import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { task } from './helpers.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-prep-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const taskFile = path.join(root, 'task.json');
  await fs.writeFile(taskFile, JSON.stringify(task({ agent: 'auto' })));
  return { root, stateRoot: path.join(root, 'state'), taskFile };
}

test('CLI mode stores adaptive on-demand preparation without starting a task', async t => {
  const { stateRoot } = await fixture(t);
  const env = { ...process.env, CODEX_THREAD_ID: 'prep-thread' };
  const run = spawnSync(process.execPath, [
    'bin/cao.mjs', 'mode', 'enable',
    '--strategy', 'adaptive',
    '--calibration-policy', 'on-demand',
    '--probe-budget-ms', '45000',
    '--state-dir', stateRoot,
  ], { encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  const data = JSON.parse(run.stdout).data;
  assert.equal(data.schemaVersion, 3);
  assert.equal(data.strategy, 'adaptive');
  assert.equal(data.calibrationPolicy, 'on-demand');
  assert.equal(data.probeBudgetMs, 45000);
});

test('CLI rejects preparation options outside adaptive dispatch', async t => {
  const { stateRoot, taskFile } = await fixture(t);
  const run = spawnSync(process.execPath, [
    'bin/cao.mjs', 'dispatch',
    '--run', 'missing-run',
    '--file', taskFile,
    '--calibration-policy', 'on-demand',
    '--state-dir', stateRoot,
  ], { encoding: 'utf8', env: { ...process.env, CODEX_THREAD_ID: 'prep-thread' } });
  assert.equal(run.status, 2);
  const error = JSON.parse(run.stderr).error;
  assert.equal(error.code, 'invalid_arguments');
  assert.match(error.message, /adaptive/);
});

test('CLI rejects invalid probe budgets before persisting mode', async t => {
  const { stateRoot } = await fixture(t);
  const run = spawnSync(process.execPath, [
    'bin/cao.mjs', 'mode', 'enable',
    '--strategy', 'adaptive',
    '--probe-budget-ms', '60001',
    '--state-dir', stateRoot,
  ], { encoding: 'utf8', env: { ...process.env, CODEX_THREAD_ID: 'prep-thread' } });
  assert.equal(run.status, 2);
  const error = JSON.parse(run.stderr).error;
  assert.equal(error.code, 'invalid_arguments');
  assert.match(error.message, /--probe-budget-ms/);

  const status = spawnSync(process.execPath, ['bin/cao.mjs', 'mode', 'status', '--state-dir', stateRoot], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_THREAD_ID: 'prep-thread' },
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).data.enabled, false);
});
