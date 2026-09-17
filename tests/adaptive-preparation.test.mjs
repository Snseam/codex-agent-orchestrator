import test from 'node:test';
import assert from 'node:assert/strict';
import { OrchestratorError } from '../src/errors.mjs';
import { planAdaptive } from '../src/adaptive-selection.mjs';
import { prepareAdaptiveResources, preparationCandidates, preparationRequestFields } from '../src/adaptive-preparation.mjs';
import { task } from './helpers.mjs';

function resource(id, extra = {}) {
  return {
    id,
    kind: 'native',
    agent: 'pi',
    providerId: 'kimi',
    profileId: null,
    requestedModel: 'k3',
    fingerprint: `fp-${id}`,
    installed: true,
    configured: true,
    authentication: { state: 'observed' },
    quota: { state: 'unknown', fresh: false },
    quotaGroup: { id: `quota-${id}` },
    capabilities: { values: [], unverified: true },
    probe: { supported: true, reason: 'test probe' },
    callVerification: { state: 'unknown', observedAt: null, expiresAt: null, errorCode: null, qualityStatus: null },
    ...extra,
  };
}

function input(extra = {}) {
  return task({
    agent: 'auto',
    brief: { risk: 'low', taskKind: 'bugfix', independent: true },
    ...extra,
  });
}

test('default preparation policy does not change the request contract fields', () => {
  assert.deepEqual(preparationRequestFields({}), {});
  assert.deepEqual(preparationRequestFields({ calibrationPolicy: 'off', probeBudgetMs: 30000 }), {});
  assert.deepEqual(preparationRequestFields({ calibrationPolicy: 'on-demand', probeBudgetMs: 30000 }), { calibrationPolicy: 'on-demand', probeBudgetMs: 30000 });
  assert.throws(() => preparationRequestFields({ calibrationPolicy: 'always' }), error => error.code === 'invalid_adaptive_calibration_policy');
});

test('preparation candidates are limited to resources blocked only by missing or stale call evidence', async () => {
  const now = Date.now();
  const inventory = {
    resources: [
      resource('missing-call'),
      resource('unsupported', { probe: { supported: false, reason: 'no adapter' } }),
      resource('quota-empty', { quota: { state: 'exhausted', fresh: true, remainingTokens: 0 } }),
      resource('auth-missing', { authentication: { state: 'missing' } }),
      resource('fresh-failed', { callVerification: { state: 'unavailable', observedAt: now - 1000, expiresAt: now + 10000, errorCode: 'probe_failed', qualityStatus: 'unavailable' } }),
    ],
  };
  const plan = await planAdaptive({ input: input(), inventory, fixedExecutorKind: 'external', hostAvailable: false, now });
  const candidates = preparationCandidates({ plan, inventory });
  assert.deepEqual(candidates.map(item => item.resource.id), ['missing-call']);
});

test('on-demand preparation probes one candidate and replans as soon as it becomes eligible', async () => {
  const now = Date.now();
  let current = [resource('native-pi-kimi')];
  const initial = { resources: current };
  const initialPlan = await planAdaptive({ input: input(), inventory: initial, fixedExecutorKind: 'external', hostAvailable: false, now });
  let runnerCalls = 0;
  let preflightCalls = 0;
  const resources = { discover: async () => ({ resources: current }) };
  const runner = { run: async request => {
    runnerCalls++;
    assert.deepEqual(request.resourceIds, ['native-pi-kimi']);
    assert.equal(request.suite, 'quick');
    current = [resource('native-pi-kimi', { callVerification: { state: 'verified', qualityStatus: 'passed', observedAt: now - 1, expiresAt: now + 60000 } })];
    return { results: [{ cached: false, record: { status: 'passed', errorCode: null } }] };
  } };
  const prepared = await prepareAdaptiveResources({
    input: input(),
    inventory: initial,
    plan: initialPlan,
    selection: { fixedExecutorKind: 'external', hostAvailable: false, calibrationPolicy: 'on-demand', probeBudgetMs: 30000, now },
    resources,
    runner,
    preflight: async candidate => {
      preflightCalls++;
      assert.equal(candidate.agent, 'pi');
      assert.deepEqual(candidate.execution, { native: true });
    },
    now: () => now,
  });
  assert.equal(runnerCalls, 1);
  assert.equal(preflightCalls, 1);
  assert.equal(prepared.plan.decision.selected.resourceId, 'native-pi-kimi');
  assert.equal(prepared.evidence.result, 'selected_after_probe');
  assert.equal(prepared.evidence.attempts[0].status, 'passed');
});

test('host or already eligible selections skip probing', async () => {
  const now = Date.now();
  const selectedInventory = { resources: [resource('ready', { callVerification: { state: 'verified', qualityStatus: 'passed', observedAt: now - 1, expiresAt: now + 60000 } })] };
  const selectedPlan = await planAdaptive({ input: input(), inventory: selectedInventory, fixedExecutorKind: 'external', hostAvailable: false, now });
  const hostPlan = await planAdaptive({ input: input({ brief: { risk: 'high', contextDependency: 'high' } }), inventory: { resources: [resource('blocked')] }, hostAvailable: true, now });
  const runner = { run: async () => { throw new Error('runner must not run'); } };
  assert.equal((await prepareAdaptiveResources({ input: input(), inventory: selectedInventory, plan: selectedPlan, selection: { calibrationPolicy: 'on-demand' }, resources: { discover: async () => selectedInventory }, runner, now: () => now })).evidence.reason, 'route_already_selected');
  assert.equal((await prepareAdaptiveResources({ input: input(), inventory: { resources: [resource('blocked')] }, plan: hostPlan, selection: { calibrationPolicy: 'on-demand' }, resources: { discover: async () => ({ resources: [] }) }, runner, now: () => now })).evidence.reason, 'route_already_selected');
});

test('preflight can consume the full budget and prevents a one millisecond runner call', async () => {
  let clock = 1000;
  const inventory = { resources: [resource('slow-preflight')] };
  const initialPlan = await planAdaptive({ input: input(), inventory, fixedExecutorKind: 'external', hostAvailable: false, now: clock });
  let runnerCalls = 0;
  const prepared = await prepareAdaptiveResources({
    input: input(),
    inventory,
    plan: initialPlan,
    selection: { fixedExecutorKind: 'external', hostAvailable: false, calibrationPolicy: 'on-demand', probeBudgetMs: 10 },
    resources: { discover: async () => inventory },
    runner: { run: async () => { runnerCalls++; } },
    preflight: async () => { clock += 11; },
    now: () => clock,
  });
  assert.equal(runnerCalls, 0);
  assert.equal(prepared.evidence.result, 'budget_exhausted');
  assert.equal(prepared.evidence.attempts[0].reason, 'probe_budget_exhausted');
});

test('blocking preflight failures are returned as preparation evidence', async () => {
  const now = Date.now();
  const inventory = { resources: [resource('blocked')] };
  const initialPlan = await planAdaptive({ input: input(), inventory, fixedExecutorKind: 'external', hostAvailable: false, now });
  const prepared = await prepareAdaptiveResources({
    input: input(),
    inventory,
    plan: initialPlan,
    selection: { fixedExecutorKind: 'external', hostAvailable: false, calibrationPolicy: 'on-demand' },
    resources: { discover: async () => inventory },
    runner: { run: async () => { throw new Error('runner must not run'); } },
    preflight: async () => { throw new OrchestratorError('capacity_exceeded', 'busy'); },
    now: () => now,
  });
  assert.equal(prepared.evidence.result, 'preflight_blocked');
  assert.equal(prepared.evidence.reason, 'capacity_exceeded');
  assert.equal(prepared.evidence.attempts[0].errorCode, 'capacity_exceeded');
});
