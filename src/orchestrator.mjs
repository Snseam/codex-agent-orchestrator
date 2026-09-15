import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { OrchestratorError, invariant } from './errors.mjs';
import * as state from './state.mjs';
import { validateTask, taskDigest, outsideScope } from './task.mjs';
import * as git from './git.mjs';
import { Herdr } from './runtime/herdr.mjs';
import { runCommand } from './process.mjs';
import { buildLaunch, compilePrompt, compileDispatchPrompt } from './adapters.mjs';
import { ProfileStore } from './profiles.mjs';
import { GatewayManager } from './gateway/manager.mjs';
import { selectRoute, reserveExecution, releaseExecution, explainRoute } from './routing.mjs';
import { prepareExecution, cleanupExecution } from './execution-config.mjs';

const time = () => new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const active = new Set(['integrating', 'preparing', 'launching', 'ready', 'sending', 'running', 'uncertain', 'needs_input', 'submitted', 'verifying', 'cancelling']);
const integrationHold = a => ['integrating', 'integration_failed', 'integration_cancelled'].includes(a.status) || (a.status === 'cancelling' && a.operation?.kind === 'integration');
const checkoutHold = t => t.definition.isolation === 'checkout' && !['accepted', 'integrated'].includes(current(t).status) && !current(t).checkoutReleased;
const missing = error => ['agent_not_found', 'agent_not_running', 'pane_not_found'].includes(error.code);
const serializeError = e => ({ code: e.code || 'error', message: e.message, details: e.details || {} });
const current = record => record.attempts.find(a => a.id === record.currentAttempt);
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const hashFile = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

export function defaultStateRoot() {
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'codex-agent-orchestrator');
}

export class Orchestrator {
  constructor({ stateRoot = defaultStateRoot(), herdr = new Herdr(), command = runCommand, profiles, gateways, materialize = prepareExecution } = {}) {
    this.root = path.resolve(stateRoot);
    this.herdr = herdr;
    this.command = command;
    this.profiles = profiles || new ProfileStore({ root: this.root });
    this.gateways = gateways || new GatewayManager({ root: this.root, profiles: this.profiles });
    this.materialize = materialize;
  }

  async _loadRun(id) {
    const run = await state.loadRun(this.root, id);
    invariant(run, 'run_not_found', `Run ${id} does not exist.`);
    invariant(run.schemaVersion === 1 && run.id === id && run.tasks && typeof run.project === 'string', 'invalid_run', 'Run record is invalid or uses an unsupported schema.');
    return run;
  }

  async init({ project, id, maxParallel = 4 }) {
    const info = await git.getProjectInfo(path.resolve(project));
    invariant(!inside(info.root, this.root), 'state_inside_project', 'State directory must be outside the project working tree.');
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    this.root = await fs.realpath(this.root);
    invariant(!inside(info.root, this.root), 'state_inside_project', 'State directory resolves inside the project.');
    invariant(Number.isInteger(maxParallel) && maxParallel > 0 && maxParallel <= 64, 'invalid_capacity', 'maxParallel must be an integer from 1 to 64.');
    const runId = id || `run-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    state.validateId(runId);
    const run = {
      schemaVersion: 1, id: runId, project: info.root, baseCommit: info.head,
      baseline: await git.snapshot(info.root), initiallyDirty: info.dirty,
      herdrSession: `cao-${crypto.randomBytes(10).toString('hex')}`,
      createdAt: time(), updatedAt: time(), maxParallel, server: null, tasks: {},
    };
    await state.createRun(this.root, run);
    await state.appendEvent(this.root, run.id, { type: 'run.created', project: run.project });
    return this.status(run.id);
  }

  async _change(runId, action) {
    await this._loadRun(runId);
    return state.withLock(path.join(state.runPath(this.root, runId), '.lock'), async () => {
      const run = await this._loadRun(runId);
      const result = await action(run);
      run.updatedAt = time();
      await state.saveRun(this.root, run);
      return result;
    });
  }

  async _attempt(runId, taskId) {
    state.validateId(taskId);
    const run = await this._loadRun(runId);
    const task = Object.hasOwn(run.tasks, taskId) ? run.tasks[taskId] : null;
    invariant(task, 'task_not_found', `Task ${taskId} does not exist.`);
    return { run, task, attempt: current(task) };
  }

  async _update(runId, taskId, attemptId, change) {
    return this._change(runId, async run => {
      const task = Object.hasOwn(run.tasks, taskId) ? run.tasks[taskId] : null;
      invariant(task?.currentAttempt === attemptId, 'stale_attempt', 'The current attempt changed.');
      const attempt = current(task);
      const before = attempt.status;
      await change(attempt, task, run);
      if (before !== attempt.status) await state.appendEvent(this.root, runId, {
        type: 'attempt.state', taskId, attemptId, from: before, to: attempt.status,
      });
      return structuredClone(attempt);
    });
  }

  async _reserve(runId, definition, feedback, retry = false) {
    const initial = await this._loadRun(runId);
    const key = crypto.createHash('sha256').update(initial.project).digest('hex');
    return state.withLock(path.join(this.root, 'locks', `project-${key}`), () => this._change(runId, async run => {
      invariant(!run.closedAt, 'run_closed', 'This run was cleaned up. Create a new run for more work.');
      let record = Object.hasOwn(run.tasks, definition.id) ? run.tasks[definition.id] : null;
      const digest = taskDigest(definition);
      if (record && !retry) {
        invariant(record.digest === digest, 'task_conflict', 'Task ID already exists with a different definition.');
        return { duplicate: true, task: structuredClone(record), run: structuredClone(run) };
      }
      if (retry) {
        invariant(record, 'task_not_found', 'Cannot retry a missing task.');
        invariant(['rework', 'failed', 'interrupted', 'cancelled'].includes(current(record).status), 'attempt_active', 'Collect, verify or cancel the current attempt before retrying.');
        invariant(record.attempts.length < definition.maxAttempts, 'attempt_limit', 'The configured attempt limit was reached.');
        invariant(current(record).workerClosed || !current(record).paneId, 'worker_not_stopped', 'The previous worker must be confirmed stopped before retrying.');
      }
      for (const dependency of definition.dependsOn) {
        const predecessor = Object.hasOwn(run.tasks, dependency) ? run.tasks[dependency] : null;
        invariant(predecessor && ['accepted', 'integrated'].includes(current(predecessor).status), 'dependency_not_ready', `Dependency ${dependency} is not accepted.`);
        invariant(current(predecessor).status === 'integrated' || definition.isolation === 'checkout', 'dependency_not_integrated', `Integrate ${dependency} before creating a dependent worktree.`);
      }
      const count = Object.values(run.tasks).filter(t => active.has(current(t).status)).length;
      invariant(count < run.maxParallel, 'capacity_exceeded', 'Run capacity reached. Collect and verify or cancel existing work.');
      for (const other of await state.listRuns(this.root)) {
        if (other.project !== run.project) continue;
        invariant(!Object.values(other.tasks || {}).some(t => integrationHold(current(t))), 'integration_recovery_required', 'The project has an incomplete integration. Inspect and recover it before starting new work.');
        invariant(!Object.values(other.tasks || {}).some(t => checkoutHold(t) && !(retry && other.id === runId && t.definition.id === definition.id)), 'checkout_busy', 'A checkout task owns unverified project changes. Retry or recover that task before starting other work.');
      }
      if (definition.isolation === 'checkout') {
        for (const other of await state.listRuns(this.root)) {
          if (other.project !== run.project) continue;
          for (const task of Object.values(other.tasks || {})) {
            if (other.id === run.id && task.definition.id === definition.id) continue;
            invariant(!(task.definition.isolation === 'checkout' && active.has(current(task).status)), 'checkout_busy', 'Another task owns the shared checkout. Use a worktree for parallel writes.');
          }
        }
      }
      const number = record ? record.attempts.length + 1 : 1;
      const id = `${definition.id}-a${number}-${crypto.randomBytes(4).toString('hex')}`;
      const directory = path.join(state.runPath(this.root, run.id), 'attempts', id);
      const previous = retry ? current(record) : null;
      const attempt = {
        id, taskId: definition.id, number, nonce: crypto.randomUUID(), directory,
        resultFile: path.join(directory, 'result.json'), status: 'preparing', createdAt: time(),
        cwd: previous?.cwd || null, baseline: previous?.baseline || null,
        workerName: `worker-${crypto.randomBytes(8).toString('hex')}`, paneId: null, terminalId: null,
        submissionStartedAt: null, workerClosed: false, cancelRequested: false,
        feedback: feedback || '', previousAttempt: previous?.id || null,
        baselineTree: previous?.baselineTree || null,
        launcherPid: process.pid, launcherHost: os.hostname(), launchFinishedAt: null,
      };
      record ||= { definition, digest, attempts: [] };
      record.attempts.push(attempt);
      record.currentAttempt = id;
      run.tasks[definition.id] = record;
      await state.appendEvent(this.root, run.id, { type: 'attempt.reserved', taskId: definition.id, attemptId: id });
      return { duplicate: false, task: structuredClone(record), run: structuredClone(run), attempt: structuredClone(attempt) };
    }));
  }

  async dispatch(runId, input) {
    const task = validateTask(input);
    const reserved = await this._reserve(runId, task);
    if (reserved.duplicate) return { duplicate: true, ...(await this.inspect(runId, task.id)) };
    await this._launch(reserved);
    return this.inspect(runId, task.id);
  }

  async _cancelCheck(runId, taskId) {
    const { attempt } = await this._attempt(runId, taskId);
    if (attempt.cancelRequested) throw new OrchestratorError('cancel_requested', 'Attempt was cancelled during launch.');
  }

  async _launch({ run, task, attempt }) {
    const update = fn => this._update(run.id, task.definition.id, attempt.id, fn);
    try {
      await fs.mkdir(attempt.directory, { recursive: true, mode: 0o700 });
      await this._configureExecution(run, task, attempt);
      await this._cancelCheck(run.id, task.definition.id);
      if (!attempt.cwd) {
        if (task.definition.isolation === 'worktree') {
          const info = await git.getProjectInfo(run.project);
          attempt.baselineTree = await git.snapshotTree(run.project);
          attempt.cwd = await git.createWorktree(run.project, path.join(attempt.directory, 'worktree'), info.head, attempt.baselineTree);
        } else attempt.cwd = run.project;
        attempt.baseline = await git.snapshot(attempt.cwd);
      }
      await update(a => { a.cwd = attempt.cwd; a.baseline = attempt.baseline; a.baselineTree = attempt.baselineTree; });
      await state.writeJsonAtomic(path.join(attempt.directory, 'task.json'), task.definition);
      await fs.writeFile(path.join(attempt.directory, 'prompt.txt'), compilePrompt(this._effectiveTask(task.definition, attempt), attempt), { mode: 0o600 });
      await this._cancelCheck(run.id, task.definition.id);
      if (attempt.execution) {
        const gatewayId = `gw-${crypto.createHash('sha256').update(run.id + attempt.id).digest('hex').slice(0, 24)}`;
        await update(a => { a.execution.gatewayId = gatewayId; });
        const gateway = await this.gateways.start({ id: gatewayId, snapshots: attempt.execution.snapshots, requireCapabilities: task.definition.execution?.requireCapabilities || [], allowShared: attempt.execution.allowShared });
        attempt.execution.gateway = gateway;
        await update(a => { a.execution.gateway = gateway; });
        await this._cancelCheck(run.id, task.definition.id);
        const manifest = await this.materialize({ task: task.definition, attempt, profile: attempt.execution.profile, gateway });
        attempt.launchManifest = manifest;
        await update(a => { a.launchManifest = manifest; a.nativeSession = manifest.nativeSession; });
      }
      const server = await state.withLock(path.join(state.runPath(this.root, run.id), '.server.lock'), () => this.herdr.ensureServer(run.herdrSession, path.join(state.runPath(this.root, run.id), 'herdr-server.log')), { timeoutMs: 15000 });
      await this._change(run.id, r => { r.server ||= server; });
      await this._cancelCheck(run.id, task.definition.id);
      const workspace = await this.herdr.createWorkspace(run.herdrSession, attempt.cwd, attempt.id);
      const pane = workspace.result?.root_pane;
      invariant(pane?.pane_id && pane?.terminal_id, 'invalid_runtime_response', 'Herdr did not return a pane and terminal identity.');
      await update(a => { a.paneId = pane.pane_id; a.terminalId = pane.terminal_id; a.workspaceId = pane.workspace_id; a.status = a.cancelRequested ? 'cancelling' : 'launching'; });
      await this._cancelCheck(run.id, task.definition.id);
      if (attempt.launchManifest) {
        await this.herdr.prepareEnvironment(run.herdrSession, pane.pane_id, attempt.launchManifest);
        await this._cancelCheck(run.id, task.definition.id);
      }
      const launch = attempt.launchManifest || buildLaunch(task.definition, attempt.directory);
      await this.herdr.startAgent(run.herdrSession, attempt.workerName, launch.kind, pane.pane_id, launch.args);
      await this._captureIdentity(run.id, task.definition.id);
      await this._cancelCheck(run.id, task.definition.id);
      await update(a => { a.status = 'ready'; });
      await this._sendOnce(run.id, task.definition.id);
    } catch (error) {
      const now = await this._attempt(run.id, task.definition.id);
      if (now.attempt.paneId && !now.attempt.submissionStartedAt && !now.attempt.cancelRequested) {
        try { await this._captureIdentity(run.id, task.definition.id); } catch { /* Preserve the original startup failure. */ }
      }
      if (now.attempt.cancelRequested) {
        await this.cancel(run.id, task.definition.id);
      } else {
        await update(a => {
          a.lastError = serializeError(error);
          a.status = !a.paneId ? 'failed' : (a.submissionStartedAt ? 'uncertain' : 'needs_input');
        });
        if (!now.attempt.paneId) {
          await update(a => { a.workerClosed = true; });
          await this._releaseRuntime(run.id, task.definition.id, attempt.id);
        }
      }
    } finally {
      await update(a => { a.launchFinishedAt = time(); if (a.cancelRequested && !a.paneId) { a.workerClosed = true; a.status = 'cancelled'; } });
      const latest = await this._attempt(run.id, task.definition.id);
      if (latest.attempt.workerClosed) await this._releaseRuntime(run.id, task.definition.id, attempt.id);
    }
  }

  _effectiveTask(definition, attempt) {
    return attempt.execution ? { ...definition, agent: attempt.execution.agent } : definition;
  }

  async _configureExecution(run, task, attempt) {
    const defaultProfile = task.definition.execution ? null : await this.profiles.getDefault();
    const selector = task.definition.execution || (defaultProfile ? { profile: defaultProfile.id } : null);
    if (!selector) {
      invariant(task.definition.agent !== 'auto', 'execution_required', 'agent:auto requires an execution selector or a default profile.');
      return;
    }
    const owner = { runId: run.id, taskId: task.definition.id, attemptId: attempt.id };
    const selected = await selectRoute(this.profiles, selector, owner, { agent: task.definition.agent === 'auto' ? null : task.definition.agent });
    const execution = {
      agent: selected.profile.agent, model: selected.profile.model, profileId: selected.profile.id,
      profileRevision: selected.profile.revision, profile: selected.profile, decision: selected.decision,
      selector: structuredClone(selector), selectorSource: task.definition.execution ? 'task' : 'default-profile',
      allowShared: selector.allowShared === true, reservations: [selected.reservation], snapshots: [selected.profile],
      excludedFallbacks: [], gateway: null, configuredAt: time(),
    };
    attempt.execution = execution;
    await this._update(run.id, task.definition.id, attempt.id, a => { a.execution = structuredClone(execution); });
    for (const id of selected.profile.fallbacks) {
      if (id === selected.profile.id) continue;
      const decision = await explainRoute(this.profiles, { profile: id, requireCapabilities: selector.requireCapabilities || [], allowShared: execution.allowShared }, { agent: execution.agent });
      invariant(decision.selectedProfileId, 'fallback_unavailable', 'Configured fallback profile is not eligible.', { profileId: id, decision });
      const fallback = await this.profiles.resolve(id);
      invariant(fallback.protocol === selected.profile.protocol, 'fallback_incompatible', 'Fallback protocol must match the selected profile.');
      try {
        const reservation = await reserveExecution(this.root, fallback, owner);
        if (!execution.reservations.some(r => r.id === reservation.id)) execution.reservations.push(reservation);
        execution.snapshots.push(fallback);
      } catch (error) {
        if (error.code !== 'route_capacity_exhausted') throw error;
        execution.excludedFallbacks.push({ profileId: id, reason: 'capacity_exhausted' });
      }
      await this._update(run.id, task.definition.id, attempt.id, a => { a.execution = structuredClone(execution); });
    }
  }

  async _releaseRuntime(runId, taskId, attemptId) {
    const { attempt } = await this._attempt(runId, taskId);
    if (!attempt.execution || attempt.runtimeReleasedAt) return;
    invariant(attempt.id === attemptId && attempt.workerClosed, 'worker_not_stopped', 'Stop the worker before releasing its execution resources.');
    try {
      const gatewayId = attempt.execution.gateway?.id || attempt.execution.gatewayId;
      if (gatewayId) {
        const deadline = Date.now() + 5000;
        while (true) {
          try { await this.gateways.stop(gatewayId); break; }
          catch (error) { if (error.code !== 'gateway_busy' || Date.now() >= deadline) throw error; await sleep(100); }
        }
      }
      const resources = await cleanupExecution(attempt.launchManifest);
      for (const reservation of attempt.execution.reservations) await releaseExecution(this.root, reservation);
      await this._update(runId, taskId, attemptId, a => { a.runtimeReleasedAt = time(); a.executionCleanup = resources; delete a.runtimeCleanupError; });
    } catch (error) {
      await this._update(runId, taskId, attemptId, a => { a.runtimeCleanupError = serializeError(error); });
      throw error;
    }
  }

  async _sendOnce(runId, taskId) {
    let { run, task, attempt } = await this._attempt(runId, taskId);
    await this._cancelCheck(runId, taskId);
    if (!attempt.processIdentity) {
      await this._captureIdentity(runId, taskId);
      ({ run, task, attempt } = await this._attempt(runId, taskId));
    }
    const live = await this._assertIdentity(run, attempt);
    invariant(live.interactive_ready && ['idle', 'done'].includes(live.agent_status), 'agent_not_ready', 'Agent must be ready before submitting a new task.');
    const claimed = await this._update(runId, taskId, attempt.id, a => {
      invariant(!a.submissionStartedAt, 'already_submitted', 'Submission already started; reconcile instead of resending.');
      invariant(!a.cancelRequested, 'cancel_requested', 'Attempt is being cancelled.');
      a.submissionStartedAt = time(); a.status = 'sending';
    });
    try {
      await this.herdr.prompt(run.herdrSession, attempt.workerName, compileDispatchPrompt(this._effectiveTask(task.definition, claimed), claimed), 0);
      await this._update(runId, taskId, attempt.id, a => {
        a.submissionAcknowledgedAt = time();
        a.status = a.cancelRequested ? 'cancelling' : 'running';
        delete a.lastError;
      });
    } catch (error) {
      await this._update(runId, taskId, attempt.id, a => {
        a.status = a.cancelRequested ? 'cancelling' : 'uncertain';
        a.lastError = serializeError(error);
      });
    }
    const latest = await this._attempt(runId, taskId);
    if (latest.attempt.cancelRequested) await this.cancel(runId, taskId);
  }

  async _captureIdentity(runId, taskId) {
    const { run, attempt } = await this._attempt(runId, taskId);
    if (attempt.processIdentity) return this._assertIdentity(run, attempt);
    const live = (await this.herdr.getAgent(run.herdrSession, attempt.workerName)).result?.agent;
    invariant(live?.terminal_id === attempt.terminalId, 'identity_changed', 'The target terminal identity changed.');
    const info = (await this.herdr.getProcessInfo(run.herdrSession, attempt.paneId)).result?.process_info;
    invariant(info?.foreground_process_group_id && info?.shell_pid, 'identity_unavailable', 'Cannot identify the worker process group.');
    await this._update(runId, taskId, attempt.id, a => {
      a.processIdentity = { group: info.foreground_process_group_id, shell: info.shell_pid, agent: live.agent };
    });
  }

  async _assertIdentity(run, attempt) {
    const live = (await this.herdr.getAgent(run.herdrSession, attempt.workerName)).result?.agent;
    invariant(live?.terminal_id === attempt.terminalId && live?.pane_id === attempt.paneId, 'identity_changed', 'The target terminal identity changed.');
    if (attempt.processIdentity) {
      const info = (await this.herdr.getProcessInfo(run.herdrSession, attempt.paneId)).result?.process_info;
      invariant(info?.foreground_process_group_id === attempt.processIdentity.group && info?.shell_pid === attempt.processIdentity.shell && live.agent === attempt.processIdentity.agent, 'identity_changed', 'Worker process identity changed; automatic adoption is refused.');
    }
    return live;
  }

  async inspect(runId, taskId, { output = false } = {}) {
    const { run, task, attempt } = await this._attempt(runId, taskId);
    const result = { runId, task: task.definition, attempt, stateDirectory: state.runPath(this.root, runId) };
    if (output && attempt.paneId && !attempt.workerClosed) {
      try { result.output = await this.herdr.readAgent(run.herdrSession, attempt.workerName); }
      catch (error) { result.outputError = serializeError(error); }
    }
    return result;
  }

  async status(runId) {
    if (!runId) return (await state.listRuns(this.root)).map(r => ({ id: r.id, project: r.project, taskCount: Object.keys(r.tasks || {}).length, createdAt: r.createdAt }));
    const run = await this._loadRun(runId);
    return { ...run, stateDirectory: state.runPath(this.root, runId), tasks: Object.values(run.tasks).map(t => ({ id: t.definition.id, agent: t.definition.agent, isolation: t.definition.isolation, ...current(t) })) };
  }

  async input(runId, taskId, { keys, text } = {}) {
    const { run, attempt } = await this._attempt(runId, taskId);
    invariant(!attempt.workerClosed && attempt.paneId, 'worker_not_running', 'No live worker to address.');
    invariant(!attempt.cancelRequested && !['submitted', 'verifying', 'accepted', 'integrated'].includes(attempt.status), 'input_not_allowed', 'Input is disabled after submission or cancellation.');
    await this._assertIdentity(run, attempt);
    invariant(Boolean(keys?.length) !== Boolean(text), 'invalid_input', 'Supply either keys or text.');
    if (keys?.length) await this.herdr.keys(run.herdrSession, attempt.workerName, keys);
    else await this.herdr.prompt(run.herdrSession, attempt.workerName, text, 0);
    await this._change(runId, r => state.appendEvent(this.root, r.id, { type: 'worker.input', taskId, attemptId: attempt.id, inputKind: keys ? 'keys' : 'text' }));
    return this.inspect(runId, taskId);
  }

  async resume(runId, taskId) {
    const { run, attempt } = await this._attempt(runId, taskId);
    invariant(!integrationHold(attempt), 'integration_recovery_required', 'Use recover to recheck the current checkout without applying the patch again.');
    invariant(attempt.status !== 'verifying' && !(attempt.status === 'cancelling' && attempt.operation?.kind === 'verification'), 'verification_in_progress', 'Verification owns this candidate. Inspect its process and evidence before recovery; resume never resubmits or reruns these checks.');
    if (!attempt.paneId && ['preparing', 'cancelling'].includes(attempt.status) && attempt.launcherHost === os.hostname() && !alive(attempt.launcherPid)) {
      await this._update(runId, taskId, attempt.id, a => {
        a.status = a.cancelRequested ? 'cancelled' : 'interrupted'; a.workerClosed = true;
        a.lastError = { code: 'startup_interrupted', message: 'Launch process exited before recording a worker. Any empty runtime panes are retained for cleanup.' };
      });
      return this.inspect(runId, taskId);
    }
    invariant(!attempt.cancelRequested, 'cancel_requested', 'Resume cannot undo cancellation; use retry after cancellation completes.');
    invariant(!attempt.workerClosed, 'worker_closed', 'The worker is closed. Use retry with a handoff for further work.');
    if (attempt.submissionStartedAt) return this.collect(runId, taskId);
    invariant(attempt.paneId, 'not_started', 'No worker was created. Use retry to start a new attempt.');
    try { await this._sendOnce(runId, taskId); }
    catch (error) {
      await this._update(runId, taskId, attempt.id, a => { a.lastError = serializeError(error); a.status = missing(error) ? 'interrupted' : 'needs_input'; });
    }
    return this.inspect(runId, taskId);
  }

  _validateResult(value, task, attempt) {
    invariant(value && typeof value === 'object' && !Array.isArray(value), 'invalid_result', 'Result must be an object.');
    invariant(value.taskId === task.id && value.attemptId === attempt.id && value.nonce === attempt.nonce, 'stale_result', 'Result does not match this task, attempt and nonce.');
    invariant(['submitted', 'needs_input'].includes(value.status), 'invalid_result', 'Result status must be submitted or needs_input.');
    invariant(typeof value.summary === 'string' && Array.isArray(value.changedFiles) && value.changedFiles.every(x => typeof x === 'string'), 'invalid_result', 'Result must contain summary and changedFiles.');
    invariant(Array.isArray(value.checks) && Array.isArray(value.children) && Array.isArray(value.unresolved), 'invalid_result', 'Result must contain checks, children and unresolved arrays.');
    const ids = new Set();
    for (const child of value.children) {
      invariant(child && typeof child.id === 'string' && !ids.has(child.id) && ['completed', 'cancelled', 'running', 'unknown'].includes(child.status), 'invalid_result', 'Invalid or duplicate child record.');
      ids.add(child.id);
    }
    invariant(value.children.length <= task.maxChildren, 'child_budget_exceeded', 'Reported children exceed the task budget. This budget is a reporting contract, not a sandbox.');
    return value;
  }

  async collect(runId, taskId, { waitMs = 0 } = {}) {
    await this._attempt(runId, taskId);
    return state.withLock(path.join(state.runPath(this.root, runId), `verify-${taskId}.lock`), () => this._collect(runId, taskId, { waitMs }));
  }

  async _collect(runId, taskId, { waitMs = 0 } = {}) {
    invariant(Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= 45000, 'invalid_timeout', 'collect waitMs must be between 0 and 45000.');
    const deadline = Date.now() + waitMs;
    while (true) {
      const { run, task, attempt } = await this._attempt(runId, taskId);
      if (!['running', 'sending', 'uncertain', 'needs_input'].includes(attempt.status)) return this.inspect(runId, taskId);
      invariant(attempt.submissionStartedAt, 'not_submitted', 'Task has not been submitted. Inspect the worker and resume once it is ready.');
      let live;
      try {
        live = await this._assertIdentity(run, attempt);
      } catch (error) {
        await this._update(runId, taskId, attempt.id, a => { if (!a.cancelRequested) a.status = missing(error) ? 'interrupted' : 'uncertain'; a.lastError = serializeError(error); });
        return this.inspect(runId, taskId);
      }
      if (live.agent_status === 'blocked') {
        await this._update(runId, taskId, attempt.id, a => { if (!a.cancelRequested) a.status = 'needs_input'; a.lastObservedState = 'blocked'; });
        return this.inspect(runId, taskId, { output: true });
      }
      if (!live.interactive_ready && attempt.status === 'needs_input') {
        await this._update(runId, taskId, attempt.id, a => { if (!a.cancelRequested) { a.status = 'running'; delete a.lastError; } });
      }
      if (live.interactive_ready && ['idle', 'done'].includes(live.agent_status)) {
        try {
          const stat = await fs.lstat(attempt.resultFile);
          invariant(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 131072, 'invalid_result', 'Result must be a regular file of at most 128 KiB.');
          const report = this._validateResult(await state.readJson(attempt.resultFile), task.definition, attempt);
          const childrenComplete = report.children.every(c => ['completed', 'cancelled'].includes(c.status));
          const snap = await git.snapshot(attempt.cwd);
          const changed = git.changedPaths(attempt.baseline, snap);
          const unexpected = outsideScope(changed, task.definition.allowedPaths);
          const resultState = report.status === 'needs_input' || !childrenComplete || report.unresolved.length || unexpected.length ? 'needs_input' : 'submitted';
          const output = await this.herdr.readAgent(run.herdrSession, attempt.workerName);
          await fs.writeFile(path.join(attempt.directory, 'terminal.txt'), output, { mode: 0o600 });
          await this._update(runId, taskId, attempt.id, a => {
            a.report = report; a.collectedAt = time(); a.snapshot = snap; a.changedPaths = changed;
            a.outsideScope = unexpected; if (!a.cancelRequested) a.status = resultState;
            delete a.lastError;
          });
          return this.inspect(runId, taskId);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            await this._update(runId, taskId, attempt.id, a => { if (!a.cancelRequested) a.status = 'needs_input'; a.lastError = serializeError(error); });
            return this.inspect(runId, taskId);
          }
          if (Date.now() >= deadline && Date.now() - Date.parse(attempt.submissionStartedAt) >= 5000) {
            await this._update(runId, taskId, attempt.id, a => {
              if (!a.cancelRequested) a.status = 'needs_input';
              a.lastError = { code: 'missing_result', message: 'Worker is idle without this attempt’s result file. Inspect output and request a valid report.' };
            });
            return this.inspect(runId, taskId, { output: true });
          }
        }
      }
      if (Date.now() >= deadline) return this.inspect(runId, taskId);
      await sleep(Math.min(1000, deadline - Date.now()));
    }
  }

  async _closeWorker(run, attempt) {
    if (attempt.workerClosed || !attempt.paneId) return;
    try {
      await this._assertIdentity(run, attempt);
    } catch (error) {
      if (!missing(error)) throw error;
      let pane;
      try { pane = (await this.herdr.getPane(run.herdrSession, attempt.paneId)).result?.pane; }
      catch (paneError) { if (paneError.code === 'pane_not_found') return; throw paneError; }
      invariant(pane?.terminal_id === attempt.terminalId, 'identity_changed', 'Refusing to close a replacement pane.');
      if (attempt.processIdentity) {
        const info = (await this.herdr.getProcessInfo(run.herdrSession, attempt.paneId)).result?.process_info;
        invariant(info?.shell_pid === attempt.processIdentity.shell && [attempt.processIdentity.group, info?.shell_pid].includes(info?.foreground_process_group_id), 'identity_changed', 'Refusing to close an unrecognized process.');
      }
    }
    try { await this.herdr.closePane(run.herdrSession, attempt.paneId); }
    catch (error) { if (error.code !== 'pane_not_found') throw error; }
  }

  async verify(runId, taskId) {
    await this._attempt(runId, taskId);
    return state.withLock(path.join(state.runPath(this.root, runId), `verify-${taskId}.lock`), async () => {
      const { run, task, attempt } = await this._attempt(runId, taskId);
      invariant(['submitted', 'accepted'].includes(attempt.status), 'not_submitted', 'Collect a valid submitted result before verification.');
      invariant(!attempt.outsideScope?.length, 'scope_violation', 'Worker changed files outside its allowed paths.');
      invariant((await git.snapshot(attempt.cwd)).hash === attempt.snapshot.hash, 'candidate_changed', 'Candidate changed since collection; recollect or retry.');
      if (attempt.status === 'accepted') return this.inspect(runId, taskId);
      await this._closeWorker(run, attempt);
      await this._update(runId, taskId, attempt.id, a => { a.workerClosed = true; });
      await this._releaseRuntime(runId, taskId, attempt.id);
      await this._update(runId, taskId, attempt.id, a => { invariant(!a.cancelRequested, 'cancel_requested', 'Verification was cancelled.'); a.status = 'verifying'; a.operation = { kind: 'verification', pid: process.pid, host: os.hostname(), finishedAt: null }; });
      const checks = [];
      let validationError;
      try {
        invariant((await git.snapshot(attempt.cwd)).hash === attempt.snapshot.hash, 'candidate_changed', 'Candidate changed while stopping its worker.');
        for (let i = 0; i < task.definition.checks.length; i++) {
          const check = task.definition.checks[i];
          let outcome;
          const startedAt = time();
          try { outcome = await this._checkCommand(runId, taskId, check, attempt.cwd); }
          catch (error) { outcome = { code: null, stdout: '', stderr: error.message, error: serializeError(error) }; }
          const evidence = path.join(attempt.directory, `check-${i + 1}.json`);
          await state.writeJsonAtomic(evidence, { ...check, ...outcome, startedAt, finishedAt: time() });
          checks.push({ name: check.name, argv: check.argv, status: outcome.code === 0 ? 'passed' : 'failed', code: outcome.code, evidence, error: outcome.error || null });
          await this._cancelCheck(runId, taskId);
        }
        invariant((await git.snapshot(attempt.cwd)).hash === attempt.snapshot.hash, 'verification_mutated_tree', 'Verification changed source files or the candidate changed concurrently.');
        if (checks.every(c => c.status === 'passed') && task.definition.isolation === 'worktree') await git.makePatch(attempt.cwd, path.join(attempt.directory, 'candidate.patch'), attempt.baselineTree || 'HEAD');
      } catch (error) { validationError = serializeError(error); }
      const passed = !validationError && checks.length === task.definition.checks.length && checks.every(c => c.status === 'passed');
      const verification = { attemptId: attempt.id, snapshotHash: attempt.snapshot.hash, passed, checks, error: validationError || null, finishedAt: time() };
      if (passed && task.definition.isolation === 'worktree') verification.patchHash = await hashFile(path.join(attempt.directory, 'candidate.patch'));
      await state.writeJsonAtomic(path.join(attempt.directory, 'verification.json'), verification);
      await this._update(runId, taskId, attempt.id, a => {
        a.verification = verification; a.status = a.cancelRequested ? 'cancelled' : (passed ? 'accepted' : 'rework');
        a.operation.finishedAt = time();
        if (passed && task.definition.isolation === 'worktree') a.patchFile = path.join(attempt.directory, 'candidate.patch');
      });
      return this.inspect(runId, taskId);
    });
  }

  async _checkCommand(runId, taskId, check, cwd) {
    await this._cancelCheck(runId, taskId);
    const controller = new AbortController();
    let reading = false;
    const timer = setInterval(async () => {
      if (reading) return;
      reading = true;
      try { const { attempt } = await this._attempt(runId, taskId); if (attempt.cancelRequested) controller.abort(); }
      catch { controller.abort(); }
      finally { reading = false; }
    }, 100);
    try { return await this.command(check.argv, { cwd, timeoutMs: check.timeoutMs, signal: controller.signal }); }
    finally { clearInterval(timer); }
  }

  async retry(runId, taskId, feedback = '') {
    const { run, task, attempt } = await this._attempt(runId, taskId);
    invariant(['rework', 'failed', 'interrupted', 'cancelled'].includes(attempt.status), 'attempt_active', 'Verify or cancel before retrying.');
    if (attempt.paneId && !attempt.workerClosed) {
      await this._closeWorker(run, attempt);
      await this._update(runId, taskId, attempt.id, a => { a.workerClosed = true; });
    }
    await this._releaseRuntime(runId, taskId, attempt.id);
    const evidence = [];
    for (const check of attempt.verification?.checks || []) {
      if (check.status === 'passed') continue;
      const record = await state.readJson(check.evidence);
      evidence.push({ name: check.name, code: record.code, stdout: record.stdout?.slice(-12000), stderr: record.stderr?.slice(-12000), error: record.error });
    }
    const detail = [feedback, attempt.report ? JSON.stringify(attempt.report) : '', attempt.verification ? JSON.stringify(attempt.verification) : '', evidence.length ? `Independent failure output:\n${JSON.stringify(evidence)}` : '', attempt.lastError ? JSON.stringify(attempt.lastError) : ''].filter(Boolean).join('\n');
    const reserved = await this._reserve(runId, task.definition, detail, true);
    await this._launch(reserved);
    return this.inspect(runId, taskId);
  }

  async cancel(runId, taskId) {
    const { run, attempt } = await this._attempt(runId, taskId);
    if (['integration_failed', 'integration_cancelled'].includes(attempt.status)) return this.inspect(runId, taskId);
    if (['cancelled', 'accepted', 'integrated'].includes(attempt.status)) {
      if (attempt.workerClosed) await this._releaseRuntime(runId, taskId, attempt.id);
      return this.inspect(runId, taskId);
    }
    await this._update(runId, taskId, attempt.id, a => { a.cancelRequested = true; a.status = 'cancelling'; });
    if (['verifying', 'integrating'].includes(attempt.status)) return this.inspect(runId, taskId);
    try {
      await this._closeWorker(run, attempt);
      // An in-flight launch rechecks cancellation after each resource creation.
      if (attempt.paneId || attempt.launchFinishedAt || (attempt.launcherHost === os.hostname() && !alive(attempt.launcherPid))) {
        const unchanged = !attempt.cwd || (attempt.baseline && (await git.snapshot(attempt.cwd)).hash === attempt.baseline.hash);
        await this._update(runId, taskId, attempt.id, a => { a.workerClosed = true; a.status = 'cancelled'; a.checkoutReleased = Boolean(unchanged); });
        await this._releaseRuntime(runId, taskId, attempt.id);
      }
    } catch (error) { await this._update(runId, taskId, attempt.id, a => { a.lastError = serializeError(error); }); }
    return this.inspect(runId, taskId);
  }

  async integrate(runId, taskId) {
    const { run } = await this._attempt(runId, taskId);
    const key = crypto.createHash('sha256').update(run.project).digest('hex');
    return state.withLock(path.join(this.root, 'locks', `project-${key}`), async () => {
      const { task, attempt } = await this._attempt(runId, taskId);
      invariant(attempt.status === 'accepted' && attempt.workerClosed, 'not_accepted', 'Only a verified, stopped attempt can be integrated.');
      invariant(task.definition.isolation === 'worktree' && attempt.patchFile, 'not_worktree', 'Checkout tasks already modify the project directly.');
      invariant((await git.snapshot(attempt.cwd)).hash === attempt.verification.snapshotHash, 'candidate_changed', 'The accepted candidate was modified.');
      invariant(await hashFile(attempt.patchFile) === attempt.verification.patchHash, 'patch_changed', 'The verified patch was modified.');
      const target = await git.snapshot(run.project);
      for (const file of attempt.changedPaths) {
        invariant(JSON.stringify(target.files[file]) === JSON.stringify(attempt.baseline.files[file]), 'integration_conflict', `Project file changed since the candidate baseline: ${file}`);
      }
      for (const other of await state.listRuns(this.root)) {
        if (other.project !== run.project) continue;
        invariant(!Object.values(other.tasks || {}).some(t => integrationHold(current(t))), 'integration_recovery_required', 'Recover the incomplete integration before applying another patch.');
        invariant(!Object.values(other.tasks || {}).some(checkoutHold), 'checkout_busy', 'A checkout task still owns unverified project changes.');
      }
      await this._update(runId, taskId, attempt.id, a => { a.status = 'integrating'; a.integrationStartedAt = time(); a.integrationBaseline = target; a.operation = { kind: 'integration', pid: process.pid, host: os.hostname(), finishedAt: null }; });
      try { await git.applyPatch(run.project, attempt.patchFile); }
      catch (error) {
        await this._update(runId, taskId, attempt.id, a => { a.status = 'integration_failed'; a.lastError = serializeError(error); a.operation.finishedAt = time(); });
        return this.inspect(runId, taskId);
      }
      return this._verifyIntegration(run, task, attempt);
    });
  }

  async _verifyIntegration(run, task, attempt) {
    const before = await git.snapshot(run.project);
    const checks = [];
    for (const check of task.definition.checks) {
      try {
        const result = await this._checkCommand(run.id, task.definition.id, check, run.project);
        checks.push({ name: check.name, status: result.code === 0 ? 'passed' : 'failed', ...result });
      } catch (error) { checks.push({ name: check.name, status: 'failed', error: serializeError(error) }); }
    }
    const stable = (await git.snapshot(run.project)).hash === before.hash;
    const passed = stable && checks.every(c => c.status === 'passed');
    const evidence = path.join(attempt.directory, `integration-${crypto.randomBytes(6).toString('hex')}.json`);
    await state.writeJsonAtomic(evidence, { passed, stable, checks, snapshotHash: before.hash });
    await this._update(run.id, task.definition.id, attempt.id, a => {
      a.integration = { passed, stable, snapshotHash: before.hash, evidence };
      a.status = a.cancelRequested ? 'integration_cancelled' : (passed ? 'integrated' : 'integration_failed');
      a.operation.finishedAt = time();
    });
    return this.inspect(run.id, task.definition.id);
  }

  async recover(runId, taskId) {
    const { run } = await this._attempt(runId, taskId);
    const key = crypto.createHash('sha256').update(run.project).digest('hex');
    return state.withLock(path.join(this.root, 'locks', `project-${key}`), async () => {
      const { task, attempt } = await this._attempt(runId, taskId);
      if (task.definition.isolation === 'checkout') {
        invariant(['rework', 'failed', 'interrupted', 'cancelled'].includes(attempt.status) && attempt.workerClosed, 'not_recoverable', 'Stop the failed checkout worker before rechecking the project.');
        invariant(attempt.baseline?.files, 'recovery_evidence_missing', 'Checkout baseline is missing.');
        const candidate = await git.snapshot(run.project);
        const changed = git.changedPaths(attempt.baseline, candidate);
        invariant(!outsideScope(changed, task.definition.allowedPaths).length, 'scope_violation', 'Checkout contains changes outside the task scope.');
        await this._update(runId, taskId, attempt.id, a => { a.snapshot = candidate; a.changedPaths = changed; a.outsideScope = []; a.cancelRequested = false; a.status = 'submitted'; });
        return this.verify(runId, taskId);
      }
      invariant(integrationHold(attempt), 'not_recoverable', 'recover rechecks incomplete integrations only. It never replays a worker or applies a patch.');
      invariant(attempt.operation?.finishedAt || (attempt.operation?.host === os.hostname() && !alive(attempt.operation.pid)), 'operation_alive', 'The original integration controller may still be running.');
      invariant(attempt.integrationBaseline?.files, 'recovery_evidence_missing', 'Integration baseline is missing. Inspect the retained checkout manually.');
      const now = await git.snapshot(run.project);
      invariant(!outsideScope(git.changedPaths(attempt.integrationBaseline, now), task.definition.allowedPaths).length, 'scope_violation', 'Current checkout changed outside this integration’s scope. Review and resolve those edits before recovery.');
      await this._update(runId, taskId, attempt.id, a => {
        a.cancelRequested = false; a.status = 'integrating';
        a.operation = { kind: 'integration', pid: process.pid, host: os.hostname(), finishedAt: null };
      });
      return this._verifyIntegration(run, task, attempt);
    });
  }

  async cleanup(runId) {
    const run = await this._change(runId, r => {
      invariant(!Object.values(r.tasks).some(t => active.has(current(t).status)), 'run_active', 'Cancel or finish active attempts before cleanup.');
      r.closedAt ||= time();
      return structuredClone(r);
    });
    for (const task of Object.values(run.tasks)) {
      const attempt = current(task);
      if (attempt.workerClosed) await this._releaseRuntime(runId, task.definition.id, attempt.id);
    }
    await this.herdr.stopServer(run.herdrSession);
    await this._change(runId, r => { r.serverStoppedAt = time(); });
    return { runId, serverStopped: true, retained: 'Worktrees, task records and evidence are retained. No project files were removed.' };
  }
}
