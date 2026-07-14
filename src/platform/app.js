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

function normalizeAccountEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Object.assign(new Error('Enter a valid email address'), { status: 400 });
  }
  return email;
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

function loginPage(error = '', registrationEnabled = false) {
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
    .register-form[aria-disabled="true"] { opacity: .72; }
    .register-form[aria-disabled="true"] input, .register-form[aria-disabled="true"] button { cursor: not-allowed; }
    .register-form[aria-disabled="true"] button, .register-form[aria-disabled="true"] button:hover { background: transparent; border-color: var(--border); color: var(--text-dim); transform: none; }
    .registration-note { margin: 0; color: var(--text-dim); font-size: 12px; }
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
      <form class="register-form" method="post" action="/auth/register" aria-disabled="${String(!registrationEnabled)}">
        <strong>New to WebBrain Cloud?</strong>
        <input required type="email" name="email" placeholder="Email"${registrationEnabled ? '' : ' disabled'}>
        <input required minlength="8" type="password" name="password" placeholder="Password"${registrationEnabled ? '' : ' disabled'}>
        <button type="submit"${registrationEnabled ? '' : ' disabled'}>Create account</button>
        ${registrationEnabled ? '' : '<p class="registration-note">Registration is currently closed.</p>'}
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
    button.account-action.edit-account-action svg { color: var(--accent); }
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
    button, input, select, textarea { font: inherit; }
    button { min-height: 34px; padding: 6px 10px; border-radius: 7px; border: 1px solid var(--accent); background: var(--accent); color: #fff; font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap; box-shadow: 0 5px 14px var(--accent-glow); transition: transform .15s ease, background .15s ease, border-color .15s ease; }
    button:hover { background: #5047dc; transform: translateY(-1px); }
    button.secondary { background: rgba(255,253,248,.65); color: var(--text); border-color: var(--border); box-shadow: none; }
    button.secondary:hover { background: var(--card-hover); }
    button.danger { background: transparent; border-color: rgba(164,59,50,.28); color: var(--danger); box-shadow: none; }
    button.danger:hover { background: rgba(164,59,50,.08); }
    button:disabled { opacity: .48; cursor: not-allowed; transform: none; }
    button:focus-visible, .button-link:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, a:focus-visible { outline: 3px solid var(--accent-glow); outline-offset: 2px; }
    .button-link { min-height: 34px; display: inline-flex; align-items: center; padding: 6px 10px; border-radius: 7px; border: 1px solid var(--border); background: rgba(255,253,248,.65); color: var(--text); font-size: 12px; font-weight: 600; text-decoration: none; white-space: nowrap; }
    .button-link:hover { background: var(--card-hover); }
    input, select, textarea { min-height: 36px; border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; background: rgba(89,55,25,.04); color: var(--text); }
    input::placeholder, textarea::placeholder { color: #8a7964; }
    select { width: 100%; background-color: rgba(89,55,25,.04); }
    textarea { width: 100%; resize: vertical; }
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
    .viewer-frames { min-height: 640px; display: none; }
    iframe { width: 100%; height: 640px; display: none; border: 0; background: #0b0e17; border-radius: 0 0 16px 16px; }
    .empty { min-height: 640px; display: grid; place-items: center; color: var(--text-dim); text-align: center; padding: 20px; }
    .viewer-state { min-height: 640px; display: grid; place-items: center; padding: 32px 20px; color: var(--text-dim); text-align: center; }
    .viewer-state-content { max-width: 380px; display: grid; justify-items: center; }
    .viewer-state h3 { margin: 0; color: var(--text); font-size: 21px; letter-spacing: -.02em; }
    .viewer-state p { max-width: 340px; margin: 8px 0 0; font-size: 13px; line-height: 1.6; }
    .browser-boot { position: relative; width: 92px; height: 68px; margin-bottom: 24px; overflow: hidden; border: 1px solid rgba(91,82,232,.30); border-radius: 13px; background: #211812; box-shadow: 0 18px 40px rgba(91,82,232,.16); }
    .browser-boot::before { content: ''; position: absolute; inset: 0 0 auto; height: 18px; border-bottom: 1px solid rgba(248,234,211,.12); background: rgba(255,255,255,.035); }
    .browser-boot-dots, .browser-boot-dots::before, .browser-boot-dots::after { position: absolute; top: 7px; width: 4px; height: 4px; border-radius: 50%; background: #8b7d70; }
    .browser-boot-dots { left: 10px; }
    .browser-boot-dots::before, .browser-boot-dots::after { content: ''; top: 0; }
    .browser-boot-dots::before { left: 8px; }
    .browser-boot-dots::after { left: 16px; }
    .browser-boot-track { position: absolute; right: 15px; bottom: 19px; left: 15px; height: 4px; overflow: hidden; border-radius: 999px; background: rgba(248,234,211,.12); }
    .browser-boot-track::after { content: ''; position: absolute; width: 42%; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--accent), #a78bfa); box-shadow: 0 0 12px var(--accent); animation: browser-boot 1.25s ease-in-out infinite; }
    .viewer-state.is-ready .browser-boot { border-color: rgba(45,136,102,.34); box-shadow: 0 18px 40px rgba(45,136,102,.13); }
    .viewer-state.is-ready .browser-boot-track { width: 10px; height: 10px; right: 14px; bottom: 13px; left: auto; overflow: visible; background: var(--success); box-shadow: 0 0 0 5px rgba(45,136,102,.12); }
    .viewer-state.is-ready .browser-boot-track::after { display: none; }
    .viewer-connect-primary { min-height: 48px; margin-top: 20px; padding: 10px 24px; border-radius: 10px; font-size: 14px; box-shadow: 0 10px 26px var(--accent-glow); }
    @keyframes browser-boot { from { transform: translateX(-115%); } to { transform: translateX(245%); } }
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
    .console-grid { display: grid; grid-template-columns: minmax(310px, .86fr) minmax(0, 1.14fr); gap: 18px; align-items: stretch; }
    .console-grid > .panel { min-width: 0; }
    .console-form { display: grid; gap: 16px; }
    .form-field { display: grid; gap: 6px; }
    .form-label { color: var(--text); font-size: 12px; font-weight: 750; }
    .field-hint { min-height: 18px; color: var(--text-dim); font-size: 11px; }
    .field-hint.is-ready { color: var(--success); }
    .console-task { min-height: 156px; padding: 11px 12px; line-height: 1.55; }
    .console-action-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .console-action-row .message { flex: 1; margin: 0; }
    .execute-button { min-height: 42px; padding: 8px 18px; border-radius: 9px; }
    .async-notice { position: relative; margin-top: 16px; padding: 12px 13px 12px 39px; overflow: hidden; border: 1px solid rgba(91,82,232,.20); border-radius: 10px; background: rgba(91,82,232,.055); }
    .async-notice::before { content: ''; position: absolute; top: 0; bottom: 0; left: 0; width: 3px; background: var(--accent); }
    .async-notice-dot { position: absolute; top: 17px; left: 18px; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 5px rgba(91,82,232,.12); }
    .async-notice strong { display: block; margin-bottom: 2px; font-size: 12px; }
    .async-notice p { margin: 0; color: var(--text-dim); font-size: 11px; line-height: 1.55; }
    .async-notice a { color: var(--accent); font-weight: 750; }
    .run-panel .panel-body { min-height: 330px; }
    .run-empty { min-height: 296px; display: grid; place-items: center; padding: 28px; border: 1px dashed var(--border); border-radius: 11px; color: var(--text-dim); text-align: center; }
    .run-empty strong { display: block; margin-bottom: 4px; color: var(--text); font-size: 14px; }
    .run-state { display: grid; gap: 15px; }
    .run-status-line { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding-bottom: 13px; border-bottom: 1px solid var(--border); }
    .run-status-title { min-width: 0; display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 800; }
    .run-spinner { width: 16px; height: 16px; flex: 0 0 16px; border: 2px solid rgba(91,82,232,.18); border-top-color: var(--accent); border-radius: 50%; animation: run-spin .8s linear infinite; }
    .run-status-badge { min-height: 24px; display: inline-flex; align-items: center; padding: 0 8px; border-radius: 999px; background: rgba(91,82,232,.09); color: var(--accent); font-size: 10px; font-weight: 850; letter-spacing: .06em; text-transform: uppercase; }
    .run-status-badge.completed { background: rgba(45,136,102,.10); color: var(--success); }
    .run-status-badge.failed, .run-status-badge.aborted { background: rgba(164,59,50,.09); color: var(--danger); }
    .run-meta { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 10px; }
    .run-meta-item { min-width: 0; padding: 9px 10px; border-radius: 8px; background: rgba(89,55,25,.035); }
    .run-meta-label { display: block; margin-bottom: 2px; color: var(--text-dim); font-size: 9px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .run-meta-value { display: block; overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    .run-section { display: grid; gap: 6px; }
    .run-section-title { color: var(--text-dim); font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .run-summary { margin: 0; color: var(--text); font-size: 13px; white-space: pre-wrap; }
    .run-conclusion { display: grid; gap: 8px; padding: 14px; border: 1px solid rgba(45,136,102,.20); border-radius: 11px; background: rgba(45,136,102,.055); }
    .run-conclusion.is-error { border-color: rgba(164,59,50,.22); background: rgba(164,59,50,.045); }
    .run-conclusion-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .run-conclusion-title { color: var(--success); font-size: 11px; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; }
    .run-conclusion.is-error .run-conclusion-title { color: var(--danger); }
    .run-conclusion-summary { margin: 0; color: var(--text-dim); font-size: 12px; line-height: 1.55; white-space: pre-wrap; }
    .run-answer { margin: 0; color: var(--text); font-size: 14px; line-height: 1.68; white-space: pre-wrap; overflow-wrap: anywhere; }
    .run-output { margin: 0; padding: 13px; border-radius: 9px; background: #211812; color: #f8ead3; font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .run-error { margin: 0; color: var(--danger); font-size: 13px; white-space: pre-wrap; }
    .run-final-url { min-width: 0; overflow: hidden; color: var(--accent); font-size: 12px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
    .run-progress-shell { min-width: 0; display: grid; gap: 7px; }
    .run-progress-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .run-progress-tools { display: flex; align-items: center; gap: 8px; }
    .run-progress-count { color: var(--text-dim); font: 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .run-progress-toggle { min-height: 27px; padding: 3px 8px; border-color: var(--border); background: rgba(255,253,248,.72); color: var(--text-dim); box-shadow: none; font-size: 10px; }
    .run-progress-toggle:hover { background: var(--card-hover); color: var(--text); }
    .run-progress-log { position: relative; padding: 12px 12px 12px 10px; border: 1px solid var(--border); border-radius: 10px; background: rgba(89,55,25,.022); }
    .run-progress-log::before { content: ''; position: absolute; top: 17px; bottom: 17px; left: 21px; width: 1px; background: linear-gradient(var(--accent), rgba(91,82,232,.10)); }
    .run-progress-empty { position: relative; padding: 16px 14px 16px 35px; color: var(--text-dim); font-size: 12px; }
    .run-progress-omission { position: relative; padding: 6px 4px 8px 35px; color: var(--text-dim); font-size: 10px; font-style: italic; }
    .run-event { position: relative; min-width: 0; padding: 7px 4px 10px 35px; }
    .run-event + .run-event { border-top: 1px solid rgba(91,82,232,.075); }
    .run-event-node { position: absolute; top: 13px; left: 6px; z-index: 1; width: 11px; height: 11px; border: 3px solid var(--card); border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 1px rgba(91,82,232,.22); }
    .run-event.is-success .run-event-node { background: var(--success); box-shadow: 0 0 0 1px rgba(45,136,102,.24); }
    .run-event.is-warning .run-event-node { background: #b56b22; box-shadow: 0 0 0 1px rgba(181,107,34,.26); }
    .run-event.is-error .run-event-node { background: var(--danger); box-shadow: 0 0 0 1px rgba(164,59,50,.24); }
    .run-event-head { min-width: 0; display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
    .run-event-title { min-width: 0; color: var(--text); font-size: 12px; font-weight: 780; overflow-wrap: anywhere; }
    .run-event-time { flex: 0 0 auto; color: var(--text-dim); font: 9px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .run-event-kind { display: inline-flex; margin-right: 6px; padding: 2px 5px; border-radius: 5px; background: rgba(91,82,232,.08); color: var(--accent); font: 8px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; vertical-align: 1px; }
    .run-event.is-success .run-event-kind { background: rgba(45,136,102,.09); color: var(--success); }
    .run-event.is-warning .run-event-kind { background: rgba(181,107,34,.10); color: #9a5718; }
    .run-event.is-error .run-event-kind { background: rgba(164,59,50,.09); color: var(--danger); }
    .run-event-body { margin: 5px 0 0; color: var(--text-dim); font-size: 11px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
    .run-event-details { margin-top: 6px; border: 1px solid rgba(91,82,232,.13); border-radius: 7px; background: rgba(255,255,255,.36); }
    .run-event-details summary { padding: 6px 8px; color: var(--accent); cursor: pointer; font-size: 10px; font-weight: 750; user-select: none; }
    .run-event-details pre { margin: 0; padding: 9px; border-top: 1px solid rgba(91,82,232,.11); color: var(--text); font: 10px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .console-code-panel { margin-top: 18px; }
    .logs-grid { display: grid; grid-template-columns: minmax(340px, .78fr) minmax(0, 1.22fr); gap: 18px; align-items: start; }
    .logs-grid > .panel { min-width: 0; }
    .logs-filters { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 9px; margin-bottom: 12px; }
    .logs-filter { display: grid; gap: 4px; }
    .logs-filter span { color: var(--text-dim); font-size: 9px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .logs-list-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 9px; color: var(--text-dim); font-size: 11px; }
    .logs-list { min-height: 320px; max-height: calc(100vh - 320px); display: grid; align-content: start; gap: 8px; padding-right: 3px; overflow-y: auto; overscroll-behavior: contain; }
    .log-run { width: 100%; min-height: 0; display: grid; gap: 7px; padding: 11px 12px; border: 1px solid var(--border); border-radius: 10px; background: rgba(89,55,25,.025); color: var(--text); box-shadow: none; text-align: left; white-space: normal; }
    .log-run:hover { border-color: rgba(91,82,232,.28); background: var(--card-hover); transform: none; }
    .log-run.is-selected { border-color: var(--accent); background: rgba(91,82,232,.065); box-shadow: 0 0 0 1px rgba(91,82,232,.07); }
    .log-run-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .log-run-time { color: var(--text-dim); font: 10px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .log-run-task { display: -webkit-box; overflow: hidden; color: var(--text); font-size: 13px; font-weight: 720; line-height: 1.42; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
    .log-run-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--text-dim); font-size: 10px; }
    .log-run-browser { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .logs-empty { min-height: 260px; display: grid; place-items: center; padding: 28px; border: 1px dashed var(--border); border-radius: 11px; color: var(--text-dim); text-align: center; }
    .logs-empty strong { display: block; margin-bottom: 4px; color: var(--text); font-size: 14px; }
    .logs-load-more { width: 100%; margin-top: 10px; }
    .logs-detail-panel { scroll-margin-top: 86px; }
    .logs-detail-panel .panel-body { min-height: 420px; }
    @keyframes run-spin { to { transform: rotate(360deg); } }
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
    .account-dialog { width: min(520px, calc(100vw - 28px)); }
    .account-dialog .dialog-body { padding: 0; }
    .account-dialog-head { padding: 22px 22px 17px; border-bottom: 1px solid var(--border); }
    .account-dialog-head p { margin: 5px 0 0; }
    .account-form { display: grid; gap: 14px; padding: 19px 22px 22px; }
    .account-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .account-form .form-field input { min-height: 41px; }
    .account-verification { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 11px; padding: 12px; border: 1px solid rgba(91,82,232,.19); border-radius: 10px; background: rgba(91,82,232,.05); }
    .account-verification-icon { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 9px; background: rgba(91,82,232,.12); color: var(--accent); }
    .account-verification-icon svg { width: 17px; height: 17px; }
    .account-verification .form-field { min-width: 0; }
    .account-verification-copy { margin: 0 0 8px; color: var(--text-dim); font-size: 11px; line-height: 1.5; }
    .account-form .message { margin: 0; }
    .account-form .dialog-actions { margin-top: 0; }
    .confirm-phrase { padding: 2px 6px; border: 1px solid var(--border); border-radius: 5px; background: rgba(89,55,25,.05); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text); }
    @media (prefers-reduced-motion: reduce) {
      * { scroll-behavior: auto !important; transition: none !important; }
      .browser-boot-track::after { width: 54%; animation: none; transform: translateX(55%); }
      .run-spinner { animation: none; border-color: var(--accent); }
    }
    @media (max-width: 900px) {
      .nav-inner { padding-inline: 14px; }
      main { padding: 24px 14px 36px; }
      .page-intro { align-items: start; flex-direction: column; }
      .grid, .grid.sessions-collapsed { grid-template-columns: 1fr; gap: 18px; }
      .console-grid { grid-template-columns: 1fr; }
      .logs-grid { grid-template-columns: 1fr; }
      .logs-detail-panel { order: -1; }
      .logs-list { min-height: 0; max-height: none; padding-right: 0; overflow: visible; }
      .collapse-sessions { display: none; }
      .session-panel.is-collapsed { min-height: 0; }
      .session-panel.is-collapsed .panel-head { height: auto; padding: 15px 16px 13px; border-bottom: 1px solid var(--border); }
      .session-panel.is-collapsed .session-heading { flex-direction: row; justify-content: space-between; }
      .session-panel.is-collapsed .session-heading > div:first-child, .session-panel.is-collapsed #sessionCount { display: block !important; }
      .session-panel.is-collapsed .session-panel-actions { order: 0; display: flex; flex-direction: row; }
      .session-panel.is-collapsed .panel-body { display: block; }
      .session-panel.is-collapsed .status { min-width: auto; padding: 0 8px; }
      iframe, .empty, .viewer-state, .viewer-frames { height: 520px; min-height: 520px; }
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
      .console-action-row { align-items: stretch; flex-direction: column; }
      .execute-button { width: 100%; }
      .run-meta { grid-template-columns: 1fr; }
      .logs-filters { grid-template-columns: 1fr; }
      .account-form-grid { grid-template-columns: 1fr; }
      .api-panel .panel-head { align-items: stretch; flex-direction: column; }
      .connection-head { align-items: stretch; flex-direction: column; }
      .connection-session { max-width: 100%; }
      .code-footer { align-items: stretch; flex-direction: column; }
      .code-actions > * { flex: 1; justify-content: center; }
      .docs-link { justify-content: center; }
    }
    @media (max-width: 420px) {
      .brand-name { display: none; }
      .header-link { padding-inline: 7px; }
    }
  </style>
</head>
<body>
  <div class="glow-bg" aria-hidden="true"></div>
  <nav>
    <div class="nav-inner">
      <a class="brand" href="https://webbrain.one/">
        <img src="https://webbrain.one/logo-github.png" alt=""><span class="brand-name">WebBrain</span><span class="brand-domain">.cloud</span>
      </a>
      <div class="account">
        <div class="header-nav" aria-label="Dashboard sections">
          <a class="header-link" href="#browsers" data-view-target="browsers" aria-current="page">Browsers</a>
          <a class="header-link" href="#console" data-view-target="console">Console</a>
          <a class="header-link" href="#api-keys" data-view-target="api-keys">API keys</a>
          <a class="header-link" href="#logs" data-view-target="logs">Logs</a>
        </div>
        <details class="account-menu" id="accountMenu">
          <summary class="account-summary" aria-label="Account menu for ${escapeHtml(user.email)}">
            <span class="account-avatar" id="accountAvatar" aria-hidden="true">${escapeHtml(String(user.email).trim().slice(0, 1) || 'W')}</span>
            <span class="account-summary-email" id="accountSummaryEmail">${escapeHtml(user.email)}</span>
            <span class="account-caret" aria-hidden="true"></span>
          </summary>
          <div class="account-popover">
            <div class="account-context">
              <span class="account-context-label">Signed in as</span>
              <span class="account-context-email" id="accountContextEmail">${escapeHtml(user.email)}</span>
            </div>
            <button class="account-action edit-account-action" id="editAccountBtn" type="button">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>
              <span>Edit account</span>
            </button>
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
            <div id="viewerEmpty" class="viewer-state" aria-live="polite">
              <div class="viewer-state-content">
                <div class="browser-boot" id="viewerStateVisual" aria-hidden="true" style="display:none">
                  <span class="browser-boot-dots"></span>
                  <span class="browser-boot-track"></span>
                </div>
                <h3 id="viewerStateTitle">Select a browser</h3>
                <p id="viewerStateDescription">Choose a browser session to preview it here.</p>
                <button class="viewer-connect-primary" id="viewerConnectBtn" type="button" style="display:none">Connect</button>
              </div>
            </div>
            <div class="viewer-frames" id="viewerFrames"></div>
          </section>
        </div>
      </div>
    </section>
    <section class="dashboard-view" id="consoleView" hidden>
      <section class="page-intro">
        <div>
          <p class="eyebrow">Run workspace</p>
          <h1>Console</h1>
        </div>
        <p class="intro-copy">Send a task to one of your browsers, follow its progress, and reuse the exact request in your own code.</p>
      </section>
      <div class="console-grid">
        <section class="panel" aria-labelledby="consoleCommandTitle">
          <div class="panel-head">
            <div>
              <div class="panel-kicker">Command</div>
              <h2 id="consoleCommandTitle">Run a browser task</h2>
              <p class="api-description">Choose an existing browser and describe the outcome you want.</p>
            </div>
          </div>
          <div class="panel-body">
            <div class="console-form">
              <label class="form-field" for="consoleSessionSelect">
                <span class="form-label">Browser</span>
                <select id="consoleSessionSelect" aria-describedby="consoleSessionStatus"></select>
                <span class="field-hint" id="consoleSessionStatus">Loading your browsers…</span>
              </label>
              <label class="form-field" for="consoleTask">
                <span class="form-label">Task</span>
                <textarea class="console-task" id="consoleTask" placeholder="Open example.com and tell me the page title">Open example.com and tell me the page title</textarea>
              </label>
              <div class="console-action-row">
                <div class="message" id="consoleMessage" aria-live="polite"></div>
                <button class="execute-button" id="executeConsoleBtn" type="button">Execute task</button>
              </div>
            </div>
            <div class="async-notice">
              <span class="async-notice-dot" aria-hidden="true"></span>
              <strong>Runs are asynchronous</strong>
              <p>This console keeps checking the result if you switch away. Open <a href="#browsers" data-view-target="browsers">Browsers</a> to connect and watch the selected browser work.</p>
            </div>
          </div>
        </section>
        <section class="panel run-panel" aria-labelledby="consoleRunTitle">
          <div class="panel-head">
            <div>
              <div class="panel-kicker">Live run</div>
              <h2 id="consoleRunTitle">Result</h2>
              <p class="api-description">Progress continues even while this tab is hidden.</p>
            </div>
            <span class="status" id="consoleRunHeaderStatus">Idle</span>
          </div>
          <div class="panel-body" id="consoleRunOutput" aria-live="polite">
            <div class="run-empty"><div><strong>No run yet</strong>Choose a browser, enter a task, and execute it.</div></div>
          </div>
        </section>
      </div>
      <section class="panel connection-panel console-code-panel" aria-labelledby="consoleCodeTitle">
        <div class="panel-head connection-head">
          <div>
            <div class="panel-kicker">Use the same request from code</div>
            <h2 id="consoleCodeTitle">Exact API commands</h2>
            <p class="api-description">Examples update with the selected browser and task. They start asynchronously, then poll for the result.</p>
          </div>
          <span class="connection-session" id="consoleCodeSessionId">Select a browser</span>
        </div>
        <div class="panel-body">
          <div class="code-tabs" role="tablist" aria-label="Choose a language">
            <button class="code-tab" id="consoleCodeTabRest" type="button" role="tab" aria-selected="true" data-code-client="rest">REST</button>
            <button class="code-tab" type="button" role="tab" aria-selected="false" data-code-client="node">Node.js</button>
            <button class="code-tab" type="button" role="tab" aria-selected="false" data-code-client="python">Python</button>
            <button class="code-tab" type="button" role="tab" aria-selected="false" data-code-client="php">PHP</button>
          </div>
          <div class="code-shell">
            <pre aria-live="polite"><code id="consoleCode"></code></pre>
            <div class="code-footer">
              <span class="code-note" id="consoleCodeNote">REST uses <code>jq</code>. Examples use <code>WEBBRAIN_API_KEY</code> and the current Console values.</span>
              <div class="code-actions">
                <a class="button-link" href="#api-keys" data-view-target="api-keys">Get an API key</a>
                <a class="button-link" href="/docs">Full docs</a>
                <button id="copyConsoleCode" type="button">Copy</button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </section>
    <section class="dashboard-view" id="logsView" hidden>
      <section class="page-intro">
        <div>
          <p class="eyebrow">Run history</p>
          <h1>Logs</h1>
        </div>
        <p class="intro-copy">Review every browser run, reopen its result, and inspect the recorded execution trail.</p>
      </section>
      <div class="logs-grid">
        <section class="panel" aria-labelledby="logsListTitle">
          <div class="panel-head">
            <div>
              <div class="panel-kicker">Run ledger</div>
              <h2 id="logsListTitle">Historical runs</h2>
              <p class="api-description">Newest first. Load older entries whenever you need the full history.</p>
            </div>
            <button class="secondary" id="refreshLogsBtn" type="button">Refresh</button>
          </div>
          <div class="panel-body">
            <div class="logs-filters">
              <label class="logs-filter" for="logsBrowserFilter">
                <span>Browser</span>
                <select id="logsBrowserFilter"><option value="all">All browsers</option></select>
              </label>
              <label class="logs-filter" for="logsStatusFilter">
                <span>Status</span>
                <select id="logsStatusFilter">
                  <option value="all">All statuses</option>
                  <option value="running">Running</option>
                  <option value="completed">Completed</option>
                  <option value="failed">Failed</option>
                  <option value="aborted">Aborted</option>
                </select>
              </label>
            </div>
            <div class="logs-list-meta"><span id="logsCount">Loading runs…</span><span id="logsMessage" aria-live="polite"></span></div>
            <div class="logs-list" id="logsList"></div>
            <button class="secondary logs-load-more" id="loadOlderLogsBtn" type="button" hidden>Load older runs</button>
          </div>
        </section>
        <section class="panel logs-detail-panel" id="logsDetailPanel" aria-labelledby="logsDetailTitle">
          <div class="panel-head">
            <div>
              <div class="panel-kicker">Selected run</div>
              <h2 id="logsDetailTitle">Run details</h2>
              <p class="api-description">Results appear first; execution activity stays available below.</p>
            </div>
            <span class="status" id="logsDetailStatus">None</span>
          </div>
          <div class="panel-body" id="logsDetailOutput" aria-live="polite">
            <div class="logs-empty"><div><strong>Select a run</strong>Choose an entry from the ledger to reopen its result and activity.</div></div>
          </div>
        </section>
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
  <dialog class="account-dialog" id="accountDialog">
    <form class="dialog-body" id="accountForm">
      <div class="account-dialog-head">
        <h2>Edit account</h2>
        <p>Change your sign-in email, password, or both.</p>
      </div>
      <div class="account-form">
        <label class="form-field" for="accountEmail">
          <span class="form-label">Email address</span>
          <input id="accountEmail" type="email" autocomplete="email" maxlength="255" required value="${escapeHtml(user.email)}">
        </label>
        <div class="account-form-grid">
          <label class="form-field" for="accountNewPassword">
            <span class="form-label">New password</span>
            <input id="accountNewPassword" type="password" autocomplete="new-password" minlength="8" placeholder="Leave blank to keep it">
          </label>
          <label class="form-field" for="accountConfirmPassword">
            <span class="form-label">Confirm new password</span>
            <input id="accountConfirmPassword" type="password" autocomplete="new-password" minlength="8" placeholder="Repeat new password">
          </label>
        </div>
        <div class="account-verification">
          <span class="account-verification-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
          </span>
          <label class="form-field" for="accountCurrentPassword">
            <span class="form-label">Current password</span>
            <span class="account-verification-copy">Required to protect changes to your sign-in details.</span>
            <input id="accountCurrentPassword" type="password" autocomplete="current-password" required>
          </label>
        </div>
        <div class="message" id="accountMessage" aria-live="polite"></div>
        <div class="dialog-actions">
          <button class="secondary" type="button" id="cancelAccountBtn">Cancel</button>
          <button type="submit" id="saveAccountBtn">Save changes</button>
        </div>
      </div>
    </form>
  </dialog>
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
    const accountSummaryEmail = document.getElementById('accountSummaryEmail');
    const accountContextEmail = document.getElementById('accountContextEmail');
    const accountAvatar = document.getElementById('accountAvatar');
    const editAccountBtn = document.getElementById('editAccountBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const connectBtn = document.getElementById('connectBtn');
    const deleteSessionBtn = document.getElementById('deleteSessionBtn');
    const renameSessionBtn = document.getElementById('renameSessionBtn');
    const viewerTitle = document.getElementById('viewerTitle');
    const viewerEmpty = document.getElementById('viewerEmpty');
    const viewerStateVisual = document.getElementById('viewerStateVisual');
    const viewerStateTitle = document.getElementById('viewerStateTitle');
    const viewerStateDescription = document.getElementById('viewerStateDescription');
    const viewerConnectBtn = document.getElementById('viewerConnectBtn');
    const viewerFrames = document.getElementById('viewerFrames');
    const externalLink = document.getElementById('externalLink');
    const createApiKeyBtn = document.getElementById('createApiKeyBtn');
    const apiKeyName = document.getElementById('apiKeyName');
    const newApiKey = document.getElementById('newApiKey');
    const apiKeyMessage = document.getElementById('apiKeyMessage');
    const apiKeysList = document.getElementById('apiKeysList');
    const browserView = document.getElementById('browserView');
    const consoleView = document.getElementById('consoleView');
    const logsView = document.getElementById('logsView');
    const apiKeysView = document.getElementById('apiKeysView');
    const viewLinks = [...document.querySelectorAll('[data-view-target]')];
    const consoleSessionSelect = document.getElementById('consoleSessionSelect');
    const consoleSessionStatus = document.getElementById('consoleSessionStatus');
    const consoleTask = document.getElementById('consoleTask');
    const consoleMessage = document.getElementById('consoleMessage');
    const executeConsoleBtn = document.getElementById('executeConsoleBtn');
    const consoleRunHeaderStatus = document.getElementById('consoleRunHeaderStatus');
    const consoleRunOutput = document.getElementById('consoleRunOutput');
    const consoleCodeSessionId = document.getElementById('consoleCodeSessionId');
    const consoleCode = document.getElementById('consoleCode');
    const consoleCodeTabs = [...document.querySelectorAll('[data-code-client]')];
    const copyConsoleCode = document.getElementById('copyConsoleCode');
    const consoleCodeNote = document.getElementById('consoleCodeNote');
    const refreshLogsBtn = document.getElementById('refreshLogsBtn');
    const logsBrowserFilter = document.getElementById('logsBrowserFilter');
    const logsStatusFilter = document.getElementById('logsStatusFilter');
    const logsCount = document.getElementById('logsCount');
    const logsMessage = document.getElementById('logsMessage');
    const logsList = document.getElementById('logsList');
    const loadOlderLogsBtn = document.getElementById('loadOlderLogsBtn');
    const logsDetailPanel = document.getElementById('logsDetailPanel');
    const logsDetailStatus = document.getElementById('logsDetailStatus');
    const logsDetailOutput = document.getElementById('logsDetailOutput');
    const accountDialog = document.getElementById('accountDialog');
    const accountForm = document.getElementById('accountForm');
    const accountEmail = document.getElementById('accountEmail');
    const accountNewPassword = document.getElementById('accountNewPassword');
    const accountConfirmPassword = document.getElementById('accountConfirmPassword');
    const accountCurrentPassword = document.getElementById('accountCurrentPassword');
    const accountMessage = document.getElementById('accountMessage');
    const cancelAccountBtn = document.getElementById('cancelAccountBtn');
    const saveAccountBtn = document.getElementById('saveAccountBtn');
    const renameDialog = document.getElementById('renameDialog');
    const renameForm = document.getElementById('renameForm');
    const renameInput = document.getElementById('renameInput');
    const cancelRenameBtn = document.getElementById('cancelRenameBtn');
    const deleteDialog = document.getElementById('deleteDialog');
    const deleteDialogDescription = document.getElementById('deleteDialogDescription');
    const deleteConfirmInput = document.getElementById('deleteConfirmInput');
    const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
    const state = {
      sessions: [],
      apiKeys: [],
      selectedId: null,
      consoleSessionId: null,
      consoleRun: null,
      consoleRunSessionId: null,
      consoleRunTask: '',
      consoleProgressExpanded: false,
      runLogs: [],
      logsOffset: 0,
      logsHasMore: false,
      logsSelectedId: null,
      logsSelectedRun: null,
      logsDetailError: '',
      logsProgressExpanded: false,
      logsBrowserFilter: 'all',
      logsStatusFilter: 'all',
      showDestroyed: false,
      deleteTargetId: null,
      codeClient: 'rest',
    };
    const viewerConnections = new Map();
    const connectingSessionIds = new Set();
    const terminalRunStatuses = new Set(['completed', 'failed', 'aborted']);
    let consolePollTimer = null;
    const sessionsCollapsedKey = 'webbrain.sessionsCollapsed';

    function setDashboardView(view, updateUrl) {
      const nextView = ['api-keys', 'console', 'logs'].includes(view) ? view : 'browsers';
      browserView.hidden = nextView !== 'browsers';
      consoleView.hidden = nextView !== 'console';
      logsView.hidden = nextView !== 'logs';
      apiKeysView.hidden = nextView !== 'api-keys';
      for (const link of viewLinks) {
        if (link.dataset.viewTarget === nextView) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
      if (updateUrl) history.pushState(null, '', '#' + nextView);
      if (nextView === 'api-keys') loadApiKeys().catch(e => showMessage(apiKeyMessage, e.message, true));
      if (nextView === 'console') renderConsole();
      if (nextView === 'logs') loadRunLogs({ reset: true }).catch(e => {
        logsMessage.textContent = e.message;
      });
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

    function openAccountDialog() {
      accountMenu.removeAttribute('open');
      accountEmail.value = accountContextEmail.textContent.trim();
      accountNewPassword.value = '';
      accountConfirmPassword.value = '';
      accountCurrentPassword.value = '';
      accountConfirmPassword.setCustomValidity('');
      showMessage(accountMessage, '');
      accountDialog.showModal();
      accountEmail.focus();
    }

    async function saveAccount(event) {
      event.preventDefault();
      const newPassword = accountNewPassword.value;
      accountConfirmPassword.setCustomValidity(
        newPassword === accountConfirmPassword.value ? '' : 'New passwords do not match'
      );
      if (!accountForm.reportValidity()) return;
      saveAccountBtn.disabled = true;
      saveAccountBtn.textContent = 'Saving…';
      showMessage(accountMessage, 'Saving account changes…');
      try {
        const body = await api('/api/me', {
          method: 'PATCH',
          body: {
            email: accountEmail.value,
            current_password: accountCurrentPassword.value,
            new_password: newPassword || undefined,
          },
        });
        const email = body.user.email;
        accountSummaryEmail.textContent = email;
        accountContextEmail.textContent = email;
        accountAvatar.textContent = email.slice(0, 1) || 'W';
        accountMenu.querySelector('summary').setAttribute('aria-label', 'Account menu for ' + email);
        accountEmail.value = email;
        accountNewPassword.value = '';
        accountConfirmPassword.value = '';
        accountCurrentPassword.value = '';
        const sessionNote = body.other_sessions_revoked
          ? ' Other signed-in sessions were logged out.'
          : '';
        showMessage(accountMessage, 'Account updated.' + sessionNote);
      } catch (error) {
        showMessage(accountMessage, error.message, true);
      } finally {
        saveAccountBtn.disabled = false;
        saveAccountBtn.textContent = 'Save changes';
      }
    }

    function selectedSession() {
      return state.sessions.find(s => s.id === state.selectedId) || null;
    }

    function browserName(session) {
      return session?.display_name || ('Browser ' + String(session?.id || '').slice(-4).toUpperCase());
    }

    function shellDoubleQuoted(value) {
      const slash = String.fromCharCode(92);
      return '"' + String(value)
        .split(slash).join(slash + slash)
        .split('"').join(slash + '"')
        .split('$').join(slash + '$')
        .split(String.fromCharCode(96)).join(slash + String.fromCharCode(96)) + '"';
    }

    function phpSingleQuoted(value) {
      const slash = String.fromCharCode(92);
      const quote = "'";
      return quote + String(value)
        .split(slash).join(slash + slash)
        .split(quote).join(slash + quote) + quote;
    }

    function consoleExamples(sessionId, task) {
      const taskText = task || 'Open example.com and tell me the page title';
      const taskLiteral = JSON.stringify(taskText);
      const sessionLiteral = JSON.stringify(sessionId);
      const endpoint = 'https://webbrain.cloud/api/browser-sessions/' + sessionId + '/runs';
      const requestBody = shellDoubleQuoted(JSON.stringify({ task: taskText, wait: false }));
      return {
        rest: [
          'WEBBRAIN_RUN_ID=$(curl -sS -X POST "' + endpoint + '" -H "Authorization: Bearer $WEBBRAIN_API_KEY" -H "Content-Type: application/json" --data ' + requestBody + ' | jq -r .run_id)',
          '',
          '# Poll while the asynchronous run continues.',
          'while true; do',
          '  RUN=$(curl -sS "' + endpoint + '/$WEBBRAIN_RUN_ID" -H "Authorization: Bearer $WEBBRAIN_API_KEY")',
          '  echo "$RUN" | jq',
          '  STATUS=$(echo "$RUN" | jq -r .status)',
          '  case "$STATUS" in completed|failed|aborted) break ;; esac',
          '  sleep 1',
          'done',
        ].join(String.fromCharCode(10)),
        node: [
          "import { WebBrainClient } from './webbrain-client.js';",
          '',
          'const client = new WebBrainClient({',
          '  apiKey: process.env.WEBBRAIN_API_KEY,',
          '});',
          'let run = await client.createRun(' + sessionLiteral + ', {',
          '  task: ' + taskLiteral + ',',
          '  wait: false,',
          '});',
          "while (!['completed', 'failed', 'aborted'].includes(run.status)) {",
          '  await new Promise(resolve => setTimeout(resolve, 1000));',
          '  run = await client.getRun(' + sessionLiteral + ', run.run_id);',
          '}',
          'console.log(run.result);',
        ].join(String.fromCharCode(10)),
        python: [
          'import os',
          'import time',
          'from webbrain_client import WebBrainClient',
          '',
          "client = WebBrainClient(os.environ['WEBBRAIN_API_KEY'])",
          'run = client.create_run(' + sessionLiteral + ', ' + taskLiteral + ', wait=False)',
          "while run['status'] not in {'completed', 'failed', 'aborted'}:",
          '    time.sleep(1)',
          '    run = client.get_run(' + sessionLiteral + ", run['run_id'])",
          "print(run['result'])",
        ].join(String.fromCharCode(10)),
        php: [
          '<?php',
          "require_once __DIR__ . '/WebBrainClient.php';",
          '',
          "$client = new WebBrainClient(getenv('WEBBRAIN_API_KEY') ?: '');",
          '$run = $client->createRun(' + phpSingleQuoted(sessionId) + ', ' + phpSingleQuoted(taskText) + ", ['wait' => false]);",
          "$terminal = ['completed', 'failed', 'aborted'];",
          "while (!in_array($run['status'], $terminal, true)) {",
          '    sleep(1);',
          '    $run = $client->getRun(' + phpSingleQuoted(sessionId) + ", $run['run_id']);",
          '}',
          "print_r($run['result']);",
        ].join(String.fromCharCode(10)),
      };
    }

    const codeKeywords = {
      rest: new Set(['curl', 'while', 'do', 'done', 'case', 'in', 'esac', 'sleep']),
      node: new Set(['import', 'from', 'const', 'let', 'await', 'new', 'export', 'class', 'async', 'throw', 'return']),
      python: new Set(['import', 'from', 'as', 'class', 'def', 'return', 'raise', 'if', 'else', 'elif', 'while', 'for', 'in', 'with', 'try', 'except']),
      php: new Set(['<?php', 'require_once', 'new', 'function', 'public', 'private', 'class', 'final', 'return', 'throw', 'while']),
    };
    const codeLiterals = new Set(['true', 'false', 'null', 'undefined', 'True', 'False', 'None']);

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

    function highlightCode(target, source, language) {
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
          if (codeKeywords[language].has(word)) kind = 'keyword';
          else if (codeLiterals.has(word)) kind = 'literal';
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

    function renderConsoleCode() {
      const session = state.sessions.find(item => item.id === state.consoleSessionId) || null;
      const sessionId = session?.id || 'bs_your_session';
      const task = consoleTask.value.trim() || consoleTask.placeholder;
      consoleCodeSessionId.textContent = session ? session.id : 'Select a browser';
      consoleCodeSessionId.title = session ? session.id : '';
      highlightCode(consoleCode, consoleExamples(sessionId, task)[state.codeClient], state.codeClient);
      for (const tab of consoleCodeTabs) tab.setAttribute('aria-selected', String(tab.dataset.codeClient === state.codeClient));
    }

    function formatDate(value) {
      if (!value) return 'Never';
      try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
      catch { return String(value); }
    }

    function consoleSelectedSession() {
      return state.sessions.find(session => session.id === state.consoleSessionId) || null;
    }

    function consoleRunIsActive() {
      return !!state.consoleRun && !terminalRunStatuses.has(state.consoleRun.status);
    }

    function renderConsoleBrowsers() {
      const sessions = state.sessions.filter(session => session.status !== 'destroyed');
      if (!state.consoleSessionId || !sessions.some(session => session.id === state.consoleSessionId)) {
        const preferred = sessions.find(session => session.id === state.selectedId && session.runtime_ready)
          || sessions.find(session => session.runtime_ready)
          || sessions[0];
        state.consoleSessionId = preferred?.id || null;
      }

      consoleSessionSelect.replaceChildren();
      if (!sessions.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No browser sessions';
        consoleSessionSelect.append(option);
      }
      for (const session of sessions) {
        const option = document.createElement('option');
        option.value = session.id;
        option.textContent = browserName(session) + ' · ' + (session.runtime_ready ? 'ready' : session.status);
        option.selected = session.id === state.consoleSessionId;
        consoleSessionSelect.append(option);
      }

      const session = consoleSelectedSession();
      const ready = !!session?.runtime_ready;
      consoleSessionSelect.disabled = !sessions.length;
      consoleSessionStatus.classList.toggle('is-ready', ready);
      if (!session) consoleSessionStatus.textContent = 'Create a browser in the Browsers tab first.';
      else if (ready) consoleSessionStatus.textContent = 'Ready to run · ' + session.id;
      else if (session.status === 'failed') consoleSessionStatus.textContent = 'This browser failed to start. Choose another browser.';
      else consoleSessionStatus.textContent = 'This browser is still preparing. Refresh or choose a ready browser.';
      executeConsoleBtn.disabled = !ready || !consoleTask.value.trim() || consoleRunIsActive();
    }

    function appendRunSection(parent, label, value, className) {
      if (value == null || value === '') return;
      const section = document.createElement('section');
      section.className = 'run-section';
      const title = document.createElement('div');
      title.className = 'run-section-title';
      title.textContent = label;
      const content = document.createElement(className === 'run-output' ? 'pre' : 'p');
      content.className = className;
      content.textContent = value;
      section.append(title, content);
      parent.append(section);
    }

    function safeHttpUrl(value) {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '';
      } catch {
        return '';
      }
    }

    function appendRunConclusion(parent, run) {
      const finalUrl = safeHttpUrl(run.final_url);
      const hasResult = run.result != null;
      const hasError = !!run.error;
      if (!hasResult && !hasError && !run.summary && !finalUrl) return false;

      const conclusion = document.createElement('section');
      conclusion.className = 'run-conclusion' + (hasError ? ' is-error' : '');
      const heading = document.createElement('div');
      heading.className = 'run-conclusion-heading';
      const title = document.createElement('div');
      title.className = 'run-conclusion-title';
      title.textContent = hasError ? 'Run error' : 'Result';
      heading.append(title);
      conclusion.append(heading);

      if (run.summary) {
        const summary = document.createElement('p');
        summary.className = 'run-conclusion-summary';
        summary.textContent = run.summary;
        conclusion.append(summary);
      }
      if (hasResult) {
        const structured = typeof run.result !== 'string';
        const result = document.createElement(structured ? 'pre' : 'p');
        result.className = structured ? 'run-output' : 'run-answer';
        result.textContent = structured ? runUpdatePayload(run.result) : run.result;
        conclusion.append(result);
      }
      if (hasError) {
        const error = document.createElement('p');
        error.className = 'run-error';
        error.textContent = run.error;
        conclusion.append(error);
      }
      if (finalUrl) {
        const link = document.createElement('a');
        link.className = 'run-final-url';
        link.href = finalUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = finalUrl;
        link.title = finalUrl;
        conclusion.append(link);
      }
      parent.append(conclusion);
      return true;
    }

    function runUpdateTime(value) {
      if (!value) return '—';
      try {
        return new Intl.DateTimeFormat(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }).format(new Date(value));
      } catch {
        return String(value);
      }
    }

    function runUpdatePayload(value) {
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value, null, 2); }
      catch { return String(value); }
    }

    function describeRunUpdate(update) {
      const type = String(update?.type || 'update');
      const data = update?.data || {};
      if (type === 'thinking') {
        return {
          kind: 'thinking',
          title: data.step
            ? 'Step ' + data.step + (data.note ? ' · ' + data.note : ' · Thinking')
            : (data.note || 'Thinking'),
          tone: '',
        };
      }
      if (type === 'text' || type === 'text_delta') {
        return {
          kind: type === 'text_delta' ? 'stream' : 'message',
          title: 'WebBrain',
          body: data.content || '',
          tone: '',
        };
      }
      if (type === 'tool_call') {
        return {
          kind: 'tool call',
          title: data.name || 'Tool',
          detailLabel: 'Arguments',
          detail: runUpdatePayload(data.args ?? {}),
          tone: '',
        };
      }
      if (type === 'tool_result') {
        const failed = !!(data.result && typeof data.result === 'object'
          && (data.result.error || data.result.success === false || data.result.cloudFailed));
        return {
          kind: failed ? 'failed' : 'result',
          title: data.name || 'Tool result',
          detailLabel: 'Result',
          detail: runUpdatePayload(data.result ?? null),
          tone: failed ? 'is-error' : 'is-success',
        };
      }
      if (type === 'error') {
        return { kind: 'error', title: 'Run error', body: data.message || runUpdatePayload(data), tone: 'is-error' };
      }
      if (type === 'warning' || type === 'max_steps_reached' || type === 'plan_review') {
        return {
          kind: type === 'max_steps_reached' ? 'limit' : 'warning',
          title: type === 'max_steps_reached' ? 'Maximum steps reached' : 'Run warning',
          body: data.message || data.note || runUpdatePayload(data),
          tone: 'is-warning',
        };
      }
      return {
        kind: type.replaceAll('_', ' '),
        title: 'Run update',
        detailLabel: 'Details',
        detail: runUpdatePayload(data),
        tone: '',
      };
    }

    function appendRunProgress(parent, updates, active, options = {}) {
      const expanded = options.expanded === true;
      const visibleLimit = 10;
      const hiddenCount = expanded ? 0 : Math.max(0, updates.length - visibleLimit);
      const visibleUpdates = hiddenCount ? updates.slice(-visibleLimit) : updates;
      const openSeqs = options.openSeqs || new Set();
      const shell = document.createElement('section');
      shell.className = 'run-progress-shell';
      const heading = document.createElement('div');
      heading.className = 'run-progress-heading';
      const title = document.createElement('div');
      title.className = 'run-section-title';
      title.textContent = active ? 'Live activity' : 'Activity';
      const tools = document.createElement('div');
      tools.className = 'run-progress-tools';
      const count = document.createElement('span');
      count.className = 'run-progress-count';
      count.textContent = updates.length + (updates.length === 1 ? ' event' : ' events');
      tools.append(count);
      if (updates.length > visibleLimit) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'run-progress-toggle';
        toggle.textContent = expanded ? 'Show recent' : 'Show all';
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.addEventListener('click', () => options.onToggle?.(!expanded));
        tools.append(toggle);
      }
      heading.append(title, tools);

      const log = document.createElement('div');
      log.className = 'run-progress-log';
      log.tabIndex = 0;
      log.setAttribute('aria-label', 'Live run progress');
      if (!updates.length) {
        const empty = document.createElement('div');
        empty.className = 'run-progress-empty';
        empty.textContent = active ? 'Waiting for the first progress update…' : 'No progress updates were recorded.';
        log.append(empty);
      }

      if (hiddenCount) {
        const omission = document.createElement('div');
        omission.className = 'run-progress-omission';
        omission.textContent = hiddenCount + ' earlier ' + (hiddenCount === 1 ? 'event' : 'events') + ' hidden';
        log.append(omission);
      }

      for (const update of visibleUpdates) {
        const description = describeRunUpdate(update);
        const event = document.createElement('article');
        event.className = 'run-event' + (description.tone ? ' ' + description.tone : '');
        const node = document.createElement('span');
        node.className = 'run-event-node';
        node.setAttribute('aria-hidden', 'true');
        const head = document.createElement('div');
        head.className = 'run-event-head';
        const eventTitle = document.createElement('div');
        eventTitle.className = 'run-event-title';
        const kind = document.createElement('span');
        kind.className = 'run-event-kind';
        kind.textContent = description.kind;
        eventTitle.append(kind, document.createTextNode(description.title));
        const time = document.createElement('time');
        time.className = 'run-event-time';
        time.dateTime = update.ts || '';
        time.textContent = runUpdateTime(update.ts);
        head.append(eventTitle, time);
        event.append(node, head);
        if (description.body) {
          const body = document.createElement('p');
          body.className = 'run-event-body';
          body.textContent = description.body;
          event.append(body);
        }
        if (description.detail) {
          const details = document.createElement('details');
          details.className = 'run-event-details';
          details.dataset.seq = String(update.seq ?? '');
          details.open = openSeqs.has(details.dataset.seq);
          const summary = document.createElement('summary');
          summary.textContent = description.detailLabel;
          const detail = document.createElement('pre');
          detail.textContent = description.detail;
          details.append(summary, detail);
          event.append(details);
        }
        log.append(event);
      }
      shell.append(heading, log);
      parent.append(shell);
    }

    function renderConsoleRun() {
      const run = state.consoleRun;
      const openSeqs = new Set([...consoleRunOutput.querySelectorAll('.run-event-details[open]')].map(item => item.dataset.seq));
      consoleRunOutput.replaceChildren();
      if (!run) {
        consoleRunHeaderStatus.textContent = 'Idle';
        const empty = document.createElement('div');
        empty.className = 'run-empty';
        const copy = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = 'No run yet';
        copy.append(title, document.createTextNode('Choose a browser, enter a task, and execute it.'));
        empty.append(copy);
        consoleRunOutput.append(empty);
        return;
      }

      const status = run.status || 'starting';
      const active = !terminalRunStatuses.has(status);
      const statusTitles = {
        starting: 'Starting the run',
        running: 'WebBrain is working',
        completed: 'Run completed',
        failed: 'Run failed',
        aborted: 'Run aborted',
      };
      consoleRunHeaderStatus.textContent = status;

      const content = document.createElement('div');
      content.className = 'run-state';
      const statusLine = document.createElement('div');
      statusLine.className = 'run-status-line';
      const statusTitle = document.createElement('div');
      statusTitle.className = 'run-status-title';
      if (active) {
        const spinner = document.createElement('span');
        spinner.className = 'run-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        statusTitle.append(spinner);
      }
      statusTitle.append(document.createTextNode(statusTitles[status] || ('Run ' + status)));
      const badge = document.createElement('span');
      badge.className = 'run-status-badge ' + status;
      badge.textContent = status;
      statusLine.append(statusTitle, badge);
      content.append(statusLine);

      const session = state.sessions.find(item => item.id === state.consoleRunSessionId);
      const meta = document.createElement('div');
      meta.className = 'run-meta';
      for (const [label, value] of [
        ['Browser', session ? browserName(session) : state.consoleRunSessionId],
        ['Run ID', run.run_id || 'Waiting for run ID…'],
      ]) {
        const item = document.createElement('div');
        item.className = 'run-meta-item';
        const itemLabel = document.createElement('span');
        itemLabel.className = 'run-meta-label';
        itemLabel.textContent = label;
        const itemValue = document.createElement('span');
        itemValue.className = 'run-meta-value';
        itemValue.textContent = value || '—';
        itemValue.title = value || '';
        item.append(itemLabel, itemValue);
        meta.append(item);
      }
      content.append(meta);

      const hasConclusion = appendRunConclusion(content, run);
      appendRunSection(content, 'Task', state.consoleRunTask, 'run-summary');
      appendRunProgress(content, Array.isArray(run.updates) ? run.updates : [], active, {
        expanded: state.consoleProgressExpanded,
        openSeqs,
        onToggle: expanded => {
          state.consoleProgressExpanded = expanded;
          renderConsoleRun();
        },
      });
      if (active && !hasConclusion) {
        appendRunSection(content, 'Result', 'Waiting for WebBrain to finish…', 'run-summary');
      }

      consoleRunOutput.append(content);
    }

    function renderConsole() {
      renderConsoleBrowsers();
      renderConsoleCode();
      renderConsoleRun();
    }

    function runLogBrowserName(run) {
      const session = state.sessions.find(item => item.id === run.session_id);
      return session ? browserName(session) : (run.session_id || 'Unknown browser');
    }

    function renderLogFilters() {
      const sessionIds = [...new Set(state.runLogs.map(run => run.session_id).filter(Boolean))];
      logsBrowserFilter.replaceChildren();
      const all = document.createElement('option');
      all.value = 'all';
      all.textContent = 'All browsers';
      logsBrowserFilter.append(all);
      for (const sessionId of sessionIds) {
        const run = state.runLogs.find(item => item.session_id === sessionId);
        const option = document.createElement('option');
        option.value = sessionId;
        option.textContent = runLogBrowserName(run);
        option.selected = state.logsBrowserFilter === sessionId;
        logsBrowserFilter.append(option);
      }
      logsBrowserFilter.value = sessionIds.includes(state.logsBrowserFilter) ? state.logsBrowserFilter : 'all';
      state.logsBrowserFilter = logsBrowserFilter.value;
      logsStatusFilter.value = state.logsStatusFilter;
    }

    function filteredRunLogs() {
      return state.runLogs.filter(run => (
        (state.logsBrowserFilter === 'all' || run.session_id === state.logsBrowserFilter)
        && (state.logsStatusFilter === 'all' || run.status === state.logsStatusFilter)
      ));
    }

    function renderRunLogs() {
      const runs = filteredRunLogs();
      logsList.replaceChildren();
      logsCount.textContent = runs.length + ' shown · ' + state.runLogs.length + ' loaded';
      loadOlderLogsBtn.hidden = !state.logsHasMore;
      if (!runs.length) {
        const empty = document.createElement('div');
        empty.className = 'logs-empty';
        const copy = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = state.runLogs.length ? 'No matching runs' : 'No runs yet';
        copy.append(title, document.createTextNode(state.runLogs.length
          ? 'Change the filters to see other historical runs.'
          : 'Runs started from Console or the API will appear here.'));
        empty.append(copy);
        logsList.append(empty);
        return;
      }

      for (const run of runs) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'log-run' + (run.run_id === state.logsSelectedId ? ' is-selected' : '');
        button.setAttribute('aria-pressed', String(run.run_id === state.logsSelectedId));
        const top = document.createElement('div');
        top.className = 'log-run-top';
        const time = document.createElement('time');
        time.className = 'log-run-time';
        time.dateTime = run.created_at || '';
        time.textContent = formatDate(run.created_at);
        const status = document.createElement('span');
        status.className = 'run-status-badge ' + run.status;
        status.textContent = run.status;
        top.append(time, status);
        const task = document.createElement('div');
        task.className = 'log-run-task';
        task.textContent = run.task || 'Untitled browser run';
        const meta = document.createElement('div');
        meta.className = 'log-run-meta';
        const browser = document.createElement('span');
        browser.className = 'log-run-browser';
        browser.textContent = runLogBrowserName(run);
        const events = document.createElement('span');
        events.textContent = run.update_count + (run.update_count === 1 ? ' event' : ' events');
        meta.append(browser, events);
        button.append(top, task, meta);
        button.addEventListener('click', () => selectRunLog(run));
        logsList.append(button);
      }
    }

    function renderLogsDetail() {
      const summary = state.runLogs.find(run => run.run_id === state.logsSelectedId);
      const run = state.logsSelectedRun;
      const openSeqs = new Set([...logsDetailOutput.querySelectorAll('.run-event-details[open]')].map(item => item.dataset.seq));
      logsDetailOutput.replaceChildren();
      if (!summary) {
        logsDetailStatus.textContent = 'None';
        const empty = document.createElement('div');
        empty.className = 'logs-empty';
        const copy = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = 'Select a run';
        copy.append(title, document.createTextNode('Choose an entry from the ledger to reopen its result and activity.'));
        empty.append(copy);
        logsDetailOutput.append(empty);
        return;
      }
      if (!run) {
        logsDetailStatus.textContent = state.logsDetailError ? 'Unavailable' : 'Loading';
        const empty = document.createElement('div');
        empty.className = 'logs-empty';
        const copy = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = state.logsDetailError ? 'Could not load this run' : 'Loading run';
        copy.append(title, document.createTextNode(state.logsDetailError || 'Fetching the recorded result and activity…'));
        empty.append(copy);
        logsDetailOutput.append(empty);
        return;
      }

      const status = run.status || summary.status;
      const active = !terminalRunStatuses.has(status);
      logsDetailStatus.textContent = status;
      const content = document.createElement('div');
      content.className = 'run-state';
      const statusLine = document.createElement('div');
      statusLine.className = 'run-status-line';
      const title = document.createElement('div');
      title.className = 'run-status-title';
      if (active) {
        const spinner = document.createElement('span');
        spinner.className = 'run-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        title.append(spinner);
      }
      title.append(document.createTextNode(active ? 'Run in progress' : 'Historical run'));
      const badge = document.createElement('span');
      badge.className = 'run-status-badge ' + status;
      badge.textContent = status;
      statusLine.append(title, badge);
      content.append(statusLine);

      const meta = document.createElement('div');
      meta.className = 'run-meta';
      for (const [label, value] of [
        ['Browser', runLogBrowserName(summary)],
        ['Started', formatDate(summary.created_at)],
        ['Run ID', summary.run_id],
        ['Updated', formatDate(run.updated_at || summary.updated_at)],
      ]) {
        const item = document.createElement('div');
        item.className = 'run-meta-item';
        const itemLabel = document.createElement('span');
        itemLabel.className = 'run-meta-label';
        itemLabel.textContent = label;
        const itemValue = document.createElement('span');
        itemValue.className = 'run-meta-value';
        itemValue.textContent = value || '—';
        itemValue.title = value || '';
        item.append(itemLabel, itemValue);
        meta.append(item);
      }
      content.append(meta);
      const hasConclusion = appendRunConclusion(content, run);
      appendRunSection(content, 'Task', summary.task, 'run-summary');
      appendRunProgress(content, Array.isArray(run.updates) ? run.updates : [], active, {
        expanded: state.logsProgressExpanded,
        openSeqs,
        onToggle: expanded => {
          state.logsProgressExpanded = expanded;
          renderLogsDetail();
        },
      });
      if (active && !hasConclusion) appendRunSection(content, 'Result', 'Waiting for WebBrain to finish…', 'run-summary');
      logsDetailOutput.append(content);
    }

    async function selectRunLog(summary, { scroll = true } = {}) {
      state.logsSelectedId = summary.run_id;
      state.logsSelectedRun = null;
      state.logsDetailError = '';
      state.logsProgressExpanded = false;
      renderRunLogs();
      renderLogsDetail();
      const selectedId = summary.run_id;
      try {
        const run = await api('/api/browser-sessions/' + encodeURIComponent(summary.session_id) + '/runs/' + encodeURIComponent(summary.run_id));
        if (state.logsSelectedId !== selectedId) return;
        state.logsSelectedRun = run;
        Object.assign(summary, {
          status: run.status,
          summary: run.summary,
          error: run.error,
          final_url: run.final_url,
          update_count: Array.isArray(run.updates) ? run.updates.length : summary.update_count,
          updated_at: run.updated_at,
          completed_at: run.completed_at,
        });
        renderRunLogs();
        renderLogsDetail();
        if (scroll && window.matchMedia('(max-width: 900px)').matches) {
          logsDetailPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      } catch (error) {
        if (state.logsSelectedId !== selectedId) return;
        state.logsDetailError = error.message;
        logsMessage.textContent = error.message;
        renderLogsDetail();
      }
    }

    async function loadRunLogs({ reset = false } = {}) {
      if (reset) {
        state.logsOffset = 0;
        logsMessage.textContent = 'Refreshing…';
      } else {
        logsMessage.textContent = 'Loading older runs…';
      }
      refreshLogsBtn.disabled = true;
      loadOlderLogsBtn.disabled = true;
      try {
        const body = await api('/api/runs?limit=50&offset=' + state.logsOffset);
        if (reset) state.runLogs = body.runs || [];
        else {
          const known = new Set(state.runLogs.map(run => run.run_id));
          state.runLogs.push(...(body.runs || []).filter(run => !known.has(run.run_id)));
        }
        state.logsHasMore = body.has_more === true;
        state.logsOffset = body.next_offset == null ? state.runLogs.length : body.next_offset;
        renderLogFilters();
        renderRunLogs();
        logsMessage.textContent = '';
        const preferred = state.runLogs.find(run => run.run_id === state.logsSelectedId) || state.runLogs[0];
        if (reset && preferred) await selectRunLog(preferred, { scroll: false });
        else if (!preferred) renderLogsDetail();
      } finally {
        refreshLogsBtn.disabled = false;
        loadOlderLogsBtn.disabled = false;
      }
    }

    function scheduleConsolePoll() {
      if (consolePollTimer) clearTimeout(consolePollTimer);
      consolePollTimer = null;
      if (consoleRunIsActive() && state.consoleRun?.run_id) {
        consolePollTimer = setTimeout(pollConsoleRun, 1000);
      }
    }

    async function pollConsoleRun() {
      const runId = state.consoleRun?.run_id;
      const sessionId = state.consoleRunSessionId;
      if (!runId || !sessionId || !consoleRunIsActive()) return;
      try {
        const next = await api('/api/browser-sessions/' + encodeURIComponent(sessionId) + '/runs/' + encodeURIComponent(runId));
        if (state.consoleRun?.run_id !== runId) return;
        state.consoleRun = next;
        showMessage(consoleMessage, terminalRunStatuses.has(next.status) ? 'Run ' + next.status + '.' : 'Run is active. You can watch it from Browsers.', next.status === 'failed');
        renderConsole();
      } catch (e) {
        showMessage(consoleMessage, 'Could not refresh the run yet. Retrying… ' + e.message, true);
      }
      scheduleConsolePoll();
    }

    async function executeConsoleRun() {
      const session = consoleSelectedSession();
      const task = consoleTask.value.trim();
      if (!session) return showMessage(consoleMessage, 'Select a browser first.', true);
      if (!session.runtime_ready) return showMessage(consoleMessage, 'Choose a browser that is ready to run.', true);
      if (!task) return showMessage(consoleMessage, 'Enter a task to execute.', true);
      if (consoleRunIsActive()) return;

      state.selectedId = session.id;
      state.consoleRunSessionId = session.id;
      state.consoleRunTask = task;
      state.consoleProgressExpanded = false;
      state.consoleRun = { status: 'starting', run_id: '', result: null, summary: '', final_url: '', error: '', updates: [] };
      showMessage(consoleMessage, 'Starting the asynchronous run…');
      renderSessions();
      try {
        const run = await api('/api/browser-sessions/' + encodeURIComponent(session.id) + '/runs', {
          method: 'POST',
          body: { task, wait: false },
        });
        state.consoleRun = run;
        showMessage(consoleMessage, 'Run started. Switch to Browsers at any time to watch it.');
        renderConsole();
        scheduleConsolePoll();
      } catch (e) {
        state.consoleRun = { status: 'failed', run_id: '', result: null, summary: '', final_url: '', error: e.message, updates: [] };
        showMessage(consoleMessage, e.message, true);
        renderConsole();
      }
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
          if (state.selectedId !== session.id) showMessage(sessionMessage, '');
          state.selectedId = session.id;
          renderSessions();
          refreshOne(session.id).catch(e => showMessage(sessionMessage, e.message, true));
        });
        sessionsEl.appendChild(btn);
      }
      renderViewer();
      renderConsole();
    }

    function renderViewer() {
      const session = selectedSession();
      for (const [sessionId] of viewerConnections) {
        const connectedSession = state.sessions.find(item => item.id === sessionId);
        if (!connectedSession || connectedSession.status !== 'ready' || !connectedSession.public_ip) removeViewerConnection(sessionId);
      }
      const connection = session ? viewerConnections.get(session.id) : null;
      const isConnected = !!connection;
      const isConnecting = !!session && connectingSessionIds.has(session.id);
      const canConnect = !!session && !!session.public_ip && session.status === 'ready';

      connectBtn.textContent = isConnected ? 'Disconnect' : (isConnecting ? 'Connecting…' : 'Connect');
      connectBtn.disabled = isConnecting || (!isConnected && !canConnect);
      deleteSessionBtn.disabled = !session || session.status === 'destroyed';
      renameSessionBtn.disabled = !session || session.status === 'destroyed';
      viewerTitle.textContent = session ? browserName(session) + ' · ' + session.status : 'Browser preview';

      viewerConnectBtn.style.display = 'none';
      viewerConnectBtn.disabled = isConnecting;
      viewerConnectBtn.textContent = isConnecting ? 'Connecting…' : 'Connect';
      viewerStateVisual.style.display = 'none';
      viewerEmpty.className = 'viewer-state';
      viewerEmpty.removeAttribute('aria-busy');
      for (const [sessionId, item] of viewerConnections) item.frame.style.display = sessionId === session?.id ? 'block' : 'none';

      if (isConnected) {
        viewerEmpty.style.display = 'none';
        viewerFrames.style.display = 'block';
        externalLink.href = connection.url;
        externalLink.style.display = '';
      } else {
        viewerFrames.style.display = 'none';
        externalLink.removeAttribute('href');
        externalLink.style.display = 'none';
        viewerEmpty.style.display = '';
        if (!session) {
          viewerStateTitle.textContent = 'Select a browser';
          viewerStateDescription.textContent = 'Choose a browser session to preview it here.';
        } else if (session.status === 'provisioning' || (session.status === 'ready' && !session.public_ip)) {
          viewerEmpty.classList.add('is-provisioning');
          viewerEmpty.setAttribute('aria-busy', 'true');
          viewerStateVisual.style.display = '';
          viewerStateTitle.textContent = 'Preparing your browser';
          viewerStateDescription.textContent = 'Starting the cloud machine and WebBrain. This usually takes a few minutes.';
        } else if (canConnect) {
          viewerEmpty.classList.add('is-ready');
          viewerStateVisual.style.display = '';
          viewerStateTitle.textContent = 'Browser is ready';
          viewerStateDescription.textContent = 'Connect to see and control ' + browserName(session) + '.';
          viewerConnectBtn.style.display = '';
        } else if (session.status === 'failed') {
          viewerStateTitle.textContent = 'Browser setup failed';
          viewerStateDescription.textContent = 'Delete this browser and create a new one to try again.';
        } else if (session.status === 'destroyed') {
          viewerStateTitle.textContent = 'Browser unavailable';
          viewerStateDescription.textContent = 'This browser has been destroyed.';
        } else {
          viewerStateTitle.textContent = 'Browser unavailable';
          viewerStateDescription.textContent = 'Refresh the dashboard to check this browser again.';
        }
      }
    }

    async function loadSessions() {
      const body = await api('/api/browser-sessions');
      state.sessions = body.browser_sessions || [];
      renderSessions();
      if (!logsView.hidden && state.runLogs.length) {
        renderLogFilters();
        renderRunLogs();
        renderLogsDetail();
      }
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

    function removeViewerConnection(sessionId) {
      const connection = viewerConnections.get(sessionId);
      if (!connection) return;
      connection.frame.src = 'about:blank';
      connection.frame.remove();
      viewerConnections.delete(sessionId);
    }

    function disconnectNoVnc() {
      const session = selectedSession();
      if (!session || !viewerConnections.has(session.id)) return;
      removeViewerConnection(session.id);
      renderViewer();
      showMessage(sessionMessage, 'Browser disconnected.');
    }

    async function openNoVnc() {
      const session = selectedSession();
      if (!session || !session.public_ip || session.status !== 'ready') return;
      const sessionId = session.id;
      if (viewerConnections.has(sessionId) || connectingSessionIds.has(sessionId)) return;
      connectingSessionIds.add(sessionId);
      setSessionsCollapsed(true);
      showMessage(sessionMessage, 'Creating noVNC link...');
      renderViewer();
      try {
        const body = await api('/api/browser-sessions/' + encodeURIComponent(sessionId) + '/connect-token', {
          method: 'POST',
          body: { scheme: 'http', port: 6081 },
        });
        const currentSession = state.sessions.find(item => item.id === sessionId);
        if (!connectingSessionIds.has(sessionId) || !currentSession || currentSession.status !== 'ready') return;
        const frame = document.createElement('iframe');
        frame.title = browserName(currentSession) + ' cloud browser';
        frame.referrerPolicy = 'no-referrer';
        frame.dataset.sessionId = sessionId;
        frame.src = body.url;
        viewerFrames.appendChild(frame);
        viewerConnections.set(sessionId, { frame, url: body.url });
        if (state.selectedId === sessionId) showMessage(sessionMessage, 'noVNC opened. Token expires at ' + body.expires_at + '.');
      } catch (e) {
        if (state.selectedId === sessionId) showMessage(sessionMessage, e.message, true);
      } finally {
        connectingSessionIds.delete(sessionId);
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
        connectingSessionIds.delete(session.id);
        removeViewerConnection(session.id);
        if (state.selectedId === session.id) {
          state.selectedId = null;
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
    editAccountBtn.addEventListener('click', openAccountDialog);
    accountForm.addEventListener('submit', saveAccount);
    accountConfirmPassword.addEventListener('input', () => accountConfirmPassword.setCustomValidity(''));
    accountNewPassword.addEventListener('input', () => accountConfirmPassword.setCustomValidity(''));
    cancelAccountBtn.addEventListener('click', () => accountDialog.close());
    accountDialog.addEventListener('close', () => {
      accountNewPassword.value = '';
      accountConfirmPassword.value = '';
      accountCurrentPassword.value = '';
      accountConfirmPassword.setCustomValidity('');
      showMessage(accountMessage, '');
    });
    refreshBtn.addEventListener('click', async () => {
      const label = refreshBtn.querySelector('.account-action-label');
      refreshBtn.disabled = true;
      label.textContent = 'Refreshing…';
      try {
        const refreshes = [loadSessions(), loadApiKeys()];
        if (!logsView.hidden) refreshes.push(loadRunLogs({ reset: true }));
        await Promise.all(refreshes);
        accountMenu.removeAttribute('open');
      } catch (e) {
        if (!logsView.hidden) logsMessage.textContent = e.message;
        else {
          const targetMessage = !consoleView.hidden ? consoleMessage : (browserView.hidden ? apiKeyMessage : sessionMessage);
          showMessage(targetMessage, e.message, true);
        }
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
    connectBtn.addEventListener('click', () => {
      const session = selectedSession();
      if (session && viewerConnections.has(session.id)) disconnectNoVnc();
      else openNoVnc();
    });
    viewerConnectBtn.addEventListener('click', openNoVnc);
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
    consoleSessionSelect.addEventListener('change', () => {
      state.consoleSessionId = consoleSessionSelect.value || null;
      renderConsole();
    });
    consoleTask.addEventListener('input', () => {
      renderConsoleBrowsers();
      renderConsoleCode();
    });
    consoleTask.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) executeConsoleRun();
    });
    executeConsoleBtn.addEventListener('click', executeConsoleRun);
    refreshLogsBtn.addEventListener('click', () => loadRunLogs({ reset: true }).catch(error => {
      logsMessage.textContent = error.message;
    }));
    loadOlderLogsBtn.addEventListener('click', () => loadRunLogs().catch(error => {
      logsMessage.textContent = error.message;
    }));
    logsBrowserFilter.addEventListener('change', () => {
      state.logsBrowserFilter = logsBrowserFilter.value;
      renderRunLogs();
    });
    logsStatusFilter.addEventListener('change', () => {
      state.logsStatusFilter = logsStatusFilter.value;
      renderRunLogs();
    });
    for (const tab of consoleCodeTabs) {
      tab.addEventListener('click', () => {
        state.codeClient = tab.dataset.codeClient;
        renderConsoleCode();
      });
    }
    copyConsoleCode.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(consoleCode.textContent);
        copyConsoleCode.textContent = 'Copied';
        consoleCodeNote.textContent = 'Code copied to your clipboard.';
        setTimeout(() => {
          copyConsoleCode.textContent = 'Copy';
          consoleCodeNote.textContent = 'REST uses jq. Examples use WEBBRAIN_API_KEY and the current Console values.';
        }, 1800);
      } catch {
        consoleCodeNote.textContent = 'Copy failed. Select the code and copy it manually.';
      }
    });
    function dashboardViewFromHash() {
      if (location.hash === '#api-keys') return 'api-keys';
      if (location.hash === '#console') return 'console';
      if (location.hash === '#logs') return 'logs';
      return 'browsers';
    }
    window.addEventListener('hashchange', () => setDashboardView(dashboardViewFromHash(), false));
    setDashboardView(dashboardViewFromHash(), false);
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
    updates: Array.isArray(snapshot.updates)
      ? snapshot.updates
      : (Array.isArray(existing.updates) ? existing.updates : []),
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
    res.type('html').send(req.auth?.user ? dashboardPage(req.auth.user) : loginPage('', config.registrationEnabled));
  });

  app.post('/auth/register', async (req, res, next) => {
    if (!config.registrationEnabled) {
      const message = 'Registration is currently closed.';
      if (wantsJson(req)) return jsonError(res, 403, message);
      return res.status(403).type('html').send(loginPage(message, false));
    }
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
      res.status(e.status || 400).type('html').send(loginPage(e.message, config.registrationEnabled));
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
      res.status(e.status || 400).type('html').send(loginPage(e.message, config.registrationEnabled));
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

  app.patch('/api/me', requireAuth, async (req, res, next) => {
    try {
      if (req.auth.type !== 'cookie') {
        return jsonError(res, 403, 'Account changes require a signed-in dashboard session');
      }
      const user = await store.getUser(req.auth.user.id);
      if (!user) return jsonError(res, 404, 'User not found');

      const currentPassword = String(req.body.current_password || '');
      if (!currentPassword) return jsonError(res, 400, 'Current password is required');
      if (!(await verifyPassword(currentPassword, user.password_hash))) {
        return jsonError(res, 401, 'Current password is incorrect');
      }

      const email = normalizeAccountEmail(req.body.email);
      const newPassword = String(req.body.new_password || '');
      if (newPassword && newPassword.length < 8) {
        return jsonError(res, 400, 'New password must be at least 8 characters');
      }
      const emailChanged = email !== user.email;
      const passwordChanged = newPassword.length > 0;
      if (!emailChanged && !passwordChanged) {
        return jsonError(res, 400, 'Change the email address or enter a new password');
      }

      const emailOwner = await store.findUserByEmail(email);
      if (emailOwner && emailOwner.id !== user.id) {
        return jsonError(res, 409, 'Email already registered');
      }

      const updated = await store.updateUser(user.id, {
        email,
        password_hash: passwordChanged ? await hashPassword(newPassword) : user.password_hash,
        updated_at: nowIso(),
      });
      const otherSessionsRevoked = passwordChanged
        ? await store.deleteOtherWebSessions(user.id, req.auth.webSession.token_hash)
        : 0;
      await audit(req, 'user.update', 'user', user.id, {
        email_changed: emailChanged,
        password_changed: passwordChanged,
        other_sessions_revoked: otherSessionsRevoked,
      });
      res.json({
        user: { id: updated.id, email: updated.email },
        password_changed: passwordChanged,
        other_sessions_revoked: otherSessionsRevoked,
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return next(Object.assign(new Error('Email already registered'), { status: 409 }));
      }
      next(error);
    }
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
        updates: Array.isArray(started.updates) ? started.updates : [],
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

  app.get('/api/runs', requireAuth, async (req, res, next) => {
    try {
      const limit = Math.max(1, Math.min(100, Math.trunc(Number(req.query.limit) || 50)));
      const offset = Math.max(0, Math.trunc(Number(req.query.offset) || 0));
      const rows = await store.listCloudRunsForUser(req.auth.user.id, { limit: limit + 1, offset });
      const hasMore = rows.length > limit;
      const runs = rows.slice(0, limit).map(run => ({
        run_id: run.id,
        session_id: run.browser_session_id,
        task: run.task || '',
        status: run.status,
        summary: run.summary || '',
        error: run.error || '',
        final_url: run.final_url || '',
        update_count: Number(run.update_count) || (Array.isArray(run.updates) ? run.updates.length : 0),
        created_at: run.created_at || null,
        updated_at: run.updated_at || null,
        completed_at: run.completed_at || null,
      }));
      res.json({
        runs,
        has_more: hasMore,
        next_offset: hasMore ? offset + runs.length : null,
      });
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
