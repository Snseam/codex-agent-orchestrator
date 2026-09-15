import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrchestratorError } from '../src/errors.mjs';
import {
  appendEvent,
  createRun,
  listRuns,
  loadRun,
  readJson,
  saveRun,
  validateId,
  withLock,
  writeJsonAtomic,
} from '../src/state.mjs';

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'cao-state-'));
}

test('writeJsonAtomic writes private JSON that readJson can read', async () => {
  const root = await tempRoot();
  const file = path.join(root, 'nested', 'value.json');

  await writeJsonAtomic(file, { ok: true, count: 2 });

  assert.deepEqual(await readJson(file), { ok: true, count: 2 });
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('readJson optional returns null for missing files', async () => {
  const root = await tempRoot();
  assert.equal(await readJson(path.join(root, 'missing.json'), { optional: true }), null);
});

test('withLock serializes concurrent callers', async () => {
  const root = await tempRoot();
  const lock = path.join(root, 'run.lock');
  const order = [];
  let active = 0;
  let maxActive = 0;
  let firstEntered;
  let releaseFirst;
  const firstEnteredPromise = new Promise((resolve) => {
    firstEntered = resolve;
  });
  const releaseFirstPromise = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = withLock(lock, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push('first:start');
    firstEntered();
    await releaseFirstPromise;
    order.push('first:end');
    active -= 1;
  });

  await firstEnteredPromise;

  const second = withLock(lock, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push('second:start');
    active -= 1;
    order.push('second:end');
  });

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end']);
  assert.equal(maxActive, 1);
});

test('withLock recovers a definitely dead local owner', async () => {
  const root = await tempRoot();
  const lock = path.join(root, 'stale.lock');
  await mkdir(lock);
  await writeFile(
    path.join(lock, 'owner.json'),
    `${JSON.stringify({
      pid: 99999999,
      hostname: os.hostname(),
      nonce: 'dead-owner',
      createdAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );

  const value = await withLock(lock, async () => 'recovered', { timeoutMs: 200 });
  assert.equal(value, 'recovered');
  await assert.rejects(stat(lock), { code: 'ENOENT' });
});

test('withLock serializes concurrent stale lock reapers without deleting the new owner', async () => {
  const root = await tempRoot();
  const lock = path.join(root, 'stale-race.lock');
  await mkdir(lock);
  await writeFile(
    path.join(lock, 'owner.json'),
    `${JSON.stringify({
      pid: 99999999,
      hostname: os.hostname(),
      nonce: 'dead-owner-race',
      createdAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );

  const entries = [];
  let active = 0;
  let maxActive = 0;
  async function critical(label) {
    entries.push(`${label}:start`);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 80));
    active -= 1;
    entries.push(`${label}:end`);
  }

  await Promise.all([
    withLock(
      lock,
      () => critical('first'),
      { timeoutMs: 1000 },
    ),
    withLock(
      lock,
      () => critical('second'),
      { timeoutMs: 1000 },
    ),
  ]);

  assert.equal(entries.includes('first:start'), true);
  assert.equal(entries.includes('first:end'), true);
  assert.equal(entries.includes('second:start'), true);
  assert.equal(entries.includes('second:end'), true);
  assert.equal(maxActive, 1);
  await assert.rejects(stat(lock), { code: 'ENOENT' });
});

test('withLock does not break a live or unknown owner', async () => {
  const root = await tempRoot();
  const lock = path.join(root, 'live.lock');
  await mkdir(lock);
  await writeFile(
    path.join(lock, 'owner.json'),
    `${JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      nonce: 'live-owner',
      createdAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );

  await assert.rejects(
    withLock(lock, async () => {}, { timeoutMs: 25 }),
    (error) => error instanceof OrchestratorError && error.code === 'lock_timeout',
  );

  assert.equal((await stat(lock)).isDirectory(), true);
  assert.equal((await readJson(path.join(lock, 'owner.json'))).nonce, 'live-owner');
});

test('run helpers create, save, load, list and append events', async () => {
  const root = await tempRoot();

  await createRun(root, { id: 'run_1', status: 'queued' });
  await assert.rejects(
    createRun(root, { id: 'run_1', status: 'queued' }),
    (error) => error instanceof OrchestratorError && error.code === 'run_exists',
  );

  await saveRun(root, { id: 'run_1', status: 'accepted' });
  await createRun(root, { id: 'run-2', status: 'queued' });

  assert.deepEqual(await loadRun(root, 'run_1'), { id: 'run_1', status: 'accepted' });
  assert.deepEqual(
    (await listRuns(root)).map((run) => run.id),
    ['run_1', 'run-2'].sort((a, b) => a.localeCompare(b)),
  );

  const event = await appendEvent(root, 'run_1', { type: 'started' });
  assert.equal(event.type, 'started');
  assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);

  const lines = (await readFile(path.join(root, 'runs', 'run_1', 'events.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).type, 'started');
});

test('validateId rejects unsafe ids', () => {
  assert.equal(validateId('Run_1-ok'), 'Run_1-ok');
  for (const id of ['', '-bad', '../bad', 'bad/path', 'x'.repeat(65)]) {
    assert.throws(() => validateId(id), OrchestratorError);
  }
});
