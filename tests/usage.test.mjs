import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageService, formatUsageTable, validateUsageOptions } from '../src/usage.mjs';
import { createRun } from '../src/state.mjs';

class FakeTokscale {
  constructor(entriesByClient = {}, { version = { version: '4.16.0', testedVersion: '4.16.0', supportedRange: '>=4.16.0 <5' }, reportsByClient = {} } = {}) {
    this.entriesByClient = entriesByClient;
    this.reportsByClient = reportsByClient;
    this.versionValue = version;
    this.calls = [];
  }

  async version() {
    this.calls.push({ method: 'version' });
    return this.versionValue;
  }

  async models(options) {
    this.calls.push({ method: 'models', options });
    const clients = options.clients || [];
    const reports = clients.map(client => this.reportsByClient[client]).filter(Boolean);
    const entries = reports.length
      ? reports.flatMap(report => report.entries || [])
      : clients.flatMap(client => this.entriesByClient[client] || []);
    return {
      entries,
      totals: {},
      warnings: reports.flatMap(report => report.warnings || []),
      diagnostics: reports.flatMap(report => report.diagnostics || []),
    };
  }
}

async function stateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'cao-usage-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function entry(client, model, tokens = {}, extra = {}) {
  return {
    client,
    provider: extra.provider ?? `${client}-provider`,
    model,
    workspaceKey: extra.workspaceKey,
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    cacheRead: tokens.cacheRead ?? 0,
    cacheWrite: tokens.cacheWrite ?? 0,
    reasoning: tokens.reasoning ?? 0,
    messageCount: tokens.messages ?? 0,
  };
}

function runRecord(id, tasks) {
  return {
    schemaVersion: 1,
    id,
    project: '/cao/project',
    baseCommit: '0'.repeat(40),
    baseline: { hash: 'baseline', files: {} },
    initiallyDirty: false,
    herdrSession: `session-${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    maxParallel: 4,
    server: null,
    tasks: Object.fromEntries(tasks.map(task => [task.definition.id, task])),
  };
}

function taskRecord({ id, agent = 'claude', isolation = 'worktree', cwd, attempts = [cwd], attemptAgents = [] }) {
  return {
    definition: {
      id,
      objective: `Synthetic ${id}`,
      agent,
      role: 'implementer',
      allowedPaths: ['src/example.mjs'],
      checks: [{ name: 'ok', argv: ['node', '--version'], timeoutMs: 10000 }],
      isolation,
      agentArgs: [],
      nativeInstructions: '',
      maxChildren: 0,
      maxAttempts: 3,
      dependsOn: [],
    },
    digest: `${id}-digest`,
    currentAttempt: `${id}-a1`,
    attempts: attempts.map((attemptCwd, index) => ({
      id: `${id}-a${index + 1}`,
      taskId: id,
      number: index + 1,
      cwd: attemptCwd,
      status: 'accepted',
      ...(attemptAgents[index] ? { execution: { agent: attemptAgents[index] } } : {}),
    })),
  };
}

const home = '/usage-home';

test('machine query sums five token buckets and forwards model, agent, and date filters', async () => {
  const tokscale = new FakeTokscale({
    claude: [
      entry('claude', 'model-a', { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5, messages: 6 }),
      entry('claude', 'model-b', { input: 100 }),
    ],
    codex: [
      entry('codex', 'model-a', { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 50, messages: 60 }),
    ],
  });
  const service = new UsageService({ stateRoot: '/unused-state', tokscale, now: () => new Date('2026-02-03T12:00:00Z') });

  const report = await service.query({ agent: 'claude,codex', model: 'model-a', since: '2026-02-01', until: '2026-02-03', home });

  assert.equal(report.scope.type, 'machine');
  assert.equal(report.attribution.exactTaskAttribution, false);
  assert.equal(report.rows.length, 2);
  assert.deepEqual(report.totals, {
    input: 11,
    output: 22,
    cacheRead: 33,
    cacheWrite: 44,
    reasoning: 55,
    totalTokens: 165,
    messages: 66,
  });
  assert.deepEqual(tokscale.calls.find(call => call.method === 'models').options, {
    home,
    since: '2026-02-01',
    until: '2026-02-03',
    clients: ['claude', 'codex'],
    groupBy: 'client,provider,model',
  });
});

test('invalid dates and conflicting day filters fail before calling Tokscale', async () => {
  const tokscale = new FakeTokscale();
  const service = new UsageService({ stateRoot: '/unused-state', tokscale });

  await assert.rejects(service.query({ since: '2026-02-30', home }), error => error.code === 'invalid_arguments');
  await assert.rejects(service.query({ today: true, since: '2026-02-01', home }), error => error.code === 'invalid_arguments');
  assert.deepEqual(tokscale.calls, []);

  assert.equal(validateUsageOptions({ today: true, home }, new Date('2026-05-06T12:00:00Z')).since, '2026-05-06');
});

test('run and task scoped usage matches exact workspace paths and Claude slugs without exact task attribution', async t => {
  const root = await stateRoot(t);
  const claudeCwd = '/cao/workspaces/claude task';
  const codexCwd = '/cao/workspaces/codex-task';
  await createRun(root, runRecord('run-scope', [
    taskRecord({ id: 'claude-task', agent: 'claude', cwd: claudeCwd }),
    taskRecord({ id: 'codex-task', agent: 'codex', cwd: codexCwd }),
  ]));
  const tokscale = new FakeTokscale({
    claude: [entry('claude', 'opus', { input: 7, output: 8, messages: 1 }, { workspaceKey: '-cao-workspaces-claude-task' })],
    codex: [entry('codex', 'gpt', { input: 70, output: 80, messages: 10 }, { workspaceKey: codexCwd })],
  });
  const service = new UsageService({ stateRoot: root, tokscale });

  const runReport = await service.query({ run: 'run-scope', home });
  assert.equal(runReport.scope.type, 'run');
  assert.equal(runReport.attribution.exactTaskAttribution, false);
  assert.equal(runReport.attribution.completeWorkspaceCoverage, true);
  assert.deepEqual(runReport.rows.map(row => row.taskIds), [['claude-task'], ['codex-task']]);
  assert.equal(runReport.totals.totalTokens, 165);

  const taskReport = await service.query({ run: 'run-scope', task: 'claude-task', home });
  assert.equal(taskReport.scope.type, 'task');
  assert.equal(taskReport.rows.length, 1);
  assert.equal(taskReport.rows[0].agent, 'claude');
  assert.equal(taskReport.totals.totalTokens, 15);
});

test('auto task without a launched execution agent is reported as unavailable instead of invalid', async t => {
  const root = await stateRoot(t);
  await createRun(root, runRecord('run-auto-unstarted', [
    taskRecord({ id: 'auto-pending', agent: 'auto', cwd: null, attempts: [null] }),
  ]));
  const tokscale = new FakeTokscale({});
  const service = new UsageService({ stateRoot: root, tokscale });

  const report = await service.query({ run: 'run-auto-unstarted', home });
  assert.equal(report.status, 'unattributable');
  assert.equal(report.rows.length, 0);
  assert.deepEqual(report.coverage, [{
    taskId: 'auto-pending',
    agent: 'auto',
    status: 'workspace_unavailable',
    attempts: 1,
    expectedWorkspaces: 0,
    matchedWorkspaces: 0,
  }]);
  assert.deepEqual(tokscale.calls.filter(call => call.method === 'models'), []);

  const filtered = await service.query({ run: 'run-auto-unstarted', agent: 'codex', home });
  assert.equal(filtered.status, 'no_matching_tasks');
  assert.deepEqual(filtered.coverage, []);
});

test('auto task retry attribution uses each attempt execution agent and keeps same workspace split by agent', async t => {
  const root = await stateRoot(t);
  const cwd = '/cao/workspaces/auto-same-cwd';
  await createRun(root, runRecord('run-auto-retry-agent', [
    taskRecord({ id: 'auto-retry-agent', agent: 'auto', cwd, attempts: [cwd, cwd], attemptAgents: ['codex', 'claude'] }),
  ]));
  const tokscale = new FakeTokscale({
    codex: [entry('codex', 'gpt', { input: 2, output: 3, messages: 1 }, { workspaceKey: cwd })],
    claude: [entry('claude', 'opus', { input: 7, output: 8, messages: 1 }, { workspaceKey: '-cao-workspaces-auto-same-cwd' })],
  });
  const service = new UsageService({ stateRoot: root, tokscale });

  const report = await service.query({ run: 'run-auto-retry-agent', task: 'auto-retry-agent', home });
  assert.equal(report.status, 'ok');
  assert.deepEqual(report.rows.map(row => [row.agent, row.taskIds, row.totalTokens]), [
    ['claude', ['auto-retry-agent'], 15],
    ['codex', ['auto-retry-agent'], 5],
  ]);
  assert.deepEqual(report.coverage, [{
    taskId: 'auto-retry-agent',
    agent: 'multiple',
    status: 'workspace_matched',
    attempts: 2,
    expectedWorkspaces: 2,
    matchedWorkspaces: 2,
  }]);
  assert.equal(report.totals.totalTokens, 20);

  const codexOnly = await service.query({ run: 'run-auto-retry-agent', task: 'auto-retry-agent', agent: 'codex', home });
  assert.equal(codexOnly.status, 'ok');
  assert.deepEqual(codexOnly.rows.map(row => row.agent), ['codex']);
  assert.equal(codexOnly.totals.totalTokens, 5);
  assert.deepEqual(codexOnly.coverage, [{
    taskId: 'auto-retry-agent',
    agent: 'codex',
    status: 'workspace_matched',
    attempts: 2,
    expectedWorkspaces: 1,
    matchedWorkspaces: 1,
  }]);
});

test('reused worktree attempts count a workspace only once', async t => {
  const root = await stateRoot(t);
  const cwd = '/cao/workspaces/retry-reused';
  await createRun(root, runRecord('run-retry', [
    taskRecord({ id: 'retry-task', agent: 'codex', cwd, attempts: [cwd, cwd] }),
  ]));
  const tokscale = new FakeTokscale({
    codex: [entry('codex', 'gpt', { input: 2, output: 3, messages: 1 }, { workspaceKey: cwd })],
  });
  const service = new UsageService({ stateRoot: root, tokscale });

  const report = await service.query({ run: 'run-retry', task: 'retry-task', home });
  assert.equal(report.rows.length, 1);
  assert.equal(report.totals.totalTokens, 5);
  assert.deepEqual(report.coverage, [{ taskId: 'retry-task', agent: 'codex', status: 'workspace_matched', attempts: 2, expectedWorkspaces: 1, matchedWorkspaces: 1 }]);
});

test('one task with two worktree cwd values is partial when only one workspace matches', async t => {
  const root = await stateRoot(t);
  const first = '/cao/workspaces/two-cwds-first';
  const second = '/cao/workspaces/two-cwds-second';
  await createRun(root, runRecord('run-two-cwds', [
    taskRecord({ id: 'two-cwds-task', agent: 'opencode', cwd: first, attempts: [first, second] }),
  ]));
  const tokscale = new FakeTokscale({
    opencode: [entry('opencode', 'open-model', { input: 5, output: 6, messages: 1 }, { workspaceKey: first })],
  });
  const service = new UsageService({ stateRoot: root, tokscale });

  const report = await service.query({ run: 'run-two-cwds', task: 'two-cwds-task', home });
  assert.equal(report.status, 'partial');
  assert.equal(report.totals, null);
  assert.equal(report.matchedTotals.totalTokens, 11);
  assert.deepEqual(report.coverage, [{
    taskId: 'two-cwds-task',
    agent: 'opencode',
    status: 'partial_workspace_match',
    attempts: 2,
    expectedWorkspaces: 2,
    matchedWorkspaces: 1,
  }]);
});

test('one Claude task with two cwd values that encode to the same slug is ambiguous and incomplete', async t => {
  const root = await stateRoot(t);
  const first = '/cao/workspaces/collide one';
  const second = '/cao/workspaces/collide-one';
  await createRun(root, runRecord('run-claude-collision', [
    taskRecord({ id: 'slug-collision', agent: 'claude', cwd: first, attempts: [first, second] }),
  ]));
  const tokscale = new FakeTokscale({
    claude: [entry('claude', 'opus', { input: 8, output: 2, messages: 1 }, { workspaceKey: '-cao-workspaces-collide-one' })],
  });
  const service = new UsageService({ stateRoot: root, tokscale });

  const report = await service.query({ run: 'run-claude-collision', task: 'slug-collision', home });
  assert.equal(report.status, 'unattributable');
  assert.equal(report.attribution.completeWorkspaceCoverage, false);
  assert.equal(report.rows.length, 0);
  assert.equal(report.totals, null);
  assert.equal(report.ambiguousWorkspaces.length, 1);
  assert.deepEqual(report.ambiguousWorkspaces[0].taskIds, ['slug-collision']);
  assert.deepEqual(report.coverage, [{
    taskId: 'slug-collision',
    agent: 'claude',
    status: 'no_matching_records',
    attempts: 2,
    expectedWorkspaces: 2,
    matchedWorkspaces: 0,
  }]);
});

test('checkout workspace observations are separated from attributed totals', async t => {
  const root = await stateRoot(t);
  const cwd = '/cao/shared-checkout';
  await createRun(root, runRecord('run-checkout', [
    taskRecord({ id: 'checkout-task', agent: 'claude', isolation: 'checkout', cwd }),
  ]));
  const tokscale = new FakeTokscale({
    claude: [entry('claude', 'opus', { input: 9, output: 1, messages: 2 }, { workspaceKey: '-cao-shared-checkout' })],
  });
  const service = new UsageService({ stateRoot: root, tokscale });

  const report = await service.query({ run: 'run-checkout', task: 'checkout-task', home });
  assert.equal(report.status, 'unattributable');
  assert.equal(report.totals, null);
  assert.equal(report.matchedTotals.totalTokens, 0);
  assert.equal(report.sharedWorkspaces.length, 1);
  assert.equal(report.sharedWorkspaces[0].totalTokens, 10);
  assert.equal(report.coverage[0].status, 'shared_checkout');
});

test('incomplete run coverage reports null totals and separate matchedTotals', async t => {
  const root = await stateRoot(t);
  const matchedCwd = '/cao/workspaces/matched';
  await createRun(root, runRecord('run-partial', [
    taskRecord({ id: 'matched-task', agent: 'codex', cwd: matchedCwd }),
    taskRecord({ id: 'missing-task', agent: 'codex', cwd: '/cao/workspaces/missing' }),
  ]));
  const tokscale = new FakeTokscale({
    codex: [entry('codex', 'gpt', { input: 4, output: 6, messages: 1 }, { workspaceKey: matchedCwd })],
  });
  const service = new UsageService({ stateRoot: root, tokscale });

  const report = await service.query({ run: 'run-partial', home });
  assert.equal(report.status, 'partial');
  assert.equal(report.totals, null);
  assert.equal(report.matchedTotals.totalTokens, 10);
  assert.deepEqual(report.coverage.map(item => [item.taskId, item.status]), [
    ['matched-task', 'workspace_matched'],
    ['missing-task', 'no_matching_records'],
  ]);
});

test('ambiguous same-key workspaces are excluded from attribution', async t => {
  const root = await stateRoot(t);
  const cwd = '/cao/workspaces/shared-key';
  await createRun(root, runRecord('run-ambiguous', [
    taskRecord({ id: 'first-task', agent: 'pi', cwd }),
    taskRecord({ id: 'second-task', agent: 'pi', cwd }),
  ]));
  const tokscale = new FakeTokscale({
    pi: [entry('pi', 'pi-model', { input: 12, output: 3, messages: 2 }, { workspaceKey: cwd })],
  });
  const service = new UsageService({ stateRoot: root, tokscale });

  const report = await service.query({ run: 'run-ambiguous', home });
  assert.equal(report.status, 'unattributable');
  assert.equal(report.totals, null);
  assert.equal(report.rows.length, 0);
  assert.equal(report.ambiguousWorkspaces.length, 1);
  assert.deepEqual(report.ambiguousWorkspaces[0].taskIds, ['first-task', 'second-task']);
});

test('source warning count ignores info diagnostics and counts warnings and errors', async () => {
  const tokscale = new FakeTokscale({}, {
    reportsByClient: {
      claude: {
        entries: [entry('claude', 'model-a', { input: 1 })],
        warnings: ['warning from native report'],
        diagnostics: [
          { severity: 'info', message: 'informational only' },
          { severity: 'warning', message: 'warning diagnostic' },
          { severity: 'error', message: 'error diagnostic' },
        ],
      },
    },
  });
  const service = new UsageService({ stateRoot: '/unused-state', tokscale });

  const report = await service.query({ agent: 'claude', home });
  assert.equal(report.sourceWarningCount, 3);
});

test('unknown run and task are reported with typed errors', async t => {
  const root = await stateRoot(t);
  await createRun(root, runRecord('known-run', [
    taskRecord({ id: 'known-task', agent: 'codex', cwd: '/cao/workspaces/known' }),
  ]));
  const service = new UsageService({ stateRoot: root, tokscale: new FakeTokscale() });

  await assert.rejects(service.query({ run: 'missing-run', home }), error => error.code === 'run_not_found');
  await assert.rejects(service.query({ run: 'known-run', task: 'missing-task', home }), error => error.code === 'task_not_found');
});

test('unsafe and overflowing token counters are rejected', async () => {
  const invalid = new UsageService({
    stateRoot: '/unused-state',
    tokscale: new FakeTokscale({ claude: [entry('claude', 'bad', { input: -1 })] }),
  });
  await assert.rejects(invalid.query({ home }), error => error.code === 'usage_invalid_counter');

  const fractional = new UsageService({
    stateRoot: '/unused-state',
    tokscale: new FakeTokscale({ claude: [entry('claude', 'bad', { input: 1.5 })] }),
  });
  await assert.rejects(fractional.query({ home }), error => error.code === 'usage_invalid_counter');

  const overflow = new UsageService({
    stateRoot: '/unused-state',
    tokscale: new FakeTokscale({
      claude: [
        entry('claude', 'huge-a', { input: Number.MAX_SAFE_INTEGER }),
        entry('claude', 'huge-b', { input: 1 }),
      ],
    }),
  });
  await assert.rejects(overflow.query({ home }), error => error.code === 'usage_counter_overflow');
});

test('formatUsageTable strips control characters to prevent terminal escapes', () => {
  const report = {
    scope: { type: 'run', runId: 'run-\x1b[31mred', taskId: 'task\x07bell' },
    status: 'ok',
    source: { version: '4.16.0\x1b[0m' },
    observedAt: '2026-01-01T00:00:00.000Z',
    attribution: { level: 'workspace' },
    rows: [
      { agent: 'claude\x1b[2J', model: 'model\nname', input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5, totalTokens: 15 },
    ],
    totals: { totalTokens: 15, messages: 1 },
    sourceWarningCount: 0,
  };

  const table = formatUsageTable(report);
  assert.doesNotMatch(table, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  assert.match(table, /model name/);
});

test('formatUsageTable includes provider and dates while stripping bidi and zero-width characters', () => {
  const report = {
    scope: { type: 'machine', runId: null, taskId: null },
    status: 'ok',
    source: { version: '4.16.0' },
    observedAt: '2026-01-01T00:00:00.000Z',
    filters: { since: '2026-01-01', until: '2026-01-02', timezone: 'UTC\u202eHidden' },
    attribution: { level: 'machine' },
    rows: [
      {
        agent: 'codex',
        model: 'model\u200bname',
        provider: 'provider\u202eoverride',
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 3,
        totalTokens: 6,
      },
    ],
    totals: { totalTokens: 6, messages: 1 },
    sourceWarningCount: 0,
  };

  const table = formatUsageTable(report);
  assert.match(table, /Provider/);
  assert.match(table, /Dates: 2026-01-01 through 2026-01-02/);
  assert.match(table, /model name/);
  assert.match(table, /provider override/);
  assert.doesNotMatch(table, /\u202e|\u200b/);
});
