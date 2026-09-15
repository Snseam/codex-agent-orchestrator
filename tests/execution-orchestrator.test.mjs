import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Orchestrator } from '../src/orchestrator.mjs';
import { ProfileStore } from '../src/profiles.mjs';
import { OrchestratorError } from '../src/errors.mjs';
import { listReservations } from '../src/routing.mjs';
import { fixture, FakeHerdr, task, writeResult } from './helpers.mjs';

function profile(id, agent, overrides = {}) {
  const protocol = { claude: 'anthropic', codex: 'openai-responses', pi: 'openai-chat', opencode: 'openai-chat' }[agent];
  return {
    id,
    name: id,
    agent,
    model: `${id}-model`,
    protocol,
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

class RecordingHerdr extends FakeHerdr {
  constructor(events, onPrompt = prompt => writeResult(prompt)) {
    super(onPrompt);
    this.events = events;
    this.startCalls = [];
    this.prepared = [];
  }
  async prepareEnvironment(session, paneId, manifest) {
    this.events.push(`herdr:prepare:${manifest.profileId}`);
    this.prepared.push({ session, paneId, manifest });
    return { result: { type: 'ok' } };
  }
  async startAgent(session, name, kind, paneId, args = []) {
    this.events.push(`herdr:start:${kind}`);
    this.startCalls.push({ session, name, kind, paneId, args });
    return super.startAgent(session, name, kind, paneId, args);
  }
}

class FakeGateway {
  constructor(root, events) {
    this.root = root;
    this.events = events;
    this.starts = [];
    this.stops = [];
  }
  async start(request) {
    this.events.push(`gateway:start:${request.id}`);
    this.starts.push(structuredClone(request));
    const tokenFile = path.join(this.root, 'fake-gateway-tokens', `${request.id}.token`);
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
    this.events.push(`gateway:stop:${id}`);
    this.stops.push(id);
    return { id, running: false, stoppedAt: new Date().toISOString() };
  }
}

async function setup(t, { profiles = [], defaultProfileId = null, onPrompt } = {}) {
  const f = await fixture();
  t.after(f.remove);
  const store = new ProfileStore({ root: f.stateRoot });
  for (const item of profiles) await store.put(item, { makeDefault: item.id === defaultProfileId });
  const events = [];
  const herdr = new RecordingHerdr(events, onPrompt);
  const gateways = new FakeGateway(f.stateRoot, events);
  const service = new Orchestrator({ stateRoot: f.stateRoot, herdr, profiles: store, gateways });
  const run = await service.init({ project: f.project });
  return { ...f, service, run, store, herdr, gateways, events };
}

test('legacy dispatch remains profile-free when no default profile is configured', async t => {
  const { service, run, herdr, gateways } = await setup(t);
  const result = await service.dispatch(run.id, task());
  assert.equal(result.attempt.execution, undefined);
  assert.equal(herdr.startCalls.length, 1);
  assert.equal(herdr.startCalls[0].kind, 'claude');
  assert.equal(gateways.starts.length, 0);
});

test('explicit profile records actual agent, immutable snapshot, duplicate launch idempotency, and startup order', async t => {
  const selected = profile('codex-primary', 'codex', { model: 'codex-before', quality: 90 });
  const { service, run, store, herdr, gateways, events } = await setup(t, { profiles: [selected] });
  const input = task({ id: 'profiled', agent: 'auto', execution: { profile: selected.id } });

  const first = await service.dispatch(run.id, input);
  const duplicate = await service.dispatch(run.id, input);
  await store.put({ ...selected, model: 'codex-after' });
  const inspected = await service.inspect(run.id, input.id);

  assert.equal(duplicate.duplicate, true);
  assert.equal(herdr.startCalls.length, 1);
  assert.equal(gateways.starts.length, 1);
  assert.equal(first.attempt.execution.agent, 'codex');
  assert.equal(first.attempt.execution.profileId, selected.id);
  assert.equal(inspected.attempt.execution.profile.model, 'codex-before');
  assert.equal(herdr.startCalls[0].kind, 'codex');
  assert.ok(events.findIndex(event => event.startsWith('gateway:start:')) < events.findIndex(event => event.startsWith('herdr:prepare:')));
  assert.ok(events.findIndex(event => event.startsWith('herdr:prepare:')) < events.findIndex(event => event.startsWith('herdr:start:')));
});

test('auto retry can select a different agent on a new attempt', async t => {
  let prompts = 0;
  const codex = profile('codex-fast', 'codex', { quality: 100 });
  const claude = profile('claude-safe', 'claude', { quality: 50 });
  const { service, run, store, herdr } = await setup(t, {
    profiles: [codex, claude],
    onPrompt: prompt => writeResult(prompt, { fix: ++prompts > 1 }),
  });
  const input = task({ id: 'auto-retry', agent: 'auto', execution: { policy: 'quality', profiles: [codex.id, claude.id] } });

  const first = await service.dispatch(run.id, input);
  await service.collect(run.id, input.id);
  assert.equal((await service.verify(run.id, input.id)).attempt.status, 'rework');
  await store.put({ ...codex, enabled: false });
  const retried = await service.retry(run.id, input.id, 'Try another route.');

  assert.notEqual(retried.attempt.id, first.attempt.id);
  assert.equal(first.attempt.execution.agent, 'codex');
  assert.equal(retried.attempt.execution.agent, 'claude');
  assert.deepEqual(herdr.startCalls.map(call => call.kind), ['codex', 'claude']);
});

test('default profile is applied to legacy tasks without changing the task definition', async t => {
  const selected = profile('claude-default', 'claude', { model: 'default-model' });
  const { service, run, herdr } = await setup(t, { profiles: [selected], defaultProfileId: selected.id });
  const result = await service.dispatch(run.id, task({ id: 'defaulted' }));
  assert.equal(result.task.agent, 'claude');
  assert.equal(result.attempt.execution.profileId, selected.id);
  assert.equal(result.attempt.execution.profile.model, 'default-model');
  assert.equal(result.attempt.execution.selectorSource, 'default-profile');
  assert.deepEqual(result.attempt.execution.selector, { profile: selected.id });
  assert.equal(herdr.startCalls[0].kind, 'claude');
});

test('auto without an explicit selector uses an audited default profile or fails before launch', async t => {
  const selected = profile('codex-default', 'codex');
  const configured = await setup(t, { profiles: [selected], defaultProfileId: selected.id });
  const routed = await configured.service.dispatch(configured.run.id, task({ agent: 'auto' }));
  assert.equal(routed.attempt.execution.agent, 'codex');
  assert.equal(routed.attempt.execution.selectorSource, 'default-profile');
  const unconfigured = await setup(t);
  const unavailable = await unconfigured.service.dispatch(unconfigured.run.id, task({ agent: 'auto' }));
  assert.equal(unavailable.attempt.lastError.code, 'execution_required');
  assert.equal(unconfigured.herdr.startCalls.length, 0);
});

test('verify, cancel, and startup failure release gateway handles and execution buckets', async t => {
  const selected = profile('claude-release', 'claude');
  const verified = await setup(t, { profiles: [selected] });
  const verifyInput = task({ id: 'verify-release', agent: 'auto', execution: { profile: selected.id } });
  await verified.service.dispatch(verified.run.id, verifyInput);
  await verified.service.collect(verified.run.id, verifyInput.id);
  const accepted = await verified.service.verify(verified.run.id, verifyInput.id);
  assert.equal(accepted.attempt.status, 'accepted');
  assert.ok(accepted.attempt.runtimeReleasedAt);
  assert.equal(verified.gateways.stops.length, 1);
  assert.deepEqual(await listReservations(verified.stateRoot), []);

  const cancelled = await setup(t, { profiles: [profile('claude-cancel', 'claude')] });
  const cancelInput = task({ id: 'cancel-release', agent: 'auto', execution: { profile: 'claude-cancel' } });
  await cancelled.service.dispatch(cancelled.run.id, cancelInput);
  const stopped = await cancelled.service.cancel(cancelled.run.id, cancelInput.id);
  assert.equal(stopped.attempt.status, 'cancelled');
  assert.ok(stopped.attempt.runtimeReleasedAt);
  assert.equal(cancelled.gateways.stops.length, 1);
  assert.deepEqual(await listReservations(cancelled.stateRoot), []);

  const failed = await fixture();
  t.after(failed.remove);
  const store = new ProfileStore({ root: failed.stateRoot });
  await store.put(profile('claude-fail', 'claude'));
  const events = [];
  const gateways = new FakeGateway(failed.stateRoot, events);
  const service = new Orchestrator({
    stateRoot: failed.stateRoot,
    herdr: new RecordingHerdr(events),
    profiles: store,
    gateways,
    materialize: async () => { throw new OrchestratorError('materialize_failed', 'synthetic failure'); },
  });
  const run = await service.init({ project: failed.project });
  const failedInput = task({ id: 'startup-fail', agent: 'auto', execution: { profile: 'claude-fail' } });
  const failedResult = await service.dispatch(run.id, failedInput);
  assert.equal(failedResult.attempt.status, 'failed');
  assert.equal(failedResult.attempt.workerClosed, true);
  assert.equal(failedResult.attempt.paneId, null);
  assert.ok(failedResult.attempt.runtimeReleasedAt);
  assert.equal(gateways.stops.length, 1);
  assert.deepEqual(await listReservations(failed.stateRoot), []);
});

test('fallbacks reserve cross-bucket capacity while same-bucket fallbacks reuse the primary lease', async t => {
  const primary = profile('primary', 'claude', { account: { id: 'shared', maxParallel: 2 }, fallbacks: ['same-bucket', 'other-bucket'] });
  const same = profile('same-bucket', 'claude', { account: { id: 'shared', maxParallel: 2 } });
  const other = profile('other-bucket', 'claude', { account: { id: 'other', maxParallel: 1 } });
  const { service, run, gateways } = await setup(t, { profiles: [primary, same, other] });
  const input = task({ id: 'fallbacks', agent: 'auto', execution: { profile: primary.id } });
  const result = await service.dispatch(run.id, input);

  const snapshotIds = result.attempt.execution.snapshots.map(snapshot => snapshot.id);
  assert.equal(snapshotIds[0], 'primary');
  assert.deepEqual(new Set(snapshotIds), new Set(['primary', 'same-bucket', 'other-bucket']));
  assert.equal(result.attempt.execution.reservations.length, 2);
  assert.deepEqual(gateways.starts[0].snapshots.map(snapshot => snapshot.id), snapshotIds);
});

test('execution capacity rejection records a failed attempt without creating a worker', async t => {
  const selected = profile('single-slot', 'claude', { account: { id: 'one-slot', maxParallel: 1 } });
  const { service, run, herdr, gateways } = await setup(t, { profiles: [selected] });
  await service.dispatch(run.id, task({ id: 'first', agent: 'auto', execution: { profile: selected.id } }));
  const second = await service.dispatch(run.id, task({ id: 'second', agent: 'auto', execution: { profile: selected.id } }));

  assert.equal(second.attempt.status, 'failed');
  assert.equal(second.attempt.workerClosed, true);
  assert.equal(second.attempt.paneId, null);
  assert.equal(second.attempt.lastError.code, 'route_capacity_exhausted');
  assert.equal(herdr.startCalls.length, 1);
  assert.equal(gateways.starts.length, 1);
  assert.equal((await listReservations(service.root)).length, 1);
});
