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
    this.billingAccounts = new Map();
    this.billingTransactions = new Map();
    this.browserSessions = new Map();
    this.warmDroplets = new Map();
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

  async ensureBillingAccount({ user_id, unlimited = false, created_at = nowIso(), updated_at = created_at }) {
    const existing = this.billingAccounts.get(user_id);
    if (existing) {
      if (unlimited && !existing.unlimited) {
        existing.unlimited = true;
        existing.updated_at = updated_at;
      }
      return clone(existing);
    }
    const row = {
      user_id,
      credit_cents: 0,
      usage_remainder_units: 0,
      unlimited: Boolean(unlimited),
      stripe_customer_id: null,
      stripe_payment_method_id: null,
      auto_top_up_enabled: false,
      auto_top_up_threshold_cents: 500,
      auto_top_up_amount_cents: 2500,
      auto_top_up_status: 'disabled',
      auto_top_up_attempt_id: null,
      auto_top_up_next_attempt_at: null,
      auto_top_up_last_error: null,
      created_at,
      updated_at,
    };
    this.billingAccounts.set(user_id, row);
    return clone(row);
  }

  async getBillingAccount(userId) {
    return clone(this.billingAccounts.get(userId) || null);
  }

  async listBillingTransactions(userId, { limit = 20 } = {}) {
    return clone([...this.billingTransactions.values()]
      .filter(transaction => transaction.user_id === userId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit));
  }

  async applyBillingCredit(row) {
    const duplicate = [...this.billingTransactions.values()].find(transaction => (
      row.provider_ref && transaction.provider_ref === row.provider_ref
    ));
    if (duplicate) {
      return {
        applied: false,
        account: await this.getBillingAccount(row.user_id),
        transaction: clone(duplicate),
      };
    }
    const account = await this.ensureBillingAccount({ user_id: row.user_id });
    const transaction = {
      ...clone(row),
      amount_cents: Number(row.amount_cents),
      created_at: row.created_at || nowIso(),
    };
    this.billingTransactions.set(transaction.id, transaction);
    const storedAccount = this.billingAccounts.get(row.user_id);
    storedAccount.credit_cents = Number(storedAccount.credit_cents) + transaction.amount_cents;
    storedAccount.updated_at = transaction.created_at;
    return {
      applied: true,
      account: clone(storedAccount),
      transaction: clone(transaction),
    };
  }

  async updateBillingAutoTopUp(userId, patch) {
    const account = this.billingAccounts.get(userId);
    if (!account) throw notFound('Billing account not found');
    const allowed = [
      'stripe_customer_id',
      'stripe_payment_method_id',
      'auto_top_up_enabled',
      'auto_top_up_threshold_cents',
      'auto_top_up_amount_cents',
      'auto_top_up_status',
      'auto_top_up_attempt_id',
      'auto_top_up_next_attempt_at',
      'auto_top_up_last_error',
      'updated_at',
    ];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) account[key] = clone(patch[key]);
    }
    account.auto_top_up_enabled = Boolean(account.auto_top_up_enabled);
    return clone(account);
  }

  async listDueAutoTopUpAccounts(at = nowIso()) {
    const now = new Date(at).getTime();
    return clone([...this.billingAccounts.values()].filter(account => (
      !account.unlimited
      && account.auto_top_up_enabled
      && account.stripe_customer_id
      && account.stripe_payment_method_id
      && Number(account.credit_cents) <= Number(account.auto_top_up_threshold_cents)
      && (
        account.auto_top_up_status === 'charging'
        || !account.auto_top_up_next_attempt_at
        || new Date(account.auto_top_up_next_attempt_at).getTime() <= now
      )
    )));
  }

  async beginAutoTopUpAttempt(userId, { attempt_id, at = nowIso() }) {
    const account = this.billingAccounts.get(userId);
    if (!account
        || account.unlimited
        || !account.auto_top_up_enabled
        || !account.stripe_customer_id
        || !account.stripe_payment_method_id
        || Number(account.credit_cents) > Number(account.auto_top_up_threshold_cents)) return null;
    if (account.auto_top_up_status === 'charging' && account.auto_top_up_attempt_id) {
      return clone(account);
    }
    if (account.auto_top_up_next_attempt_at
        && new Date(account.auto_top_up_next_attempt_at).getTime() > new Date(at).getTime()) return null;
    Object.assign(account, {
      auto_top_up_status: 'charging',
      auto_top_up_attempt_id: attempt_id,
      auto_top_up_last_error: null,
      updated_at: at,
    });
    return clone(account);
  }

  async completeAutoTopUpAttempt(userId, attemptId, patch) {
    const account = this.billingAccounts.get(userId);
    if (!account || account.auto_top_up_attempt_id !== attemptId) return null;
    return await this.updateBillingAutoTopUp(userId, {
      ...patch,
      auto_top_up_attempt_id: null,
    });
  }

  async listBillableBrowserSessions() {
    return clone([...this.browserSessions.values()].filter(session => (
      session.profile_mode !== 'ephemeral'
      && session.droplet_id
      && !['paused', 'stopping', 'destroyed'].includes(session.status)
    )));
  }

  async meterBrowserSessionUsage(sessionId, { metered_at = nowIso(), rate_cents }) {
    const session = this.browserSessions.get(sessionId);
    if (!session) throw notFound('Browser session not found');
    const previous = session.billing_metered_at;
    session.billing_metered_at = metered_at;
    if (!previous) return { applied: false, initialized: true, account: null, transaction: null };
    if (
      session.profile_mode === 'ephemeral'
      || !session.droplet_id
      || ['paused', 'stopping', 'destroyed'].includes(session.status)
    ) {
      return { applied: false, initialized: false, account: null, transaction: null };
    }
    const elapsedSeconds = Math.max(0, Math.floor(
      (new Date(metered_at).getTime() - new Date(previous).getTime()) / 1000
    ));
    const account = await this.ensureBillingAccount({ user_id: session.user_id });
    const storedAccount = this.billingAccounts.get(session.user_id);
    if (!elapsedSeconds || storedAccount.unlimited) {
      return { applied: false, initialized: false, account: clone(storedAccount), transaction: null };
    }
    const totalUnits = Number(storedAccount.usage_remainder_units || 0)
      + elapsedSeconds * Number(rate_cents);
    const chargeCents = Math.floor(totalUnits / 3600);
    storedAccount.usage_remainder_units = totalUnits % 3600;
    storedAccount.updated_at = metered_at;
    if (!chargeCents) {
      return { applied: false, initialized: false, account: clone(storedAccount), transaction: null };
    }
    const transaction = {
      id: randomId('btx'),
      user_id: session.user_id,
      amount_cents: -chargeCents,
      kind: 'browser_usage',
      provider: null,
      provider_ref: `usage:${session.id}:${metered_at}`,
      description: `${elapsedSeconds}s active browser usage`,
      created_at: metered_at,
    };
    this.billingTransactions.set(transaction.id, transaction);
    storedAccount.credit_cents = Number(storedAccount.credit_cents) - chargeCents;
    return {
      applied: true,
      initialized: false,
      account: clone(storedAccount),
      transaction: clone(transaction),
    };
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

  async createWarmDroplet(row) {
    this.warmDroplets.set(row.id, clone(row));
    return clone(row);
  }

  async getWarmDroplet(id) {
    return clone(this.warmDroplets.get(id) || null);
  }

  async getWarmDropletByToken(token) {
    return clone([...this.warmDroplets.values()].find(row => row.pool_token === token) || null);
  }

  async listWarmDroplets() {
    return clone([...this.warmDroplets.values()]);
  }

  async updateWarmDroplet(id, patch) {
    const row = this.warmDroplets.get(id);
    if (!row) throw notFound('Warm Droplet not found');
    Object.assign(row, clone(patch), { updated_at: patch.updated_at || nowIso() });
    return clone(row);
  }

  async updateWarmDropletIfStatus(id, expectedStatus, patch) {
    const row = this.warmDroplets.get(id);
    if (!row) throw notFound('Warm Droplet not found');
    if (row.status !== expectedStatus) return null;
    Object.assign(row, clone(patch), { updated_at: patch.updated_at || nowIso() });
    return clone(row);
  }

  async claimReadyWarmDroplet({ region, size, sessionId, now = nowIso() }) {
    const row = [...this.warmDroplets.values()]
      .filter(item => (
        item.status === 'ready'
        && !item.assigned_session_id
        && item.region === region
        && item.size === size
        && item.droplet_id
        && item.public_ip
      ))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
    if (!row) return null;
    row.status = 'claiming';
    row.assigned_session_id = sessionId;
    row.updated_at = now;
    return clone(row);
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
