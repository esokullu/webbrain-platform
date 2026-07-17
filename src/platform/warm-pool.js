import { randomId, randomSecret, nowIso } from '../shared/ids.js';

const ASSIGNABLE_POOL_STATUSES = new Set(['creating', 'ready']);

function safeError(error) {
  return String(error?.message || error || 'Unknown warm pool error').slice(0, 500);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class WarmDropletPool {
  constructor({ store, provisioner, controlChannel, config }) {
    this.store = store;
    this.provisioner = provisioner;
    this.controlChannel = controlChannel;
    this.config = config;
    this.reconcilePromise = null;
  }

  get desiredSize() {
    return Math.max(0, Number(this.config.warmDropletPool?.size || 0));
  }

  get region() {
    return this.config.digitalOcean.region;
  }

  get size() {
    return this.config.warmDropletPool?.dropletSize || this.config.digitalOcean.size;
  }

  get claimWaitMs() {
    return Math.max(0, Number(this.config.warmDropletPool?.claimWaitMs || 0));
  }

  get claimPollMs() {
    return Math.max(250, Number(this.config.warmDropletPool?.claimPollMs || 2000));
  }

  triggerReconcile() {
    this.reconcile().catch(error => {
      console.error('[warm-pool]', error.message || error);
    });
  }

  async reconcile() {
    if (this.reconcilePromise) return await this.reconcilePromise;
    this.reconcilePromise = this.reconcileOnce().finally(() => {
      this.reconcilePromise = null;
    });
    return await this.reconcilePromise;
  }

  async reconcileOnce() {
    const desired = this.desiredSize;
    const droplets = await this.store.listWarmDroplets();

    for (const droplet of droplets) {
      if (droplet.assigned_session_id) continue;
      if (droplet.status === 'destroying') continue;
      if (desired <= 0 || !ASSIGNABLE_POOL_STATUSES.has(droplet.status) || droplet.region !== this.region || droplet.size !== this.size) {
        await this.destroyUnassignedDroplet(droplet, desired <= 0 ? 'Warm pool disabled or scaled down.' : 'Warm pool shape changed.');
      }
    }

    const refreshed = await this.refreshCreatingDroplets();
    const candidates = refreshed.filter(droplet => (
      !droplet.assigned_session_id
      && droplet.region === this.region
      && droplet.size === this.size
      && ['creating', 'ready'].includes(droplet.status)
    ));
    const ready = candidates.filter(droplet => (
      droplet.status === 'ready' && this.controlChannel.isPoolConnected(droplet.id)
    ));
    const pending = candidates.filter(droplet => (
      droplet.status === 'creating'
      || (droplet.status === 'ready' && !this.controlChannel.isPoolConnected(droplet.id))
    ));
    const extra = [...ready, ...pending].slice(desired);
    for (const droplet of extra) {
      await this.destroyUnassignedDroplet(droplet, 'Warm pool has excess unassigned capacity.');
    }

    const capacity = Math.min(desired, ready.length + pending.length);
    const needed = Math.max(0, desired - capacity);
    for (let i = 0; i < needed; i += 1) {
      await this.createWarmDroplet();
    }
  }

  async refreshCreatingDroplets() {
    const rows = [];
    for (let droplet of await this.store.listWarmDroplets()) {
      if (droplet.assigned_session_id || droplet.status !== 'creating' || !droplet.droplet_id) {
        rows.push(droplet);
        continue;
      }
      try {
        const state = await this.provisioner.getDropletState(droplet.droplet_id);
        if (!state) {
          droplet = await this.store.updateWarmDroplet(droplet.id, {
            status: 'failed',
            last_error: 'Warm Droplet no longer exists.',
            updated_at: nowIso(),
          });
        } else if (state.public_ip && state.public_ip !== droplet.public_ip) {
          droplet = await this.store.updateWarmDroplet(droplet.id, {
            public_ip: state.public_ip,
            updated_at: nowIso(),
          });
        }
        if (state?.status === 'active' && this.controlChannel.isPoolConnected(droplet.id)) {
          droplet = await this.store.updateWarmDropletIfStatus(droplet.id, 'creating', {
            status: 'ready',
            public_ip: state.public_ip || droplet.public_ip,
            last_error: null,
            updated_at: nowIso(),
          }) || droplet;
        }
      } catch (error) {
        droplet = await this.store.updateWarmDroplet(droplet.id, {
          status: 'failed',
          last_error: safeError(error),
          updated_at: nowIso(),
        });
      }
      rows.push(droplet);
    }
    return rows;
  }

  async createWarmDroplet() {
    const now = nowIso();
    const row = await this.store.createWarmDroplet({
      id: randomId('wd'),
      droplet_id: null,
      public_ip: null,
      region: this.region,
      size: this.size,
      status: 'creating',
      assigned_session_id: null,
      pool_token: randomSecret(32),
      last_error: null,
      created_at: now,
      updated_at: now,
    });
    try {
      const created = await this.provisioner.createWarmDroplet(row, {
        region: row.region,
        size: row.size,
      });
      return await this.store.updateWarmDroplet(row.id, {
        droplet_id: created.droplet_id || null,
        public_ip: created.public_ip || null,
        status: created.status || 'creating',
        updated_at: nowIso(),
      });
    } catch (error) {
      return await this.store.updateWarmDroplet(row.id, {
        status: 'failed',
        last_error: safeError(error),
        updated_at: nowIso(),
      });
    }
  }

  async destroyUnassignedDroplet(droplet, reason) {
    const destroying = await this.store.updateWarmDropletIfStatus(droplet.id, droplet.status, {
      status: 'destroying',
      last_error: reason,
      updated_at: nowIso(),
    }).catch(() => null);
    const target = destroying || droplet;
    if (target.droplet_id) {
      await this.provisioner.destroyDroplet(target.droplet_id).catch(error => {
        console.error('[warm-pool] destroy failed:', error.message || error);
      });
    }
    return await this.store.updateWarmDroplet(target.id, {
      droplet_id: null,
      public_ip: null,
      status: 'destroying',
      updated_at: nowIso(),
    });
  }

  async hasCreatingCandidate(session) {
    const region = session.region || this.region;
    const size = session.size || this.size;
    return (await this.store.listWarmDroplets()).some(droplet => (
      !droplet.assigned_session_id
      && droplet.region === region
      && droplet.size === size
      && droplet.status === 'creating'
    ));
  }

  async claimReadyCandidate(session) {
    const claimed = await this.store.claimReadyWarmDroplet({
      region: session.region || this.region,
      size: session.size || this.size,
      sessionId: session.id,
      now: nowIso(),
    });
    if (!claimed) return null;
    if (!this.controlChannel.isPoolConnected(claimed.id)) {
      await this.store.updateWarmDroplet(claimed.id, {
        status: 'creating',
        assigned_session_id: null,
        last_error: 'Warm Droplet was not connected when claim started.',
        updated_at: nowIso(),
      });
      return null;
    }
    return claimed;
  }

  async assignClaimedDroplet(claimed, session, { providerApiKey = '', proxyUrl = '' } = {}) {
    try {
      if (session.volume_id) {
        const action = await this.provisioner.attachVolumeToDroplet(
          session.volume_id,
          claimed.droplet_id,
          session.region || claimed.region
        );
        if (action.action_id && action.status !== 'completed') {
          await this.provisioner.waitForAction(action.action_id);
        }
        await this.provisioner.waitForVolumeAttached(session.volume_id, claimed.droplet_id);
      }
      await this.controlChannel.sendPool(claimed.id, 'assign', {
        session_id: session.id,
        session_token: session.connect_secret,
        provider_api_key: providerApiKey || session.connect_secret,
        proxy_url: proxyUrl || '',
        volume_id: session.volume_id || '',
        volume_name: session.volume_name || '',
        profile_mount: this.config.droplet.profileMount,
        downloads_sync_enabled: String(Boolean(session.volume_id && this.config.downloads?.spaces?.enabled)),
      }, this.config.warmDropletPool?.assignTimeoutMs || 90000);
      await this.store.updateWarmDroplet(claimed.id, {
        status: 'assigned',
        assigned_session_id: session.id,
        last_error: null,
        updated_at: nowIso(),
      });
      this.triggerReconcile();
      return {
        droplet_id: claimed.droplet_id,
        public_ip: claimed.public_ip,
        status: 'provisioning',
        warm_pool_id: claimed.id,
      };
    } catch (error) {
      await this.store.updateWarmDroplet(claimed.id, {
        status: 'failed',
        assigned_session_id: null,
        last_error: safeError(error),
        updated_at: nowIso(),
      }).catch(() => {});
      if (claimed.droplet_id) {
        await this.provisioner.destroyDroplet(claimed.droplet_id).catch(() => {});
      }
      if (session.volume_id) {
        await this.provisioner.waitForVolumeDetached(session.volume_id).catch(() => {});
      }
      this.triggerReconcile();
      return null;
    }
  }

  async tryAssignSession(session, { providerApiKey = '', proxyUrl = '' } = {}) {
    if (this.desiredSize <= 0) return null;
    const deadline = Date.now() + this.claimWaitMs;

    while (true) {
      const claimed = await this.claimReadyCandidate(session);
      if (claimed) {
        return await this.assignClaimedDroplet(claimed, session, { providerApiKey, proxyUrl });
      }

      if (this.claimWaitMs <= 0 || Date.now() >= deadline) {
        this.triggerReconcile();
        return null;
      }

      await this.reconcile();

      const reconciledClaim = await this.claimReadyCandidate(session);
      if (reconciledClaim) {
        return await this.assignClaimedDroplet(reconciledClaim, session, { providerApiKey, proxyUrl });
      }

      if (!await this.hasCreatingCandidate(session)) {
        this.triggerReconcile();
        return null;
      }

      await sleep(Math.min(this.claimPollMs, Math.max(0, deadline - Date.now())));
    }
  }
}
