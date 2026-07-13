import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { parseJsonMaybe } from '../shared/http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, '..', '..', 'db', 'schema.sql');

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

function normalizeBrowserSession(row) {
  if (!row) return null;
  return {
    ...row,
    expires_at: fromMysqlDate(row.expires_at),
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

  async createBrowserSession(row) {
    await this.pool.execute(
      `INSERT INTO browser_sessions
       (id,user_id,display_name,status,droplet_id,public_ip,region,size,connect_secret,expires_at,created_at,updated_at)
       VALUES (:id,:user_id,:display_name,:status,:droplet_id,:public_ip,:region,:size,:connect_secret,:expires_at,:created_at,:updated_at)`,
      { ...row, display_name: row.display_name || null, expires_at: toMysqlDate(row.expires_at), created_at: toMysqlDate(row.created_at), updated_at: toMysqlDate(row.updated_at) }
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

  async updateBrowserSession(id, patch) {
    const fields = Object.keys(patch).filter(k => patch[k] !== undefined);
    if (!fields.length) return await this.getBrowserSession(id);
    const assignments = fields.map(k => `${k} = :${k}`).join(', ');
    const values = { id, ...patch };
    for (const key of ['expires_at', 'created_at', 'updated_at']) {
      if (values[key]) values[key] = toMysqlDate(values[key]);
    }
    await this.pool.execute(`UPDATE browser_sessions SET ${assignments} WHERE id = :id`, values);
    return await this.getBrowserSession(id);
  }

  async getBrowserSessionBySecret(secret) {
    return normalizeBrowserSession(await this.queryOne('SELECT * FROM browser_sessions WHERE connect_secret = :secret', { secret }));
  }

  async listExpiredBrowserSessions(now) {
    const [rows] = await this.pool.execute(
      `SELECT * FROM browser_sessions
       WHERE expires_at <= :now AND status NOT IN ('stopping','stopped','destroyed')`,
      { now: toMysqlDate(now) }
    );
    return rows.map(normalizeBrowserSession);
  }

  async createCloudRun(row) {
    await this.pool.execute(
      `INSERT INTO cloud_runs
       (id,browser_session_id,user_id,task,output_schema,status,result,summary,final_url,error,updates,created_at,updated_at,completed_at)
       VALUES (:id,:browser_session_id,:user_id,:task,:output_schema,:status,:result,:summary,:final_url,:error,:updates,:created_at,:updated_at,:completed_at)`,
      {
        ...row,
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

  async listCloudRunsForSession(browserSessionId) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM cloud_runs WHERE browser_session_id = :browserSessionId ORDER BY created_at DESC',
      { browserSessionId }
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
