import { WebSocket } from 'ws';

const DEFAULT_SIDECAR_BASE = 'http://127.0.0.1:17373';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readJson(res) {
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

export class DropletControlClient {
  constructor({
    controlUrl,
    sessionToken,
    sidecarBase = DEFAULT_SIDECAR_BASE,
    proxyRelay = null,
    proxyVerifyUrl = '',
    reconnectMinMs = 500,
    reconnectMaxMs = 10000,
  }) {
    this.controlUrl = controlUrl;
    this.sessionToken = sessionToken;
    this.sidecarBase = sidecarBase.replace(/\/$/, '');
    this.proxyRelay = proxyRelay;
    this.proxyVerifyUrl = proxyVerifyUrl;
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.stopped = false;
    this.ws = null;
  }

  start() {
    this.stopped = false;
    this.connectLoop();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }

  async connectLoop() {
    let delay = this.reconnectMinMs;
    while (!this.stopped) {
      try {
        await this.connectOnce();
        delay = this.reconnectMinMs;
      } catch (e) {
        console.warn('[droplet-control] disconnected:', e.message || e);
      }
      if (!this.stopped) {
        await sleep(delay);
        delay = Math.min(this.reconnectMaxMs, delay * 2);
      }
    }
  }

  connectOnce() {
    const url = new URL(this.controlUrl);
    url.searchParams.set('session_token', this.sessionToken);
    const ws = new WebSocket(url);
    this.ws = ws;
    return new Promise((resolve, reject) => {
      ws.once('open', () => console.log('[droplet-control] connected'));
      ws.once('error', reject);
      ws.once('close', () => {
        if (this.ws === ws) this.ws = null;
        resolve();
      });
      ws.on('message', raw => this.onMessage(ws, raw));
    });
  }

  async onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (!msg.id || !msg.action) return;
    try {
      const result = await this.handleCommand(msg.action, msg.payload || {});
      ws.send(JSON.stringify({ id: msg.id, ok: true, result }));
    } catch (e) {
      ws.send(JSON.stringify({ id: msg.id, ok: false, error: e.message || String(e), status: e.status || 500 }));
    }
  }

  async handleCommand(action, payload) {
    if (action === 'proxy.status') {
      if (!this.proxyRelay) throw Object.assign(new Error('Browser proxy relay is unavailable'), { status: 503 });
      return this.proxyRelay.status();
    }
    if (action === 'proxy.update') {
      if (!this.proxyRelay) throw Object.assign(new Error('Browser proxy relay is unavailable'), { status: 503 });
      return await this.proxyRelay.update(payload.proxy_url || '', {
        verify: payload.verify !== false,
        verifyUrl: payload.verify_url || this.proxyVerifyUrl,
      });
    }
    if (action === 'run') {
      const res = await fetch(`${this.sidecarBase}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          task: payload.task,
          api_mutations_allowed: payload.api_mutations_allowed === true || payload.apiMutationsAllowed === true,
          output_schema: payload.output_schema ?? payload.outputSchema ?? null,
          tab_id: payload.tab_id ?? payload.tabId ?? null,
          wait: false,
          timeout_ms: payload.timeout_ms,
        }),
      });
      if (!res.ok && res.status !== 202) throw new Error(`Sidecar run failed: ${res.status} ${await res.text()}`);
      return await readJson(res);
    }
    if (action === 'health') {
      const res = await fetch(`${this.sidecarBase}/healthz`);
      if (!res.ok) throw new Error(`Sidecar health failed: ${res.status} ${await res.text()}`);
      return await readJson(res);
    }
    if (action === 'status') {
      const runId = payload.run_id || payload.runId;
      const res = await fetch(`${this.sidecarBase}/runs/${encodeURIComponent(runId)}`);
      if (!res.ok) throw new Error(`Sidecar status failed: ${res.status} ${await res.text()}`);
      return await readJson(res);
    }
    if (action === 'respond') {
      const runId = payload.run_id || payload.runId;
      const res = await fetch(`${this.sidecarBase}/runs/${encodeURIComponent(runId)}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clarify_id: payload.clarify_id ?? payload.clarifyId,
          answer: payload.answer,
        }),
      });
      if (!res.ok) throw Object.assign(new Error(`Sidecar response failed: ${res.status} ${await res.text()}`), { status: res.status });
      return await readJson(res);
    }
    if (action === 'abort') {
      const runId = payload.run_id || payload.runId;
      const res = await fetch(`${this.sidecarBase}/runs/${encodeURIComponent(runId)}/abort`, { method: 'POST' });
      if (!res.ok) throw new Error(`Sidecar abort failed: ${res.status} ${await res.text()}`);
      return await readJson(res);
    }
    throw new Error(`Unknown droplet command: ${action}`);
  }
}
