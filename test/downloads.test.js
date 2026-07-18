import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { createDownloadsService } from '../src/droplet/downloads-service.js';
import { createNoVncGate } from '../src/droplet/novnc-gate.js';
import {
  DOWNLOADS_PROXY_SIGNATURE_HEADER,
  DOWNLOADS_PROXY_TIMESTAMP_HEADER,
  downloadsAccessCredentials,
  signDownloadsProxyRequest,
  verifyDownloadsBasicAuthorization,
  verifyDownloadsProxyRequest,
} from '../src/shared/downloads-access.js';
import { signNoVncToken } from '../src/shared/novnc-token.js';

function request(port, requestPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: requestPath, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.once('error', reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

test('downloads credentials and proxy signatures are domain-separated and time-bound', () => {
  const first = downloadsAccessCredentials('session-secret-one');
  const second = downloadsAccessCredentials('session-secret-two');
  assert.equal(first.username, 'webbrain');
  assert.notEqual(first.password, second.password);
  assert.equal(first.password.length >= 40, true);
  const basic = `Basic ${Buffer.from(`${first.username}:${first.password}`).toString('base64')}`;
  assert.equal(verifyDownloadsBasicAuthorization(basic, 'session-secret-one'), true);
  assert.equal(verifyDownloadsBasicAuthorization(basic, 'session-secret-two'), false);
  assert.equal(verifyDownloadsBasicAuthorization('', 'session-secret-one'), false);

  const signed = signDownloadsProxyRequest('session-secret-one', {
    timestamp: 10_000,
    method: 'PUT',
    path: '/downloads/report.txt',
  });
  assert.equal(verifyDownloadsProxyRequest('session-secret-one', {
    ...signed,
    method: 'PUT',
    path: '/downloads/report.txt',
    now: 15_000,
  }), true);
  assert.equal(verifyDownloadsProxyRequest('session-secret-one', {
    ...signed,
    method: 'GET',
    path: '/downloads/report.txt',
    now: 15_000,
  }), false);
  assert.equal(verifyDownloadsProxyRequest('session-secret-one', {
    ...signed,
    method: 'PUT',
    path: '/downloads/report.txt',
    now: 50_001,
  }), false);
});

test('downloads service safely lists, downloads, ranges, and uploads files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-downloads-'));
  await fs.writeFile(path.join(root, 'report.txt'), 'abcdefghij');
  await fs.writeFile(path.join(root, 'less<than>.txt'), 'escaped');
  await fs.writeFile(path.join(root, '.private'), 'hidden');
  await fs.writeFile(path.join(root, '.webbrain-upload-stale.part'), 'stale');
  await fs.mkdir(path.join(root, 'folder'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-outside-'));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'must not escape');
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'));

  const service = createDownloadsService({ rootDir: root, maxUploadBytes: 16 });
  const address = await service.listen(0);
  try {
    assert.equal((await fs.readdir(root)).includes('.webbrain-upload-stale.part'), false);
    const redirect = await request(address.port, '/downloads');
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.location, '/downloads/');

    const listing = await request(address.port, '/downloads/');
    assert.equal(listing.status, 200);
    assert.match(listing.headers['content-security-policy'], /default-src 'none'/);
    assert.match(listing.body.toString(), /WebBrain file tray/);
    assert.match(listing.body.toString(), /less&lt;than&gt;\.txt/);
    assert.doesNotMatch(listing.body.toString(), /.private/);
    assert.doesNotMatch(listing.body.toString(), /leak\.txt/);

    const jsonListing = await request(address.port, '/downloads/', {
      headers: { accept: 'application/json' },
    });
    assert.equal(jsonListing.status, 200);
    assert.equal(jsonListing.headers['cache-control'], 'private, no-store');
    assert.match(jsonListing.headers['content-type'], /^application\/json/);
    assert.deepEqual(JSON.parse(jsonListing.body), {
      path: '',
      entries: [
        {
          name: 'folder',
          path: 'folder',
          type: 'directory',
          size: null,
          modified_at: (await fs.stat(path.join(root, 'folder'))).mtime.toISOString(),
          url: '/downloads/folder/',
        },
        {
          name: 'less<than>.txt',
          path: 'less<than>.txt',
          type: 'file',
          size: 7,
          modified_at: (await fs.stat(path.join(root, 'less<than>.txt'))).mtime.toISOString(),
          url: '/downloads/less%3Cthan%3E.txt',
        },
        {
          name: 'report.txt',
          path: 'report.txt',
          type: 'file',
          size: 10,
          modified_at: (await fs.stat(path.join(root, 'report.txt'))).mtime.toISOString(),
          url: '/downloads/report.txt',
        },
      ],
      upload_limit_bytes: 16,
    });
    const jsonHead = await request(address.port, '/downloads/', {
      method: 'HEAD',
      headers: { accept: 'application/json' },
    });
    assert.equal(jsonHead.status, 200);
    assert.equal(jsonHead.body.length, 0);

    const head = await request(address.port, '/downloads/report.txt', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], '10');
    assert.equal(head.body.length, 0);

    const full = await request(address.port, '/downloads/report.txt');
    assert.equal(full.status, 200);
    assert.equal(full.body.toString(), 'abcdefghij');
    assert.match(full.headers['content-disposition'], /attachment/);

    const range = await request(address.port, '/downloads/report.txt', { headers: { range: 'bytes=2-5' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers['content-range'], 'bytes 2-5/10');
    assert.equal(range.body.toString(), 'cdef');

    const invalidRange = await request(address.port, '/downloads/report.txt', { headers: { range: 'bytes=20-30' } });
    assert.equal(invalidRange.status, 416);
    assert.equal(invalidRange.headers['content-range'], 'bytes */10');

    const firstUpload = await request(address.port, '/downloads/upload.txt', { method: 'PUT', body: 'first' });
    assert.equal(firstUpload.status, 201);
    assert.deepEqual(JSON.parse(firstUpload.body), {
      name: 'upload.txt',
      size: 5,
      sha256: createHash('sha256').update('first').digest('hex'),
      storage_backend: 'browser_local',
      browser_path: path.join(root, 'upload.txt'),
      browser_ready: true,
      url: '/downloads/upload.txt',
    });
    const secondUpload = await request(address.port, '/downloads/upload.txt', { method: 'PUT', body: 'second' });
    assert.equal(secondUpload.status, 201);
    assert.equal(JSON.parse(secondUpload.body).name, 'upload (1).txt');
    assert.equal(await fs.readFile(path.join(root, 'upload (1).txt'), 'utf8'), 'second');

    const declaredTooLarge = await request(address.port, '/downloads/large.bin', {
      method: 'PUT',
      headers: { 'content-length': '17' },
      body: Buffer.alloc(17),
    });
    assert.equal(declaredTooLarge.status, 413);
    const streamedTooLarge = await request(address.port, '/downloads/large.bin', {
      method: 'PUT',
      headers: { 'transfer-encoding': 'chunked' },
      body: Buffer.alloc(17),
    });
    assert.equal(streamedTooLarge.status, 413);
    assert.equal((await fs.readdir(root)).some(name => name.startsWith('.webbrain-upload-')), false);

    assert.equal((await request(address.port, '/downloads/%2e%2e/secret.txt')).status, 404);
    assert.equal((await request(address.port, '/downloads/leak.txt')).status, 404);
    const method = await request(address.port, '/downloads/report.txt', { method: 'DELETE' });
    assert.equal(method.status, 405);
    assert.equal(method.headers.allow, 'GET, HEAD, PUT');
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('interrupted uploads remove internal temporary files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-downloads-abort-'));
  const service = createDownloadsService({ rootDir: root, maxUploadBytes: 1024 });
  const address = await service.listen(0);
  try {
    await new Promise(resolve => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: address.port,
        path: '/downloads/incomplete.bin',
        method: 'PUT',
        headers: { 'content-length': '100' },
      });
      req.once('error', resolve);
      req.write(Buffer.alloc(10));
      req.destroy();
      req.once('close', resolve);
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const files = await fs.readdir(root);
      if (!files.some(name => name.startsWith('.webbrain-upload-'))) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('downloads service enforces an aggregate storage quota across uploads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-downloads-quota-'));
  const service = createDownloadsService({
    rootDir: root,
    maxUploadBytes: 16,
    maxStorageBytes: 6,
  });
  const address = await service.listen(0);
  try {
    const first = await request(address.port, '/downloads/first.bin', {
      method: 'PUT',
      body: Buffer.from('1234'),
    });
    assert.equal(first.status, 201);
    const overQuota = await request(address.port, '/downloads/second.bin', {
      method: 'PUT',
      body: Buffer.from('567'),
    });
    assert.equal(overQuota.status, 507);
    assert.match(overQuota.body.toString(), /storage has reached/i);
    assert.equal(await fs.readFile(path.join(root, 'first.bin'), 'utf8'), '1234');
    assert.deepEqual(await fs.readdir(root), ['first.bin']);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('droplet gate rejects direct and stale Downloads requests while preserving noVNC', async () => {
  const received = [];
  const downloads = http.createServer((req, res) => {
    received.push({
      authorization: req.headers.authorization,
      signature: req.headers[DOWNLOADS_PROXY_SIGNATURE_HEADER],
      timestamp: req.headers[DOWNLOADS_PROXY_TIMESTAMP_HEADER],
    });
    res.end('downloads upstream');
  });
  const noVnc = http.createServer((req, res) => res.end('novnc upstream'));
  const noVncWss = new WebSocketServer({ server: noVnc });
  noVncWss.on('connection', socket => socket.on('message', data => socket.send(data)));
  const downloadsAddress = await new Promise(resolve => downloads.listen(0, '127.0.0.1', () => resolve(downloads.address())));
  const noVncAddress = await new Promise(resolve => noVnc.listen(0, '127.0.0.1', () => resolve(noVnc.address())));
  const gate = createNoVncGate({
    secret: 'gate-secret',
    target: `http://127.0.0.1:${noVncAddress.port}`,
    downloadsTarget: `http://127.0.0.1:${downloadsAddress.port}`,
  });
  const gateAddress = await gate.listen(0, '127.0.0.1');
  try {
    assert.equal((await request(gateAddress.port, '/downloads/')).status, 401);
    const stale = signDownloadsProxyRequest('gate-secret', {
      timestamp: Date.now() - 31_000,
      method: 'GET',
      path: '/downloads/',
    });
    assert.equal((await request(gateAddress.port, '/downloads/', { headers: {
      [DOWNLOADS_PROXY_TIMESTAMP_HEADER]: stale.timestamp,
      [DOWNLOADS_PROXY_SIGNATURE_HEADER]: stale.signature,
    } })).status, 401);

    const signed = signDownloadsProxyRequest('gate-secret', { method: 'GET', path: '/downloads/' });
    const allowed = await request(gateAddress.port, '/downloads/', { headers: {
      authorization: 'Basic should-not-cross-the-gateway',
      [DOWNLOADS_PROXY_TIMESTAMP_HEADER]: signed.timestamp,
      [DOWNLOADS_PROXY_SIGNATURE_HEADER]: signed.signature,
    } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.toString(), 'downloads upstream');
    assert.deepEqual(received, [{ authorization: undefined, signature: undefined, timestamp: undefined }]);

    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const token = signNoVncToken({ sessionId: 'bs_test', expiresAt, secret: 'gate-secret' });
    const vnc = await request(gateAddress.port, `/vnc.html?token=${encodeURIComponent(token)}`, {
      headers: { 'x-forwarded-proto': 'https' },
    });
    assert.equal(vnc.status, 200);
    assert.equal(vnc.body.toString(), 'novnc upstream');
    assert.match(vnc.headers['set-cookie'][0], /wbp_novnc=/);
    assert.match(vnc.headers['set-cookie'][0], /Secure/);

    const socket = new WebSocket(`ws://127.0.0.1:${gateAddress.port}/websockify?token=${encodeURIComponent(token)}`);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send('unchanged websocket');
    const echoed = await new Promise((resolve, reject) => {
      socket.once('message', data => resolve(data.toString()));
      socket.once('error', reject);
    });
    assert.equal(echoed, 'unchanged websocket');
    const closed = new Promise(resolve => socket.once('close', resolve));
    socket.close();
    await closed;
  } finally {
    await gate.close();
    await Promise.all([
      new Promise(resolve => downloads.close(resolve)),
      new Promise(resolve => noVncWss.close(() => noVnc.close(resolve))),
    ]);
  }
});
