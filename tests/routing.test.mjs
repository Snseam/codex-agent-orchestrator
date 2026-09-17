import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { explainRoute, listReservations, releaseExecution, reserveExecution, selectRoute, validateExecution } from '../src/routing.mjs';
import { saveRun } from '../src/state.mjs';

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-routing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function future() {
  return new Date(Date.now() + 60_000).toISOString();
}

function past() {
  return new Date(Date.now() - 60_000).toISOString();
}

function profile(id, overrides = {}) {
  return {
    id,
    name: id,
    agent: 'claude',
    model: 'claude-sonnet',
    protocol: 'anthropic',
    endpoint: 'https://api.example.com/v1/messages',
    credential: { kind: 'env', name: 'TOKEN' },
    source: { type: 'inline' },
    enabled: true,
    capabilities: ['edit', 'shell'],
    priority: 0,
    account: { id: `${id}-acct`, maxParallel: 1 },
    quota: { state: 'available', observedAt: new Date().toISOString(), expiresAt: future() },
    quality: 50,
    speed: 50,
    costPerMillion: 5,
    ...overrides,
  };
}

function store(root, profiles, options = {}) {
  const byId = new Map(profiles.map(p => [p.id, p]));
  return {
    root,
    async resolve(id) {
      const item = byId.get(id);
      if (!item) throw Object.assign(new Error(`missing ${id}`), { code: 'profile_not_found' });
      return structuredClone(item);
    },
    ...(options.credentialAvailable ? { credentialAvailable: options.credentialAvailable } : {}),
  };
}

async function activeRun(root, { runId = 'run1', taskId = 'task1', attemptId = 'attempt1', status = 'running', workerClosed = false } = {}) {
  await saveRun(root, {
    schemaVersion: 1,
    id: runId,
    project: '/tmp/project',
    tasks: {
      [taskId]: {
        definition: { id: taskId },
        currentAttempt: attemptId,
        attempts: [{ id: attemptId, taskId, status, workerClosed, launcherPid: 1 }],
      },
    },
  });
}

test('validateExecution rejects ambiguous selectors and defaults shared routing to false', () => {
  assert.deepEqual(validateExecution({ profiles: ['a'], requireCapabilities: ['shell', 'shell'] }), {
    profiles: ['a'],
    requireCapabilities: ['shell'],
    allowShared: false,
  });
  assert.throws(() => validateExecution({ profile: 'p1', policy: 'quality' }), error => error.code === 'invalid_execution');
  assert.throws(() => validateExecution({ policy: 'speed' }), error => error.code === 'invalid_execution');
  assert.throws(() => validateExecution({ profiles: ['p1'], nope: true }), error => error.code === 'invalid_execution');
  assert.deepEqual(validateExecution({ native: true }), { native: true });
  assert.throws(() => validateExecution({ native: true, profile: 'p1' }), error => error.code === 'invalid_execution');
  assert.throws(() => validateExecution({ native: false }), error => error.code === 'invalid_execution');
});

test('explainRoute filters protocol, capabilities, shared sources, fresh source and quota failures', async t => {
  const root = await tempRoot(t);
  const decision = await explainRoute(store(root, [
    profile('good', { priority: 1, quality: 70 }),
    profile('wrong-protocol', { protocol: 'openai-chat' }),
    profile('pi-candidate', { agent: 'pi', protocol: 'anthropic' }),
    profile('no-cap', { capabilities: [] }),
    profile('shared', { source: { type: 'cc-switch', allowShared: true, route: 'active-proxy' } }),
    profile('source-down', { source: { state: 'unavailable', observedAt: new Date().toISOString(), expiresAt: future() } }),
    profile('quota-gone', { quota: { state: 'exhausted', observedAt: new Date().toISOString(), expiresAt: future() } }),
    profile('quota-zero', { quality: 95, quota: { state: 'available', remainingTokens: 0, observedAt: new Date().toISOString(), expiresAt: future() } }),
    profile('quota-stale', { quality: 90, quota: { state: 'exhausted', observedAt: past(), expiresAt: past() } }),
  ]), { policy: 'quality', profiles: ['good', 'wrong-protocol', 'pi-candidate', 'no-cap', 'shared', 'source-down', 'quota-gone', 'quota-zero', 'quota-stale'], requireCapabilities: ['shell'] }, { agent: 'claude' });

  assert.equal(decision.signalBasis, 'declared-and-observed');
  assert.equal(decision.selectedProfileId, 'quota-stale');
  assert.equal(decision.candidates.find(c => c.profileId === 'wrong-protocol').eligible, false);
  assert.ok(decision.candidates.find(c => c.profileId === 'wrong-protocol').reasons.some(r => r.startsWith('protocol_incompatible:claude')));
  assert.equal(decision.candidates.find(c => c.profileId === 'pi-candidate').eligible, false);
  assert.ok(decision.candidates.find(c => c.profileId === 'pi-candidate').reasons.some(r => r.startsWith('agent_mismatch:pi:claude')));
  assert.deepEqual(decision.candidates.find(c => c.profileId === 'no-cap').reasons.filter(r => r.startsWith('missing_capability')), ['missing_capability:shell']);
  assert.equal(decision.candidates.find(c => c.profileId === 'shared').eligible, false);
  assert.ok(decision.candidates.find(c => c.profileId === 'shared').reasons.includes('shared_source_requires_allowShared'));
  assert.equal(decision.candidates.find(c => c.profileId === 'source-down').eligible, false);
  assert.equal(decision.candidates.find(c => c.profileId === 'quota-gone').eligible, false);
  assert.equal(decision.candidates.find(c => c.profileId === 'quota-zero').eligible, false);
  assert.ok(decision.candidates.find(c => c.profileId === 'quota-zero').reasons.includes('quota_exhausted'));
  assert.equal(decision.candidates.find(c => c.profileId === 'quota-stale').eligible, true);
  assert.ok(decision.candidates.find(c => c.profileId === 'quota-stale').reasons.includes('quota_exhausted_stale'));
});

test('route explain validates profile protocol without a requested agent and allows shared sources only when explicit', async t => {
  const root = await tempRoot(t);
  const profiles = [
    profile('bad-native', { protocol: 'openai-chat' }),
    profile('active-proxy', { source: { type: 'cc-switch', allowShared: true, route: 'active-proxy' }, quality: 99 }),
    profile('ok', { quality: 10 }),
  ];
  const denied = await explainRoute(store(root, profiles), { policy: 'quality', profiles: ['bad-native', 'active-proxy', 'ok'] });
  assert.equal(denied.selectedProfileId, 'ok');
  assert.ok(denied.candidates.find(c => c.profileId === 'bad-native').reasons.some(r => r.startsWith('protocol_incompatible:claude')));
  assert.ok(denied.candidates.find(c => c.profileId === 'active-proxy').reasons.includes('shared_source_requires_allowShared'));

  const allowed = await explainRoute(store(root, profiles), { policy: 'quality', profiles: ['active-proxy', 'ok'], allowShared: true });
  assert.equal(allowed.selectedProfileId, 'active-proxy');
});

test('route explain excludes missing or unavailable credentials without exposing credential material', async t => {
  const root = await tempRoot(t);
  const unavailable = profile('unavailable');
  const decision = await explainRoute(store(root, [
    profile('missing', { credential: undefined }),
    unavailable,
    profile('ok', { quality: 1 }),
  ], {
    credentialAvailable: candidate => candidate.id !== unavailable.id,
  }), { policy: 'quality', profiles: ['missing', 'unavailable', 'ok'] });

  assert.equal(decision.selectedProfileId, 'ok');
  assert.ok(decision.candidates.find(c => c.profileId === 'missing').reasons.includes('credential_missing'));
  assert.ok(decision.candidates.find(c => c.profileId === 'unavailable').reasons.includes('credential_unavailable'));
  assert.ok(!decision.candidates.flatMap(c => c.reasons).some(reason => reason.includes('TOKEN')));
});

test('cost policy excludes unknown cost while quality and speed rank unknown below declared scores', async t => {
  const root = await tempRoot(t);
  const profiles = [profile('unknown', { costPerMillion: null, quality: null, speed: null, priority: 100 }), profile('cheap', { costPerMillion: 1, quality: 10, speed: 20 })];
  const cost = await explainRoute(store(root, profiles), { policy: 'cost', profiles: ['unknown', 'cheap'] });
  assert.equal(cost.selectedProfileId, 'cheap');
  assert.equal(cost.candidates.find(c => c.profileId === 'unknown').eligible, false);
  assert.ok(cost.candidates.find(c => c.profileId === 'unknown').reasons.includes('cost_unknown'));

  const quality = await explainRoute(store(root, profiles), { policy: 'quality', profiles: ['unknown', 'cheap'] });
  assert.equal(quality.selectedProfileId, 'cheap');
  const speed = await explainRoute(store(root, profiles), { policy: 'speed', profiles: ['unknown', 'cheap'] });
  assert.equal(speed.selectedProfileId, 'cheap');
});

test('selectRoute retries automatic candidates on capacity but fixed profile capacity fails', async t => {
  const root = await tempRoot(t);
  await activeRun(root, { runId: 'run1', taskId: 'busy', attemptId: 'busy-a1' });
  const busy = profile('busy', { account: { id: 'shared-account', maxParallel: 1 }, quality: 100 });
  const free = profile('free', { account: { id: 'free-account', maxParallel: 1 }, quality: 50 });
  await reserveExecution(root, busy, { runId: 'run1', taskId: 'busy', attemptId: 'busy-a1' });
  await activeRun(root, { runId: 'run2', taskId: 'next', attemptId: 'next-a1' });

  const automatic = await selectRoute(store(root, [busy, free]), { policy: 'quality', profiles: ['busy', 'free'] }, { runId: 'run2', taskId: 'next', attemptId: 'next-a1' });
  assert.equal(automatic.profile.id, 'free');
  assert.equal(automatic.decision.selectedProfileId, 'free');
  assert.ok(automatic.decision.candidates.find(c => c.profileId === 'busy').reasons.some(reason => reason.startsWith('capacity_exhausted:')));
  assert.equal(automatic.reservation.bucketId, 'account:free-account');

  await activeRun(root, { runId: 'run3', taskId: 'fixed', attemptId: 'fixed-a1' });
  await assert.rejects(
    selectRoute(store(root, [busy, free]), { profile: 'busy' }, { runId: 'run3', taskId: 'fixed', attemptId: 'fixed-a1' }),
    error => error.code === 'route_capacity_exhausted',
  );
});

test('reservations share account buckets and endpoint-host buckets with minimum active limits', async t => {
  const root = await tempRoot(t);
  await activeRun(root, { runId: 'run1', taskId: 'one', attemptId: 'one-a1' });
  await activeRun(root, { runId: 'run2', taskId: 'two', attemptId: 'two-a1' });
  await activeRun(root, { runId: 'run3', taskId: 'three', attemptId: 'three-a1' });

  await reserveExecution(root, profile('alias-a', { account: { id: 'acct', maxParallel: 2 } }), { runId: 'run1', taskId: 'one', attemptId: 'one-a1' });
  await assert.rejects(
    reserveExecution(root, profile('alias-b', { account: { id: 'acct', maxParallel: 1 } }), { runId: 'run2', taskId: 'two', attemptId: 'two-a1' }),
    error => error.code === 'route_capacity_exhausted' && error.details.limit === 1,
  );

  const firstEndpoint = await reserveExecution(root, profile('endpoint-a', { account: null, endpoint: 'https://router.example.test/a', protocol: 'openai-chat' }), { runId: 'run2', taskId: 'two', attemptId: 'two-a1' });
  assert.equal(firstEndpoint.bucketId, 'endpoint:https://router.example.test');
  await assert.rejects(
    reserveExecution(root, profile('endpoint-b', { account: null, endpoint: 'https://router.example.test/b', protocol: 'openai-chat' }), { runId: 'run3', taskId: 'three', attemptId: 'three-a1' }),
    error => error.code === 'route_capacity_exhausted',
  );
});

test('reservations accept long attempt ids and reuse same owner bucket leases without widening limits', async t => {
  const root = await tempRoot(t);
  const longAttemptId = `${'x'.repeat(64)}-a1-${'y'.repeat(16)}`;
  await activeRun(root, { runId: 'run1', taskId: 'task1', attemptId: longAttemptId });

  const first = await reserveExecution(root, profile('primary', { account: { id: 'acct', maxParallel: 2 } }), { runId: 'run1', taskId: 'task1', attemptId: longAttemptId });
  const sameBucketAlias = await reserveExecution(root, profile('fallback', { account: { id: 'acct', maxParallel: 2 } }), { runId: 'run1', taskId: 'task1', attemptId: longAttemptId });
  assert.equal(sameBucketAlias.id, first.id);
  assert.equal((await listReservations(root)).length, 1);

  const widenedAlias = await reserveExecution(root, profile('wider', { account: { id: 'acct', maxParallel: 9 } }), { runId: 'run1', taskId: 'task1', attemptId: longAttemptId });
  assert.equal(widenedAlias.id, first.id);
  assert.equal(widenedAlias.limit, 2);
});

test('same owner bucket reuse fails when a lower limit cannot satisfy active reservations', async t => {
  const root = await tempRoot(t);
  await activeRun(root, { runId: 'run1', taskId: 'one', attemptId: 'one-a1' });
  await activeRun(root, { runId: 'run2', taskId: 'two', attemptId: 'two-a1' });
  await reserveExecution(root, profile('first', { account: { id: 'acct', maxParallel: 2 } }), { runId: 'run1', taskId: 'one', attemptId: 'one-a1' });
  await reserveExecution(root, profile('second', { account: { id: 'acct', maxParallel: 2 } }), { runId: 'run2', taskId: 'two', attemptId: 'two-a1' });

  await assert.rejects(
    reserveExecution(root, profile('lower-alias', { account: { id: 'acct', maxParallel: 1 } }), { runId: 'run1', taskId: 'one', attemptId: 'one-a1' }),
    error => error.code === 'route_capacity_exhausted' && error.details.limit === 1 && error.details.active === 2,
  );
  const reservations = await listReservations(root);
  assert.equal(reservations.length, 2);
  assert.equal(Math.min(...reservations.map(r => r.limit)), 2);
});

test('invalid reservation registry fails closed instead of clearing capacity records', async t => {
  const root = await tempRoot(t);
  await fs.mkdir(path.join(root, 'routing'), { recursive: true });
  await fs.writeFile(path.join(root, 'routing', 'reservations.json'), JSON.stringify({ schemaVersion: 999, reservations: [] }));
  await assert.rejects(
    listReservations(root),
    error => error.code === 'reservation_registry_invalid',
  );
});

test('release is idempotent and listReservations reconciles durable attempt state instead of launcher pid', async t => {
  const root = await tempRoot(t);
  await activeRun(root, { runId: 'run1', taskId: 'live', attemptId: 'live-a1', status: 'running', workerClosed: false });
  const live = await reserveExecution(root, profile('live'), { runId: 'run1', taskId: 'live', attemptId: 'live-a1' });
  assert.equal((await listReservations(root)).length, 1);

  await saveRun(root, {
    schemaVersion: 1,
    id: 'run1',
    project: '/tmp/project',
    tasks: {
      live: {
        definition: { id: 'live' },
        currentAttempt: 'live-a1',
        attempts: [{ id: 'live-a1', taskId: 'live', status: 'interrupted', workerClosed: false, paneId: 'pane-1', launcherPid: 1 }],
      },
    },
  });
  assert.equal((await listReservations(root)).length, 1);

  await saveRun(root, {
    schemaVersion: 1,
    id: 'run1',
    project: '/tmp/project',
    tasks: {
      live: {
        definition: { id: 'live' },
        currentAttempt: 'live-a1',
        attempts: [{ id: 'live-a1', taskId: 'live', status: 'running', workerClosed: true, launcherPid: 1 }],
      },
    },
  });
  assert.deepEqual(await listReservations(root), []);
  await releaseExecution(root, live);
  await releaseExecution(root, live.id);
  assert.deepEqual(await listReservations(root), []);
});

test('missing durable records are reaped before counting capacity', async t => {
  const root = await tempRoot(t);
  await activeRun(root, { runId: 'run1', taskId: 'task', attemptId: 'attempt1' });
  const reservation = await reserveExecution(root, profile('p1'), { runId: 'run1', taskId: 'task', attemptId: 'attempt1' });
  assert.equal(reservation.limit, 1);
  await fs.rm(path.join(root, 'runs', 'run1'), { recursive: true, force: true });
  await activeRun(root, { runId: 'run2', taskId: 'task', attemptId: 'attempt2' });
  const next = await reserveExecution(root, profile('p2', { account: { id: 'p1-acct', maxParallel: 1 } }), { runId: 'run2', taskId: 'task', attemptId: 'attempt2' });
  assert.equal(next.bucketId, 'account:p1-acct');
  assert.equal((await listReservations(root)).length, 1);
});
