import test from 'node:test';
import assert from 'node:assert/strict';
import { planAdaptive } from '../src/adaptive-selection.mjs';

const NOW = Date.parse('2026-09-17T02:00:00.000Z');
const OBSERVED = NOW - 60_000;
const EXPIRES = NOW + 10 * 60_000;

function task(extra = {}) {
  return {
    id: 'task1',
    objective: 'Implement the requested change without leaking this prompt.',
    allowedPaths: ['src/'],
    checks: [{ name: 'unit', argv: ['node', '--test'] }],
    isolation: 'checkout',
    brief: { taskKind: 'feature', risk: 'low', independent: true },
    ...extra,
  };
}

function taskWithoutIsolation(extra = {}) {
  const raw = task(extra);
  delete raw.isolation;
  return raw;
}

function resource(id, extra = {}) {
  return {
    schemaVersion: 1,
    id,
    kind: 'profile',
    agent: 'codex',
    profileId: id.replace(/^profile-/, ''),
    providerId: null,
    fingerprint: `${id}-fingerprint`,
    installed: true,
    executable: '/private/bin/must-not-leak',
    configured: true,
    requestedModel: `${id}-model`,
    authentication: { state: 'observed', source: 'profile.credential.env', secret: 'must-not-leak' },
    quotaGroup: { id: `quota:${id}`, source: 'test', confidence: 'medium' },
    quota: { state: 'available', remainingTokens: 10, observedAt: OBSERVED, expiresAt: EXPIRES },
    capabilities: { values: [], source: 'test', unverified: true },
    callVerification: { state: 'verified', observedAt: OBSERVED, expiresAt: EXPIRES, errorCode: null, qualityStatus: 'passed' },
    privateConfig: { token: 'must-not-leak' },
    ...extra,
  };
}

function native(id, agent, extra = {}) {
  return resource(id, {
    kind: 'native',
    agent,
    profileId: null,
    providerId: null,
    quotaGroup: { id: `native:${agent}`, source: 'native', confidence: 'low' },
    ...extra,
  });
}

function inventory(resources) {
  return { schemaVersion: 1, observedAt: '2026-09-17T01:59:00.000Z', resources };
}

test('selects ResourceService-shaped external profiles with numeric TTL evidence', async () => {
  const result = await planAdaptive({
    input: task(),
    inventory: inventory([resource('profile-codex')]),
    fixedExecutorKind: 'external',
    now: NOW,
  });

  assert.equal(result.mode, 'adaptive');
  assert.equal(result.applied, false);
  assert.equal(result.selectedResource.id, 'profile-codex');
  assert.equal(result.effectiveTask.execution.profile, 'codex');
  assert.deepEqual(result.effectiveTask.execution, { profile: 'codex', allowShared: false });
  assert.match(result.inputDigest, /^[a-f0-9]{64}$/);
});

test('native resources bypass default execution profile and add model/provider args', async () => {
  const result = await planAdaptive({
    input: task({
      agent: 'pi',
      agentArgs: ['--debug'],
      execution: { native: true },
      brief: { taskKind: 'feature', risk: 'low', independent: true, requiredCapabilities: ['coding'] },
    }),
    inventory: inventory([
      native('native-pi-kimi', 'pi', {
        providerId: 'kimi',
        requestedModel: 'kimi/k3',
        effort: 'medium',
        capabilities: { values: ['coding'], source: 'verified-suite', unverified: false },
      }),
    ]),
    allowedResourceIds: ['native-pi-kimi'],
    fixedExecutorKind: 'external',
    now: NOW,
  });

  assert.equal(result.selectedResource.id, 'native-pi-kimi');
  assert.equal(result.selectedResource.effort, 'medium');
  assert.deepEqual(result.effectiveTask.execution, { native: true });
  assert.equal(result.effectiveTask.agent, 'pi');
  assert.deepEqual(result.effectiveTask.agentArgs, ['--debug', '--provider', 'kimi', '--model', 'kimi/k3', '--thinking', 'medium']);
});

test('native selection rejects caller-owned model provider session config credential and effort flags', async () => {
  for (const flag of ['--model', '--provider', '--session-dir', '--effort', '--thinking', '--api-key', '--profile', '-p', '--setting-sources', '--models']) {
    await assert.rejects(
      planAdaptive({
        input: task({ agent: 'pi', agentArgs: [flag, 'other'], brief: { taskKind: 'feature', risk: 'low', independent: true } }),
        inventory: inventory([native('native-pi', 'pi', { requestedModel: 'kimi/k3' })]),
        fixedExecutorKind: 'external',
        fixedAgent: 'pi',
        now: NOW,
      }),
      error => error.code === 'adaptive_argument_conflict',
      flag,
    );
  }
});

test('execution profile pools restrict resources and prevent host escape', async () => {
  const result = await planAdaptive({
    input: task({
      execution: { profiles: ['allowed'] },
      brief: { taskKind: 'feature', risk: 'low', independent: true },
    }),
    inventory: inventory([
      resource('profile-allowed', { profileId: 'allowed' }),
      resource('profile-denied', { profileId: 'denied' }),
    ]),
    now: NOW,
  });

  assert.equal(result.selectedResource.id, 'profile-allowed');
  assert.equal(result.effectiveTask.execution.profile, 'allowed');
  assert.ok(result.decision.candidates.find(candidate => candidate.resourceId === 'profile-denied').reasons.includes('resource_not_in_allowlist'));
});

test('execution profile pools intersect caller resource allowlists', async () => {
  const result = await planAdaptive({
    input: task({
      execution: { profiles: ['allowed'] },
      brief: { taskKind: 'feature', risk: 'low', independent: true },
    }),
    inventory: inventory([
      resource('profile-allowed', { profileId: 'allowed' }),
      resource('profile-denied', { profileId: 'denied' }),
    ]),
    allowedResourceIds: ['profile-denied'],
    now: NOW,
  });

  assert.equal(result.selectedResource, null);
  assert.equal(result.effectiveTask, null);
  assert.ok(result.decision.reasons.includes('host_not_allowed'));
  assert.ok(result.decision.candidates.every(candidate => candidate.eligible === false));
});

test('input native execution considers native resources only', async () => {
  const result = await planAdaptive({
    input: task({ agent: 'pi', execution: { native: true } }),
    inventory: inventory([
      resource('profile-pi', { agent: 'pi', profileId: 'pi' }),
      native('native-pi', 'pi', { requestedModel: 'kimi/k3' }),
    ]),
    now: NOW,
  });

  assert.equal(result.selectedResource.id, 'native-pi');
  assert.deepEqual(result.effectiveTask.execution, { native: true });
  assert.ok(result.decision.candidates.find(candidate => candidate.resourceId === 'profile-pi').reasons.includes('resource_not_in_allowlist'));
});

test('explicit raw agent filters resources while auto remains unconstrained', async () => {
  const explicit = await planAdaptive({
    input: task({ agent: 'claude' }),
    inventory: inventory([
      resource('profile-codex', { agent: 'codex' }),
      resource('profile-claude', { agent: 'claude' }),
    ]),
    fixedExecutorKind: 'external',
    now: NOW,
  });
  assert.equal(explicit.selectedResource.id, 'profile-claude');

  const auto = await planAdaptive({
    input: task({ agent: 'auto' }),
    inventory: inventory([resource('profile-codex', { agent: 'codex' })]),
    fixedExecutorKind: 'external',
    now: NOW,
  });
  assert.equal(auto.selectedResource.id, 'profile-codex');
});

test('fixedAgent cannot contradict an explicit raw task agent', async () => {
  await assert.rejects(
    planAdaptive({
      input: task({ agent: 'claude' }),
      inventory: inventory([resource('profile-codex', { agent: 'codex' })]),
      fixedAgent: 'codex',
      fixedExecutorKind: 'external',
      now: NOW,
    }),
    error => error.code === 'adaptive_selector_conflict',
  );
});

test('fixed profile and agent mismatch does not silently override to another resource', async () => {
  const result = await planAdaptive({
    input: task({ agent: 'claude' }),
    inventory: inventory([
      resource('profile-codex', { profileId: 'codex', agent: 'codex' }),
      resource('profile-claude', { profileId: 'claude', agent: 'claude' }),
    ]),
    fixedProfileId: 'codex',
    fixedExecutorKind: 'external',
    now: NOW,
  });

  assert.equal(result.selectedResource, null);
  assert.equal(result.effectiveTask, null);
  assert.ok(result.decision.candidates.find(candidate => candidate.resourceId === 'profile-codex').reasons.includes('agent_mismatch:codex:claude'));
});

test('worktree isolation cannot select host and explicit host contradiction throws', async () => {
  const implicit = await planAdaptive({
    input: task({ isolation: 'worktree', brief: { taskKind: 'feature', risk: 'high', independent: false } }),
    inventory: inventory([]),
    now: NOW,
  });
  assert.equal(implicit.selectedResource, null);
  assert.equal(implicit.effectiveTask, null);

  await assert.rejects(
    planAdaptive({
      input: task({ isolation: 'worktree' }),
      inventory: inventory([]),
      fixedExecutorKind: 'host',
      now: NOW,
    }),
    error => error.code === 'adaptive_selector_conflict',
  );
});

test('host effective task is codex checkout without execution or caller args', async () => {
  const result = await planAdaptive({
    input: task({ agentArgs: ['--ignored-for-host'], brief: { taskKind: 'feature', risk: 'high', independent: false } }),
    inventory: inventory([resource('profile-codex')]),
    hostAvailable: 'native-host',
    now: NOW,
  });

  assert.equal(result.selectedResource.id, 'native-host');
  assert.equal(result.selectedResource.kind, 'host');
  assert.equal(result.effectiveTask.agent, 'codex');
  assert.equal(result.effectiveTask.isolation, 'checkout');
  assert.deepEqual(result.effectiveTask.agentArgs, []);
  assert.equal(Object.hasOwn(result.effectiveTask, 'execution'), false);
});

test('omitted isolation may select host even though task validation defaults to worktree', async () => {
  const result = await planAdaptive({
    input: taskWithoutIsolation({ agentArgs: ['--ignored-for-host'], brief: { taskKind: 'feature', risk: 'high', independent: false } }),
    inventory: inventory([]),
    fixedExecutorKind: 'host',
    now: NOW,
  });

  assert.equal(result.selectedResource.kind, 'host');
  assert.equal(result.effectiveTask.isolation, 'checkout');
  assert.deepEqual(result.effectiveTask.agentArgs, []);
});

test('matched history can reorder eligible externals but unrelated fingerprints do not', async () => {
  const resources = [
    resource('profile-alpha', { fingerprint: 'alpha-fp' }),
    resource('profile-beta', { fingerprint: 'beta-fp' }),
  ];
  const unrelated = await planAdaptive({
    input: task({ brief: { taskKind: 'feature', risk: 'low', independent: true } }),
    inventory: inventory(resources),
    preference: 'fastest',
    fixedExecutorKind: 'external',
    history: [
      { fingerprint: 'other-fp', taskKind: 'feature', status: 'accepted', elapsedMs: 1 },
      { fingerprint: 'beta-fp', taskKind: 'bugfix', status: 'integrated', elapsedMs: 1 },
      { fingerprint: 'beta-fp', taskKind: 'feature', status: 'accepted', elapsedMs: 1 },
      { fingerprint: 'beta-fp', taskKind: 'feature', status: 'accepted', elapsedMs: 1 },
    ],
    now: NOW,
  });
  assert.equal(unrelated.selectedResource.id, 'profile-alpha');
  assert.equal(unrelated.evidence.proof.source, 'deterministic-insufficient');

  const matched = await planAdaptive({
    input: task({ brief: { taskKind: 'feature', risk: 'low', independent: true } }),
    inventory: inventory(resources),
    preference: 'fastest',
    fixedExecutorKind: 'external',
    history: [
      { fingerprint: 'alpha-fp', taskKind: 'feature', status: 'accepted', elapsedMs: 9000 },
      { fingerprint: 'alpha-fp', taskKind: 'feature', status: 'failed', elapsedMs: 3000 },
      { fingerprint: 'alpha-fp', taskKind: 'feature', status: 'cancelled', elapsedMs: 3000 },
      { fingerprint: 'beta-fp', taskKind: 'feature', status: 'integrated', elapsedMs: 1000 },
      { fingerprint: 'beta-fp', taskKind: 'feature', status: 'failed', elapsedMs: 2000 },
      { fingerprint: 'beta-fp', taskKind: 'feature', status: 'timed_out', elapsedMs: 3000 },
      { fingerprint: 'beta-fp', taskKind: 'bugfix', status: 'integrated', elapsedMs: 1 },
    ],
    now: NOW,
  });
  assert.equal(matched.selectedResource.id, 'profile-beta');
  assert.equal(matched.evidence.proof.source, 'history');
  assert.deepEqual(
    matched.evidence.proof.matchedCandidates.find(candidate => candidate.resourceId === 'profile-beta'),
    { resourceId: 'profile-beta', samples: 3, success: 1, failed: 2, elapsedMs: 2000, timeBasis: 'all_terminal_outcomes', integrated: 1 },
  );
});

test('fastest rejects a quicker all-fail candidate in favor of a slower completing one', async () => {
  const result = await planAdaptive({
    input: task({ brief: { taskKind: 'feature', risk: 'low', independent: true } }),
    inventory: inventory([
      resource('profile-alpha', { fingerprint: 'alpha-fp' }),
      resource('profile-beta', { fingerprint: 'beta-fp' }),
    ]),
    preference: 'fastest',
    fixedExecutorKind: 'external',
    history: [
      { fingerprint: 'alpha-fp', taskKind: 'feature', status: 'failed', elapsedMs: 1 },
      { fingerprint: 'alpha-fp', taskKind: 'feature', status: 'timed_out', elapsedMs: 1 },
      { fingerprint: 'alpha-fp', taskKind: 'feature', status: 'cancelled', elapsedMs: 1 },
      { fingerprint: 'beta-fp', taskKind: 'feature', status: 'accepted', elapsedMs: 9000 },
      { fingerprint: 'beta-fp', taskKind: 'feature', status: 'failed', elapsedMs: 9000 },
      { fingerprint: 'beta-fp', taskKind: 'feature', status: 'failed', elapsedMs: 9000 },
    ],
    now: NOW,
  });
  assert.equal(result.selectedResource.id, 'profile-beta');
  assert.equal(result.evidence.proof.source, 'history');
});

test('quality-first, fastest and subscription-first produce distinct inspectable selections', async () => {
  const resources = [
    resource('profile-alpha', { fingerprint: 'alpha-fp' }),
    resource('profile-beta', { fingerprint: 'beta-fp' }),
  ];
  const history = [
    { fingerprint: 'alpha-fp', taskKind: 'feature', status: 'integrated', elapsedMs: 9000 },
    { fingerprint: 'alpha-fp', taskKind: 'feature', status: 'integrated', elapsedMs: 9000 },
    { fingerprint: 'alpha-fp', taskKind: 'feature', status: 'integrated', elapsedMs: 9000 },
    { fingerprint: 'beta-fp', taskKind: 'feature', status: 'accepted', elapsedMs: 1000 },
    { fingerprint: 'beta-fp', taskKind: 'feature', status: 'accepted', elapsedMs: 1000 },
    { fingerprint: 'beta-fp', taskKind: 'feature', status: 'accepted', elapsedMs: 1000 },
  ];
  const input = task({ brief: { taskKind: 'feature', risk: 'low', independent: true } });
  const quality = await planAdaptive({
    input, inventory: inventory(resources), preference: 'quality-first', fixedExecutorKind: 'external', history, now: NOW,
  });
  const fastest = await planAdaptive({
    input, inventory: inventory(resources), preference: 'fastest', fixedExecutorKind: 'external', history, now: NOW,
  });
  const subscription = await planAdaptive({
    input, inventory: inventory(resources), preference: 'subscription-first', fixedExecutorKind: 'external', history, now: NOW,
  });
  assert.equal(quality.selectedResource.id, 'profile-alpha');
  assert.equal(fastest.selectedResource.id, 'profile-beta');
  assert.equal(subscription.selectedResource.id, 'profile-alpha');
  assert.equal(quality.evidence.proof.source, 'history');
  assert.equal(fastest.evidence.proof.source, 'history');
  assert.equal(subscription.evidence.proof.source, 'deterministic-insufficient');
  assert.ok(quality.decision.reasons.includes('preference:quality-first'));
  assert.ok(fastest.decision.reasons.includes('preference:fastest'));
  assert.ok(subscription.decision.reasons.includes('preference:subscription-first'));
  assert.notEqual(quality.decision.reasons.join(','), fastest.decision.reasons.join(','));
});

test('history never turns host or null selection into an external selection', async () => {
  const host = await planAdaptive({
    input: taskWithoutIsolation({ brief: { taskKind: 'feature', risk: 'high', independent: false } }),
    inventory: inventory([resource('profile-beta', { fingerprint: 'beta-fp' })]),
    preference: 'fastest',
    history: [
      { fingerprint: 'beta-fp', taskKind: 'feature', status: 'accepted', elapsedMs: 1 },
      { fingerprint: 'beta-fp', taskKind: 'feature', status: 'accepted', elapsedMs: 1 },
      { fingerprint: 'beta-fp', taskKind: 'feature', status: 'accepted', elapsedMs: 1 },
    ],
    now: NOW,
  });
  assert.equal(host.selectedResource.kind, 'host');
  assert.equal(host.evidence.proof.source, 'deterministic-insufficient');

  const none = await planAdaptive({
    input: task({ isolation: 'worktree', brief: { taskKind: 'feature', risk: 'high', independent: false } }),
    inventory: inventory([resource('profile-beta', { fingerprint: 'beta-fp' })]),
    preference: 'fastest',
    history: [
      { fingerprint: 'beta-fp', taskKind: 'feature', status: 'accepted', elapsedMs: 1 },
      { fingerprint: 'beta-fp', taskKind: 'feature', status: 'accepted', elapsedMs: 1 },
      { fingerprint: 'beta-fp', taskKind: 'feature', status: 'accepted', elapsedMs: 1 },
    ],
    now: NOW,
  });
  assert.equal(none.selectedResource, null);
  assert.equal(none.evidence.proof.source, 'deterministic-insufficient');
});

test('decision task and selected resource omit private config executable and credentials', async () => {
  const result = await planAdaptive({
    input: task(),
    inventory: inventory([resource('profile-codex')]),
    fixedExecutorKind: 'external',
    now: NOW,
  });

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /privateConfig|executable|credential|\/private\/bin/);
});
