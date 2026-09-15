import test from 'node:test';
import assert from 'node:assert/strict';
import { execPath } from 'node:process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCommand } from '../src/process.mjs';
import { Herdr, cleanHerdrEnv } from '../src/runtime/herdr.mjs';
import { buildLaunch, compilePrompt, capabilities } from '../src/adapters.mjs';
import { OrchestratorError } from '../src/errors.mjs';

test('runCommand executes argv without a shell and captures bounded output', async () => {
  const result = await runCommand([execPath, '-e', 'console.log(process.argv[1]); console.error("err")', 'hello world'], {
    maxBytes: 5,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'hello');
  assert.equal(result.stderr, 'err\n');
  assert.equal(result.truncated, true);
});

test('runCommand strips NODE_TEST_CONTEXT so nested node --test failures are real failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cao-node-test-'));
  try {
    const testFile = join(directory, 'fail.test.mjs');
    await writeFile(testFile, `
      import test from 'node:test';
      import assert from 'node:assert/strict';
      test('real failure', () => assert.equal(1, 2, 'intentional failure'));
    `);
    const result = await runCommand([execPath, '--test', testFile], {
      env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8' },
      timeoutMs: 10000,
      maxBytes: 100000,
    });
    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /intentional failure|not ok/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /recursively skipping running files/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runCommand rejects on timeout after cleaning up the owned process', async () => {
  await assert.rejects(
    runCommand([execPath, '-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 50 }),
    (error) => error instanceof OrchestratorError && error.code === 'command_timeout',
  );
});

test('runCommand timeout kills a grandchild that ignores TERM and holds stdout open', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cao-timeout-'));
  const pidFile = join(directory, 'child.pid');
  try {
    const shellCode = `trap '' TERM; echo $$ > ${JSON.stringify(pidFile)}; while :; do printf x; sleep 0.01; done`;
    const leaderCode = `trap 'exit 0' TERM; /bin/sh -c ${shellQuote(shellCode)} & wait`;
    const started = Date.now();
    const promise = runCommand(['/bin/sh', '-c', leaderCode], { timeoutMs: 2000, maxBytes: 128 });
    const rejection = assert.rejects(
      promise,
      (error) => error instanceof OrchestratorError && error.code === 'command_timeout',
    );
    while (!existsSync(pidFile) && Date.now() - started < 1500) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(existsSync(pidFile), 'child process should start within the test startup budget before timeout');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.equal(processExists(pid), true, 'grandchild should be running before timeout');
    await rejection;
    assert.ok(Date.now() - started < 4500, 'timeout cleanup should not hang on grandchild stdout');
    assert.equal(await waitForProcessExit(pid), true, 'timed out command should not leave child process running');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runCommand rejects pre-aborted signals without spawning', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runCommand([`cao-should-not-spawn-${randomUUID()}`], { signal: controller.signal }),
    (error) => error instanceof OrchestratorError && error.code === 'command_cancelled',
  );
});

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processExists(pid);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

test('runCommand abort kills a grandchild that ignores TERM and holds stdout open', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cao-abort-'));
  const pidFile = join(directory, 'child.pid');
  try {
    const childCode = `
      process.on("SIGTERM", () => {});
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => process.stdout.write("x"), 10);
    `;
    const script = `
      const { spawn } = require('node:child_process');
      process.on('SIGTERM', () => process.exit(0));
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {
        stdio: ['ignore', 'pipe', 'ignore']
      });
      child.stdout.pipe(process.stdout);
      setInterval(() => {}, 1000);
    `;
    const controller = new AbortController();
    const promise = runCommand([execPath, '-e', script], { signal: controller.signal, timeoutMs: 0, maxBytes: 128 });
    const started = Date.now();
    while (!existsSync(pidFile) && Date.now() - started < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(existsSync(pidFile), 'child process should have started before abort');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    controller.abort();
    await assert.rejects(
      promise,
      (error) => error instanceof OrchestratorError && error.code === 'command_cancelled',
    );
    assert.equal(await waitForProcessExit(pid), true, 'aborted command should not leave child process running');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test('runCommand waits for abort escalation before rejecting when grandchild ignores TERM without holding stdout open', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cao-abort-detached-stdout-'));
  const pidFile = join(directory, 'child.pid');
  let pid;
  try {
    const childCode = `
      process.on("SIGTERM", () => {});
      process.stdout.on("error", () => {});
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => { try { process.stdout.write("x"); } catch {} }, 10);
      setInterval(() => {}, 1000);
    `;
    const script = `
      const { spawn } = require('node:child_process');
      process.on('SIGTERM', () => process.exit(0));
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {
        stdio: ['ignore', 'pipe', 'ignore']
      });
      child.stdout.pipe(process.stdout);
      setInterval(() => {}, 1000);
    `;
    const controller = new AbortController();
    const promise = runCommand([execPath, '-e', script], { signal: controller.signal, timeoutMs: 0, maxBytes: 128 });
    const started = Date.now();
    while (!existsSync(pidFile) && Date.now() - started < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(existsSync(pidFile), 'child process should have started before abort');
    pid = Number(readFileSync(pidFile, 'utf8'));
    assert.equal(processExists(pid), true, 'grandchild should be running before abort');
    controller.abort();
    await assert.rejects(
      promise,
      (error) => error instanceof OrchestratorError && error.code === 'command_cancelled',
    );
    assert.equal(await waitForProcessExit(pid, 1000), true, 'abort rejection should happen only after cleanup escalation can kill the orphaned grandchild');
  } finally {
    if (pid && processExists(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
});


test('runCommand rejects invalid argv', async () => {
  await assert.rejects(
    runCommand('echo hi'),
    (error) => error instanceof OrchestratorError && error.code === 'invalid_command',
  );
});

test('runCommand rejects asynchronous spawn ENOENT', async () => {
  await assert.rejects(
    runCommand([`cao-missing-${randomUUID()}`]),
    (error) => error instanceof OrchestratorError && error.code === 'command_spawn_failed',
  );
});

test('cleanHerdrEnv removes inherited pane/session routing without dropping ordinary env', () => {
  const env = cleanHerdrEnv({
    PATH: '/bin',
    HERDR_SOCKET_PATH: '/tmp/socket',
    HERDR_SESSION: 'default',
    HERDR_PANE_ID: 'w1:p1',
    HERDR_CONFIG_PATH: '/custom/config.toml',
    HERDR_ACTIVE_MACHINE: 'remote',
    HERDR_ACTIVE_WORKSPACE_ID: 'w1',
    HERDR_ENV: '1',
  });
  assert.deepEqual(env, {
    PATH: '/bin',
  });
});

test('Herdr methods build explicit session argv and parse JSON envelopes', async () => {
  const calls = [];
  const runner = async (argv, options = {}) => {
    calls.push({ argv, env: options.env, timeoutMs: options.timeoutMs });
    if (argv.includes('session') && argv.includes('list')) {
      return { code: 0, stdout: '{"sessions":[{"name":"cao-x"}]}', stderr: '', truncated: false };
    }
    if (argv.includes('agent') && argv.includes('prompt')) {
      return { code: 0, stdout: '{"id":"cli:agent:prompt","result":{"ok":true}}', stderr: '', truncated: false };
    }
    if (argv.includes('agent') && argv.includes('read')) {
      return { code: 0, stdout: 'visible text', stderr: '', truncated: false };
    }
    if (argv.includes('agent') && argv.includes('get')) {
      return { code: 1, stdout: '', stderr: '{"id":"x","error":{"code":"agent_not_found","message":"missing"}}', truncated: false };
    }
    if (argv.includes('pane') && argv.includes('get')) {
      return { code: 0, stdout: '{"id":"pane","result":{"pane":{"pane_id":"w1:p2","terminal_id":"t1","workspace_id":"w1","tab_id":"tab1","focused":false,"agent_status":"idle","revision":7}}}', stderr: '', truncated: false };
    }
    if (argv.includes('pane') && argv.includes('process-info')) {
      return {
        code: 0,
        stdout: '{"id":"process-info","result":{"process_info":{"foreground_process_group_id":25934,"shell_pid":25472,"foreground_processes":[{"pid":25934,"command":"claude"}],"pane_id":"w1:p2"}}}',
        stderr: '',
        truncated: false,
      };
    }
    if (argv.includes('workspace') && argv.includes('create')) {
      return { code: 0, stdout: '{"id":"workspace","result":{"ok":true}}', stderr: '', truncated: false };
    }
    return { code: 0, stdout: '{"id":"ok","result":{}}', stderr: '', truncated: false };
  };
  const herdr = new Herdr({ binary: 'herdr-test', runner });

  assert.deepEqual(await herdr.listSessions(), [{ name: 'cao-x' }]);
  await herdr.prompt('cao-run', 'worker', 'do it', 0);
  await herdr.prompt('cao-run', 'worker', 'wait it', 1200);
  assert.equal(await herdr.readAgent('cao-run', 'worker', 12), 'visible text');
  await assert.rejects(
    herdr.getAgent('cao-run', 'missing'),
    (error) => error instanceof OrchestratorError && error.code === 'agent_not_found',
  );
  assert.equal((await herdr.getPane('cao-run', 'w1:p2')).result.pane.pane_id, 'w1:p2');
  assert.equal((await herdr.getProcessInfo('cao-run', 'w1:p2')).result.process_info.shell_pid, 25472);
  await herdr.createWorkspace('cao-run', '/repo', 'Work');

  assert.deepEqual(calls[0].argv, ['herdr-test', 'session', 'list', '--json']);
  assert.deepEqual(calls[1].argv, ['herdr-test', '--session', 'cao-run', 'agent', 'prompt', 'worker', 'do it']);
  assert.ok(!calls[1].argv.includes('--wait'));
  assert.deepEqual(calls[2].argv, [
    'herdr-test', '--session', 'cao-run', 'agent', 'prompt', 'worker', 'wait it',
    '--wait', '--until', 'idle', '--until', 'done', '--until', 'blocked', '--timeout', '1200',
  ]);
  assert.equal(calls[2].timeoutMs, 6200);
  assert.deepEqual(calls[3].argv, [
    'herdr-test', '--session', 'cao-run', 'agent', 'read', 'worker',
    '--source', 'visible', '--lines', '12', '--format', 'text',
  ]);
  assert.deepEqual(calls.find((call) => call.argv.includes('workspace'))?.argv, [
    'herdr-test', '--session', 'cao-run', 'workspace', 'create',
    '--cwd', '/repo', '--no-focus', '--label', 'Work',
  ]);
  assert.deepEqual(calls.find((call) => call.argv.includes('pane') && call.argv.includes('get'))?.argv, [
    'herdr-test', '--session', 'cao-run', 'pane', 'get', 'w1:p2',
  ]);
  assert.deepEqual(calls.find((call) => call.argv.includes('process-info'))?.argv, [
    'herdr-test', '--session', 'cao-run', 'pane', 'process-info', '--pane', 'w1:p2',
  ]);
});

test('Herdr recognizes stderr JSON envelopes for readAgent errors', async () => {
  const herdr = new Herdr({
    binary: 'herdr-test',
    runner: async () => ({
      code: 1,
      stdout: '',
      stderr: '{"id":"read","error":{"code":"server_not_running","message":"server absent"}}',
      truncated: false,
    }),
  });
  await assert.rejects(
    herdr.readAgent('cao-run', 'worker'),
    (error) => error instanceof OrchestratorError && error.code === 'server_not_running',
  );
});

test('Herdr refuses default sessions for server-affecting operations', async () => {
  const herdr = new Herdr({ runner: async () => ({ code: 0, stdout: '{}', stderr: '', truncated: false }) });
  assert.throws(
    () => herdr.stopServer('default'),
    (error) => error instanceof OrchestratorError && error.code === 'invalid_session',
  );
  await assert.rejects(
    herdr.ensureServer('', '/tmp/nope.log'),
    (error) => error instanceof OrchestratorError && error.code === 'invalid_session',
  );
});

test('Herdr ensureServer rejects async spawn ENOENT without unhandled errors', async () => {
  const herdr = new Herdr({
    binary: `cao-missing-${randomUUID()}`,
    runner: async () => ({
      code: 1,
      stdout: '',
      stderr: '{"id":"snapshot","error":{"code":"server_not_running","message":"absent"}}',
      truncated: false,
    }),
  });
  await assert.rejects(
    herdr.ensureServer(`cao-spawn-${randomUUID().slice(0, 8)}`, join(tmpdir(), `cao-spawn-${randomUUID()}.log`)),
    (error) => error instanceof OrchestratorError && error.code === 'herdr_server_spawn_failed',
  );
});

test('buildLaunch preserves provider settings and only adds Claude attempt directory', () => {
  const task = { agent: 'claude', agentArgs: ['--model', 'keep-me'] };
  assert.deepEqual(buildLaunch(task, '/tmp/attempt'), {
    kind: 'claude',
    args: ['--add-dir', '/tmp/attempt', '--model', 'keep-me'],
  });
  assert.deepEqual(buildLaunch({ agent: 'pi', agentArgs: ['--foo'] }, '/tmp/attempt'), {
    kind: 'pi',
    args: ['--foo'],
  });
  assert.equal(capabilities.pi.maxChildren, 'reported in prompt contract only');
});

test('compilePrompt includes result contract, allowed paths, checks, and final marker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cao-runtime-'));
  try {
    const prompt = compilePrompt({
      id: 'task1',
      objective: 'Fix the parser',
      role: 'implementer',
      allowedPaths: ['src/parser.mjs', 'tests/'],
      checks: [{ name: 'unit', argv: ['node', '--test'], timeoutMs: 60000 }],
      nativeInstructions: 'Use native review children only if configured.',
      maxChildren: 2,
    }, {
      id: 'attempt1',
      taskId: 'task1',
      number: 1,
      nonce: 'abc',
      cwd: '/repo',
      directory,
      resultFile: join(directory, 'result.json'),
      feedback: 'Previous check failed.',
    });
    assert.match(prompt, /Fix the parser/);
    assert.match(prompt, /src\/parser\.mjs/);
    assert.match(prompt, /\["node","--test"\]/);
    assert.match(prompt, /"status": "submitted"/);
    assert.match(prompt, /CAO_RESULT attempt1/);
    assert.match(prompt, /Do not claim tests or commands that were not run/);
    assert.match(prompt, /You may write the result file/);
    assert.match(prompt, /do not start child\/subagent\/team work/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
