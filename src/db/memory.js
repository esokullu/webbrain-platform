import { randomId, nowIso } from '../shared/ids.js';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function notFound(message = 'Not found') {
  const e = new Error(message);
  e.status = 404;
  return e;
}

function conflict(message) {
  const e = new Error(message);
  e.status = 409;
  return e;
}

export class MemoryStore {
  constructor() {
    this.users = new Map();
    this.webSessions = new Map();
    this.apiKeys = new Map();
    this.browserSessions = new Map();
    this.cloudRuns = new Map();
    this.auditLogs = [];
  }

  async migrate() {}

  async createUser({ id = randomId('usr'), email, password_hash, created_at = nowIso(), updated_at = created_at }) {
    const normalizedEmail = String(email).trim().toLowerCase();
    if ([...this.users.values()].some(u => u.email === normalizedEmail)) throw conflict('Email already registered');
    const row = { id, email: normalizedEmail, password_hash, created_at, updated_at };
    this.users.set(id, row);
    return clone(row);
  }

  async findUserByEmail(email) {
    const normalizedEmail = String(email).trim().toLowerCase();
    return clone([...this.users.values()].find(u => u.email === normalizedEmail) || null);
  }

  async getUser(id) {
    return clone(this.users.get(id) || null);
  }

  async updateUser(id, { email, password_hash, updated_at = nowIso() }) {
    const row = this.users.get(id);
    if (!row) throw notFound('User not found');
    const normalizedEmail = String(email).trim().toLowerCase();
    if ([...this.users.values()].some(user => user.id !== id && user.email === normalizedEmail)) {
      throw conflict('Email already registered');
    }
    Object.assign(row, { email: normalizedEmail, password_hash, updated_at });
    return clone(row);
  }

  async createWebSession(row) {
    this.webSessions.set(row.token_hash, clone(row));
    return clone(row);
  }

  async getWebSessionByHash(tokenHash) {
    const row = this.webSessions.get(tokenHash);
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      this.webSessions.delete(tokenHash);
      return null;
    }
    const user = await this.getUser(row.user_id);
    return user ? { ...clone(row), user } : null;
  }

  async deleteWebSessionByHash(tokenHash) {
    this.webSessions.delete(tokenHash);
  }

  async deleteOtherWebSessions(userId, keepTokenHash) {
    let deleted = 0;
    for (const [tokenHash, session] of this.webSessions) {
      if (session.user_id !== userId || tokenHash === keepTokenHash) continue;
      this.webSessions.delete(tokenHash);
      deleted += 1;
    }
    return deleted;
  }

  async createApiKey(row) {
    this.apiKeys.set(row.id, clone(row));
    return clone(row);
  }

  async findApiKey(prefix, keyHash) {
    const row = [...this.apiKeys.values()].find(k => k.prefix === prefix && k.key_hash === keyHash && !k.revoked_at);
    if (!row) return null;
    const user = await this.getUser(row.user_id);
    return user ? { ...clone(row), user } : null;
  }

  async touchApiKey(id, at = nowIso()) {
    const row = this.apiKeys.get(id);
    if (row) row.last_used_at = at;
  }

  async listApiKeys(userId) {
    return clone([...this.apiKeys.values()]
      .filter(k => k.user_id === userId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))));
  }

  async revokeApiKey(userId, id, at = nowIso()) {
    const row = this.apiKeys.get(id);
    if (!row || row.user_id !== userId) throw notFound('API key not found');
    row.revoked_at = at;
    return clone(row);
  }

  async createBrowserSession(row) {
    this.browserSessions.set(row.id, clone(row));
    return clone(row);
  }

  async getBrowserSession(id) {
    return clone(this.browserSessions.get(id) || null);
  }

  async listBrowserSessions(userId) {
    return clone([...this.browserSessions.values()].filter(s => s.user_id === userId));
  }

  async listHostedBrowserSessions(hostSessionId) {
    return clone([...this.browserSessions.values()].filter(s => s.host_session_id === hostSessionId));
  }

  async listStoppingEphemeralBrowserSessions() {
    return clone([...this.browserSessions.values()].filter(s => (
      s.profile_mode === 'ephemeral' && s.status === 'stopping'
    )));
  }

  async updateBrowserSession(id, patch) {
    const row = this.browserSessions.get(id);
    if (!row) throw notFound('Browser session not found');
    Object.assign(row, clone(patch), { updated_at: patch.updated_at || nowIso() });
    return clone(row);
  }

  /**
   * Atomically apply `patch` only when the session's current status matches
   * `expectedStatus`. Returns null when the row exists but the status does not match.
   */
  async updateBrowserSessionIfStatus(id, expectedStatus, patch) {
    const row = this.browserSessions.get(id);
    if (!row) throw notFound('Browser session not found');
    if (row.status !== expectedStatus) return null;
    Object.assign(row, clone(patch), { updated_at: patch.updated_at || nowIso() });
    return clone(row);
  }

  async getBrowserSessionBySecret(secret) {
    return clone([...this.browserSessions.values()].find(s => s.connect_secret === secret) || null);
  }

  async listExpiredBrowserSessions(now = nowIso()) {
    const cutoff = new Date(now).getTime();
    return clone([...this.browserSessions.values()].filter(s => {
      const expiresAt = s.expires_at ? new Date(s.expires_at).getTime() : NaN;
      return s.profile_mode === 'ephemeral'
        && Number.isFinite(expiresAt)
        && expiresAt <= cutoff
        && !['stopping', 'stopped', 'destroyed'].includes(s.status);
    }));
  }

  async createCloudRun(row) {
    this.cloudRuns.set(row.id, clone(row));
    return clone(row);
  }

  async getCloudRun(id) {
    return clone(this.cloudRuns.get(id) || null);
  }

  async getCloudRunByParentId(parentRunId) {
    return clone([...this.cloudRuns.values()].find(run => run.parent_run_id === parentRunId) || null);
  }

  async listCloudRunsForSession(browserSessionId) {
    return clone([...this.cloudRuns.values()].filter(r => r.browser_session_id === browserSessionId));
  }

  async listCloudRunsForUser(userId, { limit = 50, offset = 0 } = {}) {
    return clone([...this.cloudRuns.values()]
      .filter(run => run.user_id === userId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)))
      .slice(offset, offset + limit));
  }

  async updateCloudRun(id, patch) {
    const row = this.cloudRuns.get(id);
    if (!row) throw notFound('Cloud run not found');
    Object.assign(row, clone(patch), { updated_at: patch.updated_at || nowIso() });
    return clone(row);
  }

  async createAuditLog(row) {
    const saved = { id: randomId('aud'), created_at: nowIso(), ...clone(row) };
    this.auditLogs.push(saved);
    return clone(saved);
  }
}
