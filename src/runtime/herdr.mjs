import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { mkdirSync, openSync, closeSync, chmodSync } from 'node:fs';
import { runCommand } from '../process.mjs';
import { OrchestratorError } from '../errors.mjs';
import { executableAvailable } from '../preflight.mjs';
import { findExecutableBounded } from '../resources/index.mjs';
import { randomUUID } from 'node:crypto';

const HERDR_CONTEXT_KEYS = [
  'HERDR_CONFIG_PATH',
  'HERDR_SOCKET_PATH',
  'HERDR_SESSION',
  'HERDR_PANE_ID',
  'HERDR_TERMINAL_ID',
  'HERDR_WORKSPACE_ID',
  'HERDR_TAB_ID',
  'HERDR_BIN_PATH',
  'HERDR_AGENT',
  'HERDR_AGENT_SESSION_ID',
  'HERDR_AGENT_SESSION_PATH',
  'HERDR_ENV',
];

function cleanHerdrEnv(base = process.env) {
  const env = { ...base };
  for (const key of HERDR_CONTEXT_KEYS) delete env[key];
  for (const key of Object.keys(env)) {
    if (key.startsWith('HERDR_ACTIVE_')) delete env[key];
  }
  return env;
}

function validateSession(session, { allowDefault = false } = {}) {
  if (typeof session !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(session)) {
    throw new OrchestratorError('invalid_session', 'Herdr session must be a safe nonempty name', { session });
  }
  if (!allowDefault && session === 'default') {
    throw new OrchestratorError('invalid_session', 'refusing to operate on the default Herdr session');
  }
  return session;
}

function parseJsonOutput(output, argv) {
  const text = output.trim();
  if (!text) {
    throw new OrchestratorError('herdr_invalid_json', 'Herdr returned empty JSON output', { argv });
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new OrchestratorError('herdr_invalid_json', `Herdr returned invalid JSON: ${cause.message}`, {
      argv,
      output: text.slice(0, 4000),
    });
  }
}

function parseMaybeJson(output, argv) {
  const text = output.trim();
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) return null;
  return parseJsonOutput(text, argv);
}

function parseHerdrEnvelope(result, argv) {
  return parseMaybeJson(result.stdout, argv) || parseMaybeJson(result.stderr, argv);
}

function nativeErrorCode(envelope, fallback) {
  return envelope?.error?.code || fallback;
}

function nativeErrorMessage(envelope, stderr, fallback) {
  return envelope?.error?.message || stderr.trim() || fallback;
}

function isServerNotRunning(error) {
  return error instanceof OrchestratorError && (
    error.code === 'server_not_running' ||
    error.details?.nativeCode === 'server_not_running' ||
    /server_not_running/.test(String(error.message))
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
    };
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (cause) => {
      cleanup();
      reject(cause);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

export class Herdr {
  constructor({ binary = 'herdr', runner = runCommand, environment = process.env, spawner = spawn } = {}) {
    this.binary = binary;
    this.runner = runner;
    this.environment = environment;
    this.spawner = spawner;
    this.agentExecutables = new Map();
  }

  env() {
    return cleanHerdrEnv(this.environment);
  }

  async preflight(kind) {
    const found = await findExecutableBounded(kind, { environment: this.env(), ...(this.environment.HOME ? { home: this.environment.HOME } : {}) });
    if (found.executable) this.agentExecutables.set(kind, found);
    return { herdr: { available: await executableAvailable(this.binary, { env: this.env() }) }, agent: { available: Boolean(found.executable), discoverySource: found.discoverySource } };
  }

  async json(args, { timeoutMs = 30000 } = {}) {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new OrchestratorError('invalid_herdr_args', 'Herdr args must be a string array', { args });
    }
    const argv = [this.binary, ...args];
    const result = await this.runner(argv, {
      timeoutMs,
      env: this.env(),
      maxBytes: 1048576,
    });
    const envelope = parseHerdrEnvelope(result, argv);
    if (result.code !== 0) {
      const nativeCode = nativeErrorCode(envelope, 'herdr_command_failed');
      throw new OrchestratorError(nativeCode, nativeErrorMessage(envelope, result.stderr, `Herdr command failed: ${args.join(' ')}`), {
        argv,
        code: result.code,
        stderr: result.stderr,
        stdout: result.stdout,
        nativeCode,
      });
    }
    if (!envelope) return parseJsonOutput(result.stdout, argv);
    return envelope;
  }

  async listSessions() {
    const envelope = await this.json(['session', 'list', '--json']);
    if (Array.isArray(envelope)) return envelope;
    if (Array.isArray(envelope.sessions)) return envelope.sessions;
    if (Array.isArray(envelope.result?.sessions)) return envelope.result.sessions;
    throw new OrchestratorError('herdr_invalid_response', 'Herdr session list did not contain a sessions array', {
      envelope,
    });
  }

  async ensureServer(session, logPath) {
    validateSession(session);
    if (typeof logPath !== 'string' || logPath.length === 0) {
      throw new OrchestratorError('invalid_log_path', 'ensureServer requires a log path');
    }
    try {
      await this.snapshot(session);
      return { started: false };
    } catch (error) {
      if (!isServerNotRunning(error)) throw error;
    }

    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    const logFd = openSync(logPath, 'a', 0o600);
    chmodSync(logPath, 0o600);
    let child;
    try {
      child = this.spawner(this.binary, ['--session', session, 'server'], {
        detached: true,
        shell: false,
        env: this.env(),
        stdio: ['ignore', logFd, logFd],
      });
      child.unref();
    } catch (cause) {
      throw new OrchestratorError('herdr_server_spawn_failed', `failed to start Herdr server: ${cause.message}`, {
        session,
        cause: cause.message,
      });
    } finally {
      closeSync(logFd);
    }

    try {
      await waitForSpawn(child);
    } catch (cause) {
      throw new OrchestratorError('herdr_server_spawn_failed', `failed to start Herdr server: ${cause.message}`, {
        session,
        cause: cause.message,
      });
    }

    const startedAt = Date.now();
    let lastError;
    while (Date.now() - startedAt < 10000) {
      await delay(200);
      try {
        await this.snapshot(session);
        return { started: true, pid: child.pid };
      } catch (error) {
        lastError = error;
        if (!isServerNotRunning(error)) break;
      }
    }
    try {
      await this.stopServer(session);
    } catch {
      // Best effort cleanup only. If start never succeeded, there is no server to stop.
    }
    throw new OrchestratorError('herdr_server_start_failed', 'Herdr server did not become ready within 10s', {
      session,
      pid: child.pid,
      lastError: lastError?.message,
    });
  }

  createWorkspace(session, cwd, label) {
    validateSession(session);
    const args = ['--session', session, 'workspace', 'create', '--cwd', cwd, '--no-focus'];
    if (label) args.push('--label', label);
    return this.json(args);
  }

  async startAgent(session, name, kind, pane, args = []) {
    validateSession(session);
    const found = this.agentExecutables.get(kind);
    // Login shells can replace PATH even when discovery succeeded on our PATH.
    // Re-establish the discovered directory inside the owned pane before Herdr
    // resolves the agent (and its adjacent Node runtime) by name.
    if (found?.executable) {
      const directory = dirname(found.executable);
      const quoted = `'${directory.replaceAll("'", "'\\''")}'`;
      const nonce = randomUUID();
      await this.prepareEnvironment(session, pane, {
        bootstrap: `export PATH=${quoted}:"$PATH"; printf '\\nCAO_PATH_%s\\n' '${nonce}'`, readyMarker: `CAO_PATH_${nonce}`,
      });
    }
    const argv = ['--session', session, 'agent', 'start', name, '--kind', kind, '--pane', pane, '--timeout', '30000'];
    if (args.length > 0) argv.push('--', ...args);
    return this.json(argv, { timeoutMs: 45000 });
  }

  async prepareEnvironment(session, pane, manifest) {
    validateSession(session);
    await this.runInPane(session, pane, manifest.bootstrap);
    const result = await this.runner([this.binary, '--session', session, 'pane', 'wait-output', '--match', manifest.readyMarker, '--source', 'recent-unwrapped', '--timeout', '10000', pane], { timeoutMs: 15000, env: this.env() });
    if (result.code !== 0) throw new OrchestratorError('execution_environment_failed', 'The owned pane did not confirm its isolated environment.');
    return { prepared: true };
  }

  async runInPane(session, pane, command) {
    validateSession(session);
    const result = await this.runner([this.binary, '--session', session, 'pane', 'run', pane, command], { timeoutMs: 10000, env: this.env() });
    if (result.code !== 0) throw new OrchestratorError('execution_environment_failed', 'Could not send the execution bootstrap to its owned pane.');
    return { sent: true };
  }

  getAgent(session, name) {
    validateSession(session);
    return this.json(['--session', session, 'agent', 'get', name]);
  }

  getPane(session, pane) {
    validateSession(session);
    return this.json(['--session', session, 'pane', 'get', pane]);
  }

  getProcessInfo(session, pane) {
    validateSession(session);
    return this.json(['--session', session, 'pane', 'process-info', '--pane', pane]);
  }

  prompt(session, name, prompt, waitMs = 45000) {
    validateSession(session);
    const argv = ['--session', session, 'agent', 'prompt', name, prompt];
    if (waitMs === 0) return this.json(argv);
    return this.json([
      ...argv,
      '--wait',
      '--until', 'idle',
      '--until', 'done',
      '--until', 'blocked',
      '--timeout', String(waitMs),
    ], { timeoutMs: waitMs + 5000 });
  }

  async readAgent(session, name, lines = 80) {
    validateSession(session);
    const argv = [this.binary, '--session', session, 'agent', 'read', name, '--source', 'visible', '--lines', String(lines), '--format', 'text'];
    const result = await this.runner(argv, { timeoutMs: 10000, env: this.env(), maxBytes: 1048576 });
    if (result.code !== 0) {
      const envelope = parseHerdrEnvelope(result, argv);
      const nativeCode = nativeErrorCode(envelope, 'herdr_command_failed');
      throw new OrchestratorError(nativeCode, nativeErrorMessage(envelope, result.stderr, 'Herdr agent read failed'), {
        argv,
        code: result.code,
        stderr: result.stderr,
        stdout: result.stdout,
        nativeCode,
      });
    }
    return result.stdout;
  }

  keys(session, name, keys) {
    validateSession(session);
    if (!Array.isArray(keys) || keys.length === 0 || keys.some((key) => typeof key !== 'string' || key.length === 0)) {
      throw new OrchestratorError('invalid_keys', 'keys must be a nonempty string array', { keys });
    }
    return this.json(['--session', session, 'agent', 'send-keys', name, ...keys]);
  }

  closePane(session, pane) {
    validateSession(session);
    return this.json(['--session', session, 'pane', 'close', pane]);
  }

  stopServer(session) {
    validateSession(session);
    return this.json(['session', 'stop', session, '--json']);
  }

  snapshot(session) {
    validateSession(session);
    return this.json(['--session', session, 'api', 'snapshot']);
  }
}

export { cleanHerdrEnv };
