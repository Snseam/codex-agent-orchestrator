import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MonitorManager } from '../src/monitor/manager.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { ProfileStore } from '../src/profiles.mjs';
import { listReservations } from '../src/routing.mjs';
import { fixture, FakeHerdr, task, writeResult } from './helpers.mjs';

async function tempRoot(t, prefix = 'cao-monitor-runtime-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const caoBin = path.join(repoRoot, 'bin', 'cao.mjs');

function cli(args, { cwd, env = {}, input = null } = {}) {
  const result = spawnSync(process.execPath, [caoBin, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
  });
  const text = result.status === 0 ? result.stdout : result.stderr;
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ...result, json };
}

function expectCliOk(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.json?.ok, true, result.stderr || result.stdout);
  return result.json.data;
}

function profile(id, overrides = {}) {
  return {
    id,
    name: id,
    agent: 'claude',
    model: `${id}-model`,
    protocol: 'anthropic',
    endpoint: `http://127.0.0.1/${id}`,
    credential: { type: 'none' },
    source: { type: 'native' },
    enabled: true,
    capabilities: ['coding', 'reasoning'],
    priority: 0,
    account: { id: `acct-${id}`, maxParallel: 1 },
    quota: { state: 'unknown', observedAt: null, expiresAt: null, remainingTokens: null },
    quality: 50,
    speed: 50,
    costPerMillion: 1,
    modelMap: {},
    fallbacks: [],
    ...overrides,
  };
}

class RuntimeHerdr extends FakeHerdr {
  constructor(onPrompt = prompt => writeResult(prompt)) {
    super(onPrompt);
    this.startCalls = [];
    this.prepared = [];
    this.failCreate = false;
  }
  async createWorkspace(session, cwd, label) {
    if (this.failCreate) throw new Error('synthetic workspace startup failure');
    return super.createWorkspace(session, cwd, label);
  }
  async prepareEnvironment(session, paneId, manifest) {
    this.prepared.push({ session, paneId, manifest: structuredClone(manifest) });
    return { result: { type: 'ok' } };
  }
  async startAgent(session, name, kind, paneId, args = []) {
    this.startCalls.push({ session, name, kind, paneId, args: [...args] });
    return super.startAgent(session, name, kind, paneId, args);
  }
}

class RuntimeGateway {
  constructor(root) {
    this.root = root;
    this.starts = [];
    this.stops = [];
  }
  async start(request) {
    this.starts.push(structuredClone(request));
    const tokenFile = path.join(this.root, 'gateway-tokens', `${request.id}.token`);
    await fs.mkdir(path.dirname(tokenFile), { recursive: true });
    await fs.writeFile(tokenFile, `token-${request.id}\n`, { mode: 0o600 });
    return {
      id: request.id,
      pid: 12345,
      endpoint: `http://127.0.0.1/${request.id}`,
      protocol: request.snapshots[0].protocol,
      tokenFile,
      profileIds: request.snapshots.map(snapshot => snapshot.id),
      ownerNonce: `owner-${request.id}`,
      startedAt: new Date().toISOString(),
    };
  }
  async stop(id) {
    this.stops.push(id);
    return { id, running: false, stoppedAt: new Date().toISOString() };
  }
}

async function profiledService(t, { herdr = new RuntimeHerdr(), coordinatorId = 'coord-test' } = {}) {
  const f = await fixture();
  t.after(f.remove);
  const profiles = new ProfileStore({ root: f.stateRoot });
  await profiles.put(profile('profile-claude'));
  const gateways = new RuntimeGateway(f.stateRoot);
  const service = new Orchestrator({ stateRoot: f.stateRoot, herdr, profiles, gateways, coordinatorId });
  const run = await service.init({ project: f.project });
  return { ...f, service, run, profiles, gateways, herdr };
}

function settingsArg(args) {
  const split = args.indexOf('--settings');
  if (split >= 0) return args[split + 1];
  return args.find(arg => arg.startsWith('--settings='))?.slice('--settings='.length) || null;
}

async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

test('MonitorManager starts a real local monitor process, reuses identical scope, reports status, and stops it', async t => {
  const stateRoot = await tempRoot(t);
  const codexHome = await tempRoot(t, 'cao-monitor-codex-home-');
  const claudeHome = await tempRoot(t, 'cao-monitor-claude-home-');
  const manager = new MonitorManager({ root: stateRoot });
  t.after(async () => { await manager.stop('runtime').catch(() => null); });

  const first = await manager.start({ id: 'runtime', all: true, codexHome, claudeHome, coordinatorId: 'known-caller', coordinatorExplicit: true });
  assert.equal(first.running, true);
  assert.equal(first.reused, false);
  assert.match(first.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=/);
  assert.ok(!first.url.includes('?token='));

  const second = await manager.start({ id: 'runtime', all: true, codexHome, claudeHome });
  assert.equal(second.running, true);
  assert.equal(second.reused, true);
  assert.equal(second.endpoint, first.endpoint);
  await assert.rejects(manager.start({ id: 'runtime', all: true, codexHome, claudeHome, coordinatorId: 'other-caller', coordinatorExplicit: true }), error => error.code === 'monitor_already_running');

  const status = await manager.status('runtime');
  assert.equal(status.running, true);
  assert.equal(status.all, true);
  assert.equal(status.stateRoot, stateRoot);

  const stopped = await manager.stop('runtime');
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.running, false);
});

test('CLI monitor commands use isolated homes, default project scope, run/all validation, URL fragment tokens, and no implicit browser open', async t => {
  const f = await fixture();
  t.after(f.remove);
  const codexHome = await tempRoot(t, 'cao-cli-codex-home-');
  const claudeHome = await tempRoot(t, 'cao-cli-claude-home-');
  const projectRealpath = await fs.realpath(f.project);
  const common = ['--state-dir', f.stateRoot];
  const env = { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome };

  const init = expectCliOk(cli([...common, 'init', '--project', f.project, '--id', 'cli-run'], { cwd: f.project, env }));
  assert.equal(init.id, 'cli-run');

  const defaultSnapshot = expectCliOk(cli([...common, 'monitor', 'snapshot', '--codex-home', codexHome, '--claude-home', claudeHome], { cwd: f.project, env }));
  assert.equal(defaultSnapshot.scope.mode, 'project');
  assert.equal(defaultSnapshot.scope.project, projectRealpath);

  const runSnapshot = expectCliOk(cli([...common, 'monitor', 'snapshot', '--run', 'cli-run', '--codex-home', codexHome, '--claude-home', claudeHome], { cwd: f.project, env }));
  assert.equal(runSnapshot.scope.mode, 'project');
  assert.equal(runSnapshot.scope.runId, 'cli-run');
  assert.equal(runSnapshot.scope.project, projectRealpath);

  const invalid = cli([...common, 'monitor', 'snapshot', '--all', '--run', 'cli-run'], { cwd: f.project, env });
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.json?.error?.code, 'invalid_arguments');

  const started = expectCliOk(cli([...common, 'monitor', 'start', '--id', 'cli-monitor', '--port', '0', '--codex-home', codexHome, '--claude-home', claudeHome], { cwd: f.project, env }));
  try {
    assert.equal(started.browserOpened, false);
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=/);
    assert.ok(!started.url.includes('?token='));
    const status = expectCliOk(cli([...common, 'monitor', 'status', '--id', 'cli-monitor'], { cwd: f.project, env }));
    assert.equal(status.running, true);
    assert.equal(status.project, projectRealpath);
  } finally {
    const stopped = cli([...common, 'monitor', 'stop', '--id', 'cli-monitor'], { cwd: f.project, env });
    assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  }
});

test('legacy and profiled Claude launches attach telemetry settings without mutating source settings and record coordinator ids', async t => {
  const f = await fixture();
  t.after(f.remove);
  const legacySettings = path.join(f.base, 'legacy-settings.json');
  await fs.writeFile(legacySettings, JSON.stringify({ env: { KEEP: 'yes' } }, null, 2));
  const legacyHerdr = new RuntimeHerdr();
  const legacy = new Orchestrator({ stateRoot: f.stateRoot, herdr: legacyHerdr, coordinatorId: 'coord-legacy' });
  const legacyRun = await legacy.init({ project: f.project, id: 'legacy-run' });
  const legacyInput = task({ id: 'legacy-claude', agent: 'claude', agentArgs: ['--settings', legacySettings] });
  const legacyResult = await legacy.dispatch(legacyRun.id, legacyInput);

  assert.equal(legacyResult.attempt.coordinatorThreadId, 'coord-legacy');
  assert.equal((await legacy.status(legacyRun.id)).coordinatorThreadId, 'coord-legacy');
  assert.equal(legacyResult.attempt.telemetry.enabled, true);
  const legacyRuntimeSettings = settingsArg(legacyHerdr.startCalls[0].args);
  assert.equal(legacyRuntimeSettings, legacyResult.attempt.telemetry.settingsFile);
  assert.notEqual(legacyRuntimeSettings, legacySettings);
  assert.deepEqual(JSON.parse(await fs.readFile(legacySettings, 'utf8')), { env: { KEEP: 'yes' } });

  const profiled = await profiledService(t, { coordinatorId: 'coord-profile' });
  const profiledInput = task({ id: 'profile-claude', agent: 'auto', execution: { profile: 'profile-claude' } });
  const profiledResult = await profiled.service.dispatch(profiled.run.id, profiledInput);
  assert.equal(profiledResult.attempt.coordinatorThreadId, 'coord-profile');
  assert.equal((await profiled.service.status(profiled.run.id)).coordinatorThreadId, 'coord-profile');
  assert.equal(profiledResult.attempt.telemetry.enabled, true);
  assert.equal(settingsArg(profiled.herdr.startCalls[0].args), profiledResult.attempt.telemetry.settingsFile);
  const preparedSettings = profiled.herdr.prepared[0].manifest.args[profiled.herdr.prepared[0].manifest.args.indexOf('--settings') + 1];
  assert.notEqual(preparedSettings, profiledResult.attempt.telemetry.settingsFile);
  const originalProfileSettings = JSON.parse(await fs.readFile(preparedSettings, 'utf8'));
  assert.equal(originalProfileSettings.model, 'profile-claude-model');
  assert.equal(originalProfileSettings.hooks, undefined);
});

test('verify and startup-failure release runtime, remove unchanged owned settings, retain events, and clear reservations', async t => {
  const verified = await profiledService(t);
  const input = task({ id: 'verify-runtime', agent: 'auto', execution: { profile: 'profile-claude' } });
  await verified.service.dispatch(verified.run.id, input);
  const collected = await verified.service.collect(verified.run.id, input.id);
  const telemetry = collected.attempt.telemetry;
  assert.equal(await exists(telemetry.settingsFile), true);
  assert.equal(await exists(telemetry.eventsFile), true);
  const accepted = await verified.service.verify(verified.run.id, input.id);
  assert.equal(accepted.attempt.status, 'accepted');
  assert.ok(accepted.attempt.runtimeReleasedAt);
  assert.equal(await exists(telemetry.settingsFile), false);
  assert.equal(await exists(telemetry.eventsFile), true);
  assert.equal(verified.gateways.stops.length, 1);
  assert.deepEqual(await listReservations(verified.stateRoot), []);

  const failingHerdr = new RuntimeHerdr();
  failingHerdr.failCreate = true;
  const failed = await profiledService(t, { herdr: failingHerdr });
  const failInput = task({ id: 'startup-runtime', agent: 'auto', execution: { profile: 'profile-claude' } });
  const failedResult = await failed.service.dispatch(failed.run.id, failInput);
  assert.equal(failedResult.attempt.status, 'failed');
  assert.equal(failedResult.attempt.workerClosed, true);
  assert.ok(failedResult.attempt.runtimeReleasedAt);
  assert.equal(await exists(failedResult.attempt.telemetry.settingsFile), false);
  assert.equal(await exists(failedResult.attempt.telemetry.eventsFile), true);
  assert.equal(failed.gateways.stops.length, 1);
  assert.deepEqual(await listReservations(failed.stateRoot), []);
});

test('cancel releases runtime and preserves modified owned telemetry files while retaining event logs', async t => {
  const scenario = await profiledService(t);
  const input = task({ id: 'cancel-runtime', agent: 'auto', execution: { profile: 'profile-claude' } });
  const launched = await scenario.service.dispatch(scenario.run.id, input);
  await fs.appendFile(launched.attempt.telemetry.settingsFile, '\nmodified by test');
  const cancelled = await scenario.service.cancel(scenario.run.id, input.id);

  assert.equal(cancelled.attempt.status, 'cancelled');
  assert.ok(cancelled.attempt.runtimeReleasedAt);
  assert.equal(await exists(cancelled.attempt.telemetry.settingsFile), true);
  assert.equal(await exists(cancelled.attempt.telemetry.eventsFile), true);
  assert.ok(cancelled.attempt.telemetryCleanup.retained.includes(cancelled.attempt.telemetry.settingsFile));
  assert.ok(cancelled.attempt.telemetryCleanup.retained.includes(cancelled.attempt.telemetry.eventsFile));
  assert.equal(scenario.gateways.stops.length, 1);
  assert.deepEqual(await listReservations(scenario.stateRoot), []);
});

test('a restarted controller resolves state-root aliases before telemetry validation and cleanup', async t => {
  const f = await fixture();
  t.after(() => f.remove());
  const herdr = new FakeHerdr();
  const original = new Orchestrator({ stateRoot: f.stateRoot, herdr });
  const run = await original.init({ project: f.project });
  const launched = await original.dispatch(run.id, task());
  const alias = path.join(f.base, 'state-alias');
  await fs.symlink(f.stateRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const restarted = new Orchestrator({ stateRoot: alias, herdr });
  const collected = await restarted.collect(run.id, 'fix-add');
  assert.equal(collected.attempt.status, 'submitted');
  const verified = await restarted.verify(run.id, 'fix-add');
  assert.equal(verified.attempt.status, 'accepted');
  assert.ok(verified.attempt.runtimeReleasedAt);
  assert.equal(restarted.root, await fs.realpath(f.stateRoot));
  assert.equal(await exists(launched.attempt.telemetry.settingsFile), false);
  assert.equal(await exists(launched.attempt.telemetry.eventsFile), true);
  await restarted.cleanup(run.id);
});
