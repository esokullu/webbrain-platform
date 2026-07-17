#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const runtimeDir = process.env.RUNTIME_DIRECTORY || '';
const dataDir = path.resolve(process.env.WEBBRAIN_EPHEMERAL_DATA_DIR || '/tmp/webbrain-ephemeral-data');
const sessionId = process.env.WEBBRAIN_SESSION_ID || '';
const expiresAt = new Date(process.env.WEBBRAIN_EPHEMERAL_EXPIRES_AT || '');
const appDir = process.env.WEBBRAIN_APP_DIR || '/opt/webbrain-platform';
const diskMaxBytes = Number(process.env.WEBBRAIN_EPHEMERAL_DISK_MAX_BYTES);
const downloadsMaxBytes = Number(process.env.WEBBRAIN_DOWNLOADS_TOTAL_LIMIT_BYTES);

if (!runtimeDir.startsWith('/run/webbrain-ephemeral/') || !/^bs_[a-z0-9]+$/.test(sessionId)) {
  throw new Error('Ephemeral worker requires an isolated systemd RuntimeDirectory and valid session id.');
}
if (!dataDir.startsWith('/tmp/') || dataDir === '/tmp') {
  throw new Error('Ephemeral worker data must live inside its private temporary namespace.');
}
if (!Number.isSafeInteger(diskMaxBytes) || diskMaxBytes <= 0) {
  throw new Error('Ephemeral worker requires a positive aggregate disk limit.');
}
if (!Number.isSafeInteger(downloadsMaxBytes) || downloadsMaxBytes <= 0) {
  throw new Error('Ephemeral worker requires a positive Downloads storage limit.');
}
if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
  throw new Error('Ephemeral worker expiry is missing or already elapsed.');
}

const displayNumber = Number(process.env.WEBBRAIN_EPHEMERAL_DISPLAY);
const sidecarPort = Number(process.env.WEBBRAIN_SIDECAR_PORT);
const proxyPort = Number(process.env.WEBBRAIN_PROXY_RELAY_PORT);
const debuggingPort = Number(process.env.WEBBRAIN_REMOTE_DEBUGGING_PORT);
const downloadsPort = Number(process.env.WEBBRAIN_DOWNLOADS_PORT);
const vncPort = Number(process.env.WEBBRAIN_VNC_PORT);
const noVncPort = Number(process.env.WEBBRAIN_NOVNC_PORT);
const gatePort = Number(process.env.WEBBRAIN_NOVNC_GATE_PORT);
const runtimeHost = process.env.WEBBRAIN_RUNTIME_HOST || '';
if (net.isIP(runtimeHost) !== 4 || !runtimeHost.startsWith('127.') || runtimeHost === '127.0.0.1') {
  throw new Error('Ephemeral worker requires a dedicated loopback address.');
}
for (const [name, value] of Object.entries({
  displayNumber,
  sidecarPort,
  proxyPort,
  debuggingPort,
  downloadsPort,
  vncPort,
  noVncPort,
  gatePort,
})) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid ephemeral ${name}.`);
}

const homeDir = path.join(dataDir, 'home');
const downloadsDir = path.join(homeDir, 'Downloads');
const profileDir = path.join(dataDir, 'profile');
const cacheDir = path.join(dataDir, 'cache');
const configDir = path.join(dataDir, 'config');
const stateDir = path.join(dataDir, 'state');
const tempDir = path.join(dataDir, 'tmp');
await Promise.all(
  [homeDir, downloadsDir, profileDir, cacheDir, configDir, stateDir, tempDir]
    .map(directory => fs.mkdir(directory, { recursive: true, mode: 0o700 }))
);

const sharedEnv = {
  ...process.env,
  HOME: homeDir,
  TMPDIR: tempDir,
  XDG_CACHE_HOME: cacheDir,
  XDG_CONFIG_HOME: configDir,
  XDG_STATE_HOME: stateDir,
  DISPLAY: `:${displayNumber}`,
  WEBBRAIN_HEADLESS: 'false',
  WEBBRAIN_EPHEMERAL: 'true',
  WEBBRAIN_PROFILE_DIR: profileDir,
  WEBBRAIN_PROFILE_MOUNT: '',
  WEBBRAIN_BROWSER_DISK_CACHE_DIR: cacheDir,
  WEBBRAIN_REMOTE_DEBUGGING_ADDRESS: runtimeHost,
  WEBBRAIN_REMOTE_DEBUGGING_PORT: String(debuggingPort),
  WEBBRAIN_SIDECAR_HOST: runtimeHost,
  WEBBRAIN_SIDECAR_PORT: String(sidecarPort),
  WEBBRAIN_SIDECAR_BASE: `http://${runtimeHost}:${sidecarPort}`,
  WEBBRAIN_SIDECAR_WS_URL: `ws://${runtimeHost}:${sidecarPort}/extension`,
  WEBBRAIN_PROXY_RELAY_HOST: runtimeHost,
  WEBBRAIN_PROXY_RELAY_PORT: String(proxyPort),
  WEBBRAIN_BROWSER_PROXY_SERVER: `http://${runtimeHost}:${proxyPort}`,
  WEBBRAIN_PROXY_STATE_PATH: path.join(stateDir, 'proxy.json'),
  WEBBRAIN_DOWNLOADS_SYNC_ENABLED: 'false',
  WEBBRAIN_DOWNLOADS_HOST: runtimeHost,
  WEBBRAIN_DOWNLOADS_PORT: String(downloadsPort),
  WEBBRAIN_DOWNLOADS_ROOT: downloadsDir,
  WEBBRAIN_DOWNLOADS_TARGET: `http://${runtimeHost}:${downloadsPort}`,
  WEBBRAIN_NOVNC_SECRET: process.env.WEBBRAIN_SESSION_TOKEN,
  WEBBRAIN_NOVNC_TARGET: `http://${runtimeHost}:${noVncPort}`,
  WEBBRAIN_NOVNC_GATE_HOST: '0.0.0.0',
  WEBBRAIN_NOVNC_GATE_PORT: String(gatePort),
};

const children = new Map();
let shuttingDown = false;
let exitCode = 0;
let diskCheckRunning = false;
let diskMonitor = null;

function startChild(name, command, args, env = sharedEnv) {
  const child = spawn(command, args, {
    cwd: appDir,
    env,
    stdio: 'inherit',
  });
  children.set(name, child);
  child.once('error', error => {
    console.error(`[ephemeral:${sessionId}] ${name} failed to start: ${error.message}`);
    void shutdown(1);
  });
  child.once('exit', (code, signal) => {
    children.delete(name);
    if (shuttingDown) return;
    console.error(`[ephemeral:${sessionId}] ${name} exited unexpectedly (${signal || code || 0})`);
    void shutdown(code || 1);
  });
  return child;
}

async function waitForPath(target, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(target);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for ${target}`);
}

async function directorySize(root, stopAfterBytes = diskMaxBytes) {
  let total = 0;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const itemPath = path.join(directory, entry.name);
      const stat = await fs.lstat(itemPath).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        pending.push(itemPath);
      } else if (stat.isFile()) {
        total += stat.size;
        if (total > stopAfterBytes) return total;
      }
    }
  }
  return total;
}

async function enforceDiskLimit() {
  if (shuttingDown || diskCheckRunning) return;
  diskCheckRunning = true;
  try {
    const downloadsBytes = await directorySize(downloadsDir, downloadsMaxBytes);
    if (downloadsBytes > downloadsMaxBytes) {
      console.error(
        `[ephemeral:${sessionId}] Downloads exceeded the ${downloadsMaxBytes}-byte aggregate limit`
      );
      await shutdown(1);
      return;
    }
    const usedBytes = await directorySize(dataDir);
    if (usedBytes > diskMaxBytes) {
      console.error(
        `[ephemeral:${sessionId}] writable data exceeded the ${diskMaxBytes}-byte aggregate limit`
      );
      await shutdown(1);
    }
  } catch (error) {
    console.error(`[ephemeral:${sessionId}] could not verify writable data usage: ${error.message}`);
    await shutdown(1);
  } finally {
    diskCheckRunning = false;
  }
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = code;
  if (diskMonitor) clearInterval(diskMonitor);
  for (const child of children.values()) child.kill('SIGTERM');
  const deadline = Date.now() + 5000;
  while (children.size && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  for (const child of children.values()) child.kill('SIGKILL');
  process.exit(exitCode);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
setTimeout(() => void shutdown(0), Math.max(1, expiresAt.getTime() - Date.now())).unref();
diskMonitor = setInterval(() => void enforceDiskLimit(), 2000);
diskMonitor.unref();

startChild('xvfb', '/usr/bin/Xvfb', [
  `:${displayNumber}`,
  '-screen', '0', '1440x900x24',
  '-ac',
  '-noreset',
]);
await waitForPath(`/tmp/.X11-unix/X${displayNumber}`);
startChild('x11vnc', '/usr/bin/x11vnc', [
  '-display', `:${displayNumber}`,
  '-forever',
  '-shared',
  '-rfbport', String(vncPort),
  '-listen', runtimeHost,
  '-nopw',
]);
startChild('novnc', '/opt/noVNC/utils/novnc_proxy', [
  '--listen', `${runtimeHost}:${noVncPort}`,
  '--vnc', `${runtimeHost}:${vncPort}`,
]);
startChild('sidecar', '/usr/bin/node', ['src/sidecar.js']);
startChild('downloads', '/usr/bin/node', ['src/droplet/downloads-index.js']);
startChild('control', '/usr/bin/node', ['src/droplet/index.js']);
startChild('browser', '/usr/bin/node', ['scripts/launch-cloud-browser.mjs']);

console.log(
  `[ephemeral:${sessionId}] volatile runtime ${process.env.WEBBRAIN_RUNTIME_GENERATION} started in private ${dataDir}`
);
