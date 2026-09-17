import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { explainShadowRoute, recordShadowDecision } from '../src/shadow-routing.mjs';
import { taskDigest, validateTask } from '../src/task.mjs';

const NOW = Date.parse('2026-09-17T02:00:00.000Z');
const OBSERVED = NOW - 60_000;
const EXPIRES = NOW + 10 * 60_000;

test('explicit executor disambiguates current host from external Codex checkout without fallback', async () => {
  const input = { task: task({ agent: 'codex', isolation: 'checkout' }), inventory: inventory([resource('profile-codex')]), fixedAgent: 'codex', now: NOW };
  assert.equal((await explainShadowRoute({ ...input, fixedExecutorKind: 'host' })).selected.executorKind, 'host');
  assert.equal((await explainShadowRoute({ ...input, fixedExecutorKind: 'host', hostAvailable: false })).selected, null);
  assert.equal((await explainShadowRoute({ ...input, fixedExecutorKind: 'external' })).selected.executorKind, 'external');
  await assert.rejects(explainShadowRoute({ ...input, fixedExecutorKind: 'host', fixedProfileId: 'codex' }), e => e.code === 'shadow_selector_conflict');
});

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-shadow-routing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function resource(id, extra = {}) {
  return {
    id,
    kind: 'profile',
    agent: 'codex',
    profileId: id.replace(/^profile-/, ''),
    providerId: null,
    installed: true,
    configured: true,
    authentication: { state: 'observed', source: 'profile.credential.none' },
    quota: { state: 'available', fresh: true, remainingTokens: 10, observedAt: OBSERVED, expiresAt: EXPIRES },
    capabilities: { values: [], source: 'unknown', unverified: true },
    callVerification: { state: 'verified', observedAt: OBSERVED, expiresAt: EXPIRES, errorCode: null, qualityStatus: 'passed' },
    ...extra,
  };
}

function inventory(resources) {
  return { schemaVersion: 1, observedAt: '2026-09-17T01:59:00.000Z', resources };
}

function task(extra = {}) {
  return validateTask({
    id: 'task1',
    objective: 'private prompt must not be persisted',
    allowedPaths: ['src/'],
    checks: [{ name: 'unit', argv: ['node', '--test'] }],
    ...extra,
  });
}

test('brief low-risk high context dependency keeps host despite a verified external candidate', async () => {
  const decision = await explainShadowRoute({
    task: task({ brief: { risk: 'low', contextDependency: 'high', independent: true } }),
    inventory: inventory([resource('profile-codex')]),
    preference: 'balanced',
    now: NOW,
  });

  assert.deepEqual(decision.selected, { executorKind: 'host', resourceId: null });
  assert.equal(decision.applied, false);
  assert.ok(decision.reasons.includes('low_risk_high_context_dependency_prefers_host'));
  assert.ok(decision.candidates.find(candidate => candidate.resourceId === 'profile-codex').eligible);
});

test('simple independent task can suggest a fresh verified external candidate without dispatching', async () => {
  const decision = await explainShadowRoute({
    task: task({ brief: { independent: true, taskKind: 'feature' } }),
    inventory: inventory([
      resource('profile-zeta'),
      resource('profile-alpha', { quota: { state: 'available', fresh: true, remainingTokens: 20, observedAt: OBSERVED, expiresAt: EXPIRES } }),
    ]),
    preference: 'fastest',
    now: NOW,
  });

  assert.deepEqual(decision.selected, { executorKind: 'external', resourceId: 'profile-alpha' });
  assert.equal(decision.applied, false);
  assert.ok(decision.reasons.includes('insufficient_comparative_latency_evidence'));
  assert.ok(decision.reasons.includes('shadow_advisory_only_not_dispatched'));
  assert.equal(decision.evidence.comparativeLatency, 'insufficient_evidence');
});

test('normalized default claude task.agent does not force external routing without explicit fixed agent', async () => {
  const decision = await explainShadowRoute({
    task: task({ agent: 'claude', brief: { independent: true } }),
    inventory: inventory([resource('profile-codex', { agent: 'codex' })]),
    now: NOW,
  });

  assert.deepEqual(decision.selected, { executorKind: 'external', resourceId: 'profile-codex' });
  assert.equal(decision.candidates[0].eligible, true);
  assert.ok(!decision.candidates[0].reasons.some(reason => reason.startsWith('agent_mismatch')));
});

test('explicit fixedAgent filters resources and never falls back outside the allowlist', async () => {
  const decision = await explainShadowRoute({
    task: task({ brief: { independent: true } }),
    inventory: inventory([
      resource('profile-codex', { agent: 'codex' }),
      resource('profile-claude', { agent: 'claude' }),
    ]),
    fixedAgent: 'claude',
    allowedResourceIds: ['profile-codex'],
    hostAvailable: true,
    now: NOW,
  });

  assert.equal(decision.selected, null);
  assert.equal(decision.candidates.find(candidate => candidate.resourceId === 'profile-codex').eligible, false);
  assert.ok(decision.candidates.find(candidate => candidate.resourceId === 'profile-codex').reasons.includes('agent_mismatch:codex:claude'));
  assert.equal(decision.candidates.find(candidate => candidate.resourceId === 'profile-claude').eligible, false);
  assert.ok(decision.candidates.find(candidate => candidate.resourceId === 'profile-claude').reasons.includes('resource_not_in_allowlist'));
});

test('empty allowlist blocks host escape under explicit policy', async () => {
  const decision = await explainShadowRoute({
    task: task({ brief: { risk: 'high', independent: false } }),
    inventory: inventory([resource('profile-codex')]),
    allowedResourceIds: [],
    now: NOW,
  });

  assert.deepEqual(decision.selected, null);
  assert.ok(decision.reasons.includes('host_not_allowed'));
  assert.equal(decision.candidates[0].eligible, false);
  assert.ok(decision.candidates[0].reasons.includes('resource_not_in_allowlist'));
});

test('fixed execution profile is respected and does not select another eligible profile', async () => {
  const decision = await explainShadowRoute({
    task: task({ brief: { independent: true }, execution: { profile: 'missing-auth' } }),
    inventory: inventory([
      resource('profile-missing-auth', { profileId: 'missing-auth', authentication: { state: 'missing', source: 'profile.credential.env' } }),
      resource('profile-good', { profileId: 'good' }),
    ]),
    now: NOW,
  });

  assert.equal(decision.selected, null);
  assert.ok(decision.candidates.find(candidate => candidate.resourceId === 'profile-missing-auth').reasons.includes('authentication_missing'));
  assert.ok(decision.candidates.find(candidate => candidate.resourceId === 'profile-good').reasons.includes('fixed_profile_mismatch'));
});

test('caller fixedProfileId conflict with task.execution profile is rejected', async () => {
  await assert.rejects(
    explainShadowRoute({
      task: task({ execution: { profile: 'task-profile' } }),
      inventory: inventory([resource('profile-task-profile', { profileId: 'task-profile' })]),
      fixedProfileId: 'caller-profile',
      now: NOW,
    }),
    error => error.code === 'shadow_fixed_profile_conflict',
  );
});

test('fresh negative call verification and explicit quota exhaustion are ineligible evidence', async () => {
  const decision = await explainShadowRoute({
    task: task({ brief: { independent: true } }),
    inventory: inventory([
      resource('profile-down', { callVerification: { state: 'unavailable', observedAt: OBSERVED, expiresAt: EXPIRES, errorCode: 'probe_failed', qualityStatus: 'failed' } }),
      resource('profile-exhausted', { quota: { state: 'exhausted', fresh: true, remainingTokens: 0, observedAt: OBSERVED, expiresAt: EXPIRES } }),
    ]),
    now: NOW,
  });

  assert.deepEqual(decision.selected, { executorKind: 'host', resourceId: null });
  assert.ok(decision.candidates.find(candidate => candidate.resourceId === 'profile-down').reasons.includes('call_verification_unavailable_fresh'));
  assert.ok(decision.candidates.find(candidate => candidate.resourceId === 'profile-exhausted').reasons.includes('quota_exhausted_fresh'));
});

test('future observedAt is not fresh even with a future expiresAt and quota.fresh true', async () => {
  const futureObserved = NOW + 60_000;
  const decision = await explainShadowRoute({
    task: task({ brief: { independent: true } }),
    inventory: inventory([
      resource('profile-future-call', { callVerification: { state: 'verified', observedAt: futureObserved, expiresAt: EXPIRES, errorCode: null, qualityStatus: 'passed' } }),
      resource('profile-future-quota', { quota: { state: 'exhausted', fresh: true, remainingTokens: 0, observedAt: futureObserved, expiresAt: EXPIRES } }),
    ]),
    now: NOW,
  });

  assert.deepEqual(decision.selected, { executorKind: 'external', resourceId: 'profile-future-quota' });
  assert.ok(decision.candidates.find(candidate => candidate.resourceId === 'profile-future-call').reasons.includes('call_verification_stale'));
  assert.ok(!decision.candidates.find(candidate => candidate.resourceId === 'profile-future-quota').reasons.includes('quota_exhausted_fresh'));
  assert.equal(decision.candidates.find(candidate => candidate.resourceId === 'profile-future-quota').evidence.quotaFresh, false);
});

test('required capabilities are not treated as verified when only declared by resource inventory', async () => {
  const declaredOnly = await explainShadowRoute({
    task: task({ brief: { independent: true, requiredCapabilities: ['coding'] } }),
    inventory: inventory([resource('profile-declared', { capabilities: { values: ['coding'], source: 'profile', unverified: true } })]),
    now: NOW,
  });

  assert.deepEqual(declaredOnly.selected, { executorKind: 'host', resourceId: null });
  assert.ok(declaredOnly.candidates[0].reasons.includes('capabilities_unverified'));

  const verifiedDeclaration = await explainShadowRoute({
    task: task({ brief: { independent: true, requiredCapabilities: ['coding'] } }),
    inventory: inventory([resource('profile-verified-cap', { capabilities: { values: ['coding'], source: 'verified-suite', unverified: false } })]),
    now: NOW,
  });

  assert.deepEqual(verifiedDeclaration.selected, { executorKind: 'external', resourceId: 'profile-verified-cap' });
});

test('selected external resource remains in truncated candidate evidence', async () => {
  const resources = Array.from({ length: 20 }, (_, index) => resource(`profile-${String(index).padStart(2, '0')}`, {
    quota: index === 17
      ? { state: 'available', fresh: true, remainingTokens: 99, observedAt: OBSERVED, expiresAt: EXPIRES }
      : { state: 'unknown', fresh: false, remainingTokens: null, observedAt: OBSERVED, expiresAt: EXPIRES },
  }));
  const decision = await explainShadowRoute({
    task: task({ brief: { independent: true } }),
    inventory: inventory(resources),
    now: NOW,
  });

  assert.equal(decision.candidates.length, 12);
  assert.deepEqual(decision.selected, { executorKind: 'external', resourceId: 'profile-17' });
  assert.ok(decision.candidates.some(candidate => candidate.resourceId === decision.selected.resourceId));
});

test('shadow taskDigest matches normalized task digest without persisting objective', async () => {
  const input = task({ objective: 'SECRET_DIGEST_OBJECTIVE', brief: { independent: true, taskKind: 'bugfix' } });
  const decision = await explainShadowRoute({
    task: input,
    inventory: inventory([resource('profile-safe')]),
    now: NOW,
  });

  assert.equal(decision.taskDigest, taskDigest(input));
  assert.doesNotMatch(JSON.stringify(decision), /SECRET_DIGEST_OBJECTIVE|objective/);
});

test('recordShadowDecision writes only safe advisory state with a unique id', async t => {
  const root = await tempRoot(t);
  const decision = await explainShadowRoute({
    task: task({ objective: 'SECRET_OBJECTIVE_TEXT', brief: { independent: true } }),
    inventory: inventory([
      resource('profile-safe', {
        executable: '/private/path/that/should/not/persist',
        rawSecret: 'SECRET_RAW_INVENTORY',
      }),
    ]),
    now: NOW,
  });

  const first = await recordShadowDecision(root, 'thread1', decision);
  const second = await recordShadowDecision(root, 'thread1', decision);
  assert.notEqual(first.id, second.id);
  assert.equal(first.mode, 'shadow');
  assert.equal(first.applied, false);

  const text = await fs.readFile(path.join(root, 'shadow-routing', 'threads', 'thread1.json'), 'utf8');
  assert.doesNotMatch(text, new RegExp('SECRET_OBJECTIVE_TEXT|SECRET_RAW_INVENTORY|private/path|objective|rawSecret'));
  const stored = JSON.parse(text);
  assert.equal(stored.decisions.length, 2);
  assert.deepEqual(stored.decisions[0].selected, { executorKind: 'external', resourceId: 'profile-safe' });
});
