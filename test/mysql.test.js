import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeCloudRun } from '../src/db/mysql.js';

test('browser display names are present in fresh schema and existing-database migration', async () => {
  const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  const storeSource = await readFile(new URL('../src/db/mysql.js', import.meta.url), 'utf8');
  assert.match(schema, /display_name VARCHAR\(120\) NULL/);
  assert.match(storeSource, /ALTER TABLE browser_sessions ADD COLUMN display_name VARCHAR\(120\) NULL/);
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
  const row = {
    id: 'run_object',
    output_schema: { title: 'string' },
    result,
    created_at: new Date('2026-07-12T23:41:33.000Z'),
    updated_at: new Date('2026-07-12T23:41:44.000Z'),
    completed_at: new Date('2026-07-12T23:41:44.000Z'),
  };

  assert.deepEqual(normalizeCloudRun(row).result, result);
});
