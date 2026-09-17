import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withLock, writeJsonAtomic } from '../state.mjs';

const SCHEMA_VERSION = 1;
const SOURCE = 'verified-task';
const SUITE = 'task-delivery';
const SUITE_VERSION = '1';
const TTL_MS = 15 * 60 * 1000;
const MAX_RECORD_BYTES = 32 * 1024;

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value, max = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
}

function safeIdentifier(value, max = 128) {
  const string = safeString(value, max);
  return string && /^[A-Za-z0-9_.:@/-]+$/.test(string) ? string : null;
}

function parseTime(value) {
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) && time >= 0 ? time : null;
}

function nowMs(now) {
  const value = typeof now === 'function' ? now() : Date.now();
  return Number.isFinite(value) ? value : Date.now();
}

function keyInput(record) {
  return JSON.stringify({
    source: SOURCE,
    runId: record.runId,
    taskId: record.taskId,
    attemptId: record.attemptId,
    resourceId: record.resourceId,
    fingerprint: record.fingerprint,
  });
}

function keyFor(record) {
  return crypto.createHash('sha256').update(keyInput(record)).digest('hex');
}

function cacheDir(root) {
  return path.join(root, 'resources', 'task-evidence');
}

function recordPath(root, key) {
  return path.join(cacheDir(root), `${key}.json`);
}

function resourceKey({ resourceId, fingerprint }) {
  return crypto.createHash('sha256').update(JSON.stringify({ resourceId, fingerprint })).digest('hex');
}

function resourceIndexPath(root, record) {
  return path.join(cacheDir(root), 'by-resource', `${resourceKey(record)}.json`);
}

function passedCheck(check) {
  return check?.status === 'passed' || check?.passed === true;
}

function publicCheck(check, index) {
  return {
    name: safeString(check?.name, 128) || safeString(check?.id, 128) || `check-${index + 1}`,
    status: 'passed',
  };
}

function ineligible(reason) {
  return { recorded: false, reason };
}

function buildRecord({ runId, task, attempt, now }) {
  if (!safeIdentifier(runId)) return ineligible('invalid_run');
  if (!plain(task) || !safeIdentifier(task.id)) return ineligible('invalid_task');
  if (!plain(attempt) || !safeIdentifier(attempt.id) || attempt.taskId !== task.id) return ineligible('identity_mismatch');
  if ((attempt.executorKind || 'external') !== 'external') return ineligible('not_external_execution');
  if (!safeString(attempt.submissionAcknowledgedAt)) return ineligible('submission_not_acknowledged');
  if (attempt.workerClosed !== true) return ineligible('worker_not_closed');
  if (attempt.nativeChildren?.complete !== true) return ineligible('native_children_incomplete');
  if (!['accepted', 'integrated'].includes(attempt.status)) return ineligible('not_accepted');
  if (attempt.cancelRequested === true) return ineligible('cancel_requested');
  if (safeString(attempt.deadlineExceededAt)) return ineligible('deadline_exceeded');

  const observation = attempt.resourceObservation;
  if (!plain(observation)) return ineligible('missing_resource_observation');
  if (observation.source !== 'execution-config') return ineligible('invalid_observation_source');
  if (observation.evidenceSource !== 'real') return ineligible('mock_evidence_source');
  const resourceId = safeIdentifier(observation.resourceId, 256);
  const fingerprint = safeString(observation.fingerprint, 4096);
  if (!resourceId || !fingerprint) return ineligible('invalid_resource_observation');

  const verification = attempt.verification;
  if (!plain(verification) || verification.passed !== true) return ineligible('verification_not_passed');
  if (verification.attemptId !== attempt.id) return ineligible('identity_mismatch');
  if (!safeString(attempt.snapshot?.hash, 256) || verification.snapshotHash !== attempt.snapshot.hash) return ineligible('snapshot_mismatch');
  if (!Array.isArray(verification.checks) || verification.checks.length === 0) return ineligible('verification_checks_missing');
  if (!verification.checks.every(passedCheck)) return ineligible('verification_checks_failed');

  const finishedAt = parseTime(verification.finishedAt);
  const observedAt = parseTime(observation.observedAt);
  const acknowledgedAt = parseTime(attempt.submissionAcknowledgedAt);
  const current = nowMs(now);
  if (finishedAt === null || observedAt === null || acknowledgedAt === null) return ineligible('invalid_timestamp');
  if (finishedAt > current || observedAt > current || acknowledgedAt > current) return ineligible('future_evidence');
  if (observedAt > acknowledgedAt || acknowledgedAt > finishedAt) return ineligible('invalid_timeline');
  const deadlineAt = parseTime(attempt.deadlineAt);
  if (deadlineAt !== null && finishedAt > deadlineAt) return ineligible('deadline_exceeded');
  if (finishedAt + TTL_MS <= current) return ineligible('evidence_expired');

  const record = {
    schemaVersion: SCHEMA_VERSION,
    source: SOURCE,
    suiteId: SUITE,
    suiteVersion: SUITE_VERSION,
    status: 'passed',
    qualityStatus: 'task-delivery',
    runId,
    taskId: task.id,
    attemptId: attempt.id,
    resourceId,
    fingerprint,
    bindingFingerprint: fingerprint,
    bindingObservedAt: observedAt,
    observedAt: finishedAt,
    expiresAt: finishedAt + TTL_MS,
    verification: {
      finishedAt,
      snapshotHash: verification.snapshotHash,
      checks: verification.checks.map(publicCheck),
    },
  };
  record.id = keyFor(record);
  return { recorded: true, record };
}

function sanitizeRecord(input, { key } = {}) {
  if (!plain(input) || input.schemaVersion !== SCHEMA_VERSION || input.source !== SOURCE) throw new Error('invalid_record');
  const record = {
    schemaVersion: SCHEMA_VERSION,
    id: safeString(input.id, 128) || key,
    source: SOURCE,
    suiteId: input.suiteId === SUITE ? SUITE : null,
    suiteVersion: input.suiteVersion === SUITE_VERSION ? SUITE_VERSION : null,
    status: input.status === 'passed' ? 'passed' : null,
    qualityStatus: input.qualityStatus === 'task-delivery' ? 'task-delivery' : null,
    runId: safeIdentifier(input.runId),
    taskId: safeIdentifier(input.taskId),
    attemptId: safeIdentifier(input.attemptId),
    resourceId: safeIdentifier(input.resourceId, 256),
    fingerprint: safeString(input.fingerprint, 4096),
    bindingFingerprint: safeString(input.bindingFingerprint, 4096),
    bindingObservedAt: parseTime(input.bindingObservedAt),
    observedAt: parseTime(input.observedAt),
    expiresAt: parseTime(input.expiresAt),
    verification: plain(input.verification) && Array.isArray(input.verification.checks) && input.verification.checks.length > 0 && input.verification.checks.length <= 100 && input.verification.checks.every(passedCheck) ? {
      finishedAt: parseTime(input.verification.finishedAt),
      snapshotHash: safeString(input.verification.snapshotHash, 256),
      checks: input.verification.checks.map(publicCheck),
    } : null,
  };
  if (!record.id || !record.suiteId || !record.suiteVersion || !record.status || !record.qualityStatus) throw new Error('invalid_record');
  for (const field of ['runId', 'taskId', 'attemptId', 'resourceId', 'fingerprint', 'bindingFingerprint']) {
    if (!record[field]) throw new Error('invalid_record');
  }
  if (record.bindingFingerprint !== record.fingerprint) throw new Error('invalid_record');
  if (![record.bindingObservedAt, record.observedAt, record.expiresAt, record.verification?.finishedAt].every(Number.isFinite)) throw new Error('invalid_record');
  if (record.bindingObservedAt > record.observedAt) throw new Error('invalid_record');
  if (record.expiresAt !== record.observedAt + TTL_MS || record.expiresAt < record.observedAt) throw new Error('invalid_record');
  if (record.verification.finishedAt !== record.observedAt || !record.verification.snapshotHash || !record.verification.checks) throw new Error('invalid_record');
  if (key && record.id !== key) throw new Error('invalid_record');
  if (key && keyFor(record) !== key) throw new Error('invalid_record');
  return record;
}

async function readRawRecord(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD_BYTES) throw new Error('invalid_record_file');
  const text = await fs.readFile(file, 'utf8');
  if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new Error('record_too_large');
  return JSON.parse(text);
}

export async function recordTaskEvidence({ root, runId, task, attempt, now = Date.now } = {}) {
  if (!safeString(root, 4096)) return ineligible('invalid_root');
  const built = buildRecord({ runId, task, attempt, now });
  if (!built.recorded) return built;
  const key = built.record.id;
  const json = `${JSON.stringify(built.record, null, 2)}\n`;
  if (Buffer.byteLength(json) > MAX_RECORD_BYTES) return ineligible('record_too_large');
  return withLock(path.join(cacheDir(root), 'locks', key), async () => {
    try {
      const existing = sanitizeRecord(await readRawRecord(recordPath(root, key)), { key });
      await updateResourceIndex(root, existing);
      return { recorded: true, record: existing, duplicate: true };
    } catch {
      // Malformed or missing entries are replaced by the verified bounded record.
    }
    await fs.mkdir(cacheDir(root), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(recordPath(root, key), built.record);
    await updateResourceIndex(root, built.record);
    return built;
  });
}

async function updateResourceIndex(root, record) {
  const indexKey = resourceKey(record);
  await withLock(path.join(cacheDir(root), 'locks', `resource-${indexKey}`), async () => {
    const file = resourceIndexPath(root, record);
    try {
      const existing = sanitizeRecord(await readRawRecord(file));
      if (existing.observedAt > record.observedAt) return;
      if (existing.observedAt === record.observedAt && existing.id.localeCompare(record.id) >= 0) return;
    } catch {
      // Missing or malformed resource indexes are rebuilt from the bounded record.
    }
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(file, record);
  });
}

export async function readTaskEvidence({ root, id, now = Date.now } = {}) {
  if (!safeString(root, 4096) || !/^[a-f0-9]{64}$/.test(id || '')) return { record: null, fresh: false, reason: 'invalid_id' };
  try {
    const record = sanitizeRecord(await readRawRecord(recordPath(root, id)), { key: id });
    const current = nowMs(now);
    if (record.observedAt > current) return { record, fresh: false, reason: 'future_observation' };
    if (record.expiresAt <= current) return { record, fresh: false, reason: 'expired' };
    return { record, fresh: true, reason: 'fresh' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { record: null, fresh: false, reason: 'missing' };
    return { record: null, fresh: false, reason: 'invalid_record' };
  }
}

export async function readTaskEvidenceForResource({ root, resourceId, fingerprint, now = Date.now } = {}) {
  if (!safeString(root, 4096) || !safeIdentifier(resourceId, 256) || !safeString(fingerprint, 4096)) {
    return { record: null, fresh: false, reason: 'invalid_resource' };
  }
  const key = resourceKey({ resourceId, fingerprint });
  try {
    const record = sanitizeRecord(await readRawRecord(path.join(cacheDir(root), 'by-resource', `${key}.json`)));
    if (record.resourceId !== resourceId || record.fingerprint !== fingerprint) return { record: null, fresh: false, reason: 'fingerprint_mismatch' };
    const current = nowMs(now);
    if (record.observedAt > current) return { record, fresh: false, reason: 'future_observation' };
    if (record.expiresAt <= current) return { record, fresh: false, reason: 'expired' };
    return { record, fresh: true, reason: 'fresh' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { record: null, fresh: false, reason: 'missing' };
    return { record: null, fresh: false, reason: 'invalid_record' };
  }
}

export async function listTaskEvidence({ root, resourceId, now = Date.now, maxRecords = 2048 } = {}) {
  if (!safeString(root, 4096)) return [];
  const current = nowMs(now);
  let entries;
  try {
    entries = await fs.readdir(cacheDir(root), { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  let scanned = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    if (scanned++ >= maxRecords) break;
    const key = entry.name.slice(0, -5);
    try {
      const record = sanitizeRecord(await readRawRecord(path.join(cacheDir(root), entry.name)), { key });
      if (resourceId !== undefined && record.resourceId !== resourceId) continue;
      records.push({
        ...record,
        fresh: record.observedAt <= current && record.expiresAt > current,
        freshnessReason: record.observedAt > current ? 'future_observation' : (record.expiresAt <= current ? 'expired' : 'fresh'),
      });
    } catch {
      // Ignore malformed private cache entries. They must never influence routing.
    }
  }
  return records.sort((left, right) => left.observedAt - right.observedAt || left.id.localeCompare(right.id));
}

export const TASK_EVIDENCE_TTL_MS = TTL_MS;
