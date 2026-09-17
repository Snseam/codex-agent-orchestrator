import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseArgs } from '../bin/cao.mjs';

test('CLI exposes help and validates command arguments', () => {
  assert.match(execFileSync(process.execPath, ['bin/cao.mjs', '--help'], { encoding: 'utf8' }), /dispatch submits once/);
  assert.throws(() => parseArgs(['verify', '--wat', 'x']), /Unknown option/);
  assert.throws(() => parseArgs(['status', '--run']), /Missing value/);
  assert.throws(() => parseArgs(['status', '--run', 'a', '--run', 'b']), /Duplicate option/);
  assert.deepEqual(parseArgs(['skill', 'install', '--skills-dir', '/tmp/codex skills']).command, 'skill install');
  assert.deepEqual(parseArgs(['mode', 'enable', '--thread', 'thread-1', '--max-parallel', '2']).command, 'mode enable');
  assert.throws(() => parseArgs(['skill', 'install', '--run', 'x']), /Unknown option/);
  assert.equal(parseArgs(['performance', 'report', '--run', 'r']).command, 'performance report');
  assert.equal(parseArgs(['result', 'submit', '--attempt-dir', '/tmp/attempt', '--stdin']).command, 'result submit');
  assert.deepEqual(parseArgs(['supervise', '--run', 'r', '--integrate', '--repair-reports']).values, { run: 'r', integrate: true, 'repair-reports': true });
  assert.equal(parseArgs(['dispatch', '--run', 'r', '--file', 't.json', '--adaptive']).values.adaptive, true);
  assert.equal(parseArgs(['dispatch', '--run', 'r', '--file', 't.json', '--adaptive', '--calibration-policy', 'on-demand', '--probe-budget-ms', '12000']).values['calibration-policy'], 'on-demand');
  assert.equal(parseArgs(['mode', 'enable', '--strategy', 'adaptive', '--preference', 'fastest']).values.strategy, 'adaptive');
  assert.equal(parseArgs(['mode', 'enable', '--strategy', 'adaptive', '--calibration-policy', 'on-demand']).values['calibration-policy'], 'on-demand');
  assert.throws(() => parseArgs(['supervise', '--integrate=true']), /takes no value/);
  assert.throws(() => parseArgs(['step', '--run', 'r', '--wait-ms', '4']), /Unknown option/);
  const r = spawnSync(process.execPath, ['bin/cao.mjs', 'unknown'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stderr).error.code, 'invalid_arguments');
});
