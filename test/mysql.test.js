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
  assert.match(schema, /updates JSON NULL/);
  assert.match(storeSource, /ALTER TABLE cloud_runs ADD COLUMN updates JSON NULL AFTER error/);
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
