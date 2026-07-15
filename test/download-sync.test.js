import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChromeDownloadSync } from '../src/droplet/download-sync.js';

function fakeCdp() {
  const handlers = new Map();
  const calls = [];
  return {
    calls,
    on(method, handler) { handlers.set(method, handler); },
    async call(method, params) { calls.push({ method, params }); return {}; },
    emit(method, payload) { handlers.get(method)?.(payload); },
  };
}

async function waitFor(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for download sync');
}

test('Chrome download sync uploads completed files and only then clears staging', async () => {
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-download-sync-'));
  const cdp = fakeCdp();
  const uploads = [];
  const sync = new ChromeDownloadSync({
    stagingDir,
    ingestUrl: 'https://platform.example/droplet/downloads',
    sessionToken: 'session-secret',
    retryDelaysMs: [5],
    fetchImpl: async (url, options) => {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
      uploads.push({ url, options, body: Buffer.concat(chunks).toString('utf8') });
      return { ok: true, status: 201, async text() { return JSON.stringify({ path: 'report.pdf' }); } };
    },
  });

  try {
    await sync.start(cdp);
    assert.deepEqual(cdp.calls, [{
      method: 'Browser.setDownloadBehavior',
      params: { behavior: 'allowAndName', downloadPath: stagingDir, eventsEnabled: true },
    }]);

    await fs.writeFile(path.join(stagingDir, 'guid-123'), 'pdf-data');
    cdp.emit('Browser.downloadWillBegin', {
      guid: 'guid-123',
      suggestedFilename: '../report.pdf',
      url: 'https://example.com/report.pdf',
    });
    cdp.emit('Browser.downloadProgress', { guid: 'guid-123', state: 'completed' });

    await waitFor(async () => (await fs.readdir(stagingDir)).length === 0);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].url, 'https://platform.example/droplet/downloads/report.pdf');
    assert.equal(uploads[0].options.headers.authorization, 'Bearer session-secret');
    assert.equal(uploads[0].options.headers['content-length'], '8');
    assert.equal(uploads[0].options.headers['x-webbrain-download-id'], 'guid-123');
    assert.equal(uploads[0].body, 'pdf-data');
  } finally {
    sync.close();
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
});

test('download sync discards incomplete crash leftovers instead of uploading partial files', async () => {
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-download-recover-'));
  await fs.writeFile(path.join(stagingDir, 'guid-incomplete'), 'partial');
  await fs.writeFile(path.join(stagingDir, 'guid-incomplete.json'), JSON.stringify({
    guid: 'guid-incomplete',
    filename: 'partial.bin',
    completed: false,
  }));
  let uploaded = false;
  const sync = new ChromeDownloadSync({
    stagingDir,
    ingestUrl: 'https://platform.example/droplet/downloads',
    sessionToken: 'session-secret',
    fetchImpl: async () => { uploaded = true; throw new Error('should not upload'); },
  });
  try {
    await sync.start(fakeCdp());
    assert.deepEqual(await fs.readdir(stagingDir), []);
    assert.equal(uploaded, false);
  } finally {
    sync.close();
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
});
