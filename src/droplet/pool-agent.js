#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { WEBBRAIN_CONFIG_ENV } from '../shared/webbrain-config.js';

const execFile = promisify(execFileCallback);
const appDir = process.env.WEBBRAIN_APP_DIR || '/opt/webbrain-platform';
const poolToken = process.env.WEBBRAIN_POOL_TOKEN || '';
const platformUrl = process.env.WEBBRAIN_PLATFORM_URL || 'http://127.0.0.1:3000';
const controlUrl = process.env.WEBBRAIN_POOL_CONTROL_WS_URL || platformUrl.replace(/^http/, 'ws') + '/droplet/pool-control';

if (!poolToken) {
  console.error('WEBBRAIN_POOL_TOKEN is required for warm pool role.');
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function environmentFile(env) {
  return Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`).join('\n') + '\n';
}

async function systemctl(args, options = {}) {
  return await execFile('systemctl', args, options);
}

async function waitForProfileDevice(volumeName) {
  const device = `/dev/disk/by-id/scsi-0DO_Volume_${volumeName}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await fs.stat(device);
      return device;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error(`WebBrain profile volume did not appear: ${device}`);
}

async function mountProfileVolume({ volumeName, profileMount }) {
  if (!volumeName) return;
  const device = await waitForProfileDevice(volumeName);
  const { stdout } = await execFile('blkid', ['-s', 'UUID', '-o', 'value', device]);
  const uuid = stdout.trim();
  if (!uuid) throw new Error(`WebBrain profile volume has no filesystem UUID: ${device}`);
  await fs.mkdir(profileMount, { recursive: true, mode: 0o700 });
  const fstab = await fs.readFile('/etc/fstab', 'utf8').catch(() => '');
  if (!fstab.includes(`UUID=${uuid} `)) {
    await fs.appendFile('/etc/fstab', `UUID=${uuid} ${profileMount} ext4 defaults,discard,noatime,nofail 0 2\n`);
  }
  await execFile('mountpoint', ['-q', profileMount]).catch(async () => {
    await execFile('mount', [profileMount]);
  });
  await fs.mkdir(path.join(profileMount, 'chrome'), { recursive: true, mode: 0o700 });
  await execFile('chmod', ['0700', profileMount, path.join(profileMount, 'chrome')]);
}

function serviceFiles({ hasProfileVolume, profileMount }) {
  const mountLine = hasProfileVolume ? `\nRequiresMountsFor=${profileMount}` : '';
  const localFs = hasProfileVolume ? ' local-fs.target' : '';
  return {
    '/etc/systemd/system/webbrain-sidecar.service': `[Unit]
Description=WebBrain local sidecar
After=network-online.target
Wants=network-online.target
[Service]
EnvironmentFile=/etc/webbrain-droplet.env
WorkingDirectory=${appDir}
ExecStart=/usr/bin/npm run start:sidecar
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
`,
    '/etc/systemd/system/webbrain-xvfb.service': `[Unit]
Description=WebBrain virtual display
After=network-online.target
[Service]
EnvironmentFile=/etc/webbrain-droplet.env
ExecStart=/usr/bin/Xvfb :99 -screen 0 1440x900x24 -ac -noreset
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
`,
    '/etc/systemd/system/webbrain-x11vnc.service': `[Unit]
Description=WebBrain VNC server
After=webbrain-xvfb.service
Requires=webbrain-xvfb.service
[Service]
EnvironmentFile=/etc/webbrain-droplet.env
ExecStart=/usr/bin/x11vnc -display :99 -forever -shared -rfbport 5900 -nopw
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
`,
    '/etc/systemd/system/webbrain-novnc.service': `[Unit]
Description=WebBrain noVNC proxy
After=webbrain-x11vnc.service
Requires=webbrain-x11vnc.service
[Service]
EnvironmentFile=/etc/webbrain-droplet.env
ExecStart=/opt/noVNC/utils/novnc_proxy --listen 127.0.0.1:6080 --vnc 127.0.0.1:5900
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
`,
    '/etc/systemd/system/webbrain-browser.service': `[Unit]
Description=WebBrain cloud browser
After=webbrain-droplet.service webbrain-sidecar.service webbrain-xvfb.service${localFs}
Wants=webbrain-droplet.service
Requires=webbrain-xvfb.service${mountLine}
[Service]
EnvironmentFile=/etc/webbrain-droplet.env
WorkingDirectory=${appDir}
${hasProfileVolume ? `ExecStartPre=/usr/bin/node ${appDir}/scripts/clean-stale-chrome-singletons.mjs
` : ''}ExecStart=/usr/bin/npm run start:browser
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
`,
    '/etc/systemd/system/webbrain-droplet.service': `[Unit]
Description=WebBrain droplet control client
After=network-online.target webbrain-sidecar.service webbrain-novnc.service
Wants=network-online.target
[Service]
EnvironmentFile=/etc/webbrain-droplet.env
WorkingDirectory=${appDir}
RuntimeDirectory=webbrain-ephemeral-launch
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=no
ExecStart=/usr/bin/npm run start:droplet
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
`,
  };
}

async function writeServiceFiles(options) {
  for (const [file, content] of Object.entries(serviceFiles(options))) {
    await fs.writeFile(file, content, { mode: 0o644 });
  }
}

async function assign(payload) {
  const sessionId = String(payload.session_id || '');
  const sessionToken = String(payload.session_token || '');
  if (!/^bs_[a-z0-9]+$/.test(sessionId) || !sessionToken) {
    throw new Error('Warm assignment requires a valid browser session id and token.');
  }
  const hasProfileVolume = Boolean(payload.volume_name);
  const profileMount = String(payload.profile_mount || process.env.WEBBRAIN_PROFILE_MOUNT || '/mnt/webbrain-profile');
  const profileDir = hasProfileVolume ? `${profileMount}/chrome` : `${appDir}/.webbrain-sessions/${sessionId}`;
  const proxyStatePath = hasProfileVolume ? `${profileMount}/proxy.json` : '/var/lib/webbrain/proxy.json';
  const downloadsSyncEnabled = hasProfileVolume && String(payload.downloads_sync_enabled) === 'true';
  const downloadsStagingDir = '/var/lib/webbrain/download-staging';

  await systemctl(['stop',
    'webbrain-browser.service',
    'webbrain-droplet.service',
    'webbrain-sidecar.service',
    'webbrain-xvfb.service',
    'webbrain-x11vnc.service',
    'webbrain-novnc.service',
  ]).catch(() => {});

  if (hasProfileVolume) {
    await mountProfileVolume({ volumeName: payload.volume_name, profileMount });
  }

  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  await fs.mkdir('/var/cache/webbrain-chrome', { recursive: true, mode: 0o700 });
  await fs.mkdir(downloadsStagingDir, { recursive: true, mode: 0o700 });

  await fs.writeFile('/etc/webbrain-droplet.env', environmentFile({
    NODE_ENV: 'production',
    WEBBRAIN_ROLE: 'droplet',
    WEBBRAIN_SESSION_ID: sessionId,
    WEBBRAIN_SESSION_TOKEN: sessionToken,
    WEBBRAIN_PLATFORM_URL: process.env.WEBBRAIN_PLATFORM_URL || '',
    WEBBRAIN_CONTROL_WS_URL: process.env.WEBBRAIN_CONTROL_WS_URL || '',
    WEBBRAIN_EXTENSION_DIR: process.env.WEBBRAIN_EXTENSION_DIR || '/opt/webbrain3/src/chrome',
    WEBBRAIN_PROVIDER_BASE_URL: process.env.WEBBRAIN_PROVIDER_BASE_URL || '',
    WEBBRAIN_PROVIDER_API_KEY: payload.provider_api_key || sessionToken,
    WEBBRAIN_PROVIDER_MODEL: process.env.WEBBRAIN_PROVIDER_MODEL || 'webbrain-cloud 1.0',
    ...(payload.webbrain_config_b64
      ? { [WEBBRAIN_CONFIG_ENV]: payload.webbrain_config_b64 }
      : {}),
    WEBBRAIN_NOVNC_SECRET: sessionToken,
    WEBBRAIN_NOVNC_TARGET: 'http://127.0.0.1:6080',
    WEBBRAIN_NOVNC_GATE_PORT: process.env.WEBBRAIN_NOVNC_GATE_PORT || '6081',
    WEBBRAIN_EPHEMERAL_GATE_BASE_PORT: process.env.WEBBRAIN_EPHEMERAL_GATE_BASE_PORT || '6100',
    WEBBRAIN_EPHEMERAL_MAX_SESSIONS: process.env.WEBBRAIN_EPHEMERAL_MAX_SESSIONS || '1',
    WEBBRAIN_EPHEMERAL_MEMORY_MAX: process.env.WEBBRAIN_EPHEMERAL_MEMORY_MAX || '2G',
    WEBBRAIN_EPHEMERAL_DISK_MAX_BYTES: process.env.WEBBRAIN_EPHEMERAL_DISK_MAX_BYTES || String(2 * 1024 * 1024 * 1024),
    WEBBRAIN_EPHEMERAL_DOWNLOAD_LIMIT_BYTES: process.env.WEBBRAIN_EPHEMERAL_DOWNLOAD_LIMIT_BYTES || String(512 * 1024 * 1024),
    WEBBRAIN_EPHEMERAL_DOWNLOAD_TOTAL_LIMIT_BYTES: process.env.WEBBRAIN_EPHEMERAL_DOWNLOAD_TOTAL_LIMIT_BYTES || String(1024 * 1024 * 1024),
    WEBBRAIN_EPHEMERAL_LAUNCH_DIR: '/run/webbrain-ephemeral-launch',
    WEBBRAIN_DOWNLOADS_TARGET: 'http://127.0.0.1:6082',
    WEBBRAIN_DOWNLOADS_HOST: '127.0.0.1',
    WEBBRAIN_DOWNLOADS_PORT: '6083',
    WEBBRAIN_DOWNLOADS_ROOT: '/root/Downloads',
    WEBBRAIN_DOWNLOADS_UPLOAD_LIMIT_BYTES: downloadsSyncEnabled
      ? (process.env.WEBBRAIN_DOWNLOADS_MAX_UPLOAD_BYTES || String(25 * 1024 * 1024 * 1024))
      : String(5 * 1024 * 1024 * 1024),
    WEBBRAIN_DOWNLOADS_SYNC_ENABLED: String(downloadsSyncEnabled),
    WEBBRAIN_DOWNLOADS_STAGING_DIR: downloadsStagingDir,
    WEBBRAIN_DOWNLOADS_INGEST_URL: process.env.WEBBRAIN_DOWNLOADS_INGEST_URL || '',
    DISPLAY: ':99',
    WEBBRAIN_HEADLESS: 'false',
    WEBBRAIN_START_URL: process.env.WEBBRAIN_START_URL || 'https://webbrain.one',
    WEBBRAIN_BROWSER_BIN: process.env.WEBBRAIN_BROWSER_BIN || '/opt/chrome-linux64/chrome',
    WEBBRAIN_PROFILE_DIR: profileDir,
    WEBBRAIN_PROFILE_MOUNT: hasProfileVolume ? profileMount : '',
    WEBBRAIN_BROWSER_DISK_CACHE_DIR: '/var/cache/webbrain-chrome',
    WEBBRAIN_BROWSER_PROXY_URL: payload.proxy_url || '',
    WEBBRAIN_BROWSER_PROXY_SERVER: process.env.WEBBRAIN_BROWSER_PROXY_SERVER || 'http://127.0.0.1:17890',
    WEBBRAIN_BROWSER_PROXY_BYPASS_LIST: process.env.WEBBRAIN_BROWSER_PROXY_BYPASS_LIST || '',
    WEBBRAIN_PROXY_RELAY_HOST: process.env.WEBBRAIN_PROXY_RELAY_HOST || '127.0.0.1',
    WEBBRAIN_PROXY_RELAY_PORT: process.env.WEBBRAIN_PROXY_RELAY_PORT || '17890',
    WEBBRAIN_PROXY_STATE_PATH: proxyStatePath,
    WEBBRAIN_PROXY_VERIFY_URL: process.env.WEBBRAIN_PROXY_VERIFY_URL || 'http://api.ipify.org?format=json',
    WEBBRAIN_PROXY_VERIFY_TIMEOUT_MS: process.env.WEBBRAIN_PROXY_VERIFY_TIMEOUT_MS || '10000',
  }), { mode: 0o600 });
  await fs.chmod('/etc/webbrain-droplet.env', 0o600);

  await writeServiceFiles({ hasProfileVolume, profileMount });
  await execFile('bash', ['scripts/install-downloads-share.sh'], {
    cwd: appDir,
    env: {
      ...process.env,
      WEBBRAIN_APP_DIR: appDir,
      WEBBRAIN_DROPLET_ENV_FILE: '/etc/webbrain-droplet.env',
      WEBBRAIN_DOWNLOADS_ROOT: '/root/Downloads',
    },
  });
  await systemctl(['daemon-reload']);
  await systemctl(['enable',
    'webbrain-sidecar.service',
    'webbrain-xvfb.service',
    'webbrain-x11vnc.service',
    'webbrain-novnc.service',
    'webbrain-droplet.service',
    'webbrain-browser.service',
  ]);
  await systemctl(['restart',
    'webbrain-sidecar.service',
    'webbrain-xvfb.service',
    'webbrain-x11vnc.service',
    'webbrain-novnc.service',
    'webbrain-droplet.service',
    'webbrain-browser.service',
  ]);
  return { assigned: true, session_id: sessionId, profile_volume: hasProfileVolume };
}

class PoolAgent {
  constructor() {
    this.ws = null;
    this.assigned = false;
    this.stopped = false;
  }

  start() {
    void this.connectLoop();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }

  async connectLoop() {
    let delay = 500;
    while (!this.stopped && !this.assigned) {
      try {
        await this.connectOnce();
        delay = 500;
      } catch (error) {
        console.warn('[warm-pool] disconnected:', error.message || error);
      }
      if (!this.stopped && !this.assigned) {
        await sleep(delay);
        delay = Math.min(delay * 2, 10000);
      }
    }
  }

  connectOnce() {
    const url = new URL(controlUrl);
    url.searchParams.set('pool_token', poolToken);
    const ws = new WebSocket(url);
    this.ws = ws;
    return new Promise((resolve, reject) => {
      ws.once('open', () => console.log('[warm-pool] connected'));
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
      if (msg.action !== 'assign') throw new Error(`Unknown warm pool command: ${msg.action}`);
      if (this.assigned) throw new Error('Warm Droplet is already assigned.');
      const result = await assign(msg.payload || {});
      this.assigned = true;
      ws.send(JSON.stringify({ id: msg.id, ok: true, result }));
      setTimeout(() => this.stop(), 250);
    } catch (error) {
      ws.send(JSON.stringify({ id: msg.id, ok: false, error: error.message || String(error), status: error.status || 500 }));
    }
  }
}

const agent = new PoolAgent();
agent.start();
process.on('SIGINT', () => agent.stop());
process.on('SIGTERM', () => agent.stop());
