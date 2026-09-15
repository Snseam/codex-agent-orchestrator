import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileStore, validateProfile } from '../src/profiles.mjs';

async function root(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cao-profiles-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function profile(extra = {}) {
  return {
    id: 'claude-main',
    name: 'Claude Main',
    agent: 'claude',
    model: 'claude-sonnet',
    protocol: 'anthropic',
    endpoint: 'https://api.anthropic.example/v1',
    credential: { type: 'env', name: 'ANTHROPIC_API_KEY' },
    source: { type: 'native' },
    ...extra,
  };
}

function revisionFor(record) {
  const { schemaVersion, revision, createdAt, updatedAt, ...publicRecord } = record;
  return createHash('sha256').update(JSON.stringify(publicRecord)).digest('hex');
}

test('validateProfile normalizes defaults and rejects secret literals or unsafe none credentials', () => {
  const normalized = validateProfile(profile({ capabilities: ['tools', 'tools'], quality: 90 }));
  assert.equal(normalized.enabled, true);
  assert.deepEqual(normalized.capabilities, ['tools']);
  assert.deepEqual(normalized.account, { id: null, maxParallel: 1 });
  assert.deepEqual(normalized.quota, { state: 'unknown', observedAt: null, expiresAt: null, remainingTokens: null });
  assert.equal(normalized.quality, 90);

  assert.throws(() => validateProfile(profile({ apiKey: 'literal-secret' })), error => error.code === 'profile_secret_literal');
  assert.throws(() => validateProfile(profile({ credential: { type: 'env', value: 'literal-secret' } })), error => error.code === 'profile_secret_literal');
  assert.throws(() => validateProfile(profile({ credential: { type: 'none' } })), error => error.code === 'invalid_profile');
  assert.equal(validateProfile(profile({ endpoint: 'http://127.0.0.1:9999/v1', credential: { type: 'none' } })).credential.type, 'none');
  assert.throws(() => validateProfile(profile({ endpoint: 'https://user@example.test/v1' })), error => error.code === 'invalid_profile');
  assert.throws(() => validateProfile(profile({ enabled: 'false' })), error => error.code === 'invalid_profile');
  assert.throws(() => validateProfile(profile({ modelMap: JSON.parse('{\"__proto__\":\"polluted\"}') })), error => error.code === 'invalid_profile');
  assert.throws(() => validateProfile(profile({ credential: { type: 'env', name: 'BAD-NAME' } })), error => error.code === 'invalid_secret_ref');
  assert.equal(validateProfile(profile({ credential: { type: 'env', name: 'ANTHROPIC_AUTH_TOKEN', authScheme: 'bearer' } })).credential.authScheme, 'bearer');
  assert.equal(validateProfile(profile({ credential: { type: 'stored', ref: 'stored:main', authScheme: 'api-key' } })).credential.authScheme, 'api-key');
  assert.throws(() => validateProfile(profile({ credential: { type: 'env', name: 'ANTHROPIC_API_KEY', authScheme: 'basic' } })), error => error.code === 'invalid_profile');
  assert.throws(() => validateProfile(profile({ fallbacks: ['claude-main'] })), error => error.code === 'invalid_profile');
  assert.throws(() => validateProfile(profile({ fallbacks: ['ok1', 'ok2', 'ok3', 'ok4', 'ok5', 'ok6', 'ok7', 'ok8', 'ok9'] })), error => error.code === 'invalid_profile');
  assert.throws(() => validateProfile(profile({ fallbacks: ['ok', '../bad'] })), error => error.code === 'invalid_id');
  assert.deepEqual(validateProfile(profile({ fallbacks: ['backup', 'backup'] })).fallbacks, ['backup']);
});



test('validateProfile keeps CC Switch provider ids opaque and normalizes source directory', () => {
  const normalized = validateProfile(profile({
    id: 'cc-profile',
    credential: { type: 'cc-switch', providerId: 'claude:main/provider', app: 'claude', field: 'ANTHROPIC_AUTH_TOKEN', secretRef: 'cc-switch:abc' },
    source: { type: 'cc-switch', directory: '.', providerId: 'claude:main/provider', app: 'claude', fingerprint: 'a'.repeat(64) },
  }));
  assert.equal(normalized.credential.providerId, 'claude:main/provider');
  assert.equal(normalized.source.providerId, 'claude:main/provider');
  assert.equal(normalized.source.directory.startsWith('/'), true);
});

test('ProfileStore supports CRUD, default, clone, export and optimistic revisions', async t => {
  const store = new ProfileStore({ root: await root(t) });
  const first = await store.put(profile(), { makeDefault: true });
  assert.match(first.revision, /^[a-f0-9]{64}$/);
  assert.equal((await store.getDefault()).id, 'claude-main');
  assert.equal((await store.get('claude-main')).credential.name, 'ANTHROPIC_API_KEY');

  await assert.rejects(
    store.put(profile({ name: 'Conflict' }), { ifRevision: 'not-current' }),
    error => error.code === 'profile_revision_conflict',
  );

  const updated = await store.put(profile({ priority: 5 }), { ifRevision: first.revision });
  assert.notEqual(updated.revision, first.revision);
  assert.equal(updated.createdAt, first.createdAt);
  assert.equal(updated.priority, 5);

  const cloned = await store.clone('claude-main', 'claude-copy');
  assert.equal(cloned.id, 'claude-copy');
  assert.equal(cloned.name, 'Claude Main copy');
  assert.equal((await store.list()).length, 2);

  const exported = await store.export('claude-main');
  assert.equal(exported.credential.name, 'ANTHROPIC_API_KEY');
  assert.equal(exported.schemaVersion, undefined);
  assert.equal(exported.revision, undefined);
  assert.equal(exported.createdAt, undefined);
  assert.equal(exported.updatedAt, undefined);
  assert.equal(JSON.stringify(exported).includes('literal-secret'), false);
  const roundTrip = await store.put({ ...exported, id: 'roundtrip-profile' });
  assert.equal(roundTrip.id, 'roundtrip-profile');

  assert.equal(await store.remove('claude-copy'), true);
  assert.equal(await store.get('claude-copy'), null);
  await store.setDefault(null);
  assert.equal(await store.getDefault(), null);
  await store.setDefault('claude-main');
  await store.remove('claude-main');
  await store.put(profile());
  assert.equal(await store.getDefault(), null, 'Recreating a removed default does not silently restore it');
});

test('malformed stored JSON never includes its content in parser diagnostics', async t => {
  const store = new ProfileStore({ root: await root(t) });
  await store.put(profile());
  await writeFile(store.profileFile('claude-main'), 'synthetic-sensitive-content');
  for (const operation of [() => store.get('claude-main'), () => store.list(), () => store.put(profile())]) {
    await assert.rejects(operation(), error => {
      assert.equal(error.code, 'invalid_profile_store');
      assert.ok(!JSON.stringify(error).includes('synthetic-sensitive-content'));
      return true;
    });
  }
});

test('ProfileStore stores secrets privately and normal methods return only references', async t => {
  const directory = await root(t);
  const store = new ProfileStore({ root: directory });
  const ref = await store.putSecret('stored-main', 'synthetic-secret-value\n');
  assert.equal(ref, 'stored:stored-main');
  assert.equal(await store.secretExists(ref), true);
  assert.equal(await store.resolveSecret(ref), 'synthetic-secret-value');
  assert.equal((await stat(join(directory, 'profile-secrets', 'stored-main.secret'))).mode & 0o777, 0o600);

  await store.put(profile({
    id: 'stored-profile',
    credential: { type: 'stored', ref },
  }));
  const publicProfile = await store.get('stored-profile');
  assert.deepEqual(publicProfile.credential, { type: 'stored', ref });
  assert.equal(JSON.stringify(publicProfile).includes('synthetic-secret-value'), false);
  assert.equal(await store.resolveProfileSecret(publicProfile), 'synthetic-secret-value');
  assert.equal(await store.credentialAvailable(publicProfile), true);

  const loopback = profile({ id: 'loopback-profile', endpoint: 'http://127.0.0.1:9999/v1', credential: { type: 'none' } });
  await store.put(loopback);
  assert.equal(await store.resolveProfileSecret(await store.get('loopback-profile')), null);
  assert.equal(await store.credentialAvailable(await store.get('loopback-profile')), true);

  await assert.rejects(store.putSecret('bad-control', 'bad\ninside'), error => error.code === 'invalid_secret');
  await assert.rejects(store.putSecret('too-large', 'x'.repeat(64 * 1024 + 1)), error => error.code === 'invalid_secret');
  process.env.CAO_PROFILE_TEST_SECRET = 'env-secret-value\n';
  t.after(() => { delete process.env.CAO_PROFILE_TEST_SECRET; delete process.env.CAO_BAD_PROFILE_SECRET; });
  assert.equal(await store.resolveSecret('env:CAO_PROFILE_TEST_SECRET'), 'env-secret-value');
  process.env.CAO_BAD_PROFILE_SECRET = 'bad\ninside';
  await assert.rejects(store.resolveSecret('env:CAO_BAD_PROFILE_SECRET'), error => error.code === 'invalid_secret');
  await assert.rejects(store.resolveSecret('env:BAD-NAME'), error => error.code === 'invalid_secret_ref');

  await store.removeSecret('stored-main');
  assert.equal(await store.secretExists(ref), false);
  assert.equal(await store.credentialAvailable(publicProfile), false);
  await assert.rejects(store.resolveSecret(ref), error => error.code === 'secret_not_found');
  await symlink('/tmp/not-a-secret-target', join(directory, 'profile-secrets', 'linked.secret'));
  assert.equal(await store.secretExists('stored:linked'), false);
  await assert.rejects(store.resolveSecret('stored:linked'), error => error.code === 'secret_not_found');
  await assert.rejects(store.putSecret('linked', 'replacement'), error => error.code === 'invalid_secret');
  await mkdir(join(directory, 'profile-secrets', 'directory.secret'));
  assert.equal(await store.secretExists('stored:directory'), false);
  await assert.rejects(store.resolveSecret('stored:directory'), error => error.code === 'secret_not_found');
});



test('ProfileStore validates stored profile records before returning disk JSON', async t => {
  const directory = await root(t);
  const store = new ProfileStore({ root: directory });
  const saved = await store.put(profile());
  const file = store.profileFile('claude-main');

  const tampered = { ...saved, name: 'Tampered without revision update' };
  await writeFile(file, `${JSON.stringify(tampered, null, 2)}\n`);
  await assert.rejects(store.get('claude-main'), error => error.code === 'profile_revision_invalid');

  const leakedValue = 'manual-secret-value-never-returned';
  const withSecretField = { ...saved, credential: { ...saved.credential, value: leakedValue } };
  withSecretField.revision = revisionFor(withSecretField);
  await writeFile(file, `${JSON.stringify(withSecretField, null, 2)}\n`);
  await assert.rejects(
    store.get('claude-main'),
    error => error.code === 'profile_secret_literal' && !JSON.stringify(error).includes(leakedValue),
  );

  const good = { ...saved, revision: revisionFor(saved) };
  await writeFile(file, `${JSON.stringify(good, null, 2)}\n`);
  assert.equal((await store.list()).length, 1);

  const unknownSecret = { ...saved, secret: leakedValue };
  unknownSecret.revision = revisionFor(unknownSecret);
  await writeFile(file, `${JSON.stringify(unknownSecret, null, 2)}\n`);
  await assert.rejects(
    store.list(),
    error => error.code === 'profile_secret_literal' && !JSON.stringify(error).includes(leakedValue),
  );
});

test('ProfileStore resolve returns immutable public snapshots and native source checks are no-op', async t => {
  const store = new ProfileStore({ root: await root(t) });
  await store.put(profile());
  const snapshot = await store.resolve('claude-main');
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(snapshot.id, 'claude-main');
  assert.equal(await store.assertSourceCurrent(snapshot), true);
});
