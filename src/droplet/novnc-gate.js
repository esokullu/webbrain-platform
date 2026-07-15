import http from 'node:http';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import {
  DOWNLOADS_PROXY_SIGNATURE_HEADER,
  DOWNLOADS_PROXY_TIMESTAMP_HEADER,
  isDownloadsRequestPath,
  verifyDownloadsProxyRequest,
} from '../shared/downloads-access.js';
import { verifyNoVncToken } from '../shared/novnc-token.js';

function proxyHeaders(req, { stripAuthorization = false } = {}) {
  const headers = { ...req.headers };
  delete headers.host;
  if (stripAuthorization) delete headers.authorization;
  delete headers[DOWNLOADS_PROXY_SIGNATURE_HEADER];
  delete headers[DOWNLOADS_PROXY_TIMESTAMP_HEADER];
  return headers;
}

export function createNoVncGate({
  secret,
  target = 'http://127.0.0.1:6080',
  downloadsTarget = '',
  downloadsSecret = secret,
}) {
  if (!secret) throw new Error('NoVNC gate requires WEBBRAIN_NOVNC_SECRET.');
  const targetUrl = new URL(target);
  const downloadsTargetUrl = downloadsTarget ? new URL(downloadsTarget) : null;
  const wss = new WebSocketServer({ noServer: true });

  function validate(req) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const token = url.searchParams.get('token') || req.headers.cookie?.match(/wbp_novnc=([^;]+)/)?.[1];
    const verified = verifyNoVncToken(token, secret);
    return verified.ok ? { ok: true, token } : verified;
  }

  const server = http.createServer((req, res) => {
    if (isDownloadsRequestPath(req.url)) {
      const authorized = downloadsTargetUrl && verifyDownloadsProxyRequest(downloadsSecret, {
        timestamp: req.headers[DOWNLOADS_PROXY_TIMESTAMP_HEADER],
        signature: req.headers[DOWNLOADS_PROXY_SIGNATURE_HEADER],
        method: req.method,
        path: req.url,
      });
      if (!authorized) {
        res.writeHead(401, {
          'cache-control': 'private, no-store',
          'content-type': 'text/plain; charset=utf-8',
        });
        res.end('Unauthorized downloads proxy request');
        return;
      }
      proxyHttpRequest(req, res, downloadsTargetUrl, { stripAuthorization: true });
      return;
    }

    const auth = validate(req);
    if (!auth.ok) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end(auth.error || 'Unauthorized');
      return;
    }
    proxyHttpRequest(req, res, targetUrl, { noVncToken: auth.token });
  });

  server.on('upgrade', (req, socket, head) => {
    if (isDownloadsRequestPath(req.url)) {
      socket.write('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const auth = validate(req);
    if (!auth.ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, client => {
      const upstream = new WebSocket(`ws://${targetUrl.hostname}:${targetUrl.port || 80}${req.url}`, {
        headers: proxyHeaders(req),
      });
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

  function proxyHttpRequest(req, res, upstreamUrl, { noVncToken = '', stripAuthorization = false } = {}) {
    const upstreamReq = http.request({
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || 80,
      method: req.method,
      path: req.url,
      headers: proxyHeaders(req, { stripAuthorization }),
    }, upstreamRes => {
      const headers = { ...upstreamRes.headers };
      if (noVncToken) {
        const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
        headers['set-cookie'] = [`wbp_novnc=${encodeURIComponent(noVncToken)}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`];
      }
      res.writeHead(upstreamRes.statusCode || 502, headers);
      upstreamRes.pipe(res);
    });
    upstreamReq.on('error', e => {
      if (res.headersSent) return res.destroy(e);
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(e.message);
    });
    req.pipe(upstreamReq);
  }

  return {
    server,
    listen(port, host = '0.0.0.0') {
      return new Promise(resolve => server.listen(port, host, () => resolve(server.address())));
    },
    close() {
      for (const client of wss.clients) client.terminate();
      return new Promise(resolve => wss.close(() => server.close(resolve)));
    },
  };
}
