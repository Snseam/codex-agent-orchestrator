import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Herdr } from '../src/runtime/herdr.mjs';
import { validateProfile } from '../src/profiles.mjs';
import { prepareExecution } from '../src/execution-config.mjs';
import { ResourceService } from '../src/resources/index.mjs';
import { CalibrationStore } from '../src/calibration/store.mjs';
import { PROBE_ENVIRONMENT } from '../src/calibration/environment.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-resource-runtime-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, '.nvm', 'versions', 'node', 'v22.22.0', 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'pi'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  return { root, bin };
}

test('Herdr makes a discovered NVM executable available only in its owned pane', async t => {
  const { root, bin } = await fixture(t);
  const env = { PATH: path.dirname(process.execPath), HOME: root };
  const calls = [];
  const herdr = new Herdr({ binary: process.execPath, environment: env, runner: async argv => { calls.push(argv); return { code: 0, stdout: '{"result":{}}', stderr: '' }; } });
  assert.equal((await herdr.preflight('pi')).agent.available, true);
  await herdr.startAgent('cao-test', 'worker', 'pi', 'pane');
  assert.ok(calls.some(argv => argv.includes('run') && argv.some(value => value.includes(`export PATH='${bin}'`))));
  assert.ok(calls.some(argv => argv.includes('wait-output')));
  assert.ok(calls.at(-1).includes('start'));
  assert.equal(env.PATH, path.dirname(process.execPath));
});

test('Pi model limits are explicit when declared and price placeholders remain unknown', async t => {
  const { root } = await fixture(t);
  const profile = validateProfile({ id: 'pi-test', agent: 'pi', model: 'configured-model', protocol: 'anthropic', endpoint: 'http://127.0.0.1:1', credential: { type: 'none' }, modelMetadata: { contextWindow: 1000000, maxOutputTokens: 128000 } });
  const directory = path.join(root, 'attempt'); await fs.mkdir(directory);
  const tokenFile = path.join(root, 'token'); await fs.writeFile(tokenFile, 'test-private-token');
  const manifest = await prepareExecution({ task: { agent: 'pi', agentArgs: [] }, attempt: { directory }, profile, gateway: { id: 'g', protocol: 'anthropic', endpoint: 'http://127.0.0.1:2', tokenFile } });
  const config = JSON.parse(await fs.readFile(path.join(directory, 'execution', 'pi-provider.json'), 'utf8'));
  assert.equal(config.models[0].contextWindow, 1000000);
  assert.equal(config.models[0].maxTokens, 128000);
  assert.equal(manifest.modelMetadata.source, 'profile-declared');
  assert.equal(manifest.modelMetadata.priceSource, 'unknown');
  assert.throws(() => validateProfile({ ...profile, modelMetadata: { contextWindow: 100, maxOutputTokens: 101 } }), e => e.code === 'invalid_profile');
});

test('resource call verification uses only fresh real evidence of the exact probe configuration', async t => {
  const { root, bin } = await fixture(t);
  const stateRoot = path.join(root, 'state');
  const service = new ResourceService({ root: stateRoot, home: root, environment: { PATH: bin } });
  const resource = (await service.discover({ agents: ['pi'] })).resources[0];
  assert.equal(resource.callVerification.state, 'unknown');
  const observedAt = Date.now();
  await new CalibrationStore({ root: stateRoot }).save({ schemaVersion: 1, resourceId: resource.id, fingerprint: resource.fingerprint,
    suiteId: 'quick', suiteVersion: '1', environmentFingerprint: PROBE_ENVIRONMENT, observedAt, expiresAt: observedAt + 10000,
    status: 'passed', source: 'real', metrics: {}, checks: [{ id: 'completed-response', passed: true }], errorCode: null, servedModel: 'observed-model', usageComplete: false });
  const checked = (await service.discover({ agents: ['pi'] })).resources[0];
  assert.equal(checked.callVerification.state, 'verified');
  assert.equal(checked.observedModel, 'observed-model');
});
