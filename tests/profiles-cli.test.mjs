import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'cao-profile-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'state');
  const files = path.join(root, 'files');
  await mkdir(files, { recursive: true });
  return { root, state, files };
}

function runCao(state, args, { input } = {}) {
  const result = spawnSync(process.execPath, ['bin/cao.mjs', ...args, '--state-dir', state], {
    cwd: process.cwd(),
    encoding: 'utf8',
    input,
    env: { ...process.env, CAO_HERDR_BIN: 'herdr' },
    maxBuffer: 1024 * 1024,
  });
  let stdout = null;
  let stderr = null;
  try { stdout = result.stdout ? JSON.parse(result.stdout) : null; } catch {}
  try { stderr = result.stderr ? JSON.parse(result.stderr) : null; } catch {}
  return { ...result, stdoutJson: stdout, stderrJson: stderr };
}

function expectOk(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdoutJson?.ok, true, result.stdout);
  return result.stdoutJson.data;
}

function expectError(result, code) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(result.stderrJson?.ok, false, result.stderr);
  assert.equal(result.stderrJson.error.code, code, result.stderr);
  return result.stderrJson.error;
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function profile(id, extra = {}) {
  return {
    id,
    name: `Profile ${id}`,
    agent: 'claude',
    model: `${id}-model`,
    protocol: 'anthropic',
    endpoint: 'http://127.0.0.1:9876/api',
    credential: { type: 'none' },
    source: { type: 'native' },
    enabled: true,
    capabilities: ['coding', 'shell'],
    priority: 10,
    account: { id: `acct-${id}`, maxParallel: 2 },
    quota: { state: 'available', observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), remainingTokens: 1000 },
    quality: 80,
    speed: 70,
    costPerMillion: 1,
    modelMap: { haiku: `${id}-haiku` },
    fallbacks: [],
    ...extra,
  };
}

async function createSyntheticCCSwitch(directory, { endpoint = 'https://old.anthropic.example/v1', model = 'claude-old', token = 'old-token', field = 'ANTHROPIC_AUTH_TOKEN' } = {}) {
  const sqlite = await import('node:sqlite');
  const db = new sqlite.DatabaseSync(path.join(directory, 'cc-switch.db'));
  db.exec(`
    PRAGMA user_version = 18;
    CREATE TABLE providers(
      id TEXT NOT NULL,
      app_type TEXT NOT NULL,
      name TEXT,
      settings_config TEXT,
      website_url TEXT,
      category TEXT,
      created_at TEXT,
      sort_index INTEGER,
      notes TEXT,
      icon TEXT,
      icon_color TEXT,
      meta TEXT,
      is_current BOOLEAN,
      in_failover_queue BOOLEAN,
      cost_multiplier TEXT,
      limit_daily_usd REAL,
      limit_monthly_usd REAL,
      provider_type TEXT,
      PRIMARY KEY(id, app_type)
    );
    CREATE TABLE proxy_config(
      app_type TEXT PRIMARY KEY,
      proxy_enabled BOOLEAN,
      listen_address TEXT,
      listen_port INTEGER,
      enable_logging BOOLEAN,
      enabled BOOLEAN,
      auto_failover_enabled BOOLEAN,
      live_takeover_active BOOLEAN,
      created_at TEXT,
      updated_at TEXT
    );
  `);
  db.prepare(`INSERT INTO providers(id, app_type, name, settings_config, meta, is_current, provider_type) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    'claude-main',
    'claude',
    'Claude Main',
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: endpoint, [field]: token, ANTHROPIC_MODEL: model } }),
    JSON.stringify({ providerType: 'api', apiFormat: 'anthropic' }),
    0,
    'api',
  );
  db.close();
}

async function updateSyntheticCCSwitch(directory, { endpoint, model, token = 'new-token', field = 'ANTHROPIC_API_KEY' }) {
  const sqlite = await import('node:sqlite');
  const db = new sqlite.DatabaseSync(path.join(directory, 'cc-switch.db'));
  db.prepare('UPDATE providers SET settings_config = ? WHERE id = ? AND app_type = ?').run(
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: endpoint, [field]: token, ANTHROPIC_MODEL: model } }),
    'claude-main',
    'claude',
  );
  db.close();
}

function task(id, extra = {}) {
  return {
    id,
    objective: 'Synthetic task for route explain.',
    agent: 'auto',
    allowedPaths: ['src/example.mjs'],
    checks: [{ name: 'noop', argv: [process.execPath, '--version'] }],
    execution: { policy: 'quality', profiles: ['claude-main'] },
    ...extra,
  };
}

test('profile CLI supports put/show/list/export/import roundtrip/default/clear/clone/remove', async t => {
  const { state, files } = await fixture(t);
  const profileFile = await writeJson(path.join(files, 'profile.json'), profile('claude-main'));

  const put = expectOk(runCao(state, ['profile', 'put', '--file', profileFile, '--default']));
  assert.equal(put.id, 'claude-main');
  assert.equal(put.revision.length, 64);

  const shown = expectOk(runCao(state, ['profile', 'show', '--id', 'claude-main']));
  assert.equal(shown.id, 'claude-main');
  assert.equal(shown.model, 'claude-main-model');

  const listed = expectOk(runCao(state, ['profile', 'list']));
  assert.equal(listed.defaultProfileId, 'claude-main');
  assert.deepEqual(listed.profiles.map(item => item.id), ['claude-main']);

  const exportFile = path.join(files, 'exported.json');
  const exportResult = expectOk(runCao(state, ['profile', 'export', '--id', 'claude-main', '--file', exportFile]));
  assert.equal(exportResult.containsCredentialValues, false);
  const exported = JSON.parse(await readFile(exportFile, 'utf8'));
  assert.equal(exported.id, 'claude-main');
  assert.equal(exported.revision, undefined);
  assert.equal(exported.schemaVersion, undefined);

  const importedFile = await writeJson(path.join(files, 'imported.json'), { ...exported, id: 'imported-main', name: 'Imported main' });
  const imported = expectOk(runCao(state, ['profile', 'put', '--file', importedFile]));
  assert.equal(imported.id, 'imported-main');

  const clone = expectOk(runCao(state, ['profile', 'clone', '--id', 'claude-main', '--new-id', 'claude-copy']));
  assert.equal(clone.id, 'claude-copy');
  assert.equal(clone.model, 'claude-main-model');

  assert.equal(expectOk(runCao(state, ['profile', 'default', '--id', 'imported-main'])).defaultProfileId, 'imported-main');
  assert.equal(expectOk(runCao(state, ['profile', 'default', '--clear'])).defaultProfileId, null);

  assert.deepEqual(expectOk(runCao(state, ['profile', 'remove', '--id', 'claude-copy'])), { id: 'claude-copy', removed: true });
  const afterRemove = expectOk(runCao(state, ['profile', 'list']));
  assert.deepEqual(afterRemove.profiles.map(item => item.id).sort(), ['claude-main', 'imported-main']);
});

test('secret set reads stdin and never echoes the secret value', async t => {
  const { state } = await fixture(t);
  const secret = 'super-secret-profile-token';
  const result = expectOk(runCao(state, ['secret', 'set', '--id', 'stored-token', '--stdin'], { input: `${secret}\n` }));
  assert.deepEqual(result, { ref: 'stored:stored-token', stored: true });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.doesNotMatch(result.ref, new RegExp(secret));
});

test('route explain selects an auto-compatible profile and invalid JSON errors do not leak file contents', async t => {
  const { state, files } = await fixture(t);
  await writeJson(path.join(files, 'profile.json'), profile('claude-main'));
  expectOk(runCao(state, ['profile', 'put', '--file', path.join(files, 'profile.json')]));

  const taskFile = await writeJson(path.join(files, 'task.json'), task('route-task'));
  const route = expectOk(runCao(state, ['route', 'explain', '--file', taskFile]));
  assert.equal(route.selectedProfileId, 'claude-main');
  assert.equal(route.policy, 'quality');
  assert.equal(route.signalBasis, 'declared-and-observed');
  assert.equal(route.candidates[0].eligible, true);

  const bad = path.join(files, 'bad-profile.json');
  await writeFile(bad, '{"id":"bad-profile","token":"SHOULD_NOT_LEAK",');
  const error = expectError(runCao(state, ['profile', 'put', '--file', bad]), 'invalid_profile_file');
  assert.doesNotMatch(JSON.stringify(error), /SHOULD_NOT_LEAK/);
});

test('profile refresh updates CC Switch source fields while preserving CAO routing metadata', async t => {
  const { state, root, files } = await fixture(t);
  const ccSwitchDir = path.join(root, 'cc-switch');
  await mkdir(ccSwitchDir, { recursive: true });
  await createSyntheticCCSwitch(ccSwitchDir);

  const imported = expectOk(runCao(state, [
    'profile', 'import-cc-switch',
    '--directory', ccSwitchDir,
    '--provider', 'claude-main',
    '--app', 'claude',
    '--id', 'cc-refresh',
  ]));
  assert.equal(imported.endpoint, 'https://old.anthropic.example/v1');
  assert.equal(imported.model, 'claude-old');
  assert.equal(imported.credential.field, 'ANTHROPIC_AUTH_TOKEN');

  const { schemaVersion, revision, createdAt, updatedAt, resolvedAt, ...editableImported } = imported;
  const editedFile = await writeJson(path.join(files, 'edited-cc-refresh.json'), {
    ...editableImported,
    capabilities: ['coding', 'vision'],
    priority: 42,
    account: { id: 'manual-account', maxParallel: 7 },
    quota: { state: 'available', observedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z', remainingTokens: 123 },
    quality: 91,
    speed: 37,
    costPerMillion: 2.5,
    modelMap: { haiku: 'manual-haiku' },
    fallbacks: ['fallback-one'],
  });
  expectOk(runCao(state, ['profile', 'put', '--file', editedFile, '--if-revision', imported.revision]));
  await updateSyntheticCCSwitch(ccSwitchDir, { endpoint: 'https://new.anthropic.example/v1', model: 'claude-new' });

  const refreshed = expectOk(runCao(state, ['profile', 'refresh', '--id', 'cc-refresh', '--model', 'manual-model-override']));
  assert.equal(refreshed.endpoint, 'https://new.anthropic.example/v1');
  assert.equal(refreshed.model, 'manual-model-override');
  assert.equal(refreshed.credential.field, 'ANTHROPIC_API_KEY');
  assert.match(refreshed.credential.secretRef, /^cc-switch:/);
  assert.equal(refreshed.source.type, 'cc-switch');
  assert.equal(refreshed.source.providerId, 'claude-main');
  assert.equal(refreshed.source.app, 'claude');
  assert.equal(refreshed.source.directory, path.resolve(ccSwitchDir));

  assert.deepEqual(refreshed.capabilities, ['coding', 'vision']);
  assert.equal(refreshed.priority, 42);
  assert.deepEqual(refreshed.account, { id: 'manual-account', maxParallel: 7 });
  assert.deepEqual(refreshed.quota, { state: 'available', observedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z', remainingTokens: 123 });
  assert.equal(refreshed.quality, 91);
  assert.equal(refreshed.speed, 37);
  assert.equal(refreshed.costPerMillion, 2.5);
  assert.deepEqual(refreshed.modelMap, { haiku: 'manual-haiku' });
  assert.deepEqual(refreshed.fallbacks, ['fallback-one']);
  assert.doesNotMatch(JSON.stringify(refreshed), /old-token|new-token/);
});

test('source discover missing directory is sanitized and does not require user config or SQLite', async t => {
  const { state, root } = await fixture(t);
  const missing = path.join(root, 'does-not-exist');
  const result = runCao(state, ['source', 'discover', '--directory', missing]);
  if (result.status === 0) {
    const data = result.stdoutJson.data;
    assert.ok(Array.isArray(data.providers));
    assert.equal(data.providers.length, 0);
    assert.doesNotMatch(JSON.stringify(data), /api[_-]?key|token|secret|password/i);
  } else {
    const error = expectError(result, result.stderrJson.error.code);
    assert.doesNotMatch(JSON.stringify(error), /api[_-]?key|token|secret|password/i);
    assert.ok(['cc_switch_missing', 'cc_switch_unsupported', 'source_missing', 'config_source_missing', 'state_read_failed'].includes(error.code), error.code);
  }
});
