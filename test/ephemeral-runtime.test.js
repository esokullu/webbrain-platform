import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EphemeralRuntimeManager } from '../src/droplet/ephemeral-runtime-manager.js';

test('ephemeral runtime manager uses a volatile hardened systemd unit and cleans stopped sessions', async () => {
  const launchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-ephemeral-manager-'));
  const commands = [];
  let launchedEnvText = '';
  let unitActive = true;
  const manager = new EphemeralRuntimeManager({
    env: {
      WEBBRAIN_EPHEMERAL_LAUNCH_DIR: launchDir,
      WEBBRAIN_APP_DIR: '/opt/webbrain-platform',
      WEBBRAIN_PLATFORM_URL: 'https://webbrain.cloud',
      WEBBRAIN_CONTROL_WS_URL: 'wss://webbrain.cloud/droplet/control',
      WEBBRAIN_EPHEMERAL_GATE_BASE_PORT: '6200',
      WEBBRAIN_EPHEMERAL_MAX_SESSIONS: '1',
      WEBBRAIN_EPHEMERAL_MEMORY_MAX: '1536M',
      WEBBRAIN_EPHEMERAL_DISK_MAX_BYTES: '1073741824',
      WEBBRAIN_EPHEMERAL_DOWNLOAD_TOTAL_LIMIT_BYTES: '268435456',
    },
    portReachable: async (port, host) => {
      assert.equal(port, 6200);
      assert.equal(host, '127.200.0.1');
    },
    execFileImpl: async (command, args) => {
      commands.push([command, args]);
      if (command === 'systemd-run') {
        launchedEnvText = await fs.readFile(path.join(launchDir, 'bs_ephemeral1.env'), 'utf8');
      }
      if (command === 'systemctl' && args[0] === 'is-active' && !unitActive) {
        throw new Error('inactive');
      }
      if (command === 'systemctl' && args[0] === 'stop') unitActive = false;
      return { stdout: '', stderr: '' };
    },
  });

  try {
    const started = await manager.start({
      session_id: 'bs_ephemeral1',
      session_token: 'child-secret',
      provider_api_key: 'provider-secret',
      proxy_url: 'http://user:pass@proxy.example:8080/',
      webbrain_config_b64: 'encoded-webbrain-config',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(started.exists, true);
    assert.equal(started.gate_port, 6200);
    assert.match(started.generation, /^eph_[a-f0-9]{24}$/);

    const run = commands.find(([command]) => command === 'systemd-run');
    assert.ok(run);
    assert.equal(run[1].includes('RuntimeDirectory=webbrain-ephemeral/bs_ephemeral1'), true);
    assert.equal(run[1].includes('RuntimeDirectoryPreserve=no'), true);
    assert.equal(run[1].includes('DynamicUser=yes'), true);
    assert.equal(run[1].includes('PrivateTmp=yes'), true);
    assert.equal(run[1].includes('ProtectSystem=strict'), true);
    assert.equal(run[1].includes('ReadWritePaths=/tmp'), true);
    assert.equal(run[1].includes('MemoryMax=1536M'), true);
    assert.equal(run[1].includes('IPAddressDeny=127.0.0.0/8 ::1/128 169.254.0.0/16'), true);
    assert.equal(run[1].includes('IPAddressAllow=127.200.0.1/32'), true);
    assert.equal(run[1].some(value => String(value).includes('InaccessiblePaths=-/mnt/webbrain-profile')), true);

    assert.match(launchedEnvText, /WEBBRAIN_EPHEMERAL="true"/);
    assert.match(launchedEnvText, /WEBBRAIN_SESSION_TOKEN="child-secret"/);
    assert.match(launchedEnvText, /WEBBRAIN_CONFIG_B64="encoded-webbrain-config"/);
    assert.match(launchedEnvText, /WEBBRAIN_NOVNC_GATE_PORT="6200"/);
    assert.match(launchedEnvText, /WEBBRAIN_RUNTIME_HOST="127\.200\.0\.1"/);
    assert.match(launchedEnvText, /WEBBRAIN_EPHEMERAL_DATA_DIR="\/tmp\/webbrain-ephemeral-data"/);
    assert.match(launchedEnvText, /WEBBRAIN_EPHEMERAL_DISK_MAX_BYTES="1073741824"/);
    assert.match(launchedEnvText, /WEBBRAIN_DOWNLOADS_TOTAL_LIMIT_BYTES="268435456"/);
    assert.doesNotMatch(launchedEnvText, /\/mnt\/webbrain-profile/);
    await assert.rejects(fs.access(path.join(launchDir, 'bs_ephemeral1.env')));

    await assert.rejects(
      manager.start({
        session_id: 'bs_ephemeral2',
        session_token: 'other-secret',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
      error => error.status === 409 && /capacity/.test(error.message)
    );

    const stopped = await manager.stop({ session_id: 'bs_ephemeral1' });
    assert.equal(stopped.existed, true);
    await assert.rejects(fs.access(path.join(launchDir, 'bs_ephemeral1.env')));
    assert.equal((await manager.status({ session_id: 'bs_ephemeral1' })).exists, false);
  } finally {
    await fs.rm(launchDir, { recursive: true, force: true });
  }
});

test('ephemeral runtime manager forgets a crashed transient unit instead of reusing its profile', async () => {
  const launchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-ephemeral-crash-'));
  let active = true;
  const manager = new EphemeralRuntimeManager({
    env: {
      WEBBRAIN_EPHEMERAL_LAUNCH_DIR: launchDir,
      WEBBRAIN_EPHEMERAL_MAX_SESSIONS: '1',
    },
    portReachable: async () => true,
    execFileImpl: async (command, args) => {
      if (command === 'systemctl' && args[0] === 'is-active' && !active) {
        throw Object.assign(new Error('inactive'), { code: 3 });
      }
      return { stdout: '', stderr: '' };
    },
  });

  try {
    await manager.start({
      session_id: 'bs_crashed1',
      session_token: 'secret',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    active = false;
    assert.equal((await manager.status({ session_id: 'bs_crashed1' })).exists, false);
    await assert.rejects(fs.access(path.join(launchDir, 'bs_crashed1.env')));
  } finally {
    await fs.rm(launchDir, { recursive: true, force: true });
  }
});

test('ephemeral runtime manager retains units until failed systemd cleanup can be retried', async () => {
  const launchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-ephemeral-retry-'));
  let stopFailures = 1;
  const manager = new EphemeralRuntimeManager({
    env: {
      WEBBRAIN_EPHEMERAL_LAUNCH_DIR: launchDir,
      WEBBRAIN_EPHEMERAL_MAX_SESSIONS: '1',
    },
    portReachable: async () => {
      throw new Error('viewer gate failed');
    },
    execFileImpl: async (command, args) => {
      if (command === 'systemctl' && args[0] === 'stop' && stopFailures > 0) {
        stopFailures -= 1;
        throw new Error('systemd bus unavailable');
      }
      return { stdout: '', stderr: '' };
    },
  });

  try {
    await assert.rejects(manager.start({
      session_id: 'bs_retryunit',
      session_token: 'secret',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }), /viewer gate failed/);
    const stopped = await manager.stop({ session_id: 'bs_retryunit' });
    assert.equal(stopped.existed, true);
    assert.equal((await manager.status({ session_id: 'bs_retryunit' })).exists, false);
  } finally {
    await fs.rm(launchDir, { recursive: true, force: true });
  }
});

test('ephemeral runtime manager does not acknowledge stop_all when any unit remains', async () => {
  const launchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-ephemeral-stop-all-'));
  let failStops = false;
  const manager = new EphemeralRuntimeManager({
    env: {
      WEBBRAIN_EPHEMERAL_LAUNCH_DIR: launchDir,
      WEBBRAIN_EPHEMERAL_MAX_SESSIONS: '1',
    },
    portReachable: async () => true,
    execFileImpl: async (command, args) => {
      if (command === 'systemctl' && args[0] === 'stop' && failStops) {
        throw new Error('systemctl stop failed');
      }
      return { stdout: '', stderr: '' };
    },
  });

  try {
    await manager.start({
      session_id: 'bs_stopall',
      session_token: 'secret',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    failStops = true;
    await assert.rejects(manager.stopAll(), /Failed to stop 1 ephemeral browser runtime/);
    failStops = false;
    assert.deepEqual((await manager.stopAll()).stopped_session_ids, ['bs_stopall']);
  } finally {
    await fs.rm(launchDir, { recursive: true, force: true });
  }
});

test('ephemeral runtime manager discards untracked units and launch secrets after a parent restart', async () => {
  const launchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-ephemeral-restart-'));
  await fs.writeFile(path.join(launchDir, 'stale.env'), 'WEBBRAIN_SESSION_TOKEN=\"stale-secret\"\\n');
  const commands = [];
  const manager = new EphemeralRuntimeManager({
    env: { WEBBRAIN_EPHEMERAL_LAUNCH_DIR: launchDir },
    execFileImpl: async (command, args) => {
      commands.push([command, args]);
      return { stdout: '', stderr: '' };
    },
  });

  try {
    await manager.discardStaleRuntimes();
    assert.deepEqual(commands, [[
      'systemctl',
      ['stop', 'webbrain-ephemeral-*.service'],
    ]]);
    assert.deepEqual(await fs.readdir(launchDir), []);
  } finally {
    await fs.rm(launchDir, { recursive: true, force: true });
  }
});

test('ephemeral worker keeps writable data in private temporary storage with an aggregate limit', async () => {
  const source = await fs.readFile(
    new URL('../src/droplet/ephemeral-worker.js', import.meta.url),
    'utf8'
  );
  assert.match(source, /WEBBRAIN_EPHEMERAL_DATA_DIR \|\| '\/tmp\/webbrain-ephemeral-data'/);
  assert.match(source, /WEBBRAIN_EPHEMERAL_DISK_MAX_BYTES/);
  assert.match(source, /setInterval\(\(\) => void enforceDiskLimit\(\), 2000\)/);
  assert.match(source, /WEBBRAIN_REMOTE_DEBUGGING_ADDRESS: runtimeHost/);
  assert.match(source, /WEBBRAIN_SIDECAR_HOST: runtimeHost/);
  assert.match(source, /WEBBRAIN_DOWNLOADS_HOST: runtimeHost/);
});
