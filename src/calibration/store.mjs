import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CALIBRATION_MAX_RECORD_BYTES, CALIBRATION_TIMEOUT_COOLDOWN_MS, SUITES } from './suites.mjs';
import { withLock, writeJsonAtomic } from '../state.mjs';

const SCHEMA_VERSION = 1;
const STATUSES = new Set(['passed', 'failed', 'unavailable', 'timeout']);
const SOURCES = new Set(['real', 'mock']);
const REQUIRED_KEY_FIELDS = ['resourceId', 'fingerprint', 'suiteId', 'suiteVersion', 'environmentFingerprint'];
const CORE_METRICS = ['wallMs', 'firstEventMs', 'outputTokens', 'tokensPerSecond'];
const RESERVED_METRIC_NAMES = new Set(['price', 'cost', 'thoughtTime', 'thinkingTime']);

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function nullableString(value, label) {
  if (value === null) return null;
  assertString(value, label);
  return value;
}

function assertTimestamp(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer timestamp`);
  }
}

function nullableFiniteNumber(value, label) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite number or null`);
  }
  return value;
}

function keyInput(parts) {
  const selected = {};
  for (const field of REQUIRED_KEY_FIELDS) {
    assertString(parts[field], field);
    selected[field] = parts[field];
  }
  return JSON.stringify(selected);
}

function keyFor(parts) {
  return crypto.createHash('sha256').update(keyInput(parts)).digest('hex');
}

function suiteTtlMs(suiteId, suiteVersion) {
  const suite = SUITES[suiteId];
  return suite?.version === suiteVersion ? suite.ttlMs : null;
}

function boundedExpiresAt(record) {
  const cooldown = record.status === 'timeout' || record.status === 'unavailable';
  const ttl = cooldown ? CALIBRATION_TIMEOUT_COOLDOWN_MS : suiteTtlMs(record.suiteId, record.suiteVersion);
  if (!ttl) return record.expiresAt;
  return Math.min(record.expiresAt, record.observedAt + ttl);
}

function sanitizeMetrics(metrics) {
  assertPlainObject(metrics, 'metrics');
  const sanitized = {};
  for (const field of CORE_METRICS) {
    sanitized[field] = nullableFiniteNumber(metrics[field] ?? null, `metrics.${field}`);
  }
  for (const [key, value] of Object.entries(metrics)) {
    if (CORE_METRICS.includes(key)) continue;
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(key) || RESERVED_METRIC_NAMES.has(key)) {
      throw new TypeError(`metrics.${key} is not allowed`);
    }
    sanitized[key] = nullableFiniteNumber(value, `metrics.${key}`);
  }
  return sanitized;
}

function sanitizeChecks(checks) {
  if (!Array.isArray(checks) || checks.length > 100) {
    throw new TypeError('checks must be an array with at most 100 entries');
  }
  return checks.map((check, index) => {
    assertPlainObject(check, `checks.${index}`);
    assertString(check.id, `checks.${index}.id`);
    if (typeof check.passed !== 'boolean') {
      throw new TypeError(`checks.${index}.passed must be a boolean`);
    }
    return { id: check.id, passed: check.passed };
  });
}

function sanitizeRecord(record, { key } = {}) {
  assertPlainObject(record, 'record');
  for (const field of REQUIRED_KEY_FIELDS) assertString(record[field], field);
  assertTimestamp(record.observedAt, 'observedAt');
  assertTimestamp(record.expiresAt, 'expiresAt');
  if (record.expiresAt < record.observedAt) throw new TypeError('expiresAt precedes observedAt');
  if (record.schemaVersion !== SCHEMA_VERSION) throw new TypeError('schemaVersion must be 1');
  if (!STATUSES.has(record.status)) throw new TypeError('status is not allowed');
  if (!SOURCES.has(record.source)) throw new TypeError('source is not allowed');
  if (typeof record.usageComplete !== 'boolean') throw new TypeError('usageComplete must be a boolean');

  const sanitized = {
    schemaVersion: SCHEMA_VERSION,
    id: record.id === undefined || record.id === null ? key : nullableString(record.id, 'id'),
    resourceId: record.resourceId,
    fingerprint: record.fingerprint,
    suiteId: record.suiteId,
    suiteVersion: record.suiteVersion,
    environmentFingerprint: record.environmentFingerprint,
    observedAt: record.observedAt,
    expiresAt: record.expiresAt,
    status: record.status,
    source: record.source,
    metrics: sanitizeMetrics(record.metrics),
    checks: sanitizeChecks(record.checks),
    errorCode: nullableString(record.errorCode, 'errorCode'),
    servedModel: nullableString(record.servedModel, 'servedModel'),
    usageComplete: record.usageComplete,
  };
  sanitized.expiresAt = boundedExpiresAt(sanitized);
  sanitized.id ??= key;
  return sanitized;
}

function sameKey(record, parts) {
  return REQUIRED_KEY_FIELDS.every(field => record[field] === parts[field]);
}

function freshness(record, parts, now) {
  if (!sameKey(record, parts)) return { fresh: false, reason: 'fingerprint_mismatch' };
  if (record.source === 'mock') return { fresh: false, reason: 'mock_source' };
  if (record.observedAt > now) return { fresh: false, reason: 'future_observation' };
  if (record.expiresAt <= now) return { fresh: false, reason: 'expired' };
  return { fresh: true, reason: 'fresh' };
}

async function readJson(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > CALIBRATION_MAX_RECORD_BYTES) throw new Error('invalid_record_file');
  const text = await fs.readFile(file, 'utf8');
  if (Buffer.byteLength(text) > CALIBRATION_MAX_RECORD_BYTES) {
    throw new Error('record_too_large');
  }
  return JSON.parse(text);
}

export class CalibrationStore {
  constructor({ root, now = Date.now } = {}) {
    assertString(root, 'root');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.root = root;
    this.now = now;
    this.locks = new Map();
  }

  cacheDir() {
    return path.join(this.root, 'calibration');
  }

  recordPath(key) {
    return path.join(this.cacheDir(), `${key}.json`);
  }

  async withKeyLock(key, operation) {
    return withLock(path.join(this.cacheDir(), 'locks', key), operation);
  }

  async read(parts) {
    const key = keyFor(parts);
    const file = this.recordPath(key);
    try {
      const raw = await readJson(file);
      const record = sanitizeRecord(raw, { key });
      const { fresh, reason } = freshness(record, parts, this.now());
      return { record, fresh, reason };
    } catch (error) {
      if (error?.code === 'ENOENT') return { record: null, fresh: false, reason: 'missing' };
      return { record: null, fresh: false, reason: 'invalid_record' };
    }
  }

  async save(record) {
    const key = keyFor(record);
    return this.withKeyLock(key, async () => {
      const sanitized = sanitizeRecord(record, { key });
      const json = `${JSON.stringify(sanitized, null, 2)}\n`;
      if (Buffer.byteLength(json) > CALIBRATION_MAX_RECORD_BYTES) {
        throw new Error('calibration_record_too_large');
      }
      await fs.mkdir(this.cacheDir(), { recursive: true, mode: 0o700 });
      await writeJsonAtomic(this.recordPath(key), sanitized);
      return sanitized;
    });
  }

  async list({ resourceId } = {}) {
    if (resourceId !== undefined) assertString(resourceId, 'resourceId');
    let entries;
    try {
      entries = await fs.readdir(this.cacheDir(), { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }

    const records = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const key = entry.name.slice(0, -5);
      try {
        const raw = await readJson(path.join(this.cacheDir(), entry.name));
        const record = sanitizeRecord(raw, { key });
        if (resourceId === undefined || record.resourceId === resourceId) records.push(record);
      } catch {
        // Ignore malformed cache entries during reports.
      }
    }
    return records.sort((left, right) => left.observedAt - right.observedAt || left.id.localeCompare(right.id));
  }
}

export function calibrationKey(parts) {
  return keyFor(parts);
}
