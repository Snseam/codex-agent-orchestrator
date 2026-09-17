import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { checkNativeChildren } from '../src/native-children.mjs';
import { sanitizeHookInput } from '../src/monitor/claude-hook.mjs';

async function tmp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-native-children-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function task(extra = {}) {
  return { id: 'task-one', agent: 'claude', maxChildren: 1, ...extra };
}

function attempt(root, extra = {}) {
  const eventsFile = path.join(root, 'monitor', 'claude', 'run-one', 'task-one', 'attempt-one', 'events.ndjson');
  return {
    id: 'attempt-one',
    telemetry: { enabled: true, eventsFile, nativeSessionId: 'native-one' },
    ...extra,
  };
}

function report(children = []) {
  return { children };
}

function event(name, { agentId = null, sessionId = 'native-one', observedAt = '2026-09-15T00:00:00.000Z', cao = {} } = {}) {
  return sanitizeHookInput({
    hook_event_name: name,
    session_id: sessionId,
    ...(agentId ? { agent_id: agentId, agent_type: 'Explore' } : {}),
  }, {
    runId: cao.runId ?? 'run-one',
    taskId: cao.taskId ?? 'task-one',
    attemptId: cao.attemptId ?? 'attempt-one',
    nativeSessionId: sessionId,
  }, observedAt);
}

async function writeEvents(file, events) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, events.map(item => JSON.stringify(item)).join('\n') + '\n', { mode: 0o600 });
}

test('observed omitted running Claude child blocks even when the report has no children', async t => {
  const root = await tmp(t);
  const a = attempt(root);
  await writeEvents(a.telemetry.eventsFile, [
    event('SubagentStart', { agentId: 'child-one' }),
  ]);

  const result = await checkNativeChildren({ root, runId: 'run-one', task: task(), attempt: a, report: report([]) });
  assert.equal(result.state, 'blocked');
  assert.equal(result.complete, false);
  assert.deepEqual(result.children, [{ id: 'child-one', status: 'running' }]);
  assert.ok(result.reasons.includes('observed_child_running:child-one'));
  assert.ok(result.reasons.includes('observed_child_omitted:child-one'));
});

test('out-of-order duplicates are replayed by event time and foreign sessions are ignored', async t => {
  const root = await tmp(t);
  const a = attempt(root);
  await writeEvents(a.telemetry.eventsFile, [
    event('SubagentStop', { agentId: 'child-one', observedAt: '2026-09-15T00:00:02.000Z' }),
    event('SubagentStart', { agentId: 'child-one', observedAt: '2026-09-15T00:00:01.000Z' }),
    event('SubagentStart', { agentId: 'foreign-child', sessionId: 'foreign-session', observedAt: '2026-09-15T00:00:03.000Z' }),
    event('SubagentStop', { agentId: 'child-one', observedAt: '2026-09-15T00:00:02.000Z' }),
  ]);

  const result = await checkNativeChildren({
    root,
    runId: 'run-one',
    task: task(),
    attempt: a,
    report: report([{ id: 'child-one', status: 'completed' }]),
  });
  assert.equal(result.state, 'verified');
  assert.equal(result.complete, true);
  assert.deepEqual(result.children, [{ id: 'child-one', status: 'completed' }]);
  assert.deepEqual(result.reasons, []);
});

test('parent Stop does not complete a started child without explicit SubagentStop', async t => {
  const root = await tmp(t);
  const a = attempt(root);
  await writeEvents(a.telemetry.eventsFile, [
    event('SubagentStart', { agentId: 'child-one', observedAt: '2026-09-15T00:00:01.000Z' }),
    event('Stop', { observedAt: '2026-09-15T00:00:02.000Z' }),
  ]);

  const result = await checkNativeChildren({
    root,
    runId: 'run-one',
    task: task(),
    attempt: a,
    report: report([{ id: 'child-one', status: 'completed' }]),
  });
  assert.equal(result.state, 'blocked');
  assert.equal(result.complete, false);
  assert.deepEqual(result.children, [{ id: 'child-one', status: 'running' }]);
  assert.ok(result.reasons.includes('observed_child_running:child-one'));
});

test('oversized telemetry leaves Claude child acceptance unknown when children were allowed', async t => {
  const root = await tmp(t);
  const a = attempt(root);
  await fs.mkdir(path.dirname(a.telemetry.eventsFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(a.telemetry.eventsFile, 'x'.repeat(1024 * 1024 + 1), { mode: 0o600 });

  const result = await checkNativeChildren({
    root,
    runId: 'run-one',
    task: task({ maxChildren: 1 }),
    attempt: a,
    report: report([{ id: 'child-one', status: 'completed' }]),
  });
  assert.equal(result.state, 'unknown');
  assert.equal(result.complete, false);
  assert.deepEqual(result.reasons, ['telemetry_file_unsafe']);
});

test('maxChildren zero accepts empty report without telemetry but blocks observed children', async t => {
  const root = await tmp(t);
  const missingTelemetry = attempt(root, { telemetry: { enabled: false, reason: 'settings_disable_all_hooks' } });
  const noChildren = await checkNativeChildren({
    root,
    runId: 'run-one',
    task: task({ maxChildren: 0 }),
    attempt: missingTelemetry,
    report: report([]),
  });
  assert.equal(noChildren.state, 'reported');
  assert.equal(noChildren.complete, true);
  assert.deepEqual(noChildren.children, []);

  const observed = attempt(root);
  await writeEvents(observed.telemetry.eventsFile, [
    event('SubagentStart', { agentId: 'child-one', observedAt: '2026-09-15T00:00:01.000Z' }),
    event('SubagentStop', { agentId: 'child-one', observedAt: '2026-09-15T00:00:02.000Z' }),
  ]);
  const withChild = await checkNativeChildren({
    root,
    runId: 'run-one',
    task: task({ maxChildren: 0 }),
    attempt: observed,
    report: report([]),
  });
  assert.equal(withChild.state, 'blocked');
  assert.equal(withChild.complete, false);
  assert.ok(withChild.reasons.includes('observed_child_budget_exceeded'));
});

test('explicit SubagentStop verifies reported Claude child completion', async t => {
  const root = await tmp(t);
  const a = attempt(root);
  await writeEvents(a.telemetry.eventsFile, [
    event('SubagentStart', { agentId: 'child-one', observedAt: '2026-09-15T00:00:01.000Z' }),
    event('SubagentStop', { agentId: 'child-one', observedAt: '2026-09-15T00:00:02.000Z' }),
  ]);

  const result = await checkNativeChildren({
    root,
    runId: 'run-one',
    task: task(),
    attempt: a,
    report: report([{ id: 'child-one', status: 'completed' }]),
  });
  assert.equal(result.state, 'verified');
  assert.equal(result.complete, true);
  assert.equal(result.source, 'claude-hooks');
  assert.deepEqual(result.children, [{ id: 'child-one', status: 'completed' }]);
});

test('reported running children block and non-Claude agents remain report-contract evidence', async t => {
  const root = await tmp(t);
  const running = await checkNativeChildren({
    root,
    runId: 'run-one',
    task: task({ agent: 'pi', maxChildren: 1 }),
    attempt: { id: 'attempt-one' },
    report: report([{ id: 'child-one', status: 'running' }]),
  });
  assert.equal(running.state, 'blocked');
  assert.equal(running.complete, false);
  assert.deepEqual(running.reasons, ['reported_child_unfinished']);

  const completed = await checkNativeChildren({
    root,
    runId: 'run-one',
    task: task({ agent: 'pi', maxChildren: 1 }),
    attempt: { id: 'attempt-one' },
    report: report([{ id: 'child-one', status: 'completed' }]),
  });
  assert.equal(completed.state, 'reported');
  assert.equal(completed.complete, true);
  assert.equal(completed.source, 'report-contract');
  assert.deepEqual(completed.reasons, ['pi_telemetry_unsupported']);
});
