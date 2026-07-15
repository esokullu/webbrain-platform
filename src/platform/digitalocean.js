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
    return {
      droplet_id: String(parsed.droplet?.id || ''),
      public_ip: findPublicIp(parsed.droplet),
      status: 'provisioning',
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
}

export class NullProvisioner {
  constructor() {
    this.created = [];
    this.createdOptions = [];
    this.destroyed = [];
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
