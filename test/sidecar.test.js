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
      assert.equal(msg.payload.apiMutationsAllowed, true);
      if (msg.payload.task === 'Summarize') assert.equal(msg.payload.capture, 'video');
      const runId = msg.payload.task === 'Ask for input'
        ? 'run_input'
        : (msg.payload.task === 'Continue summary' ? 'run_child' : 'run_test');
      statuses.set(runId, {
        runId,
        status: 'running',
        parentRunId: msg.payload.parentRunId || null,
        tabId: 7,
        task: msg.payload.task,
        updates: [],
      });
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: statuses.get(runId) }));
      if (runId === 'run_input') {
        setTimeout(() => {
          statuses.set(runId, {
            ...statuses.get(runId),
            status: 'needs_user_input',
            pendingInput: { clarifyId: 'clr_1', question: 'Continue?', options: ['yes', 'no'] },
            updates: [{ seq: 1, type: 'clarify', data: { clarifyId: 'clr_1', question: 'Continue?', options: ['yes', 'no'] } }],
          });
        }, 5);
        return;
      }
      setTimeout(() => {
        statuses.set(runId, {
          ...statuses.get(runId),
          status: 'completed',
          result: { title: 'Done' },
          summary: 'Finished.',
          finalUrl: 'https://example.com',
          updates: [
            { seq: 1, type: 'thinking', data: { step: 1 }, ts: '2026-07-14T10:00:00.000Z' },
            { seq: 2, type: 'tool_call', data: { name: 'read_page', args: {} }, ts: '2026-07-14T10:00:01.000Z' },
          ],
        });
      }, 40);
      return;
    }
    if (msg.action === 'cloud_status') {
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: statuses.get(msg.payload.runId) }));
      return;
    }
    if (msg.action === 'cloud_respond') {
      assert.deepEqual(msg.payload, { runId: 'run_input', clarifyId: 'clr_1', answer: 'yes' });
      const current = statuses.get(msg.payload.runId);
      statuses.set(msg.payload.runId, { ...current, status: 'running', pendingInput: null });
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
      api_mutations_allowed: true,
      output_schema: { title: 'string' },
      capture: 'video',
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
      api_mutations_allowed: true,
      output_schema: { title: 'string' },
      tab_id: 42,
      wait: true,
      timeout_ms: 1000,
    }),
  });
  assert.equal(waited.status, 200);
  assert.equal(waited.body.status, 'completed');
  assert.deepEqual(waited.body.result, { title: 'Done' });
  assert.deepEqual(waited.body.updates.map(update => update.seq), [1, 2]);
  assert.equal(waited.body.updates[1].data.name, 'read_page');

  const followUp = await request(base, '/api/browser-sessions/bs_1/runs', {
    method: 'POST',
    body: JSON.stringify({
      task: 'Continue summary',
      parent_run_id: 'run_test',
      api_mutations_allowed: true,
      tab_id: 42,
      wait: false,
    }),
  });
  assert.equal(followUp.status, 202);
  assert.equal(followUp.body.run_id, 'run_child');
  assert.equal(followUp.body.parent_run_id, 'run_test');

  const paused = await request(base, '/runs', {
    method: 'POST',
    body: JSON.stringify({
      task: 'Ask for input',
      api_mutations_allowed: true,
      tab_id: 42,
      wait: true,
      timeout_ms: 1000,
    }),
  });
  assert.equal(paused.status, 202);
  assert.equal(paused.body.status, 'needs_user_input');
  assert.equal(paused.body.pending_input.clarifyId, 'clr_1');
  const invalidResponse = await request(base, '/runs/run_input/responses', {
    method: 'POST',
    body: JSON.stringify({ clarify_id: 'clr_1' }),
  });
  assert.equal(invalidResponse.status, 400);
  const resumed = await request(base, '/runs/run_input/responses', {
    method: 'POST',
    body: JSON.stringify({ clarify_id: 'clr_1', answer: 'yes' }),
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.status, 'running');
  assert.equal(resumed.body.pending_input, null);

  const aborted = await request(base, '/api/browser-sessions/bs_1/runs/run_test/abort', { method: 'POST' });
  assert.equal(aborted.status, 200);
  assert.equal(aborted.body.status, 'aborted');

  const interrupted = await request(base, '/api/browser-sessions/bs_1/runs', {
    method: 'POST',
    body: JSON.stringify({ task: 'Disconnect me', api_mutations_allowed: true, tab_id: 42, wait: false }),
  });
  assert.equal(interrupted.status, 202);
  ws.close();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sidecar.runs.get(interrupted.body.run_id).status, 'failed');

  await sidecar.close();
});

test('sidecar negotiates workflow capability and uses distinct compile and replay actions', async () => {
  const sidecar = createSidecarServer({ port: 0, requestTimeoutMs: 1000 });
  const address = await sidecar.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/extension`);
  const runtimeValue = 'runtime-only@example.com';
  await new Promise(resolve => ws.once('open', resolve));
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString('utf8'));
    if (msg.action === 'cloud_workflow_compile') {
      assert.deepEqual(msg.payload, { runId: 'run_source', name: 'Fill form' });
      ws.send(JSON.stringify({
        id: msg.id,
        ok: true,
        result: { ok: true, workflow: { schema: 'webbrain-workflow/1', id: 'wfl_1' }, warnings: [] },
      }));
      return;
    }
    if (msg.action === 'cloud_workflow_run') {
      assert.equal(msg.payload.parameters.email, runtimeValue);
      assert.equal(msg.payload.workflow.id, 'wfl_1');
      ws.send(JSON.stringify({
        id: msg.id,
        ok: true,
        result: { runId: 'run_workflow', workflowId: 'wfl_1', status: 'running', tabId: 5 },
      }));
    }
  });
  ws.send(JSON.stringify({
    type: 'hello',
    client: 'webbrain-extension',
    protocolVersion: 2,
    capabilities: ['saved_workflows_v1'],
  }));
  await new Promise(resolve => setTimeout(resolve, 0));

  const health = await request(base, '/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.body.extension_protocol_version, 2);
  assert.deepEqual(health.body.capabilities, ['saved_workflows_v1']);

  const compiled = await request(base, '/runs/run_source/workflow', {
    method: 'POST',
    body: JSON.stringify({ name: 'Fill form' }),
  });
  assert.equal(compiled.status, 200);
  assert.equal(compiled.body.workflow.id, 'wfl_1');

  const started = await request(base, '/runs', {
    method: 'POST',
    body: JSON.stringify({
      workflow: { schema: 'webbrain-workflow/1', id: 'wfl_1' },
      parameters: { email: runtimeValue },
      tab_id: 5,
    }),
  });
  assert.equal(started.status, 202);
  assert.equal(started.body.workflow_id, 'wfl_1');
  assert.doesNotMatch(JSON.stringify(started.body), new RegExp(runtimeValue));
  assert.doesNotMatch(JSON.stringify(sidecar.runs.get('run_workflow')), new RegExp(runtimeValue));

  ws.close();
  await sidecar.close();
});
