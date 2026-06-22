import http from 'node:http';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { verifyNoVncToken } from '../shared/novnc-token.js';

function proxyHeaders(req) {
  const headers = { ...req.headers };
  delete headers.host;
  return headers;
}

export function createNoVncGate({
  secret,
  target = 'http://127.0.0.1:6080',
}) {
  if (!secret) throw new Error('NoVNC gate requires WEBBRAIN_NOVNC_SECRET.');
  const targetUrl = new URL(target);
  const wss = new WebSocketServer({ noServer: true });

  function validate(req) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const token = url.searchParams.get('token') || req.headers.cookie?.match(/wbp_novnc=([^;]+)/)?.[1];
    const verified = verifyNoVncToken(token, secret);
    return verified.ok ? { ok: true, token } : verified;
  }

  const server = http.createServer((req, res) => {
    const auth = validate(req);
    if (!auth.ok) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end(auth.error || 'Unauthorized');
      return;
    }
    const upstreamPath = req.url;
    const upstreamReq = http.request({
      hostname: targetUrl.hostname,
      port: targetUrl.port || 80,
      method: req.method,
      path: upstreamPath,
      headers: proxyHeaders(req),
    }, upstreamRes => {
      const headers = { ...upstreamRes.headers };
      headers['set-cookie'] = [`wbp_novnc=${encodeURIComponent(auth.token)}; Path=/; HttpOnly; SameSite=Lax`];
      res.writeHead(upstreamRes.statusCode || 502, headers);
      upstreamRes.pipe(res);
    });
    upstreamReq.on('error', e => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(e.message);
    });
    req.pipe(upstreamReq);
  });

  server.on('upgrade', (req, socket, head) => {
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
      upstream.once('open', () => {
        client.on('message', data => upstream.send(data));
        upstream.on('message', data => client.send(data));
        client.on('close', () => upstream.close());
        upstream.on('close', () => client.close());
      });
      upstream.once('error', () => client.close());
    });
  });

  return {
    server,
    listen(port, host = '0.0.0.0') {
      return new Promise(resolve => server.listen(port, host, () => resolve(server.address())));
    },
    close() {
      return new Promise(resolve => wss.close(() => server.close(resolve)));
    },
  };
}
