import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { MemoryStore } from '../src/db/memory.js';
import { DigitalOceanProvisioner, NullProvisioner, digitalOceanDropletName } from '../src/platform/digitalocean.js';
import { loadConfig } from '../src/platform/config.js';
import { createPlatformServer } from '../src/platform/server.js';
import { chromeExtensionIdForPath, renderCloudInit } from '../src/platform/cloud-init.js';
import { verifyNoVncToken } from '../src/shared/novnc-token.js';
import { instanceHostname, sessionIdFromInstanceHost } from '../src/platform/instance-proxy.js';
import { hashToken } from '../src/shared/crypto.js';

async function startPlatform(env = {}) {
  const config = loadConfig({
    WEBBRAIN_DB_DRIVER: 'memory',
    WEBBRAIN_PROVISIONER: 'null',
    WEBBRAIN_INSTANCE_DOMAIN: 'webbrain.cloud',
    WEBBRAIN_REGISTRATION_ENABLED: 'true',
    WEBBRAIN_MODEL_PROXY_BASE_URL: 'http://127.0.0.1:65530/v1',
    WEBBRAIN_RUN_POLL_INTERVAL_MS: '10',
    WEBBRAIN_RUN_WAIT_TIMEOUT_MS: '1000',
    ...env,
  });
  const store = new MemoryStore();
  const provisioner = new NullProvisioner();
  const platform = createPlatformServer({ store, provisioner, config });
  const address = await platform.listen(0, '127.0.0.1');
  return {
    config,
    store,
    provisioner,
    platform,
    base: `http://127.0.0.1:${address.port}`,
    wsBase: `ws://127.0.0.1:${address.port}`,
  };
}

async function request(base, path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    body: text ? JSON.parse(text) : null,
  };
}

async function requestText(base, path, options = {}) {
  const res = await fetch(`${base}${path}`, options);
  return {
    status: res.status,
    headers: res.headers,
    text: await res.text(),
  };
}

function cookieFrom(res) {
  return res.headers.get('set-cookie')?.split(';')[0] || '';
}

async function register(base, email) {
  const res = await request(base, '/auth/register', {
    method: 'POST',
    headers: { accept: 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  assert.equal(res.status, 201);
  return cookieFrom(res);
}

test('platform auth, API keys, session ownership, run lifecycle, and abort', async () => {
  const ctx = await startPlatform();
  let ws = null;
  try {
  const cookie = await register(ctx.base, 'a@example.com');
  const otherCookie = await register(ctx.base, 'b@example.com');

  const keyRes = await request(ctx.base, '/api/api-keys', {
    method: 'POST',
    headers: { cookie },
    body: JSON.stringify({ name: 'test key' }),
  });
  assert.equal(keyRes.status, 201);
  assert.match(keyRes.body.key, /^wbp_/);
  assert.match(keyRes.body.api_key.prefix, /^[a-f0-9]{8}$/);

  const legacyRawKey = 'wbp_ab_cd12_legacy-secret';
  const legacyUser = await ctx.store.findUserByEmail('a@example.com');
  await ctx.store.createApiKey({
    id: 'key_legacy_underscore',
    user_id: legacyUser.id,
    name: 'legacy underscore prefix',
    prefix: 'ab_cd12',
    key_hash: hashToken(legacyRawKey),
    last_used_at: null,
    revoked_at: null,
    created_at: new Date().toISOString(),
  });
  const legacyAuth = await request(ctx.base, '/api/me', {
    headers: { authorization: `Bearer ${legacyRawKey}` },
  });
  assert.equal(legacyAuth.status, 200);

  const revokedLegacy = await request(ctx.base, '/api/api-keys/key_legacy_underscore', {
    method: 'DELETE',
    headers: { cookie },
  });
  assert.equal(revokedLegacy.status, 200);
  const keyHistory = await request(ctx.base, '/api/api-keys', { headers: { cookie } });
  assert.equal(keyHistory.status, 200);
  assert.equal(keyHistory.body.api_keys.length, 2);
  assert.equal(keyHistory.body.api_keys.find(key => key.id === 'key_legacy_underscore').revoked_at !== null, true);
  const revokedAuth = await request(ctx.base, '/api/me', {
    headers: { authorization: `Bearer ${legacyRawKey}` },
  });
  assert.equal(revokedAuth.status, 401);

  const sessionRes = await request(ctx.base, '/api/browser-sessions', {
    method: 'POST',
    headers: { authorization: `Bearer ${keyRes.body.key}` },
    body: JSON.stringify({
      region: 'nyc3',
      size: 's-1vcpu-1gb',
      display_name: 'Daily research',
      proxy: {
        domain: 'proxy-start.example',
        port: 8080,
        username: 'startup-user',
        password: 'startup-p@ss',
      },
    }),
  });
  assert.equal(sessionRes.status, 201);
  assert.equal(sessionRes.body.browser_session.status, 'ready');
  assert.equal(sessionRes.body.browser_session.display_name, 'Daily research');
  assert.deepEqual(sessionRes.body.browser_session.proxy, {
    enabled: true,
    endpoint: 'http://proxy-start.example:8080',
    updated_at: sessionRes.body.browser_session.proxy.updated_at,
  });
  assert.equal(sessionRes.body.browser_session.proxy.updated_at !== null, true);
  assert.equal(ctx.provisioner.createdOptions[0].proxyUrl, 'http://startup-user:startup-p%40ss@proxy-start.example:8080/');
  const sessionId = sessionRes.body.browser_session.id;
  const storedSession = await ctx.store.getBrowserSession(sessionId);
  assert.equal(storedSession.connect_secret.length > 20, true);

  const renamed = await request(ctx.base, `/api/browser-sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { cookie },
    body: JSON.stringify({ display_name: 'Client work' }),
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.browser_session.display_name, 'Client work');
  assert.equal((await ctx.store.getBrowserSession(sessionId)).display_name, 'Client work');

  const tooLongName = await request(ctx.base, `/api/browser-sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { cookie },
    body: JSON.stringify({ display_name: 'x'.repeat(121) }),
  });
  assert.equal(tooLongName.status, 400);

  const notReady = await request(ctx.base, `/api/browser-sessions/${sessionId}/runs`, {
    method: 'POST',
    headers: { cookie },
    body: JSON.stringify({ task: 'Too early' }),
  });
  assert.equal(notReady.status, 409);
  assert.equal(notReady.body.extension_connected, false);

  const forbidden = await request(ctx.base, `/api/browser-sessions/${sessionId}`, {
    headers: { cookie: otherCookie },
  });
  assert.equal(forbidden.status, 404);

  const connect = await request(ctx.base, `/api/browser-sessions/${sessionId}/connect-token`, {
    method: 'POST',
    headers: { cookie },
    body: JSON.stringify({ scheme: 'http', port: 6081 }),
  });
  assert.equal(connect.status, 200);
  assert.equal(verifyNoVncToken(connect.body.token, storedSession.connect_secret).ok, true);
  assert.match(connect.body.url, /token=/);
  const connectUrl = new URL(connect.body.url);
  assert.equal(connectUrl.protocol, 'https:');
  assert.equal(connectUrl.hostname, instanceHostname(sessionId, 'webbrain.cloud'));
  assert.equal(connectUrl.searchParams.get('autoconnect'), 'true');
  assert.equal(connectUrl.searchParams.get('resize'), 'scale');
  assert.equal(connectUrl.searchParams.get('path'), `websockify?token=${connect.body.token}`);

  ws = new WebSocket(`${ctx.wsBase}/droplet/control?session_token=${encodeURIComponent(storedSession.connect_secret)}`);
  await new Promise(resolve => ws.once('open', resolve));
  const statuses = new Map();
  let statusPolls = 0;
  let runSeq = 0;
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString('utf8'));
    if (msg.type === 'hello') return;
    if (msg.action === 'health') {
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: { ok: true, extension_connected: true } }));
      return;
    }
    if (msg.action === 'proxy.status') {
      ws.send(JSON.stringify({
        id: msg.id,
        ok: true,
        result: {
          enabled: true,
          endpoint: 'http://proxy-start.example:8080',
          exit_ip: '198.51.100.10',
          updated_at: '2026-07-15T06:00:00.000Z',
          verified_at: '2026-07-15T06:00:01.000Z',
        },
      }));
      return;
    }
    if (msg.action === 'proxy.update') {
      assert.equal(msg.payload.verify, true);
      if (!msg.payload.proxy_url) {
        ws.send(JSON.stringify({
          id: msg.id,
          ok: true,
          result: {
            enabled: false,
            endpoint: null,
            exit_ip: '203.0.113.40',
            updated_at: '2026-07-15T06:20:00.000Z',
            verified_at: '2026-07-15T06:20:01.000Z',
          },
        }));
        return;
      }
      assert.equal(msg.payload.proxy_url, 'http://next-user:next-p%40ss@proxy-next.example:9000/');
      ws.send(JSON.stringify({
        id: msg.id,
        ok: true,
        result: {
          enabled: true,
          endpoint: 'http://proxy-next.example:9000',
          exit_ip: '198.51.100.20',
          updated_at: '2026-07-15T06:10:00.000Z',
          verified_at: '2026-07-15T06:10:01.000Z',
        },
      }));
      return;
    }
    if (msg.action === 'run') {
      assert.equal(msg.payload.api_mutations_allowed, true);
      assert.equal(msg.payload.tab_id ?? null, msg.payload.task === 'Long task' ? 91 : null);
      const runId = `run_cloud_${++runSeq}`;
      statuses.set(runId, { run_id: runId, status: 'running', task: msg.payload.task });
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: statuses.get(runId) }));
      return;
    }
    if (msg.action === 'status') {
      const current = statuses.get(msg.payload.run_id);
      if (current?.task === 'Interactive task') {
        if (current.status === 'running' && current.responded) {
          statuses.set(msg.payload.run_id, {
            ...current,
            status: 'completed',
            result: 'Continued',
            completed_at: '2026-07-14T10:00:04.000Z',
          });
        } else if (current.status === 'running') {
          statuses.set(msg.payload.run_id, {
            ...current,
            status: 'needs_user_input',
            pending_input: {
              clarifyId: 'clr_account',
              question: 'Which account?',
              options: ['Personal', 'Work'],
            },
            updates: [{
              seq: 1,
              type: 'clarify',
              data: { clarifyId: 'clr_account', question: 'Which account?', options: ['Personal', 'Work'] },
              ts: '2026-07-14T10:00:03.000Z',
            }],
          });
        }
        ws.send(JSON.stringify({ id: msg.id, ok: true, result: statuses.get(msg.payload.run_id) }));
        return;
      }
      statusPolls += 1;
      if (statusPolls >= 2) {
        statuses.set(msg.payload.run_id, {
          run_id: msg.payload.run_id,
          status: 'completed',
          result: { title: 'Done' },
          summary: 'Finished.',
          final_url: 'https://example.com',
          updates: [
            { seq: 1, type: 'thinking', data: { step: 1 }, ts: '2026-07-14T10:00:00.000Z' },
            { seq: 2, type: 'tool_call', data: { name: 'read_page', args: {} }, ts: '2026-07-14T10:00:01.000Z' },
            { seq: 3, type: 'tool_result', data: { name: 'read_page', result: { success: true } }, ts: '2026-07-14T10:00:02.000Z' },
          ],
        });
      } else {
        statuses.set(msg.payload.run_id, {
          ...statuses.get(msg.payload.run_id),
          updates: [
            { seq: 1, type: 'thinking', data: { step: 1 }, ts: '2026-07-14T10:00:00.000Z' },
          ],
        });
      }
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: statuses.get(msg.payload.run_id) }));
      return;
    }
    if (msg.action === 'respond') {
      assert.equal(msg.payload.clarify_id, 'clr_account');
      assert.equal(msg.payload.answer, 'Work');
      const current = statuses.get(msg.payload.run_id);
      const next = {
        ...current,
        status: 'running',
        responded: true,
        pending_input: null,
        updates: [
          ...(current.updates || []),
          { seq: 2, type: 'clarify_response', data: { clarifyId: 'clr_account', source: 'cloud_api' }, ts: '2026-07-14T10:00:03.500Z' },
        ],
      };
      statuses.set(msg.payload.run_id, next);
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: next }));
      return;
    }
    if (msg.action === 'abort') {
      const next = {
        run_id: msg.payload.run_id,
        status: 'aborted',
        error: 'Abort requested.',
      };
      statuses.set(msg.payload.run_id, next);
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: next }));
    }
  });

  const proxyStatus = await request(ctx.base, `/api/browser-sessions/${sessionId}/proxy`, {
    headers: { cookie },
  });
  assert.equal(proxyStatus.status, 200);
  assert.equal(proxyStatus.body.proxy.exit_ip, '198.51.100.10');
  assert.equal(proxyStatus.body.proxy.endpoint, 'http://proxy-start.example:8080');

  const proxyUpdated = await request(ctx.base, `/api/browser-sessions/${sessionId}/proxy`, {
    method: 'PATCH',
    headers: { cookie },
    body: JSON.stringify({
      proxy: {
        domain: 'proxy-next.example',
        port: 9000,
        username: 'next-user',
        password: 'next-p@ss',
      },
    }),
  });
  assert.equal(proxyUpdated.status, 200);
  assert.equal(proxyUpdated.body.proxy.endpoint, 'http://proxy-next.example:9000');
  assert.equal(JSON.stringify(proxyUpdated.body).includes('next-p@ss'), false);
  assert.equal(JSON.stringify(proxyUpdated.body).includes('next-p%40ss'), false);
  const proxyStored = await ctx.store.getBrowserSession(sessionId);
  assert.equal(proxyStored.proxy_endpoint, 'http://proxy-next.example:9000');
  assert.equal(proxyStored.proxy_enabled, true);

  const waited = await request(ctx.base, `/api/browser-sessions/${sessionId}/runs`, {
    method: 'POST',
    headers: { cookie },
    body: JSON.stringify({
      task: 'Summarize this page',
      output_schema: { title: 'string' },
      wait: true,
      timeout_ms: 1000,
    }),
  });
  assert.equal(waited.status, 200);
  assert.equal(waited.body.status, 'completed');
  assert.deepEqual(waited.body.result, { title: 'Done' });
  assert.deepEqual(waited.body.updates.map(update => update.seq), [1, 2, 3]);
  assert.equal((await ctx.store.getCloudRun(waited.body.run_id)).updates[1].data.name, 'read_page');

  const needsInput = await request(ctx.base, `/api/browser-sessions/${sessionId}/runs`, {
    method: 'POST',
    headers: { cookie },
    body: JSON.stringify({ task: 'Interactive task', wait: true, timeout_ms: 1000 }),
  });
  assert.equal(needsInput.status, 202);
  assert.equal(needsInput.body.status, 'needs_user_input');
  assert.deepEqual(needsInput.body.pending_input, {
    clarify_id: 'clr_account',
    question: 'Which account?',
    options: ['Personal', 'Work'],
    reason: '',
    permission: null,
    submit_confirmation: null,
  });

  const forbiddenResponse = await request(ctx.base, `/api/browser-sessions/${sessionId}/runs/${needsInput.body.run_id}/responses`, {
    method: 'POST',
    headers: { cookie: otherCookie },
    body: JSON.stringify({ clarify_id: 'clr_account', answer: 'Work' }),
  });
  assert.equal(forbiddenResponse.status, 404);

  const emptyResponse = await request(ctx.base, `/api/browser-sessions/${sessionId}/runs/${needsInput.body.run_id}/responses`, {
    method: 'POST',
    headers: { cookie },
    body: JSON.stringify({ clarify_id: 'clr_account', answer: '' }),
  });
  assert.equal(emptyResponse.status, 400);

  const staleResponse = await request(ctx.base, `/api/browser-sessions/${sessionId}/runs/${needsInput.body.run_id}/responses`, {
    method: 'POST',
    headers: { cookie },
    body: JSON.stringify({ clarify_id: 'clr_stale', answer: 'Work' }),
  });
  assert.equal(staleResponse.status, 409);
  assert.equal(staleResponse.body.pending_clarify_id, 'clr_account');

  const responded = await request(ctx.base, `/api/browser-sessions/${sessionId}/runs/${needsInput.body.run_id}/responses`, {
    method: 'POST',
    headers: { cookie },
    body: JSON.stringify({ clarify_id: 'clr_account', answer: 'Work' }),
  });
  assert.equal(responded.status, 200);
  assert.equal(responded.body.status, 'running');
  assert.equal(responded.body.pending_input, null);
  assert.deepEqual(responded.body.updates.at(-1), {
    seq: 2,
    type: 'clarify_response',
    data: { clarifyId: 'clr_account', source: 'cloud_api' },
    ts: '2026-07-14T10:00:03.500Z',
  });
  assert.equal(ctx.store.auditLogs.some(entry => entry.action === 'cloud_run.respond'), true);

  const continued = await request(ctx.base, `/api/browser-sessions/${sessionId}/runs/${needsInput.body.run_id}`, {
    headers: { cookie },
  });
  assert.equal(continued.status, 200);
  assert.equal(continued.body.status, 'completed');
  assert.equal(continued.body.result, 'Continued');

  statusPolls = 0;
  const created = await request(ctx.base, `/api/browser-sessions/${sessionId}/runs`, {
    method: 'POST',
    headers: { cookie },
    body: JSON.stringify({ task: 'Long task', tab_id: 91, wait: false }),
  });
  assert.equal(created.status, 202);
  const proxyBlockedDuringRun = await request(ctx.base, `/api/browser-sessions/${sessionId}/proxy`, {
    method: 'PATCH',
    headers: { cookie },
    body: JSON.stringify({ proxy_url: null }),
  });
  assert.equal(proxyBlockedDuringRun.status, 409);
  assert.deepEqual(proxyBlockedDuringRun.body.active_run_ids, [created.body.run_id]);
  const aborted = await request(ctx.base, `/api/browser-sessions/${sessionId}/runs/${created.body.run_id}/abort`, {
    method: 'POST',
    headers: { cookie },
  });
  assert.equal(aborted.status, 200);
  assert.equal(aborted.body.status, 'aborted');
  const directProxy = await request(ctx.base, `/api/browser-sessions/${sessionId}/proxy`, {
    method: 'DELETE',
    headers: { cookie },
  });
  assert.equal(directProxy.status, 200);
  assert.equal(directProxy.body.proxy.enabled, false);
  assert.equal((await ctx.store.getBrowserSession(sessionId)).proxy_endpoint, null);
  assert.equal(ctx.store.auditLogs.some(entry => entry.action === 'browser_session.proxy_delete'), true);
  const directProxyAgain = await request(ctx.base, `/api/browser-sessions/${sessionId}/proxy`, {
    method: 'DELETE',
    headers: { cookie },
  });
  assert.equal(directProxyAgain.status, 200);
  assert.equal(directProxyAgain.body.proxy.enabled, false);

  const newestLogs = await request(ctx.base, '/api/runs?limit=1&offset=0', { headers: { cookie } });
  assert.equal(newestLogs.status, 200);
  assert.equal(newestLogs.body.runs.length, 1);
  assert.equal(newestLogs.body.runs[0].run_id, created.body.run_id);
  assert.equal(newestLogs.body.runs[0].task, 'Long task');
  assert.equal(newestLogs.body.runs[0].status, 'aborted');
  assert.equal(newestLogs.body.has_more, true);
  assert.equal(newestLogs.body.next_offset, 1);
  assert.equal('updates' in newestLogs.body.runs[0], false);
  assert.equal('result' in newestLogs.body.runs[0], false);

  const olderLogs = await request(ctx.base, '/api/runs?limit=1&offset=1', { headers: { cookie } });
  assert.equal(olderLogs.status, 200);
  assert.equal(olderLogs.body.runs[0].run_id, needsInput.body.run_id);
  assert.equal(olderLogs.body.runs[0].task, 'Interactive task');
  assert.equal(olderLogs.body.runs[0].update_count, 2);
  assert.equal(olderLogs.body.has_more, true);

  const oldestLogs = await request(ctx.base, '/api/runs?limit=1&offset=2', { headers: { cookie } });
  assert.equal(oldestLogs.status, 200);
  assert.equal(oldestLogs.body.runs[0].run_id, waited.body.run_id);
  assert.equal(oldestLogs.body.runs[0].task, 'Summarize this page');
  assert.equal(oldestLogs.body.runs[0].update_count, 3);
  assert.equal(oldestLogs.body.has_more, false);

  const otherLogs = await request(ctx.base, '/api/runs', { headers: { cookie: otherCookie } });
  assert.equal(otherLogs.status, 200);
  assert.deepEqual(otherLogs.body.runs, []);

  } finally {
    ws?.close();
    await ctx.platform.close();
  }
});

test('account settings securely update email and password', async () => {
  const ctx = await startPlatform();
  try {
    const cookie = await register(ctx.base, 'owner@example.com');
    await register(ctx.base, 'taken@example.com');
    const secondLogin = await request(ctx.base, '/auth/login', {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'password123' }),
    });
    assert.equal(secondLogin.status, 200);
    const otherCookie = cookieFrom(secondLogin);

    const keyRes = await request(ctx.base, '/api/api-keys', {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify({ name: 'account test' }),
    });
    const apiKeyUpdate = await request(ctx.base, '/api/me', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${keyRes.body.key}` },
      body: JSON.stringify({ email: 'new-owner@example.com', current_password: 'password123' }),
    });
    assert.equal(apiKeyUpdate.status, 403);
    assert.equal(apiKeyUpdate.body.error, 'Account changes require a signed-in dashboard session');

    const wrongPassword = await request(ctx.base, '/api/me', {
      method: 'PATCH',
      headers: { cookie },
      body: JSON.stringify({ email: 'new-owner@example.com', current_password: 'wrong-password' }),
    });
    assert.equal(wrongPassword.status, 401);
    assert.equal(wrongPassword.body.error, 'Current password is incorrect');

    const duplicateEmail = await request(ctx.base, '/api/me', {
      method: 'PATCH',
      headers: { cookie },
      body: JSON.stringify({ email: 'taken@example.com', current_password: 'password123' }),
    });
    assert.equal(duplicateEmail.status, 409);
    assert.equal(duplicateEmail.body.error, 'Email already registered');

    const invalidEmail = await request(ctx.base, '/api/me', {
      method: 'PATCH',
      headers: { cookie },
      body: JSON.stringify({ email: 'not-an-email', current_password: 'password123' }),
    });
    assert.equal(invalidEmail.status, 400);
    assert.equal(invalidEmail.body.error, 'Enter a valid email address');

    const shortPassword = await request(ctx.base, '/api/me', {
      method: 'PATCH',
      headers: { cookie },
      body: JSON.stringify({ email: 'owner@example.com', current_password: 'password123', new_password: 'short' }),
    });
    assert.equal(shortPassword.status, 400);
    assert.equal(shortPassword.body.error, 'New password must be at least 8 characters');

    const unchanged = await request(ctx.base, '/api/me', {
      method: 'PATCH',
      headers: { cookie },
      body: JSON.stringify({ email: 'owner@example.com', current_password: 'password123' }),
    });
    assert.equal(unchanged.status, 400);

    const updated = await request(ctx.base, '/api/me', {
      method: 'PATCH',
      headers: { cookie },
      body: JSON.stringify({
        email: 'new-owner@example.com',
        current_password: 'password123',
        new_password: 'new-password-456',
      }),
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.user.email, 'new-owner@example.com');
    assert.equal(updated.body.password_changed, true);
    assert.equal(updated.body.other_sessions_revoked, 1);

    const currentSession = await request(ctx.base, '/api/me', { headers: { cookie } });
    assert.equal(currentSession.status, 200);
    assert.equal(currentSession.body.user.email, 'new-owner@example.com');
    assert.equal((await request(ctx.base, '/api/me', { headers: { cookie: otherCookie } })).status, 401);

    const oldEmailLogin = await request(ctx.base, '/auth/login', {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'new-password-456' }),
    });
    assert.equal(oldEmailLogin.status, 401);
    const oldPasswordLogin = await request(ctx.base, '/auth/login', {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: JSON.stringify({ email: 'new-owner@example.com', password: 'password123' }),
    });
    assert.equal(oldPasswordLogin.status, 401);
    const newLogin = await request(ctx.base, '/auth/login', {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: JSON.stringify({ email: 'new-owner@example.com', password: 'new-password-456' }),
    });
    assert.equal(newLogin.status, 200);

    const updateAudit = ctx.store.auditLogs.find(entry => entry.action === 'user.update');
    assert.deepEqual(updateAudit.metadata, {
      email_changed: true,
      password_changed: true,
      other_sessions_revoked: 1,
    });
  } finally {
    await ctx.platform.close();
  }
});

test('browser sessions inherit the platform proxy default unless explicitly disabled', async () => {
  const ctx = await startPlatform({
    WEBBRAIN_BROWSER_PROXY_URL: 'http://default-user:default-pass@proxy-default.example:8080',
  });
  try {
    const cookie = await register(ctx.base, 'default-proxy@example.com');
    const inherited = await request(ctx.base, '/api/browser-sessions', {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify({ display_name: 'Inherited proxy' }),
    });
    assert.equal(inherited.status, 201);
    assert.equal(inherited.body.browser_session.proxy.endpoint, 'http://proxy-default.example:8080');
    assert.equal(ctx.provisioner.createdOptions[0].proxyUrl, 'http://default-user:default-pass@proxy-default.example:8080/');

    const direct = await request(ctx.base, '/api/browser-sessions', {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify({ display_name: 'Direct', proxy_url: null }),
    });
    assert.equal(direct.status, 201);
    assert.equal(direct.body.browser_session.proxy.enabled, false);
    assert.equal(ctx.provisioner.createdOptions[1].proxyUrl, '');

    const invalid = await request(ctx.base, '/api/browser-sessions', {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify({ proxy_url: 'ftp://proxy.example:21' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(ctx.provisioner.created.length, 2);
  } finally {
    await ctx.platform.close();
  }
});

test('model proxy replaces browser credentials and uses a stable platform-user identity', async () => {
  let captured = null;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = {
      url: req.url,
      authorization: req.headers.authorization || '',
      deviceId: req.headers['x-webbrain-device-id'] || '',
      client: req.headers['x-webbrain-client'] || '',
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"choices":[');
    res.end('{"message":{"content":"ok"}}]}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}/v1`;
  const ctx = await startPlatform({ WEBBRAIN_MODEL_PROXY_BASE_URL: upstreamBase });
  try {
    const cookie = await register(ctx.base, 'proxy@example.com');
    const sessionRes = await request(ctx.base, '/api/browser-sessions', {
      method: 'POST', headers: { cookie }, body: JSON.stringify({}),
    });
    const stored = await ctx.store.getBrowserSession(sessionRes.body.browser_session.id);
    const user = await ctx.store.findUserByEmail('proxy@example.com');
    const response = await request(ctx.base, '/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${stored.connect_secret}`,
        'x-webbrain-device-id': 'caller-controlled',
        'x-webbrain-client': 'caller-controlled',
      },
      body: JSON.stringify({ model: 'webbrain-cloud 1.0', messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.choices[0].message.content, 'ok');
    assert.equal(captured.url, '/v1/chat/completions');
    assert.equal(captured.authorization, '');
    assert.equal(captured.deviceId, `platform-${hashToken(`webbrain-platform:${user.id}`).slice(0, 32)}`);
    assert.equal(captured.client, 'platform');
    assert.equal(captured.body.messages[0].content, 'hello');
  } finally {
    await ctx.platform.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('authenticated dashboard renders browser session controls and noVNC viewer', async () => {
  const ctx = await startPlatform();
  try {
    const cookie = await register(ctx.base, 'dashboard@example.com');
    const res = await requestText(ctx.base, '/', { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.match(res.text, /<span class="brand-name">WebBrain<\/span><span class="brand-domain">\.cloud/);
    assert.match(res.text, /<link rel="icon" type="image\/png" href="https:\/\/webbrain\.one\/logo-github\.png">/);
    assert.match(res.text, /--bg: #f7f1e6/);
    assert.match(res.text, /Browser sessions/);
    assert.match(res.text, />Connect</);
    assert.doesNotMatch(res.text, /Open noVNC/);
    assert.doesNotMatch(res.text, /Create or select a browser, then connect here\./);
    assert.match(res.text, /id="viewerStateTitle">Select a browser</);
    assert.match(res.text, /id="viewerConnectBtn"/);
    assert.match(res.text, /Preparing your browser/);
    assert.match(res.text, /Browser is ready/);
    assert.match(res.text, /browser-boot 1\.25s/);
    assert.match(res.text, /id="viewerFrames"/);
    assert.match(res.text, /id="newSessionName"/);
    assert.match(res.text, /id="newProxyDomain"/);
    assert.match(res.text, /id="newProxyPort"/);
    assert.match(res.text, /id="newProxyUsername"/);
    assert.match(res.text, /id="newProxyPassword"/);
    assert.match(res.text, /id="proxyBtn"/);
    assert.match(res.text, /id="proxyDialog"/);
    assert.match(res.text, /function saveBrowserProxy\(event\)/);
    assert.match(res.text, /body: hasNextProxy \? \{ proxy: nextProxy \} : \{ proxy_url: null \}/);
    assert.match(res.text, /id="renameDialog"/);
    assert.match(res.text, /method: 'PATCH'/);
    assert.match(res.text, /display_name/);
    assert.match(res.text, /Type I confirm to delete/);
    assert.match(res.text, /deleteConfirmInput\.value !== 'I confirm'/);
    assert.doesNotMatch(res.text, /confirm\('Delete browser session/);
    assert.match(res.text, /collapseSessionsBtn/);
    assert.match(res.text, /toggleDestroyedBtn/);
    assert.match(res.text, /showDestroyed: false/);
    assert.match(res.text, /filter\(s => s\.status !== 'destroyed'\)/);
    assert.match(res.text, /Show ' \+ destroyedCount \+ ' destroyed/);
    assert.match(res.text, /meta\.textContent = session\.id;/);
    assert.doesNotMatch(res.text, /session\.proxy\?\.enabled[^\n]+session\.proxy\.endpoint/);
    assert.doesNotMatch(res.text, /meta\.textContent = session\.public_ip/);
    assert.match(res.text, /webbrain\.sessionsCollapsed/);
    assert.match(res.text, /aria-controls="sessionPanelBody"/);
    assert.match(res.text, /setSessionsCollapsed\(true\)/);
    assert.match(res.text, /const viewerConnections = new Map\(\)/);
    assert.match(res.text, /const connectingSessionIds = new Set\(\)/);
    assert.match(res.text, /connectBtn\.textContent = isConnected \? 'Disconnect'/);
    assert.match(res.text, /item\.frame\.style\.display = sessionId === session\?\.id \? 'block' : 'none'/);
    assert.match(res.text, /frame\.allow = 'clipboard-read; clipboard-write'/);
    assert.match(res.text, /viewerConnections\.set\(sessionId, \{ frame, url: body\.url \}\)/);
    assert.match(res.text, /function removeViewerConnection\(sessionId\)/);
    assert.match(res.text, /function disconnectNoVnc\(\)/);
    assert.match(res.text, /\.session-heading > div:first-child[\s\S]*display: none !important/);
    assert.match(res.text, /\/api\/browser-sessions/);
    assert.match(res.text, /Create key/);
    assert.match(res.text, /href="#api-keys" data-view-target="api-keys"/);
    assert.match(res.text, /id="accountMenu"/);
    assert.match(res.text, /Account menu for dashboard@example\.com/);
    assert.match(res.text, /Signed in as/);
    assert.match(res.text, /Edit account[^]*Refresh dashboard/);
    assert.match(res.text, /id="accountDialog"/);
    assert.match(res.text, /id="accountEmail"[^>]*value="dashboard@example\.com"/);
    assert.match(res.text, /id="accountCurrentPassword"[^>]*autocomplete="current-password"[^>]*required/);
    assert.match(res.text, /id="accountNewPassword"[^>]*autocomplete="new-password"[^>]*minlength="8"/);
    assert.match(res.text, /id="accountConfirmPassword"/);
    assert.match(res.text, /api\('\/api\/me', \{[\s\S]*method: 'PATCH'/);
    assert.match(res.text, /function saveAccount\(event\)/);
    assert.match(res.text, /Refresh dashboard/);
    assert.match(res.text, /class="account-action logout-action" type="submit"/);
    assert.match(res.text, /accountMenu\.removeAttribute\('open'\)/);
    assert.match(res.text, /id="browserView"/);
    assert.match(res.text, /id="consoleView" hidden/);
    assert.match(res.text, /id="logsView" hidden/);
    const dashboardScript = [...res.text.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1] || '';
    assert.doesNotThrow(() => new Function(dashboardScript));
    assert.match(res.text, /id="apiKeysView" hidden/);
    assert.match(res.text, />Browsers<[^]*>Console<[^]*>API keys<[^]*>Logs</);
    assert.match(res.text, /setDashboardView/);
    assert.doesNotMatch(res.text, /\.header-link\s*\{\s*display:\s*none/);
    assert.match(res.text, /id="apiKeysList"/);
    assert.match(res.text, /loadApiKeys/);
    assert.match(res.text, /revokeApiKey/);
    assert.match(res.text, /revoked_at/);
    assert.match(res.text, /min-height: 34px/);
    assert.match(res.text, /id="consoleSessionSelect"/);
    assert.match(res.text, /id="consoleTask"/);
    assert.match(res.text, /id="executeConsoleBtn"/);
    assert.match(res.text, /id="consoleRunOutput"/);
    assert.match(res.text, /Runs are asynchronous/);
    assert.match(res.text, /Switch to Browsers at any time to watch it/);
    assert.match(res.text, /body: \{ task, wait: false \}/);
    assert.match(res.text, /function pollConsoleRun\(\)/);
    assert.match(res.text, /terminalRunStatuses/);
    assert.match(res.text, /function appendRunProgress\(/);
    assert.match(res.text, /className = 'run-progress-log'/);
    assert.match(res.text, /Live activity/);
    assert.match(res.text, /description\.detailLabel/);
    assert.match(res.text, /hiddenCount = expanded/);
    assert.match(res.text, /toggle\.textContent = expanded \? 'Show recent' : 'Show all'/);
    assert.match(res.text, /function appendRunConclusion\(/);
    assert.match(res.text, /className = 'run-conclusion'/);
    assert.doesNotMatch(res.text, /\.run-progress-log\s*\{[^}]*max-height/);
    assert.doesNotMatch(res.text, /\.run-progress-log\s*\{[^}]*overflow:\s*auto/);
    assert.doesNotMatch(res.text, /\.run-output\s*\{[^}]*max-height/);
    assert.match(res.text, /id="logsBrowserFilter"/);
    assert.match(res.text, /id="logsStatusFilter"/);
    assert.match(res.text, /function loadRunLogs\(/);
    assert.match(res.text, /function selectRunLog\(/);
    assert.match(res.text, /\/api\/runs\?limit=50&offset=/);
    assert.match(res.text, /state\.selectedId = session\.id/);
    assert.doesNotMatch(res.text, /Use this browser from code/);
    assert.match(res.text, /id="consoleCodeSessionId"/);
    assert.match(res.text, /\.tok-keyword/);
    assert.match(res.text, /\.tok-string/);
    assert.match(res.text, /highlightCode/);
    assert.match(res.text, /data-code-client="rest"/);
    assert.match(res.text, /data-code-client="node"/);
    assert.match(res.text, /data-code-client="python"/);
    assert.match(res.text, /data-code-client="php"/);
    assert.match(res.text, /jq -r \.run_id/);
    assert.match(res.text, /bs_your_session/);
    assert.match(res.text, /copyConsoleCode/);
    assert.match(res.text, /href="\/docs"/);
    assert.match(res.text, /API documentation/);
    assert.doesNotMatch(res.text, /id="regionInput"/);
    const inlineScripts = [...res.text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
    assert.ok(inlineScripts.length > 0);
    for (const script of inlineScripts) assert.doesNotThrow(() => new Function(script));
    assert.doesNotMatch(res.text, /id="sizeInput"/);
    assert.doesNotMatch(res.text, /session\.region/);
    assert.doesNotMatch(res.text, /session\.size/);
  } finally {
    await ctx.platform.close();
  }
});

test('login page uses the WebBrain visual identity', async () => {
  const ctx = await startPlatform({ WEBBRAIN_REGISTRATION_ENABLED: 'false' });
  try {
    const res = await requestText(ctx.base, '/');
    assert.equal(res.status, 200);
    assert.match(res.text, /WebBrain<span class="brand-domain">\.cloud/);
    assert.match(res.text, /<link rel="icon" type="image\/png" href="https:\/\/webbrain\.one\/logo-github\.png">/);
    assert.match(res.text, /--accent: #5b52e8/);
    assert.match(res.text, /Your AI browser/);
    assert.match(res.text, /Create account/);
    assert.match(res.text, /aria-disabled="true"/);
    assert.match(res.text, /type="email" name="email" placeholder="Email" disabled/);
    assert.match(res.text, /type="submit" disabled>Create account/);
    assert.match(res.text, /Registration is currently closed\./);
    assert.match(res.text, /href="\/docs"/);

    const registerRes = await request(ctx.base, '/auth/register', {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: JSON.stringify({ email: 'closed@example.com', password: 'password123' }),
    });
    assert.equal(registerRes.status, 403);
    assert.equal(registerRes.body.error, 'Registration is currently closed.');
    assert.equal(await ctx.store.findUserByEmail('closed@example.com'), null);
  } finally {
    await ctx.platform.close();
  }
});

test('public API documentation provides accessible REST and client tabs', async () => {
  const ctx = await startPlatform();
  try {
    const res = await requestText(ctx.base, '/docs');
    assert.equal(res.status, 200);
    assert.match(res.text, /<link rel="icon" type="image\/png" href="https:\/\/webbrain\.one\/logo-github\.png">/);
    assert.match(res.text, /One browser[\s\S]*Four ways to drive it/);
    assert.match(res.text, /role="tablist"/);
    assert.match(res.text, /data-client="rest"/);
    assert.match(res.text, /data-client="node"/);
    assert.match(res.text, /data-client="python"/);
    assert.match(res.text, /data-client="php"/);
    assert.match(res.text, /Copy example/);
    assert.match(res.text, /class="tok-comment"/);
    assert.match(res.text, /class="tok-keyword"/);
    assert.match(res.text, /class="tok-string"/);
    assert.match(res.text, /class="tok-variable"/);
    assert.match(res.text, /class="tok-function"/);
    assert.match(res.text, /\/api\/browser-sessions\/:sessionId\/runs/);
    assert.match(res.text, /\/api\/browser-sessions\/:sessionId\/runs\/:runId\/responses/);
    assert.match(res.text, /needs_user_input/);
    assert.match(res.text, /PATCH[\s\S]*\/api\/browser-sessions\/:sessionId/);
    assert.match(res.text, /tree\/main\/clients\/node/);
    assert.match(res.text, /tree\/main\/clients\/python/);
    assert.match(res.text, /tree\/main\/clients\/php/);
    assert.match(res.text, /DELETE<\/span><code>\/api\/browser-sessions\/:sessionId\/proxy/);
    assert.match(res.text, /ArrowRight/);
  } finally {
    await ctx.platform.close();
  }
});

test('instance hostnames round-trip browser session ids', () => {
  assert.equal(instanceHostname('bs_9c1e5c521147839e5cf00373', 'webbrain.cloud'), 'bs-9c1e5c521147839e5cf00373.webbrain.cloud');
  assert.equal(sessionIdFromInstanceHost('bs-9c1e5c521147839e5cf00373.webbrain.cloud', 'webbrain.cloud'), 'bs_9c1e5c521147839e5cf00373');
  assert.equal(sessionIdFromInstanceHost('webbrain.cloud', 'webbrain.cloud'), null);
});

test('instance subdomains proxy HTTP and WebSocket traffic to the session droplet', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'x-upstream-path': req.url });
    res.end('proxied');
  });
  const upstreamWss = new WebSocketServer({ server: upstream });
  upstreamWss.on('connection', ws => ws.on('message', data => ws.send(data)));
  const upstreamAddress = await new Promise(resolve => upstream.listen(0, '127.0.0.1', () => resolve(upstream.address())));

  const config = loadConfig({
    WEBBRAIN_DB_DRIVER: 'memory',
    WEBBRAIN_PROVISIONER: 'null',
    WEBBRAIN_INSTANCE_DOMAIN: 'webbrain.cloud',
    WEBBRAIN_NOVNC_GATE_PORT: String(upstreamAddress.port),
  });
  const store = new MemoryStore();
  await store.createBrowserSession({
    id: 'bs_deadbeef',
    user_id: 'usr_test',
    status: 'ready',
    public_ip: '127.0.0.1',
    connect_secret: 'secret',
    expires_at: new Date(Date.now() + 60000).toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const platform = createPlatformServer({ store, provisioner: new NullProvisioner(), config });
  const address = await platform.listen(0, '127.0.0.1');

  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: address.port,
        path: '/app/ui.css?token=test',
        headers: { host: 'bs-deadbeef.webbrain.cloud' },
      }, upstreamRes => {
        const chunks = [];
        upstreamRes.on('data', chunk => chunks.push(chunk));
        upstreamRes.on('end', () => resolve({
          status: upstreamRes.statusCode,
          headers: upstreamRes.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      req.once('error', reject);
      req.end();
    });
    assert.equal(res.status, 200);
    assert.equal(res.text, 'proxied');
    assert.equal(res.headers['x-upstream-path'], '/app/ui.css?token=test');

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/websockify?token=test`, {
      headers: { host: 'bs-deadbeef.webbrain.cloud' },
    });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send('hello');
    const echoed = await new Promise((resolve, reject) => {
      ws.once('message', data => resolve(data.toString()));
      ws.once('error', reject);
    });
    assert.equal(echoed, 'hello');
    const wsClosed = new Promise(resolve => ws.once('close', resolve));
    ws.close();
    await wsClosed;
  } finally {
    await platform.close();
    await new Promise(resolve => upstreamWss.close(() => upstream.close(resolve)));
  }
});

test('browser session cloud-init starts virtual display and noVNC services', () => {
  const config = loadConfig({
    WEBBRAIN_PLATFORM_URL: 'http://platform.example',
    WEBBRAIN_PROVIDER_BASE_URL: 'http://platform.example/v1',
    WEBBRAIN_REF: 'main',
  });
  const cloudInit = renderCloudInit({
    session: { id: 'bs_test', connect_secret: 'connect-secret' },
    config,
    providerApiKey: 'provider-secret',
  });

  assert.match(cloudInit, /DISPLAY=':99'/);
  assert.match(cloudInit, /WEBBRAIN_HEADLESS='false'/);
  assert.match(cloudInit, /WEBBRAIN_NOVNC_GATE_PORT='6081'/);
  assert.match(cloudInit, /WEBBRAIN_BROWSER_BIN='\/opt\/chrome-linux64\/chrome'/);
  assert.match(cloudInit, /WEBBRAIN_BROWSER_PROXY_SERVER='http:\/\/127\.0\.0\.1:17890'/);
  assert.match(cloudInit, /WEBBRAIN_BROWSER_PROXY_BYPASS_LIST='platform\.example'/);
  assert.match(cloudInit, /WEBBRAIN_PROXY_STATE_PATH='\/var\/lib\/webbrain\/proxy\.json'/);
  assert.match(cloudInit, /WEBBRAIN_START_URL='https:\/\/webbrain\.one'/);
  assert.match(cloudInit, /"toolbar_pin":"force_pinned"/);
  assert.match(cloudInit, new RegExp(chromeExtensionIdForPath('/opt/webbrain3/src/chrome')));
  assert.match(cloudInit, /package_upgrade: false/);
  assert.match(cloudInit, /  - build-essential/);
  assert.match(cloudInit, /  - unzip/);
  assert.match(cloudInit, /  - ufw/);
  assert.match(cloudInit, /webbrain-xvfb\.service/);
  assert.match(cloudInit, /webbrain-x11vnc\.service/);
  assert.match(cloudInit, /webbrain-novnc\.service/);
  assert.match(cloudInit, /\/opt\/noVNC\/utils\/novnc_proxy --listen 127\.0\.0\.1:6080 --vnc 127\.0\.0\.1:5900/);
  assert.match(cloudInit, /ufw allow 6081\/tcp/);
  assert.match(cloudInit, /ufw --force enable/);
  assert.match(cloudInit, /https:\/\/deb\.nodesource\.com\/setup_20\.x/);
  assert.match(cloudInit, /google-chrome-stable_current_amd64\.deb/);
  assert.match(cloudInit, /chrome-for-testing/);
  assert.match(cloudInit, /\/tmp\/chrome-linux64\.zip/);
  assert.match(cloudInit, /git clone 'https:\/\/github\.com\/webbrain-one\/webbrain\.git' \/opt\/webbrain3/);
  assert.match(cloudInit, /git clone https:\/\/github\.com\/novnc\/noVNC\.git \/opt\/noVNC/);
  assert.match(cloudInit, /After=webbrain-droplet\.service webbrain-sidecar\.service webbrain-xvfb\.service/);
  assert.match(cloudInit, /systemctl start webbrain-sidecar\.service webbrain-xvfb\.service webbrain-x11vnc\.service webbrain-novnc\.service webbrain-droplet\.service webbrain-browser\.service/);
});

test('cloud browser extension id matches Chrome unpacked-extension path hashing', () => {
  assert.equal(chromeExtensionIdForPath('/opt/webbrain3/src/chrome'), 'ojnjlpnhkfaiapnicpdgngopfpmphocc');
});

test('cloud browser launches at the virtual display size', async () => {
  const source = await readFile(new URL('../scripts/launch-cloud-browser.mjs', import.meta.url), 'utf8');
  assert.match(source, /'--window-size=1440,900'/);
  assert.match(source, /`--proxy-server=\$\{browserProxyServer\}`/);
  assert.match(source, /`--proxy-bypass-list=\$\{browserProxyBypassList\}`/);
});

test('digitalocean provisioner uses hostname-safe droplet names', async () => {
  const config = loadConfig({
    DO_API_TOKEN: 'do-token',
    DO_REGION: 'nyc3',
    DO_SIZE: 's-1vcpu-1gb',
    WEBBRAIN_PLATFORM_URL: 'http://platform.example',
  });
  let requestBody = null;
  const provisioner = new DigitalOceanProvisioner(config, async (url, options = {}) => {
    if (options.method === 'POST') {
      assert.equal(url, 'https://api.digitalocean.com/v2/droplets');
      requestBody = JSON.parse(options.body);
    }
    return {
      ok: true,
      async json() {
        return {
          droplet: {
            id: 123,
            status: 'active',
            networks: { v4: [{ type: 'public', ip_address: '203.0.113.10' }] },
          },
        };
      },
    };
  }, {
    async isRuntimeReachable(host, port, timeoutMs) {
      assert.equal(host, '203.0.113.10');
      assert.equal(port, 6081);
      assert.equal(timeoutMs, 1000);
      return true;
    },
  });

  assert.equal(digitalOceanDropletName('bs_abc123'), 'webbrain-bs-abc123');
  const created = await provisioner.createBrowserDroplet({
    id: 'bs_abc123',
    connect_secret: 'connect-secret',
  }, {
    proxyUrl: 'http://proxy-user:proxy-pass@proxy.example:8080',
  });

  assert.equal(created.status, 'provisioning');
  assert.equal(requestBody.name, 'webbrain-bs-abc123');
  assert.match(requestBody.name, /^[a-z0-9.-]+$/);
  assert.match(requestBody.user_data, /WEBBRAIN_BROWSER_PROXY_URL='http:\/\/proxy-user:proxy-pass@proxy\.example:8080'/);

  const refreshed = await provisioner.getDroplet(123);
  assert.equal(refreshed.status, 'ready');
});
