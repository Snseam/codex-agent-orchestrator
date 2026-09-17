import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Orchestrator } from '../src/orchestrator.mjs';
import { AdaptiveDispatcher } from '../src/adaptive-dispatch.mjs';
import { Supervisor } from '../src/supervisor/index.mjs';
import { ProfileStore } from '../src/profiles.mjs';
import { listReservations } from '../src/routing.mjs';
import { sanitizeHookInput } from '../src/monitor/claude-hook.mjs';
import { fixture, task, FakeHerdr, writeResult } from './helpers.mjs';

function nativeResource(extra = {}) {
  return { id: 'native-pi-kimi', kind: 'native', agent: 'pi', profileId: null, providerId: 'kimi', requestedModel: 'k3',
    endpoint: 'http://127.0.0.1:9876', fingerprint: 'fingerprint-a', installed: true, configured: true,
    authentication: { state: 'observed' }, quotaGroup: { id: 'endpoint:http://127.0.0.1:9876' },
    quota: { state: 'unknown' }, capabilities: { values: [], unverified: true },
    callVerification: { state: 'verified', qualityStatus: 'passed', observedAt: Date.now() - 1000, expiresAt: Date.now() + 60000 }, ...extra };
}
async function setup(t, list = [nativeResource()]) {
  const f = await fixture(); t.after(f.remove);
  const runtime = new FakeHerdr();
  const resources = { discover: async () => ({ resources: list }), get: async id => list.find(r => r.id === id) };
  const service = new Orchestrator({ stateRoot: f.stateRoot, herdr: runtime, coordinatorId: 'owner', resourceResolver: resources.get });
  const run = await service.init({ project: f.project });
  const dispatcher = new AdaptiveDispatcher({ orchestrator: service, resources });
  const input = task({ agent: 'auto', brief: { risk: 'low', taskKind: 'bugfix', independent: true } });
  return { ...f, runtime, resources, service, run, dispatcher, input };
}

test('active native choice pins model/provider, bypasses default profile and completes independent integration', async t => {
  const f = await setup(t);
  await f.service.profiles.put({ id: 'unrelated', agent: 'claude', model: 'other', protocol: 'anthropic', endpoint: 'http://127.0.0.1:1', credential: { type: 'none' } }, { makeDefault: true });
  const launched = await f.dispatcher.dispatch(f.run.id, f.input, { fixedExecutorKind: 'external' });
  assert.equal(launched.task.agent, 'pi'); assert.deepEqual(launched.task.execution, { native: true });
  assert.deepEqual(launched.task.agentArgs, ['--provider', 'kimi', '--model', 'k3']);
  assert.equal(launched.attempt.execution, undefined);
  assert.equal(launched.attempt.routeDecision.mode, 'adaptive');
  assert.equal((await listReservations(f.stateRoot)).length, 1);
  const result = await new Supervisor({ orchestrator: f.service }).supervise(f.run.id, { integrate: true, waitMs: 10000 });
  assert.equal(result.reason, 'complete');
  assert.equal((await f.service.inspect(f.run.id, f.input.id)).attempt.status, 'integrated');
  assert.deepEqual(await listReservations(f.stateRoot), []);
});

test('duplicate active requests do not create another worker even after readiness expires', async t => {
  const f = await setup(t);
  const results = await Promise.all([f.dispatcher.dispatch(f.run.id, f.input), f.dispatcher.dispatch(f.run.id, f.input)]);
  assert.equal(f.runtime.starts, 1); assert.equal(results.filter(r => r.duplicate).length, 1);
  f.resources.discover = async () => { throw new Error('duplicate must reuse existing attempt'); };
  assert.equal((await f.dispatcher.dispatch(f.run.id, f.input)).duplicate, true);
  await assert.rejects(f.dispatcher.dispatch(f.run.id, { ...f.input, maxAttempts: 20 }), e => e.code === 'task_conflict');
});

test('adaptive host choice registers checkout and retains independent acceptance', async t => {
  const f = await setup(t, []);
  const input = { ...f.input, brief: { risk: 'high', contextDependency: 'high' } }; delete input.agent;
  const start = await f.dispatcher.dispatch(f.run.id, input);
  assert.equal(start.attempt.executorKind, 'host'); assert.equal(f.runtime.starts, 0);
  await fs.writeFile(path.join(f.project, 'src/math.mjs'), 'export const add=(a,b)=>a+b;');
  await f.service.hostReport(f.run.id, input.id, { taskId: input.id, attemptId: start.attempt.id, nonce: start.attempt.nonce, status: 'submitted', summary: 'fixed', changedFiles: ['src/math.mjs'], checks: [], children: [], unresolved: [], hostStopped: true });
  assert.equal((await f.service.hostVerify(f.run.id, input.id)).attempt.status, 'accepted');
});

test('configuration drift refuses launch instead of claiming the old resource was used', async t => {
  const f = await setup(t);
  let reads = 0;
  const actual = f.resources.get;
  f.resources.get = async id => ({ ...await actual(id), fingerprint: ++reads > 1 ? 'changed' : 'fingerprint-a' });
  f.service.resourceResolver = f.resources.get;
  const result = await f.dispatcher.dispatch(f.run.id, f.input);
  assert.equal(result.attempt.status, 'failed');
  assert.equal(result.attempt.lastError.code, 'resource_configuration_changed');
  assert.equal(f.runtime.starts, 0);
});

test('fixed unavailable resource never falls back to host or other resources', async t => {
  const f = await setup(t);
  await assert.rejects(f.dispatcher.dispatch(f.run.id, f.input, { allowedResourceIds: ['missing'], fixedExecutorKind: 'external' }), e => e.code === 'adaptive_route_unavailable');
  assert.equal((await f.service.status(f.run.id)).tasks.length, 0);
});

function nativeClaude(extra = {}) {
  return nativeResource({
    id: 'native-claude', agent: 'claude', providerId: null, requestedModel: null,
    fingerprint: 'fingerprint-claude', quotaGroup: { id: 'native:claude' }, ...extra,
  });
}

function hookEvent(name, { agentId, sessionId, runId, taskId, attemptId, observedAt = '2026-09-17T00:00:00.000Z' }) {
  return sanitizeHookInput({
    hook_event_name: name,
    session_id: sessionId,
    ...(agentId ? { agent_id: agentId, agent_type: 'Explore' } : {}),
  }, { runId, taskId, attemptId, nativeSessionId: sessionId }, observedAt);
}

async function writeHookEvents(file, events) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, events.map(item => JSON.stringify(item)).join('\n') + '\n', { mode: 0o600 });
}

class ManagedHerdr extends FakeHerdr {
  async prepareEnvironment() { return { result: { type: 'ok' } }; }
}

class FakeGateway {
  constructor(root) {
    this.root = root;
    this.starts = [];
    this.stops = [];
  }
  async start(request) {
    this.starts.push(structuredClone(request));
    const tokenFile = path.join(this.root, 'fake-gateway-tokens', `${request.id}.token`);
    await fs.mkdir(path.dirname(tokenFile), { recursive: true });
    await fs.writeFile(tokenFile, `token-${request.id}\n`, { mode: 0o600 });
    return {
      id: request.id, pid: 12345, endpoint: `http://127.0.0.1/${request.id}`,
      protocol: request.snapshots[0].protocol, tokenFile,
      profileIds: request.snapshots.map(snapshot => snapshot.id),
      ownerNonce: `owner-${request.id}`, startedAt: new Date().toISOString(),
    };
  }
  async stop(id) {
    this.stops.push(id);
    return { id, running: false, stoppedAt: new Date().toISOString() };
  }
}

function profile(id, overrides = {}) {
  return {
    id, name: id, agent: 'claude', model: `${id}-model`, protocol: 'anthropic',
    endpoint: `http://127.0.0.1/${id}`, credential: { type: 'none' }, source: { type: 'native' },
    enabled: true, capabilities: ['coding'], priority: 0, account: { id: `acct-${id}`, maxParallel: 1 },
    quota: { state: 'unknown', observedAt: null, expiresAt: null, remainingTokens: null },
    quality: 50, speed: 50, costPerMillion: 1, modelMap: {}, fallbacks: [], ...overrides,
  };
}

function managedResource(id, extra = {}) {
  return {
    id: `profile-${id}`, kind: 'profile', agent: 'claude', profileId: id, providerId: null,
    requestedModel: `${id}-model`, fingerprint: `fp-${id}`, installed: true, configured: true,
    authentication: { state: 'observed' }, quotaGroup: { id: `account:${id}` },
    quota: { state: 'available', remainingTokens: 10, observedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000 },
    capabilities: { values: [], unverified: true },
    callVerification: { state: 'verified', qualityStatus: 'passed', observedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000 },
    ...extra,
  };
}

test('adaptive unknown Claude telemetry blocks collect and verify', async t => {
  const f = await setup(t, [nativeClaude()]);
  const input = { ...f.input, maxChildren: 1 };
  const launched = await f.dispatcher.dispatch(f.run.id, input, { fixedExecutorKind: 'external' });
  assert.equal(launched.attempt.routeDecision.mode, 'adaptive');
  assert.equal(launched.attempt.telemetry.enabled, true);
  const collected = await f.service.collect(f.run.id, input.id);
  assert.equal(collected.attempt.status, 'needs_input');
  assert.equal(collected.attempt.lastError.code, 'children_unfinished');
  assert.equal(collected.attempt.nativeChildren.state, 'unknown');
  assert.equal(collected.attempt.nativeChildren.complete, false);
  await assert.rejects(f.service.verify(f.run.id, input.id), e => e.code === 'native_children_unverified');
});

test('observed running Claude child blocks adaptive collect', async t => {
  const f = await setup(t, [nativeClaude()]);
  const input = { ...f.input, maxChildren: 1 };
  const launched = await f.dispatcher.dispatch(f.run.id, input, { fixedExecutorKind: 'external' });
  await writeHookEvents(launched.attempt.telemetry.eventsFile, [
    hookEvent('SubagentStart', {
      agentId: 'child-one',
      sessionId: launched.attempt.telemetry.nativeSessionId,
      runId: f.run.id, taskId: input.id, attemptId: launched.attempt.id,
    }),
  ]);
  const collected = await f.service.collect(f.run.id, input.id);
  assert.equal(collected.attempt.status, 'needs_input');
  assert.equal(collected.attempt.nativeChildren.state, 'blocked');
  assert.equal(collected.attempt.lastError.code, 'children_unfinished');
  await assert.rejects(f.service.verify(f.run.id, input.id), e => e.code === 'native_children_unverified');
});

test('legacy unknown telemetry remaps to the report contract and can submit', async t => {
  const f = await fixture(); t.after(f.remove);
  const runtime = new FakeHerdr();
  const service = new Orchestrator({ stateRoot: f.stateRoot, herdr: runtime, coordinatorId: 'owner' });
  const run = await service.init({ project: f.project });
  const input = task({ maxChildren: 1 });
  const launched = await service.dispatch(run.id, input);
  assert.equal(launched.attempt.routeDecision, undefined);
  await fs.writeFile(launched.attempt.telemetry.eventsFile, 'x'.repeat(1024 * 1024 + 1), { mode: 0o600 });
  const collected = await service.collect(run.id, input.id);
  assert.equal(collected.attempt.status, 'submitted');
  assert.equal(collected.attempt.nativeChildren.state, 'reported');
  assert.equal(collected.attempt.nativeChildren.source, 'legacy-report-contract');
  assert.equal(collected.attempt.nativeChildren.complete, true);
  assert.equal((await service.verify(run.id, input.id)).attempt.status, 'accepted');
});

test('cancel retains capacity when native children are unfinished', async t => {
  const f = await setup(t, [nativeClaude()]);
  const input = { ...f.input, maxChildren: 1 };
  const launched = await f.dispatcher.dispatch(f.run.id, input, { fixedExecutorKind: 'external' });
  await writeHookEvents(launched.attempt.telemetry.eventsFile, [
    hookEvent('SubagentStart', {
      agentId: 'child-one',
      sessionId: launched.attempt.telemetry.nativeSessionId,
      runId: f.run.id, taskId: input.id, attemptId: launched.attempt.id,
    }),
  ]);
  const cancelled = await f.service.cancel(f.run.id, input.id);
  assert.equal(cancelled.attempt.status, 'cancelled');
  assert.equal(cancelled.attempt.lastError.code, 'native_children_unverified');
  assert.equal(cancelled.attempt.runtimeReleasedAt, undefined);
  assert.equal((await listReservations(f.stateRoot)).length, 1);
});

test('retry keeps the bound adaptive resource instead of re-selecting', async t => {
  const f = await fixture(); t.after(f.remove);
  const runtime = new FakeHerdr(prompt => writeResult(prompt, { fix: false }));
  const list = [nativeResource(), nativeResource({ id: 'native-pi-other', fingerprint: 'fingerprint-b', requestedModel: 'other' })];
  const resources = { discover: async () => ({ resources: list }), get: async id => list.find(r => r.id === id) };
  const service = new Orchestrator({ stateRoot: f.stateRoot, herdr: runtime, coordinatorId: 'owner', resourceResolver: resources.get });
  const run = await service.init({ project: f.project });
  const dispatcher = new AdaptiveDispatcher({ orchestrator: service, resources });
  const input = task({ agent: 'auto', brief: { risk: 'low', taskKind: 'bugfix', independent: true } });
  const first = await dispatcher.dispatch(run.id, input, { fixedExecutorKind: 'external' });
  await service.collect(run.id, input.id);
  assert.equal((await service.verify(run.id, input.id)).attempt.status, 'rework');
  const retried = await service.retry(run.id, input.id, 'Keep the same route.');
  assert.notEqual(retried.attempt.id, first.attempt.id);
  assert.equal(retried.attempt.routeDecision.resource.id, first.attempt.routeDecision.resource.id);
  assert.equal(retried.attempt.routeDecision.resource.fingerprint, first.attempt.routeDecision.resource.fingerprint);
  assert.deepEqual(retried.task.agentArgs, first.task.agentArgs);
  assert.deepEqual(retried.task.execution, { native: true });
});

test('managed adaptive dispatch pins fallbacks and does not use them after the primary is disabled', async t => {
  const f = await fixture(); t.after(f.remove);
  const store = new ProfileStore({ root: f.stateRoot });
  const primary = profile('primary', { fallbacks: ['backup'] });
  const backup = profile('backup');
  await store.put(primary);
  await store.put(backup);
  const runtime = new ManagedHerdr(prompt => writeResult(prompt, { fix: false }));
  const gateways = new FakeGateway(f.stateRoot);
  const list = [managedResource('primary')];
  const resources = { discover: async () => ({ resources: list }), get: async id => list.find(r => r.id === id) };
  const service = new Orchestrator({
    stateRoot: f.stateRoot, herdr: runtime, coordinatorId: 'owner',
    profiles: store, gateways, resourceResolver: resources.get,
  });
  const run = await service.init({ project: f.project });
  const dispatcher = new AdaptiveDispatcher({ orchestrator: service, resources });
  const input = task({ agent: 'auto', brief: { risk: 'low', taskKind: 'bugfix', independent: true } });
  const launched = await dispatcher.dispatch(run.id, input, { fixedExecutorKind: 'external' });
  assert.equal(launched.attempt.routeDecision.mode, 'adaptive');
  assert.equal(launched.attempt.execution.profileId, 'primary');
  assert.deepEqual(launched.attempt.execution.excludedFallbacks, [{ profileId: 'backup', reason: 'adaptive_attempt_pinned' }]);
  assert.deepEqual(launched.attempt.execution.snapshots.map(snapshot => snapshot.id), ['primary']);
  assert.equal(launched.attempt.execution.reservations.length, 1);
  await service.collect(run.id, input.id);
  assert.equal((await service.verify(run.id, input.id)).attempt.status, 'rework');
  await store.put({ ...primary, enabled: false });
  const retried = await service.retry(run.id, input.id, 'Primary must stay pinned.');
  assert.notEqual(retried.attempt.execution?.profileId, 'backup');
  assert.equal(retried.attempt.status, 'failed');
  assert.ok(retried.attempt.lastError);
  assert.notEqual(retried.attempt.lastError.code, undefined);
});
