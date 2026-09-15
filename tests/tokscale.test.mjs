import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { OrchestratorError } from '../src/errors.mjs';
import { Tokscale } from '../src/runtime/tokscale.mjs';

const HOME = resolve('/tmp/cao-tokscale-home');
const WORKSPACE_REPORT = {
  groupBy: 'workspace,model',
  entries: [
    {
      client: 'claude',
      mergedClients: 'claude',
      workspaceKey: 'demo-workspace',
      workspaceLabel: 'demo-workspace',
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
      input: 100,
      output: 50,
      cacheRead: 30,
      cacheWrite: 20,
      reasoning: 0,
      messageCount: 1,
    },
  ],
  totalInput: 100,
  totalOutput: 50,
  totalCacheRead: 30,
  totalCacheWrite: 20,
  totalMessages: 1,
};

function okReport(overrides = {}) {
  return {
    groupBy: 'client,provider,model',
    entries: [
      {
        client: 'claude',
        mergedClients: 'claude',
        model: 'claude-sonnet-4-5',
        provider: 'anthropic',
        input: 10,
        output: 5,
        cacheRead: 3,
        cacheWrite: 2,
        reasoning: 0,
        messageCount: 1,
      },
    ],
    totalInput: 10,
    totalOutput: 5,
    totalCacheRead: 3,
    totalCacheWrite: 2,
    totalMessages: 1,
    ...overrides,
  };
}

function jsonResult(value, extra = {}) {
  return {
    code: 0,
    stdout: JSON.stringify(value),
    stderr: '',
    truncated: false,
    ...extra,
  };
}

test('Tokscale version accepts tested 4.x version and rejects unsupported versions', async () => {
  const calls = [];
  const tokscale = new Tokscale({
    binary: 'tokscale-test',
    runner: async (argv, options) => {
      calls.push({ argv, options });
      return { code: 0, stdout: 'tokscale 4.16.0\n', stderr: '', truncated: false };
    },
  });

  assert.deepEqual(await tokscale.version(), {
    version: '4.16.0',
    testedVersion: '4.16.0',
    supportedRange: '>=4.16.0 <5',
  });
  assert.deepEqual(calls[0].argv, ['tokscale-test', '--version']);
  assert.equal(calls[0].options.timeoutMs, 60000);
  assert.equal(calls[0].options.maxBytes, 16 * 1024 * 1024);

  for (const output of ['tokscale 4.15.9', 'tokscale 5.0.0']) {
    const unsupported = new Tokscale({
      runner: async () => ({ code: 0, stdout: output, stderr: '', truncated: false }),
    });
    await assert.rejects(
      unsupported.version(),
      (error) => error instanceof OrchestratorError
        && error.code === 'tokscale_unsupported_version'
        && error.details.testedVersion === '4.16.0',
    );
  }
});

test('Tokscale version requires exact stdout format and rejects prerelease or stderr numbers', async () => {
  for (const result of [
    { code: 0, stdout: 'tokscale 4.16.0-beta.1\n', stderr: '', truncated: false },
    { code: 0, stdout: 'tool 4.16.0\n', stderr: '', truncated: false },
    { code: 0, stdout: '', stderr: 'tokscale 4.16.0\n', truncated: false },
  ]) {
    const tokscale = new Tokscale({ runner: async () => result });
    await assert.rejects(
      tokscale.version(),
      (error) => error instanceof OrchestratorError && error.code === 'tokscale_invalid_report',
    );
  }
});

test('Tokscale models builds the read-only argv and returns normalized report unchanged', async () => {
  const calls = [];
  const report = okReport({
    warnings: ['cache was stale'],
    diagnostics: [{ code: 'fixture_warning', severity: 'warning', message: 'Synthetic advisory' }],
  });
  const tokscale = new Tokscale({
    binary: 'tokscale-test',
    runner: async (argv, options) => {
      calls.push({ argv, options });
      return jsonResult(report);
    },
  });

  const actual = await tokscale.models({
    clients: ['claude'],
    groupBy: 'client,provider,model',
    since: '2026-09-01',
    until: '2026-09-15',
    home: HOME,
  });

  assert.deepEqual(actual, report);
  assert.deepEqual(calls[0].argv, [
    'tokscale-test',
    'models',
    '--json',
    '--no-spinner',
    '--home',
    HOME,
    '--client',
    'claude',
    '--group-by',
    'client,provider,model',
    '--since',
    '2026-09-01',
    '--until',
    '2026-09-15',
  ]);
  assert.equal(calls[0].options.timeoutMs, 60000);
  assert.equal(calls[0].options.maxBytes, 16 * 1024 * 1024);
});

test('Tokscale models accepts zero-entry reports with exact zero totals', async () => {
  const tokscale = new Tokscale({
    runner: async () => jsonResult({
      groupBy: 'workspace,model',
      entries: [],
      totalInput: 0,
      totalOutput: 0,
      totalCacheRead: 0,
      totalCacheWrite: 0,
      totalMessages: 0,
    }),
  });

  const report = await tokscale.models({
    clients: ['claude', 'codex'],
    groupBy: 'workspace,model',
    home: HOME,
  });
  assert.deepEqual(report.entries, []);
});

test('Tokscale models validates fixture reports for supported groupings', async () => {
  const tokscale = new Tokscale({
    runner: async () => jsonResult(WORKSPACE_REPORT),
  });

  const report = await tokscale.models({
    clients: ['claude'],
    groupBy: 'workspace,model',
    home: HOME,
  });
  assert.equal(report.groupBy, 'workspace,model');
  assert.equal(report.totalInput, 100);
});

test('Tokscale models allows required group metadata fields to be null', async () => {
  const workspace = {
    ...WORKSPACE_REPORT,
    entries: [{ ...WORKSPACE_REPORT.entries[0], workspaceKey: null, workspaceLabel: 'Unknown workspace' }],
  };
  const workspaceClient = new Tokscale({ runner: async () => jsonResult(workspace) });
  assert.equal((await workspaceClient.models({
    clients: ['claude'],
    groupBy: 'workspace,model',
    home: HOME,
  })).entries[0].workspaceKey, null);

  const session = okReport({
    groupBy: 'client,session,model',
    entries: [{ ...okReport().entries[0], sessionId: null, provider: null }],
  });
  const sessionClient = new Tokscale({ runner: async () => jsonResult(session) });
  assert.equal((await sessionClient.models({
    clients: ['claude'],
    groupBy: 'client,session,model',
    home: HOME,
  })).entries[0].sessionId, null);
});

test('Tokscale rejects unsafe inputs before spawning', async () => {
  const tokscale = new Tokscale({
    runner: async () => {
      throw new Error('runner should not be called');
    },
  });

  await assert.rejects(
    tokscale.models({ clients: ['cursor'], groupBy: 'client,provider,model', home: HOME }),
    (error) => error instanceof OrchestratorError && error.code === 'tokscale_invalid_report',
  );
  await assert.rejects(
    tokscale.models({ clients: ['claude'], groupBy: 'client,model', home: HOME }),
    (error) => error instanceof OrchestratorError && error.code === 'tokscale_invalid_report',
  );
  await assert.rejects(
    tokscale.models({ clients: ['claude'], groupBy: 'client,provider,model', home: 'relative-home' }),
    (error) => error instanceof OrchestratorError && error.code === 'tokscale_invalid_report',
  );
  for (const dates of [{ since: '2026-02-30' }, { since: '2026-09-15', until: '2026-09-01' }]) {
    await assert.rejects(tokscale.models({ clients: ['claude'], groupBy: 'client,provider,model', home: HOME, ...dates }), error => error.code === 'tokscale_invalid_report');
  }
});

test('Tokscale rejects invalid reports instead of inventing defaults', async () => {
  const cases = [
    okReport({ groupBy: 'workspace,model' }),
    okReport({ totalInput: 11 }),
    { ...okReport(), entries: [{ ...okReport().entries[0], input: 1.5 }], totalInput: 1.5 },
    { ...okReport(), entries: [{ ...okReport().entries[0], cacheRead: undefined }] },
    { ...okReport(), entries: [{ ...okReport().entries[0], mergedClients: 'claude,cursor' }] },
    { ...okReport(), entries: [{ ...okReport().entries[0], client: 'cursor', mergedClients: 'cursor' }] },
    okReport({ diagnostics: { unexpected: 'shape' } }),
    okReport({ warnings: [123] }),
    okReport({ diagnostics: [{ code: 'fixture', severity: 'unrecognized' }] }),
    okReport({ entries: [okReport().entries[0], okReport().entries[0]], totalInput: 20, totalOutput: 10, totalCacheRead: 6, totalCacheWrite: 4, totalMessages: 2 }),
    { ...okReport(), entries: [{ ...okReport().entries[0], client: null }] },
    { ...okReport(), entries: [{ ...okReport().entries[0], client: '' }] },
    { ...okReport(), entries: [{ ...okReport().entries[0], model: null }] },
    { ...okReport(), entries: [{ ...okReport().entries[0], model: '' }] },
    { ...okReport(), groupBy: 'client,session,model', entries: [{ ...okReport().entries[0] }] },
    { ...WORKSPACE_REPORT, entries: [{ ...WORKSPACE_REPORT.entries[0], workspaceKey: undefined }] },
  ];

  for (const report of cases) {
    const tokscale = new Tokscale({ runner: async () => jsonResult(report) });
    await assert.rejects(
      tokscale.models({ clients: ['claude'], groupBy: 'client,provider,model', home: HOME }),
      (error) => error instanceof OrchestratorError && error.code === 'tokscale_invalid_report',
    );
  }
});

test('Tokscale invalid JSON errors do not leak output text', async () => {
  const tokscale = new Tokscale({
    runner: async () => ({
      code: 0,
      stdout: '{"token":"secret-output"',
      stderr: '',
      truncated: false,
    }),
  });

  await assert.rejects(
    tokscale.models({ clients: ['claude'], groupBy: 'client,provider,model', home: HOME }),
    (error) => error instanceof OrchestratorError
      && error.code === 'tokscale_invalid_report'
      && !error.message.includes('secret-output')
      && !JSON.stringify(error.details).includes('secret-output'),
  );
});

test('Tokscale maps execution failures without leaking stderr in details', async () => {
  const failure = new Tokscale({
    runner: async () => ({ code: 2, stdout: '', stderr: 'secret stderr', truncated: false }),
  });
  await assert.rejects(
    failure.models({ clients: ['claude'], groupBy: 'client,provider,model', home: HOME }),
    (error) => error instanceof OrchestratorError
      && error.code === 'tokscale_failed'
      && !Object.hasOwn(error.details, 'stderr')
      && !Object.hasOwn(error.details, 'stdout'),
  );

  const timeout = new Tokscale({
    runner: async () => {
      throw new OrchestratorError('command_timeout', 'timeout', { stderr: 'secret stderr', truncated: true });
    },
  });
  await assert.rejects(
    timeout.models({ clients: ['claude'], groupBy: 'client,provider,model', home: HOME }),
    (error) => error instanceof OrchestratorError
      && error.code === 'tokscale_timeout'
      && !Object.hasOwn(error.details, 'stderr'),
  );

  const missing = new Tokscale({
    runner: async () => {
      throw new OrchestratorError('command_spawn_failed', 'missing', { stderr: 'secret stderr' });
    },
  });
  await assert.rejects(
    missing.version(),
    (error) => error instanceof OrchestratorError
      && error.code === 'tokscale_missing'
      && error.message.includes('@tokscale/cli')
      && error.details.installSuggestion === 'npm install -g @tokscale/cli@4.16.0'
      && !Object.hasOwn(error.details, 'stderr'),
  );
});
