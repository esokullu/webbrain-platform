import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeCloudRun } from '../src/db/mysql.js';

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
  assert.match(schema, /updates JSON NULL/);
  assert.match(storeSource, /ALTER TABLE cloud_runs ADD COLUMN updates JSON NULL AFTER error/);
  assert.match(schema, /parent_run_id VARCHAR\(40\) NULL/);
  assert.match(schema, /tab_id BIGINT NULL/);
  assert.match(schema, /UNIQUE INDEX idx_cloud_runs_parent_run \(parent_run_id\)/);
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
