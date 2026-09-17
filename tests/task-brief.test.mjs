import assert from 'node:assert/strict';
import test from 'node:test';
import { OrchestratorError } from '../src/errors.mjs';
import { validateBrief, renderBrief } from '../src/task-brief.mjs';
import { taskDigest, validateTask } from '../src/task.mjs';

function validTask(overrides = {}) {
  return {
    id: 'task_1',
    objective: 'Implement the feature',
    allowedPaths: ['src/task.mjs', 'tests/'],
    checks: [{ name: 'unit', argv: ['node', '--test', 'tests/task.test.mjs'] }],
    ...overrides,
  };
}

test('validateBrief normalizes defaults when brief is provided', () => {
  assert.deepEqual(validateBrief({}), {
    version: 1,
    taskKind: 'other',
    risk: 'medium',
    contextRefs: [],
    knownFindings: [],
    nonGoals: [],
    acceptance: [],
    contextDependency: 'low',
    independent: false,
    requiredCapabilities: [],
  });
});

test('validateBrief accepts explicit legal fields', () => {
  assert.deepEqual(
    validateBrief({
      version: 1,
      taskKind: 'bugfix',
      risk: 'high',
      contextRefs: ['src/task.mjs', 'tests/task-brief.test.mjs'],
      knownFindings: ['dispatch prompt currently lacks a compact task summary'],
      nonGoals: ['do not change verifier checks'],
      acceptance: ['worker prompt includes the supplied acceptance notes'],
      contextDependency: 'high',
      independent: false,
      requiredCapabilities: ['node-test', 'repo.read'],
    }),
    {
      version: 1,
      taskKind: 'bugfix',
      risk: 'high',
      contextRefs: ['src/task.mjs', 'tests/task-brief.test.mjs'],
      knownFindings: ['dispatch prompt currently lacks a compact task summary'],
      nonGoals: ['do not change verifier checks'],
      acceptance: ['worker prompt includes the supplied acceptance notes'],
      contextDependency: 'high',
      independent: false,
      requiredCapabilities: ['node-test', 'repo.read'],
    },
  );
});

test('validateBrief rejects malformed schema strictly', () => {
  const cases = [
    null,
    [],
    { extra: true },
    { version: 2 },
    { taskKind: 'cleanup' },
    { risk: 'critical' },
    { contextDependency: 'medium' },
    { independent: 'yes' },
    { knownFindings: [''] },
    { nonGoals: [7] },
    { acceptance: ['x'.repeat(2001)] },
    { requiredCapabilities: ['two words'] },
    { requiredCapabilities: Array.from({ length: 31 }, (_, index) => `cap${index}`) },
  ];

  for (const item of cases) {
    assert.throws(
      () => validateBrief(item),
      (error) => error instanceof OrchestratorError && error.code === 'invalid_task',
    );
  }
});

test('validateBrief rejects absolute traversal git glob and directory context refs', () => {
  const badRefs = [
    '../secret',
    '/tmp/file',
    'src\\file.js',
    'C:/tmp/file',
    'C:\\tmp\\file',
    '//server/share',
    'src/*.js',
    './src/file.js',
    'src//file.js',
    'src/../file.js',
    '.git/config',
    'src/.git/config',
    'src/',
    'x'.repeat(513),
  ];

  for (const ref of badRefs) {
    assert.throws(
      () => validateBrief({ contextRefs: [ref] }),
      (error) => error instanceof OrchestratorError && ['invalid_path', 'invalid_task'].includes(error.code),
    );
  }
});

test('validateBrief enforces serialized size without truncating', () => {
  const largeBrief = {
    knownFindings: Array.from({ length: 17 }, (_, index) => `${index}-`.padEnd(2000, 'x')),
  };

  assert.throws(
    () => validateBrief(largeBrief),
    (error) =>
      error instanceof OrchestratorError &&
      error.code === 'invalid_task' &&
      error.details.field === 'brief' &&
      error.details.actual > 32768,
  );
});

test('validateTask omits absent brief but normalizes explicit brief', () => {
  const base = validateTask(validTask());
  assert.equal(Object.hasOwn(base, 'brief'), false);

  const withBrief = validateTask(validTask({ brief: { taskKind: 'review', acceptance: ['confirm no regressions'] } }));
  assert.equal(withBrief.brief.version, 1);
  assert.equal(withBrief.brief.taskKind, 'review');
  assert.deepEqual(withBrief.brief.acceptance, ['confirm no regressions']);
});

test('taskDigest remains compatible for tasks without brief and changes when brief is explicit', () => {
  const oldShape = validTask();
  const sameOldShape = {
    checks: [{ argv: ['node', '--test', 'tests/task.test.mjs'], name: 'unit' }],
    objective: 'Implement the feature',
    allowedPaths: ['src/task.mjs', 'tests/'],
    id: 'task_1',
  };

  assert.equal(taskDigest(oldShape), taskDigest(sameOldShape));
  assert.notEqual(taskDigest(oldShape), taskDigest(validTask({ brief: {} })));
});

test('renderBrief includes acceptance context and authority boundary note', () => {
  const rendered = renderBrief({
    taskKind: 'feature',
    risk: 'low',
    acceptance: ['mandatory acceptance note survives rendering'],
    contextRefs: ['src/task.mjs'],
  });

  assert.match(rendered, /Acceptance notes:\n- mandatory acceptance note survives rendering/);
  assert.match(rendered, /not tool authority/);
  assert.match(rendered, /does not prove acceptance/);
  assert.match(rendered, /verification checks remain separate/);
});
