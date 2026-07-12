import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCloudRun } from '../src/db/mysql.js';

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
