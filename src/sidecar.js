import http from 'node:http';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 17373;
const DEFAULT_WAIT_TIMEOUT_MS = 120000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'aborted']);
const WAIT_RETURN_STATUSES = new Set([...TERMINAL_STATUSES, 'needs_user_input']);

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function normalizeRun(snapshot, sessionId = null) {
  if (!snapshot) return null;
  return {
    run_id: snapshot.runId || snapshot.run_id,
    status: snapshot.status,
    session_id: sessionId || snapshot.sessionId || snapshot.session_id || null,
    tab_id: snapshot.tabId ?? snapshot.tab_id ?? null,
    pending_input: snapshot.pendingInput || snapshot.pending_input || null,
    result: snapshot.result,
    summary: snapshot.summary || '',
    content: snapshot.content || '',
    final_url: snapshot.finalUrl || snapshot.final_url || '',
    error: snapshot.error || '',
    updates: snapshot.updates || [],
    created_at: snapshot.createdAt || snapshot.created_at || null,
    updated_at: snapshot.updatedAt || snapshot.updated_at || null,
    completed_at: snapshot.completedAt || snapshot.completed_at || null,
  };
}

function route(method, pathname) {
  let m = /^\/runs\/([^/]+)\/abort$/.exec(pathname);
  if (method === 'POST' && m) return { kind: 'abort', runId: m[1], sessionId: null };
  m = /^\/runs\/([^/]+)\/responses$/.exec(pathname);
  if (method === 'POST' && m) return { kind: 'respond', runId: m[1], sessionId: null };
  m = /^\/runs\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && m) return { kind: 'status', runId: m[1], sessionId: null };
  if (method === 'POST' && pathname === '/runs') return { kind: 'create', sessionId: null };

  m = /^\/api\/browser-sessions\/([^/]+)\/runs\/([^/]+)\/abort$/.exec(pathname);
  if (method === 'POST' && m) return { kind: 'abort', sessionId: m[1], runId: m[2] };
  m = /^\/api\/browser-sessions\/([^/]+)\/runs\/([^/]+)\/responses$/.exec(pathname);
  if (method === 'POST' && m) return { kind: 'respond', sessionId: m[1], runId: m[2] };
  m = /^\/api\/browser-sessions\/([^/]+)\/runs\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && m) return { kind: 'status', sessionId: m[1], runId: m[2] };
  m = /^\/api\/browser-sessions\/([^/]+)\/runs$/.exec(pathname);
  if (method === 'POST' && m) return { kind: 'create', sessionId: m[1] };

  return null;
}

export function createSidecarServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = options.port || DEFAULT_PORT;
  const requestTimeoutMs = options.requestTimeoutMs || 15000;
  const pollIntervalMs = options.pollIntervalMs || 500;
  const runs = new Map();
  const pending = new Map();
  let extensionSocket = null;
  let seq = 0;

  function hasExtension() {
    return !!extensionSocket && extensionSocket.readyState === WebSocket.OPEN;
  }

  function sendExtension(action, payload = {}, timeoutMs = requestTimeoutMs) {
    if (!hasExtension()) {
      return Promise.reject(new Error('WebBrain extension bridge is not connected.'));
    }
    const id = `sidecar_${Date.now().toString(36)}_${seq++}`;
    const message = JSON.stringify({ id, action, payload });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Extension request timed out: ${action}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      extensionSocket.send(message);
    });
  }

  async function pollRun(runId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let latest = runs.get(runId) || null;
    while (Date.now() < deadline) {
      const response = await sendExtension('cloud_status', { runId });
      latest = normalizeRun(response, latest?.session_id || null);
      if (latest?.run_id) runs.set(latest.run_id, latest);
      if (latest && WAIT_RETURN_STATUSES.has(latest.status)) return latest;
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    return latest;
  }

  async function createRun(body, sessionId) {
    const task = String(body.task || '').trim();
    if (!task) {
      const err = new Error('`task` is required.');
      err.status = 400;
      throw err;
    }
    const outputSchema = body.output_schema ?? body.outputSchema ?? null;
    const started = await sendExtension('cloud_run', {
      task,
      apiMutationsAllowed: body.api_mutations_allowed === true || body.apiMutationsAllowed === true,
      outputSchema,
      tabId: body.tab_id ?? body.tabId,
    });
    const run = normalizeRun(started, sessionId);
    runs.set(run.run_id, run);

    if (!body.wait) {
      return { status: 202, body: run };
    }

    const timeoutMs = Number.isFinite(Number(body.timeout_ms))
      ? Math.max(1000, Number(body.timeout_ms))
      : DEFAULT_WAIT_TIMEOUT_MS;
    const terminal = await pollRun(run.run_id, timeoutMs);
    if (!terminal || !TERMINAL_STATUSES.has(terminal.status)) {
      return { status: 202, body: runs.get(run.run_id) || run };
    }
    return { status: terminal.status === 'completed' ? 200 : 500, body: terminal };
  }

  async function statusRun(runId, sessionId) {
    try {
      const response = await sendExtension('cloud_status', { runId });
      const run = normalizeRun(response, sessionId);
      runs.set(run.run_id, run);
      return run;
    } catch (e) {
      const cached = runs.get(runId);
      if (cached) return cached;
      throw e;
    }
  }

  async function abortRun(runId, sessionId) {
    const response = await sendExtension('cloud_abort', { runId });
    const run = normalizeRun(response, sessionId);
    runs.set(run.run_id, run);
    return run;
  }

  async function respondRun(runId, sessionId, body) {
    const clarifyId = String(body.clarify_id || body.clarifyId || '').trim();
    const answer = String(body.answer ?? '').trim();
    if (!clarifyId) throw Object.assign(new Error('`clarify_id` is required.'), { status: 400 });
    if (!answer) throw Object.assign(new Error('`answer` is required.'), { status: 400 });
    const response = await sendExtension('cloud_respond', { runId, clarifyId, answer });
    const run = normalizeRun(response, sessionId);
    runs.set(run.run_id, run);
    return run;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
      if (req.method === 'GET' && url.pathname === '/healthz') {
        json(res, 200, { ok: true, extension_connected: hasExtension(), runs: runs.size });
        return;
      }

      const r = route(req.method, url.pathname);
      if (!r) {
        json(res, 404, { error: 'Not found' });
        return;
      }

      if (r.kind === 'create') {
        const body = await readJson(req);
        const result = await createRun(body, r.sessionId);
        json(res, result.status, result.body);
        return;
      }
      if (r.kind === 'status') {
        json(res, 200, await statusRun(r.runId, r.sessionId));
        return;
      }
      if (r.kind === 'respond') {
        json(res, 200, await respondRun(r.runId, r.sessionId, await readJson(req)));
        return;
      }
      if (r.kind === 'abort') {
        json(res, 200, await abortRun(r.runId, r.sessionId));
        return;
      }
    } catch (e) {
      json(res, e.status || 500, { error: e.message || String(e) });
    }
  });

  const wss = new WebSocketServer({ server, path: '/extension' });
  wss.on('connection', (ws) => {
    extensionSocket = ws;
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (msg.type === 'hello') return;
      if (!msg.id || !pending.has(msg.id)) return;
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok === false) {
        p.reject(Object.assign(new Error(msg.error || 'Extension command failed'), { status: msg.status || 500 }));
      } else p.resolve(msg.result);
    });
    ws.on('close', () => {
      if (extensionSocket !== ws) return;
      extensionSocket = null;
      const completedAt = new Date().toISOString();
      for (const run of runs.values()) {
        if (!['running', 'needs_user_input', 'aborting'].includes(run.status)) continue;
        run.status = run.status === 'aborting' ? 'aborted' : 'failed';
        run.error = run.status === 'aborted'
          ? 'Run aborted when the extension bridge disconnected.'
          : 'Run interrupted when the extension bridge disconnected.';
        run.updated_at = completedAt;
        run.completed_at = completedAt;
      }
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error('WebBrain extension bridge disconnected.'));
      }
      pending.clear();
    });
  });

  return {
    server,
    wss,
    runs,
    get extensionConnected() { return hasExtension(); },
    listen(listenPort = port, listenHost = host) {
      return new Promise(resolve => {
        server.listen(listenPort, listenHost, () => resolve(server.address()));
      });
    },
    close() {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('Sidecar closed'));
      }
      pending.clear();
      return new Promise(resolve => {
        wss.close(() => server.close(resolve));
      });
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.WEBBRAIN_SIDECAR_PORT || DEFAULT_PORT);
  const host = process.env.WEBBRAIN_SIDECAR_HOST || DEFAULT_HOST;
  const sidecar = createSidecarServer({ host, port });
  sidecar.listen(port, host).then(() => {
    console.log(`WebBrain sidecar listening on http://${host}:${port}`);
  });
}
