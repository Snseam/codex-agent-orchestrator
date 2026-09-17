import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CalibrationRunner, observeClaudeStream } from '../src/calibration/runner.mjs';
import { listReservations, reserveExecution, releaseExecution } from '../src/routing.mjs';
import { runCommand } from '../src/process.mjs';

async function setup(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-probe-test-')); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'state'), home = path.join(base, 'home');
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'PRIVATE_TEST_KEY', ANTHROPIC_BASE_URL: 'http://127.0.0.1:45678', ANTHROPIC_MODEL: 'test-model' }, hooks: { secret: 'must-not-copy' } }));
  const resource = { id: 'native-claude', kind: 'native', agent: 'claude', installed: true, fingerprint: 'test-fingerprint', requestedModel: 'test-model', executable: 'claude' };
  const resources = { discover: async () => ({ resources: [resource] }) };
  const calls = [];
  let clock = 1700000000000;
  const command = async (argv, opts) => {
    calls.push({ argv, ...opts }); clock += 10;
    if (argv.includes('--help')) return { code: 0, stdout: '--safe-mode --restricted --no-session-persistence' };
    if (argv[0] === process.execPath) return runCommand(argv, opts);
    assert.equal(opts.env.ANTHROPIC_AUTH_TOKEN, 'PRIVATE_TEST_KEY');
    assert.notEqual(opts.env.HOME, home);
    assert.notEqual(opts.env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'));
    assert.ok(argv.includes('--no-session-persistence'));
    const prompt = argv[argv.indexOf('-p') + 1];
    if (prompt.startsWith('Fix unique.mjs')) await fs.writeFile(path.join(opts.cwd, 'unique.mjs'), 'export const uniqueStrings = xs => [...new Set(xs.filter(x=>typeof x==="string").map(x=>x.trim()).filter(Boolean))];');
    opts.onStdout(Buffer.from(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } } }) + '\n'));
    clock += 100;
    const value = prompt.match(/cao_[a-f0-9]+/)?.[0] || 'Done';
    opts.onStdout(Buffer.from(JSON.stringify({ type: 'assistant', message: { model: 'test-model' } }) + '\n' + JSON.stringify({ type: 'result', is_error: false, result: value, usage: { output_tokens: 5 } }) + '\n'));
    return { code: 0, stdout: '', stderr: '', truncated: false };
  };
  const runner = new CalibrationRunner({ root, home, environment: { PATH: process.env.PATH, NODE_OPTIONS: 'do-not-forward' }, resources, command, now: () => clock, source: 'mock', ...options });
  return { runner, calls, root, home, resource };
}

test('quick probe isolates configuration, measures observed fields and removes its temporary roots', async t => {
  const { runner, calls, root, home } = await setup(t);
  const before = await fs.readFile(path.join(home, '.claude', 'settings.json'), 'utf8');
  const result = await runner.run({ resourceIds: ['native-claude'] });
  assert.equal(result.results[0].record.status, 'passed');
  assert.equal(result.results[0].record.source, 'mock');
  assert.ok(result.results[0].record.metrics.firstEventMs >= 0);
  assert.equal(calls.at(-1).env.NODE_OPTIONS, undefined);
  await assert.rejects(fs.stat(calls.at(-1).env.HOME), e => e.code === 'ENOENT');
  assert.equal(await fs.readFile(path.join(home, '.claude', 'settings.json'), 'utf8'), before);
  assert.deepEqual(await listReservations(root), []);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TEST_KEY|must-not-copy|cao_[a-f0-9]{24}/);
});

test('code probe uses an independent verifier, not the agent final message', async t => {
  const { runner, calls } = await setup(t);
  const result = await runner.run({ resourceIds: ['native-claude'], suite: 'code' });
  assert.equal(result.results[0].record.status, 'passed');
  assert.ok(calls.some(c => c.argv[0] === process.execPath));
  assert.equal(result.results[0].record.metrics.tokensPerSecond, null);
});

test('OAuth-only native authentication is not copied into an isolated probe', async t => {
  const { runner, calls, home } = await setup(t);
  await fs.writeFile(path.join(home, '.claude', 'settings.json'), '{}');
  const result = await runner.run({ resourceIds: ['native-claude'] });
  assert.equal(result.results[0].record.status, 'unavailable');
  assert.equal(result.results[0].record.errorCode, 'native_probe_auth_unavailable');
  assert.equal(calls.length, 0);
});

test('unsafe/incompatible CLI cannot start a model and unavailable resources stay explicit', async t => {
  const { runner } = await setup(t, { command: async () => ({ code: 0, stdout: 'old CLI' }) });
  const result = await runner.run({ resourceIds: ['native-claude'] });
  assert.equal(result.results[0].record.errorCode, 'probe_isolation_unavailable');
  await assert.rejects(runner.run({ resourceIds: ['unknown'] }), e => e.code === 'resource_not_found');
  await assert.rejects(runner.run({ resourceIds: ['native-claude'], timeoutMs: 9999999 }), e => e.code === 'invalid_calibration');
});

test('stream observation ignores setup events and only trusts explicit numeric usage', () => {
  let time = 0;
  const stream = observeClaudeStream({ now: () => time, startedAt: 0 });
  stream.onStdout(Buffer.from('{"type":"system"}\n')); time = 100;
  stream.onStdout(Buffer.from('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}}\n'));
  stream.onStdout(Buffer.from('{"type":"result","is_error":false,"usage":{"output_tokens":"123"}}'));
  assert.equal(stream.finish().firstEventMs, 100);
  assert.equal(stream.finish().outputTokens, null);
});

test('calibration capacity shares profile bucket and is retained until explicitly released', async t => {
  const { root } = await setup(t);
  const profile = { id: 'p', account: { id: 'same-account', maxParallel: 1 } };
  const reservation = await reserveExecution(root, profile, { runId: 'calibration-one', taskId: 'quick', attemptId: 'a' }, { ownerKind: 'calibration' });
  assert.equal((await listReservations(root))[0].ownerKind, 'calibration');
  await assert.rejects(reserveExecution(root, profile, { runId: 'normal-run', taskId: 't', attemptId: 'b' }), e => e.code === 'route_capacity_exhausted');
  await releaseExecution(root, reservation);
  assert.deepEqual(await listReservations(root), []);
});

test('process output observation receives chunks and observer failure terminates the owned process', async () => {
  let text = '';
  const result = await runCommand([process.execPath, '-e', 'process.stdout.write("ok")'], { onStdout: chunk => { text += chunk; } });
  assert.equal(result.code, 0); assert.equal(text, 'ok');
  await assert.rejects(runCommand([process.execPath, '-e', 'console.log("x");setInterval(()=>{},1000)'], { timeoutMs: 3000, onStdout: () => { throw new Error('secret'); } }), e => e.code === 'command_observer_failed' && !e.message.includes('secret'));
});
