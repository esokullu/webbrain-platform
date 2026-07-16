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

test('download sync preserves nonempty crash leftovers, removes empty records, and clears temp metadata', async () => {
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-download-recover-'));
  await fs.writeFile(path.join(stagingDir, 'guid-incomplete'), 'partial');
  await fs.writeFile(path.join(stagingDir, 'guid-incomplete.json'), JSON.stringify({
    guid: 'guid-incomplete',
    filename: 'partial.bin',
    completed: false,
  }));
  await fs.writeFile(path.join(stagingDir, 'guid-orphan'), 'orphan-data');
  await fs.writeFile(path.join(stagingDir, 'guid-empty'), '');
  await fs.writeFile(path.join(stagingDir, 'guid-empty.json'), JSON.stringify({
    guid: 'guid-empty',
    filename: 'empty.bin',
    completed: false,
  }));
  await fs.writeFile(path.join(stagingDir, 'guid-incomplete.json.123.tmp'), 'stale metadata');
  let uploaded = false;
  const sync = new ChromeDownloadSync({
    stagingDir,
    ingestUrl: 'https://platform.example/droplet/downloads',
    sessionToken: 'session-secret',
    fetchImpl: async () => { uploaded = true; throw new Error('should not upload'); },
  });
  try {
    await sync.start(fakeCdp());
    assert.deepEqual((await fs.readdir(stagingDir)).sort(), [
      'guid-incomplete',
      'guid-incomplete.json',
      'guid-orphan',
    ]);
    assert.equal(uploaded, false);
  } finally {
    sync.close();
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
});

test('download sync stops retrying terminal storage rejections and retries them after restart', async () => {
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-download-terminal-'));
  const cdp = fakeCdp();
  let rejectedUploads = 0;
  const sync = new ChromeDownloadSync({
    stagingDir,
    ingestUrl: 'https://platform.example/droplet/downloads',
    sessionToken: 'session-secret',
    retryDelaysMs: [5],
    fetchImpl: async () => {
      rejectedUploads += 1;
      return { ok: false, status: 507, async text() { return 'Downloads quota reached'; } };
    },
  });
  let recovered = null;
  try {
    await sync.start(cdp);
    await fs.writeFile(path.join(stagingDir, 'guid-quota'), 'important-download');
    cdp.emit('Browser.downloadWillBegin', {
      guid: 'guid-quota',
      suggestedFilename: 'important.bin',
      url: 'https://example.com/important.bin',
    });
    cdp.emit('Browser.downloadProgress', { guid: 'guid-quota', state: 'completed' });

    await waitFor(async () => {
      try {
        const record = JSON.parse(await fs.readFile(path.join(stagingDir, 'guid-quota.json'), 'utf8'));
        return record.upload_error?.status === 507;
      } catch {
        return false;
      }
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(rejectedUploads, 1);
    assert.deepEqual((await fs.readdir(stagingDir)).sort(), ['guid-quota', 'guid-quota.json']);
    sync.close();

    let recoveredUploads = 0;
    recovered = new ChromeDownloadSync({
      stagingDir,
      ingestUrl: 'https://platform.example/droplet/downloads',
      sessionToken: 'session-secret',
      fetchImpl: async () => {
        recoveredUploads += 1;
        return { ok: true, status: 201, async text() { return JSON.stringify({ path: 'important.bin' }); } };
      },
    });
    await recovered.start(fakeCdp());
    await waitFor(async () => (await fs.readdir(stagingDir)).length === 0);
    assert.equal(recoveredUploads, 1);
  } finally {
    sync.close();
    recovered?.close();
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
});
