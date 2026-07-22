import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { parseJsonMaybe } from '../shared/http.js';
import { randomId } from '../shared/ids.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, '..', '..', 'db', 'schema.sql');
const BROWSER_SESSION_DATE_FIELDS = [
  'proxy_updated_at',
  'paused_at',
  'billing_metered_at',
  'ended_at',
  'expires_at',
  'created_at',
  'updated_at',
];

function toMysqlDate(iso) {
  if (!iso) return null;
  return new Date(iso).toISOString().slice(0, 19).replace('T', ' ');
}

function fromMysqlDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function encodeJson(value) {
  return value == null ? null : JSON.stringify(value);
}

function notFound(message = 'Not found') {
  return Object.assign(new Error(message), { status: 404 });
}

function normalizeBrowserSession(row) {
  if (!row) return null;
  return {
    ...row,
    proxy_enabled: Boolean(row.proxy_enabled),
    proxy_updated_at: fromMysqlDate(row.proxy_updated_at),
    paused_at: fromMysqlDate(row.paused_at),
    billing_metered_at: fromMysqlDate(row.billing_metered_at),
    ended_at: fromMysqlDate(row.ended_at),
    expires_at: fromMysqlDate(row.expires_at),
    created_at: fromMysqlDate(row.created_at),
    updated_at: fromMysqlDate(row.updated_at),
  };
}

function normalizeWarmDroplet(row) {
  if (!row) return null;
  return {
    ...row,
    created_at: fromMysqlDate(row.created_at),
    updated_at: fromMysqlDate(row.updated_at),
  };
}

export function normalizeCloudRun(row) {
  if (!row) return null;
  return {
    ...row,
    output_schema: parseJsonMaybe(row.output_schema),
    // mysql2 decodes JSON columns before returning them. In particular, a JSON
    // string result arrives here as a plain JavaScript string, so parsing it a
    // second time would turn a normal agent answer into the fallback `null`.
    result: row.result,
    updates: parseJsonMaybe(row.updates, []),
    created_at: fromMysqlDate(row.created_at),
    updated_at: fromMysqlDate(row.updated_at),
    completed_at: fromMysqlDate(row.completed_at),
  };
}

function normalizeSavedWorkflow(row) {
  if (!row) return null;
  return {
    ...row,
    definition: parseJsonMaybe(row.definition),
    created_at: fromMysqlDate(row.created_at),
    updated_at: fromMysqlDate(row.updated_at),
  };
}

export class MySqlStore {
  constructor(config) {
    this.config = config;
    this.pool = mysql.createPool(config.url ? poolConfigFromUrl(config) : {
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: 10,
      namedPlaceholders: true,
    });
  }

  async migrate() {
    const sql = await fs.readFile(schemaPath, 'utf8');
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
    for (const statement of statements) {
      await this.pool.query(statement);
    }
    await this.pool.query(
      `INSERT INTO billing_accounts (user_id, credit_cents, unlimited, created_at, updated_at)
       SELECT id, 0, 1, NOW(), NOW()
       FROM users
       WHERE email = 'esokullu@gmail.com'
       ON DUPLICATE KEY UPDATE
         updated_at = IF(
           billing_accounts.unlimited = 0,
           VALUES(updated_at),
           billing_accounts.updated_at
         ),
         unlimited = 1`
    );
    const billingAccountColumns = [
      ['usage_remainder_units', 'ALTER TABLE billing_accounts ADD COLUMN usage_remainder_units BIGINT NOT NULL DEFAULT 0 AFTER credit_cents'],
      ['stripe_customer_id', 'ALTER TABLE billing_accounts ADD COLUMN stripe_customer_id VARCHAR(255) NULL AFTER unlimited'],
      ['stripe_payment_method_id', 'ALTER TABLE billing_accounts ADD COLUMN stripe_payment_method_id VARCHAR(255) NULL AFTER stripe_customer_id'],
      ['auto_top_up_enabled', 'ALTER TABLE billing_accounts ADD COLUMN auto_top_up_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER stripe_payment_method_id'],
      ['auto_top_up_threshold_cents', 'ALTER TABLE billing_accounts ADD COLUMN auto_top_up_threshold_cents BIGINT NOT NULL DEFAULT 500 AFTER auto_top_up_enabled'],
      ['auto_top_up_amount_cents', 'ALTER TABLE billing_accounts ADD COLUMN auto_top_up_amount_cents BIGINT NOT NULL DEFAULT 2500 AFTER auto_top_up_threshold_cents'],
      ['auto_top_up_status', "ALTER TABLE billing_accounts ADD COLUMN auto_top_up_status VARCHAR(32) NOT NULL DEFAULT 'disabled' AFTER auto_top_up_amount_cents"],
      ['auto_top_up_attempt_id', 'ALTER TABLE billing_accounts ADD COLUMN auto_top_up_attempt_id VARCHAR(64) NULL AFTER auto_top_up_status'],
      ['auto_top_up_next_attempt_at', 'ALTER TABLE billing_accounts ADD COLUMN auto_top_up_next_attempt_at DATETIME NULL AFTER auto_top_up_attempt_id'],
      ['auto_top_up_last_error', 'ALTER TABLE billing_accounts ADD COLUMN auto_top_up_last_error VARCHAR(255) NULL AFTER auto_top_up_next_attempt_at'],
    ];
    for (const [column, alter] of billingAccountColumns) {
      const [rows] = await this.pool.execute(
        `SELECT 1
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'billing_accounts'
           AND COLUMN_NAME = :column
         LIMIT 1`,
        { column }
      );
      if (!rows.length) await this.pool.query(alter);
    }
    const [displayNameColumns] = await this.pool.execute(
      `SELECT 1
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'browser_sessions'
         AND COLUMN_NAME = :column
       LIMIT 1`,
      { column: 'display_name' }
    );
    if (!displayNameColumns.length) {
      await this.pool.query('ALTER TABLE browser_sessions ADD COLUMN display_name VARCHAR(120) NULL AFTER user_id');
    }
    const browserProxyColumns = [
      ['proxy_enabled', 'ALTER TABLE browser_sessions ADD COLUMN proxy_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER connect_secret'],
      ['proxy_endpoint', 'ALTER TABLE browser_sessions ADD COLUMN proxy_endpoint VARCHAR(512) NULL AFTER proxy_enabled'],
      ['proxy_updated_at', 'ALTER TABLE browser_sessions ADD COLUMN proxy_updated_at DATETIME NULL AFTER proxy_endpoint'],
    ];
    for (const [column, alter] of browserProxyColumns) {
      const [rows] = await this.pool.execute(
        `SELECT 1
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'browser_sessions'
           AND COLUMN_NAME = :column
         LIMIT 1`,
        { column }
      );
      if (!rows.length) await this.pool.query(alter);
    }
    const browserVolumeColumns = [
      ['volume_id', 'ALTER TABLE browser_sessions ADD COLUMN volume_id VARCHAR(64) NULL AFTER size'],
      ['volume_name', 'ALTER TABLE browser_sessions ADD COLUMN volume_name VARCHAR(128) NULL AFTER volume_id'],
      ['volume_size_gib', 'ALTER TABLE browser_sessions ADD COLUMN volume_size_gib INT NULL AFTER volume_name'],
      ['paused_at', 'ALTER TABLE browser_sessions ADD COLUMN paused_at DATETIME NULL AFTER proxy_updated_at'],
      ['billing_metered_at', 'ALTER TABLE browser_sessions ADD COLUMN billing_metered_at DATETIME NULL AFTER paused_at'],
    ];
    for (const [column, alter] of browserVolumeColumns) {
      const [rows] = await this.pool.execute(
        `SELECT 1
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'browser_sessions'
           AND COLUMN_NAME = :column
         LIMIT 1`,
        { column }
      );
      if (!rows.length) await this.pool.query(alter);
    }
    const ephemeralBrowserColumns = [
      ['profile_mode', "ALTER TABLE browser_sessions ADD COLUMN profile_mode VARCHAR(16) NOT NULL DEFAULT 'persistent' AFTER volume_size_gib"],
      ['host_session_id', 'ALTER TABLE browser_sessions ADD COLUMN host_session_id VARCHAR(40) NULL AFTER profile_mode'],
      ['runtime_port', 'ALTER TABLE browser_sessions ADD COLUMN runtime_port INT NULL AFTER host_session_id'],
      ['runtime_generation', 'ALTER TABLE browser_sessions ADD COLUMN runtime_generation VARCHAR(64) NULL AFTER runtime_port'],
      ['ended_at', 'ALTER TABLE browser_sessions ADD COLUMN ended_at DATETIME NULL AFTER paused_at'],
      ['end_reason', 'ALTER TABLE browser_sessions ADD COLUMN end_reason VARCHAR(255) NULL AFTER ended_at'],
    ];
    for (const [column, alter] of ephemeralBrowserColumns) {
      const [rows] = await this.pool.execute(
        `SELECT 1
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'browser_sessions'
           AND COLUMN_NAME = :column
         LIMIT 1`,
        { column }
      );
      if (!rows.length) await this.pool.query(alter);
    }
    const [browserExpiryColumns] = await this.pool.execute(
      `SELECT IS_NULLABLE AS is_nullable
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'browser_sessions'
         AND COLUMN_NAME = 'expires_at'
       LIMIT 1`
    );
    if (browserExpiryColumns[0]?.is_nullable !== 'YES') {
      await this.pool.query('ALTER TABLE browser_sessions MODIFY COLUMN expires_at DATETIME NULL');
    }
    await this.pool.query(
      `UPDATE browser_sessions
       SET expires_at = NULL
       WHERE profile_mode <> 'ephemeral'
         AND expires_at IS NOT NULL`
    );
    const [hostSessionIndexes] = await this.pool.execute(
      `SELECT 1
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'browser_sessions'
         AND INDEX_NAME = 'idx_browser_sessions_host'
       LIMIT 1`
    );
    if (!hostSessionIndexes.length) {
      await this.pool.query('CREATE INDEX idx_browser_sessions_host ON browser_sessions (host_session_id)');
    }
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS warm_droplets (
        id VARCHAR(40) PRIMARY KEY,
        droplet_id VARCHAR(64) NULL,
        public_ip VARCHAR(64) NULL,
        region VARCHAR(64) NOT NULL,
        size VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL,
        assigned_session_id VARCHAR(40) NULL,
        pool_token TEXT NOT NULL,
        last_error TEXT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        INDEX idx_warm_droplets_status (status, assigned_session_id),
        INDEX idx_warm_droplets_droplet (droplet_id),
        FOREIGN KEY (assigned_session_id) REFERENCES browser_sessions(id)
      )`
    );
    const [runUpdateColumns] = await this.pool.execute(
      `SELECT 1
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'cloud_runs'
         AND COLUMN_NAME = :column
       LIMIT 1`,
      { column: 'updates' }
    );
    if (!runUpdateColumns.length) {
      await this.pool.query('ALTER TABLE cloud_runs ADD COLUMN updates JSON NULL AFTER error');
    }
    const runContinuationColumns = [
      ['workflow_id', 'ALTER TABLE cloud_runs ADD COLUMN workflow_id VARCHAR(40) NULL AFTER user_id'],
      ['parent_run_id', 'ALTER TABLE cloud_runs ADD COLUMN parent_run_id VARCHAR(40) NULL AFTER user_id'],
      ['tab_id', 'ALTER TABLE cloud_runs ADD COLUMN tab_id BIGINT NULL AFTER parent_run_id'],
    ];
    for (const [column, alter] of runContinuationColumns) {
      const [rows] = await this.pool.execute(
        `SELECT 1
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'cloud_runs'
           AND COLUMN_NAME = :column
         LIMIT 1`,
        { column }
      );
      if (!rows.length) await this.pool.query(alter);
    }
    const [runParentIndexes] = await this.pool.execute(
      `SELECT 1
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'cloud_runs'
         AND INDEX_NAME = 'idx_cloud_runs_parent_run'
       LIMIT 1`
    );
    if (!runParentIndexes.length) {
      await this.pool.query('CREATE UNIQUE INDEX idx_cloud_runs_parent_run ON cloud_runs (parent_run_id)');
    }
  }

  async queryOne(sql, params = {}) {
    const [rows] = await this.pool.execute(sql, params);
    return rows[0] || null;
  }

  async createUser(row) {
    await this.pool.execute(
      'INSERT INTO users (id,email,password_hash,created_at,updated_at) VALUES (:id,:email,:password_hash,:created_at,:updated_at)',
      { ...row, created_at: toMysqlDate(row.created_at), updated_at: toMysqlDate(row.updated_at) }
    );
    return await this.getUser(row.id);
  }

  async findUserByEmail(email) {
    const row = await this.queryOne('SELECT * FROM users WHERE email = :email', { email: String(email).trim().toLowerCase() });
    return row ? { ...row, created_at: fromMysqlDate(row.created_at), updated_at: fromMysqlDate(row.updated_at) } : null;
  }

  async getUser(id) {
    const row = await this.queryOne('SELECT * FROM users WHERE id = :id', { id });
    return row ? { ...row, created_at: fromMysqlDate(row.created_at), updated_at: fromMysqlDate(row.updated_at) } : null;
  }

  async updateUser(id, { email, password_hash, updated_at }) {
    await this.pool.execute(
      `UPDATE users
       SET email = :email, password_hash = :password_hash, updated_at = :updated_at
       WHERE id = :id`,
      { id, email: String(email).trim().toLowerCase(), password_hash, updated_at: toMysqlDate(updated_at) }
    );
    return await this.getUser(id);
  }

  async createWebSession(row) {
    await this.pool.execute(
      'INSERT INTO web_sessions (id,user_id,token_hash,expires_at,created_at) VALUES (:id,:user_id,:token_hash,:expires_at,:created_at)',
      { ...row, expires_at: toMysqlDate(row.expires_at), created_at: toMysqlDate(row.created_at) }
    );
    return row;
  }

  async getWebSessionByHash(tokenHash) {
    const row = await this.queryOne(
      `SELECT ws.*, u.email, u.password_hash, u.created_at AS user_created_at, u.updated_at AS user_updated_at
       FROM web_sessions ws JOIN users u ON u.id = ws.user_id
       WHERE ws.token_hash = :tokenHash AND ws.expires_at > NOW()`,
      { tokenHash }
    );
    if (!row) return null;
    return {
      id: row.id,
      user_id: row.user_id,
      token_hash: row.token_hash,
      expires_at: fromMysqlDate(row.expires_at),
      created_at: fromMysqlDate(row.created_at),
      user: {
        id: row.user_id,
        email: row.email,
        password_hash: row.password_hash,
        created_at: fromMysqlDate(row.user_created_at),
        updated_at: fromMysqlDate(row.user_updated_at),
      },
    };
  }

  async deleteWebSessionByHash(tokenHash) {
    await this.pool.execute('DELETE FROM web_sessions WHERE token_hash = :tokenHash', { tokenHash });
  }

  async deleteOtherWebSessions(userId, keepTokenHash) {
    const [result] = await this.pool.execute(
      'DELETE FROM web_sessions WHERE user_id = :userId AND token_hash <> :keepTokenHash',
      { userId, keepTokenHash }
    );
    return result.affectedRows || 0;
  }

  async createApiKey(row) {
    await this.pool.execute(
      `INSERT INTO api_keys (id,user_id,name,prefix,key_hash,last_used_at,revoked_at,created_at)
       VALUES (:id,:user_id,:name,:prefix,:key_hash,:last_used_at,:revoked_at,:created_at)`,
      { ...row, last_used_at: toMysqlDate(row.last_used_at), revoked_at: toMysqlDate(row.revoked_at), created_at: toMysqlDate(row.created_at) }
    );
    return row;
  }

  async findApiKey(prefix, keyHash) {
    const row = await this.queryOne(
      `SELECT ak.*, u.email, u.password_hash, u.created_at AS user_created_at, u.updated_at AS user_updated_at
       FROM api_keys ak JOIN users u ON u.id = ak.user_id
       WHERE ak.prefix = :prefix AND ak.key_hash = :keyHash AND ak.revoked_at IS NULL`,
      { prefix, keyHash }
    );
    if (!row) return null;
    return {
      ...row,
      created_at: fromMysqlDate(row.created_at),
      last_used_at: fromMysqlDate(row.last_used_at),
      revoked_at: fromMysqlDate(row.revoked_at),
      user: {
        id: row.user_id,
        email: row.email,
        password_hash: row.password_hash,
        created_at: fromMysqlDate(row.user_created_at),
        updated_at: fromMysqlDate(row.user_updated_at),
      },
    };
  }

  async touchApiKey(id, at) {
    await this.pool.execute('UPDATE api_keys SET last_used_at = :at WHERE id = :id', { id, at: toMysqlDate(at) });
  }

  async listApiKeys(userId) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM api_keys WHERE user_id = :userId ORDER BY created_at DESC',
      { userId }
    );
    return rows.map(row => ({
      ...row,
      created_at: fromMysqlDate(row.created_at),
      last_used_at: fromMysqlDate(row.last_used_at),
      revoked_at: fromMysqlDate(row.revoked_at),
    }));
  }

  async revokeApiKey(userId, id, at) {
    await this.pool.execute(
      'UPDATE api_keys SET revoked_at = :at WHERE id = :id AND user_id = :userId',
      { id, userId, at: toMysqlDate(at) }
    );
    return { id, user_id: userId, revoked_at: at };
  }

  async ensureBillingAccount({ user_id, unlimited = false, created_at, updated_at }) {
    await this.pool.execute(
      `INSERT INTO billing_accounts (user_id, credit_cents, unlimited, created_at, updated_at)
       VALUES (:user_id, 0, :unlimited, :created_at, :updated_at)
       ON DUPLICATE KEY UPDATE
         updated_at = IF(:unlimited = 1 AND unlimited = 0, VALUES(updated_at), updated_at),
         unlimited = GREATEST(unlimited, VALUES(unlimited))`,
      {
        user_id,
        unlimited: unlimited ? 1 : 0,
        created_at: toMysqlDate(created_at),
        updated_at: toMysqlDate(updated_at),
      }
    );
    return await this.getBillingAccount(user_id);
  }

  async getBillingAccount(userId) {
    const row = await this.queryOne(
      'SELECT * FROM billing_accounts WHERE user_id = :userId',
      { userId }
    );
    return row ? {
      ...row,
      credit_cents: Number(row.credit_cents),
      usage_remainder_units: Number(row.usage_remainder_units || 0),
      unlimited: Boolean(row.unlimited),
      auto_top_up_enabled: Boolean(row.auto_top_up_enabled),
      auto_top_up_threshold_cents: Number(row.auto_top_up_threshold_cents || 0),
      auto_top_up_amount_cents: Number(row.auto_top_up_amount_cents || 0),
      auto_top_up_next_attempt_at: fromMysqlDate(row.auto_top_up_next_attempt_at),
      created_at: fromMysqlDate(row.created_at),
      updated_at: fromMysqlDate(row.updated_at),
    } : null;
  }

  async listBillingTransactions(userId, { limit = 20 } = {}) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const [rows] = await this.pool.execute(
      `SELECT *
       FROM billing_transactions
       WHERE user_id = :userId
       ORDER BY created_at DESC, id DESC
       LIMIT ${safeLimit}`,
      { userId }
    );
    return rows.map(row => ({
      ...row,
      amount_cents: Number(row.amount_cents),
      created_at: fromMysqlDate(row.created_at),
    }));
  }

  async applyBillingCredit(row) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      let applied = false;
      try {
        await connection.execute(
          `INSERT INTO billing_transactions
           (id,user_id,amount_cents,kind,provider,provider_ref,description,created_at)
           VALUES (:id,:user_id,:amount_cents,:kind,:provider,:provider_ref,:description,:created_at)`,
          {
            ...row,
            provider: row.provider || null,
            provider_ref: row.provider_ref || null,
            description: row.description || null,
            created_at: toMysqlDate(row.created_at),
          }
        );
        applied = true;
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY' || !row.provider_ref) throw error;
        const [duplicates] = await connection.execute(
          'SELECT id FROM billing_transactions WHERE provider_ref = :provider_ref LIMIT 1',
          { provider_ref: row.provider_ref }
        );
        if (!duplicates.length) throw error;
      }
      if (applied) {
        await connection.execute(
          `INSERT INTO billing_accounts (user_id, credit_cents, unlimited, created_at, updated_at)
           VALUES (:user_id, :amount_cents, 0, :created_at, :created_at)
           ON DUPLICATE KEY UPDATE
             credit_cents = credit_cents + VALUES(credit_cents),
             updated_at = VALUES(updated_at)`,
          {
            user_id: row.user_id,
            amount_cents: Number(row.amount_cents),
            created_at: toMysqlDate(row.created_at),
          }
        );
      }
      await connection.commit();
      const transaction = await this.queryOne(
        row.provider_ref
          ? 'SELECT * FROM billing_transactions WHERE provider_ref = :provider_ref'
          : 'SELECT * FROM billing_transactions WHERE id = :id',
        row.provider_ref ? { provider_ref: row.provider_ref } : { id: row.id }
      );
      return {
        applied,
        account: await this.getBillingAccount(row.user_id),
        transaction: transaction ? {
          ...transaction,
          amount_cents: Number(transaction.amount_cents),
          created_at: fromMysqlDate(transaction.created_at),
        } : null,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async updateBillingAutoTopUp(userId, patch) {
    const columnMap = {
      stripe_customer_id: value => value || null,
      stripe_payment_method_id: value => value || null,
      auto_top_up_enabled: value => value ? 1 : 0,
      auto_top_up_threshold_cents: value => Number(value),
      auto_top_up_amount_cents: value => Number(value),
      auto_top_up_status: value => String(value),
      auto_top_up_attempt_id: value => value || null,
      auto_top_up_next_attempt_at: value => toMysqlDate(value),
      auto_top_up_last_error: value => value ? String(value).slice(0, 255) : null,
      updated_at: value => toMysqlDate(value),
    };
    const assignments = [];
    const params = { userId };
    for (const [key, normalize] of Object.entries(columnMap)) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      assignments.push(`${key} = :${key}`);
      params[key] = normalize(patch[key]);
    }
    if (!assignments.length) return await this.getBillingAccount(userId);
    const [result] = await this.pool.execute(
      `UPDATE billing_accounts SET ${assignments.join(', ')} WHERE user_id = :userId`,
      params
    );
    if (!result.affectedRows) throw notFound('Billing account not found');
    return await this.getBillingAccount(userId);
  }

  async listDueAutoTopUpAccounts(at) {
    const [rows] = await this.pool.execute(
      `SELECT *
       FROM billing_accounts
       WHERE unlimited = 0
         AND auto_top_up_enabled = 1
         AND stripe_customer_id IS NOT NULL
         AND stripe_payment_method_id IS NOT NULL
         AND credit_cents <= auto_top_up_threshold_cents
         AND (
           auto_top_up_status = 'charging'
           OR auto_top_up_next_attempt_at IS NULL
           OR auto_top_up_next_attempt_at <= :at
         )`,
      { at: toMysqlDate(at) }
    );
    return rows.map(row => ({
      ...row,
      credit_cents: Number(row.credit_cents),
      usage_remainder_units: Number(row.usage_remainder_units || 0),
      unlimited: Boolean(row.unlimited),
      auto_top_up_enabled: Boolean(row.auto_top_up_enabled),
      auto_top_up_threshold_cents: Number(row.auto_top_up_threshold_cents),
      auto_top_up_amount_cents: Number(row.auto_top_up_amount_cents),
      auto_top_up_next_attempt_at: fromMysqlDate(row.auto_top_up_next_attempt_at),
      created_at: fromMysqlDate(row.created_at),
      updated_at: fromMysqlDate(row.updated_at),
    }));
  }

  async beginAutoTopUpAttempt(userId, { attempt_id, at }) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT * FROM billing_accounts WHERE user_id = :userId FOR UPDATE',
        { userId }
      );
      const account = rows[0];
      if (
        !account
        || account.unlimited
        || !account.auto_top_up_enabled
        || !account.stripe_customer_id
        || !account.stripe_payment_method_id
        || Number(account.credit_cents) > Number(account.auto_top_up_threshold_cents)
      ) {
        await connection.commit();
        return null;
      }
      if (account.auto_top_up_status === 'charging' && account.auto_top_up_attempt_id) {
        await connection.commit();
        return await this.getBillingAccount(userId);
      }
      if (account.auto_top_up_next_attempt_at
          && new Date(account.auto_top_up_next_attempt_at).getTime() > new Date(at).getTime()) {
        await connection.commit();
        return null;
      }
      await connection.execute(
        `UPDATE billing_accounts
         SET auto_top_up_status = 'charging',
             auto_top_up_attempt_id = :attempt_id,
             auto_top_up_last_error = NULL,
             updated_at = :at
         WHERE user_id = :userId`,
        { userId, attempt_id, at: toMysqlDate(at) }
      );
      await connection.commit();
      return await this.getBillingAccount(userId);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async completeAutoTopUpAttempt(userId, attemptId, patch) {
    const columnMap = {
      auto_top_up_status: value => String(value),
      auto_top_up_next_attempt_at: value => toMysqlDate(value),
      auto_top_up_last_error: value => value ? String(value).slice(0, 255) : null,
      updated_at: value => toMysqlDate(value),
    };
    const assignments = ['auto_top_up_attempt_id = NULL'];
    const params = { userId, attemptId };
    for (const [key, normalize] of Object.entries(columnMap)) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      assignments.push(`${key} = :${key}`);
      params[key] = normalize(patch[key]);
    }
    const [result] = await this.pool.execute(
      `UPDATE billing_accounts
       SET ${assignments.join(', ')}
       WHERE user_id = :userId AND auto_top_up_attempt_id = :attemptId`,
      params
    );
    return result.affectedRows ? await this.getBillingAccount(userId) : null;
  }

  async listBillableBrowserSessions() {
    const [rows] = await this.pool.execute(
      `SELECT *
       FROM browser_sessions
       WHERE profile_mode <> 'ephemeral'
         AND droplet_id IS NOT NULL
         AND status NOT IN ('paused', 'stopping', 'destroyed')`
    );
    return rows.map(normalizeBrowserSession);
  }

  async meterBrowserSessionUsage(sessionId, { metered_at, rate_cents }) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [sessionRows] = await connection.execute(
        'SELECT * FROM browser_sessions WHERE id = :sessionId FOR UPDATE',
        { sessionId }
      );
      const session = sessionRows[0];
      if (!session) throw notFound('Browser session not found');
      const previous = fromMysqlDate(session.billing_metered_at);
      await connection.execute(
        'UPDATE browser_sessions SET billing_metered_at = :metered_at WHERE id = :sessionId',
        { sessionId, metered_at: toMysqlDate(metered_at) }
      );
      if (!previous) {
        await connection.commit();
        return { applied: false, initialized: true, account: null, transaction: null };
      }
      if (
        session.profile_mode === 'ephemeral'
        || !session.droplet_id
        || ['paused', 'stopping', 'destroyed'].includes(session.status)
      ) {
        await connection.commit();
        return { applied: false, initialized: false, account: null, transaction: null };
      }
      const elapsedSeconds = Math.max(0, Math.floor(
        (new Date(metered_at).getTime() - new Date(previous).getTime()) / 1000
      ));
      await connection.execute(
        `INSERT INTO billing_accounts (user_id, credit_cents, unlimited, created_at, updated_at)
         VALUES (:userId, 0, 0, :at, :at)
         ON DUPLICATE KEY UPDATE user_id = user_id`,
        { userId: session.user_id, at: toMysqlDate(metered_at) }
      );
      const [accountRows] = await connection.execute(
        'SELECT * FROM billing_accounts WHERE user_id = :userId FOR UPDATE',
        { userId: session.user_id }
      );
      const account = accountRows[0];
      if (!elapsedSeconds || account.unlimited) {
        await connection.commit();
        return {
          applied: false,
          initialized: false,
          account: await this.getBillingAccount(session.user_id),
          transaction: null,
        };
      }
      const totalUnits = Number(account.usage_remainder_units || 0)
        + elapsedSeconds * Number(rate_cents);
      const chargeCents = Math.floor(totalUnits / 3600);
      const remainderUnits = totalUnits % 3600;
      await connection.execute(
        `UPDATE billing_accounts
         SET usage_remainder_units = :remainderUnits,
             credit_cents = credit_cents - :chargeCents,
             updated_at = :at
         WHERE user_id = :userId`,
        {
          userId: session.user_id,
          remainderUnits,
          chargeCents,
          at: toMysqlDate(metered_at),
        }
      );
      let transaction = null;
      if (chargeCents) {
        transaction = {
          id: randomId('btx'),
          user_id: session.user_id,
          amount_cents: -chargeCents,
          kind: 'browser_usage',
          provider: null,
          provider_ref: `usage:${session.id}:${metered_at}`,
          description: `${elapsedSeconds}s active browser usage`,
          created_at: metered_at,
        };
        await connection.execute(
          `INSERT INTO billing_transactions
           (id,user_id,amount_cents,kind,provider,provider_ref,description,created_at)
           VALUES (:id,:user_id,:amount_cents,:kind,:provider,:provider_ref,:description,:created_at)`,
          { ...transaction, created_at: toMysqlDate(transaction.created_at) }
        );
      }
      await connection.commit();
      return {
        applied: Boolean(chargeCents),
        initialized: false,
        account: await this.getBillingAccount(session.user_id),
        transaction,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async createBrowserSession(row) {
    await this.pool.execute(
      `INSERT INTO browser_sessions
       (id,user_id,display_name,status,droplet_id,public_ip,region,size,volume_id,volume_name,volume_size_gib,profile_mode,host_session_id,runtime_port,runtime_generation,connect_secret,proxy_enabled,proxy_endpoint,proxy_updated_at,paused_at,billing_metered_at,ended_at,end_reason,expires_at,created_at,updated_at)
       VALUES (:id,:user_id,:display_name,:status,:droplet_id,:public_ip,:region,:size,:volume_id,:volume_name,:volume_size_gib,:profile_mode,:host_session_id,:runtime_port,:runtime_generation,:connect_secret,:proxy_enabled,:proxy_endpoint,:proxy_updated_at,:paused_at,:billing_metered_at,:ended_at,:end_reason,:expires_at,:created_at,:updated_at)`,
      {
        ...row,
        display_name: row.display_name || null,
        profile_mode: row.profile_mode || 'persistent',
        host_session_id: row.host_session_id || null,
        runtime_port: row.runtime_port || null,
        runtime_generation: row.runtime_generation || null,
        proxy_enabled: row.proxy_enabled ? 1 : 0,
        proxy_endpoint: row.proxy_endpoint || null,
        proxy_updated_at: toMysqlDate(row.proxy_updated_at),
        volume_id: row.volume_id || null,
        volume_name: row.volume_name || null,
        volume_size_gib: row.volume_size_gib || null,
        paused_at: toMysqlDate(row.paused_at),
        billing_metered_at: toMysqlDate(row.billing_metered_at),
        ended_at: toMysqlDate(row.ended_at),
        end_reason: row.end_reason || null,
        expires_at: toMysqlDate(row.expires_at),
        created_at: toMysqlDate(row.created_at),
        updated_at: toMysqlDate(row.updated_at),
      }
    );
    return await this.getBrowserSession(row.id);
  }

  async getBrowserSession(id) {
    return normalizeBrowserSession(await this.queryOne('SELECT * FROM browser_sessions WHERE id = :id', { id }));
  }

  async listBrowserSessions(userId) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM browser_sessions WHERE user_id = :userId ORDER BY created_at DESC',
      { userId }
    );
    return rows.map(normalizeBrowserSession);
  }

  async listHostedBrowserSessions(hostSessionId) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM browser_sessions WHERE host_session_id = :hostSessionId ORDER BY created_at DESC',
      { hostSessionId }
    );
    return rows.map(normalizeBrowserSession);
  }

  async listStoppingEphemeralBrowserSessions() {
    const [rows] = await this.pool.execute(
      "SELECT * FROM browser_sessions WHERE profile_mode = 'ephemeral' AND status = 'stopping' ORDER BY updated_at ASC"
    );
    return rows.map(normalizeBrowserSession);
  }

  async updateBrowserSession(id, patch) {
    const fields = Object.keys(patch).filter(k => patch[k] !== undefined);
    if (!fields.length) return await this.getBrowserSession(id);
    const assignments = fields.map(k => `${k} = :${k}`).join(', ');
    const values = { id, ...patch };
    if ('proxy_enabled' in values) values.proxy_enabled = values.proxy_enabled ? 1 : 0;
    for (const key of BROWSER_SESSION_DATE_FIELDS) {
      if (values[key]) values[key] = toMysqlDate(values[key]);
    }
    await this.pool.execute(`UPDATE browser_sessions SET ${assignments} WHERE id = :id`, values);
    return await this.getBrowserSession(id);
  }

  /**
   * Atomically apply `patch` only when the session's current status matches
   * `expectedStatus`. Returns null when the row exists but the status does not match.
   */
  async updateBrowserSessionIfStatus(id, expectedStatus, patch) {
    const fields = Object.keys(patch).filter(k => patch[k] !== undefined);
    if (!fields.length) {
      const current = await this.getBrowserSession(id);
      if (!current) {
        const e = new Error('Browser session not found');
        e.status = 404;
        throw e;
      }
      return current.status === expectedStatus ? current : null;
    }
    const assignments = fields.map(k => `${k} = :${k}`).join(', ');
    const values = { id, expectedStatus, ...patch };
    if ('proxy_enabled' in values) values.proxy_enabled = values.proxy_enabled ? 1 : 0;
    for (const key of BROWSER_SESSION_DATE_FIELDS) {
      if (values[key]) values[key] = toMysqlDate(values[key]);
    }
    const [result] = await this.pool.execute(
      `UPDATE browser_sessions SET ${assignments} WHERE id = :id AND status = :expectedStatus`,
      values
    );
    if (!result.affectedRows) {
      const current = await this.getBrowserSession(id);
      if (!current) {
        const e = new Error('Browser session not found');
        e.status = 404;
        throw e;
      }
      return null;
    }
    return await this.getBrowserSession(id);
  }

  async getBrowserSessionBySecret(secret) {
    return normalizeBrowserSession(await this.queryOne('SELECT * FROM browser_sessions WHERE connect_secret = :secret', { secret }));
  }

  async listExpiredBrowserSessions(now) {
    const [rows] = await this.pool.execute(
      `SELECT * FROM browser_sessions
       WHERE profile_mode = 'ephemeral'
         AND expires_at IS NOT NULL
         AND expires_at <= :now
         AND status NOT IN ('stopping','stopped','destroyed')`,
      { now: toMysqlDate(now) }
    );
    return rows.map(normalizeBrowserSession);
  }

  async createWarmDroplet(row) {
    await this.pool.execute(
      `INSERT INTO warm_droplets
       (id,droplet_id,public_ip,region,size,status,assigned_session_id,pool_token,last_error,created_at,updated_at)
       VALUES (:id,:droplet_id,:public_ip,:region,:size,:status,:assigned_session_id,:pool_token,:last_error,:created_at,:updated_at)`,
      {
        ...row,
        droplet_id: row.droplet_id || null,
        public_ip: row.public_ip || null,
        assigned_session_id: row.assigned_session_id || null,
        last_error: row.last_error || null,
        created_at: toMysqlDate(row.created_at),
        updated_at: toMysqlDate(row.updated_at),
      }
    );
    return await this.getWarmDroplet(row.id);
  }

  async getWarmDroplet(id) {
    return normalizeWarmDroplet(await this.queryOne('SELECT * FROM warm_droplets WHERE id = :id', { id }));
  }

  async getWarmDropletByToken(token) {
    return normalizeWarmDroplet(await this.queryOne('SELECT * FROM warm_droplets WHERE pool_token = :token', { token }));
  }

  async listWarmDroplets() {
    const [rows] = await this.pool.execute('SELECT * FROM warm_droplets ORDER BY created_at ASC');
    return rows.map(normalizeWarmDroplet);
  }

  async updateWarmDroplet(id, patch) {
    const fields = Object.keys(patch).filter(k => patch[k] !== undefined);
    if (!fields.length) return await this.getWarmDroplet(id);
    const values = { id, ...patch };
    for (const key of ['created_at', 'updated_at']) {
      if (values[key]) values[key] = toMysqlDate(values[key]);
    }
    await this.pool.execute(
      `UPDATE warm_droplets SET ${fields.map(k => `${k} = :${k}`).join(', ')} WHERE id = :id`,
      values
    );
    return await this.getWarmDroplet(id);
  }

  async updateWarmDropletIfStatus(id, expectedStatus, patch) {
    const fields = Object.keys(patch).filter(k => patch[k] !== undefined);
    if (!fields.length) {
      const current = await this.getWarmDroplet(id);
      if (!current) {
        const e = new Error('Warm Droplet not found');
        e.status = 404;
        throw e;
      }
      return current.status === expectedStatus ? current : null;
    }
    const values = { id, expectedStatus, ...patch };
    for (const key of ['created_at', 'updated_at']) {
      if (values[key]) values[key] = toMysqlDate(values[key]);
    }
    const [result] = await this.pool.execute(
      `UPDATE warm_droplets SET ${fields.map(k => `${k} = :${k}`).join(', ')}
       WHERE id = :id AND status = :expectedStatus`,
      values
    );
    if (!result.affectedRows) {
      const current = await this.getWarmDroplet(id);
      if (!current) {
        const e = new Error('Warm Droplet not found');
        e.status = 404;
        throw e;
      }
      return null;
    }
    return await this.getWarmDroplet(id);
  }

  async claimReadyWarmDroplet({ region, size, sessionId, now }) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        `SELECT * FROM warm_droplets
         WHERE status = 'ready'
           AND assigned_session_id IS NULL
           AND region = :region
           AND size = :size
           AND droplet_id IS NOT NULL
           AND public_ip IS NOT NULL
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE`,
        { region, size }
      );
      const row = rows[0];
      if (!row) {
        await conn.commit();
        return null;
      }
      await conn.execute(
        `UPDATE warm_droplets
         SET status = 'claiming', assigned_session_id = :sessionId, updated_at = :updatedAt
         WHERE id = :id`,
        { id: row.id, sessionId, updatedAt: toMysqlDate(now) }
      );
      await conn.commit();
      return await this.getWarmDroplet(row.id);
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  async createCloudRun(row) {
    await this.pool.execute(
      `INSERT INTO cloud_runs
       (id,browser_session_id,user_id,workflow_id,parent_run_id,tab_id,task,output_schema,status,result,summary,final_url,error,updates,created_at,updated_at,completed_at)
       VALUES (:id,:browser_session_id,:user_id,:workflow_id,:parent_run_id,:tab_id,:task,:output_schema,:status,:result,:summary,:final_url,:error,:updates,:created_at,:updated_at,:completed_at)`,
      {
        ...row,
        workflow_id: row.workflow_id || null,
        parent_run_id: row.parent_run_id || null,
        tab_id: row.tab_id ?? null,
        output_schema: encodeJson(row.output_schema),
        result: encodeJson(row.result),
        updates: encodeJson(row.updates || []),
        created_at: toMysqlDate(row.created_at),
        updated_at: toMysqlDate(row.updated_at),
        completed_at: toMysqlDate(row.completed_at),
      }
    );
    return await this.getCloudRun(row.id);
  }

  async getCloudRun(id) {
    return normalizeCloudRun(await this.queryOne('SELECT * FROM cloud_runs WHERE id = :id', { id }));
  }

  async getCloudRunByParentId(parentRunId) {
    return normalizeCloudRun(await this.queryOne(
      'SELECT * FROM cloud_runs WHERE parent_run_id = :parentRunId LIMIT 1',
      { parentRunId }
    ));
  }

  async listCloudRunsForSession(browserSessionId) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM cloud_runs WHERE browser_session_id = :browserSessionId ORDER BY created_at DESC',
      { browserSessionId }
    );
    return rows.map(normalizeCloudRun);
  }

  async listCloudRunsForUser(userId, { limit = 50, offset = 0 } = {}) {
    const safeLimit = Math.max(1, Math.min(101, Math.trunc(Number(limit) || 50)));
    const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
    const [rows] = await this.pool.execute(
      `SELECT id, browser_session_id, user_id, workflow_id, parent_run_id, tab_id, task, status, summary, final_url, error,
              COALESCE(JSON_LENGTH(updates), 0) AS update_count,
              created_at, updated_at, completed_at
       FROM cloud_runs
       WHERE user_id = :userId
       ORDER BY created_at DESC, id DESC
       LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      { userId }
    );
    return rows.map(normalizeCloudRun);
  }

  async updateCloudRun(id, patch) {
    const encoded = { ...patch };
    if ('output_schema' in encoded) encoded.output_schema = encodeJson(encoded.output_schema);
    if ('result' in encoded) encoded.result = encodeJson(encoded.result);
    if ('updates' in encoded) encoded.updates = encodeJson(encoded.updates || []);
    for (const key of ['created_at', 'updated_at', 'completed_at']) {
      if (encoded[key]) encoded[key] = toMysqlDate(encoded[key]);
    }
    const fields = Object.keys(encoded).filter(k => encoded[k] !== undefined);
    if (!fields.length) return await this.getCloudRun(id);
    await this.pool.execute(
      `UPDATE cloud_runs SET ${fields.map(k => `${k} = :${k}`).join(', ')} WHERE id = :id`,
      { id, ...encoded }
    );
    return await this.getCloudRun(id);
  }

  async createSavedWorkflow(row) {
    await this.pool.execute(
      `INSERT INTO saved_workflows
       (id,user_id,name,schema_version,definition,source_browser_session_id,source_run_id,created_at,updated_at)
       VALUES (:id,:user_id,:name,:schema_version,:definition,:source_browser_session_id,:source_run_id,:created_at,:updated_at)`,
      {
        ...row,
        definition: encodeJson(row.definition),
        created_at: toMysqlDate(row.created_at),
        updated_at: toMysqlDate(row.updated_at),
      }
    );
    return await this.getSavedWorkflow(row.id);
  }

  async getSavedWorkflow(id) {
    return normalizeSavedWorkflow(await this.queryOne(
      'SELECT * FROM saved_workflows WHERE id = :id',
      { id }
    ));
  }

  async countSavedWorkflowsForUser(userId) {
    const row = await this.queryOne(
      'SELECT COUNT(*) AS total FROM saved_workflows WHERE user_id = :userId',
      { userId }
    );
    return Number(row?.total || 0);
  }

  async listSavedWorkflowsForUser(userId, { limit = 50, offset = 0 } = {}) {
    const safeLimit = Math.max(1, Math.min(101, Math.trunc(Number(limit) || 50)));
    const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
    const [rows] = await this.pool.execute(
      `SELECT * FROM saved_workflows
       WHERE user_id = :userId
       ORDER BY updated_at DESC, id DESC
       LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      { userId }
    );
    return rows.map(normalizeSavedWorkflow);
  }

  async updateSavedWorkflow(id, patch) {
    const encoded = { ...patch };
    if ('definition' in encoded) encoded.definition = encodeJson(encoded.definition);
    for (const key of ['created_at', 'updated_at']) {
      if (encoded[key]) encoded[key] = toMysqlDate(encoded[key]);
    }
    const fields = Object.keys(encoded).filter(key => encoded[key] !== undefined);
    if (!fields.length) return await this.getSavedWorkflow(id);
    await this.pool.execute(
      `UPDATE saved_workflows SET ${fields.map(key => `${key} = :${key}`).join(', ')} WHERE id = :id`,
      { id, ...encoded }
    );
    return await this.getSavedWorkflow(id);
  }

  async deleteSavedWorkflow(id) {
    const [result] = await this.pool.execute('DELETE FROM saved_workflows WHERE id = :id', { id });
    return result.affectedRows > 0;
  }

  async createAuditLog(row) {
    await this.pool.execute(
      `INSERT INTO audit_logs (id,user_id,action,target_type,target_id,metadata,ip,user_agent,created_at)
       VALUES (:id,:user_id,:action,:target_type,:target_id,:metadata,:ip,:user_agent,:created_at)`,
      { ...row, metadata: encodeJson(row.metadata), created_at: toMysqlDate(row.created_at) }
    );
    return row;
  }

  async close() {
    await this.pool.end();
  }
}

function poolConfigFromUrl(config) {
  const parsed = new URL(config.url);
  const sslMode = parsed.searchParams.get('ssl-mode') || parsed.searchParams.get('sslmode');
  parsed.searchParams.delete('ssl-mode');
  parsed.searchParams.delete('sslmode');
  const sslRequired = sslMode && !['DISABLED', 'disable', 'false', '0'].includes(sslMode);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    connectionLimit: 10,
    namedPlaceholders: true,
    ssl: sslRequired ? { rejectUnauthorized: config.sslRejectUnauthorized === true } : undefined,
  };
}
