import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/db/memory.js';
import { NullProvisioner } from '../src/platform/digitalocean.js';
import { loadConfig } from '../src/platform/config.js';
import { WarmDropletPool } from '../src/platform/warm-pool.js';

function config(env = {}) {
  return loadConfig({
    WEBBRAIN_DB_DRIVER: 'memory',
    WEBBRAIN_WARM_DROPLET_POOL_SIZE: '1',
    WEBBRAIN_WARM_DROPLET_SIZE: 's-2vcpu-4gb',
    WEBBRAIN_WARM_DROPLET_CLAIM_WAIT_MS: '0',
    ...env,
  });
}

function fakeControlChannel() {
  const connected = new Set();
  const sent = [];
  return {
    connected,
    sent,
    isPoolConnected(id) {
      return connected.has(id);
    },
    async sendPool(id, action, payload) {
      sent.push({ id, action, payload });
      return { ok: true };
    },
  };
}

function browserSession(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: 'bs_pool',
    user_id: 'usr_pool',
    display_name: 'Pool test',
    status: 'provisioning',
    droplet_id: null,
    public_ip: null,
    region: 'nyc3',
    size: 's-2vcpu-4gb',
    volume_id: 'vol-pool',
    volume_name: 'wb-profile-bs-pool',
    volume_size_gib: 2,
    profile_mode: 'persistent',
    host_session_id: null,
    runtime_port: null,
    runtime_generation: null,
    connect_secret: 'session-secret',
    proxy_enabled: false,
    proxy_endpoint: null,
    proxy_updated_at: null,
    paused_at: null,
    ended_at: null,
    end_reason: null,
    expires_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

test('warm pool config defaults off and inherits the browser Droplet size when unset', () => {
  const defaults = loadConfig({ WEBBRAIN_DB_DRIVER: 'memory' });
  assert.equal(defaults.warmDropletPool.size, 0);
  assert.equal(defaults.warmDropletPool.dropletSize, 's-2vcpu-4gb');
  assert.equal(defaults.warmDropletPool.claimWaitMs, 60000);
  assert.equal(defaults.warmDropletPool.claimPollMs, 2000);

  const inheritedSize = loadConfig({ WEBBRAIN_DB_DRIVER: 'memory', DO_SIZE: 's-1vcpu-2gb' });
  assert.equal(inheritedSize.warmDropletPool.size, 0);
  assert.equal(inheritedSize.warmDropletPool.dropletSize, 's-1vcpu-2gb');
});

test('warm pool reconciler creates one configured spare and does nothing when disabled', async () => {
  const store = new MemoryStore();
  const provisioner = new NullProvisioner();
  const controlChannel = fakeControlChannel();
  const pool = new WarmDropletPool({ store, provisioner, controlChannel, config: config() });

  await pool.reconcile();
  assert.equal(provisioner.createdWarmDroplets.length, 1);
  assert.equal((await store.listWarmDroplets()).length, 1);
  assert.equal((await store.listWarmDroplets())[0].status, 'creating');

  const disabled = new WarmDropletPool({
    store: new MemoryStore(),
    provisioner: new NullProvisioner(),
    controlChannel: fakeControlChannel(),
    config: config({ WEBBRAIN_WARM_DROPLET_POOL_SIZE: '0' }),
  });
  await disabled.reconcile();
  assert.equal((await disabled.store.listWarmDroplets()).length, 0);
});

test('warm pool waits for an in-flight spare to become claimable before falling back cold', async () => {
  const store = new MemoryStore();
  const provisioner = new NullProvisioner();
  const controlChannel = fakeControlChannel();
  const pool = new WarmDropletPool({
    store,
    provisioner,
    controlChannel,
    config: config({
      WEBBRAIN_WARM_DROPLET_CLAIM_WAIT_MS: '1000',
      WEBBRAIN_WARM_DROPLET_CLAIM_POLL_MS: '10',
    }),
  });
  const now = new Date().toISOString();
  await store.createWarmDroplet({
    id: 'wd_waiting',
    droplet_id: 'warm-waiting',
    public_ip: '127.0.0.1',
    region: 'nyc3',
    size: 's-2vcpu-4gb',
    status: 'creating',
    assigned_session_id: null,
    pool_token: 'pool-secret',
    last_error: null,
    created_at: now,
    updated_at: now,
  });
  controlChannel.connected.add('wd_waiting');

  const assigned = await pool.tryAssignSession(browserSession({ id: 'bs_waiting' }));
  assert.equal(assigned.droplet_id, 'warm-waiting');
  assert.equal(assigned.warm_pool_id, 'wd_waiting');
  assert.equal(provisioner.created.length, 0);
  assert.equal(controlChannel.sent[0].payload.session_id, 'bs_waiting');
  assert.equal((await store.getWarmDroplet('wd_waiting')).status, 'assigned');
});

test('warm pool destroys excess unassigned creating capacity when a spare is already ready', async () => {
  const store = new MemoryStore();
  const provisioner = new NullProvisioner();
  const controlChannel = fakeControlChannel();
  const pool = new WarmDropletPool({ store, provisioner, controlChannel, config: config() });
  const now = new Date().toISOString();
  await store.createWarmDroplet({
    id: 'wd_ready',
    droplet_id: 'warm-ready',
    public_ip: '127.0.0.1',
    region: 'nyc3',
    size: 's-2vcpu-4gb',
    status: 'ready',
    assigned_session_id: null,
    pool_token: 'ready-secret',
    last_error: null,
    created_at: now,
    updated_at: now,
  });
  await store.createWarmDroplet({
    id: 'wd_extra',
    droplet_id: 'warm-extra',
    public_ip: '127.0.0.2',
    region: 'nyc3',
    size: 's-2vcpu-4gb',
    status: 'creating',
    assigned_session_id: null,
    pool_token: 'extra-secret',
    last_error: null,
    created_at: new Date(Date.now() + 1000).toISOString(),
    updated_at: now,
  });
  controlChannel.connected.add('wd_ready');

  await pool.reconcile();
  assert.deepEqual(provisioner.destroyed, ['warm-extra']);
  assert.equal((await store.getWarmDroplet('wd_ready')).status, 'ready');
  assert.equal((await store.getWarmDroplet('wd_extra')).status, 'destroying');
});

test('warm pool atomically claims one ready droplet and assigns volume-backed sessions', async () => {
  const store = new MemoryStore();
  const provisioner = new NullProvisioner();
  const controlChannel = fakeControlChannel();
  const pool = new WarmDropletPool({ store, provisioner, controlChannel, config: config() });

  await pool.reconcile();
  const warm = (await store.listWarmDroplets())[0];
  controlChannel.connected.add(warm.id);
  await pool.reconcile();
  const ready = await store.getWarmDroplet(warm.id);
  assert.equal(ready.status, 'ready');

  await store.createUser({
    id: 'usr_pool',
    email: 'pool@example.com',
    password_hash: 'hash',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const session = await store.createBrowserSession({
    id: 'bs_pool',
    user_id: 'usr_pool',
    display_name: 'Pool test',
    status: 'provisioning',
    droplet_id: null,
    public_ip: null,
    region: 'nyc3',
    size: 's-2vcpu-4gb',
    volume_id: 'vol-pool',
    volume_name: 'wb-profile-bs-pool',
    volume_size_gib: 2,
    profile_mode: 'persistent',
    host_session_id: null,
    runtime_port: null,
    runtime_generation: null,
    connect_secret: 'session-secret',
    proxy_enabled: false,
    proxy_endpoint: null,
    proxy_updated_at: null,
    paused_at: null,
    ended_at: null,
    end_reason: null,
    expires_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const assigned = await pool.tryAssignSession(session, {
    providerApiKey: 'provider-secret',
    proxyUrl: 'http://proxy.example:8080/',
  });
  assert.equal(assigned.droplet_id, ready.droplet_id);
  assert.equal(assigned.status, 'provisioning');
  assert.deepEqual(provisioner.attachedVolumes, [{
    volumeId: 'vol-pool',
    dropletId: ready.droplet_id,
    region: 'nyc3',
  }]);
  assert.equal(controlChannel.sent.length, 1);
  assert.equal(controlChannel.sent[0].action, 'assign');
  assert.equal(controlChannel.sent[0].payload.session_id, 'bs_pool');
  assert.equal(controlChannel.sent[0].payload.volume_name, 'wb-profile-bs-pool');
  assert.equal(controlChannel.sent[0].payload.proxy_url, 'http://proxy.example:8080/');
  assert.equal((await store.getWarmDroplet(ready.id)).status, 'assigned');

  const second = await pool.tryAssignSession({ ...session, id: 'bs_second' });
  assert.equal(second, null);
});

test('warm pool assigns disposable sessions without attaching a profile volume', async () => {
  const store = new MemoryStore();
  const provisioner = new NullProvisioner();
  const controlChannel = fakeControlChannel();
  const pool = new WarmDropletPool({ store, provisioner, controlChannel, config: config() });

  await pool.reconcile();
  const warm = (await store.listWarmDroplets())[0];
  controlChannel.connected.add(warm.id);
  await pool.reconcile();
  const ready = await store.getWarmDroplet(warm.id);

  const session = await store.createBrowserSession({
    id: 'bs_incognito',
    user_id: 'usr_pool',
    display_name: 'Incognito',
    status: 'provisioning',
    droplet_id: null,
    public_ip: null,
    region: 'nyc3',
    size: 's-2vcpu-4gb',
    volume_id: null,
    volume_name: null,
    volume_size_gib: null,
    profile_mode: 'persistent',
    host_session_id: null,
    runtime_port: null,
    runtime_generation: null,
    connect_secret: 'session-secret',
    proxy_enabled: false,
    proxy_endpoint: null,
    proxy_updated_at: null,
    paused_at: null,
    ended_at: null,
    end_reason: null,
    expires_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const assigned = await pool.tryAssignSession(session);
  assert.equal(assigned.droplet_id, ready.droplet_id);
  assert.deepEqual(provisioner.attachedVolumes, []);
  assert.equal(controlChannel.sent[0].payload.volume_id, '');
  assert.equal(controlChannel.sent[0].payload.volume_name, '');
  assert.equal(controlChannel.sent[0].payload.downloads_sync_enabled, 'false');
});

test('warm pool claim failure fails the warm node and returns null for cold fallback', async () => {
  const store = new MemoryStore();
  const provisioner = new NullProvisioner();
  const controlChannel = fakeControlChannel();
  controlChannel.sendPool = async (id, action, payload) => {
    controlChannel.sent.push({ id, action, payload });
    throw new Error('assignment refused');
  };
  const pool = new WarmDropletPool({ store, provisioner, controlChannel, config: config() });

  await pool.reconcile();
  const warm = (await store.listWarmDroplets())[0];
  controlChannel.connected.add(warm.id);
  await pool.reconcile();
  const ready = await store.getWarmDroplet(warm.id);
  const session = await store.createBrowserSession({
    id: 'bs_failure',
    user_id: 'usr_pool',
    display_name: 'Failure',
    status: 'provisioning',
    droplet_id: null,
    public_ip: null,
    region: 'nyc3',
    size: 's-2vcpu-4gb',
    volume_id: 'vol-failure',
    volume_name: 'wb-profile-bs-failure',
    volume_size_gib: 2,
    profile_mode: 'persistent',
    host_session_id: null,
    runtime_port: null,
    runtime_generation: null,
    connect_secret: 'session-secret',
    proxy_enabled: false,
    proxy_endpoint: null,
    proxy_updated_at: null,
    paused_at: null,
    ended_at: null,
    end_reason: null,
    expires_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const assigned = await pool.tryAssignSession(session);
  assert.equal(assigned, null);
  assert.equal(provisioner.destroyed.includes(ready.droplet_id), true);
  assert.equal(provisioner.attachedVolumes[0].volumeId, 'vol-failure');
  const failed = await store.getWarmDroplet(ready.id);
  assert.equal(['failed', 'destroying'].includes(failed.status), true);
});
