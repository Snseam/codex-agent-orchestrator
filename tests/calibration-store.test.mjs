import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CalibrationStore, calibrationKey } from '../src/calibration/store.mjs';
import { CALIBRATION_TIMEOUT_COOLDOWN_MS, SUITES } from '../src/calibration/suites.mjs';

async function temporaryStore(now = () => 1_000_000) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-calibration-'));
  return { root, store: new CalibrationStore({ root, now }), remove: () => fs.rm(root, { recursive: true, force: true }) };
}

function record(overrides = {}) {
  return {
    schemaVersion: 1,
    resourceId: 'model:gpt-test',
    fingerprint: 'model-fingerprint',
    suiteId: SUITES.quick.id,
    suiteVersion: SUITES.quick.version,
    environmentFingerprint: 'darwin-arm64-node22',
    observedAt: 1_000_000,
    expiresAt: 1_000_000 + SUITES.quick.ttlMs,
    status: 'passed',
    source: 'real',
    metrics: {
      wallMs: 1000,
      firstEventMs: null,
      outputTokens: 20,
      tokensPerSecond: 10,
    },
    checks: [{ id: 'canary', passed: true }],
    errorCode: null,
    servedModel: 'gpt-test',
    usageComplete: true,
    ...overrides,
  };
}

test('saved evidence reads fresh until its exact fingerprint expires', async () => {
  const env = await temporaryStore(() => 1_000_001);
  try {
    const saved = await env.store.save(record());
    assert.equal(saved.id, calibrationKey(record()));

    const hit = await env.store.read(record());
    assert.equal(hit.fresh, true);
    assert.equal(hit.reason, 'fresh');
    assert.deepEqual(hit.record, saved);

    const miss = await env.store.read({ ...record(), fingerprint: 'new-fingerprint' });
    assert.equal(miss.record, null);
    assert.equal(miss.fresh, false);
    assert.equal(miss.reason, 'missing');
  } finally {
    await env.remove();
  }
});

test('suite and cooldown TTLs bound validity', async () => {
  const env = await temporaryStore(() => 1_000_000 + SUITES.quick.ttlMs + 1);
  try {
    const saved = await env.store.save(record({ expiresAt: 1_000_000 + SUITES.quick.ttlMs * 10 }));
    assert.equal(saved.expiresAt, 1_000_000 + SUITES.quick.ttlMs);
    const expired = await env.store.read(record());
    assert.equal(expired.fresh, false);
    assert.equal(expired.reason, 'expired');

    const timeout = await env.store.save(record({
      fingerprint: 'timeout-fingerprint',
      status: 'timeout',
      expiresAt: 1_000_000 + SUITES.quick.ttlMs,
      errorCode: 'calibration_timeout',
    }));
    assert.equal(timeout.expiresAt, 1_000_000 + CALIBRATION_TIMEOUT_COOLDOWN_MS);
  } finally {
    await env.remove();
  }
});

test('unknown metrics are preserved without price or thought-time inference fields', async () => {
  const env = await temporaryStore();
  try {
    const saved = await env.store.save(record({
      metrics: {
        wallMs: 1000,
        firstEventMs: 100,
        outputTokens: 20,
        tokensPerSecond: 10,
        queueMs: 50,
      },
    }));
    assert.equal(saved.metrics.queueMs, 50);
    await assert.rejects(
      env.store.save(record({ fingerprint: 'bad-metric', metrics: { wallMs: null, firstEventMs: null, outputTokens: null, tokensPerSecond: null, price: 1 } })),
      /metrics\.price/,
    );
    await assert.rejects(
      env.store.save(record({ fingerprint: 'bad-thought', metrics: { wallMs: null, firstEventMs: null, outputTokens: null, tokensPerSecond: null, thoughtTime: 1 } })),
      /metrics\.thoughtTime/,
    );
  } finally {
    await env.remove();
  }
});

test('malformed JSON and oversized entries do not leak raw cache contents', async () => {
  const env = await temporaryStore();
  try {
    await fs.mkdir(path.join(env.root, 'calibration'), { recursive: true });
    await fs.writeFile(path.join(env.root, 'calibration', `${calibrationKey(record())}.json`), '{"prompt":"secret prompt","answer":');
    const result = await env.store.read(record());
    assert.deepEqual(result, { record: null, fresh: false, reason: 'invalid_record' });
    assert.equal(JSON.stringify(result).includes('secret prompt'), false);

    const largeMetrics = Object.fromEntries(Array.from({ length: 4000 }, (_, index) => [`m${index}`, index]));
    await assert.rejects(
      env.store.save(record({ fingerprint: 'large-record', metrics: { ...record().metrics, ...largeMetrics } })),
      /calibration_record_too_large/,
    );
  } finally {
    await env.remove();
  }
});

test('field whitelist removes prompts, answers, credentials, and check details', async () => {
  const env = await temporaryStore();
  try {
    const saved = await env.store.save(record({
      prompt: 'do not store',
      answer: 'do not store',
      credentials: { token: 'secret' },
      checks: [{ id: 'canary', passed: true, output: 'secret output' }],
    }));
    assert.deepEqual(Object.keys(saved).sort(), [
      'checks',
      'environmentFingerprint',
      'errorCode',
      'expiresAt',
      'fingerprint',
      'id',
      'metrics',
      'observedAt',
      'resourceId',
      'schemaVersion',
      'servedModel',
      'source',
      'status',
      'suiteId',
      'suiteVersion',
      'usageComplete',
    ].sort());
    assert.deepEqual(saved.checks, [{ id: 'canary', passed: true }]);
    assert.equal(JSON.stringify(saved).includes('do not store'), false);
    assert.equal(JSON.stringify(saved).includes('secret'), false);
  } finally {
    await env.remove();
  }
});

test('concurrent saves for the same evidence key leave one valid sanitized record', async () => {
  const env = await temporaryStore();
  try {
    const [first, second] = await Promise.all([
      env.store.save(record({ observedAt: 1_000_001, expiresAt: 1_000_001 + SUITES.quick.ttlMs, checks: [{ id: 'first', passed: true }] })),
      env.store.save(record({ observedAt: 1_000_002, expiresAt: 1_000_002 + SUITES.quick.ttlMs, checks: [{ id: 'second', passed: true }] })),
    ]);
    const read = await env.store.read(record());
    assert.equal(read.record.id, first.id);
    assert.equal(read.record.id, second.id);
    assert.ok(['first', 'second'].includes(read.record.checks[0].id));
  } finally {
    await env.remove();
  }
});

test('mock evidence is listed but never fresh for the real cache', async () => {
  const env = await temporaryStore(() => 1_000_001);
  try {
    await env.store.save(record({ source: 'mock' }));
    const read = await env.store.read(record());
    assert.equal(read.record.source, 'mock');
    assert.equal(read.fresh, false);
    assert.equal(read.reason, 'mock_source');

    const listed = await env.store.list({ resourceId: 'model:gpt-test' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].source, 'mock');
  } finally {
    await env.remove();
  }
});
