import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createSidecarServer } from '../src/sidecar.js';

async function request(base, path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json();
  return { status: res.status, body };
}

test('sidecar run lifecycle proxies cloud_run/status/abort to extension bridge', async () => {
  const sidecar = createSidecarServer({ port: 0, pollIntervalMs: 25, requestTimeoutMs: 1000 });
  const address = await sidecar.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/extension`);
  const statuses = new Map();

  await new Promise(resolve => ws.once('open', resolve));
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString('utf8'));
    if (msg.type === 'hello') return;
    if (msg.action === 'cloud_run') {
      assert.equal(msg.payload.tabId, 42);
      statuses.set('run_test', {
        runId: 'run_test',
        status: 'running',
        tabId: 7,
        task: msg.payload.task,
        updates: [],
      });
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: statuses.get('run_test') }));
      setTimeout(() => {
        statuses.set('run_test', {
          ...statuses.get('run_test'),
          status: 'completed',
          result: { title: 'Done' },
          summary: 'Finished.',
          finalUrl: 'https://example.com',
        });
      }, 40);
      return;
    }
    if (msg.action === 'cloud_status') {
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: statuses.get(msg.payload.runId) }));
      return;
    }
    if (msg.action === 'cloud_abort') {
      const current = statuses.get(msg.payload.runId);
      statuses.set(msg.payload.runId, { ...current, status: 'aborted', error: 'Abort requested.' });
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: statuses.get(msg.payload.runId) }));
    }
  });

  const created = await request(base, '/api/browser-sessions/bs_1/runs', {
    method: 'POST',
    body: JSON.stringify({
      task: 'Summarize',
      output_schema: { title: 'string' },
      tab_id: 42,
      wait: false,
    }),
  });
  assert.equal(created.status, 202);
  assert.equal(created.body.run_id, 'run_test');
  assert.equal(created.body.session_id, 'bs_1');

  const waited = await request(base, '/api/browser-sessions/bs_1/runs', {
    method: 'POST',
    body: JSON.stringify({
      task: 'Summarize and wait',
      output_schema: { title: 'string' },
      tab_id: 42,
      wait: true,
      timeout_ms: 1000,
    }),
  });
  assert.equal(waited.status, 200);
  assert.equal(waited.body.status, 'completed');
  assert.deepEqual(waited.body.result, { title: 'Done' });

  const aborted = await request(base, '/api/browser-sessions/bs_1/runs/run_test/abort', { method: 'POST' });
  assert.equal(aborted.status, 200);
  assert.equal(aborted.body.status, 'aborted');

  const interrupted = await request(base, '/api/browser-sessions/bs_1/runs', {
    method: 'POST',
    body: JSON.stringify({ task: 'Disconnect me', tab_id: 42, wait: false }),
  });
  assert.equal(interrupted.status, 202);
  ws.close();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sidecar.runs.get(interrupted.body.run_id).status, 'failed');

  await sidecar.close();
});
