import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { preparePiProbe, observePiStream } from '../src/calibration/pi.mjs';

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-pi-calibration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeNativePi(home, { settings, models, auth }) {
  const directory = path.join(home, '.pi', 'agent');
  await fs.mkdir(directory, { recursive: true });
  if (settings) await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify(settings));
  if (models) await fs.writeFile(path.join(directory, 'models.json'), JSON.stringify(models));
  if (auth) await fs.writeFile(path.join(directory, 'auth.json'), JSON.stringify(auth));
}

test('legacy-only Pi settings use the same selection without copying unrelated credentials', async t => {
  const root = await temporary(t), home = path.join(root, 'home');
  await writeNativePi(home, { auth: { legacy: { type: 'api_key', key: 'private-legacy-key' } } });
  await fs.writeFile(path.join(home, '.pi', 'settings.json'), JSON.stringify({ defaultProvider: 'legacy', defaultModel: 'model' }));
  const prepared = await preparePiProbe({ id: 'native-pi', kind: 'native', agent: 'pi' }, { directory: path.join(root, 'probe'), home, environment: {}, suite: 'quick' });
  assert.equal(prepared.providerId, 'legacy'); assert.equal(prepared.model, 'model');
});

test('Pi provider failures retain only a classified code and nested usage is collected', () => {
  const observer = observePiStream();
  observer.onStdout(Buffer.from(JSON.stringify({ type: 'turn_end', message: { role: 'assistant', model: 'm', stopReason: 'error', errorMessage: '401 authentication PRIVATE', usage: { output: 0 } } }) + '\n'));
  const result = observer.finish();
  assert.equal(result.failureCode, 'probe_auth_failed'); assert.equal(result.result.is_error, true);
  assert.equal(result.outputTokens, 0); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test('preparePiProbe isolates native Pi with selected API-key provider only', async t => {
  const root = await temporary(t);
  const home = path.join(root, 'home');
  const directory = path.join(root, 'probe');
  await writeNativePi(home, {
    settings: { defaultProvider: 'kimi-coding', defaultModel: 'k3' },
    models: {
      providers: {
        'kimi-coding': {
          name: 'Kimi',
          baseUrl: 'https://kimi.example.invalid/v1',
          api: 'openai-completions',
          apiKey: '!security should-not-run',
          models: [{ id: 'k3', name: 'K3', reasoning: true, input: ['text', 'image'], contextWindow: 200000, maxTokens: 12000 }],
        },
        other: { name: 'Other', baseUrl: 'https://other.example.invalid/v1', api: 'openai-completions', models: [{ id: 'x' }] },
      },
    },
    auth: {
      'kimi-coding': { type: 'api_key', key: 'native-secret' },
      other: { type: 'api_key', key: 'other-secret' },
    },
  });

  const prepared = await preparePiProbe(
    { id: 'native-pi', kind: 'native', agent: 'pi', providerId: 'kimi-coding', requestedModel: 'kimi-coding/k3' },
    { directory, home, environment: { PATH: '/bin', TMPDIR: '/tmp' }, suite: 'quick' },
  );

  assert.equal(prepared.model, 'k3');
  assert.equal(prepared.providerId, 'kimi-coding');
  assert.equal(prepared.capacityProfile.endpoint, 'https://kimi.example.invalid/v1');
  assert.deepEqual(prepared.env, {
    PATH: '/bin',
    TMPDIR: '/tmp',
    HOME: directory,
    USERPROFILE: directory,
    PI_CODING_AGENT_DIR: path.join(directory, 'pi'),
    PI_CODING_AGENT_SESSION_DIR: path.join(directory, 'sessions'),
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
  });
  assert.ok(prepared.argv.includes('--print'));
  assert.ok(prepared.argv.includes('--mode'));
  assert.ok(prepared.argv.includes('json'));
  assert.ok(prepared.argv.includes('--no-session'));
  assert.ok(prepared.argv.includes('--offline'));
  assert.ok(prepared.argv.includes('--no-extensions'));
  assert.ok(prepared.argv.includes('--no-skills'));
  assert.ok(prepared.argv.includes('--no-prompt-templates'));
  assert.ok(prepared.argv.includes('--no-themes'));
  assert.ok(prepared.argv.includes('--no-context-files'));
  assert.ok(prepared.argv.includes('--no-approve'));
  assert.ok(prepared.argv.includes('--no-tools'));
  assert.equal(prepared.argv.includes('--tools'), false);

  const isolatedAuth = JSON.parse(await fs.readFile(path.join(directory, 'pi', 'auth.json'), 'utf8'));
  assert.deepEqual(isolatedAuth, { 'kimi-coding': { type: 'api_key', key: 'native-secret' } });
  const isolatedModels = JSON.parse(await fs.readFile(path.join(directory, 'pi', 'models.json'), 'utf8'));
  assert.deepEqual(Object.keys(isolatedModels.providers), ['kimi-coding']);
  assert.equal(JSON.stringify(isolatedModels).includes('native-secret'), false);
  assert.equal(JSON.stringify(isolatedModels).includes('other-secret'), false);
});

test('preparePiProbe respects PI_CODING_AGENT_DIR and env-referenced model credentials without evaluating command values', async t => {
  const root = await temporary(t);
  const home = path.join(root, 'home');
  const configuredPiDir = path.join(root, 'configured-pi');
  const directory = path.join(root, 'probe');
  await fs.mkdir(configuredPiDir, { recursive: true });
  await fs.writeFile(path.join(configuredPiDir, 'settings.json'), JSON.stringify({ defaultProvider: 'custom', defaultModel: 'model-a' }));
  await fs.writeFile(path.join(configuredPiDir, 'models.json'), JSON.stringify({
    providers: { custom: { name: 'Custom', baseUrl: 'https://custom.example.invalid/v1', api: 'openai-completions', apiKey: '$CUSTOM_KEY', models: [{ id: 'model-a' }] } },
  }));
  await fs.writeFile(path.join(configuredPiDir, 'auth.json'), '{}');
  await writeNativePi(home, {
    settings: { defaultProvider: 'custom', defaultModel: 'model-a' },
    models: { providers: { custom: { name: 'Wrong', baseUrl: 'https://wrong.example.invalid/v1', api: 'openai-completions', apiKey: '!echo should-not-read', models: [{ id: 'model-a' }] } } },
    auth: {},
  });

  const prepared = await preparePiProbe(
    { id: 'native-pi', kind: 'native', agent: 'pi' },
    { directory, home, environment: { PATH: '/bin', CUSTOM_KEY: 'env-secret', PI_CODING_AGENT_DIR: configuredPiDir }, suite: 'code' },
  );
  assert.equal(prepared.argv.includes('--no-tools'), false);
  assert.equal(prepared.argv.at(prepared.argv.indexOf('--tools') + 1), 'read,edit,write');
  const isolatedAuth = JSON.parse(await fs.readFile(path.join(directory, 'pi', 'auth.json'), 'utf8'));
  assert.deepEqual(isolatedAuth, { custom: { type: 'api_key', key: 'env-secret' } });

  const commandDirectory = path.join(root, 'command-probe');
  await writeNativePi(path.join(root, 'command-home'), {
    settings: { defaultProvider: 'custom', defaultModel: 'model-a' },
    models: { providers: { custom: { baseUrl: 'https://custom.example.invalid/v1', api: 'openai-completions', apiKey: '!echo secret', models: [{ id: 'model-a' }] } } },
    auth: {},
  });
  await assert.rejects(
    preparePiProbe({ id: 'native-pi', kind: 'native', agent: 'pi' }, { directory: commandDirectory, home: path.join(root, 'command-home'), environment: { PATH: '/bin' } }),
    error => error.code === 'native_probe_auth_unsupported',
  );
});

test('preparePiProbe rejects OAuth-only and missing native provider or model clearly', async t => {
  const root = await temporary(t);
  const home = path.join(root, 'home');
  await writeNativePi(home, {
    settings: { defaultProvider: 'openai-codex', defaultModel: 'gpt-5' },
    auth: { 'openai-codex': { type: 'oauth', access: 'access-secret', refresh: 'refresh-secret' } },
  });

  await assert.rejects(
    preparePiProbe({ id: 'native-pi', kind: 'native', agent: 'pi' }, { directory: path.join(root, 'probe'), home, environment: { PATH: '/bin' } }),
    error => error.code === 'native_probe_auth_unsupported',
  );

  const missingHome = path.join(root, 'missing-home');
  await assert.rejects(
    preparePiProbe({ id: 'native-pi', kind: 'native', agent: 'pi' }, { directory: path.join(root, 'missing'), home: missingHome, environment: { PATH: '/bin' } }),
    error => error.code === 'native_probe_config_unavailable',
  );
  await writeNativePi(path.join(root, 'no-model-home'), {
    settings: { defaultProvider: 'custom' },
    auth: { custom: { type: 'api_key', key: 'secret' } },
  });
  await assert.rejects(
    preparePiProbe({ id: 'native-pi', kind: 'native', agent: 'pi' }, { directory: path.join(root, 'no-model'), home: path.join(root, 'no-model-home'), environment: { PATH: '/bin' } }),
    error => error.code === 'probe_model_unknown',
  );

  await writeNativePi(path.join(root, 'slash-home'), {
    settings: { defaultProvider: 'openrouter', defaultModel: 'anthropic/claude-3.5-sonnet' },
    auth: { openrouter: { type: 'api_key', key: 'secret' } },
  });
  const slash = await preparePiProbe({ id: 'native-pi', kind: 'native', agent: 'pi' }, { directory: path.join(root, 'slash'), home: path.join(root, 'slash-home'), environment: { PATH: '/bin' } });
  assert.equal(slash.providerId, 'openrouter');
  assert.equal(slash.model, 'anthropic/claude-3.5-sonnet');
});

test('preparePiProbe maps Pi profiles to isolated custom providers', async t => {
  const root = await temporary(t);
  const profile = {
    id: 'pi-profile',
    agent: 'pi',
    protocol: 'openai-responses',
    endpoint: 'http://127.0.0.1:8080',
    model: 'response-model',
    credential: { type: 'env', name: 'PROFILE_KEY' },
    capabilities: ['coding'],
    modelMetadata: { contextWindow: 64000, maxOutputTokens: 4096 },
  };

  const prepared = await preparePiProbe(
    { id: 'profile-pi-profile', kind: 'profile', profileId: 'pi-profile', agent: 'pi', profile },
    { directory: path.join(root, 'probe'), home: path.join(root, 'home'), environment: { PATH: '/bin', PROFILE_KEY: 'profile-secret' }, suite: 'code' },
  );

  assert.equal(prepared.model, 'response-model');
  assert.match(prepared.providerId, /^cao_calibration_/);
  assert.equal(prepared.capacityProfile, profile);
  const models = JSON.parse(await fs.readFile(path.join(root, 'probe', 'pi', 'models.json'), 'utf8'));
  const provider = models.providers[prepared.argv.at(prepared.argv.indexOf('--provider') + 1)];
  assert.equal(provider.api, 'openai-responses');
  assert.equal(provider.baseUrl, 'http://127.0.0.1:8080/v1');
  assert.equal(provider.apiKey, 'profile-secret');
  assert.equal(provider.models[0].contextWindow, 64000);
  assert.equal(provider.models[0].maxTokens, 4096);
});

test('observePiStream parses JSON-line fixtures into the calibration result shape', () => {
  let clock = 1000;
  const stream = observePiStream({ now: () => clock, startedAt: 900 });
  stream.onStdout(Buffer.from(JSON.stringify({ type: 'session', id: 's1' }) + '\n'));
  clock = 1123;
  stream.onStdout(Buffer.from(JSON.stringify({
    type: 'message_update',
    usage: { outputTokens: 2 },
    assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
  }) + '\n'));
  stream.onStdout(Buffer.from(JSON.stringify({
    type: 'message_update',
    usage: { output_tokens: 3 },
    assistantMessageEvent: { type: 'text_delta', delta: ' world' },
  }) + '\n'));
  stream.onStdout(Buffer.from(JSON.stringify({
    type: 'turn_end',
    message: { role: 'assistant', model: 'kimi-k3', stopReason: 'stop', content: [{ type: 'text', text: 'hello world' }] },
  })));

  assert.deepEqual(stream.finish(), {
    result: { is_error: false, result: 'hello world', usage: { output_tokens: 3 } },
    servedModel: 'kimi-k3',
    firstEventMs: 223,
    outputTokens: 3,
  });
});

test('observePiStream caps output and keeps malformed lines out of public result', () => {
  const stream = observePiStream({ now: () => 0, startedAt: 0 });
  stream.onStdout(Buffer.from('{"secret":"not-json"\n'));
  assert.deepEqual(stream.finish(), { result: null, servedModel: null, firstEventMs: null, outputTokens: null });

  const tooLarge = observePiStream({ now: () => 0, startedAt: 0 });
  assert.throws(
    () => tooLarge.onStdout(Buffer.alloc(1024 * 1024 + 1)),
    error => error.code === 'calibration_output_limit',
  );
});

test('observePiStream requires terminal completion and maps output usage plus failed stops', () => {
  const partial = observePiStream({ now: () => 10, startedAt: 0 });
  partial.onStdout(Buffer.from(JSON.stringify({
    type: 'message_update',
    usage: { output: 5 },
    assistantMessageEvent: { type: 'text_delta', delta: 'partial' },
  }) + '\n'));
  assert.deepEqual(partial.finish(), { result: null, servedModel: null, firstEventMs: 10, outputTokens: 5 });

  const aborted = observePiStream({ now: () => 10, startedAt: 0 });
  aborted.onStdout(Buffer.from(JSON.stringify({
    type: 'turn_end',
    message: { role: 'assistant', model: 'k3', stopReason: 'aborted', content: [{ type: 'text', text: 'stopped' }] },
    usage: { output: 7 },
  }) + '\n'));
  assert.deepEqual(aborted.finish(), {
    result: { is_error: true, result: 'stopped', usage: { output_tokens: 7 } },
    servedModel: 'k3',
    firstEventMs: null,
    outputTokens: 7,
  });
});
