import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { WebBrainApiError, WebBrainClient } from '../clients/node/webbrain-client.js';

const execFileAsync = promisify(execFile);

async function startDownloadsFixture() {
  const files = new Map();
  const uploadTargets = [];
  const basic = `Basic ${Buffer.from('webbrain:fixture-secret').toString('base64')}`;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/browser-sessions/bs_test/downloads-access') {
      if (req.headers.authorization !== 'Bearer wbp_test') {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
      }
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        url: `http://127.0.0.1:${server.address().port}/downloads/`,
        username: 'webbrain',
        password: 'fixture-secret',
        upload_limit_bytes: 1024 * 1024,
        expires_at: '2026-07-16T00:00:00.000Z',
      }));
    }
    if (!req.url.startsWith('/downloads/') || req.headers.authorization !== basic) {
      res.statusCode = 401;
      return res.end('Unauthorized');
    }
    const encodedName = new URL(req.url, 'http://127.0.0.1').pathname.slice('/downloads/'.length);
    const name = decodeURIComponent(encodedName.replace(/\/$/, ''));
    if (!name && req.method === 'GET') {
      const entries = [...files.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([fileName, body]) => ({
          name: fileName,
          path: fileName,
          type: 'file',
          size: body.length,
          modified_at: '2026-07-15T00:00:00.000Z',
          url: `/downloads/${encodeURIComponent(fileName)}`,
        }));
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ path: '', entries, upload_limit_bytes: 1024 * 1024 }));
    }
    if (name && req.method === 'PUT') {
      uploadTargets.push(req.headers['x-webbrain-upload-target']);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const extension = path.extname(name);
      const stem = extension ? name.slice(0, -extension.length) : name;
      let storedName = name;
      for (let index = 1; files.has(storedName); index += 1) storedName = `${stem} (${index})${extension}`;
      const body = Buffer.concat(chunks);
      files.set(storedName, body);
      res.statusCode = 201;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        name: storedName,
        size: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
        storage_backend: 'browser_local',
        browser_path: `/root/Downloads/${storedName}`,
        browser_ready: true,
        url: `/downloads/${encodeURIComponent(storedName)}`,
      }));
    }
    if (name && req.method === 'GET' && files.has(name)) {
      const body = files.get(name);
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
      let start = 0;
      let end = body.length - 1;
      if (range) {
        start = range[1] ? Number(range[1]) : 0;
        end = range[2] ? Number(range[2]) : end;
        res.statusCode = 206;
        res.setHeader('content-range', `bytes ${start}-${end}/${body.length}`);
      }
      res.setHeader('content-type', 'application/octet-stream');
      return res.end(body.subarray(start, end + 1));
    }
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: 'Not found' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    files,
    uploadTargets,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function runtimeAvailable(command, argument = '--version') {
  try {
    await execFileAsync(command, [argument]);
    return true;
  } catch {
    return false;
  }
}

test('Node.js client sends authenticated session and run requests', async () => {
  const requests = [];
  let runPolls = 0;
  let runResponded = false;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    requests.push({
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization,
      body: rawBody ? JSON.parse(rawBody) : null,
    });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/browser-sessions') {
      res.end(JSON.stringify({
        browser_session: { id: 'bs_test', status: 'provisioning' },
        webbrain_config_result: {
          accepted: ['settings.themeMode'],
          ignored: [],
          warnings: [],
        },
      }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/browser-sessions/bs_test') {
      res.end(JSON.stringify({ browser_session: { id: 'bs_test', status: 'ready', runtime_ready: true } }));
      return;
    }
    if (req.method === 'PATCH' && req.url === '/api/browser-sessions/bs_test') {
      res.end(JSON.stringify({ browser_session: { id: 'bs_test', display_name: JSON.parse(rawBody).display_name } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/browser-sessions/bs_test/proxy') {
      res.end(JSON.stringify({ proxy: { enabled: false, endpoint: null } }));
      return;
    }
    if (req.method === 'PATCH' && req.url === '/api/browser-sessions/bs_test/proxy') {
      res.end(JSON.stringify({ proxy: { enabled: true, endpoint: 'http://proxy.example:8080' } }));
      return;
    }
    if (req.method === 'DELETE' && req.url === '/api/browser-sessions/bs_test/proxy') {
      res.end(JSON.stringify({ proxy: { enabled: false, endpoint: null } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/browser-sessions/bs_test/pause') {
      res.end(JSON.stringify({ browser_session: { id: 'bs_test', status: 'paused' } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/browser-sessions/bs_test/resume') {
      res.statusCode = 202;
      res.end(JSON.stringify({ browser_session: { id: 'bs_test', status: 'provisioning' } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/browser-sessions/bs_test/reset') {
      res.statusCode = 202;
      res.end(JSON.stringify({ browser_session: { id: 'bs_test', status: 'restarting' } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/browser-sessions/bs_test/downloads-access') {
      res.end(JSON.stringify({
        url: 'https://bs-test.webbrain.cloud/downloads/',
        username: 'webbrain',
        password: 'derived-secret',
        upload_limit_bytes: 5368709120,
        expires_at: '2026-07-16T00:00:00.000Z',
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/browser-sessions/bs_test/runs') {
      res.statusCode = 202;
      res.end(JSON.stringify({ run_id: 'run_test', status: 'running' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/browser-sessions/bs_test/runs/run_test') {
      runPolls += 1;
      res.end(JSON.stringify(runResponded
        ? { run_id: 'run_test', status: 'completed', result: 'Example Domain' }
        : {
            run_id: 'run_test',
            status: 'needs_user_input',
            pending_input: { clarify_id: 'clr_1', question: 'Continue?', options: ['yes', 'no'] },
          }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/browser-sessions/bs_test/runs/run_test/responses') {
      runResponded = true;
      res.end(JSON.stringify({ run_id: 'run_test', status: 'running', pending_input: null }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/browser-sessions/bs_test/runs/run_test/messages') {
      res.statusCode = 202;
      res.end(JSON.stringify({ run_id: 'run_child', parent_run_id: 'run_test', status: 'running' }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const client = new WebBrainClient({
      apiKey: 'wbp_test',
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    });
    const session = await client.createBrowserSession({
      type: 'incognito',
      webbrain_config: {
        schema: 'webbrain-config/1',
        settings: { themeMode: 'dark' },
      },
    });
    assert.equal(session.id, 'bs_test');
    assert.deepEqual(session.webbrain_config_result.accepted, ['settings.themeMode']);
    const ready = await client.waitForBrowserSession(session.id, { pollIntervalMs: 1, timeoutMs: 1000 });
    assert.equal(ready.runtime_ready, true);
    const renamed = await client.updateBrowserSession(ready.id, { displayName: 'Research' });
    assert.equal(renamed.display_name, 'Research');
    const directProxy = await client.getBrowserProxy(ready.id);
    assert.equal(directProxy.enabled, false);
    const proxy = await client.updateBrowserProxy(ready.id, { enabled: true });
    assert.equal(proxy.endpoint, 'http://proxy.example:8080');
    const clearedProxy = await client.deleteBrowserProxy(ready.id);
    assert.equal(clearedProxy.enabled, false);
    assert.equal((await client.pauseBrowserSession(ready.id)).status, 'paused');
    assert.equal((await client.resumeBrowserSession(ready.id)).status, 'provisioning');
    assert.equal((await client.resetBrowserSession(ready.id)).status, 'restarting');
    const downloads = await client.createDownloadsAccess(ready.id);
    assert.equal(downloads.url, 'https://bs-test.webbrain.cloud/downloads/');
    assert.equal(downloads.username, 'webbrain');
    const run = await client.createRun(ready.id, {
      task: 'Open example.com',
      tabId: 42,
      outputSchema: { title: 'string' },
      capture: 'video',
    });
    const paused = await client.waitForRun(session.id, run.run_id, { pollIntervalMs: 1, timeoutMs: 1000 });
    assert.equal(paused.status, 'needs_user_input');
    assert.equal(paused.pending_input.clarify_id, 'clr_1');
    const resumed = await client.respondToRun(session.id, run.run_id, paused.pending_input.clarify_id, 'yes');
    assert.equal(resumed.status, 'running');
    const finished = await client.waitForRun(session.id, run.run_id, { pollIntervalMs: 1, timeoutMs: 1000 });
    assert.equal(finished.result, 'Example Domain');
    const followUp = await client.continueRun(session.id, run.run_id, {
      task: 'Open the first link',
      timeoutMs: 30000,
      outputSchema: { title: 'string' },
    });
    assert.equal(followUp.parent_run_id, run.run_id);
    assert.equal(requests.every(entry => entry.authorization === 'Bearer wbp_test'), true);
    assert.deepEqual(requests.find(entry => entry.path === '/api/browser-sessions').body, {
      type: 'incognito',
      webbrain_config: {
        schema: 'webbrain-config/1',
        settings: { themeMode: 'dark' },
      },
    });
    assert.deepEqual(requests.find(entry => entry.path.endsWith('/runs')).body, {
      task: 'Open example.com',
      wait: false,
      tab_id: 42,
      output_schema: { title: 'string' },
      capture: 'video',
    });
    assert.deepEqual(requests.find(entry => entry.method === 'PATCH' && entry.path.endsWith('/proxy')).body, {
      proxy_enabled: true,
    });
    assert.deepEqual(requests.find(entry => entry.method === 'DELETE' && entry.path.endsWith('/proxy')).body, null);
    assert.deepEqual(requests.find(entry => entry.path.endsWith('/pause')).body, {});
    assert.deepEqual(requests.find(entry => entry.path.endsWith('/resume')).body, {});
    assert.deepEqual(requests.find(entry => entry.path.endsWith('/reset')).body, {});
    assert.deepEqual(requests.find(entry => entry.path.endsWith('/responses')).body, {
      clarify_id: 'clr_1',
      answer: 'yes',
    });
    assert.deepEqual(requests.find(entry => entry.path.endsWith('/messages')).body, {
      task: 'Open the first link',
      wait: false,
      timeout_ms: 30000,
      output_schema: { title: 'string' },
    });
    assert.equal(runPolls, 2);

    await assert.rejects(
      () => client.getBrowserSession('missing'),
      error => error instanceof WebBrainApiError && error.status === 404 && error.message === 'Not found'
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('PHP client preserves the non-secret WebBrain config result when PHP is installed', async t => {
  if (!await runtimeAvailable('php', '-v')) return t.skip('PHP is not installed');
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      // Consume the request body before replying.
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      browser_session: { id: 'bs_config', status: 'provisioning' },
      webbrain_config_result: {
        accepted: ['settings.captchaSolverEnabled'],
        ignored: [{ field: 'settings.planBeforeAct', reason: 'platform_managed' }],
        warnings: [],
      },
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const phpSource = `<?php
require_once ${JSON.stringify(path.resolve('clients/php/WebBrainClient.php'))};
$client = new WebBrainClient('wbp_test', ${JSON.stringify(`http://127.0.0.1:${server.address().port}`)});
$session = $client->createBrowserSession(['type' => 'incognito']);
echo json_encode($session, JSON_THROW_ON_ERROR);
`;
    const { stdout } = await execFileAsync('php', ['-r', phpSource.replace(/^<\?php\s*/, '')]);
    const session = JSON.parse(stdout);
    assert.equal(session.id, 'bs_config');
    assert.deepEqual(session.webbrain_config_result.accepted, ['settings.captchaSolverEnabled']);
    assert.equal(Object.hasOwn(session.webbrain_config_result, 'values'), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Node.js client streams Downloads listing, upload, full download, and ranges', async () => {
  const fixture = await startDownloadsFixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webbrain-node-client-'));
  try {
    const source = path.join(directory, 'source.txt');
    await writeFile(source, 'abcdefghij');
    const client = new WebBrainClient({ apiKey: 'wbp_test', baseUrl: fixture.baseUrl });
    const access = await client.createDownloadsAccess('bs_test');
    assert.deepEqual((await client.listDownloads('bs_test', { access })).entries, []);
    const first = await client.uploadDownloadsFile('bs_test', source, { remotePath: 'node sample.txt', access });
    const second = await client.uploadDownloadsFile('bs_test', source, { remotePath: 'node sample.txt', access });
    assert.equal(first.name, 'node sample.txt');
    assert.equal(first.sha256, createHash('sha256').update('abcdefghij').digest('hex'));
    assert.equal(first.storage_backend, 'browser_local');
    assert.equal(first.browser_path, '/root/Downloads/node sample.txt');
    assert.equal(first.browser_ready, true);
    assert.equal(second.name, 'node sample (1).txt');
    assert.deepEqual((await client.listDownloads('bs_test', { access })).entries.map(entry => entry.name), [
      'node sample (1).txt',
      'node sample.txt',
    ]);
    const browserUpload = await client.uploadDownloadsFile('bs_test', source, {
      remotePath: 'node browser.txt',
      access,
      browserLocal: true,
    });
    assert.equal(browserUpload.browser_ready, true);
    assert.equal(fixture.uploadTargets.at(-1), 'browser');

    const destination = path.join(directory, 'full.txt');
    const downloaded = await client.downloadDownloadsFile('bs_test', first.name, destination, { access });
    assert.equal(downloaded.size, 10);
    assert.equal(await readFile(destination, 'utf8'), 'abcdefghij');
    await assert.rejects(
      () => client.downloadDownloadsFile('bs_test', first.name, destination, { access }),
      error => error.code === 'EEXIST',
    );

    const partial = path.join(directory, 'partial.txt');
    const ranged = await client.downloadDownloadsFile('bs_test', first.name, partial, {
      access,
      range: 'bytes=2-5',
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.content_range, 'bytes 2-5/10');
    assert.equal(await readFile(partial, 'utf8'), 'cdef');
    await assert.rejects(
      () => client.listDownloads('bs_test', { path: '../private', access }),
      /forbidden segment/,
    );
    await assert.rejects(
      () => client.listDownloads('bs_test', {
        access: { ...access, url: 'http://downloads.example.com/downloads/' },
      }),
      /must use HTTPS/,
    );
    await assert.rejects(
      () => client.downloadDownloadsFile('bs_test', first.name, path.join(directory, 'invalid-range'), {
        access,
        range: 'bytes=-',
      }),
      /single HTTP bytes range/,
    );
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Python and PHP clients stream Downloads transfers when their runtimes are installed', async t => {
  const hasPython = await runtimeAvailable('python3');
  const hasPhp = await runtimeAvailable('php', '-v');
  if (!hasPython && !hasPhp) return t.skip('Python and PHP are not installed');

  const fixture = await startDownloadsFixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webbrain-other-clients-'));
  const source = path.join(directory, 'source.txt');
  await writeFile(source, 'abcdefghij');
  const environment = {
    ...process.env,
    WEBBRAIN_FIXTURE_BASE: fixture.baseUrl,
    WEBBRAIN_FIXTURE_SOURCE: source,
    WEBBRAIN_FIXTURE_DIRECTORY: directory,
  };
  try {
    if (hasPython) {
      const pythonSource = `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(path.resolve('clients/python'))})
from webbrain_client import WebBrainClient
client = WebBrainClient('wbp_test', base_url=os.environ['WEBBRAIN_FIXTURE_BASE'])
access = client.create_downloads_access('bs_test')
uploaded = client.upload_downloads_file('bs_test', os.environ['WEBBRAIN_FIXTURE_SOURCE'], remote_path='python sample.txt', access=access, browser_local=True)
listing = client.list_downloads('bs_test', access=access)
full = os.path.join(os.environ['WEBBRAIN_FIXTURE_DIRECTORY'], 'python-full.txt')
partial = os.path.join(os.environ['WEBBRAIN_FIXTURE_DIRECTORY'], 'python-partial.txt')
downloaded = client.download_downloads_file('bs_test', uploaded['name'], full, access=access)
ranged = client.download_downloads_file('bs_test', uploaded['name'], partial, access=access, byte_range='bytes=3-6')
print(json.dumps({'uploaded': uploaded, 'names': [entry['name'] for entry in listing['entries']], 'downloaded': downloaded, 'ranged': ranged}))
`;
      const { stdout } = await execFileAsync('python3', ['-c', pythonSource], { env: environment });
      const result = JSON.parse(stdout);
      assert.equal(result.uploaded.name, 'python sample.txt');
      assert.equal(result.uploaded.browser_path, '/root/Downloads/python sample.txt');
      assert.equal(result.uploaded.browser_ready, true);
      assert.equal(fixture.uploadTargets.at(-1), 'browser');
      assert.equal(result.names.includes('python sample.txt'), true);
      assert.equal(await readFile(path.join(directory, 'python-full.txt'), 'utf8'), 'abcdefghij');
      assert.equal(await readFile(path.join(directory, 'python-partial.txt'), 'utf8'), 'defg');
      assert.equal(result.ranged.status, 206);
    }

    if (hasPhp) {
      const phpSource = `
require_once ${JSON.stringify(path.resolve('clients/php/WebBrainClient.php'))};
$client = new WebBrainClient('wbp_test', getenv('WEBBRAIN_FIXTURE_BASE'));
$access = $client->createDownloadsAccess('bs_test');
$uploaded = $client->uploadDownloadsFile('bs_test', getenv('WEBBRAIN_FIXTURE_SOURCE'), 'php sample.txt', $access, true);
$listing = $client->listDownloads('bs_test', '', $access);
$full = getenv('WEBBRAIN_FIXTURE_DIRECTORY') . '/php-full.txt';
$partial = getenv('WEBBRAIN_FIXTURE_DIRECTORY') . '/php-partial.txt';
$downloaded = $client->downloadDownloadsFile('bs_test', $uploaded['name'], $full, $access);
$ranged = $client->downloadDownloadsFile('bs_test', $uploaded['name'], $partial, $access, 'bytes=1-4');
echo json_encode(['uploaded' => $uploaded, 'names' => array_column($listing['entries'], 'name'), 'downloaded' => $downloaded, 'ranged' => $ranged], JSON_THROW_ON_ERROR);
`;
      const { stdout } = await execFileAsync('php', ['-r', phpSource], { env: environment });
      const result = JSON.parse(stdout);
      assert.equal(result.uploaded.name, 'php sample.txt');
      assert.equal(result.uploaded.browser_path, '/root/Downloads/php sample.txt');
      assert.equal(result.uploaded.browser_ready, true);
      assert.equal(fixture.uploadTargets.at(-1), 'browser');
      assert.equal(result.names.includes('php sample.txt'), true);
      assert.equal(await readFile(path.join(directory, 'php-full.txt'), 'utf8'), 'abcdefghij');
      assert.equal(await readFile(path.join(directory, 'php-partial.txt'), 'utf8'), 'bcde');
      assert.equal(result.ranged.status, 206);
    }
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Python and PHP clients expose the shared browser automation operations', async () => {
  const python = await readFile(new URL('../clients/python/webbrain_client.py', import.meta.url), 'utf8');
  const php = await readFile(new URL('../clients/php/WebBrainClient.php', import.meta.url), 'utf8');
  for (const method of ['create_browser_session', 'update_browser_session', 'reset_browser_session', 'pause_browser_session', 'resume_browser_session', 'get_browser_proxy', 'update_browser_proxy', 'delete_browser_proxy', 'create_downloads_access', 'list_downloads', 'upload_downloads_file', 'download_downloads_file', 'wait_for_browser_session', 'create_run', 'get_run', 'continue_run', 'respond_to_run', 'abort_run', 'wait_for_run']) {
    assert.match(python, new RegExp(`def ${method}\\(`));
  }
  for (const method of ['createBrowserSession', 'updateBrowserSession', 'resetBrowserSession', 'pauseBrowserSession', 'resumeBrowserSession', 'getBrowserProxy', 'updateBrowserProxy', 'deleteBrowserProxy', 'createDownloadsAccess', 'listDownloads', 'uploadDownloadsFile', 'downloadDownloadsFile', 'waitForBrowserSession', 'createRun', 'getRun', 'continueRun', 'respondToRun', 'abortRun', 'waitForRun']) {
    assert.match(php, new RegExp(`function ${method}\\(`));
  }
  assert.match(python, /Authorization.*Bearer/);
  assert.match(php, /Authorization: Bearer/);

  const readmes = await Promise.all([
    readFile(new URL('../clients/node/README.md', import.meta.url), 'utf8'),
    readFile(new URL('../clients/python/README.md', import.meta.url), 'utf8'),
    readFile(new URL('../clients/php/README.md', import.meta.url), 'utf8'),
  ]);
  for (const readme of readmes) {
    assert.match(readme, /Create a browser and run a task/);
    assert.match(readme, /Structured output/);
    assert.match(readme, /Downloads transfers/);
    assert.match(readme, /upload.*Downloads.*File|upload_downloads_file/i);
    assert.match(readme, /download.*Downloads.*File|download_downloads_file/i);
    assert.match(readme, /parent_run_id/);
  }
});
