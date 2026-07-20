import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { WEBBRAIN_CONFIG_ENV } from '../shared/webbrain-config.js';

const execFile = promisify(execFileCallback);
const ACTIVE_SESSION_STATUSES = new Set(['starting', 'active', 'stopping']);

function assertSessionId(value) {
  const sessionId = String(value || '');
  if (!/^bs_[a-z0-9]+$/.test(sessionId)) {
    throw Object.assign(new Error('A valid ephemeral browser session id is required.'), { status: 400 });
  }
  return sessionId;
}

function quoteEnvironmentValue(value) {
  return `"${String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}"`;
}

function environmentFile(values) {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${quoteEnvironmentValue(value)}`)
    .join('\n') + '\n';
}

function defaultPortReachable(port, host = '127.0.0.1', timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      // The transient unit blocks the rest of 127/8 in both directions. Use
      // its explicitly allowed loopback address as the source for this probe.
      const socket = net.createConnection({ host, port, localAddress: host });
      socket.setTimeout(500);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      const retry = () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(Object.assign(new Error('Ephemeral browser runtime did not open its viewer gate in time.'), { status: 504 }));
          return;
        }
        setTimeout(tryConnect, 150);
      };
      socket.once('error', retry);
      socket.once('timeout', retry);
    };
    tryConnect();
  });
}

export class EphemeralRuntimeManager {
  constructor({
    execFileImpl = execFile,
    fsImpl = fs,
    portReachable = defaultPortReachable,
    env = process.env,
  } = {}) {
    this.execFile = execFileImpl;
    this.fs = fsImpl;
    this.portReachable = portReachable;
    this.env = env;
    this.launchDir = env.WEBBRAIN_EPHEMERAL_LAUNCH_DIR || '/run/webbrain-ephemeral-launch';
    this.appDir = env.WEBBRAIN_APP_DIR || '/opt/webbrain-platform';
    this.baseGatePort = Number(env.WEBBRAIN_EPHEMERAL_GATE_BASE_PORT || 6100);
    this.maxSessions = Math.max(1, Number(env.WEBBRAIN_EPHEMERAL_MAX_SESSIONS || 1));
    this.memoryMax = env.WEBBRAIN_EPHEMERAL_MEMORY_MAX || '2G';
    this.sessions = new Map();
    this.startPromises = new Map();
  }

  async discardStaleRuntimes() {
    // The manager's registry is intentionally in-memory. If the parent control
    // process crashed, discard any units it can no longer account for before
    // accepting new platform commands.
    await this.execFile('systemctl', ['stop', 'webbrain-ephemeral-*.service']).catch(error => {
      if (!/not loaded|not found|no units/i.test(String(error?.message || ''))) throw error;
    });
    await this.fs.rm(this.launchDir, { recursive: true, force: true });
    await this.fs.mkdir(this.launchDir, { recursive: true, mode: 0o700 });
    this.sessions.clear();
  }

  async start(payload = {}) {
    const sessionId = assertSessionId(payload.session_id);
    if (!payload.session_token) {
      throw Object.assign(new Error('Ephemeral browser session token is required.'), { status: 400 });
    }
    const pending = this.startPromises.get(sessionId);
    if (pending) return await pending;
    const startPromise = this.startRuntime(sessionId, payload);
    this.startPromises.set(sessionId, startPromise);
    try {
      return await startPromise;
    } finally {
      if (this.startPromises.get(sessionId) === startPromise) {
        this.startPromises.delete(sessionId);
      }
    }
  }

  async startRuntime(sessionId, payload) {
    if (this.sessions.has(sessionId)) {
      const existing = await this.status({ session_id: sessionId });
      if (existing.exists) return existing;
    }
    const usedSlots = new Set(
      [...this.sessions.values()]
        .filter(item => ACTIVE_SESSION_STATUSES.has(item.status))
        .map(item => item.slot)
    );
    const slot = Array.from({ length: this.maxSessions }, (_, index) => index)
      .find(index => !usedSlots.has(index));
    if (slot === undefined) {
      throw Object.assign(new Error('This Droplet has reached its ephemeral browser capacity.'), { status: 409 });
    }

    const expiresAt = new Date(payload.expires_at || '');
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw Object.assign(new Error('Ephemeral browser expiry must be in the future.'), { status: 400 });
    }

    const generation = `eph_${randomBytes(12).toString('hex')}`;
    const unit = `webbrain-ephemeral-${sessionId}.service`;
    const gatePort = this.baseGatePort + slot;
    const runtimeHost = `127.200.${Math.floor(slot / 254)}.${(slot % 254) + 1}`;
    const ports = {
      sidecar: 18000 + slot,
      proxy: 18100 + slot,
      debugging: 18200 + slot,
      downloads: 18300 + slot,
      vnc: 18400 + slot,
      novnc: 18500 + slot,
      gate: gatePort,
      display: 100 + slot,
    };
    const envPath = path.join(this.launchDir, `${sessionId}.env`);
    const record = {
      session_id: sessionId,
      generation,
      unit,
      slot,
      gate_port: gatePort,
      env_path: envPath,
      status: 'starting',
      expires_at: expiresAt.toISOString(),
    };
    this.sessions.set(sessionId, record);

    await this.fs.mkdir(this.launchDir, { recursive: true, mode: 0o700 });
    await this.fs.writeFile(envPath, environmentFile({
      NODE_ENV: 'production',
      WEBBRAIN_EPHEMERAL_CHILD: 'true',
      WEBBRAIN_EPHEMERAL: 'true',
      WEBBRAIN_RUNTIME_GENERATION: generation,
      WEBBRAIN_EPHEMERAL_EXPIRES_AT: expiresAt.toISOString(),
      WEBBRAIN_SESSION_ID: sessionId,
      WEBBRAIN_SESSION_TOKEN: payload.session_token,
      WEBBRAIN_PLATFORM_URL: this.env.WEBBRAIN_PLATFORM_URL || '',
      WEBBRAIN_CONTROL_WS_URL: this.env.WEBBRAIN_CONTROL_WS_URL || '',
      WEBBRAIN_EXTENSION_DIR: this.env.WEBBRAIN_EXTENSION_DIR || '/opt/webbrain3/src/chrome',
      WEBBRAIN_PROVIDER_BASE_URL: this.env.WEBBRAIN_PROVIDER_BASE_URL || '',
      WEBBRAIN_PROVIDER_API_KEY: payload.provider_api_key || payload.session_token,
      WEBBRAIN_PROVIDER_MODEL: this.env.WEBBRAIN_PROVIDER_MODEL || 'webbrain-cloud 1.0',
      ...(payload.webbrain_config_b64
        ? { [WEBBRAIN_CONFIG_ENV]: payload.webbrain_config_b64 }
        : {}),
      WEBBRAIN_BROWSER_BIN: this.env.WEBBRAIN_BROWSER_BIN || '/opt/chrome-linux64/chrome',
      WEBBRAIN_START_URL: this.env.WEBBRAIN_START_URL || 'https://webbrain.one',
      WEBBRAIN_BROWSER_PROXY_URL: payload.proxy_url || '',
      WEBBRAIN_BROWSER_PROXY_BYPASS_LIST: this.env.WEBBRAIN_BROWSER_PROXY_BYPASS_LIST || '',
      WEBBRAIN_PROXY_VERIFY_URL: this.env.WEBBRAIN_PROXY_VERIFY_URL || 'http://api.ipify.org?format=json',
      WEBBRAIN_PROXY_VERIFY_TIMEOUT_MS: this.env.WEBBRAIN_PROXY_VERIFY_TIMEOUT_MS || '10000',
      WEBBRAIN_EPHEMERAL_DISPLAY: ports.display,
      WEBBRAIN_RUNTIME_HOST: runtimeHost,
      WEBBRAIN_EPHEMERAL_DATA_DIR: '/tmp/webbrain-ephemeral-data',
      WEBBRAIN_EPHEMERAL_DISK_MAX_BYTES: this.env.WEBBRAIN_EPHEMERAL_DISK_MAX_BYTES || String(2 * 1024 * 1024 * 1024),
      WEBBRAIN_SIDECAR_PORT: ports.sidecar,
      WEBBRAIN_PROXY_RELAY_PORT: ports.proxy,
      WEBBRAIN_REMOTE_DEBUGGING_PORT: ports.debugging,
      WEBBRAIN_DOWNLOADS_PORT: ports.downloads,
      WEBBRAIN_VNC_PORT: ports.vnc,
      WEBBRAIN_NOVNC_PORT: ports.novnc,
      WEBBRAIN_NOVNC_GATE_PORT: ports.gate,
      WEBBRAIN_DOWNLOADS_UPLOAD_LIMIT_BYTES: this.env.WEBBRAIN_EPHEMERAL_DOWNLOAD_LIMIT_BYTES || String(512 * 1024 * 1024),
      WEBBRAIN_DOWNLOADS_TOTAL_LIMIT_BYTES: this.env.WEBBRAIN_EPHEMERAL_DOWNLOAD_TOTAL_LIMIT_BYTES || String(1024 * 1024 * 1024),
    }), { flag: 'wx', mode: 0o600 });

    const runtimeSeconds = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
    const properties = [
      'Type=simple',
      'BindsTo=webbrain-droplet.service',
      'After=webbrain-droplet.service',
      'Restart=no',
      'KillMode=control-group',
      'TimeoutStopSec=15s',
      `RuntimeMaxSec=${runtimeSeconds}s`,
      `EnvironmentFile=${envPath}`,
      `WorkingDirectory=${this.appDir}`,
      `RuntimeDirectory=webbrain-ephemeral/${sessionId}`,
      'RuntimeDirectoryMode=0700',
      'RuntimeDirectoryPreserve=no',
      'DynamicUser=yes',
      'PrivateTmp=yes',
      'PrivateDevices=yes',
      'ProtectHome=yes',
      'ProtectSystem=strict',
      'ReadWritePaths=/tmp',
      'ProtectKernelTunables=yes',
      'ProtectKernelModules=yes',
      'ProtectControlGroups=yes',
      'NoNewPrivileges=yes',
      'LockPersonality=yes',
      'RestrictSUIDSGID=yes',
      'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
      'IPAddressDeny=127.0.0.0/8 ::1/128 169.254.0.0/16',
      `IPAddressAllow=${runtimeHost}/32`,
      'InaccessiblePaths=-/mnt/webbrain-profile -/var/lib/webbrain -/var/cache/webbrain-chrome -/opt/webbrain-platform/.webbrain-sessions',
      'TemporaryFileSystem=/dev/shm:rw,nosuid,nodev,size=512M',
      `MemoryMax=${this.memoryMax}`,
    ];
    const args = [
      '--unit', unit.replace(/\.service$/, ''),
      '--collect',
      ...properties.flatMap(property => ['--property', property]),
      '/usr/bin/node',
      path.join(this.appDir, 'src/droplet/ephemeral-worker.js'),
    ];

    try {
      await this.execFile('systemd-run', args);
      // Type=simple has already read the EnvironmentFile before systemd-run
      // returns. Remove the launch secrets while the volatile runtime is live.
      await this.fs.rm(envPath, { force: true });
      await this.portReachable(gatePort, runtimeHost);
      record.status = 'active';
      return this.publicRecord(record, true);
    } catch (error) {
      let stopFailed = false;
      try {
        await this.execFile('systemctl', ['stop', unit]);
      } catch (stopError) {
        if (!/not loaded|not found/i.test(String(stopError?.message || ''))) {
          stopFailed = true;
          record.status = 'stopping';
        }
      }
      await this.fs.rm(envPath, { force: true }).catch(() => {});
      if (!stopFailed) this.sessions.delete(sessionId);
      throw error;
    }
  }

  async stop(payload = {}) {
    const sessionId = assertSessionId(payload.session_id);
    const pending = this.startPromises.get(sessionId);
    if (pending) await pending.catch(() => {});
    const record = this.sessions.get(sessionId);
    if (!record) return { ok: true, existed: false, session_id: sessionId };
    record.status = 'stopping';
    await this.execFile('systemctl', ['stop', record.unit]).catch(error => {
      if (!/not loaded|not found/i.test(String(error?.message || ''))) throw error;
    });
    await this.fs.rm(record.env_path, { force: true }).catch(() => {});
    this.sessions.delete(sessionId);
    return { ok: true, existed: true, session_id: sessionId };
  }

  async status(payload = {}) {
    const sessionId = assertSessionId(payload.session_id);
    const pending = this.startPromises.get(sessionId);
    if (pending) {
      try {
        return await pending;
      } catch {
        return { exists: false, session_id: sessionId };
      }
    }
    const record = this.sessions.get(sessionId);
    if (!record) return { exists: false, session_id: sessionId };
    try {
      await this.execFile('systemctl', ['is-active', '--quiet', record.unit]);
    } catch (error) {
      // systemctl uses 3 for inactive and 4 for an unknown unit. Infrastructure
      // errors (for example, a transient D-Bus failure) must not make us forget
      // a runtime that could still be alive.
      if (![3, 4].includes(Number(error?.code))) throw error;
      await this.fs.rm(record.env_path, { force: true }).catch(() => {});
      this.sessions.delete(sessionId);
      return { exists: false, session_id: sessionId };
    }
    return this.publicRecord(record, true);
  }

  async stopAll() {
    const stopped = [];
    const failures = [];
    for (const sessionId of [...this.sessions.keys()]) {
      try {
        await this.stop({ session_id: sessionId });
        stopped.push(sessionId);
      } catch (error) {
        failures.push({ sessionId, error });
      }
    }
    if (failures.length) {
      const error = new Error(
        `Failed to stop ${failures.length} ephemeral browser runtime${failures.length === 1 ? '' : 's'}.`
      );
      error.status = failures[0].error?.status || 503;
      error.cause = failures[0].error;
      throw error;
    }
    return { ok: true, stopped_session_ids: stopped };
  }

  publicRecord(record, exists) {
    return {
      exists,
      session_id: record.session_id,
      generation: record.generation,
      gate_port: record.gate_port,
      slot: record.slot,
      status: record.status,
      expires_at: record.expires_at,
    };
  }
}
