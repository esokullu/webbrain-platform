import { URL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

export class DropletControlChannel {
  constructor({ store, requestTimeoutMs = 15000 }) {
    this.store = store;
    this.requestTimeoutMs = requestTimeoutMs;
    this.wss = new WebSocketServer({ noServer: true });
    this.connections = new Map();
    this.pending = new Map();
    this.seq = 0;

    this.wss.on('connection', (ws, req, session) => {
      const current = this.connections.get(session.id);
      if (current && current.readyState === WebSocket.OPEN) current.close(4000, 'Replaced by a new droplet connection');
      this.connections.set(session.id, ws);
      ws.sessionId = session.id;
      ws.on('message', raw => this.onMessage(raw));
      ws.on('close', () => {
        if (this.connections.get(session.id) === ws) this.connections.delete(session.id);
      });
      ws.send(JSON.stringify({ type: 'hello', session_id: session.id }));
    });
  }

  attach(server) {
    server.on('upgrade', async (req, socket, head) => {
      let parsed;
      try {
        parsed = new URL(req.url, 'http://127.0.0.1');
      } catch {
        socket.destroy();
        return;
      }
      if (parsed.pathname !== '/droplet/control') {
        socket.destroy();
        return;
      }
      const sessionToken = parsed.searchParams.get('session_token') || req.headers['x-webbrain-session-token'];
      const session = sessionToken ? await this.store.getBrowserSessionBySecret(sessionToken) : null;
      if (!session) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, ws => {
        this.wss.emit('connection', ws, req, session);
      });
    });
  }

  isConnected(sessionId) {
    const ws = this.connections.get(sessionId);
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  send(sessionId, action, payload = {}, timeoutMs = this.requestTimeoutMs) {
    const ws = this.connections.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      const e = new Error('Droplet control channel is not connected.');
      e.status = 409;
      return Promise.reject(e);
    }
    const id = `ctl_${Date.now().toString(36)}_${this.seq++}`;
    ws.send(JSON.stringify({ id, action, payload }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const e = new Error(`Droplet command timed out: ${action}`);
        e.status = 504;
        reject(e);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (!msg.id || !this.pending.has(msg.id)) return;
    const item = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    clearTimeout(item.timer);
    if (msg.ok === false) {
      const e = new Error(msg.error || 'Droplet command failed');
      e.status = msg.status || 500;
      item.reject(e);
    } else {
      item.resolve(msg.result);
    }
  }

  close() {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('Droplet control channel closed'));
    }
    this.pending.clear();
    for (const ws of this.connections.values()) ws.close();
    this.connections.clear();
    return new Promise(resolve => this.wss.close(resolve));
  }
}
