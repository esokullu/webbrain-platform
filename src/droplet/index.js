#!/usr/bin/env node
import { DropletControlClient } from './control-client.js';
import { createNoVncGate } from './novnc-gate.js';
import { BrowserProxyRelay } from './proxy-relay.js';

const platformUrl = process.env.WEBBRAIN_PLATFORM_URL || 'http://127.0.0.1:3000';
const controlUrl = process.env.WEBBRAIN_CONTROL_WS_URL || platformUrl.replace(/^http/, 'ws') + '/droplet/control';
const sessionToken = process.env.WEBBRAIN_SESSION_TOKEN;
const sidecarBase = process.env.WEBBRAIN_SIDECAR_BASE || 'http://127.0.0.1:17373';
const proxyVerifyUrl = process.env.WEBBRAIN_PROXY_VERIFY_URL || 'http://api.ipify.org?format=json';

if (!sessionToken) {
  console.error('WEBBRAIN_SESSION_TOKEN is required for droplet role.');
  process.exit(1);
}

const proxyRelay = new BrowserProxyRelay({
  host: process.env.WEBBRAIN_PROXY_RELAY_HOST || '127.0.0.1',
  port: Number(process.env.WEBBRAIN_PROXY_RELAY_PORT || 17890),
  initialProxyUrl: process.env.WEBBRAIN_BROWSER_PROXY_URL || '',
  statePath: process.env.WEBBRAIN_PROXY_STATE_PATH || '/var/lib/webbrain/proxy.json',
  verifyUrl: proxyVerifyUrl,
  verifyTimeoutMs: Number(process.env.WEBBRAIN_PROXY_VERIFY_TIMEOUT_MS || 10000),
});
const initialProxy = await proxyRelay.start({ verifyInitial: true });
console.log(`[browser-proxy] relay listening on ${proxyRelay.host}:${proxyRelay.port}; upstream ${initialProxy.enabled ? initialProxy.endpoint : 'direct'}`);

const control = new DropletControlClient({
  controlUrl,
  sessionToken,
  sidecarBase,
  proxyRelay,
  proxyVerifyUrl,
});
control.start();

let gate = null;
if (process.env.WEBBRAIN_NOVNC_SECRET) {
  gate = createNoVncGate({
    secret: process.env.WEBBRAIN_NOVNC_SECRET,
    target: process.env.WEBBRAIN_NOVNC_TARGET || 'http://127.0.0.1:6080',
  });
  const port = Number(process.env.WEBBRAIN_NOVNC_GATE_PORT || 6081);
  await gate.listen(port, process.env.WEBBRAIN_NOVNC_GATE_HOST || '0.0.0.0');
  console.log(`WebBrain noVNC gate listening on ${port}`);
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  control.stop();
  await gate?.close();
  await proxyRelay.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
