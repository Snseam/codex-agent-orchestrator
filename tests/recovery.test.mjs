import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Orchestrator } from '../src/orchestrator.mjs';
import { OrchestratorError } from '../src/errors.mjs';
import { FakeHerdr, fixture, promptData, task, writeResult } from './helpers.mjs';

async function setup(t, { runtime = new FakeHerdr(), command = okCommand } = {}) {
  const f = await fixture();
  t.after(f.remove);
  const service = new Orchestrator({ stateRoot: f.stateRoot, herdr: runtime, command });
  const run = await service.init({ project: f.project });
  return { ...f, service, run, runtime };
}

async function okCommand() {
  return { code: 0, stdout: '', stderr: '', truncated: false };
}

function noteTask(id = 'note') {
  return task({
    id,
    objective: 'Write a small note file.',
    allowedPaths: ['README.md'],
    checks: [{ name: 'ok', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 10000 }],
  });
}

async function writeNoteResult(prompt) {
  const data = promptData(prompt);
  await fs.writeFile(path.join(data.cwd, 'README.md'), `note from ${data.taskId}\n`);
  await fs.writeFile(data.resultFile, JSON.stringify({
    taskId: data.taskId,
    attemptId: data.attemptId,
    nonce: data.nonce,
    status: 'submitted',
    summary: 'Wrote a note',
    changedFiles: ['README.md'],
    checks: [],
    children: [],
    unresolved: [],
  }));
}

function runtimeForMixedTasks() {
  return new FakeHerdr(prompt => {
    const data = promptData(prompt);
    return data.taskId === 'fix-add' ? writeResult(prompt) : writeNoteResult(prompt);
  });
}

async function dispatchCollectVerify(service, runId, definition) {
  await service.dispatch(runId, definition);
  await service.collect(runId, definition.id);
  return service.verify(runId, definition.id);
}

async function waitForStatus(service, runId, taskId, status) {
  for (let i = 0; i < 100; i++) {
    const current = await service.inspect(runId, taskId);
    if (current.attempt.status === status) return current;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${taskId} to become ${status}`);
}

function changeProcessGroup(runtime, attempt, group) {
  runtime.panes.get(attempt.paneId).group = group;
}

test('integration_failed quarantines the project until recover succeeds without replaying the patch', async t => {
  let projectChecks = 0;
  let project;
  const command = async (_argv, { cwd }) => {
    if (cwd === project && projectChecks++ === 0) return { code: 1, stdout: '', stderr: 'integration failed once', truncated: false };
    return okCommand();
  };
  const ctx = await setup(t, { runtime: runtimeForMixedTasks(), command });
  project = await fs.realpath(ctx.project);
  const { service, run } = ctx;

  const note = noteTask();
  await dispatchCollectVerify(service, run.id, note);
  await dispatchCollectVerify(service, run.id, task());

  const failed = await service.integrate(run.id, task().id);
  assert.equal(failed.attempt.status, 'integration_failed');
  assert.match(await fs.readFile(path.join(project, 'src/math.mjs'), 'utf8'), /a \+ b/);

  await assert.rejects(service.dispatch(run.id, noteTask('later')), error => error.code === 'integration_recovery_required');
  await assert.rejects(service.integrate(run.id, note.id), error => error.code === 'integration_recovery_required');

  const recovered = await service.recover(run.id, task().id);
  assert.equal(recovered.attempt.status, 'integrated');
  assert.match(await fs.readFile(path.join(project, 'src/math.mjs'), 'utf8'), /a \+ b/);

  const afterHold = await service.dispatch(run.id, noteTask('after-hold'));
  assert.equal(afterHold.attempt.status, 'running');
});

test('integration_cancelled keeps the project quarantined', async t => {
  let project;
  const command = async (_argv, { cwd, signal }) => {
    if (cwd !== project) return okCommand();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw new OrchestratorError('command_cancelled', 'cancelled');
  };
  const ctx = await setup(t, { command });
  project = await fs.realpath(ctx.project);
  const { service, run } = ctx;

  await dispatchCollectVerify(service, run.id, task());
  const pending = service.integrate(run.id, task().id);
  await waitForStatus(service, run.id, task().id, 'integrating');
  assert.equal((await service.cancel(run.id, task().id)).attempt.status, 'cancelling');
  const cancelled = await pending;
  assert.equal(cancelled.attempt.status, 'integration_cancelled');

  await assert.rejects(service.dispatch(run.id, noteTask('blocked')), error => error.code === 'integration_recovery_required');
});

test('resume rejects an in-flight integration', async t => {
  let release;
  let project;
  const gate = new Promise(resolve => { release = resolve; });
  const command = async (_argv, { cwd }) => {
    if (cwd === project) await gate;
    return okCommand();
  };
  const ctx = await setup(t, { command });
  project = await fs.realpath(ctx.project);
  const { service, run } = ctx;

  await dispatchCollectVerify(service, run.id, task());
  const pending = service.integrate(run.id, task().id);
  await waitForStatus(service, run.id, task().id, 'integrating');
  await assert.rejects(service.resume(run.id, task().id), error => error.code === 'integration_recovery_required');
  release();
  assert.equal((await pending).attempt.status, 'integrated');
});

test('same pane process group changes are rejected for collect, input, and cancel', async t => {
  {
    const { service, run, runtime } = await setup(t);
    const launched = await service.dispatch(run.id, task());
    changeProcessGroup(runtime, launched.attempt, 99999);
    const result = await service.collect(run.id, task().id);
    assert.equal(result.attempt.status, 'uncertain');
    assert.equal(result.attempt.lastError.code, 'identity_changed');
  }

  {
    const { service, run, runtime } = await setup(t, { runtime: new FakeHerdr(async () => {}) });
    const launched = await service.dispatch(run.id, task());
    changeProcessGroup(runtime, launched.attempt, 99999);
    await assert.rejects(service.input(run.id, task().id, { text: 'hello' }), error => error.code === 'identity_changed');
  }

  {
    const { service, run, runtime } = await setup(t);
    const launched = await service.dispatch(run.id, task());
    changeProcessGroup(runtime, launched.attempt, 99999);
    const cancelled = await service.cancel(run.id, task().id);
    assert.equal(cancelled.attempt.status, 'cancelling');
    assert.equal(cancelled.attempt.lastError.code, 'identity_changed');
    assert.deepEqual(runtime.closed, []);
  }
});

test('idle worker without a result for more than five seconds becomes needs_input missing_result', async t => {
  const { service, run } = await setup(t, { runtime: new FakeHerdr(async () => {}) });
  const launched = await service.dispatch(run.id, task());
  await service._update(run.id, task().id, launched.attempt.id, attempt => {
    attempt.submissionStartedAt = new Date(Date.now() - 6000).toISOString();
  });

  const result = await service.collect(run.id, task().id);
  assert.equal(result.attempt.status, 'needs_input');
  assert.equal(result.attempt.lastError.code, 'missing_result');
});

test('failed checkout verification holds the project until retry or recover releases it', async t => {
  let project;
  const command = async (_argv, { cwd }) => {
    if (cwd === project) {
      const source = await fs.readFile(path.join(project, 'src/math.mjs'), 'utf8');
      return source.includes('a + b')
        ? { code: 0, stdout: 'ok', stderr: '', truncated: false }
        : { code: 1, stdout: '', stderr: 'math still subtracts', truncated: false };
    }
    return okCommand();
  };
  let checkoutPrompts = 0;
  const runtime = new FakeHerdr(async prompt => {
    const data = promptData(prompt);
    if (data.taskId !== 'fix-add') {
      await writeNoteResult(prompt);
      return;
    }
    checkoutPrompts++;
    if (checkoutPrompts === 1) {
      await fs.writeFile(path.join(data.cwd, 'src/math.mjs'), 'export const add = (a, b) => a * b;\n');
      await fs.writeFile(data.resultFile, JSON.stringify({
        taskId: data.taskId,
        attemptId: data.attemptId,
        nonce: data.nonce,
        status: 'submitted',
        summary: 'Changed add but tests still need work',
        changedFiles: ['src/math.mjs'],
        checks: [],
        children: [],
        unresolved: [],
      }));
      return;
    }
    await writeResult(prompt);
  });
  const ctx = await setup(t, { runtime, command });
  project = await fs.realpath(ctx.project);
  const { service, run } = ctx;
  const checkoutTask = task({ isolation: 'checkout' });
  const acceptedNote = noteTask('accepted-note');
  await dispatchCollectVerify(service, run.id, acceptedNote);

  await service.dispatch(run.id, checkoutTask);
  await service.collect(run.id, checkoutTask.id);
  const failed = await service.verify(run.id, checkoutTask.id);
  assert.equal(failed.attempt.status, 'rework');
  assert.equal(failed.attempt.workerClosed, true);
  assert.match(await fs.readFile(path.join(project, 'src/math.mjs'), 'utf8'), /a \* b/);

  const otherRun = await service.init({ project });
  await assert.rejects(service.dispatch(otherRun.id, noteTask('other-worktree')), error => error.code === 'checkout_busy');

  await assert.rejects(service.integrate(run.id, acceptedNote.id), error => error.code === 'checkout_busy');

  const retried = await service.retry(run.id, checkoutTask.id, 'Continue in the same checkout.');
  assert.equal(retried.attempt.status, 'running');
  assert.equal(checkoutPrompts, 2);
  await service.collect(run.id, checkoutTask.id);
  const accepted = await service.verify(run.id, checkoutTask.id);
  assert.equal(accepted.attempt.status, 'accepted');

  const afterRetry = await service.dispatch(otherRun.id, noteTask('after-retry'));
  assert.equal(afterRetry.attempt.status, 'running');
});

test('recover revalidates a stopped failed checkout without applying a patch and releases hold', async t => {
  let project;
  const command = async (_argv, { cwd }) => {
    if (cwd === project) {
      const source = await fs.readFile(path.join(project, 'src/math.mjs'), 'utf8');
      return source.includes('a + b')
        ? { code: 0, stdout: 'ok', stderr: '', truncated: false }
        : { code: 1, stdout: '', stderr: 'math still subtracts', truncated: false };
    }
    return okCommand();
  };
  const ctx = await setup(t, { runtime: new FakeHerdr(p => writeResult(p, { fix: false })), command });
  project = await fs.realpath(ctx.project);
  const { service, run } = ctx;
  const checkoutTask = task({ isolation: 'checkout' });

  await service.dispatch(run.id, checkoutTask);
  await service.collect(run.id, checkoutTask.id);
  const failed = await service.verify(run.id, checkoutTask.id);
  assert.equal(failed.attempt.status, 'rework');
  assert.equal(failed.attempt.workerClosed, true);
  assert.match(await fs.readFile(path.join(project, 'src/math.mjs'), 'utf8'), /a - b/);

  const otherRun = await service.init({ project });
  await assert.rejects(service.dispatch(otherRun.id, noteTask('blocked-before-recover')), error => error.code === 'checkout_busy');

  await fs.writeFile(path.join(project, 'src/math.mjs'), 'export const add = (a, b) => a + b;\n');
  const recovered = await service.recover(run.id, checkoutTask.id);
  assert.equal(recovered.attempt.status, 'accepted');
  assert.equal(recovered.attempt.patchFile, undefined);
  assert.match(await fs.readFile(path.join(project, 'src/math.mjs'), 'utf8'), /a \+ b/);

  const afterRecover = await service.dispatch(otherRun.id, noteTask('after-recover'));
  assert.equal(afterRecover.attempt.status, 'running');
});

test('cancelling an untouched checkout releases the checkout hold', async t => {
  const { service, run, project } = await setup(t, { runtime: new FakeHerdr(async () => {}) });
  const checkoutTask = task({ isolation: 'checkout' });

  const launched = await service.dispatch(run.id, checkoutTask);
  assert.equal(launched.attempt.status, 'running');
  const cancelled = await service.cancel(run.id, checkoutTask.id);
  assert.equal(cancelled.attempt.status, 'cancelled');
  assert.equal(cancelled.attempt.checkoutReleased, true);

  const otherRun = await service.init({ project });
  const next = await service.dispatch(otherRun.id, noteTask('after-clean-cancel'));
  assert.equal(next.attempt.status, 'running');
});
