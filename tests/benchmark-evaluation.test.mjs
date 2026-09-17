import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluateBenchmark } from '../benchmarks/evaluator.mjs';

function plan(extra = {}) {
  return {
    schemaVersion: 1,
    experimentId: 'example',
    deadlineMs: 1000,
    cohorts: [{ id: 'existing', tasks: [{ id: 'task-a' }, { id: 'task-b' }] }],
    arms: [{ id: 'direct' }, { id: 'adaptive' }],
    repetitions: [1, 2],
    ...extra,
  };
}

function accepted(taskId, armId, repetition, durationMs) {
  return { cohortId: 'existing', taskId, armId, repetition, outcome: 'accepted', projectAcceptance: true, durationMs };
}

test('evaluates planned trials without success-subset percentiles or rollout claims', () => {
  const report = evaluateBenchmark(plan(), {
    schemaVersion: 1,
    experimentId: 'example',
    trials: [
      accepted('task-a', 'direct', 1, 600),
      accepted('task-a', 'adaptive', 1, 500),
      { cohortId: 'existing', taskId: 'task-a', armId: 'direct', repetition: 2, outcome: 'failed', durationMs: 900 },
      accepted('task-a', 'adaptive', 2, 700),
      { cohortId: 'existing', taskId: 'task-b', armId: 'direct', repetition: 1, outcome: 'timeout', durationMs: 1200 },
      { cohortId: 'existing', taskId: 'task-b', armId: 'adaptive', repetition: 1, outcome: 'cancelled', cancelledBy: 'user', durationMs: 100 },
    ],
  });

  assert.equal(report.trialCount, 8);
  assert.equal(report.rollout.enableAdaptiveByDefault, false);
  const included = report.sensitivities.userCancelsIncluded.overall;
  assert.equal(included.arms.direct.denominator, 4);
  assert.equal(included.arms.direct.completed, 1);
  assert.equal(included.arms.direct.p50TimeToAcceptanceMs, null);
  assert.equal(included.arms.adaptive.denominator, 4);
  assert.equal(included.arms.adaptive.completed, 2);
  assert.equal(included.arms.adaptive.p50TimeToAcceptanceMs, 700);
  assert.equal(included.arms.adaptive.p90TimeToAcceptanceMs, null);
  assert.equal(included.arms.adaptive.missing, 1);
  assert.equal(included.comparisons[0].pairedTotal, 4);
  assert.equal(included.comparisons[0].plannedPairs, 4);
  assert.equal(included.comparisons[0].observedMatchedPairs, 3);
  assert.equal(included.comparisons[0].missingPairMembers, 2);
  assert.equal(included.comparisons[0].benefitClaim, null);
  assert.equal(included.comparisons[0].bothComplete, 1);
  assert.equal(report.sensitivities.userCancelsIncluded.cohorts.existing.arms.adaptive.denominator, 4);

  const excluded = report.sensitivities.userCancelsExcluded.overall;
  assert.equal(excluded.arms.adaptive.denominator, 3);
  assert.equal(excluded.comparisons[0].pairedTotal, 3);
});

test('deadline overflow and missing project acceptance are not complete', () => {
  const report = evaluateBenchmark(plan({ cohorts: [{ id: 'existing', tasks: [{ id: 'task-a' }] }], repetitions: [1] }), {
    schemaVersion: 1,
    experimentId: 'example',
    trials: [
      accepted('task-a', 'direct', 1, 1001),
      { cohortId: 'existing', taskId: 'task-a', armId: 'adaptive', repetition: 1, outcome: 'accepted', projectAcceptance: false, durationMs: 300 },
    ],
  });

  assert.equal(report.sensitivities.userCancelsIncluded.overall.arms.direct.completed, 0);
  assert.equal(report.sensitivities.userCancelsIncluded.overall.arms.direct.byClassification.timeout, 1);
  assert.equal(report.sensitivities.userCancelsIncluded.overall.arms.adaptive.completed, 0);
  assert.equal(report.sensitivities.userCancelsIncluded.overall.arms.adaptive.byClassification.acceptance_incomplete, 1);
});

test('empty results count every planned trial as missing', () => {
  const report = evaluateBenchmark(plan({ cohorts: [{ id: 'existing', tasks: [{ id: 'task-a' }] }], repetitions: [1] }), { schemaVersion: 1, experimentId: 'example', trials: [] });
  assert.equal(report.trialCount, 2);
  assert.equal(report.sensitivities.userCancelsIncluded.overall.arms.direct.denominator, 1);
  assert.equal(report.sensitivities.userCancelsIncluded.overall.arms.direct.missing, 1);
  assert.equal(report.sensitivities.userCancelsIncluded.overall.arms.adaptive.missing, 1);
});

test('rejects duplicate unknown and unpaired experiment identities', () => {
  assert.throws(
    () => evaluateBenchmark(plan({ cohorts: [{ id: 'existing', tasks: [{ id: 'task-a' }] }], repetitions: [1] }), {
      schemaVersion: 1,
      experimentId: 'example',
      trials: [accepted('task-a', 'direct', 1, 100), accepted('task-a', 'direct', 1, 200)],
    }),
    error => error.code === 'duplicate_benchmark_identity',
  );
  assert.throws(
    () => evaluateBenchmark(plan({ cohorts: [{ id: 'existing', tasks: [{ id: 'task-a' }] }], repetitions: [1] }), {
      schemaVersion: 1,
      experimentId: 'example',
      trials: [accepted('not-planned', 'direct', 1, 100)],
    }),
    error => error.code === 'unknown_benchmark_identity',
  );
  assert.throws(
    () => evaluateBenchmark(plan({ arms: [{ id: 'direct' }] }), { trials: [] }),
    error => error.code === 'invalid_benchmark_input',
  );
});

test('rejects mismatched experiments unsafe ids and oversized plans', () => {
  assert.throws(
    () => evaluateBenchmark(plan({ schemaVersion: 2 }), { schemaVersion: 2, experimentId: 'example', trials: [] }),
    error => error.code === 'unsupported_benchmark_schema',
  );
  assert.throws(
    () => evaluateBenchmark(plan(), { schemaVersion: 1, experimentId: 'other', trials: [] }),
    error => error.code === 'benchmark_experiment_mismatch',
  );
  assert.throws(
    () => evaluateBenchmark(plan({ arms: [{ id: '__proto__' }, { id: 'adaptive' }] }), { schemaVersion: 1, experimentId: 'example', trials: [] }),
    error => error.code === 'invalid_benchmark_input',
  );
  assert.throws(
    () => evaluateBenchmark(plan({ repetitions: Array.from({ length: 100001 }, (_, index) => index + 1) }), { schemaVersion: 1, experimentId: 'example', trials: [] }),
    error => error.code === 'benchmark_plan_too_large',
  );
});

test('CLI evaluates JSON files', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-benchmark-eval-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const planFile = path.join(directory, 'plan.json');
  const resultsFile = path.join(directory, 'results.json');
  await fs.writeFile(planFile, JSON.stringify(plan({ cohorts: [{ id: 'existing', tasks: [{ id: 'task-a' }] }], repetitions: [1] })));
  await fs.writeFile(resultsFile, JSON.stringify({ schemaVersion: 1, experimentId: 'example', trials: [accepted('task-a', 'direct', 1, 100), accepted('task-a', 'adaptive', 1, 90)] }));

  const result = spawnSync(process.execPath, ['benchmarks/evaluate.mjs', planFile, resultsFile], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.experimentId, 'example');
  assert.equal(report.sensitivities.userCancelsIncluded.overall.arms.adaptive.p90TimeToAcceptanceMs, 90);
});
