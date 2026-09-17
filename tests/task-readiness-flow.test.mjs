import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Orchestrator } from '../src/orchestrator.mjs';
import { ResourceService } from '../src/resources/index.mjs';
import { AdaptiveDispatcher } from '../src/adaptive-dispatch.mjs';
import { Herdr } from '../src/runtime/herdr.mjs';
import { fixture, task, FakeHerdr } from './helpers.mjs';

async function setup(t, { source = 'real' } = {}) {
  const f = await fixture(); t.after(f.remove);
  const home = path.join(f.base, 'home');
  const bin = path.join(home, 'bin');
  const config = path.join(home, '.pi', 'agent');
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(config, { recursive: true });
  await fs.writeFile(path.join(bin, 'pi'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await fs.writeFile(path.join(config, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture-oauth', defaultModel: 'fixture-model' }));
  // Synthetic auth shape only; never copied to a real runtime or provider.
  await fs.writeFile(path.join(config, 'auth.json'), JSON.stringify({ 'fixture-oauth': { type: 'oauth', access: 'FAKE_LOCAL_TEST', refresh: 'FAKE_LOCAL_TEST', expires: Date.now() + 100000 } }));
  const resources = new ResourceService({ root: f.stateRoot, home, environment: { HOME: home, PATH: bin } });
  const runtime = new FakeHerdr();
  // Simulate production provenance to exercise the controller contract offline.
  runtime.evidenceSource = source;
  const service = new Orchestrator({ stateRoot: f.stateRoot, herdr: runtime, resourceResolver: id => resources.get(id) });
  const run = await service.init({ project: f.project });
  return { ...f, home, config, resources, runtime, service, run };
}

test('an independently accepted native OAuth task supplies readiness to a later adaptive run without probing', async t => {
  const f = await setup(t);
  assert.equal((await f.resources.get('native-pi')).callVerification.state, 'unknown');
  const input = task({ agent: 'pi', execution: { native: true } });
  const launched = await f.service.dispatch(f.run.id, input);
  assert.equal(launched.attempt.resourceObservation.resourceId, 'native-pi');
  assert.equal((await f.resources.get('native-pi')).callVerification.state, 'unknown');
  await f.service.collect(f.run.id, input.id);
  assert.equal((await f.resources.get('native-pi')).callVerification.state, 'unknown');
  const accepted = await f.service.verify(f.run.id, input.id);
  assert.equal(accepted.attempt.status, 'accepted');
  assert.equal(accepted.attempt.readinessEvidence.state, 'recorded');
  const ready = await f.resources.get('native-pi');
  assert.equal(ready.callVerification.state, 'verified');
  assert.equal(ready.callVerification.source, 'verified-task');
  const second = await f.service.init({ project: f.project });
  const dispatcher = new AdaptiveDispatcher({ orchestrator: f.service, resources: f.resources });
  const selected = await dispatcher.dispatch(second.id, task({ id: 'second-task', agent: 'pi' }), { fixedExecutorKind: 'external', allowedResourceIds: ['native-pi'] });
  assert.equal(selected.attempt.routeDecision.resource.id, 'native-pi');
  assert.equal(f.runtime.starts, 2);
});

test('changed native configuration after launch cannot gain readiness from an old verified candidate', async t => {
  const f = await setup(t);
  const input = task({ agent: 'pi' });
  await f.service.dispatch(f.run.id, input);
  await f.service.collect(f.run.id, input.id);
  await fs.writeFile(path.join(f.config, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture-oauth', defaultModel: 'changed-model' }));
  const accepted = await f.service.verify(f.run.id, input.id);
  assert.equal(accepted.attempt.status, 'accepted');
  assert.equal(accepted.attempt.readinessEvidence.reason, 'resource_configuration_changed');
  assert.equal((await f.resources.get('native-pi')).callVerification.state, 'unknown');
});

test('mock runtimes and legacy model overrides do not establish native-default readiness', async t => {
  for (const variant of [{ source: 'mock', agentArgs: [] }, { source: 'real', agentArgs: ['--model', 'custom'] }]) {
    const f = await setup(t, variant);
    const input = task({ agent: 'pi', agentArgs: variant.agentArgs });
    const launched = await f.service.dispatch(f.run.id, input);
    assert.equal(launched.attempt.resourceObservation, undefined);
    await f.service.collect(f.run.id, input.id);
    assert.equal((await f.service.verify(f.run.id, input.id)).attempt.status, 'accepted');
    assert.equal((await f.resources.get('native-pi')).callVerification.state, 'unknown');
  }
});

test('Herdr labels injected transports conservatively and allows explicit mock API provenance', () => {
  assert.equal(new Herdr().evidenceSource, 'real');
  assert.equal(new Herdr({ runner: async () => ({ code: 0 }) }).evidenceSource, 'mock');
  assert.equal(new Herdr({ evidenceSource: 'mock' }).evidenceSource, 'mock');
  assert.throws(() => new Herdr({ evidenceSource: 'claimed' }), { code: 'invalid_evidence_source' });
});

test('project-local Pi overrides cannot establish readiness for the native user default', async t => {
  const f = await setup(t);
  await fs.mkdir(path.join(f.project, '.pi'));
  await fs.writeFile(path.join(f.project, '.pi', 'settings.json'), JSON.stringify({ defaultProvider: 'project-specific-provider' }));
  const input = task({ agent: 'pi' });
  const launched = await f.service.dispatch(f.run.id, input);
  assert.equal(launched.attempt.resourceObservation, undefined);
  await f.service.collect(f.run.id, input.id);
  assert.equal((await f.service.verify(f.run.id, input.id)).attempt.status, 'accepted');
  assert.equal((await f.resources.get('native-pi')).callVerification.state, 'unknown');
});
