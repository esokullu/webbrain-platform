import express from 'express';
import { randomId, randomSecret, nowIso, isoAfterMs } from '../shared/ids.js';
import { hashPassword, verifyPassword, hashToken } from '../shared/crypto.js';
import { publicBrowserSession, publicRun, jsonError } from '../shared/http.js';
import { signNoVncToken } from '../shared/novnc-token.js';
import { instanceHostname } from './instance-proxy.js';

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'aborted']);

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function wantsJson(req) {
  return req.path.startsWith('/api/') || req.headers.accept?.includes('application/json');
}

function setSessionCookie(res, config, token, expiresAt) {
  const attrs = [
    `${config.cookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (config.cookieSecure) attrs.push('Secure');
  res.setHeader('set-cookie', attrs.join('; '));
}

function clearSessionCookie(res, config) {
  res.setHeader('set-cookie', `${config.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function loginPage(error = '') {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WebBrain Platform</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f7f4; color: #202124; }
    main { max-width: 920px; margin: 0 auto; padding: 64px 24px; display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    h1 { font-size: 34px; margin: 0 0 12px; }
    p { color: #5f6368; line-height: 1.5; }
    form { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 20px; display: grid; gap: 12px; }
    input, button { font: inherit; padding: 11px 12px; border-radius: 6px; border: 1px solid #c9c9c9; }
    button { background: #202124; color: white; border-color: #202124; cursor: pointer; }
    .forms { display: grid; gap: 16px; }
    .error { color: #a33020; }
    @media (max-width: 760px) { main { grid-template-columns: 1fr; padding-top: 36px; } }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>WebBrain Platform</h1>
      <p>Run programmable WebBrain browser sessions in the cloud. Sign in to create a browser session, log into sites through noVNC, then call the API against that same browser profile.</p>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    </section>
    <section class="forms">
      <form method="post" action="/auth/login">
        <strong>Login</strong>
        <input required type="email" name="email" placeholder="Email">
        <input required type="password" name="password" placeholder="Password">
        <button type="submit">Login</button>
      </form>
      <form method="post" action="/auth/register">
        <strong>Register</strong>
        <input required type="email" name="email" placeholder="Email">
        <input required minlength="8" type="password" name="password" placeholder="Password">
        <button type="submit">Create account</button>
      </form>
    </section>
  </main>
</body>
</html>`;
}

function dashboardPage(user) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WebBrain Platform</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f5; color: #202124; }
    main { max-width: 1280px; margin: 0 auto; padding: 28px 24px 40px; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid #d9ddd6; padding-bottom: 16px; }
    h1 { margin: 0; font-size: 26px; letter-spacing: 0; }
    h2 { margin: 0; font-size: 17px; letter-spacing: 0; }
    button, input, select { font: inherit; }
    button { min-height: 38px; padding: 8px 12px; border-radius: 6px; border: 1px solid #202124; background: #202124; color: #fff; cursor: pointer; white-space: nowrap; }
    button.secondary { background: #fff; color: #202124; border-color: #bfc5bd; }
    button.danger { background: #8b1f14; border-color: #8b1f14; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .button-link { min-height: 38px; box-sizing: border-box; display: inline-flex; align-items: center; padding: 8px 12px; border-radius: 6px; border: 1px solid #bfc5bd; background: #fff; color: #202124; text-decoration: none; white-space: nowrap; }
    input, select { min-height: 38px; box-sizing: border-box; border: 1px solid #c6cbc3; border-radius: 6px; padding: 8px 10px; background: #fff; color: #202124; }
    .muted { color: #646b61; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .grid { display: grid; grid-template-columns: minmax(340px, 430px) 1fr; gap: 18px; margin-top: 20px; align-items: start; }
    .panel { background: #fff; border: 1px solid #d9ddd6; border-radius: 8px; }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 14px 12px; border-bottom: 1px solid #edf0eb; }
    .panel-body { padding: 14px; }
    .create-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; margin-bottom: 12px; }
    .sessions { display: grid; gap: 8px; }
    .session { text-align: left; width: 100%; color: #202124; background: #fafbf9; border: 1px solid #dfe4dc; display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 10px; }
    .session.active { border-color: #202124; background: #f0f2ed; }
    .session-title { font-weight: 650; overflow-wrap: anywhere; }
    .session-meta { color: #646b61; font-size: 12px; margin-top: 4px; overflow-wrap: anywhere; }
    .status { display: inline-flex; align-items: center; min-height: 24px; padding: 0 8px; border-radius: 999px; background: #edf0eb; color: #394034; font-size: 12px; }
    .viewer-wrap { min-height: 680px; display: grid; grid-template-rows: auto 1fr; }
    .viewer-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #edf0eb; }
    .viewer-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    iframe { width: 100%; height: 640px; border: 0; background: #111; border-radius: 0 0 8px 8px; }
    .empty { min-height: 640px; display: grid; place-items: center; color: #646b61; text-align: center; padding: 20px; }
    .message { margin-top: 10px; min-height: 20px; color: #355f1d; overflow-wrap: anywhere; }
    .message.error { color: #9b2b1f; }
    .api-key-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin-top: 10px; }
    .secret { display: none; margin-top: 10px; padding: 10px; border: 1px solid #d9ddd6; border-radius: 6px; background: #fafbf9; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    @media (max-width: 900px) {
      main { padding: 20px 14px 32px; }
      header { align-items: flex-start; flex-direction: column; }
      .grid { grid-template-columns: 1fr; }
      .create-row { grid-template-columns: 1fr; }
      iframe, .empty { height: 520px; min-height: 520px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Cloud browsers</h1>
        <div class="muted">${escapeHtml(user.email)}</div>
      </div>
      <div class="toolbar">
        <button class="secondary" id="refreshBtn" type="button">Refresh</button>
        <form method="post" action="/auth/logout"><button type="submit">Logout</button></form>
      </div>
    </header>
    <div class="grid">
      <section class="panel">
        <div class="panel-head">
          <h2>Browser Sessions</h2>
          <span class="status" id="sessionCount">0</span>
        </div>
        <div class="panel-body">
          <div class="create-row">
            <select id="regionInput" aria-label="Region">
              <option value="nyc3">nyc3</option>
              <option value="nyc1">nyc1</option>
              <option value="sfo3">sfo3</option>
              <option value="ams3">ams3</option>
            </select>
            <select id="sizeInput" aria-label="Size">
              <option value="s-1vcpu-1gb">Small</option>
              <option value="s-2vcpu-2gb">Medium</option>
              <option value="s-2vcpu-4gb">Browser</option>
            </select>
            <button id="createSessionBtn" type="button">Create</button>
          </div>
          <div class="sessions" id="sessions"></div>
          <div class="message" id="sessionMessage"></div>
        </div>
      </section>
      <section class="panel viewer-wrap">
        <div class="viewer-actions">
          <div class="viewer-title" id="viewerTitle">noVNC</div>
          <div class="toolbar">
            <button class="secondary" id="connectBtn" type="button" disabled>Open noVNC</button>
            <a class="button-link" id="externalLink" href="#" target="_blank" rel="noopener" style="display:none">New tab</a>
            <button class="danger" id="deleteSessionBtn" type="button" disabled>Delete</button>
          </div>
        </div>
        <div id="viewerEmpty" class="empty">Create or select a browser session, then open noVNC here.</div>
        <iframe id="novncFrame" title="WebBrain cloud browser noVNC" style="display:none" referrerpolicy="no-referrer"></iframe>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>API Keys</h2></div>
        <div class="panel-body">
          <div class="api-key-row">
            <input id="apiKeyName" placeholder="API key name" value="Default API key">
            <button id="createApiKeyBtn" type="button">Create key</button>
          </div>
          <div class="secret" id="newApiKey"></div>
          <div class="message" id="apiKeyMessage"></div>
        </div>
      </section>
    </div>
  </main>
  <script>
    const sessionsEl = document.getElementById('sessions');
    const sessionMessage = document.getElementById('sessionMessage');
    const sessionCount = document.getElementById('sessionCount');
    const createSessionBtn = document.getElementById('createSessionBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const connectBtn = document.getElementById('connectBtn');
    const deleteSessionBtn = document.getElementById('deleteSessionBtn');
    const viewerTitle = document.getElementById('viewerTitle');
    const viewerEmpty = document.getElementById('viewerEmpty');
    const novncFrame = document.getElementById('novncFrame');
    const externalLink = document.getElementById('externalLink');
    const createApiKeyBtn = document.getElementById('createApiKeyBtn');
    const apiKeyName = document.getElementById('apiKeyName');
    const newApiKey = document.getElementById('newApiKey');
    const apiKeyMessage = document.getElementById('apiKeyMessage');
    const state = { sessions: [], selectedId: null };

    function showMessage(el, text, isError) {
      el.textContent = text || '';
      el.classList.toggle('error', !!isError);
    }

    async function api(path, options) {
      options = options || {};
      const res = await fetch(path, {
        credentials: 'same-origin',
        ...options,
        headers: {
          'content-type': 'application/json',
          ...(options.headers || {}),
        },
        body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
      });
      const text = await res.text();
      const body = text ? JSON.parse(text) : null;
      if (!res.ok) throw new Error((body && body.error) || 'Request failed');
      return body;
    }

    function selectedSession() {
      return state.sessions.find(s => s.id === state.selectedId) || null;
    }

    function renderSessions() {
      sessionCount.textContent = String(state.sessions.length);
      sessionsEl.innerHTML = '';
      if (!state.sessions.length) {
        sessionsEl.innerHTML = '<div class="empty" style="min-height:180px">No browser sessions yet.</div>';
      }
      for (const session of state.sessions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'session' + (session.id === state.selectedId ? ' active' : '');
        const details = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'session-title';
        title.textContent = session.id;
        const meta = document.createElement('div');
        meta.className = 'session-meta';
        meta.textContent = (session.public_ip || 'waiting for IP') + ' | ' + session.region + ' | ' + session.size;
        details.append(title, meta);
        const status = document.createElement('span');
        status.className = 'status';
        status.textContent = session.status;
        btn.append(details, status);
        btn.addEventListener('click', () => {
          state.selectedId = session.id;
          renderSessions();
          renderViewer();
          refreshOne(session.id).catch(e => showMessage(sessionMessage, e.message, true));
        });
        sessionsEl.appendChild(btn);
      }
      renderViewer();
    }

    function renderViewer() {
      const session = selectedSession();
      connectBtn.disabled = !session || !session.public_ip || session.status !== 'ready';
      deleteSessionBtn.disabled = !session || session.status === 'destroyed';
      viewerTitle.textContent = session ? session.id + ' | ' + session.status : 'noVNC';
    }

    async function loadSessions() {
      const body = await api('/api/browser-sessions');
      state.sessions = body.browser_sessions || [];
      if (state.selectedId && !state.sessions.some(s => s.id === state.selectedId)) state.selectedId = null;
      if (!state.selectedId && state.sessions[0]) state.selectedId = state.sessions[0].id;
      renderSessions();
    }

    async function refreshOne(id) {
      const body = await api('/api/browser-sessions/' + encodeURIComponent(id));
      const next = body.browser_session;
      state.sessions = state.sessions.map(s => s.id === next.id ? next : s);
      renderSessions();
      return next;
    }

    async function createSession() {
      createSessionBtn.disabled = true;
      showMessage(sessionMessage, 'Creating droplet...');
      try {
        const body = await api('/api/browser-sessions', {
          method: 'POST',
          body: {
            region: document.getElementById('regionInput').value,
            size: document.getElementById('sizeInput').value,
          },
        });
        state.selectedId = body.browser_session.id;
        await loadSessions();
        showMessage(sessionMessage, 'Session created. It may take a few minutes before noVNC is ready.');
      } catch (e) {
        showMessage(sessionMessage, e.message, true);
      } finally {
        createSessionBtn.disabled = false;
      }
    }

    async function openNoVnc() {
      const session = selectedSession();
      if (!session) return;
      connectBtn.disabled = true;
      showMessage(sessionMessage, 'Creating noVNC link...');
      try {
        const body = await api('/api/browser-sessions/' + encodeURIComponent(session.id) + '/connect-token', {
          method: 'POST',
          body: { scheme: 'http', port: 6081 },
        });
        novncFrame.src = body.url;
        externalLink.href = body.url;
        externalLink.style.display = '';
        viewerEmpty.style.display = 'none';
        novncFrame.style.display = '';
        showMessage(sessionMessage, 'noVNC opened. Token expires at ' + body.expires_at + '.');
      } catch (e) {
        showMessage(sessionMessage, e.message, true);
      } finally {
        connectBtn.disabled = false;
        renderViewer();
      }
    }

    async function deleteSession() {
      const session = selectedSession();
      if (!session || !confirm('Delete browser session ' + session.id + '?')) return;
      deleteSessionBtn.disabled = true;
      showMessage(sessionMessage, 'Deleting session...');
      try {
        await api('/api/browser-sessions/' + encodeURIComponent(session.id), { method: 'DELETE' });
        if (state.selectedId === session.id) {
          state.selectedId = null;
          novncFrame.removeAttribute('src');
          novncFrame.style.display = 'none';
          viewerEmpty.style.display = '';
          externalLink.style.display = 'none';
        }
        await loadSessions();
        showMessage(sessionMessage, 'Session deleted.');
      } catch (e) {
        showMessage(sessionMessage, e.message, true);
      } finally {
        deleteSessionBtn.disabled = false;
      }
    }

    async function createApiKey() {
      createApiKeyBtn.disabled = true;
      newApiKey.style.display = 'none';
      showMessage(apiKeyMessage, 'Creating API key...');
      try {
        const body = await api('/api/api-keys', {
          method: 'POST',
          body: { name: apiKeyName.value || 'Dashboard API key' },
        });
        newApiKey.textContent = body.key;
        newApiKey.style.display = 'block';
        showMessage(apiKeyMessage, 'Copy this key now. It will not be shown again.');
      } catch (e) {
        showMessage(apiKeyMessage, e.message, true);
      } finally {
        createApiKeyBtn.disabled = false;
      }
    }

    createSessionBtn.addEventListener('click', createSession);
    refreshBtn.addEventListener('click', () => loadSessions().catch(e => showMessage(sessionMessage, e.message, true)));
    connectBtn.addEventListener('click', openNoVnc);
    deleteSessionBtn.addEventListener('click', deleteSession);
    createApiKeyBtn.addEventListener('click', createApiKey);
    loadSessions().catch(e => showMessage(sessionMessage, e.message, true));
    setInterval(() => loadSessions().catch(() => {}), 15000);
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function normalizeRunSnapshot(snapshot, existing = {}) {
  return {
    status: snapshot.status || existing.status,
    result: snapshot.result ?? existing.result ?? null,
    summary: snapshot.summary || existing.summary || '',
    final_url: snapshot.final_url || snapshot.finalUrl || existing.final_url || '',
    error: snapshot.error || existing.error || '',
    completed_at: TERMINAL_RUN_STATUSES.has(snapshot.status) ? (snapshot.completed_at || snapshot.completedAt || nowIso()) : existing.completed_at || null,
  };
}

export function createPlatformApp({ store, provisioner, controlChannel, config }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  app.use(async (req, res, next) => {
    try {
      req.auth = null;
      const authHeader = req.headers.authorization || '';
      if (authHeader.toLowerCase().startsWith('bearer ')) {
        const rawKey = authHeader.slice(7).trim();
        const prefix = rawKey.split('_')[1] || '';
        const apiKey = prefix ? await store.findApiKey(prefix, hashToken(rawKey)) : null;
        if (apiKey) {
          await store.touchApiKey(apiKey.id, nowIso());
          req.auth = { type: 'api_key', user: apiKey.user, apiKey };
        }
      }
      if (!req.auth) {
        const token = parseCookies(req.headers.cookie || '')[config.cookieName];
        if (token) {
          const session = await store.getWebSessionByHash(hashToken(token));
          if (session) req.auth = { type: 'cookie', user: session.user, webSession: session };
        }
      }
      next();
    } catch (e) {
      next(e);
    }
  });

  function requireAuth(req, res, next) {
    if (!req.auth?.user) return jsonError(res, 401, 'Authentication required');
    next();
  }

  async function audit(req, action, targetType, targetId, metadata = {}) {
    await store.createAuditLog({
      id: randomId('aud'),
      user_id: req.auth?.user?.id || null,
      action,
      target_type: targetType,
      target_id: targetId,
      metadata,
      ip: req.ip || '',
      user_agent: req.headers?.['user-agent'] || '',
      created_at: nowIso(),
    });
  }

  async function ownedBrowserSession(req, res) {
    const session = await store.getBrowserSession(req.params.sessionId);
    if (!session || session.user_id !== req.auth.user.id) {
      jsonError(res, 404, 'Browser session not found');
      return null;
    }
    return session;
  }

  app.get('/healthz', (req, res) => {
    res.json({ ok: true, role: 'platform' });
  });

  app.all('/v1/*', async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
      const session = token ? await store.getBrowserSessionBySecret(token) : null;
      if (!session) return jsonError(res, 401, 'Model proxy authentication required');
      if (!config.modelProxy.baseUrl) return jsonError(res, 503, 'WEBBRAIN_MODEL_PROXY_BASE_URL is not configured');
      const target = `${config.modelProxy.baseUrl.replace(/\/$/, '')}/${req.params[0]}`;
      const headers = {
        'content-type': req.headers['content-type'] || 'application/json',
      };
      if (config.modelProxy.apiKey) headers.authorization = `Bearer ${config.modelProxy.apiKey}`;
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
      });
      res.status(upstream.status);
      const contentType = upstream.headers.get('content-type');
      if (contentType) res.setHeader('content-type', contentType);
      if (upstream.body) {
        for await (const chunk of upstream.body) res.write(chunk);
      }
      res.end();
    } catch (e) {
      next(e);
    }
  });

  app.get('/', (req, res) => {
    res.type('html').send(req.auth?.user ? dashboardPage(req.auth.user) : loginPage());
  });

  app.post('/auth/register', async (req, res, next) => {
    try {
      const email = String(req.body.email || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      if (!email || !email.includes('@')) throw Object.assign(new Error('Valid email is required'), { status: 400 });
      if (password.length < 8) throw Object.assign(new Error('Password must be at least 8 characters'), { status: 400 });
      if (await store.findUserByEmail(email)) throw Object.assign(new Error('Email already registered'), { status: 409 });
      const now = nowIso();
      const user = await store.createUser({
        id: randomId('usr'),
        email,
        password_hash: await hashPassword(password),
        created_at: now,
        updated_at: now,
      });
      await createLoginSession(res, config, store, user);
      await audit({ ...req, auth: { user } }, 'user.register', 'user', user.id);
      if (wantsJson(req)) return res.status(201).json({ user: { id: user.id, email: user.email } });
      res.redirect('/');
    } catch (e) {
      if (wantsJson(req)) return next(e);
      res.status(e.status || 400).type('html').send(loginPage(e.message));
    }
  });

  app.post('/auth/login', async (req, res, next) => {
    try {
      const email = String(req.body.email || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      const user = await store.findUserByEmail(email);
      if (!user || !(await verifyPassword(password, user.password_hash))) {
        throw Object.assign(new Error('Invalid email or password'), { status: 401 });
      }
      await createLoginSession(res, config, store, user);
      await audit({ ...req, auth: { user } }, 'user.login', 'user', user.id);
      if (wantsJson(req)) return res.json({ user: { id: user.id, email: user.email } });
      res.redirect('/');
    } catch (e) {
      if (wantsJson(req)) return next(e);
      res.status(e.status || 400).type('html').send(loginPage(e.message));
    }
  });

  app.post('/auth/logout', async (req, res) => {
    const token = parseCookies(req.headers.cookie || '')[config.cookieName];
    if (token) await store.deleteWebSessionByHash(hashToken(token));
    clearSessionCookie(res, config);
    if (wantsJson(req)) return res.json({ ok: true });
    res.redirect('/');
  });

  app.get('/api/me', requireAuth, (req, res) => {
    res.json({ user: { id: req.auth.user.id, email: req.auth.user.email }, auth_type: req.auth.type });
  });

  app.get('/api/api-keys', requireAuth, async (req, res) => {
    const keys = await store.listApiKeys(req.auth.user.id);
    res.json({ api_keys: keys.map(k => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      last_used_at: k.last_used_at || null,
      created_at: k.created_at,
    })) });
  });

  app.post('/api/api-keys', requireAuth, async (req, res) => {
    const prefix = randomSecret(5).slice(0, 8);
    const secret = randomSecret(24);
    const rawKey = `wbp_${prefix}_${secret}`;
    const now = nowIso();
    const key = await store.createApiKey({
      id: randomId('key'),
      user_id: req.auth.user.id,
      name: String(req.body.name || 'API key').slice(0, 255),
      prefix,
      key_hash: hashToken(rawKey),
      last_used_at: null,
      revoked_at: null,
      created_at: now,
    });
    await audit(req, 'api_key.create', 'api_key', key.id);
    res.status(201).json({
      api_key: { id: key.id, name: key.name, prefix: key.prefix, created_at: key.created_at },
      key: rawKey,
    });
  });

  app.delete('/api/api-keys/:keyId', requireAuth, async (req, res) => {
    const key = await store.revokeApiKey(req.auth.user.id, req.params.keyId, nowIso());
    await audit(req, 'api_key.revoke', 'api_key', key.id);
    res.json({ ok: true });
  });

  app.get('/api/browser-sessions', requireAuth, async (req, res) => {
    const sessions = await store.listBrowserSessions(req.auth.user.id);
    const refreshed = [];
    for (const session of sessions) {
      refreshed.push(await refreshProvisioningSession(session));
    }
    res.json({ browser_sessions: refreshed.map(publicBrowserSession) });
  });

  app.post('/api/browser-sessions', requireAuth, async (req, res, next) => {
    try {
      const now = nowIso();
      const session = await store.createBrowserSession({
        id: randomId('bs'),
        user_id: req.auth.user.id,
        status: 'provisioning',
        droplet_id: null,
        public_ip: null,
        region: req.body.region || config.digitalOcean.region,
        size: req.body.size || config.digitalOcean.size,
        connect_secret: randomSecret(32),
        expires_at: isoAfterMs(Number(req.body.ttl_ms || config.browserSessionTtlMs)),
        created_at: now,
        updated_at: now,
      });
      let provisioned;
      try {
        provisioned = await provisioner.createBrowserDroplet(session, { providerApiKey: req.body.provider_api_key || session.connect_secret });
      } catch (e) {
        await store.updateBrowserSession(session.id, { status: 'failed', updated_at: nowIso() });
        throw e;
      }
      const updated = await store.updateBrowserSession(session.id, {
        status: provisioned.status || 'provisioning',
        droplet_id: provisioned.droplet_id || null,
        public_ip: provisioned.public_ip || null,
        updated_at: nowIso(),
      });
      await audit(req, 'browser_session.create', 'browser_session', session.id, { droplet_id: updated.droplet_id });
      res.status(201).json({ browser_session: publicBrowserSession(updated) });
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/browser-sessions/:sessionId', requireAuth, async (req, res) => {
    let session = await ownedBrowserSession(req, res);
    if (!session) return;
    session = await refreshProvisioningSession(session);
    res.json({
      browser_session: {
        ...publicBrowserSession(session),
        droplet_connected: controlChannel.isConnected(session.id),
      },
    });
  });

  async function refreshProvisioningSession(session) {
    if (!session.droplet_id || ['failed', 'stopping', 'destroyed'].includes(session.status)) return session;
    const refreshed = await provisioner.getDroplet(session.droplet_id).catch(() => null);
    if (!refreshed?.status) return session;
    if (refreshed.status === session.status && (!refreshed.public_ip || refreshed.public_ip === session.public_ip)) return session;
    return await store.updateBrowserSession(session.id, {
      status: refreshed.status,
      public_ip: refreshed.public_ip || session.public_ip,
      updated_at: nowIso(),
    });
  }

  app.delete('/api/browser-sessions/:sessionId', requireAuth, async (req, res, next) => {
    try {
      const session = await ownedBrowserSession(req, res);
      if (!session) return;
      await store.updateBrowserSession(session.id, { status: 'stopping', updated_at: nowIso() });
      await provisioner.destroyDroplet(session.droplet_id);
      const updated = await store.updateBrowserSession(session.id, { status: 'destroyed', updated_at: nowIso() });
      await audit(req, 'browser_session.destroy', 'browser_session', session.id);
      res.json({ browser_session: publicBrowserSession(updated) });
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/browser-sessions/:sessionId/connect-token', requireAuth, async (req, res) => {
    let session = await ownedBrowserSession(req, res);
    if (!session) return;
    session = await refreshProvisioningSession(session);
    if (!session.public_ip) return jsonError(res, 409, 'Browser session is not ready');
    const expiresAt = isoAfterMs(config.connectTokenTtlMs);
    const token = signNoVncToken({ sessionId: session.id, expiresAt, secret: session.connect_secret });
    const scheme = req.body.scheme || 'http';
    const port = req.body.port || 6081;
    const query = new URLSearchParams({
      token,
      autoconnect: 'true',
      resize: 'scale',
      path: `websockify?token=${token}`,
    });
    await audit(req, 'browser_session.connect_token', 'browser_session', session.id);
    res.json({
      token,
      expires_at: expiresAt,
      url: config.instanceDomain
        ? `https://${instanceHostname(session.id, config.instanceDomain)}/vnc.html?${query.toString()}`
        : `${scheme}://${session.public_ip}:${port}/vnc.html?${query.toString()}`,
    });
  });

  app.post('/api/browser-sessions/:sessionId/runs', requireAuth, async (req, res, next) => {
    try {
      const session = await ownedBrowserSession(req, res);
      if (!session) return;
      const task = String(req.body.task || '').trim();
      if (!task) return jsonError(res, 400, '`task` is required');
      const started = await controlChannel.send(session.id, 'run', {
        task,
        output_schema: req.body.output_schema ?? req.body.outputSchema ?? null,
        wait: false,
        timeout_ms: req.body.timeout_ms,
      });
      let run = await store.createCloudRun({
        id: started.run_id || started.runId,
        browser_session_id: session.id,
        user_id: req.auth.user.id,
        task,
        output_schema: req.body.output_schema ?? req.body.outputSchema ?? null,
        status: started.status || 'running',
        result: started.result ?? null,
        summary: started.summary || '',
        final_url: started.final_url || started.finalUrl || '',
        error: started.error || '',
        created_at: nowIso(),
        updated_at: nowIso(),
        completed_at: null,
      });
      await audit(req, 'cloud_run.create', 'cloud_run', run.id, { browser_session_id: session.id });
      if (!req.body.wait) return res.status(202).json(publicRun(run));

      run = await waitForRun({ run, session, store, controlChannel, config, timeoutMs: req.body.timeout_ms });
      return res.status(TERMINAL_RUN_STATUSES.has(run.status) ? (run.status === 'completed' ? 200 : 500) : 202).json(publicRun(run));
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/browser-sessions/:sessionId/runs/:runId', requireAuth, async (req, res, next) => {
    try {
      const session = await ownedBrowserSession(req, res);
      if (!session) return;
      let run = await store.getCloudRun(req.params.runId);
      if (!run || run.user_id !== req.auth.user.id || run.browser_session_id !== session.id) {
        return jsonError(res, 404, 'Cloud run not found');
      }
      if (!TERMINAL_RUN_STATUSES.has(run.status) && controlChannel.isConnected(session.id)) {
        const snapshot = await controlChannel.send(session.id, 'status', { run_id: run.id }).catch(() => null);
        if (snapshot) run = await store.updateCloudRun(run.id, normalizeRunSnapshot(snapshot, run));
      }
      res.json(publicRun(run));
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/browser-sessions/:sessionId/runs/:runId/abort', requireAuth, async (req, res, next) => {
    try {
      const session = await ownedBrowserSession(req, res);
      if (!session) return;
      const run = await store.getCloudRun(req.params.runId);
      if (!run || run.user_id !== req.auth.user.id || run.browser_session_id !== session.id) {
        return jsonError(res, 404, 'Cloud run not found');
      }
      const snapshot = await controlChannel.send(session.id, 'abort', { run_id: run.id });
      const updated = await store.updateCloudRun(run.id, normalizeRunSnapshot(snapshot, run));
      await audit(req, 'cloud_run.abort', 'cloud_run', run.id);
      res.json(publicRun(updated));
    } catch (e) {
      next(e);
    }
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    jsonError(res, err.status || 500, err.message || 'Internal server error');
  });

  return app;
}

async function createLoginSession(res, config, store, user) {
  const token = randomSecret(32);
  const now = nowIso();
  const expiresAt = isoAfterMs(config.sessionTtlMs);
  await store.createWebSession({
    id: randomId('ses'),
    user_id: user.id,
    token_hash: hashToken(token),
    expires_at: expiresAt,
    created_at: now,
  });
  setSessionCookie(res, config, token, expiresAt);
  return token;
}

async function waitForRun({ run, session, store, controlChannel, config, timeoutMs }) {
  const timeout = Number.isFinite(Number(timeoutMs)) ? Math.max(1000, Number(timeoutMs)) : config.runWaitTimeoutMs;
  const deadline = Date.now() + timeout;
  let latest = run;
  while (Date.now() < deadline) {
    const snapshot = await controlChannel.send(session.id, 'status', { run_id: latest.id });
    latest = await store.updateCloudRun(latest.id, normalizeRunSnapshot(snapshot, latest));
    if (TERMINAL_RUN_STATUSES.has(latest.status)) return latest;
    await new Promise(resolve => setTimeout(resolve, config.runPollIntervalMs));
  }
  return latest;
}

export async function cleanupExpiredBrowserSessions({ store, provisioner }) {
  const expired = await store.listExpiredBrowserSessions(nowIso());
  const cleaned = [];
  for (const session of expired) {
    await store.updateBrowserSession(session.id, { status: 'stopping', updated_at: nowIso() });
    await provisioner.destroyDroplet(session.droplet_id);
    cleaned.push(await store.updateBrowserSession(session.id, { status: 'destroyed', updated_at: nowIso() }));
  }
  return cleaned;
}
