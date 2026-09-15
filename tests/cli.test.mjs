import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseArgs } from '../bin/cao.mjs';

test('CLI exposes help and validates command arguments', () => {
  assert.match(execFileSync(process.execPath, ['bin/cao.mjs', '--help'], { encoding: 'utf8' }), /dispatch submits once/);
  assert.throws(() => parseArgs(['verify', '--wat', 'x']), /Unknown option/);
  assert.throws(() => parseArgs(['status', '--run']), /Missing value/);
  assert.throws(() => parseArgs(['status', '--run', 'a', '--run', 'b']), /Duplicate option/);
  const r = spawnSync(process.execPath, ['bin/cao.mjs', 'unknown'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stderr).error.code, 'invalid_arguments');
});
