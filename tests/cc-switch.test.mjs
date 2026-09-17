import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverCCSwitch, importCCSwitchProfile } from '../src/config-sources/cc-switch.mjs';
import { ProfileStore } from '../src/profiles.mjs';

const dummyClaudeKey = 'dummy-claude-key-for-synthetic-test';
const dummyOAuthToken = 'dummy-oauth-token-for-synthetic-test';

test('Pi CC Switch providers expose model metadata and import credential references without copying keys', async t => {
  const directory = await temporaryDirectory(t);
  await createDatabase(directory);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(directory, 'cc-switch.db'));
  db.prepare('INSERT INTO providers(id,app_type,name,settings_config,meta,is_current,provider_type) VALUES(?,?,?,?,?,?,?)').run('pi-kimi', 'pi', 'Kimi', JSON.stringify({ api: 'anthropic-messages', baseUrl: 'https://api.example.test/v1', apiKey: 'private-pi-test-key', models: [{ id: 'k3', contextWindow: 1000000, maxTokens: 128000 }] }), '{}', 0, 'api');
  db.close();
  const inventory = await discoverCCSwitch({ directory });
  const p = inventory.providers.find(p => p.providerId === 'pi-kimi');
  assert.equal(p.supported, true); assert.equal(p.authKind, 'pi-api');
  assert.doesNotMatch(JSON.stringify(inventory), /private-pi-test-key/);
  const profile = await importCCSwitchProfile({ directory, providerId: 'pi-kimi', app: 'pi', id: 'pi-import' });
  assert.deepEqual(profile.modelMetadata, { contextWindow: 1000000, maxOutputTokens: 128000 });
  const store = new ProfileStore({ root: join(directory, 'state') });
  const saved = await store.put(profile);
  assert.equal(await store.resolveProfileSecret(saved), 'private-pi-test-key');
  await assert.rejects(importCCSwitchProfile({ directory, providerId: 'pi-kimi', app: 'pi', model: 'not-in-catalog' }), e => e.code === 'cc_switch_model_not_found');
});

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cao-cc-switch-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function createDatabase(directory) {
  const sqlite = await import('node:sqlite');
  const file = join(directory, 'cc-switch.db');
  const db = new sqlite.DatabaseSync(file);
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
  const insert = db.prepare(`
    INSERT INTO providers(id, app_type, name, settings_config, meta, is_current, provider_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    'claude-main',
    'claude',
    'Claude Direct',
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.example/v1', ANTHROPIC_AUTH_TOKEN: dummyClaudeKey, ANTHROPIC_MODEL: 'claude-sonnet-4' } }),
    JSON.stringify({ providerType: 'api', apiFormat: 'anthropic' }),
    0,
    'api',
  );
  insert.run(
    'claude-api-key',
    'claude',
    'Claude API Key',
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api-key.anthropic.example/v1', ANTHROPIC_API_KEY: 'dummy-api-key-for-synthetic-test', ANTHROPIC_MODEL: 'claude-opus-4' } }),
    JSON.stringify({ providerType: 'api', apiFormat: 'anthropic' }),
    0,
    'api',
  );
  insert.run(
    'codex-oauth',
    'codex',
    'Codex OAuth',
    JSON.stringify({ auth: { tokens: { access_token: dummyOAuthToken } }, config: 'model = "gpt-main"' }),
    JSON.stringify({ providerType: 'oauth' }),
    0,
    'oauth',
  );
  insert.run(
    'claude-proxy',
    'claude',
    'Claude Current Proxy',
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://proxy-origin.example/v1', DEFAULT_SONNET_MODEL: 'claude-proxy-model' } }),
    JSON.stringify({ providerType: 'oauth', authBinding: 'oauth' }),
    1,
    'oauth',
  );
  db.prepare(`
    INSERT INTO proxy_config(app_type, proxy_enabled, listen_address, listen_port, enable_logging, enabled, auto_failover_enabled, live_takeover_active, created_at, updated_at)
    VALUES ('claude', 1, '127.0.0.1', 3456, 0, 1, 1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run();
  db.close();
  return file;
}

function assertNoCredentialMaterial(value) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(dummyClaudeKey), false);
  assert.equal(serialized.includes(dummyOAuthToken), false);
}

test('discoverCCSwitch reads real 3.20 schema and returns sanitized provider inventory', async t => {
  const directory = await temporaryDirectory(t);
  await createDatabase(directory);

  const inventory = await discoverCCSwitch({ directory });
  assert.equal(inventory.supported, true);
  assert.equal(inventory.schemaVersion, 18);
  assert.equal(inventory.providers.length, 4);

  const direct = inventory.providers.find(provider => provider.providerId === 'claude-main');
  assert.equal(direct.supported, true);
  assert.equal(direct.authKind, 'claude-api');
  assert.equal(direct.credentialField, 'ANTHROPIC_AUTH_TOKEN');
  assert.equal(direct.endpoint, 'https://api.anthropic.example/v1');
  assert.equal(direct.model, 'claude-sonnet-4');
  assert.match(direct.secretRef, /^cc-switch:/);
  assert.match(direct.fingerprint, /^[a-f0-9]{64}$/);

  const apiKey = inventory.providers.find(provider => provider.providerId === 'claude-api-key');
  assert.equal(apiKey.supported, true);
  assert.equal(apiKey.credentialField, 'ANTHROPIC_API_KEY');

  const codex = inventory.providers.find(provider => provider.providerId === 'codex-oauth');
  assert.equal(codex.supported, false);
  assert.equal(codex.requiresGateway, true);
  assert.deepEqual(codex.reasons, ['requires_gateway']);

  const proxy = inventory.providers.find(provider => provider.providerId === 'claude-proxy');
  assert.equal(proxy.supported, false);
  assert.equal(proxy.sharedProxyAvailable, true);
  assert.equal(proxy.proxyEndpoint, 'http://127.0.0.1:3456/v1');

  assertNoCredentialMaterial(inventory);
});

test('importCCSwitchProfile stores cc-switch references and resolves private DB field values', async t => {
  const directory = await temporaryDirectory(t);
  await createDatabase(directory);
  const input = await importCCSwitchProfile({ directory, providerId: 'claude-main', app: 'claude', id: 'imported-claude' });

  assert.equal(input.id, 'imported-claude');
  assert.equal(input.agent, 'claude');
  assert.equal(input.credential.type, 'cc-switch');
  assert.equal(input.credential.field, 'ANTHROPIC_AUTH_TOKEN');
  assert.equal(input.credential.authScheme, 'bearer');
  assert.match(input.credential.secretRef, /^cc-switch:/);
  assert.equal(input.source.type, 'cc-switch');
  assert.equal(input.source.route, 'direct');
  assertNoCredentialMaterial(input);

  const store = new ProfileStore({ root: await temporaryDirectory(t) });
  const saved = await store.put(input);
  assertNoCredentialMaterial(saved);
  const snapshot = await store.resolve('imported-claude');
  assert.equal(await store.resolveProfileSecret(snapshot), dummyClaudeKey);
  assert.equal(await store.credentialAvailable(snapshot), true);
  assertNoCredentialMaterial(await store.export('imported-claude'));

  const apiKeyInput = await importCCSwitchProfile({ directory, providerId: 'claude-api-key', app: 'claude', id: 'imported-claude-api-key' });
  assert.equal(apiKeyInput.credential.field, 'ANTHROPIC_API_KEY');
  assert.equal(apiKeyInput.credential.authScheme, 'api-key');
  assertNoCredentialMaterial(apiKeyInput);
});

test('importCCSwitchProfile rejects OAuth direct import and requires explicit shared proxy reuse', async t => {
  const directory = await temporaryDirectory(t);
  await createDatabase(directory);

  await assert.rejects(
    importCCSwitchProfile({ directory, providerId: 'codex-oauth', app: 'codex', id: 'codex-oauth' }),
    error => error.code === 'cc_switch_requires_gateway',
  );
  await assert.rejects(
    importCCSwitchProfile({ directory, providerId: 'claude-proxy', app: 'claude', id: 'claude-proxy' }),
    error => error.code === 'cc_switch_shared_route_required',
  );

  const shared = await importCCSwitchProfile({ directory, providerId: 'claude-proxy', app: 'claude', id: 'claude-proxy', allowShared: true });
  assert.deepEqual(shared.credential, { type: 'none' });
  assert.equal(shared.endpoint, 'http://127.0.0.1:3456/v1');
  assert.equal(shared.source.allowShared, true);
  assert.equal(shared.source.route, 'active-proxy');
  assertNoCredentialMaterial(shared);
});

test('ProfileStore assertSourceCurrent detects CC Switch public source drift but ignores secret value changes', async t => {
  const directory = await temporaryDirectory(t);
  await createDatabase(directory);
  const store = new ProfileStore({ root: await temporaryDirectory(t) });
  await store.put(await importCCSwitchProfile({ directory, providerId: 'claude-main', app: 'claude', id: 'drift-profile' }));
  const snapshot = await store.resolve('drift-profile');
  assert.equal(await store.assertSourceCurrent(snapshot), true);

  const sqlite = await import('node:sqlite');
  const db = new sqlite.DatabaseSync(join(directory, 'cc-switch.db'));
  db.prepare('UPDATE providers SET settings_config = ? WHERE id = ? AND app_type = ?').run(
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.example/v1', ANTHROPIC_AUTH_TOKEN: 'changed-secret-not-in-fingerprint', ANTHROPIC_MODEL: 'claude-sonnet-4' } }),
    'claude-main',
    'claude',
  );
  assert.equal(await store.assertSourceCurrent(snapshot), true);
  assert.equal(await store.resolveProfileSecret(snapshot), 'changed-secret-not-in-fingerprint');

  db.prepare('UPDATE providers SET settings_config = ? WHERE id = ? AND app_type = ?').run(
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.example/v1', ANTHROPIC_AUTH_TOKEN: 'changed-secret-not-in-fingerprint', ANTHROPIC_MODEL: 'claude-new-public-model' } }),
    'claude-main',
    'claude',
  );
  db.close();

  await assert.rejects(store.assertSourceCurrent(snapshot), error => error.code === 'profile_source_drift');
  assert.equal(await store.credentialAvailable(snapshot), false);
});

test('discoverCCSwitch handles missing and unsupported databases without credential output', async t => {
  const missing = await discoverCCSwitch({ directory: await temporaryDirectory(t) });
  assert.equal(missing.supported, false);
  assert.deepEqual(missing.reasons, ['database_not_found']);

  const directory = await temporaryDirectory(t);
  const sqlite = await import('node:sqlite');
  const db = new sqlite.DatabaseSync(join(directory, 'cc-switch.db'));
  db.exec('PRAGMA user_version = 17; CREATE TABLE providers(id TEXT PRIMARY KEY, token TEXT)');
  db.close();
  await assert.rejects(discoverCCSwitch({ directory }), error => error.code === 'cc_switch_unsupported_schema');
});
