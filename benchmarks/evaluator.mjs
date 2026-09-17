const OUTCOMES = new Set(['accepted', 'failed', 'timeout', 'unjudged', 'cancelled']);
const MAX_PLANNED_TRIALS = 100_000;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail('invalid_benchmark_input', `${path} must be a non-empty string`);
  if (CONTROL_CHARS.test(value)) fail('invalid_benchmark_input', `${path} must not contain control characters`);
  if (RESERVED_KEYS.has(value)) fail('invalid_benchmark_input', `${path} uses a reserved object key`);
  return value;
}

function requirePositiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('invalid_benchmark_input', `${path} must be a positive safe integer`);
  return value;
}

function asArray(value, path) {
  if (!Array.isArray(value) || value.length === 0) fail('invalid_benchmark_input', `${path} must be a non-empty array`);
  return value;
}

function asOptionalArray(value, path) {
  if (!Array.isArray(value)) fail('invalid_benchmark_input', `${path} must be an array`);
  return value;
}

function identity({ cohortId, taskId, armId, repetition }) {
  return JSON.stringify([cohortId, taskId, armId, repetition]);
}

function pairIdentity({ cohortId, taskId, repetition }) {
  return JSON.stringify([cohortId, taskId, repetition]);
}

function percentileWithIncomplete(trials, p) {
  if (trials.length === 0) return null;
  const rank = Math.ceil(trials.length * p);
  const completed = trials.filter(trial => trial.complete).sort((a, b) => a.durationMs - b.durationMs);
  return completed.length >= rank ? completed[rank - 1].durationMs : null;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function normalizePlan(plan) {
  if (!isObject(plan)) fail('invalid_benchmark_input', 'plan must be an object');
  const schemaVersion = requirePositiveInteger(plan.schemaVersion, 'plan.schemaVersion');
  if (schemaVersion !== 1) fail('unsupported_benchmark_schema', 'Only benchmark schemaVersion 1 is supported');
  const experimentId = requireString(plan.experimentId, 'plan.experimentId');
  const deadlineMs = requirePositiveInteger(plan.deadlineMs, 'plan.deadlineMs');
  const cohorts = asArray(plan.cohorts, 'plan.cohorts').map((cohort, index) => {
    if (!isObject(cohort)) fail('invalid_benchmark_input', `plan.cohorts[${index}] must be an object`);
    const id = requireString(cohort.id, `plan.cohorts[${index}].id`);
    const tasks = asArray(cohort.tasks, `plan.cohorts[${index}].tasks`).map((task, taskIndex) => {
      if (!isObject(task)) fail('invalid_benchmark_input', `plan.cohorts[${index}].tasks[${taskIndex}] must be an object`);
      return { id: requireString(task.id, `plan.cohorts[${index}].tasks[${taskIndex}].id`) };
    });
    return { id, tasks };
  });
  const arms = asArray(plan.arms, 'plan.arms').map((arm, index) => {
    if (!isObject(arm)) fail('invalid_benchmark_input', `plan.arms[${index}] must be an object`);
    return { id: requireString(arm.id, `plan.arms[${index}].id`), label: typeof arm.label === 'string' ? arm.label : arm.id };
  });
  if (arms.length < 2) fail('invalid_benchmark_input', 'plan.arms must include at least two arms for paired evaluation');
  const repetitions = asArray(plan.repetitions, 'plan.repetitions').map((repetition, index) => requirePositiveInteger(repetition, `plan.repetitions[${index}]`));
  for (const [label, values] of [['cohort', cohorts.map(c => c.id)], ['arm', arms.map(a => a.id)], ['repetition', repetitions]]) {
    const seen = new Set();
    for (const value of values) {
      if (seen.has(value)) fail('duplicate_benchmark_identity', `duplicate ${label} id: ${value}`);
      seen.add(value);
    }
  }
  for (const cohort of cohorts) {
    const seenTasks = new Set();
    for (const task of cohort.tasks) {
      if (seenTasks.has(task.id)) fail('duplicate_benchmark_identity', `duplicate task id in cohort ${cohort.id}: ${task.id}`);
      seenTasks.add(task.id);
    }
  }
  const plannedCount = cohorts.reduce((sum, cohort) => sum + cohort.tasks.length * arms.length * repetitions.length, 0);
  if (plannedCount > MAX_PLANNED_TRIALS) fail('benchmark_plan_too_large', `planned trial count ${plannedCount} exceeds limit ${MAX_PLANNED_TRIALS}`);
  return { schemaVersion, experimentId, deadlineMs, cohorts, arms, repetitions, plannedCount };
}

function plannedTrials(plan) {
  const trials = [];
  for (const cohort of plan.cohorts) {
    for (const task of cohort.tasks) {
      for (const repetition of plan.repetitions) {
        for (const arm of plan.arms) {
          trials.push({ cohortId: cohort.id, taskId: task.id, armId: arm.id, repetition });
        }
      }
    }
  }
  return trials;
}

function normalizeResult(raw, index, plan, planned) {
  if (!isObject(raw)) fail('invalid_benchmark_input', `results.trials[${index}] must be an object`);
  const trial = {
    cohortId: requireString(raw.cohortId, `results.trials[${index}].cohortId`),
    taskId: requireString(raw.taskId, `results.trials[${index}].taskId`),
    armId: requireString(raw.armId, `results.trials[${index}].armId`),
    repetition: requirePositiveInteger(raw.repetition, `results.trials[${index}].repetition`),
  };
  const key = identity(trial);
  if (!planned.has(key)) fail('unknown_benchmark_identity', `result does not match the predeclared plan: ${trial.cohortId}/${trial.taskId}/${trial.armId}/${trial.repetition}`);
  const outcome = requireString(raw.outcome, `results.trials[${index}].outcome`);
  if (!OUTCOMES.has(outcome)) fail('invalid_benchmark_input', `unsupported outcome: ${outcome}`);
  const durationMs = raw.durationMs == null ? null : requirePositiveInteger(raw.durationMs, `results.trials[${index}].durationMs`);
  const projectAccepted = raw.projectAcceptance === true || raw.acceptance?.project === true;
  const deadlineExceeded = durationMs != null && durationMs > plan.deadlineMs;
  const userCancelled = outcome === 'cancelled' && raw.cancelledBy === 'user';
  const complete = outcome === 'accepted' && projectAccepted && durationMs != null && !deadlineExceeded;
  const classification = complete ? 'accepted' : deadlineExceeded || outcome === 'timeout' ? 'timeout' : userCancelled ? 'user_cancelled' : outcome === 'accepted' ? 'acceptance_incomplete' : outcome;
  return {
    ...trial,
    key,
    source: 'result',
    outcome,
    classification,
    durationMs,
    complete,
    projectAccepted,
    deadlineExceeded,
    userCancelled,
  };
}

function materializeTrials(plan, results) {
  const planned = new Map(plannedTrials(plan).map(trial => [identity(trial), trial]));
  if (!isObject(results)) fail('invalid_benchmark_input', 'results must be an object');
  const schemaVersion = requirePositiveInteger(results.schemaVersion, 'results.schemaVersion');
  const experimentId = requireString(results.experimentId, 'results.experimentId');
  if (schemaVersion !== plan.schemaVersion) fail('benchmark_experiment_mismatch', `results schemaVersion ${schemaVersion} does not match plan schemaVersion ${plan.schemaVersion}`);
  if (experimentId !== plan.experimentId) fail('benchmark_experiment_mismatch', `results experimentId ${experimentId} does not match plan experimentId ${plan.experimentId}`);
  const rawTrials = asOptionalArray(results.trials, 'results.trials');
  const seen = new Set();
  const actual = new Map();
  rawTrials.forEach((raw, index) => {
    const trial = normalizeResult(raw, index, plan, planned);
    if (seen.has(trial.key)) fail('duplicate_benchmark_identity', `duplicate result trial: ${trial.cohortId}/${trial.taskId}/${trial.armId}/${trial.repetition}`);
    seen.add(trial.key);
    actual.set(trial.key, trial);
  });
  const trials = [];
  for (const [key, base] of planned) {
    trials.push(actual.get(key) ?? {
      ...base,
      key,
      source: 'missing',
      outcome: 'unjudged',
      classification: 'missing',
      durationMs: null,
      complete: false,
      projectAccepted: false,
      deadlineExceeded: false,
      userCancelled: false,
    });
  }
  return trials;
}

function summarizeArm(trials, includeUserCancels) {
  const counted = includeUserCancels ? trials : trials.filter(trial => !trial.userCancelled);
  const completed = counted.filter(trial => trial.complete);
  const byClassification = Object.create(null);
  for (const trial of counted) byClassification[trial.classification] = (byClassification[trial.classification] ?? 0) + 1;
  return {
    denominator: counted.length,
    completed: completed.length,
    projectAcceptanceRate: counted.length ? completed.length / counted.length : null,
    p50TimeToAcceptanceMs: percentileWithIncomplete(counted, 0.5),
    p90TimeToAcceptanceMs: percentileWithIncomplete(counted, 0.9),
    missing: counted.filter(trial => trial.source === 'missing').length,
    byClassification,
  };
}

function compareArms(trials, armA, armB, includeUserCancels) {
  const byPair = new Map();
  for (const trial of trials.filter(t => t.armId === armA || t.armId === armB)) {
    const key = pairIdentity(trial);
    if (!byPair.has(key)) byPair.set(key, {});
    byPair.get(key)[trial.armId] = trial;
  }
  let pairedTotal = 0;
  let plannedPairs = 0;
  let observedMatchedPairs = 0;
  let bothComplete = 0;
  let aOnlyComplete = 0;
  let bOnlyComplete = 0;
  let neitherComplete = 0;
  let missingPairMembers = 0;
  const completedDeltasMs = [];
  for (const pair of byPair.values()) {
    const left = pair[armA];
    const right = pair[armB];
    if (!left || !right) {
      missingPairMembers++;
      continue;
    }
    if (!includeUserCancels && (left.userCancelled || right.userCancelled)) continue;
    plannedPairs++;
    const missingMembers = (left.source === 'missing' ? 1 : 0) + (right.source === 'missing' ? 1 : 0);
    missingPairMembers += missingMembers;
    if (missingMembers === 0) observedMatchedPairs++;
    pairedTotal++;
    if (left.complete && right.complete) {
      bothComplete++;
      completedDeltasMs.push(right.durationMs - left.durationMs);
    } else if (left.complete) aOnlyComplete++;
    else if (right.complete) bOnlyComplete++;
    else neitherComplete++;
  }
  return {
    arms: [armA, armB],
    plannedPairs,
    observedMatchedPairs,
    pairedTotal,
    bothComplete,
    aOnlyComplete,
    bOnlyComplete,
    neitherComplete,
    missingPairMembers,
    medianCompletedPairDeltaMs: median(completedDeltasMs),
    benefitClaim: null,
    claimReason: observedMatchedPairs === 0 ? 'no_observed_matched_trials' : 'statistical_framework_only_no_rollout_claim',
  };
}

function summarizeScope(plan, trials, includeUserCancels) {
  const arms = Object.create(null);
  for (const arm of plan.arms) arms[arm.id] = summarizeArm(trials.filter(trial => trial.armId === arm.id), includeUserCancels);
  const comparisons = [];
  for (let i = 0; i < plan.arms.length; i++) {
    for (let j = i + 1; j < plan.arms.length; j++) comparisons.push(compareArms(trials, plan.arms[i].id, plan.arms[j].id, includeUserCancels));
  }
  return { arms, comparisons };
}

function summarizeSensitivity(plan, trials, includeUserCancels) {
  const cohorts = Object.create(null);
  for (const cohort of plan.cohorts) cohorts[cohort.id] = summarizeScope(plan, trials.filter(trial => trial.cohortId === cohort.id), includeUserCancels);
  return { includeUserCancels, overall: summarizeScope(plan, trials, includeUserCancels), cohorts };
}

export function evaluateBenchmark(planInput, resultsInput) {
  const plan = normalizePlan(planInput);
  const trials = materializeTrials(plan, resultsInput);
  return {
    schemaVersion: 1,
    experimentId: plan.experimentId,
    deadlineMs: plan.deadlineMs,
    trialCount: trials.length,
    sensitivities: {
      userCancelsIncluded: summarizeSensitivity(plan, trials, true),
      userCancelsExcluded: summarizeSensitivity(plan, trials, false),
    },
    rollout: {
      enableAdaptiveByDefault: false,
      reason: 'benchmark_evaluator_reports_statistics_only_real_controlled_data_required',
    },
    trials: trials.map(trial => ({
      cohortId: trial.cohortId,
      taskId: trial.taskId,
      armId: trial.armId,
      repetition: trial.repetition,
      source: trial.source,
      outcome: trial.outcome,
      classification: trial.classification,
      durationMs: trial.durationMs,
      complete: trial.complete,
      projectAccepted: trial.projectAccepted,
    })),
  };
}
