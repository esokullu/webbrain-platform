import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MySqlStore, normalizeCloudRun } from '../src/db/mysql.js';

test('dashboard columns are present in fresh schema and existing-database migrations', async () => {
  const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  const storeSource = await readFile(new URL('../src/db/mysql.js', import.meta.url), 'utf8');
  assert.match(schema, /display_name VARCHAR\(120\) NULL/);
  assert.match(storeSource, /FROM information_schema\.COLUMNS/);
  assert.doesNotMatch(storeSource, /SHOW COLUMNS FROM browser_sessions LIKE/);
  assert.match(storeSource, /ALTER TABLE browser_sessions ADD COLUMN display_name VARCHAR\(120\) NULL/);
  assert.match(schema, /proxy_enabled TINYINT\(1\) NOT NULL DEFAULT 0/);
  assert.match(schema, /proxy_endpoint VARCHAR\(512\) NULL/);
  assert.match(schema, /proxy_updated_at DATETIME NULL/);
  assert.match(storeSource, /ALTER TABLE browser_sessions ADD COLUMN proxy_enabled TINYINT\(1\) NOT NULL DEFAULT 0/);
  assert.match(storeSource, /ALTER TABLE browser_sessions ADD COLUMN proxy_endpoint VARCHAR\(512\) NULL/);
  assert.match(storeSource, /ALTER TABLE browser_sessions ADD COLUMN proxy_updated_at DATETIME NULL/);
  assert.match(schema, /volume_id VARCHAR\(64\) NULL/);
  assert.match(schema, /volume_name VARCHAR\(128\) NULL/);
  assert.match(schema, /volume_size_gib INT NULL/);
  assert.match(schema, /paused_at DATETIME NULL/);
  assert.match(storeSource, /ALTER TABLE browser_sessions ADD COLUMN volume_id VARCHAR\(64\) NULL/);
  assert.match(storeSource, /ALTER TABLE browser_sessions ADD COLUMN volume_size_gib INT NULL/);
  assert.match(storeSource, /ALTER TABLE browser_sessions ADD COLUMN paused_at DATETIME NULL/);
  assert.match(schema, /profile_mode VARCHAR\(16\) NOT NULL DEFAULT 'persistent'/);
  assert.match(schema, /host_session_id VARCHAR\(40\) NULL/);
  assert.match(schema, /runtime_port INT NULL/);
  assert.match(schema, /runtime_generation VARCHAR\(64\) NULL/);
  assert.match(schema, /ended_at DATETIME NULL/);
  assert.match(schema, /end_reason VARCHAR\(255\) NULL/);
  assert.match(schema, /expires_at DATETIME NULL/);
  assert.match(schema, /INDEX idx_browser_sessions_host \(host_session_id\)/);
  assert.match(storeSource, /ALTER TABLE browser_sessions ADD COLUMN profile_mode VARCHAR\(16\) NOT NULL DEFAULT 'persistent'/);
  assert.match(storeSource, /CREATE INDEX idx_browser_sessions_host ON browser_sessions \(host_session_id\)/);
  assert.match(storeSource, /async listHostedBrowserSessions\(/);
  assert.match(storeSource, /ALTER TABLE browser_sessions MODIFY COLUMN expires_at DATETIME NULL/);
  assert.match(storeSource, /SET expires_at = NULL\s+WHERE profile_mode <> 'ephemeral'/);
  assert.match(
    storeSource,
    /async listExpiredBrowserSessions\([\s\S]*?WHERE profile_mode = 'ephemeral'[\s\S]*?expires_at <= :now/
  );
  assert.match(schema, /updates JSON NULL/);
  assert.match(storeSource, /ALTER TABLE cloud_runs ADD COLUMN updates JSON NULL AFTER error/);
  assert.match(schema, /parent_run_id VARCHAR\(40\) NULL/);
  assert.match(schema, /tab_id BIGINT NULL/);
  assert.match(schema, /UNIQUE INDEX idx_cloud_runs_parent_run \(parent_run_id\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS warm_droplets/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS billing_accounts/);
  assert.match(schema, /credit_cents BIGINT NOT NULL DEFAULT 0/);
  assert.match(schema, /usage_remainder_units BIGINT NOT NULL DEFAULT 0/);
  assert.match(schema, /unlimited TINYINT\(1\) NOT NULL DEFAULT 0/);
  assert.match(schema, /stripe_payment_method_id VARCHAR\(255\) NULL/);
  assert.match(schema, /auto_top_up_enabled TINYINT\(1\) NOT NULL DEFAULT 0/);
  assert.match(schema, /auto_top_up_threshold_cents BIGINT NOT NULL DEFAULT 500/);
  assert.match(schema, /auto_top_up_amount_cents BIGINT NOT NULL DEFAULT 2500/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS billing_transactions/);
  assert.match(schema, /provider_ref VARCHAR\(255\) NULL UNIQUE/);
  assert.match(storeSource, /WHERE email = 'esokullu@gmail\.com'/);
  assert.match(
    storeSource,
    /updated_at = IF\(\s+billing_accounts\.unlimited = 0,\s+VALUES\(updated_at\),\s+billing_accounts\.updated_at\s+\)/
  );
  assert.match(storeSource, /async ensureBillingAccount\(/);
  assert.match(storeSource, /async applyBillingCredit\(/);
  assert.match(storeSource, /async meterBrowserSessionUsage\(/);
  assert.match(storeSource, /async beginAutoTopUpAttempt\(/);
  assert.match(schema, /billing_metered_at DATETIME NULL/);
  assert.match(storeSource, /ALTER TABLE browser_sessions ADD COLUMN billing_metered_at DATETIME NULL/);
  assert.match(schema, /assigned_session_id VARCHAR\(40\) NULL/);
  assert.match(schema, /INDEX idx_warm_droplets_status \(status, assigned_session_id\)/);
  assert.match(storeSource, /CREATE TABLE IF NOT EXISTS warm_droplets/);
  assert.match(storeSource, /async claimReadyWarmDroplet\(/);
  assert.match(storeSource, /ALTER TABLE cloud_runs ADD COLUMN parent_run_id VARCHAR\(40\) NULL AFTER user_id/);
  assert.match(storeSource, /ALTER TABLE cloud_runs ADD COLUMN tab_id BIGINT NULL AFTER parent_run_id/);
  assert.match(storeSource, /CREATE UNIQUE INDEX idx_cloud_runs_parent_run ON cloud_runs \(parent_run_id\)/);
  assert.match(storeSource, /async listCloudRunsForUser\(/);
  assert.match(storeSource, /WHERE user_id = :userId/);
  assert.match(storeSource, /ORDER BY created_at DESC, id DESC/);
  assert.match(storeSource, /JSON_LENGTH\(updates\)/);
  assert.match(storeSource, /async updateUser\(/);
  assert.match(storeSource, /SET email = :email, password_hash = :password_hash, updated_at = :updated_at/);
  assert.match(storeSource, /async deleteOtherWebSessions\(/);
  assert.match(storeSource, /DELETE FROM web_sessions WHERE user_id = :userId AND token_hash <> :keepTokenHash/);
});

test('MySQL browser session updates normalize billing timestamps for DATETIME columns', async () => {
  const calls = [];
  const store = {
    pool: {
      async execute(sql, values) {
        calls.push({ sql, values });
        return [{ affectedRows: 1 }];
      },
    },
    async getBrowserSession(id) {
      return { id, status: 'resuming' };
    },
  };
  const meteredAt = '2026-07-18T13:18:36.391Z';

  await MySqlStore.prototype.updateBrowserSessionIfStatus.call(store, 'bs_resume', 'paused', {
    status: 'resuming',
    paused_at: null,
    billing_metered_at: meteredAt,
    updated_at: meteredAt,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /WHERE id = :id AND status = :expectedStatus/);
  assert.equal(calls[0].values.paused_at, null);
  assert.equal(calls[0].values.billing_metered_at, '2026-07-18 13:18:36');
  assert.equal(calls[0].values.updated_at, '2026-07-18 13:18:36');
});

test('MySQL cloud-run normalization preserves unstructured string results', () => {
  const row = {
    id: 'run_string',
    output_schema: null,
    result: 'The page title is "Google".',
    created_at: new Date('2026-07-12T23:41:33.000Z'),
    updated_at: new Date('2026-07-12T23:41:44.000Z'),
    completed_at: new Date('2026-07-12T23:41:44.000Z'),
  };

  assert.equal(normalizeCloudRun(row).result, row.result);
});

test('MySQL cloud-run normalization preserves structured object results', () => {
  const result = { title: 'Google' };
  const updates = [{ seq: 1, type: 'thinking', data: { step: 1 } }];
  const row = {
    id: 'run_object',
    output_schema: { title: 'string' },
    result,
    updates,
    created_at: new Date('2026-07-12T23:41:33.000Z'),
    updated_at: new Date('2026-07-12T23:41:44.000Z'),
    completed_at: new Date('2026-07-12T23:41:44.000Z'),
  };

  assert.deepEqual(normalizeCloudRun(row).result, result);
  assert.deepEqual(normalizeCloudRun(row).updates, updates);
});

test('MySQL cloud-run normalization parses JSON update snapshots and defaults legacy rows', () => {
  const updates = [{ seq: 2, type: 'tool_call', data: { name: 'read_page' } }];
  const base = {
    id: 'run_updates',
    output_schema: null,
    result: null,
    created_at: new Date('2026-07-14T10:00:00.000Z'),
    updated_at: new Date('2026-07-14T10:00:01.000Z'),
    completed_at: null,
  };
  assert.deepEqual(normalizeCloudRun({ ...base, updates: JSON.stringify(updates) }).updates, updates);
  assert.deepEqual(normalizeCloudRun({ ...base, updates: null }).updates, []);
});
