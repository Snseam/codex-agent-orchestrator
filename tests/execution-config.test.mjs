import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareExecution, cleanupExecution } from '../src/execution-config.mjs';

async function root(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-exec-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function gateway(directory, { id = 'gw1', protocol = 'anthropic', token = 'local-token-for-test' } = {}) {
  const tokenFile = path.join(directory, `${id}.token`);
  await fs.writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  return { id, protocol, endpoint: `http://127.0.0.1/${id}`, tokenFile };
}

function profile(id, agent, overrides = {}) {
  const protocol = { claude: 'anthropic', codex: 'openai-responses', pi: 'openai-chat', opencode: 'openai-chat' }[agent];
  return {
    id,
    revision: `rev-${id}`,
    agent,
    model: `${id}-model`,
    protocol,
    capabilities: ['coding', 'reasoning'],
    modelMap: {},
    ...overrides,
  };
}

function task(agent, overrides = {}) {
  return {
    id: `task-${agent}`,
    agent,
    objective: 'Exercise execution config.',
    allowedPaths: ['src/math.mjs'],
    checks: [{ name: 'noop', argv: [process.execPath, '-e', ''] }],
    agentArgs: [],
    ...overrides,
  };
}

function attempt(directory, id = 'attempt-a1') {
  return {
    id,
    number: 1,
    directory,
    nonce: 'nonce',
    resultFile: path.join(directory, 'result.json'),
  };
}

async function prepare(t, agent, { taskOverrides = {}, profileOverrides = {}, gatewayOverrides = {}, environment = {} } = {}) {
  const directory = await root(t);
  const attemptDirectory = path.join(directory, 'attempt');
  await fs.mkdir(attemptDirectory, { recursive: true });
  const selected = profile(`${agent}-profile`, agent, profileOverrides);
  const gw = await gateway(directory, { protocol: selected.protocol, ...gatewayOverrides });
  const manifest = await prepareExecution({
    task: task(agent, taskOverrides),
    attempt: attempt(attemptDirectory),
    profile: selected,
    gateway: gw,
    environment,
  });
  return { directory, attemptDirectory, selected, gw, manifest };
}

test('profiled configs keep local tokens out of manifest and argv while isolating private files per profile', async t => {
  const first = await prepare(t, 'codex', { gatewayOverrides: { id: 'gw-a', token: 'token-a-secret' }, profileOverrides: { model: 'model-a' } });
  const second = await prepare(t, 'codex', { gatewayOverrides: { id: 'gw-b', token: 'token-b-secret' }, profileOverrides: { id: 'codex-profile-b', model: 'model-b' } });

  assert.notEqual(first.manifest.privateDirectory, second.manifest.privateDirectory);
  assert.notDeepEqual(first.manifest.args, second.manifest.args);
  for (const token of ['token-a-secret', 'token-b-secret']) {
    assert.doesNotMatch(JSON.stringify(first.manifest), new RegExp(token));
    assert.doesNotMatch(JSON.stringify(second.manifest), new RegExp(token));
    assert.ok(!first.manifest.args.some(arg => arg.includes(token)));
    assert.ok(!second.manifest.args.some(arg => arg.includes(token)));
  }
  assert.equal(first.manifest.globalConfigMutation, false);
  assert.equal(second.manifest.globalConfigMutation, false);
});

test('bootstrap reveals only split ready marker material, never the full marker as terminal text', async t => {
  const { manifest } = await prepare(t, 'claude');
  const settings = JSON.parse(await fs.readFile(path.join(manifest.privateDirectory, 'claude-settings.json'), 'utf8'));
  assert.equal(settings.env.ANTHROPIC_API_KEY, '');
  assert.ok(settings.env.ANTHROPIC_AUTH_TOKEN);
  assert.match(manifest.readyMarker, /^CAO_ENV_/);
  assert.ok(!manifest.bootstrap.includes(manifest.readyMarker));
  assert.ok(!/echo\s+CAO_ENV_/.test(manifest.bootstrap));
  assert.match(manifest.bootstrap, /printf '\\nCAO_ENV_%s\\n'/);
});

test('agent launch args preserve safe native args and do not mutate configured global roots', async t => {
  const environmentRoot = await root(t);
  const cases = [
    ['claude', { agentArgs: ['--permission-mode', 'acceptEdits'] }, ['--permission-mode', 'acceptEdits'], { CLAUDE_CONFIG_DIR: path.join(environmentRoot, 'claude') }],
    ['codex', { agentArgs: ['-c', 'model_reasoning_effort="low"'] }, ['-c', 'model_reasoning_effort="low"'], { CODEX_HOME: path.join(environmentRoot, 'codex') }],
    ['pi', { agentArgs: ['--debug'] }, ['--debug'], { PI_CODING_AGENT_SESSION_DIR: path.join(environmentRoot, 'pi-sessions') }],
    ['opencode', { agentArgs: ['--continue-session'] }, ['--continue-session'], { XDG_DATA_HOME: path.join(environmentRoot, 'xdg') }],
  ];

  for (const [agent, taskOverrides, expectedArgs, env] of cases) {
    const { manifest } = await prepare(t, agent, { taskOverrides, environment: env });
    for (const expected of expectedArgs) assert.ok(manifest.args.includes(expected), `${agent} should preserve ${expected}`);
    assert.equal(manifest.globalConfigMutation, false);
  }

  assert.deepEqual(await fs.readdir(environmentRoot), []);
});

test('profile-owned model/session/config arguments are rejected before writing native config', async t => {
  const conflicts = [
    ['claude', ['--model', 'sonnet']],
    ['codex', ['-m', 'gpt-test']],
    ['codex', ['-c', 'model_provider="danger"']],
    ['pi', ['--provider', 'anthropic']],
    ['opencode', ['-m', 'provider/model']],
  ];
  for (const [agent, agentArgs] of conflicts) {
    await assert.rejects(
      prepare(t, agent, { taskOverrides: { agentArgs } }),
      error => error.code === 'execution_argument_conflict',
      `${agent} ${agentArgs.join(' ')} should be rejected`,
    );
  }
});

test('cleanup removes unchanged owned files, retains changed files, and rejects owner replacement', async t => {
  const { manifest } = await prepare(t, 'pi');
  const changed = manifest.files[0].path;
  await fs.appendFile(changed, '\nchanged by test');
  const cleanup = await cleanupExecution(manifest);
  assert.ok(cleanup.retained.includes(changed));
  for (const file of manifest.files.filter(file => file.path !== changed)) {
    await assert.rejects(fs.lstat(file.path), error => error.code === 'ENOENT');
    assert.ok(cleanup.removed.includes(file.path));
  }

  const other = await prepare(t, 'opencode');
  const saved = JSON.parse(await fs.readFile(path.join(other.manifest.privateDirectory, 'manifest.json'), 'utf8'));
  saved.ownerNonce = 'different-owner';
  await fs.writeFile(path.join(other.manifest.privateDirectory, 'manifest.json'), JSON.stringify(saved));
  await assert.rejects(cleanupExecution(other.manifest), error => error.code === 'execution_owner_changed');
});

test('cleanup refuses an execution directory replaced by a symlink', async t => {
  const { manifest } = await prepare(t, 'claude');
  const original = `${manifest.privateDirectory}.original`;
  await fs.rename(manifest.privateDirectory, original);
  await fs.symlink(original, manifest.privateDirectory);
  await assert.rejects(cleanupExecution(manifest), error => error.code === 'execution_owner_changed');
});
