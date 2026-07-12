#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const sessionId = process.env.WEBBRAIN_SESSION_ID || 'default';
const extensionDir = path.resolve(process.env.WEBBRAIN_EXTENSION_DIR || path.join(rootDir, '..', 'webbrain3', 'src', 'chrome'));
const profileDir = path.resolve(process.env.WEBBRAIN_PROFILE_DIR || path.join(rootDir, '.webbrain-sessions', sessionId));
const debuggingPort = Number(process.env.WEBBRAIN_REMOTE_DEBUGGING_PORT || 9222);
const sidecarWsUrl = process.env.WEBBRAIN_SIDECAR_WS_URL || 'ws://127.0.0.1:17373/extension';
const startUrl = process.env.WEBBRAIN_START_URL || 'about:blank';

function commandExists(cmd) {
  if (path.isAbsolute(cmd)) return existsSync(cmd);
  return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
}

function findBrowser() {
  const explicit = process.env.WEBBRAIN_BROWSER_BIN || process.env.CHROME_BIN || process.env.CHROMIUM_BIN;
  const candidates = [
    explicit,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find(commandExists);
  if (!found) {
    throw new Error('No Chrome/Chromium binary found. Set WEBBRAIN_BROWSER_BIN.');
  }
  return found;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
}

function webbrainCloudProviderConfig() {
  const cfg = {
    type: 'openai',
    category: 'cloud',
    label: 'WebBrain Cloud',
    providerName: 'webbrain-cloud',
    enabled: true,
    promptTier: 'full',
  };
  if (process.env.WEBBRAIN_PROVIDER_BASE_URL) cfg.baseUrl = process.env.WEBBRAIN_PROVIDER_BASE_URL;
  if (process.env.WEBBRAIN_PROVIDER_API_KEY) cfg.apiKey = process.env.WEBBRAIN_PROVIDER_API_KEY;
  if (process.env.WEBBRAIN_PROVIDER_MODEL) cfg.model = process.env.WEBBRAIN_PROVIDER_MODEL;
  return cfg;
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function devtoolsJson(route) {
  const res = await fetch(`http://127.0.0.1:${debuggingPort}${route}`);
  if (!res.ok) throw new Error(`DevTools ${route} failed with ${res.status}`);
  return await res.json();
}

async function waitForDevtools() {
  const deadline = Date.now() + 15000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await devtoolsJson('/json/version');
    } catch (e) {
      lastError = e;
      await sleep(250);
    }
  }
  throw new Error(`Chrome DevTools did not come up on port ${debuggingPort}: ${lastError?.message || lastError}`);
}

function extensionIdFromUrl(url) {
  const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(url || '');
  return m?.[1] || null;
}

async function readExtensionIdFromPreferences() {
  try {
    const prefPath = path.join(profileDir, 'Default', 'Preferences');
    const parsed = JSON.parse(await fs.readFile(prefPath, 'utf8'));
    const settings = parsed.extensions?.settings || {};
    for (const [id, entry] of Object.entries(settings)) {
      if (path.resolve(entry.path || '') === extensionDir) return id;
      if (entry.manifest?.name === 'WebBrain') return id;
    }
  } catch {
    return null;
  }
  return null;
}

async function waitForExtensionId() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const prefsId = await readExtensionIdFromPreferences();
    if (prefsId) return prefsId;
    const targets = await devtoolsJson('/json/list').catch(() => []);
    for (const target of targets.filter(item => item.type === 'service_worker')) {
      const id = extensionIdFromUrl(target.url);
      if (id) return id;
    }
    await sleep(300);
  }
  throw new Error('Could not detect the WebBrain extension ID from DevTools targets or profile preferences.');
}

async function closeTarget(targetId) {
  const res = await fetch(`http://127.0.0.1:${debuggingPort}/json/close/${encodeURIComponent(targetId)}`);
  if (!res.ok) throw new Error(`Could not close temporary extension target: ${res.status}`);
}

async function waitForExtensionPage(cdp) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await cdp.call('Runtime.evaluate', {
      expression: "typeof chrome !== 'undefined' && !!chrome.storage?.local && !!chrome.runtime?.sendMessage",
      returnByValue: true,
    });
    if (result.result?.value === true) return;
    await sleep(100);
  }
  throw new Error('WebBrain extension page did not become ready for configuration.');
}

async function createTarget(url) {
  const encoded = encodeURIComponent(url);
  let res = await fetch(`http://127.0.0.1:${debuggingPort}/json/new?${encoded}`, { method: 'PUT' });
  if (!res.ok) {
    res = await fetch(`http://127.0.0.1:${debuggingPort}/json/new?${encoded}`);
  }
  if (!res.ok) throw new Error(`Could not create target for ${url}: ${res.status}`);
  return await res.json();
}

function createCdpClient(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString('utf8'));
    if (!msg.id || !pending.has(msg.id)) return;
    const item = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) item.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else item.resolve(msg.result);
  });
  return {
    open: () => new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    call(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      ws.close();
    },
  };
}

async function preseedExtension(extensionId) {
  const target = await createTarget(`chrome-extension://${extensionId}/src/ui/settings.html`);
  const cdp = createCdpClient(target.webSocketDebuggerUrl);
  try {
    await cdp.open();
    await cdp.call('Runtime.enable');
    await waitForExtensionPage(cdp);

    const providerConfig = webbrainCloudProviderConfig();
    const storagePatch = {
      askBeforeConsequentialActions: false,
      webbrainCloudBridgeEnabled: true,
      webbrainCloudBridgeUrl: sidecarWsUrl,
      webbrainCloudManaged: true,
      activeProvider: 'webbrain_cloud',
      tracingEnabled: boolEnv('WEBBRAIN_TRACING_ENABLED', true),
    };

    const expression = `
      (async () => {
        const providerConfig = ${JSON.stringify(providerConfig)};
        const storagePatch = ${JSON.stringify(storagePatch)};
        const current = await chrome.storage.local.get(['providers']);
        const providers = {
          ...(current.providers || {}),
          webbrain_cloud: {
            ...(current.providers?.webbrain_cloud || {}),
            ...providerConfig
          }
        };
        await chrome.storage.local.set({ ...storagePatch, providers });
        try {
          await chrome.runtime.sendMessage({
            target: 'background',
            action: 'update_provider',
            providerId: 'webbrain_cloud',
            config: providerConfig
          });
        } catch (e) {}
        try {
          await chrome.runtime.sendMessage({
            target: 'background',
            action: 'set_active_provider',
            providerId: 'webbrain_cloud'
          });
        } catch (e) {}
        const bridge = await chrome.runtime.sendMessage({
          target: 'background',
          action: 'cloud_bridge_start',
          url: ${JSON.stringify(sidecarWsUrl)}
        });
        return { ok: true, bridge };
      })()
    `;

    const result = await cdp.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Extension preseed failed.');
    }
    return result.result?.value;
  } finally {
    cdp.close();
    await closeTarget(target.id).catch(() => {});
  }
}

async function main() {
  if (!existsSync(extensionDir)) {
    throw new Error(`WebBrain extension directory does not exist: ${extensionDir}`);
  }
  await fs.mkdir(profileDir, { recursive: true });

  const browser = findBrowser();
  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${debuggingPort}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-dev-shm-usage',
  ];
  if (boolEnv('WEBBRAIN_HEADLESS', false)) args.push('--headless=new');
  if (process.getuid?.() === 0) args.push('--no-sandbox');
  args.push(startUrl);

  const child = spawn(browser, args, { stdio: 'inherit' });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));

  await waitForDevtools();
  const extensionId = await waitForExtensionId();
  const seeded = await preseedExtension(extensionId);
  console.log(JSON.stringify({
    ok: true,
    browser,
    profile_dir: profileDir,
    extension_dir: extensionDir,
    extension_id: extensionId,
    sidecar_ws_url: sidecarWsUrl,
    preseed: seeded,
  }, null, 2));

  child.on('exit', code => process.exit(code ?? 0));
}

main().catch(e => {
  console.error(`[webbrain-cloud-browser] ${e.message || e}`);
  process.exit(1);
});
