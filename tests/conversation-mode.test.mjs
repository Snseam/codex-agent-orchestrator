import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { OrchestratorError } from '../src/errors.mjs';
import { disableConversationMode, enableConversationMode, statusConversationMode } from '../src/conversation-mode.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-mode-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project with spaces');
  await fs.mkdir(project);
  return { root, stateRoot: path.join(root, 'state'), project };
}

test('mode state is isolated by thread even for the same project', async t => {
  const { stateRoot, project } = await fixture(t);
  const realProject = await fs.realpath(project);
  const first = await enableConversationMode({ stateRoot, thread: 'thread-one', project, agent: 'codex', profile: 'profile_1', maxParallel: '4', maxAttempts: '5' });
  const second = await enableConversationMode({ stateRoot, thread: 'thread-two', project, agent: 'claude' });

  assert.equal(first.enabled, true);
  assert.equal(first.project, realProject);
  assert.equal(first.agent, 'codex');
  assert.equal(first.profile, 'profile_1');
  assert.equal(first.maxParallel, 4);
  assert.equal(first.maxAttempts, 5);
  assert.equal(second.enabled, true);
  assert.equal(second.agent, 'claude');
  assert.equal(second.maxParallel, 2);
  assert.equal(second.maxAttempts, 3);

  assert.equal((await statusConversationMode({ stateRoot, thread: 'thread-one' })).agent, 'codex');
  assert.equal((await statusConversationMode({ stateRoot, thread: 'thread-two' })).agent, 'claude');
});

test('repeat enable preserves previous settings unless explicit options update them', async t => {
  const { stateRoot, project } = await fixture(t);
  const realProject = await fs.realpath(project);
  await enableConversationMode({ stateRoot, thread: 'thread-one', project, agent: 'codex', profile: 'profile_1', maxParallel: '4', maxAttempts: '5' });
  const repeated = await enableConversationMode({ stateRoot, thread: 'thread-one' });
  assert.equal(repeated.project, realProject);
  assert.equal(repeated.agent, 'codex');
  assert.equal(repeated.profile, 'profile_1');
  assert.equal(repeated.maxParallel, 4);
  assert.equal(repeated.maxAttempts, 5);

  const updated = await enableConversationMode({ stateRoot, thread: 'thread-one', agent: 'auto', maxParallel: '1' });
  assert.equal(updated.agent, 'auto');
  assert.equal(updated.maxParallel, 1);
  assert.equal(updated.maxAttempts, 5);
});

test('adaptive mode stores on-demand calibration as schema 3 and preserves it across disable', async t => {
  const { stateRoot, project } = await fixture(t);
  const enabled = await enableConversationMode({
    stateRoot, thread: 'thread-one', project, strategy: 'adaptive',
    calibrationPolicy: 'on-demand', probeBudgetMs: '45000',
  });
  assert.equal(enabled.schemaVersion, 3);
  assert.equal(enabled.strategy, 'adaptive');
  assert.equal(enabled.calibrationPolicy, 'on-demand');
  assert.equal(enabled.probeBudgetMs, 45000);

  const disabled = await disableConversationMode({ stateRoot, thread: 'thread-one' });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.calibrationPolicy, 'on-demand');
  assert.equal(disabled.probeBudgetMs, 45000);

  const repeated = await enableConversationMode({ stateRoot, thread: 'thread-one' });
  assert.equal(repeated.enabled, true);
  assert.equal(repeated.calibrationPolicy, 'on-demand');
  assert.equal(repeated.probeBudgetMs, 45000);

  await assert.rejects(
    enableConversationMode({ stateRoot, thread: 'thread-one', strategy: 'delegated' }),
    error => error instanceof OrchestratorError && error.code === 'invalid_arguments',
  );
  const delegated = await enableConversationMode({ stateRoot, thread: 'thread-one', strategy: 'delegated', calibrationPolicy: 'off' });
  assert.equal(delegated.strategy, 'delegated');
  assert.equal(delegated.calibrationPolicy, 'off');
});

test('disable only flips the selected thread and missing status has no side effect', async t => {
  const { stateRoot, project } = await fixture(t);
  await enableConversationMode({ stateRoot, thread: 'thread-one', project, agent: 'codex' });
  await enableConversationMode({ stateRoot, thread: 'thread-two', project, agent: 'claude' });
  const disabled = await disableConversationMode({ stateRoot, thread: 'thread-one' });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.agent, 'codex');
  assert.equal((await statusConversationMode({ stateRoot, thread: 'thread-two' })).enabled, true);

  const missing = await statusConversationMode({ stateRoot, thread: 'missing-thread' });
  assert.equal(missing.enabled, false);
  assert.equal(missing.identityAvailable, true);
  await assert.rejects(fs.lstat(path.join(stateRoot, 'conversations', 'missing-thread')), { code: 'ENOENT' });
});

test('legacy mode schemas load with calibration defaults', async t => {
  const { stateRoot } = await fixture(t);
  const first = path.join(stateRoot, 'conversations', 'thread-one', 'mode.json');
  await fs.mkdir(path.dirname(first), { recursive: true });
  await fs.writeFile(first, JSON.stringify({
    schemaVersion: 1,
    threadId: 'thread-one',
    enabled: true,
    project: null,
    agent: null,
    profile: null,
    maxParallel: 2,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  const loadedOne = await statusConversationMode({ stateRoot, thread: 'thread-one' });
  assert.equal(loadedOne.schemaVersion, 1);
  assert.equal(loadedOne.calibrationPolicy, 'off');
  assert.equal(loadedOne.probeBudgetMs, 30000);

  const second = path.join(stateRoot, 'conversations', 'thread-two', 'mode.json');
  await fs.mkdir(path.dirname(second), { recursive: true });
  await fs.writeFile(second, JSON.stringify({
    schemaVersion: 2,
    threadId: 'thread-two',
    enabled: true,
    strategy: 'adaptive',
    preference: 'balanced',
    project: null,
    agent: null,
    profile: null,
    maxParallel: 2,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  const loadedTwo = await statusConversationMode({ stateRoot, thread: 'thread-two' });
  assert.equal(loadedTwo.schemaVersion, 2);
  assert.equal(loadedTwo.strategy, 'adaptive');
  assert.equal(loadedTwo.calibrationPolicy, 'off');
  assert.equal(loadedTwo.probeBudgetMs, 30000);
});

test('mode requires identity for mutations and validates inputs strictly', async t => {
  const { stateRoot, project } = await fixture(t);
  await assert.rejects(
    enableConversationMode({ stateRoot, project, env: {} }),
    error => error instanceof OrchestratorError && error.code === 'thread_unavailable',
  );
  await assert.rejects(
    disableConversationMode({ stateRoot, env: {} }),
    error => error instanceof OrchestratorError && error.code === 'thread_unavailable',
  );
  const noIdentity = await statusConversationMode({ stateRoot, env: {} });
  assert.equal(noIdentity.identityAvailable, false);
  assert.equal(noIdentity.enabled, false);

  await assert.rejects(enableConversationMode({ stateRoot, thread: '../bad', project }), /Thread id/);
  await assert.rejects(enableConversationMode({ stateRoot, thread: 'ok', project, agent: 'bad' }), /--agent/);
  await assert.rejects(enableConversationMode({ stateRoot, thread: 'ok', project, maxParallel: '0' }), /--max-parallel/);
  await assert.rejects(enableConversationMode({ stateRoot, thread: 'ok', project, maxAttempts: '21' }), /--max-attempts/);
  await assert.rejects(enableConversationMode({ stateRoot, thread: 'ok', project, calibrationPolicy: 'later' }), /--calibration-policy/);
  await assert.rejects(enableConversationMode({ stateRoot, thread: 'ok', project, strategy: 'shadow', calibrationPolicy: 'on-demand' }), /adaptive strategy/);
  await assert.rejects(enableConversationMode({ stateRoot, thread: 'ok', project, strategy: 'adaptive', probeBudgetMs: '60001' }), /--probe-budget-ms/);
  await assert.rejects(enableConversationMode({ stateRoot, thread: 'ok', project: path.join(project, 'missing') }), { code: 'ENOENT' });
});

test('CLI mode commands persist and reload conversation state without touching user directories', async t => {
  const { root, stateRoot, project } = await fixture(t);
  const env = { ...process.env, CODEX_THREAD_ID: 'env-thread', CODEX_HOME: path.join(root, 'codex-home') };
  const run = args => spawnSync(process.execPath, ['bin/cao.mjs', ...args, '--state-dir', stateRoot], { encoding: 'utf8', env });

  const enabled = run(['mode', 'enable', '--project', project, '--agent', 'codex']);
  assert.equal(enabled.status, 0, enabled.stderr);
  const enabledData = JSON.parse(enabled.stdout).data;
  assert.equal(enabledData.threadId, 'env-thread');
  assert.equal(enabledData.enabled, true);

  const status = run(['mode', 'status']);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).data.agent, 'codex');

  const disabled = run(['mode', 'disable']);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(JSON.parse(disabled.stdout).data.enabled, false);

  await assert.rejects(fs.lstat(path.join(env.CODEX_HOME, 'skills')), { code: 'ENOENT' });
});

test('mode rejects tampered records instead of spreading arbitrary JSON', async t => {
  const { stateRoot } = await fixture(t);
  const file = path.join(stateRoot, 'conversations', 'thread-one', 'mode.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    schemaVersion: 1,
    threadId: 'thread-one',
    enabled: 'false',
    project: null,
    agent: null,
    profile: null,
    maxParallel: 2,
    maxAttempts: 3,
  }));

  await assert.rejects(
    statusConversationMode({ stateRoot, thread: 'thread-one' }),
    error => error instanceof OrchestratorError && error.code === 'mode_state_invalid',
  );

  await fs.writeFile(file, JSON.stringify({
    schemaVersion: 1,
    threadId: 'other-thread',
    enabled: false,
    project: null,
    agent: null,
    profile: null,
    maxParallel: 2,
    maxAttempts: 3,
  }));

  await assert.rejects(
    enableConversationMode({ stateRoot, thread: 'thread-one' }),
    error => error instanceof OrchestratorError && error.code === 'mode_thread_mismatch',
  );
});

test('mode refuses state directories inside the selected or preserved project', async t => {
  const { root, project } = await fixture(t);
  const insideState = path.join(project, '.cao-state');
  await assert.rejects(
    enableConversationMode({ stateRoot: insideState, thread: 'thread-one', project }),
    error => error instanceof OrchestratorError && error.code === 'state_inside_project',
  );

  const aliasedRoot = path.join(root, 'aliased-project');
  await fs.symlink(project, aliasedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    enableConversationMode({ stateRoot: path.join(aliasedRoot, '.cao-state'), thread: 'thread-one', project }),
    error => error instanceof OrchestratorError && error.code === 'state_inside_project',
  );

  const modeFile = path.join(insideState, 'conversations', 'thread-two', 'mode.json');
  await fs.mkdir(path.dirname(modeFile), { recursive: true });
  await fs.writeFile(modeFile, JSON.stringify({
    schemaVersion: 1,
    threadId: 'thread-two',
    enabled: true,
    project: await fs.realpath(project),
    agent: null,
    profile: null,
    maxParallel: 2,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  await assert.rejects(
    enableConversationMode({ stateRoot: insideState, thread: 'thread-two' }),
    error => error instanceof OrchestratorError && error.code === 'state_inside_project',
  );
});
