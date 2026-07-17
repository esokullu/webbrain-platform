import net from 'node:net';
import { renderCloudInit } from './cloud-init.js';

export class DigitalOceanProvisioner {
  constructor(config, fetchImpl = fetch, opts = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.isRuntimeReachable = opts.isRuntimeReachable || isTcpReachable;
  }

  async createBrowserDroplet(session, opts = {}) {
    if (!this.config.digitalOcean.token) {
      const e = new Error('DO_API_TOKEN is required to create droplets.');
      e.status = 503;
      throw e;
    }
    if (session.volume_id) await this.waitForVolumeDetached(session.volume_id);
    const body = {
      name: digitalOceanDropletName(session.id),
      region: opts.region || session.region || this.config.digitalOcean.region,
      size: opts.size || session.size || this.config.digitalOcean.size,
      image: opts.image || this.config.digitalOcean.image,
      ssh_keys: opts.sshKeys || this.config.digitalOcean.sshKeys,
      backups: false,
      ipv6: false,
      monitoring: true,
      tags: ['webbrain', `session:${session.id}`],
      volumes: session.volume_id ? [session.volume_id] : undefined,
      user_data: renderCloudInit({
        session,
        config: this.config,
        providerApiKey: opts.providerApiKey || '',
        proxyUrl: opts.proxyUrl || '',
      }),
    };
    const res = await this.fetch('https://api.digitalocean.com/v2/droplets', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.digitalOcean.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`DigitalOcean create failed: ${res.status} ${await res.text()}`);
    const parsed = await res.json();
    if (!parsed.droplet?.id) throw new Error('DigitalOcean create response did not include a Droplet id.');
    return {
      droplet_id: String(parsed.droplet?.id || ''),
      public_ip: findPublicIp(parsed.droplet),
      status: 'provisioning',
      request: body,
    };
  }

  async createBrowserVolume(session, opts = {}) {
    if (!this.config.digitalOcean.token) {
      const e = new Error('DO_API_TOKEN is required to create browser storage.');
      e.status = 503;
      throw e;
    }
    const body = {
      size_gigabytes: Number(opts.sizeGiB || this.config.digitalOcean.volumeSizeGiB || 2),
      name: digitalOceanVolumeName(session.id),
      description: `Persistent Chrome profile for ${session.id}`,
      region: opts.region || session.region || this.config.digitalOcean.region,
      filesystem_type: 'ext4',
      filesystem_label: 'webbrain-profile',
      tags: ['webbrain', `session:${session.id}`],
    };
    const res = await this.fetch('https://api.digitalocean.com/v2/volumes', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.digitalOcean.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`DigitalOcean volume create failed: ${res.status} ${await res.text()}`);
    const parsed = await res.json();
    if (!parsed.volume?.id) throw new Error('DigitalOcean volume create response did not include a volume id.');
    return {
      volume_id: String(parsed.volume?.id || ''),
      volume_name: parsed.volume?.name || body.name,
      volume_size_gib: Number(parsed.volume?.size_gigabytes || body.size_gigabytes),
      request: body,
    };
  }

  async getDroplet(dropletId) {
    if (!this.config.digitalOcean.token) return null;
    const res = await this.fetch(`https://api.digitalocean.com/v2/droplets/${dropletId}`, {
      headers: { authorization: `Bearer ${this.config.digitalOcean.token}` },
    });
    if (!res.ok) return null;
    const parsed = await res.json();
    const publicIp = findPublicIp(parsed.droplet);
    const runtimeReady = parsed.droplet?.status === 'active'
      && publicIp
      && await this.isRuntimeReachable(publicIp, this.config.droplet.noVncGatePort, this.config.droplet.readyTimeoutMs);
    return {
      droplet_id: String(parsed.droplet?.id || dropletId),
      public_ip: publicIp,
      raw_status: parsed.droplet?.status,
      status: runtimeReady ? 'ready' : 'provisioning',
    };
  }

  async destroyDroplet(dropletId) {
    if (!dropletId || !this.config.digitalOcean.token) return { ok: true, skipped: true };
    const res = await this.fetch(`https://api.digitalocean.com/v2/droplets/${dropletId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.config.digitalOcean.token}` },
    });
    if (!res.ok && res.status !== 404) throw new Error(`DigitalOcean delete failed: ${res.status} ${await res.text()}`);
    return { ok: true };
  }

  async powerCycleDroplet(dropletId) {
    if (!dropletId) throw Object.assign(new Error('A Droplet id is required to reset a browser.'), { status: 409 });
    if (!this.config.digitalOcean.token) {
      throw Object.assign(new Error('DO_API_TOKEN is required to reset droplets.'), { status: 503 });
    }
    const res = await this.fetch(`https://api.digitalocean.com/v2/droplets/${dropletId}/actions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.digitalOcean.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'power_cycle' }),
    });
    if (!res.ok) throw new Error(`DigitalOcean power cycle failed: ${res.status} ${await res.text()}`);
    const parsed = await res.json();
    return {
      ok: true,
      action_id: parsed.action?.id ? String(parsed.action.id) : null,
      status: parsed.action?.status || null,
    };
  }

  async getAction(actionId) {
    if (!actionId) throw Object.assign(new Error('A DigitalOcean action id is required.'), { status: 409 });
    if (!this.config.digitalOcean.token) {
      throw Object.assign(new Error('DO_API_TOKEN is required to inspect Droplet actions.'), { status: 503 });
    }
    const res = await this.fetch(`https://api.digitalocean.com/v2/actions/${actionId}`, {
      headers: { authorization: `Bearer ${this.config.digitalOcean.token}` },
    });
    if (!res.ok) throw new Error(`DigitalOcean action lookup failed: ${res.status} ${await res.text()}`);
    const parsed = await res.json();
    if (!parsed.action?.id) throw new Error('DigitalOcean action response did not include an action.');
    return {
      action_id: String(parsed.action.id),
      status: parsed.action.status || null,
    };
  }

  async waitForAction(actionId, { timeoutMs = 120_000, pollIntervalMs = 1000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let latest = null;
    while (Date.now() < deadline) {
      latest = await this.getAction(actionId);
      if (latest.status === 'completed') return latest;
      if (latest.status === 'errored') {
        const error = Object.assign(new Error('DigitalOcean Droplet power cycle failed.'), {
          status: 502,
          code: 'DIGITALOCEAN_ACTION_ERRORED',
        });
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    throw Object.assign(new Error('Timed out waiting for the DigitalOcean Droplet power cycle.'), { status: 504 });
  }

  async getVolume(volumeId) {
    if (!volumeId || !this.config.digitalOcean.token) return null;
    const res = await this.fetch(`https://api.digitalocean.com/v2/volumes/${volumeId}`, {
      headers: { authorization: `Bearer ${this.config.digitalOcean.token}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`DigitalOcean volume lookup failed: ${res.status} ${await res.text()}`);
    return (await res.json()).volume || null;
  }

  async waitForVolumeDetached(volumeId, timeoutMs = 45_000) {
    if (!volumeId) return { ok: true, skipped: true };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const volume = await this.getVolume(volumeId);
      if (!volume) throw Object.assign(new Error('Browser profile volume no longer exists.'), { status: 409 });
      if (!Array.isArray(volume.droplet_ids) || volume.droplet_ids.length === 0) return { ok: true };
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw Object.assign(new Error('Browser profile volume is still detaching; retry shortly.'), { status: 409 });
  }

  async destroyVolume(volumeId) {
    if (!volumeId || !this.config.digitalOcean.token) return { ok: true, skipped: true };
    const res = await this.fetch(`https://api.digitalocean.com/v2/volumes/${volumeId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.config.digitalOcean.token}` },
    });
    if (!res.ok && res.status !== 404) throw new Error(`DigitalOcean volume delete failed: ${res.status} ${await res.text()}`);
    return { ok: true };
  }
}

export class NullProvisioner {
  constructor() {
    this.created = [];
    this.createdOptions = [];
    this.destroyed = [];
    this.createdVolumes = [];
    this.destroyedVolumes = [];
    this.powerCycled = [];
    this.waitedActions = [];
  }

  async createBrowserVolume(session, opts = {}) {
    const volume = {
      volume_id: `mock-volume-${session.id}`,
      volume_name: digitalOceanVolumeName(session.id),
      volume_size_gib: Number(opts.sizeGiB || 2),
      request: null,
    };
    this.createdVolumes.push(volume);
    return volume;
  }

  async createBrowserDroplet(session, opts = {}) {
    this.created.push(session);
    this.createdOptions.push(opts);
    return {
      droplet_id: `mock-${session.id}`,
      public_ip: '127.0.0.1',
      status: 'ready',
      request: null,
    };
  }

  async getDroplet() {
    return null;
  }

  async destroyDroplet(dropletId) {
    this.destroyed.push(dropletId);
    return { ok: true };
  }

  async powerCycleDroplet(dropletId) {
    this.powerCycled.push(dropletId);
    return { ok: true, action_id: `mock-reset-${dropletId}`, status: 'in-progress' };
  }

  async waitForAction(actionId) {
    this.waitedActions.push(actionId);
    return { action_id: actionId, status: 'completed' };
  }

  async waitForVolumeDetached() {
    return { ok: true };
  }

  async destroyVolume(volumeId) {
    this.destroyedVolumes.push(volumeId);
    return { ok: true };
  }
}

export function digitalOceanDropletName(sessionId) {
  const suffix = String(sessionId || 'session')
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 48) || 'session';
  return `webbrain-${suffix}`;
}

export function digitalOceanVolumeName(sessionId) {
  const suffix = String(sessionId || 'session')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 44) || 'session';
  return `wb-profile-${suffix}`;
}

export function isTcpReachable(host, port, timeoutMs = 1000) {
  if (!host || !port) return Promise.resolve(false);
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const finish = ok => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function findPublicIp(droplet) {
  const networks = droplet?.networks?.v4 || [];
  return networks.find(n => n.type === 'public')?.ip_address || '';
}
