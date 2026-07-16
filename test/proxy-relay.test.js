import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Server as ProxyChainServer } from 'proxy-chain';
import { BrowserProxyRelay } from '../src/droplet/proxy-relay.js';
import { DropletControlClient } from '../src/droplet/control-client.js';
import { cancelDropletPause, prepareDropletForPause } from '../src/droplet/pause.js';
import { normalizeProxyUrl, proxyUrlFromParts, publicProxyEndpoint } from '../src/shared/proxy.js';

async function proxyRequest(port, url = 'http://exit.test/ip') {
  return await new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: target.toString(),
      headers: { host: target.host, connection: 'close' },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    req.end();
  });
}

async function authenticatedUpstream({ username, password, ip }) {
  const server = new ProxyChainServer({
    host: '127.0.0.1',
    port: 0,
    prepareRequestFunction: credentials => {
      if (credentials.username !== username || credentials.password !== password) {
        return { requestAuthentication: true };
      }
      return {
        customResponseFunction: () => ({
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ip }),
        }),
      };
    },
  });
  await server.listen();
  return server;
}

test('proxy URL normalization keeps credentials private in public endpoints', () => {
  const url = normalizeProxyUrl('http://user:pass@proxy.example:8080');
  assert.equal(url, 'http://user:pass@proxy.example:8080/');
  assert.equal(publicProxyEndpoint(url), 'http://proxy.example:8080');
  assert.equal(proxyUrlFromParts({
    domain: 'p.webshare.io',
    port: 80,
    username: 'webshare-user',
    password: 'p@ss/word',
  }), 'http://webshare-user:p%40ss%2Fword@p.webshare.io/');
  assert.throws(() => proxyUrlFromParts({ domain: 'p.webshare.io', port: 80 }), /domain, port, username, and password/);
  assert.throws(() => normalizeProxyUrl('ftp://proxy.example:21'), /HTTP, HTTPS, SOCKS4, or SOCKS5/);
  assert.throws(() => normalizeProxyUrl('http://proxy.example/path'), /cannot include a path/);
});

test('droplet control exposes proxy status and verified live updates', async () => {
  const calls = [];
  const relay = {
    status: () => ({ enabled: false, endpoint: null }),
    update: async (proxyUrl, options) => {
      calls.push({ proxyUrl, options });
      return { enabled: true, endpoint: 'http://proxy.example:8080', exit_ip: '198.51.100.5' };
    },
  };
  const client = new DropletControlClient({
    controlUrl: 'ws://127.0.0.1/control',
    sessionToken: 'test',
    proxyRelay: relay,
    proxyVerifyUrl: 'http://exit.test/ip',
  });
  assert.deepEqual(await client.handleCommand('proxy.status', {}), { enabled: false, endpoint: null });
  const updated = await client.handleCommand('proxy.update', { proxy_url: 'http://user:pass@proxy.example:8080' });
  assert.equal(updated.exit_ip, '198.51.100.5');
  assert.deepEqual(calls, [{
    proxyUrl: 'http://user:pass@proxy.example:8080',
    options: { verify: true, verifyUrl: 'http://exit.test/ip' },
  }]);
});

test('pause preparation refuses staged downloads and otherwise stops, flushes, and unmounts in order', async () => {
  const commands = [];
  await assert.rejects(() => prepareDropletForPause({
    profileMount: '/mnt/webbrain-profile',
    downloadsStagingDir: '/staging',
    readdirImpl: async () => ['pending-download'],
    execFileImpl: async (...args) => commands.push(args),
  }), error => error.status === 409 && /finish syncing/.test(error.message));
  assert.deepEqual(commands, []);

  await assert.rejects(() => prepareDropletForPause({
    profileMount: '/mnt/webbrain-profile',
    downloadsStagingDir: '/staging',
    readdirImpl: async () => ['orphan-guid'],
    execFileImpl: async (...args) => commands.push(args),
  }), error => error.status === 409 && /Unsynced browser download data/.test(error.message));
  assert.deepEqual(commands, []);

  await assert.rejects(() => prepareDropletForPause({
    profileMount: '/mnt/webbrain-profile',
    downloadsStagingDir: '/staging',
    readdirImpl: async () => ['guid-quota.json', 'guid-quota'],
    readFileImpl: async () => JSON.stringify({ upload_error: { status: 507 } }),
    execFileImpl: async (...args) => commands.push(args),
  }), error => error.status === 409 && /storage returned 507/.test(error.message));
  assert.deepEqual(commands, []);

  let reads = 0;
  const ready = await prepareDropletForPause({
    profileMount: '/mnt/webbrain-profile',
    downloadsStagingDir: '/staging',
    readdirImpl: async () => { reads += 1; return []; },
    execFileImpl: async (command, args) => { commands.push([command, args]); },
  });
  assert.deepEqual(ready, { ready_to_detach: true });
  assert.equal(reads, 2);
  assert.deepEqual(commands, [
    ['systemctl', ['stop', 'webbrain-browser.service']],
    ['sync', []],
    ['mountpoint', ['-q', '/mnt/webbrain-profile']],
    ['umount', ['/mnt/webbrain-profile']],
  ]);

  const control = new DropletControlClient({
    controlUrl: 'ws://127.0.0.1/control',
    sessionToken: 'test',
    pausePrepare: async payload => ({ payload, prepared: true }),
  });
  assert.deepEqual(await control.handleCommand('pause.prepare', { test: 1 }), {
    payload: { test: 1 },
    prepared: true,
  });
});

test('pause cancellation remounts and verifies the profile before restarting Chrome', async () => {
  const commands = [];
  let mountChecks = 0;
  const resumed = await cancelDropletPause({
    profileMount: '/mnt/webbrain-profile',
    execFileImpl: async (command, args) => {
      commands.push([command, args]);
      if (command === 'mountpoint') {
        mountChecks += 1;
        if (mountChecks === 1) throw new Error('not mounted');
      }
    },
  });
  assert.deepEqual(resumed, { resumed: true });
  assert.deepEqual(commands, [
    ['mountpoint', ['-q', '/mnt/webbrain-profile']],
    ['mount', ['/mnt/webbrain-profile']],
    ['mountpoint', ['-q', '/mnt/webbrain-profile']],
    ['systemctl', ['start', 'webbrain-browser.service']],
    ['systemctl', ['is-active', '--quiet', 'webbrain-browser.service']],
  ]);
});

test('droplet control forwards run metadata and clarification responses', async () => {
  const received = [];
  const sidecar = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, extension_connected: true }));
      return;
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push({ method: req.method, url: req.url, body });
      res.writeHead(req.url.endsWith('/responses') ? 200 : 202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ run_id: 'run_test', status: 'running' }));
    });
  });
  await new Promise(resolve => sidecar.listen(0, '127.0.0.1', resolve));

  try {
    const address = sidecar.address();
    const client = new DropletControlClient({
      controlUrl: 'ws://127.0.0.1/control',
      sessionToken: 'test',
      sidecarBase: `http://127.0.0.1:${address.port}`,
      downloadsSyncEnabled: true,
    });
    assert.deepEqual(await client.handleCommand('health', {}), {
      ok: true,
      extension_connected: true,
      downloads_sync_enabled: true,
    });
    const started = await client.handleCommand('run', {
      task: 'Open Google',
      api_mutations_allowed: true,
      parent_run_id: 'run_parent',
    });

    assert.equal(started.run_id, 'run_test');
    assert.equal(received[0].body.task, 'Open Google');
    assert.equal(received[0].body.api_mutations_allowed, true);
    assert.equal(received[0].body.parent_run_id, 'run_parent');
    const resumed = await client.handleCommand('respond', {
      run_id: 'run_test',
      clarify_id: 'clr_1',
      answer: 'Continue',
    });
    assert.equal(resumed.status, 'running');
    assert.deepEqual(received[1], {
      method: 'POST',
      url: '/runs/run_test/responses',
      body: { clarify_id: 'clr_1', answer: 'Continue' },
    });
  } finally {
    await new Promise((resolve, reject) => sidecar.close(error => error ? reject(error) : resolve()));
  }
});

test('browser proxy relay authenticates upstream, switches live, verifies the exit, and persists state', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-proxy-'));
  const statePath = path.join(tempDir, 'proxy.json');
  const upstreamA = await authenticatedUpstream({ username: 'user-a', password: 'pass-a', ip: '198.51.100.11' });
  const upstreamB = await authenticatedUpstream({ username: 'user-b', password: 'pass-b', ip: '198.51.100.22' });
  const brokenUpstream = await authenticatedUpstream({ username: 'user-c', password: 'pass-c', ip: 'not-an-ip' });
  const urlA = `http://user-a:pass-a@127.0.0.1:${upstreamA.port}`;
  const urlB = `http://user-b:pass-b@127.0.0.1:${upstreamB.port}`;
  const brokenUrl = `http://user-c:pass-c@127.0.0.1:${brokenUpstream.port}`;
  let relay = new BrowserProxyRelay({
    host: '127.0.0.1',
    port: 0,
    initialProxyUrl: urlA,
    statePath,
    verifyUrl: 'http://exit.test/ip',
    verifyTimeoutMs: 1000,
  });

  try {
    const initial = await relay.start();
    assert.equal(initial.endpoint, `http://127.0.0.1:${upstreamA.port}`);
    assert.equal(initial.exit_ip, '198.51.100.11');
    assert.deepEqual(await proxyRequest(relay.port), {
      status: 200,
      body: JSON.stringify({ ip: '198.51.100.11' }),
    });

    const updated = await relay.update(urlB);
    assert.equal(updated.endpoint, `http://127.0.0.1:${upstreamB.port}`);
    assert.equal(updated.exit_ip, '198.51.100.22');
    assert.equal(JSON.stringify(updated).includes('pass-b'), false);
    assert.deepEqual(await proxyRequest(relay.port), {
      status: 200,
      body: JSON.stringify({ ip: '198.51.100.22' }),
    });

    await assert.rejects(() => relay.update(brokenUrl), /valid IP address/);
    assert.equal(relay.status().endpoint, `http://127.0.0.1:${upstreamB.port}`);
    assert.equal(relay.status().exit_ip, '198.51.100.22');

    await relay.close();
    relay = new BrowserProxyRelay({
      host: '127.0.0.1',
      port: 0,
      initialProxyUrl: urlA,
      statePath,
      verifyUrl: 'http://exit.test/ip',
      verifyTimeoutMs: 1000,
    });
    const restored = await relay.start();
    assert.equal(restored.endpoint, `http://127.0.0.1:${upstreamB.port}`);
    assert.equal(restored.exit_ip, '198.51.100.22');
    assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600);
    const direct = await relay.update('', { verify: false });
    assert.equal(direct.enabled, false);
    assert.equal(direct.endpoint, null);
  } finally {
    await relay.close();
    await upstreamA.close(true);
    await upstreamB.close(true);
    await brokenUpstream.close(true);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
