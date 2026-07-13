import express from 'express';
import { randomId, randomSecret, nowIso, isoAfterMs } from '../shared/ids.js';
import { hashPassword, verifyPassword, hashToken } from '../shared/crypto.js';
import { publicBrowserSession, publicRun, jsonError } from '../shared/http.js';
import { signNoVncToken } from '../shared/novnc-token.js';
import { instanceHostname } from './instance-proxy.js';
import { docsPage } from './docs-page.js';

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

function normalizeBrowserDisplayName(value) {
  const name = String(value ?? '').trim();
  if (name.length > 120) {
    throw Object.assign(new Error('Browser name must be 120 characters or fewer'), { status: 400 });
  }
  return name || null;
}

function apiKeyPrefixCandidates(rawKey) {
  if (!String(rawKey).startsWith('wbp_')) return [];
  const payload = String(rawKey).slice(4);
  return [...new Set([
    payload.slice(0, 8),
    payload.slice(0, 7),
    payload.split('_')[0],
  ].filter(Boolean))];
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
    .nav-note { color: var(--text-dim); font-size: 13px; font-weight: 650; text-decoration: none; }
    .nav-note:hover { color: var(--text); }
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
      <a class="nav-note" href="/docs">API documentation →</a>
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
    .header-nav { display: flex; align-items: center; gap: 4px; padding: 3px; border: 1px solid var(--border); border-radius: 9px; background: rgba(255,253,248,.55); }
    .header-link { min-height: 28px; display: inline-flex; align-items: center; padding: 4px 9px; border-radius: 6px; color: var(--text-dim); font-size: 12px; font-weight: 700; text-decoration: none; }
    .header-link:hover, .header-link[aria-current="page"] { background: var(--card); color: var(--text); box-shadow: 0 2px 8px var(--shadow); }
    .account-menu { position: relative; }
    .account-summary { min-height: 38px; max-width: 270px; display: flex; align-items: center; gap: 8px; padding: 5px 8px 5px 5px; border: 1px solid var(--border); border-radius: 10px; background: rgba(255,253,248,.65); color: var(--text); cursor: pointer; list-style: none; user-select: none; transition: background .15s ease, border-color .15s ease, box-shadow .15s ease; }
    .account-summary::-webkit-details-marker { display: none; }
    .account-summary:hover, .account-menu[open] .account-summary { background: var(--card); border-color: rgba(91,82,232,.25); box-shadow: 0 4px 14px var(--shadow); }
    .account-summary:focus-visible { outline: 3px solid var(--accent-glow); outline-offset: 2px; }
    .account-avatar { width: 26px; height: 26px; flex: 0 0 26px; display: grid; place-items: center; border-radius: 8px; background: rgba(91,82,232,.12); color: var(--accent); font-size: 12px; font-weight: 850; text-transform: uppercase; }
    .account-summary-email { min-width: 0; overflow: hidden; color: var(--text-dim); font-size: 12px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
    .account-caret { width: 7px; height: 7px; flex: 0 0 7px; margin: -3px 2px 0 1px; border-right: 1.5px solid var(--text-dim); border-bottom: 1.5px solid var(--text-dim); transform: rotate(45deg); transition: transform .15s ease; }
    .account-menu[open] .account-caret { margin-top: 3px; transform: rotate(225deg); }
    .account-popover { position: absolute; top: calc(100% + 8px); right: 0; width: min(292px, calc(100vw - 28px)); padding: 6px; border: 1px solid var(--border); border-radius: 12px; background: var(--card); box-shadow: 0 18px 46px rgba(44,24,16,.16); }
    .account-context { min-width: 0; margin-bottom: 4px; padding: 8px 9px 10px; border-bottom: 1px solid var(--border); }
    .account-context-label { display: block; margin-bottom: 2px; color: var(--text-dim); font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .account-context-email { display: block; overflow: hidden; font-size: 13px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
    .account-popover form { margin: 0; }
    button.account-action { width: 100%; min-height: 38px; display: flex; align-items: center; gap: 10px; padding: 8px 9px; border: 0; border-radius: 7px; background: transparent; color: var(--text); box-shadow: none; font-size: 13px; font-weight: 650; text-align: left; }
    button.account-action:hover { background: var(--card-hover); color: var(--text); transform: none; }
    button.account-action svg { width: 16px; height: 16px; flex: 0 0 16px; color: var(--text-dim); }
    button.account-action.logout-action { color: var(--danger); }
    button.account-action.logout-action svg { color: currentColor; }
    button.account-action.logout-action:hover { background: rgba(164,59,50,.08); color: var(--danger); }
    main { max-width: 1480px; margin: 0 auto; padding: 32px 24px 48px; }
    .dashboard-view[hidden] { display: none; }
    .page-intro { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 22px; }
    .eyebrow { margin: 0 0 5px; color: var(--accent); font-size: 11px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(30px, 4vw, 44px); line-height: 1.05; letter-spacing: -.035em; }
    .intro-copy { max-width: 560px; margin: 0; color: var(--text-dim); font-size: 14px; }
    h2 { margin: 0; font-size: 16px; letter-spacing: -.01em; }
    button, input { font: inherit; }
    button { min-height: 34px; padding: 6px 10px; border-radius: 7px; border: 1px solid var(--accent); background: var(--accent); color: #fff; font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap; box-shadow: 0 5px 14px var(--accent-glow); transition: transform .15s ease, background .15s ease, border-color .15s ease; }
    button:hover { background: #5047dc; transform: translateY(-1px); }
    button.secondary { background: rgba(255,253,248,.65); color: var(--text); border-color: var(--border); box-shadow: none; }
    button.secondary:hover { background: var(--card-hover); }
    button.danger { background: transparent; border-color: rgba(164,59,50,.28); color: var(--danger); box-shadow: none; }
    button.danger:hover { background: rgba(164,59,50,.08); }
    button:disabled { opacity: .48; cursor: not-allowed; transform: none; }
    button:focus-visible, .button-link:focus-visible, input:focus-visible, a:focus-visible { outline: 3px solid var(--accent-glow); outline-offset: 2px; }
    .button-link { min-height: 34px; display: inline-flex; align-items: center; padding: 6px 10px; border-radius: 7px; border: 1px solid var(--border); background: rgba(255,253,248,.65); color: var(--text); font-size: 12px; font-weight: 600; text-decoration: none; white-space: nowrap; }
    .button-link:hover { background: var(--card-hover); }
    input { min-height: 36px; border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; background: rgba(89,55,25,.04); color: var(--text); }
    input::placeholder { color: #8a7964; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .grid { display: grid; grid-template-columns: minmax(320px, 400px) minmax(0, 1fr); gap: 18px; align-items: start; }
    .grid.sessions-collapsed { grid-template-columns: 44px minmax(0, 1fr); gap: 12px; }
    .workspace-column { min-width: 0; display: grid; gap: 18px; }
    .panel { overflow: hidden; background: rgba(255,253,248,.92); border: 1px solid var(--border); border-radius: 16px; box-shadow: 0 16px 42px var(--shadow); }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 15px 16px 13px; border-bottom: 1px solid var(--border); }
    .panel-kicker { color: var(--text-dim); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .session-heading { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex: 1; }
    .session-panel-actions { display: flex; align-items: center; gap: 7px; }
    .collapse-sessions { width: 30px; min-height: 30px; padding: 0; display: inline-grid; place-items: center; background: transparent; color: var(--text-dim); border-color: var(--border); box-shadow: none; font-size: 21px; line-height: 1; }
    .collapse-sessions:hover { background: var(--card-hover); color: var(--text); }
    .session-panel.is-collapsed { align-self: stretch; min-height: 680px; }
    .session-panel.is-collapsed .panel-head { height: 100%; padding: 8px 6px; border-bottom: 0; align-items: flex-start; }
    .session-panel.is-collapsed .session-heading { justify-content: center; }
    .session-panel.is-collapsed .session-heading > div:first-child, .session-panel.is-collapsed .destroyed-toggle, .session-panel.is-collapsed #sessionCount { display: none !important; }
    .session-panel.is-collapsed .session-panel-actions { display: block; }
    .session-panel.is-collapsed .panel-body { display: none !important; }
    .session-panel.is-collapsed .collapse-sessions span { transform: rotate(180deg); }
    .panel-body { padding: 16px; }
    .create-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px; margin-bottom: 14px; }
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
    .viewer-title-button { min-width: 0; max-width: 52%; display: inline-flex; align-items: center; gap: 6px; padding-inline: 4px 7px; border-color: transparent; background: transparent; color: var(--text); box-shadow: none; }
    .viewer-title-button:hover { background: var(--card-hover); }
    iframe { width: 100%; height: 640px; border: 0; background: #0b0e17; border-radius: 0 0 16px 16px; }
    .empty { min-height: 640px; display: grid; place-items: center; color: var(--text-dim); text-align: center; padding: 20px; }
    .empty-small { min-height: 180px; border: 1px dashed var(--border); border-radius: 10px; }
    .message { margin-top: 10px; min-height: 20px; color: var(--success); font-size: 12px; overflow-wrap: anywhere; }
    .message.error { color: var(--danger); }
    .api-key-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    .api-panel { max-width: 980px; margin: 0 auto; }
    .api-description { margin: 3px 0 0; color: var(--text-dim); font-size: 12px; }
    .docs-link { align-self: center; }
    .secret { display: none; margin-top: 10px; padding: 11px; border: 1px solid var(--border); border-radius: 8px; background: rgba(89,55,25,.04); overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    .api-key-list { display: grid; gap: 8px; margin-top: 14px; }
    .api-key-list .empty-small { min-height: 100px; }
    .api-key-item { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 12px; padding: 11px 12px; border: 1px solid var(--border); border-radius: 10px; background: rgba(89,55,25,.025); }
    .api-key-name { font-size: 13px; font-weight: 700; }
    .api-key-meta { margin-top: 3px; color: var(--text-dim); font-size: 11px; }
    .api-key-actions { display: flex; align-items: center; gap: 8px; }
    .api-key-state { color: var(--success); font-size: 11px; font-weight: 700; }
    .api-key-state.revoked { color: var(--text-dim); }
    .connection-panel { min-width: 0; }
    .connection-head { align-items: flex-start; }
    .connection-session { max-width: 48%; padding: 5px 8px; border: 1px solid var(--border); border-radius: 7px; background: rgba(89,55,25,.035); color: var(--text-dim); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .code-tabs { display: flex; gap: 4px; margin-bottom: 8px; padding: 4px; border-radius: 9px; background: var(--surface); overflow-x: auto; }
    .code-tab { min-height: 29px; flex: 0 0 auto; padding: 4px 10px; border-color: transparent; background: transparent; color: var(--text-dim); box-shadow: none; }
    .code-tab:hover, .code-tab[aria-selected="true"] { background: var(--card); border-color: var(--border); color: var(--text); box-shadow: 0 2px 8px var(--shadow); }
    .code-shell { overflow: hidden; border-radius: 11px; background: #211812; color: #f8ead3; }
    .code-shell pre { min-height: 230px; margin: 0; padding: 18px; overflow: auto; font: 12px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; tab-size: 2; }
    .code-shell .tok-comment { color: #9c8c7f; font-style: italic; }
    .code-shell .tok-keyword { color: #d6b4ff; font-weight: 650; }
    .code-shell .tok-string { color: #a6e3b5; }
    .code-shell .tok-variable { color: #f4cc7d; }
    .code-shell .tok-number, .code-shell .tok-literal { color: #ff9f7a; }
    .code-shell .tok-function { color: #8ebdff; }
    .code-shell .tok-operator { color: #e9a6cf; }
    .code-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 10px; border-top: 1px solid rgba(248,234,211,.12); background: rgba(255,255,255,.03); }
    .code-note { color: #cbbda8; font-size: 11px; }
    .code-actions { display: flex; align-items: center; gap: 7px; }
    .code-actions .button-link, .code-actions button { min-height: 29px; border-color: rgba(248,234,211,.22); background: transparent; color: #f8ead3; box-shadow: none; }
    .code-actions .button-link:hover, .code-actions button:hover { background: rgba(255,255,255,.09); }
    dialog { width: min(440px, calc(100vw - 28px)); padding: 0; border: 1px solid var(--border); border-radius: 16px; background: var(--card); color: var(--text); box-shadow: 0 28px 80px rgba(44,24,16,.24); }
    dialog::backdrop { background: rgba(15,12,20,.46); backdrop-filter: blur(3px); }
    .dialog-body { padding: 22px; }
    .dialog-body h2 { font-size: 21px; }
    .dialog-body p { color: var(--text-dim); font-size: 13px; }
    .dialog-body input { width: 100%; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
    .confirm-phrase { padding: 2px 6px; border: 1px solid var(--border); border-radius: 5px; background: rgba(89,55,25,.05); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text); }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }
    @media (max-width: 900px) {
      .nav-inner { padding-inline: 14px; }
      main { padding: 24px 14px 36px; }
      .page-intro { align-items: start; flex-direction: column; }
      .grid, .grid.sessions-collapsed { grid-template-columns: 1fr; gap: 18px; }
      .collapse-sessions { display: none; }
      .session-panel.is-collapsed { min-height: 0; }
      .session-panel.is-collapsed .panel-head { height: auto; padding: 15px 16px 13px; border-bottom: 1px solid var(--border); }
      .session-panel.is-collapsed .session-heading { flex-direction: row; justify-content: space-between; }
      .session-panel.is-collapsed .session-heading > div:first-child, .session-panel.is-collapsed #sessionCount { display: block !important; }
      .session-panel.is-collapsed .session-panel-actions { order: 0; display: flex; flex-direction: row; }
      .session-panel.is-collapsed .panel-body { display: block; }
      .session-panel.is-collapsed .status { min-width: auto; padding: 0 8px; }
      iframe, .empty { height: 520px; min-height: 520px; }
    }
    @media (max-width: 620px) {
      .brand { font-size: 17px; gap: 7px; }
      .brand img { width: 27px; height: 27px; }
      .brand-domain { display: none; }
      .account { gap: 6px; }
      .account-summary { padding-right: 7px; }
      .account-summary-email { display: none; }
      .header-nav { gap: 2px; }
      .page-intro { margin-bottom: 18px; }
      .viewer-actions { align-items: flex-start; flex-direction: column; }
      .viewer-actions .toolbar { width: 100%; }
      .viewer-actions .toolbar > * { flex: 1; justify-content: center; }
      .create-row { grid-template-columns: 1fr; }
      .create-row button { width: 100%; }
      .api-key-row { grid-template-columns: 1fr; }
      .api-key-item { grid-template-columns: 1fr; }
      .api-key-actions { justify-content: space-between; }
      .api-panel .panel-head { align-items: stretch; flex-direction: column; }
      .connection-head { align-items: stretch; flex-direction: column; }
      .connection-session { max-width: 100%; }
      .code-footer { align-items: stretch; flex-direction: column; }
      .code-actions > * { flex: 1; justify-content: center; }
      .docs-link { justify-content: center; }
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
        <div class="header-nav" aria-label="Dashboard sections">
          <a class="header-link" href="#browsers" data-view-target="browsers" aria-current="page">Browsers</a>
          <a class="header-link" href="#api-keys" data-view-target="api-keys">API keys</a>
        </div>
        <details class="account-menu" id="accountMenu">
          <summary class="account-summary" aria-label="Account menu for ${escapeHtml(user.email)}">
            <span class="account-avatar" aria-hidden="true">${escapeHtml(String(user.email).trim().slice(0, 1) || 'W')}</span>
            <span class="account-summary-email">${escapeHtml(user.email)}</span>
            <span class="account-caret" aria-hidden="true"></span>
          </summary>
          <div class="account-popover">
            <div class="account-context">
              <span class="account-context-label">Signed in as</span>
              <span class="account-context-email">${escapeHtml(user.email)}</span>
            </div>
            <button class="account-action" id="refreshBtn" type="button">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 8.2a7 7 0 0 1 11.5-2.6L20 8M4 16l2.4 2.4a7 7 0 0 0 11.5-2.6"/></svg>
              <span class="account-action-label">Refresh dashboard</span>
            </button>
            <form method="post" action="/auth/logout">
              <button class="account-action logout-action" type="submit">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/></svg>
                <span>Log out</span>
              </button>
            </form>
          </div>
        </details>
      </div>
    </div>
  </nav>
  <main>
    <section class="dashboard-view" id="browserView">
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
              <input id="newSessionName" aria-label="Browser name" maxlength="120" placeholder="Name this browser (optional)">
              <button id="createSessionBtn" type="button">+ New browser</button>
            </div>
            <div class="sessions" id="sessions"></div>
            <div class="message" id="sessionMessage"></div>
          </div>
        </section>
        <div class="workspace-column">
          <section class="panel viewer-wrap">
            <div class="viewer-actions">
              <button class="viewer-title-button" id="renameSessionBtn" type="button" disabled title="Rename browser"><span class="viewer-title" id="viewerTitle">Browser preview</span><span aria-hidden="true">✎</span></button>
              <div class="toolbar">
                <button class="secondary" id="connectBtn" type="button" disabled>Connect</button>
                <a class="button-link" id="externalLink" href="#" target="_blank" rel="noopener" style="display:none">Open separately</a>
                <button class="danger" id="deleteSessionBtn" type="button" disabled>Delete</button>
              </div>
            </div>
            <div id="viewerEmpty" class="empty">Create or select a browser, then connect here.</div>
            <iframe id="novncFrame" title="WebBrain cloud browser noVNC" style="display:none" referrerpolicy="no-referrer"></iframe>
          </section>
          <section class="panel connection-panel" aria-labelledby="connectionTitle">
            <div class="panel-head connection-head">
              <div>
                <div class="panel-kicker">Use this browser from code</div>
                <h2 id="connectionTitle">Run a task</h2>
                <p class="api-description">The selected session stays visible above while your code controls it.</p>
              </div>
              <span class="connection-session" id="connectionSessionId">Select a browser</span>
            </div>
            <div class="panel-body">
              <div class="code-tabs" role="tablist" aria-label="Choose a language">
                <button class="code-tab" id="connectionTabRest" type="button" role="tab" aria-selected="true" data-code-client="rest">REST</button>
                <button class="code-tab" type="button" role="tab" aria-selected="false" data-code-client="node">Node.js</button>
                <button class="code-tab" type="button" role="tab" aria-selected="false" data-code-client="python">Python</button>
                <button class="code-tab" type="button" role="tab" aria-selected="false" data-code-client="php">PHP</button>
              </div>
              <div class="code-shell">
                <pre aria-live="polite"><code id="connectionCode"></code></pre>
                <div class="code-footer">
                  <span class="code-note" id="connectionNote">Examples use the selected session ID and <code>WEBBRAIN_API_KEY</code>.</span>
                  <div class="code-actions">
                    <a class="button-link" href="#api-keys" data-view-target="api-keys">Get an API key</a>
                    <a class="button-link" href="/docs">Full docs</a>
                    <button id="copyConnectionCode" type="button">Copy</button>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </section>
    <section class="dashboard-view" id="apiKeysView" hidden>
      <section class="page-intro">
        <div>
          <p class="eyebrow">Developer access</p>
          <h1>API keys</h1>
        </div>
        <p class="intro-copy">Create and revoke the keys your tools use to control these browser sessions.</p>
      </section>
      <section class="panel api-panel" id="apiKeysPanel">
        <div class="panel-head">
          <div>
            <div class="panel-kicker">Credentials</div>
            <h2>Your API keys</h2>
            <p class="api-description">Keys grant access to your browsers. Store them like passwords.</p>
          </div>
          <a class="button-link docs-link" href="/docs">API documentation →</a>
        </div>
        <div class="panel-body">
          <div class="api-key-row">
            <input id="apiKeyName" aria-label="API key name" placeholder="API key name" value="Default API key">
            <button id="createApiKeyBtn" type="button">Create key</button>
          </div>
          <div class="secret" id="newApiKey"></div>
          <div class="message" id="apiKeyMessage"></div>
          <div class="api-key-list" id="apiKeysList"></div>
        </div>
      </section>
    </section>
  </main>
  <dialog id="renameDialog">
    <form class="dialog-body" method="dialog" id="renameForm">
      <h2>Name this browser</h2>
      <p>Use a short name you will recognize later.</p>
      <input id="renameInput" aria-label="Browser name" maxlength="120" placeholder="Research, Personal, Client work…">
      <div class="dialog-actions">
        <button class="secondary" type="button" id="cancelRenameBtn">Cancel</button>
        <button type="submit" id="saveRenameBtn">Save name</button>
      </div>
    </form>
  </dialog>
  <dialog id="deleteDialog">
    <div class="dialog-body">
      <h2>Delete this browser?</h2>
      <p id="deleteDialogDescription">This permanently destroys the cloud browser and cannot be undone.</p>
      <p>Type <span class="confirm-phrase">I confirm</span> to continue.</p>
      <input id="deleteConfirmInput" aria-label="Type I confirm to delete" autocomplete="off" placeholder="I confirm">
      <div class="dialog-actions">
        <button class="secondary" type="button" id="cancelDeleteBtn">Cancel</button>
        <button class="danger" type="button" id="confirmDeleteBtn" disabled>Delete browser</button>
      </div>
    </div>
  </dialog>
  <script>
    const sessionsEl = document.getElementById('sessions');
    const dashboardGrid = document.getElementById('dashboardGrid');
    const sessionPanel = document.getElementById('sessionPanel');
    const collapseSessionsBtn = document.getElementById('collapseSessionsBtn');
    const toggleDestroyedBtn = document.getElementById('toggleDestroyedBtn');
    const sessionMessage = document.getElementById('sessionMessage');
    const sessionCount = document.getElementById('sessionCount');
    const createSessionBtn = document.getElementById('createSessionBtn');
    const newSessionName = document.getElementById('newSessionName');
    const accountMenu = document.getElementById('accountMenu');
    const refreshBtn = document.getElementById('refreshBtn');
    const connectBtn = document.getElementById('connectBtn');
    const deleteSessionBtn = document.getElementById('deleteSessionBtn');
    const renameSessionBtn = document.getElementById('renameSessionBtn');
    const viewerTitle = document.getElementById('viewerTitle');
    const viewerEmpty = document.getElementById('viewerEmpty');
    const novncFrame = document.getElementById('novncFrame');
    const externalLink = document.getElementById('externalLink');
    const createApiKeyBtn = document.getElementById('createApiKeyBtn');
    const apiKeyName = document.getElementById('apiKeyName');
    const newApiKey = document.getElementById('newApiKey');
    const apiKeyMessage = document.getElementById('apiKeyMessage');
    const apiKeysList = document.getElementById('apiKeysList');
    const browserView = document.getElementById('browserView');
    const apiKeysView = document.getElementById('apiKeysView');
    const viewLinks = [...document.querySelectorAll('[data-view-target]')];
    const connectionSessionId = document.getElementById('connectionSessionId');
    const connectionCode = document.getElementById('connectionCode');
    const connectionTabs = [...document.querySelectorAll('[data-code-client]')];
    const copyConnectionCode = document.getElementById('copyConnectionCode');
    const connectionNote = document.getElementById('connectionNote');
    const renameDialog = document.getElementById('renameDialog');
    const renameForm = document.getElementById('renameForm');
    const renameInput = document.getElementById('renameInput');
    const cancelRenameBtn = document.getElementById('cancelRenameBtn');
    const deleteDialog = document.getElementById('deleteDialog');
    const deleteDialogDescription = document.getElementById('deleteDialogDescription');
    const deleteConfirmInput = document.getElementById('deleteConfirmInput');
    const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
    const state = { sessions: [], apiKeys: [], selectedId: null, showDestroyed: false, deleteTargetId: null, codeClient: 'rest' };
    const sessionsCollapsedKey = 'webbrain.sessionsCollapsed';

    function setDashboardView(view, updateUrl) {
      const nextView = view === 'api-keys' ? 'api-keys' : 'browsers';
      browserView.hidden = nextView !== 'browsers';
      apiKeysView.hidden = nextView !== 'api-keys';
      for (const link of viewLinks) {
        if (link.dataset.viewTarget === nextView) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
      if (updateUrl) history.pushState(null, '', nextView === 'api-keys' ? '#api-keys' : '#browsers');
      if (nextView === 'api-keys') loadApiKeys().catch(e => showMessage(apiKeyMessage, e.message, true));
    }

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

    function browserName(session) {
      return session?.display_name || ('Browser ' + String(session?.id || '').slice(-4).toUpperCase());
    }

    function connectionExamples(sessionId) {
      return {
        rest: 'curl -X POST "https://webbrain.cloud/api/browser-sessions/' + sessionId + '/runs" -H "Authorization: Bearer $WEBBRAIN_API_KEY" -H "Content-Type: application/json" --data ' + JSON.stringify('{"task":"Open example.com and tell me the page title","wait":true}'),
        node: [
          "import { WebBrainClient } from './webbrain-client.js';",
          '',
          'const client = new WebBrainClient({',
          '  apiKey: process.env.WEBBRAIN_API_KEY,',
          '});',
          "const run = await client.createRun('" + sessionId + "', {",
          "  task: 'Open example.com and tell me the page title',",
          '  wait: true,',
          '});',
          'console.log(run.result);',
        ].join(String.fromCharCode(10)),
        python: [
          'import os',
          'from webbrain_client import WebBrainClient',
          '',
          "client = WebBrainClient(os.environ['WEBBRAIN_API_KEY'])",
          "run = client.create_run('" + sessionId + "', 'Open example.com and tell me the page title', wait=True)",
          "print(run['result'])",
        ].join(String.fromCharCode(10)),
        php: [
          '<?php',
          "require_once __DIR__ . '/WebBrainClient.php';",
          '',
          "$client = new WebBrainClient(getenv('WEBBRAIN_API_KEY') ?: '');",
          "$run = $client->createRun('" + sessionId + "', 'Open example.com and tell me the page title', ['wait' => true]);",
          "print_r($run['result']);",
        ].join(String.fromCharCode(10)),
      };
    }

    const connectionKeywords = {
      rest: new Set(['curl']),
      node: new Set(['import', 'from', 'const', 'let', 'await', 'new', 'export', 'class', 'async', 'throw', 'return']),
      python: new Set(['import', 'from', 'as', 'class', 'def', 'return', 'raise', 'if', 'else', 'elif', 'while', 'for', 'in', 'with', 'try', 'except']),
      php: new Set(['<?php', 'require_once', 'new', 'function', 'public', 'private', 'class', 'final', 'return', 'throw']),
    };
    const connectionLiterals = new Set(['true', 'false', 'null', 'undefined', 'True', 'False', 'None']);

    function isCodeWordStart(char) {
      if (!char) return false;
      const code = char.charCodeAt(0);
      return char === '_' || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    }

    function isCodeWordPart(char) {
      if (!char) return false;
      const code = char.charCodeAt(0);
      return isCodeWordStart(char) || (code >= 48 && code <= 57);
    }

    function appendCodeToken(fragment, value, kind) {
      if (!value) return;
      if (!kind) {
        fragment.append(document.createTextNode(value));
        return;
      }
      const span = document.createElement('span');
      span.className = 'tok-' + kind;
      span.textContent = value;
      fragment.append(span);
    }

    function highlightConnectionCode(target, source, language) {
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      let plainStart = 0;
      const flushPlain = end => {
        appendCodeToken(fragment, source.slice(plainStart, end));
      };
      const addToken = (end, kind) => {
        flushPlain(cursor);
        appendCodeToken(fragment, source.slice(cursor, end), kind);
        cursor = end;
        plainStart = end;
      };

      while (cursor < source.length) {
        const char = source[cursor];
        const next = source[cursor + 1];

        if (language === 'php' && source.startsWith('<?php', cursor)) {
          addToken(cursor + 5, 'keyword');
          continue;
        }
        if ((char === '#' && language !== 'node') || (char === '/' && next === '/' && (language === 'node' || language === 'php'))) {
          let end = cursor + (char === '/' ? 2 : 1);
          while (end < source.length && source.charCodeAt(end) !== 10) end += 1;
          addToken(end, 'comment');
          continue;
        }
        if (char === "'" || char === '"' || (language === 'node' && char.charCodeAt(0) === 96)) {
          let end = cursor + 1;
          while (end < source.length) {
            if (source.charCodeAt(end) === 92) end += 2;
            else if (source[end] === char) { end += 1; break; }
            else end += 1;
          }
          addToken(Math.min(end, source.length), 'string');
          continue;
        }
        if (char === '$' && (language === 'rest' || language === 'php')) {
          let end = cursor + 1;
          while (isCodeWordPart(source[end])) end += 1;
          addToken(end, 'variable');
          continue;
        }
        if (language === 'rest' && char === '-' && (next === '-' || isCodeWordStart(next))) {
          let end = cursor + 1;
          while (source[end] === '-' || isCodeWordPart(source[end])) end += 1;
          addToken(end, 'keyword');
          continue;
        }
        if (char >= '0' && char <= '9') {
          let end = cursor + 1;
          while ((source[end] >= '0' && source[end] <= '9') || source[end] === '.') end += 1;
          addToken(end, 'number');
          continue;
        }
        if (isCodeWordStart(char)) {
          let end = cursor + 1;
          while (isCodeWordPart(source[end])) end += 1;
          const word = source.slice(cursor, end);
          let lookahead = end;
          while (source[lookahead] === ' ' || source.charCodeAt(lookahead) === 10) lookahead += 1;
          let kind = '';
          if (connectionKeywords[language].has(word)) kind = 'keyword';
          else if (connectionLiterals.has(word)) kind = 'literal';
          else if (source[lookahead] === '(') kind = 'function';
          if (kind) addToken(end, kind);
          else cursor = end;
          continue;
        }
        const operator = source.slice(cursor, cursor + 2);
        if (['=>', '->', '::', '?:'].includes(operator)) {
          addToken(cursor + 2, 'operator');
          continue;
        }
        cursor += 1;
      }
      flushPlain(source.length);
      target.replaceChildren(fragment);
    }

    function renderConnectionExample() {
      const session = selectedSession();
      const sessionId = session?.id || 'bs_your_session';
      connectionSessionId.textContent = session ? session.id : 'Select a browser';
      connectionSessionId.title = session ? session.id : '';
      highlightConnectionCode(connectionCode, connectionExamples(sessionId)[state.codeClient], state.codeClient);
      for (const tab of connectionTabs) tab.setAttribute('aria-selected', String(tab.dataset.codeClient === state.codeClient));
    }

    function formatDate(value) {
      if (!value) return 'Never';
      try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
      catch { return String(value); }
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
        title.textContent = browserName(session);
        const meta = document.createElement('div');
        meta.className = 'session-meta';
        meta.textContent = session.id;
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
      renameSessionBtn.disabled = !session || session.status === 'destroyed';
      viewerTitle.textContent = session ? browserName(session) + ' · ' + session.status : 'Browser preview';
      renderConnectionExample();
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

    function openRenameDialog() {
      const session = selectedSession();
      if (!session || session.status === 'destroyed') return;
      renameInput.value = session.display_name || '';
      renameDialog.showModal();
      renameInput.focus();
      renameInput.select();
    }

    async function saveBrowserName(event) {
      event.preventDefault();
      const session = selectedSession();
      if (!session) return;
      const saveButton = document.getElementById('saveRenameBtn');
      saveButton.disabled = true;
      try {
        const body = await api('/api/browser-sessions/' + encodeURIComponent(session.id), {
          method: 'PATCH',
          body: { display_name: renameInput.value.trim() || null },
        });
        state.sessions = state.sessions.map(item => item.id === body.browser_session.id ? body.browser_session : item);
        renameDialog.close();
        renderSessions();
        showMessage(sessionMessage, 'Browser name saved.');
      } catch (e) {
        showMessage(sessionMessage, e.message, true);
      } finally {
        saveButton.disabled = false;
      }
    }

    async function createSession() {
      createSessionBtn.disabled = true;
      showMessage(sessionMessage, 'Creating droplet...');
      try {
        const body = await api('/api/browser-sessions', {
          method: 'POST',
          body: { display_name: newSessionName.value.trim() || null },
        });
        state.selectedId = body.browser_session.id;
        newSessionName.value = '';
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

    function openDeleteDialog() {
      const session = selectedSession();
      if (!session || session.status === 'destroyed') return;
      state.deleteTargetId = session.id;
      deleteDialogDescription.textContent = 'This permanently destroys “' + browserName(session) + '” and cannot be undone.';
      deleteConfirmInput.value = '';
      confirmDeleteBtn.disabled = true;
      deleteDialog.showModal();
      deleteConfirmInput.focus();
    }

    async function deleteSession() {
      const session = state.sessions.find(item => item.id === state.deleteTargetId);
      if (!session || deleteConfirmInput.value !== 'I confirm') return;
      deleteSessionBtn.disabled = true;
      confirmDeleteBtn.disabled = true;
      showMessage(sessionMessage, 'Deleting session...');
      try {
        await api('/api/browser-sessions/' + encodeURIComponent(session.id), { method: 'DELETE' });
        deleteDialog.close();
        state.deleteTargetId = null;
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
        confirmDeleteBtn.disabled = deleteConfirmInput.value !== 'I confirm';
      }
    }

    function renderApiKeys() {
      apiKeysList.innerHTML = '';
      if (!state.apiKeys.length) {
        apiKeysList.innerHTML = '<div class="empty empty-small">No API keys yet.</div>';
        return;
      }
      for (const key of state.apiKeys) {
        const row = document.createElement('div');
        row.className = 'api-key-item';
        const details = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'api-key-name';
        name.textContent = key.name;
        const meta = document.createElement('div');
        meta.className = 'api-key-meta';
        meta.textContent = 'wbp_' + key.prefix + '_… · Created ' + formatDate(key.created_at) + ' · Last used ' + formatDate(key.last_used_at);
        details.append(name, meta);
        const actions = document.createElement('div');
        actions.className = 'api-key-actions';
        const stateLabel = document.createElement('span');
        stateLabel.className = 'api-key-state' + (key.revoked_at ? ' revoked' : '');
        stateLabel.textContent = key.revoked_at ? 'Revoked ' + formatDate(key.revoked_at) : 'Active';
        actions.appendChild(stateLabel);
        if (!key.revoked_at) {
          const revokeButton = document.createElement('button');
          revokeButton.type = 'button';
          revokeButton.className = 'danger';
          revokeButton.textContent = 'Revoke';
          revokeButton.addEventListener('click', () => revokeApiKey(key));
          actions.appendChild(revokeButton);
        }
        row.append(details, actions);
        apiKeysList.appendChild(row);
      }
    }

    async function loadApiKeys() {
      const body = await api('/api/api-keys');
      state.apiKeys = body.api_keys || [];
      renderApiKeys();
    }

    async function revokeApiKey(key) {
      if (!confirm('Revoke API key “' + key.name + '”? Applications using it will stop working.')) return;
      try {
        await api('/api/api-keys/' + encodeURIComponent(key.id), { method: 'DELETE' });
        await loadApiKeys();
        showMessage(apiKeyMessage, 'API key revoked.');
      } catch (e) {
        showMessage(apiKeyMessage, e.message, true);
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
        await loadApiKeys();
      } catch (e) {
        showMessage(apiKeyMessage, e.message, true);
      } finally {
        createApiKeyBtn.disabled = false;
      }
    }

    createSessionBtn.addEventListener('click', createSession);
    newSessionName.addEventListener('keydown', event => {
      if (event.key === 'Enter') createSession();
    });
    collapseSessionsBtn.addEventListener('click', () => setSessionsCollapsed(!sessionPanel.classList.contains('is-collapsed')));
    toggleDestroyedBtn.addEventListener('click', () => {
      state.showDestroyed = !state.showDestroyed;
      renderSessions();
    });
    refreshBtn.addEventListener('click', async () => {
      const label = refreshBtn.querySelector('.account-action-label');
      refreshBtn.disabled = true;
      label.textContent = 'Refreshing…';
      try {
        await Promise.all([loadSessions(), loadApiKeys()]);
        accountMenu.removeAttribute('open');
      } catch (e) {
        showMessage(browserView.hidden ? apiKeyMessage : sessionMessage, e.message, true);
      } finally {
        refreshBtn.disabled = false;
        label.textContent = 'Refresh dashboard';
      }
    });
    document.addEventListener('click', event => {
      if (accountMenu.open && !accountMenu.contains(event.target)) accountMenu.removeAttribute('open');
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && accountMenu.open) {
        accountMenu.removeAttribute('open');
        accountMenu.querySelector('summary').focus();
      }
    });
    connectBtn.addEventListener('click', openNoVnc);
    renameSessionBtn.addEventListener('click', openRenameDialog);
    renameForm.addEventListener('submit', saveBrowserName);
    cancelRenameBtn.addEventListener('click', () => renameDialog.close());
    deleteSessionBtn.addEventListener('click', openDeleteDialog);
    deleteConfirmInput.addEventListener('input', () => {
      confirmDeleteBtn.disabled = deleteConfirmInput.value !== 'I confirm';
    });
    cancelDeleteBtn.addEventListener('click', () => deleteDialog.close());
    confirmDeleteBtn.addEventListener('click', deleteSession);
    deleteDialog.addEventListener('close', () => {
      state.deleteTargetId = null;
      deleteConfirmInput.value = '';
      confirmDeleteBtn.disabled = true;
    });
    createApiKeyBtn.addEventListener('click', createApiKey);
    for (const link of viewLinks) {
      link.addEventListener('click', event => {
        event.preventDefault();
        setDashboardView(link.dataset.viewTarget, true);
      });
    }
    for (const tab of connectionTabs) {
      tab.addEventListener('click', () => {
        state.codeClient = tab.dataset.codeClient;
        renderConnectionExample();
      });
    }
    copyConnectionCode.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(connectionCode.textContent);
        copyConnectionCode.textContent = 'Copied';
        connectionNote.textContent = 'Code copied to your clipboard.';
        setTimeout(() => {
          copyConnectionCode.textContent = 'Copy';
          connectionNote.textContent = 'Examples use the selected session ID and WEBBRAIN_API_KEY.';
        }, 1800);
      } catch {
        connectionNote.textContent = 'Copy failed. Select the code and copy it manually.';
      }
    });
    window.addEventListener('hashchange', () => setDashboardView(location.hash === '#api-keys' ? 'api-keys' : 'browsers', false));
    setDashboardView(location.hash === '#api-keys' ? 'api-keys' : 'browsers', false);
    loadSessions().catch(e => showMessage(sessionMessage, e.message, true));
    loadApiKeys().catch(e => showMessage(apiKeyMessage, e.message, true));
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
        const keyHash = hashToken(rawKey);
        let apiKey = null;
        for (const prefix of apiKeyPrefixCandidates(rawKey)) {
          apiKey = await store.findApiKey(prefix, keyHash);
          if (apiKey) break;
        }
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

  app.get('/docs', (req, res) => {
    res.type('html').send(docsPage());
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
      revoked_at: k.revoked_at || null,
      created_at: k.created_at,
    })) });
  });

  app.post('/api/api-keys', requireAuth, async (req, res) => {
    const prefix = hashToken(randomSecret(16)).slice(0, 8);
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
        display_name: normalizeBrowserDisplayName(req.body.display_name ?? req.body.name),
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

  app.patch('/api/browser-sessions/:sessionId', requireAuth, async (req, res, next) => {
    try {
      const session = await ownedBrowserSession(req, res);
      if (!session) return;
      const displayName = normalizeBrowserDisplayName(req.body.display_name ?? req.body.name);
      const updated = await store.updateBrowserSession(session.id, {
        display_name: displayName,
        updated_at: nowIso(),
      });
      await audit(req, 'browser_session.rename', 'browser_session', session.id, { display_name: displayName });
      res.json({ browser_session: publicBrowserSession(updated) });
    } catch (e) {
      next(e);
    }
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
