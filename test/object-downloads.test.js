import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { createObjectDownloadsHandler } from '../src/platform/object-downloads.js';

function createMemoryObjectStore() {
  const objects = new Map();
  return {
    objects,
    async list(prefix) {
      return [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, item]) => ({ key, size: item.body.length, modifiedAt: item.modifiedAt }));
    },
    async head(key) {
      const item = objects.get(key);
      return item ? { key, size: item.body.length, contentType: item.contentType, modifiedAt: item.modifiedAt } : null;
    },
    async get(key, range) {
      const item = objects.get(key);
      if (!item) throw Object.assign(new Error('not found'), { status: 404 });
      const body = range ? item.body.subarray(range.start, range.end + 1) : item.body;
      return { body: Readable.from(body) };
    },
    async put(key, stream, { contentType } = {}) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      objects.set(key, { body: Buffer.concat(chunks), contentType, modifiedAt: new Date() });
      return { etag: `etag-${key}` };
    },
  };
}

async function startDownloads({ quotaBytes = 12, maxUploadBytes = 8 } = {}) {
  const objectStore = createMemoryObjectStore();
  const handler = createObjectDownloadsHandler({ objectStore, quotaBytes, maxUploadBytes });
  const server = http.createServer((req, res) => {
    handler.handleRequest(req, res, { userId: req.headers['x-user'] || 'user-a' }).catch(error => {
      res.writeHead(error.status || 500);
      res.end(error.message);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    objectStore,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('shared Downloads streams uploads, isolates users, suffixes collisions, and supports ranges', async () => {
  const ctx = await startDownloads();
  try {
    let response = await fetch(`${ctx.base}/downloads/report.txt`, {
      method: 'PUT',
      headers: { 'content-length': '5' },
      body: 'hello',
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).path, 'report.txt');

    response = await fetch(`${ctx.base}/downloads/report.txt`, {
      method: 'PUT',
      headers: { 'content-length': '5' },
      body: 'world',
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).path, 'report (1).txt');

    response = await fetch(`${ctx.base}/downloads/`, { headers: { accept: 'application/json' } });
    const listing = await response.json();
    assert.equal(response.status, 200);
    assert.equal(listing.used_bytes, 10);
    assert.equal(listing.quota_bytes, 12);
    assert.deepEqual(listing.entries.map(entry => entry.name), ['report (1).txt', 'report.txt']);

    response = await fetch(`${ctx.base}/downloads/report.txt`, { headers: { range: 'bytes=1-3' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 1-3/5');
    assert.equal(await response.text(), 'ell');

    response = await fetch(`${ctx.base}/downloads/report.txt`, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), '5');

    response = await fetch(`${ctx.base}/downloads/`, {
      headers: { accept: 'application/json', 'x-user': 'user-b' },
    });
    assert.deepEqual((await response.json()).entries, []);

    response = await fetch(`${ctx.base}/downloads/third.txt`, {
      method: 'PUT',
      headers: { 'content-length': '3' },
      body: '123',
    });
    assert.equal(response.status, 507);

    response = await fetch(`${ctx.base}/downloads/too-big.bin`, {
      method: 'PUT',
      headers: { 'content-length': '9' },
      body: '123456789',
    });
    assert.equal(response.status, 413);
  } finally {
    await ctx.close();
  }
});

test('Chrome upload idempotency reuses the reserved final name after an uncertain response', async () => {
  const objectStore = createMemoryObjectStore();
  const handler = createObjectDownloadsHandler({ objectStore, quotaBytes: 10, maxUploadBytes: 10 });
  const first = await handler.uploadStream({
    userId: 'user-a',
    requestedPath: 'report.pdf',
    stream: Readable.from('first-copy'),
    contentLength: 10,
    idempotencyKey: 'chrome-guid-1',
  });
  const second = await handler.uploadStream({
    userId: 'user-a',
    requestedPath: 'report.pdf',
    stream: Readable.from('retry-copy'),
    contentLength: 10,
    idempotencyKey: 'chrome-guid-1',
  });
  assert.equal(first.path, 'report.pdf');
  assert.equal(second.path, 'report.pdf');
  assert.equal(second.idempotent, true);
  const visible = await handler.listUserObjects('user-a');
  assert.deepEqual(visible.map(item => item.relativeKey), ['report.pdf']);
  assert.equal(objectStore.objects.get('users/user-a/report.pdf').body.toString(), 'first-copy');
  assert.deepEqual(
    JSON.parse(objectStore.objects.get('users/user-a/.webbrain-internal/chrome-guid-1.json').body.toString()),
    {
      committed: true,
      requested: 'report.pdf',
      path: 'report.pdf',
      size: 10,
      etag: 'etag-users/user-a/report.pdf',
    },
  );
});

test('uncommitted idempotency markers never claim a different visible file', async () => {
  const objectStore = createMemoryObjectStore();
  objectStore.objects.set('users/user-a/report.pdf', {
    body: Buffer.from('other-file'),
    contentType: 'application/pdf',
    modifiedAt: new Date(),
  });
  objectStore.objects.set('users/user-a/.webbrain-internal/chrome-guid-1.json', {
    body: Buffer.from(JSON.stringify({ requested: 'report.pdf', path: 'report.pdf' })),
    contentType: 'application/json',
    modifiedAt: new Date(),
  });
  const handler = createObjectDownloadsHandler({ objectStore, quotaBytes: 30, maxUploadBytes: 10 });
  const uploaded = await handler.uploadStream({
    userId: 'user-a',
    requestedPath: 'report.pdf',
    stream: Readable.from('retry-copy'),
    contentLength: 10,
    idempotencyKey: 'chrome-guid-1',
  });
  assert.equal(uploaded.path, 'report (1).pdf');
  assert.equal(uploaded.idempotent, undefined);
  assert.equal(objectStore.objects.get('users/user-a/report.pdf').body.toString(), 'other-file');
  assert.equal(objectStore.objects.get('users/user-a/report (1).pdf').body.toString(), 'retry-copy');
});

test('interrupted shared uploads abort without publishing a partial object', async () => {
  const objectStore = createMemoryObjectStore();
  const handler = createObjectDownloadsHandler({ objectStore, quotaBytes: 1024, maxUploadBytes: 1024 });
  const source = new Readable({
    read() {
      this.push('partial');
      this.destroy(new Error('connection lost'));
    },
  });
  await assert.rejects(() => handler.uploadStream({
    userId: 'user-a',
    requestedPath: 'partial.bin',
    stream: source,
  }), /connection lost/);
  assert.equal(objectStore.objects.has('users/user-a/partial.bin'), false);
});
