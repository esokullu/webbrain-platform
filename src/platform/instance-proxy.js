import http from 'node:http';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import {
  DOWNLOADS_PROXY_SIGNATURE_HEADER,
  DOWNLOADS_PROXY_TIMESTAMP_HEADER,
  isDownloadsRequestPath,
  signDownloadsProxyRequest,
  verifyDownloadsBasicAuthorization,
} from '../shared/downloads-access.js';

const SESSION_PREFIX = 'bs_';
const HOST_PREFIX = 'bs-';

export function instanceHostname(sessionId, domain) {
  const id = String(sessionId || '').toLowerCase();
  if (!id.startsWith(SESSION_PREFIX) || !/^[a-z0-9_]+$/.test(id)) {
    throw new Error('Invalid browser session id for instance hostname.');
  }
  return `${HOST_PREFIX}${id.slice(SESSION_PREFIX.length)}.${normalizeDomain(domain)}`;
}

export function sessionIdFromInstanceHost(host, domain) {
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain) return null;
  const hostname = String(host || '').toLowerCase().split(':')[0].replace(/\.$/, '');
  const suffix = `.${normalizedDomain}`;
  if (!hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  if (!label.startsWith(HOST_PREFIX) || !/^bs-[a-z0-9]+$/.test(label)) return null;
  return `${SESSION_PREFIX}${label.slice(HOST_PREFIX.length)}`;
}

export function createInstanceProxy({ store, domain, targetPort = 6081 }) {
  const normalizedDomain = normalizeDomain(domain);
  const wss = new WebSocketServer({ noServer: true });

  async function sessionForRequest(req) {
    const sessionId = sessionIdFromInstanceHost(req.headers.host, normalizedDomain);
    if (!sessionId) return { handled: false, session: null };
    const session = await store.getBrowserSession(sessionId);
    return { handled: true, session };
  }

  async function handleRequest(req, res) {
    const { handled, session } = await sessionForRequest(req);
    if (!handled) return false;
    if (!session || !session.public_ip || ['stopping', 'stopped', 'destroyed', 'failed'].includes(session.status)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Browser instance not found');
      return true;
    }

    const isDownloads = isDownloadsRequestPath(req.url);
    if (isDownloads && !isHttpsRequest(req)) {
      res.writeHead(400, {
        'cache-control': 'private, no-store',
        'content-type': 'text/plain; charset=utf-8',
      });
      res.end('Downloads access requires HTTPS');
      return true;
    }
    if (isDownloads && !verifyDownloadsBasicAuthorization(req.headers.authorization, session.connect_secret)) {
      res.writeHead(401, {
        'cache-control': 'private, no-store',
        'content-type': 'text/plain; charset=utf-8',
        'www-authenticate': 'Basic realm="WebBrain Downloads", charset="UTF-8"',
      });
      res.end('Downloads authentication required');
      return true;
    }

    const headers = upstreamHeaders(req, session.public_ip, targetPort);
    if (isDownloads) {
      delete headers.authorization;
      const signed = signDownloadsProxyRequest(session.connect_secret, {
        method: req.method,
        path: req.url,
      });
      headers[DOWNLOADS_PROXY_TIMESTAMP_HEADER] = signed.timestamp;
      headers[DOWNLOADS_PROXY_SIGNATURE_HEADER] = signed.signature;
    }
    const upstreamReq = http.request({
      hostname: session.public_ip,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers,
    }, upstreamRes => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstreamReq.on('error', error => {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('Browser instance is unavailable');
    });
    req.pipe(upstreamReq);
    return true;
  }

  function attach(server) {
    server.on('upgrade', async (req, socket, head) => {
      let lookup;
      try {
        lookup = await sessionForRequest(req);
      } catch {
        socket.destroy();
        return;
      }
      if (!lookup.handled) return;
      const session = lookup.session;
      if (!session || !session.public_ip || ['stopping', 'stopped', 'destroyed', 'failed'].includes(session.status)) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      if (isDownloadsRequestPath(req.url)) {
        socket.write('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, client => {
        const protocols = websocketProtocols(req);
        const upstream = new WebSocket(
          `ws://${session.public_ip}:${targetPort}${req.url}`,
          protocols.length ? protocols : undefined,
          { headers: websocketUpstreamHeaders(req) }
        );
        const pending = [];
        client.on('message', data => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
          else if (upstream.readyState === WebSocket.CONNECTING) pending.push(data);
        });
        client.on('close', () => upstream.close());
        upstream.once('open', () => {
          for (const data of pending.splice(0)) upstream.send(data);
        });
        upstream.on('message', data => {
          if (client.readyState === WebSocket.OPEN) client.send(data);
        });
        upstream.on('close', () => client.close());
        upstream.once('error', () => client.close());
      });
    });
  }

  function close() {
    for (const client of wss.clients) client.terminate();
    return new Promise(resolve => wss.close(() => resolve()));
  }

  return { attach, close, handleRequest };
}

function normalizeDomain(domain) {
  return String(domain || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
}

function isHttpsRequest(req) {
  if (req.socket?.encrypted === true) return true;
  return String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase() === 'https';
}

function upstreamHeaders(req, hostname, port) {
  const headers = { ...req.headers, host: `${hostname}:${port}` };
  return headers;
}

function websocketUpstreamHeaders(req) {
  const headers = {};
  for (const name of ['cookie', 'origin', 'user-agent', 'x-forwarded-for', 'x-forwarded-proto']) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  return headers;
}

function websocketProtocols(req) {
  return String(req.headers['sec-websocket-protocol'] || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}
