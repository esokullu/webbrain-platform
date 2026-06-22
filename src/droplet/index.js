#!/usr/bin/env node
import { DropletControlClient } from './control-client.js';
import { createNoVncGate } from './novnc-gate.js';

const platformUrl = process.env.WEBBRAIN_PLATFORM_URL || 'http://127.0.0.1:3000';
const controlUrl = process.env.WEBBRAIN_CONTROL_WS_URL || platformUrl.replace(/^http/, 'ws') + '/droplet/control';
const sessionToken = process.env.WEBBRAIN_SESSION_TOKEN;
const sidecarBase = process.env.WEBBRAIN_SIDECAR_BASE || 'http://127.0.0.1:17373';

if (!sessionToken) {
  console.error('WEBBRAIN_SESSION_TOKEN is required for droplet role.');
  process.exit(1);
}

const control = new DropletControlClient({ controlUrl, sessionToken, sidecarBase });
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

process.on('SIGINT', async () => {
  control.stop();
  await gate?.close();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  control.stop();
  await gate?.close();
  process.exit(0);
});
