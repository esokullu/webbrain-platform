import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { MemoryStore } from '../src/db/memory.js';
import { DigitalOceanProvisioner, NullProvisioner, digitalOceanDropletName } from '../src/platform/digitalocean.js';
import { loadConfig } from '../src/platform/config.js';
import { createPlatformServer } from '../src/platform/server.js';
import { renderCloudInit } from '../src/platform/cloud-init.js';
import { verifyNoVncToken } from '../src/shared/novnc-token.js';

async function startPlatform() {
  const config = loadConfig({
    WEBBRAIN_DB_DRIVER: 'memory',
    WEBBRAIN_PROVISIONER: 'null',
    WEBBRAIN_MODEL_PROXY_BASE_URL: 'http://127.0.0.1:65530/v1',
    WEBBRAIN_RUN_POLL_INTERVAL_MS: '10',
    WEBBRAIN_RUN_WAIT_TIMEOUT_MS: '1000',
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

  const sessionRes = await request(ctx.base, '/api/browser-sessions', {
    method: 'POST',
    headers: { authorization: `Bearer ${keyRes.body.key}` },
    body: JSON.stringify({ region: 'nyc3', size: 's-1vcpu-1gb' }),
  });
  assert.equal(sessionRes.status, 201);
  assert.equal(sessionRes.body.browser_session.status, 'ready');
  const sessionId = sessionRes.body.browser_session.id;
  const storedSession = await ctx.store.getBrowserSession(sessionId);
  assert.equal(storedSession.connect_secret.length > 20, true);

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

  ws = new WebSocket(`${ctx.wsBase}/droplet/control?session_token=${encodeURIComponent(storedSession.connect_secret)}`);
  await new Promise(resolve => ws.once('open', resolve));
  const statuses = new Map();
  let statusPolls = 0;
  let runSeq = 0;
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString('utf8'));
    if (msg.type === 'hello') return;
    if (msg.action === 'run') {
      const runId = `run_cloud_${++runSeq}`;
      statuses.set(runId, { run_id: runId, status: 'running' });
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: statuses.get(runId) }));
      return;
    }
    if (msg.action === 'status') {
      statusPolls += 1;
      if (statusPolls >= 2) {
        statuses.set(msg.payload.run_id, {
          run_id: msg.payload.run_id,
          status: 'completed',
          result: { title: 'Done' },
          summary: 'Finished.',
          final_url: 'https://example.com',
        });
      }
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: statuses.get(msg.payload.run_id) }));
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

  statusPolls = 0;
  const created = await request(ctx.base, `/api/browser-sessions/${sessionId}/runs`, {
    method: 'POST',
    headers: { cookie },
    body: JSON.stringify({ task: 'Long task', wait: false }),
  });
  assert.equal(created.status, 202);
  const aborted = await request(ctx.base, `/api/browser-sessions/${sessionId}/runs/${created.body.run_id}/abort`, {
    method: 'POST',
    headers: { cookie },
  });
  assert.equal(aborted.status, 200);
  assert.equal(aborted.body.status, 'aborted');

  } finally {
    ws?.close();
    await ctx.platform.close();
  }
});

test('authenticated dashboard renders browser session controls and noVNC viewer', async () => {
  const ctx = await startPlatform();
  try {
    const cookie = await register(ctx.base, 'dashboard@example.com');
    const res = await requestText(ctx.base, '/', { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.match(res.text, /Browser Sessions/);
    assert.match(res.text, /Open noVNC/);
    assert.match(res.text, /novncFrame/);
    assert.match(res.text, /\/api\/browser-sessions/);
    assert.match(res.text, /Create key/);
  } finally {
    await ctx.platform.close();
  }
});

test('browser session cloud-init starts virtual display and noVNC services', () => {
  const config = loadConfig({
    WEBBRAIN_PLATFORM_URL: 'http://platform.example',
    WEBBRAIN_PROVIDER_BASE_URL: 'http://platform.example/v1',
    WEBBRAIN_REPO_URL: 'https://github.com/esokullu/webbrain3.git',
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
  assert.match(cloudInit, /git clone https:\/\/github\.com\/novnc\/noVNC\.git \/opt\/noVNC/);
  assert.match(cloudInit, /systemctl enable --now webbrain-sidecar\.service webbrain-xvfb\.service webbrain-x11vnc\.service webbrain-novnc\.service webbrain-browser\.service webbrain-droplet\.service/);
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
  });

  assert.equal(created.status, 'provisioning');
  assert.equal(requestBody.name, 'webbrain-bs-abc123');
  assert.match(requestBody.name, /^[a-z0-9.-]+$/);

  const refreshed = await provisioner.getDroplet(123);
  assert.equal(refreshed.status, 'ready');
});
