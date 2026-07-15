import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { Server as ProxyChainServer } from 'proxy-chain';
import { normalizeProxyUrl, publicProxyState } from '../shared/proxy.js';

const DEFAULT_VERIFY_URL = 'http://api.ipify.org?format=json';

function isoNow() {
  return new Date().toISOString();
}

function safeRequestError(error) {
  return error?.code ? ` (${error.code})` : '';
}

export class BrowserProxyRelay {
  constructor({
    host = '127.0.0.1',
    port = 17890,
    initialProxyUrl = '',
    statePath = '/var/lib/webbrain/proxy.json',
    verifyUrl = DEFAULT_VERIFY_URL,
    verifyTimeoutMs = 10000,
    serverFactory,
  } = {}) {
    this.host = host;
    this.port = Number(port);
    this.initialProxyUrl = normalizeProxyUrl(initialProxyUrl);
    this.statePath = statePath;
    this.verifyUrl = verifyUrl;
    this.verifyTimeoutMs = Number(verifyTimeoutMs);
    this.serverFactory = serverFactory || (options => new ProxyChainServer(options));
    this.server = null;
    this.proxyUrl = '';
    this.updatedAt = null;
    this.verifiedAt = null;
    this.exitIp = null;
  }

  async start({ verifyInitial = true } = {}) {
    if (this.server) return this.status();
    const saved = await this.loadState();
    this.proxyUrl = normalizeProxyUrl(saved?.upstream_proxy_url || this.initialProxyUrl);
    this.updatedAt = saved?.updated_at || (this.proxyUrl ? isoNow() : null);
    this.verifiedAt = saved?.verified_at || null;
    this.exitIp = saved?.exit_ip || null;

    this.server = this.serverFactory({
      host: this.host,
      port: this.port,
      verbose: false,
      prepareRequestFunction: () => ({ upstreamProxyUrl: this.proxyUrl || null }),
    });
    await this.server.listen();
    this.port = this.server.port;

    if (verifyInitial && this.proxyUrl && this.verifyUrl) {
      const verified = await this.verify();
      this.exitIp = verified.exit_ip;
      this.verifiedAt = verified.verified_at;
      await this.persistState();
    }
    return this.status();
  }

  async update(proxyUrl, { verify = true, verifyUrl = this.verifyUrl } = {}) {
    if (!this.server) throw new Error('Browser proxy relay is not running');
    const nextProxyUrl = normalizeProxyUrl(proxyUrl);
    const previous = {
      proxyUrl: this.proxyUrl,
      updatedAt: this.updatedAt,
      verifiedAt: this.verifiedAt,
      exitIp: this.exitIp,
    };

    this.proxyUrl = nextProxyUrl;
    this.updatedAt = isoNow();
    this.verifiedAt = null;
    this.exitIp = null;
    this.server.closeConnections();

    try {
      if (verify && verifyUrl) {
        const verified = await this.verify(verifyUrl);
        this.exitIp = verified.exit_ip;
        this.verifiedAt = verified.verified_at;
      }
      await this.persistState();
      return this.status();
    } catch (error) {
      this.proxyUrl = previous.proxyUrl;
      this.updatedAt = previous.updatedAt;
      this.verifiedAt = previous.verifiedAt;
      this.exitIp = previous.exitIp;
      this.server.closeConnections();
      throw error;
    }
  }

  async verify(verifyUrl = this.verifyUrl) {
    let target;
    try {
      target = new URL(verifyUrl);
    } catch {
      throw new Error('Proxy verification URL is invalid');
    }
    if (target.protocol !== 'http:') {
      throw new Error('Proxy verification URL must use HTTP');
    }

    const body = await new Promise((resolve, reject) => {
      const req = http.request({
        host: this.host,
        port: this.port,
        method: 'GET',
        path: target.toString(),
        headers: {
          accept: 'application/json, text/plain;q=0.9',
          connection: 'close',
          host: target.host,
        },
      }, res => {
        const chunks = [];
        let length = 0;
        res.on('data', chunk => {
          length += chunk.length;
          if (length > 8192) {
            req.destroy(new Error('Proxy verification response is too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Proxy verification failed with status ${res.statusCode}`));
            return;
          }
          resolve(Buffer.concat(chunks).toString('utf8').trim());
        });
      });
      req.setTimeout(this.verifyTimeoutMs, () => req.destroy(Object.assign(new Error('Proxy verification timed out'), { code: 'ETIMEDOUT' })));
      req.once('error', error => reject(new Error(`Proxy verification request failed${safeRequestError(error)}`)));
      req.end();
    });

    let exitIp = body;
    try {
      const parsed = JSON.parse(body);
      exitIp = parsed.ip || parsed.query || '';
    } catch {
      // Plain-text IP services are supported too.
    }
    exitIp = String(exitIp).trim();
    if (!net.isIP(exitIp)) throw new Error('Proxy verification did not return a valid IP address');
    return { exit_ip: exitIp, verified_at: isoNow() };
  }

  status() {
    return publicProxyState({
      proxyUrl: this.proxyUrl,
      exitIp: this.exitIp,
      updatedAt: this.updatedAt,
      verifiedAt: this.verifiedAt,
    });
  }

  async close() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await server.close(true);
  }

  async loadState() {
    if (!this.statePath) return null;
    try {
      return JSON.parse(await fs.readFile(this.statePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async persistState() {
    if (!this.statePath) return;
    const directory = path.dirname(this.statePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const tempPath = `${this.statePath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify({
      upstream_proxy_url: this.proxyUrl,
      updated_at: this.updatedAt,
      verified_at: this.verifiedAt,
      exit_ip: this.exitIp,
    }), { mode: 0o600 });
    await fs.rename(tempPath, this.statePath);
    await fs.chmod(this.statePath, 0o600);
  }
}
