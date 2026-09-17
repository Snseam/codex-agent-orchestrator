import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordTaskEvidence, readTaskEvidence, TASK_EVIDENCE_TTL_MS } from '../src/resources/task-evidence.mjs';
import { ResourceService } from '../src/resources/index.mjs';
import { CalibrationStore } from '../src/calibration/store.mjs';
import { PROBE_ENVIRONMENT } from '../src/calibration/environment.mjs';

async function fixture(t, now = Date.parse('2026-09-18T01:00:00.000Z')) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-task-evidence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const state = path.join(root, 'state');
  const bin = path.join(home, 'bin');
  const piConfig = path.join(home, '.pi', 'agent');
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(piConfig, { recursive: true });
  await fs.writeFile(path.join(bin, 'pi'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await fs.writeFile(path.join(piConfig, 'settings.json'), JSON.stringify({ defaultProvider: 'oauth-provider', defaultModel: 'fixture-model' }));
  const resources = new ResourceService({ root: state, home, environment: { HOME: home, PATH: bin }, now: () => now });
  const resource = (await resources.get('native-pi')).id === 'native-pi' ? await resources.get('native-pi') : null;
  return { root, state, home, resources, resource, now };
}

function task() {
  return { id: 'fix-add', checks: [{ name: 'unit', argv: ['node', '--test'] }] };
}

function acceptedAttempt(resource, overrides = {}) {
  const base = Date.parse('2026-09-18T00:59:00.000Z');
  return {
    id: 'attempt-one',
    taskId: 'fix-add',
    executorKind: 'external',
    status: 'accepted',
    submissionAcknowledgedAt: new Date(base + 1000).toISOString(),
    workerClosed: true,
    nativeChildren: { complete: true, state: 'verified' },
    resourceObservation: {
      resourceId: resource.id,
      fingerprint: resource.fingerprint,
      observedAt: new Date(base).toISOString(),
      source: 'execution-config',
      evidenceSource: 'real',
    },
    snapshot: { hash: 'snapshot-hash' },
    verification: {
      attemptId: 'attempt-one',
      snapshotHash: 'snapshot-hash',
      passed: true,
      checks: [{ name: 'unit', status: 'passed', evidence: 'private output' }],
      finishedAt: new Date(base + 2000).toISOString(),
    },
    ...overrides,
  };
}

test('verified external task evidence is private, idempotent, and readable until TTL', async t => {
  const f = await fixture(t);
  const attempt = acceptedAttempt(f.resource);
  const result = await recordTaskEvidence({ root: f.state, runId: 'run-one', task: task(), attempt, now: () => f.now });
  assert.equal(result.recorded, true);
  assert.equal(result.record.source, 'verified-task');
  assert.equal(result.record.suiteId, 'task-delivery');
  assert.equal(result.record.resourceId, f.resource.id);
  assert.equal(result.record.fingerprint, f.resource.fingerprint);
  assert.deepEqual(result.record.verification.checks, [{ name: 'unit', status: 'passed' }]);
  assert.doesNotMatch(JSON.stringify(result.record), /private output|prompt|credentials|servedModel/);

  const duplicate = await recordTaskEvidence({
    root: f.state,
    runId: 'run-one',
    task: task(),
    attempt: acceptedAttempt(f.resource, { snapshot: { hash: 'changed' }, verification: { ...attempt.verification, snapshotHash: 'changed', finishedAt: new Date(f.now).toISOString() } }),
    now: () => f.now,
  });
  assert.equal(duplicate.recorded, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.record.verification.snapshotHash, 'snapshot-hash');
  assert.equal(duplicate.record.observedAt, result.record.observedAt);

  const fresh = await readTaskEvidence({ root: f.state, id: result.record.id, now: () => f.now });
  assert.equal(fresh.fresh, true);
  assert.equal(fresh.reason, 'fresh');
  const expired = await readTaskEvidence({ root: f.state, id: result.record.id, now: () => result.record.observedAt + TASK_EVIDENCE_TTL_MS + 1 });
  assert.equal(expired.fresh, false);
  assert.equal(expired.reason, 'expired');
});

test('task evidence rejects host, mock, failed, unacknowledged, incomplete, stale, and invalid timelines', async t => {
  const f = await fixture(t);
  const base = acceptedAttempt(f.resource);
  for (const [reason, override] of [
    ['not_external_execution', { executorKind: 'host' }],
    ['mock_evidence_source', { resourceObservation: { ...base.resourceObservation, evidenceSource: 'mock' } }],
    ['submission_not_acknowledged', { submissionAcknowledgedAt: null }],
    ['worker_not_closed', { workerClosed: false }],
    ['native_children_incomplete', { nativeChildren: { complete: false } }],
    ['not_accepted', { status: 'submitted' }],
    ['verification_not_passed', { verification: { ...base.verification, passed: false } }],
    ['snapshot_mismatch', { verification: { ...base.verification, snapshotHash: 'other' } }],
    ['verification_checks_missing', { verification: { ...base.verification, checks: [] } }],
    ['verification_checks_failed', { verification: { ...base.verification, checks: [{ name: 'unit', status: 'failed' }] } }],
    ['identity_mismatch', { verification: { ...base.verification, attemptId: 'other' } }],
    ['invalid_timeline', { submissionAcknowledgedAt: new Date(Date.parse(base.verification.finishedAt) + 1).toISOString() }],
    ['deadline_exceeded', { deadlineExceededAt: base.verification.finishedAt }],
    ['cancel_requested', { cancelRequested: true }],
  ]) {
    const result = await recordTaskEvidence({ root: f.state, runId: 'run-one', task: task(), attempt: { ...base, ...override }, now: () => f.now });
    assert.equal(result.recorded, false, reason);
    assert.equal(result.reason, reason);
  }
});

test('ResourceService uses task-delivery evidence for readiness without assigning observed model', async t => {
  const f = await fixture(t);
  const recorded = await recordTaskEvidence({ root: f.state, runId: 'run-one', task: task(), attempt: acceptedAttempt(f.resource), now: () => f.now });
  assert.equal(recorded.recorded, true);
  const ready = await f.resources.get('native-pi');
  assert.equal(ready.callVerification.state, 'verified');
  assert.equal(ready.callVerification.source, 'verified-task');
  assert.equal(ready.callVerification.suite, 'task-delivery');
  assert.equal(ready.observedModel, null);
});

test('ResourceService ignores expired, malformed, mock, and changed-fingerprint task evidence', async t => {
  const f = await fixture(t);
  await recordTaskEvidence({
    root: f.state,
    runId: 'run-one',
    task: task(),
    attempt: acceptedAttempt(f.resource, { verification: { ...acceptedAttempt(f.resource).verification, finishedAt: new Date(f.now - TASK_EVIDENCE_TTL_MS - 1).toISOString() } }),
    now: () => f.now,
  });
  await fs.mkdir(path.join(f.state, 'resources', 'task-evidence'), { recursive: true });
  await fs.writeFile(path.join(f.state, 'resources', 'task-evidence', '0'.repeat(64) + '.json'), '{"source":"mock","prompt":"secret"}');
  await fs.writeFile(path.join(f.state, 'resources', 'task-evidence', '1'.repeat(64) + '.json'), '{"source":"verified-task","prompt":');
  const unknown = await f.resources.get('native-pi');
  assert.equal(unknown.callVerification.state, 'unknown');

  const changed = await recordTaskEvidence({
    root: f.state,
    runId: 'run-two',
    task: task(),
    attempt: acceptedAttempt({ ...f.resource, fingerprint: 'old-fingerprint' }, { id: 'attempt-two', verification: { ...acceptedAttempt(f.resource).verification, attemptId: 'attempt-two' } }),
    now: () => f.now,
  });
  assert.equal(changed.recorded, true);
  assert.equal((await f.resources.get('native-pi')).callVerification.state, 'unknown');
});

test('fresh negative calibration beats only older task evidence and newer task evidence beats old calibration', async t => {
  const f = await fixture(t);
  const taskResult = await recordTaskEvidence({ root: f.state, runId: 'run-one', task: task(), attempt: acceptedAttempt(f.resource), now: () => f.now });
  assert.equal(taskResult.recorded, true);
  const calibration = new CalibrationStore({ root: f.state });
  await calibration.save({
    schemaVersion: 1,
    resourceId: f.resource.id,
    fingerprint: f.resource.fingerprint,
    suiteId: 'quick',
    suiteVersion: '1',
    environmentFingerprint: PROBE_ENVIRONMENT,
    observedAt: f.now - 500,
    expiresAt: f.now + 60_000,
    status: 'failed',
    source: 'real',
    metrics: {},
    checks: [{ id: 'completed-response', passed: false }],
    errorCode: 'probe_failed',
    servedModel: null,
    usageComplete: false,
  });
  const blocked = await f.resources.get('native-pi');
  assert.equal(blocked.callVerification.state, 'unavailable');
  assert.equal(blocked.callVerification.source, 'calibration');

  const next = await fixture(t);
  await new CalibrationStore({ root: next.state }).save({
    schemaVersion: 1,
    resourceId: next.resource.id,
    fingerprint: next.resource.fingerprint,
    suiteId: 'quick',
    suiteVersion: '1',
    environmentFingerprint: PROBE_ENVIRONMENT,
    observedAt: next.now - 120_000,
    expiresAt: next.now + 60_000,
    status: 'failed',
    source: 'real',
    metrics: {},
    checks: [{ id: 'completed-response', passed: false }],
    errorCode: 'old_probe_failed',
    servedModel: null,
    usageComplete: false,
  });
  await recordTaskEvidence({ root: next.state, runId: 'run-one', task: task(), attempt: acceptedAttempt(next.resource), now: () => next.now });
  const selected = await next.resources.get('native-pi');
  assert.equal(selected.callVerification.source, 'verified-task');
  assert.equal(selected.observedModel, null);

  const future = await fixture(t);
  await recordTaskEvidence({ root: future.state, runId: 'run-one', task: task(), attempt: acceptedAttempt(future.resource), now: () => future.now });
  await new CalibrationStore({ root: future.state }).save({
    schemaVersion: 1,
    resourceId: future.resource.id,
    fingerprint: future.resource.fingerprint,
    suiteId: 'quick',
    suiteVersion: '1',
    environmentFingerprint: PROBE_ENVIRONMENT,
    observedAt: future.now + 60_000,
    expiresAt: future.now + 120_000,
    status: 'passed',
    source: 'real',
    metrics: {},
    checks: [{ id: 'completed-response', passed: true }],
    errorCode: null,
    servedModel: 'future-model',
    usageComplete: false,
  });
  const futureSelected = await future.resources.get('native-pi');
  assert.equal(futureSelected.callVerification.source, 'verified-task');
  assert.equal(futureSelected.observedModel, null);
});
