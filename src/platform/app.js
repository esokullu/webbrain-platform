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
  <title>WebBrain Cloud</title>
  <style>
    :root {
      --bg: #f7f1e6;
      --card: #fffdf8;
      --card-hover: #f2e9d4;
      --surface: #ede2cb;
      --border: rgba(89,55,25,0.15);
      --text: #2c1810;
      --text-dim: #6b5b47;
      --accent: #5b52e8;
      --accent2: #7c6ce6;
      --accent-glow: rgba(91,82,232,0.20);
      --danger: #a43b32;
      --shadow: rgba(89,55,25,0.10);
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
    .glow-bg { position: fixed; inset: 0; z-index: -1; overflow: hidden; }
    .glow-bg::before { content: ''; position: absolute; width: 640px; height: 640px; top: -220px; left: 45%; transform: translateX(-50%); background: radial-gradient(circle, var(--accent-glow) 0%, transparent 70%); filter: blur(70px); }
    .glow-bg::after { content: ''; position: absolute; width: 460px; height: 460px; bottom: -140px; right: -80px; background: radial-gradient(circle, rgba(167,139,250,0.14) 0%, transparent 70%); filter: blur(60px); }
    nav { border-bottom: 1px solid var(--border); background: rgba(247,241,230,0.85); backdrop-filter: blur(20px); }
    .nav-inner { max-width: 1100px; margin: 0 auto; min-height: 68px; padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
    .brand { display: flex; align-items: center; gap: 10px; color: var(--accent); font-size: 20px; font-weight: 800; text-decoration: none; }
    .brand img { width: 30px; height: 30px; border-radius: 8px; box-shadow: 0 6px 18px var(--accent-glow); }
    .brand-domain { color: var(--accent2); opacity: .68; font-weight: 400; }
    .nav-note { color: var(--text-dim); font-size: 13px; }
    main { max-width: 1100px; margin: 0 auto; padding: 84px 24px 72px; display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(320px, .9fr); align-items: center; gap: 72px; }
    .eyebrow { margin: 0 0 16px; color: var(--accent); font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    h1 { max-width: 680px; margin: 0 0 20px; font-size: clamp(42px, 6vw, 68px); line-height: 1.02; letter-spacing: -.045em; }
    h1 span { color: var(--accent); }
    .intro { max-width: 620px; margin: 0; color: var(--text-dim); font-size: 18px; }
    .trust-line { display: flex; align-items: center; gap: 10px; margin-top: 28px; color: var(--text-dim); font-size: 13px; }
    .trust-dot { width: 8px; height: 8px; border-radius: 50%; background: #2d8866; box-shadow: 0 0 0 5px rgba(45,136,102,.10); }
    .forms { display: grid; gap: 14px; }
    form { position: relative; overflow: hidden; background: rgba(255,253,248,.9); border: 1px solid var(--border); border-radius: 16px; padding: 24px; display: grid; gap: 12px; box-shadow: 0 18px 46px var(--shadow); }
    form::before { content: ''; position: absolute; inset: 0 0 auto; height: 3px; background: linear-gradient(90deg, var(--accent), var(--accent2)); }
    form strong { font-size: 16px; }
    input, button { width: 100%; min-height: 44px; font: inherit; padding: 10px 12px; border-radius: 9px; border: 1px solid var(--border); }
    input { background: rgba(89,55,25,.04); color: var(--text); }
    input::placeholder { color: #8a7964; }
    input:focus-visible, button:focus-visible, a:focus-visible { outline: 3px solid var(--accent-glow); outline-offset: 2px; }
    button { border-color: var(--accent); background: var(--accent); color: white; font-weight: 700; cursor: pointer; box-shadow: 0 8px 22px var(--accent-glow); }
    button:hover { background: #5047dc; transform: translateY(-1px); }
    .register-form { box-shadow: none; background: rgba(255,253,248,.62); }
    .register-form::before { display: none; }
    .register-form button { background: transparent; border-color: var(--border); color: var(--text); box-shadow: none; }
    .register-form button:hover { background: var(--card-hover); }
    .error { padding: 12px 14px; border: 1px solid rgba(164,59,50,.25); border-radius: 10px; background: rgba(164,59,50,.07); color: var(--danger); }
    @media (max-width: 800px) {
      .nav-inner { padding-inline: 16px; }
      .nav-note { display: none; }
      main { grid-template-columns: 1fr; gap: 40px; padding: 48px 18px 56px; }
      h1 { font-size: clamp(40px, 12vw, 58px); }
    }
  </style>
</head>
<body>
  <div class="glow-bg" aria-hidden="true"></div>
  <nav>
    <div class="nav-inner">
      <a class="brand" href="https://webbrain.one/">
        <img src="https://webbrain.one/logo-github.png" alt=""> WebBrain<span class="brand-domain">.cloud</span>
      </a>
      <span class="nav-note">A private WebBrain browser, ready anywhere.</span>
    </div>
  </nav>
  <main>
    <section class="hero-copy">
      <p class="eyebrow">WebBrain Cloud</p>
      <h1>Your AI browser, <span>always within reach.</span></h1>
      <p class="intro">Create a private WebBrain browser, sign in to the sites you use, and control the same visible session from the API.</p>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
      <div class="trust-line"><span class="trust-dot"></span>Your browser profile stays isolated in its own cloud machine.</div>
    </section>
    <section class="forms">
      <form method="post" action="/auth/login">
        <strong>Sign in</strong>
        <input required type="email" name="email" placeholder="Email">
        <input required type="password" name="password" placeholder="Password">
        <button type="submit">Sign in</button>
      </form>
      <form class="register-form" method="post" action="/auth/register">
        <strong>New to WebBrain Cloud?</strong>
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
  <title>WebBrain Cloud</title>
  <style>
    :root {
      --bg: #f7f1e6;
      --card: #fffdf8;
      --card-hover: #f2e9d4;
      --surface: #ede2cb;
      --border: rgba(89,55,25,0.15);
      --text: #2c1810;
      --text-dim: #6b5b47;
      --accent: #5b52e8;
      --accent2: #7c6ce6;
      --accent-glow: rgba(91,82,232,0.20);
      --success: #2d8866;
      --danger: #a43b32;
      --shadow: rgba(89,55,25,0.10);
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
    .glow-bg { position: fixed; inset: 0; z-index: -1; overflow: hidden; pointer-events: none; }
    .glow-bg::before { content: ''; position: absolute; width: 720px; height: 720px; top: -300px; left: 52%; transform: translateX(-50%); background: radial-gradient(circle, var(--accent-glow) 0%, transparent 70%); filter: blur(80px); }
    .glow-bg::after { content: ''; position: absolute; width: 460px; height: 460px; top: 44%; right: -180px; background: radial-gradient(circle, rgba(167,139,250,.13) 0%, transparent 70%); filter: blur(60px); }
    nav { position: sticky; top: 0; z-index: 20; border-bottom: 1px solid var(--border); background: rgba(247,241,230,.86); backdrop-filter: blur(20px); }
    .nav-inner { max-width: 1480px; min-height: 68px; margin: 0 auto; padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
    .brand { display: flex; align-items: center; gap: 10px; color: var(--accent); font-size: 20px; font-weight: 800; text-decoration: none; }
    .brand img { width: 30px; height: 30px; border-radius: 8px; box-shadow: 0 6px 18px var(--accent-glow); }
    .brand-domain { color: var(--accent2); opacity: .68; font-weight: 400; }
    .account { display: flex; align-items: center; gap: 12px; }
    .account-email { color: var(--text-dim); font-size: 13px; }
    main { max-width: 1480px; margin: 0 auto; padding: 32px 24px 48px; }
    .page-intro { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 22px; }
    .eyebrow { margin: 0 0 5px; color: var(--accent); font-size: 11px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(30px, 4vw, 44px); line-height: 1.05; letter-spacing: -.035em; }
    .intro-copy { max-width: 560px; margin: 0; color: var(--text-dim); font-size: 14px; }
    h2 { margin: 0; font-size: 16px; letter-spacing: -.01em; }
    button, input { font: inherit; }
    button { min-height: 40px; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: #fff; font-weight: 700; cursor: pointer; white-space: nowrap; box-shadow: 0 7px 18px var(--accent-glow); transition: transform .15s ease, background .15s ease, border-color .15s ease; }
    button:hover { background: #5047dc; transform: translateY(-1px); }
    button.secondary { background: rgba(255,253,248,.65); color: var(--text); border-color: var(--border); box-shadow: none; }
    button.secondary:hover { background: var(--card-hover); }
    button.danger { background: transparent; border-color: rgba(164,59,50,.28); color: var(--danger); box-shadow: none; }
    button.danger:hover { background: rgba(164,59,50,.08); }
    button:disabled { opacity: .48; cursor: not-allowed; transform: none; }
    button:focus-visible, .button-link:focus-visible, input:focus-visible, a:focus-visible { outline: 3px solid var(--accent-glow); outline-offset: 2px; }
    .button-link { min-height: 40px; display: inline-flex; align-items: center; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border); background: rgba(255,253,248,.65); color: var(--text); font-weight: 600; text-decoration: none; white-space: nowrap; }
    .button-link:hover { background: var(--card-hover); }
    input { min-height: 40px; border: 1px solid var(--border); border-radius: 8px; padding: 8px 11px; background: rgba(89,55,25,.04); color: var(--text); }
    input::placeholder { color: #8a7964; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .grid { display: grid; grid-template-columns: minmax(320px, 400px) minmax(0, 1fr); gap: 18px; align-items: start; }
    .grid.sessions-collapsed { grid-template-columns: 58px minmax(0, 1fr); gap: 12px; }
    .panel { overflow: hidden; background: rgba(255,253,248,.92); border: 1px solid var(--border); border-radius: 16px; box-shadow: 0 16px 42px var(--shadow); }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 15px 16px 13px; border-bottom: 1px solid var(--border); }
    .panel-kicker { color: var(--text-dim); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .session-heading { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex: 1; }
    .session-panel-actions { display: flex; align-items: center; gap: 7px; }
    .collapse-sessions { width: 30px; min-height: 30px; padding: 0; display: inline-grid; place-items: center; background: transparent; color: var(--text-dim); border-color: var(--border); box-shadow: none; font-size: 21px; line-height: 1; }
    .collapse-sessions:hover { background: var(--card-hover); color: var(--text); }
    .session-panel.is-collapsed { align-self: stretch; min-height: 680px; }
    .session-panel.is-collapsed .panel-head { height: 100%; padding: 10px 8px; border-bottom: 0; align-items: stretch; }
    .session-panel.is-collapsed .session-heading { flex: 1; flex-direction: column; justify-content: flex-start; gap: 12px; }
    .session-panel.is-collapsed .session-heading h2 { order: 2; flex: 1; writing-mode: vertical-rl; transform: rotate(180deg); font-size: 11px; line-height: 1; letter-spacing: .1em; text-transform: uppercase; color: var(--text-dim); }
    .session-panel.is-collapsed .session-panel-actions { order: 1; flex-direction: column-reverse; }
    .session-panel.is-collapsed .panel-body, .session-panel.is-collapsed .destroyed-toggle { display: none !important; }
    .session-panel.is-collapsed .status { min-width: 24px; padding: 0; justify-content: center; }
    .session-panel.is-collapsed .collapse-sessions span { transform: rotate(180deg); }
    .panel-body { padding: 16px; }
    .create-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .create-note { color: var(--text-dim); font-size: 12px; }
    .sessions { display: grid; gap: 8px; }
    .session { text-align: left; width: 100%; color: var(--text); background: rgba(89,55,25,.025); border: 1px solid var(--border); display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 10px; padding: 11px 12px; box-shadow: none; }
    .session:hover { background: var(--card-hover); border-color: rgba(91,82,232,.25); }
    .session.active { border-color: var(--accent); background: rgba(91,82,232,.08); box-shadow: 0 0 0 1px rgba(91,82,232,.08); }
    .session-title { font-weight: 700; font-size: 13px; overflow-wrap: anywhere; }
    .session-meta { color: var(--text-dim); font-size: 12px; margin-top: 3px; overflow-wrap: anywhere; }
    .status { display: inline-flex; align-items: center; min-height: 24px; padding: 0 8px; border-radius: 999px; background: rgba(89,55,25,.07); color: var(--text-dim); font-size: 11px; font-weight: 700; }
    .destroyed-toggle { min-height: 30px; padding: 4px 8px; border: 0; background: transparent; color: var(--text-dim); box-shadow: none; font-size: 11px; font-weight: 600; }
    .destroyed-toggle:hover { background: var(--card-hover); color: var(--text); }
    .viewer-wrap { min-height: 680px; display: grid; grid-template-rows: auto 1fr; }
    .viewer-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 14px; border-bottom: 1px solid var(--border); }
    .viewer-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 700; }
    iframe { width: 100%; height: 640px; border: 0; background: #0b0e17; border-radius: 0 0 16px 16px; }
    .empty { min-height: 640px; display: grid; place-items: center; color: var(--text-dim); text-align: center; padding: 20px; }
    .empty-small { min-height: 180px; border: 1px dashed var(--border); border-radius: 10px; }
    .message { margin-top: 10px; min-height: 20px; color: var(--success); font-size: 12px; overflow-wrap: anywhere; }
    .message.error { color: var(--danger); }
    .api-key-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    .api-panel { grid-column: 1 / -1; }
    .api-description { margin: 3px 0 0; color: var(--text-dim); font-size: 12px; }
    .secret { display: none; margin-top: 10px; padding: 11px; border: 1px solid var(--border); border-radius: 8px; background: rgba(89,55,25,.04); overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }
    @media (max-width: 900px) {
      .nav-inner { padding-inline: 14px; }
      .account-email { display: none; }
      main { padding: 24px 14px 36px; }
      .page-intro { align-items: start; flex-direction: column; }
      .grid, .grid.sessions-collapsed { grid-template-columns: 1fr; gap: 18px; }
      .collapse-sessions { display: none; }
      .session-panel.is-collapsed { min-height: 0; }
      .session-panel.is-collapsed .panel-head { height: auto; padding: 15px 16px 13px; border-bottom: 1px solid var(--border); }
      .session-panel.is-collapsed .session-heading { flex-direction: row; justify-content: space-between; }
      .session-panel.is-collapsed .session-heading h2 { order: 0; flex: 0 1 auto; writing-mode: horizontal-tb; transform: none; font-size: 16px; line-height: normal; letter-spacing: normal; text-transform: none; color: var(--text); }
      .session-panel.is-collapsed .session-panel-actions { order: 0; flex-direction: row; }
      .session-panel.is-collapsed .panel-body { display: block; }
      .session-panel.is-collapsed .status { min-width: auto; padding: 0 8px; }
      iframe, .empty { height: 520px; min-height: 520px; }
    }
    @media (max-width: 620px) {
      .brand { font-size: 17px; gap: 7px; }
      .brand img { width: 27px; height: 27px; }
      .account { gap: 6px; }
      .account button { min-height: 36px; padding: 7px 10px; }
      .page-intro { margin-bottom: 18px; }
      .viewer-actions { align-items: flex-start; flex-direction: column; }
      .viewer-actions .toolbar { width: 100%; }
      .viewer-actions .toolbar > * { flex: 1; justify-content: center; }
      .create-row { align-items: stretch; flex-direction: column; }
      .create-row button { width: 100%; }
      .api-key-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="glow-bg" aria-hidden="true"></div>
  <nav>
    <div class="nav-inner">
      <a class="brand" href="https://webbrain.one/">
        <img src="https://webbrain.one/logo-github.png" alt=""> WebBrain<span class="brand-domain">.cloud</span>
      </a>
      <div class="account">
        <span class="account-email">${escapeHtml(user.email)}</span>
        <button class="secondary" id="refreshBtn" type="button">Refresh</button>
        <form method="post" action="/auth/logout"><button class="secondary" type="submit">Log out</button></form>
      </div>
    </div>
  </nav>
  <main>
    <section class="page-intro">
      <div>
        <p class="eyebrow">WebBrain Cloud</p>
        <h1>Cloud browsers</h1>
      </div>
      <p class="intro-copy">Your persistent WebBrain sessions—visible here and controllable through the API.</p>
    </section>
    <div class="grid" id="dashboardGrid">
      <section class="panel session-panel" id="sessionPanel">
        <div class="panel-head">
          <div class="session-heading">
            <div>
              <div class="panel-kicker">Workspace</div>
              <h2>Browser sessions</h2>
            </div>
            <div class="session-panel-actions">
              <button class="destroyed-toggle" id="toggleDestroyedBtn" type="button" aria-pressed="false" style="display:none">Show destroyed</button>
              <span class="status" id="sessionCount">0</span>
              <button class="collapse-sessions" id="collapseSessionsBtn" type="button" aria-controls="sessionPanelBody" aria-expanded="true" title="Collapse browser sessions"><span aria-hidden="true">‹</span></button>
            </div>
          </div>
        </div>
        <div class="panel-body" id="sessionPanelBody">
          <div class="create-row">
            <span class="create-note">A private browser with WebBrain preinstalled.</span>
            <button id="createSessionBtn" type="button">+ New browser</button>
          </div>
          <div class="sessions" id="sessions"></div>
          <div class="message" id="sessionMessage"></div>
        </div>
      </section>
      <section class="panel viewer-wrap">
        <div class="viewer-actions">
          <div class="viewer-title" id="viewerTitle">Browser preview</div>
          <div class="toolbar">
            <button class="secondary" id="connectBtn" type="button" disabled>Open noVNC</button>
            <a class="button-link" id="externalLink" href="#" target="_blank" rel="noopener" style="display:none">New tab</a>
            <button class="danger" id="deleteSessionBtn" type="button" disabled>Delete</button>
          </div>
        </div>
        <div id="viewerEmpty" class="empty">Create or select a browser session, then open noVNC here.</div>
        <iframe id="novncFrame" title="WebBrain cloud browser noVNC" style="display:none" referrerpolicy="no-referrer"></iframe>
      </section>
      <section class="panel api-panel">
        <div class="panel-head">
          <div>
            <div class="panel-kicker">Developer access</div>
            <h2>API keys</h2>
            <p class="api-description">Control the same visible browsers from your own tools.</p>
          </div>
        </div>
        <div class="panel-body">
          <div class="api-key-row">
            <input id="apiKeyName" aria-label="API key name" placeholder="API key name" value="Default API key">
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
    const dashboardGrid = document.getElementById('dashboardGrid');
    const sessionPanel = document.getElementById('sessionPanel');
    const collapseSessionsBtn = document.getElementById('collapseSessionsBtn');
    const toggleDestroyedBtn = document.getElementById('toggleDestroyedBtn');
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
    const state = { sessions: [], selectedId: null, showDestroyed: false };
    const sessionsCollapsedKey = 'webbrain.sessionsCollapsed';

    function setSessionsCollapsed(collapsed) {
      dashboardGrid.classList.toggle('sessions-collapsed', collapsed);
      sessionPanel.classList.toggle('is-collapsed', collapsed);
      collapseSessionsBtn.setAttribute('aria-expanded', String(!collapsed));
      collapseSessionsBtn.title = collapsed ? 'Expand browser sessions' : 'Collapse browser sessions';
      try { localStorage.setItem(sessionsCollapsedKey, collapsed ? '1' : '0'); } catch {}
    }

    try { setSessionsCollapsed(localStorage.getItem(sessionsCollapsedKey) === '1'); } catch { setSessionsCollapsed(false); }

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

    function visibleSessions() {
      return state.showDestroyed ? state.sessions : state.sessions.filter(s => s.status !== 'destroyed');
    }

    function ensureVisibleSelection(sessions) {
      if (state.selectedId && !sessions.some(s => s.id === state.selectedId)) state.selectedId = null;
      if (!state.selectedId && sessions[0]) state.selectedId = sessions[0].id;
    }

    function renderSessions() {
      const sessions = visibleSessions();
      const destroyedCount = state.sessions.filter(s => s.status === 'destroyed').length;
      ensureVisibleSelection(sessions);
      sessionCount.textContent = String(sessions.length);
      toggleDestroyedBtn.style.display = destroyedCount ? '' : 'none';
      toggleDestroyedBtn.textContent = state.showDestroyed ? 'Hide destroyed' : 'Show ' + destroyedCount + ' destroyed';
      toggleDestroyedBtn.setAttribute('aria-pressed', String(state.showDestroyed));
      sessionsEl.innerHTML = '';
      if (!sessions.length) {
        sessionsEl.innerHTML = '<div class="empty empty-small">No active browser sessions yet.</div>';
      }
      for (const session of sessions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'session' + (session.id === state.selectedId ? ' active' : '');
        const details = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'session-title';
        title.textContent = session.id;
        const meta = document.createElement('div');
        meta.className = 'session-meta';
        meta.textContent = session.public_ip || (session.status === 'provisioning' ? 'Preparing browser…' : 'Waiting for browser');
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
      viewerTitle.textContent = session ? session.id + ' · ' + session.status : 'Browser preview';
    }

    async function loadSessions() {
      const body = await api('/api/browser-sessions');
      state.sessions = body.browser_sessions || [];
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
          body: {},
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
      setSessionsCollapsed(true);
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
    collapseSessionsBtn.addEventListener('click', () => setSessionsCollapsed(!sessionPanel.classList.contains('is-collapsed')));
    toggleDestroyedBtn.addEventListener('click', () => {
      state.showDestroyed = !state.showDestroyed;
      renderSessions();
    });
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
        'x-webbrain-device-id': `platform-${hashToken(`webbrain-platform:${session.user_id}`).slice(0, 32)}`,
        'x-webbrain-client': 'platform',
      };
      if (req.headers.accept) headers.accept = req.headers.accept;
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
    const refreshed = await Promise.all(sessions.map(session => refreshProvisioningSession(session)));
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
      browser_session: publicBrowserSession(session),
    });
  });

  async function browserRuntimeState(session) {
    const dropletConnected = controlChannel.isConnected(session.id);
    if (!dropletConnected) {
      return { droplet_connected: false, extension_connected: false, runtime_ready: false };
    }
    const health = await controlChannel.send(session.id, 'health', {}, 2000).catch(() => null);
    const extensionConnected = health?.extension_connected === true;
    return {
      droplet_connected: true,
      extension_connected: extensionConnected,
      runtime_ready: extensionConnected,
    };
  }

  async function refreshProvisioningSession(session) {
    const runtime = await browserRuntimeState(session);
    if (!session.droplet_id || ['failed', 'stopping', 'destroyed'].includes(session.status)) return { ...session, ...runtime };
    const refreshed = await provisioner.getDroplet(session.droplet_id).catch(() => null);
    if (!refreshed?.status) return { ...session, ...runtime };
    const status = refreshed.status === 'ready' && !runtime.runtime_ready ? 'provisioning' : refreshed.status;
    if (status === session.status && (!refreshed.public_ip || refreshed.public_ip === session.public_ip)) {
      return { ...session, ...runtime };
    }
    const updated = await store.updateBrowserSession(session.id, {
      status,
      public_ip: refreshed.public_ip || session.public_ip,
      updated_at: nowIso(),
    });
    return { ...updated, ...runtime };
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
      const runtime = await browserRuntimeState(session);
      if (!runtime.runtime_ready) {
        return jsonError(res, 409, 'WebBrain browser runtime is not ready; the extension bridge is not connected.', runtime);
      }
      const started = await controlChannel.send(session.id, 'run', {
        task,
        output_schema: req.body.output_schema ?? req.body.outputSchema ?? null,
        tab_id: req.body.tab_id ?? req.body.tabId ?? null,
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
