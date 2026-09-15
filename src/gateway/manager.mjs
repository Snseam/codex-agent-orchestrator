import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeJsonAtomic, readJson, validateId, withLock, listRuns } from '../state.mjs';
import { OrchestratorError } from '../errors.mjs';

const STARTUP_TIMEOUT_MS = 10000;
const CHILD_SHUTDOWN_MS = 1000;
const QUOTA_FRESH_TTL_MS = 15 * 60 * 1000;
const SUPPORTED_PROTOCOLS = new Set(['anthropic', 'openai-responses', 'openai-chat']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function gatewayError(code, message, details = {}) {
  return new OrchestratorError(code, message, details);
}

function gatewayRoot(root, id) {
  return path.join(root, 'gateways', id);
}

function publicHandle(handle) {
  const {
    id,
    pid,
    endpoint,
    protocol,
    tokenFile,
    logFile,
    configFile,
    profileIds,
    startedAt,
  } = handle;
  return { id, pid, endpoint, protocol, tokenFile, logFile, configFile, profileIds, startedAt };
}

function isLoopbackEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function validateEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw gatewayError('invalid_gateway_profile', 'Profile endpoint must be an absolute URL', { endpoint });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw gatewayError('invalid_gateway_profile', 'Profile endpoint must be http(s) without userinfo, query, or fragment', {
      endpoint,
    });
  }
}

function hasCapabilities(profile, required) {
  const capabilities = new Set(Array.isArray(profile.capabilities) ? profile.capabilities : []);
  return required.every((capability) => capabilities.has(capability));
}

function parseTime(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function quotaFresh(quota, now = Date.now()) {
  const expiresAt = parseTime(quota.expiresAt);
  if (expiresAt !== null) return expiresAt > now;
  const observedAt = parseTime(quota.observedAt ?? quota.checkedAt);
  if (observedAt !== null) return now - observedAt <= QUOTA_FRESH_TTL_MS;
  return false;
}

function quotaUnavailable(profile) {
  const quota = profile.quota;
  if (!quota || typeof quota !== 'object') return false;
  if (!quotaFresh(quota)) return false;
  if (typeof quota.remainingTokens === 'number' && Number.isFinite(quota.remainingTokens) && quota.remainingTokens <= 0) return true;
  return quota.state === 'exhausted' || quota.state === 'unavailable';
}

function assertCompatibleProfiles(profiles, { requireCapabilities, allowShared }) {
  if (profiles.length === 0) {
    throw gatewayError('invalid_gateway_start', 'Gateway start requires at least one profile');
  }
  const protocol = profiles[0].protocol;
  if (!SUPPORTED_PROTOCOLS.has(protocol)) {
    throw gatewayError('invalid_gateway_profile', 'Gateway profile protocol is not supported', { protocol });
  }
  for (const profile of profiles) {
    if (profile.enabled === false) {
      throw gatewayError('invalid_gateway_profile', 'Gateway profile is disabled', { profileId: profile.id });
    }
    if (quotaUnavailable(profile)) {
      throw gatewayError('invalid_gateway_profile', 'Gateway profile quota is unavailable', { profileId: profile.id });
    }
    if (profile.protocol !== protocol) {
      throw gatewayError('invalid_gateway_profile', 'Gateway fallback profiles must use the same protocol', {
        primaryProtocol: protocol,
        profileId: profile.id,
        protocol: profile.protocol,
      });
    }
    validateEndpoint(profile.endpoint);
    if (!hasCapabilities(profile, requireCapabilities)) {
      throw gatewayError('invalid_gateway_profile', 'Gateway profile is missing required capabilities', {
        profileId: profile.id,
        requireCapabilities,
      });
    }
    if ((profile.source?.allowShared === true || profile.source?.route === 'active-proxy') && !allowShared) {
      throw gatewayError('invalid_gateway_profile', 'Refusing shared gateway source without allowShared', {
        profileId: profile.id,
      });
    }
    if (profile.credential?.type === 'none' && !isLoopbackEndpoint(profile.endpoint)) {
      throw gatewayError('invalid_gateway_profile', 'credential.type none is only allowed for loopback endpoints', {
        profileId: profile.id,
      });
    }
  }
}

async function writePrivateText(file, text) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, 'w', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function childFailure(state) {
  if (state?.error) {
    return gatewayError('gateway_start_failed', 'Gateway child process failed to start', {
      cause: state.error.code ?? state.error.name ?? 'spawn_error',
    });
  }
  if (state?.exit) {
    return gatewayError('gateway_start_failed', 'Gateway child process exited before becoming ready', {
      code: state.exit.code,
      signal: state.exit.signal,
    });
  }
  return null;
}

function monitorChild(child) {
  const state = { error: null, exit: null };
  state.done = new Promise((resolve) => {
    child.once?.('error', (error) => {
      state.error = error;
      resolve(state);
    });
    child.once?.('exit', (code, signal) => {
      state.exit = { code, signal };
      resolve(state);
    });
  });
  return state;
}

async function waitForReady(readyFile, deadline, childState) {
  let lastError;
  while (Date.now() < deadline) {
    const failure = childFailure(childState);
    if (failure) throw failure;
    try {
      const ready = await readJson(readyFile, { optional: true });
      if (ready?.endpoint && Number.isInteger(ready?.pid)) return ready;
    } catch (error) {
      lastError = error;
    }
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, 50)),
      childState?.done ?? new Promise(() => {}),
    ]);
  }
  const failure = childFailure(childState);
  if (failure) throw failure;
  throw gatewayError('gateway_start_timeout', 'Gateway did not become ready within 10s', {
    readyFile,
    lastError: lastError?.message,
  });
}

async function terminateChild(child, childState) {
  if (!child || childState?.exit || childState?.error) return;
  child.kill?.('SIGTERM');
  await Promise.race([
    childState?.done ?? Promise.resolve(),
    new Promise((resolve) => setTimeout(resolve, CHILD_SHUTDOWN_MS)),
  ]);
  if (!childState?.exit && !childState?.error) {
    child.kill?.('SIGKILL');
    await Promise.race([
      childState?.done ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, CHILD_SHUTDOWN_MS)),
    ]);
  }
}

async function requestJson(url, { method = 'GET', token, ownerNonce, timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (ownerNonce) headers['x-cao-owner-nonce'] = ownerNonce;
    const response = await fetch(url, { method, headers, signal: controller.signal });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { text };
      }
    }
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function secretEnvName(profileId) {
  const digest = createHash('sha256').update(profileId).digest('hex').slice(0, 32).toUpperCase();
  return `CAO_GATEWAY_SECRET_${digest}`;
}

function ownerProof(ownerNonce) {
  return createHash('sha256').update(ownerNonce).digest('hex');
}

function publicHealth(health) {
  if (!health || typeof health !== 'object') return null;
  const { ownerNonce: _ownerNonce, ownerProof: _ownerProof, ...rest } = health;
  return rest;
}

function credentialSecretRef(credential) {
  if (credential?.type === 'stored') return credential.ref;
  if (credential?.type === 'env') return `env:${credential.name}`;
  if (credential?.type === 'cc-switch') return credential.secretRef;
  return null;
}

async function resolveSecrets(profiles, store) {
  const env = {};
  const secretEnv = {};
  for (const profile of profiles) {
    if (profile.credential?.type === 'none') continue;
    let secret = null;
    if (typeof store?.resolveProfileSecret === 'function') {
      secret = await store.resolveProfileSecret(profile);
    } else {
      const ref = credentialSecretRef(profile.credential);
      if (typeof ref !== 'string' || ref.length === 0) {
        throw gatewayError('gateway_secret_unavailable', 'Profile does not expose a resolvable credential reference', {
          profileId: profile.id,
        });
      }
      if (typeof store?.resolveSecret !== 'function') {
        throw gatewayError('gateway_secret_unavailable', 'Profile store does not support secret resolution', {
          profileId: profile.id,
        });
      }
      secret = await store.resolveSecret(ref);
    }
    if (typeof secret !== 'string' || secret.length === 0 || CONTROL_CHARS.test(secret)) {
      throw gatewayError('gateway_secret_unavailable', 'Profile secret is unavailable or has an invalid header format', {
        profileId: profile.id,
      });
    }
    const name = secretEnvName(profile.id);
    env[name] = secret;
    secretEnv[profile.id] = name;
  }
  return { env, secretEnv };
}

function cloneSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw gatewayError('invalid_gateway_start', 'snapshots must contain profile objects');
  }
  return structuredClone(snapshot);
}

async function assertSourcesCurrent(store, profiles) {
  for (const profile of profiles) {
    if (typeof store?.assertSourceCurrent === 'function') {
      await store.assertSourceCurrent(profile);
    }
  }
}

async function resolveProfiles(store, { profileIds, snapshots }) {
  if (snapshots !== undefined) {
    if (!Array.isArray(snapshots) || snapshots.length === 0) {
      throw gatewayError('invalid_gateway_start', 'snapshots must be a nonempty profile array');
    }
    const profiles = snapshots.map(cloneSnapshot);
    if (Array.isArray(profileIds) && profileIds.length > 0) {
      const ids = profiles.map((profile) => profile.id);
      if (ids.length !== profileIds.length || ids.some((id, index) => id !== profileIds[index])) {
        throw gatewayError('invalid_gateway_start', 'profileIds must match supplied snapshots order');
      }
    }
    await assertSourcesCurrent(store, profiles);
    return profiles;
  }
  if (typeof store?.resolve !== 'function') {
    throw gatewayError('gateway_profile_store_missing', 'GatewayManager requires a ProfileStore-like object');
  }
  if (!Array.isArray(profileIds) || profileIds.length === 0 || profileIds.some((profileId) => typeof profileId !== 'string')) {
    throw gatewayError('invalid_gateway_start', 'start requires nonempty profileIds or snapshots');
  }
  const profiles = [];
  for (const profileId of profileIds) {
    const profile = await store.resolve(profileId);
    if (!profile || typeof profile !== 'object') {
      throw gatewayError('gateway_profile_missing', 'Profile could not be resolved', { profileId });
    }
    profiles.push(profile);
  }
  await assertSourcesCurrent(store, profiles);
  return profiles;
}

function attemptReferencesGateway(attempt, gatewayId) {
  if (!attempt || typeof attempt !== 'object' || attempt.workerClosed === true) return false;
  return attempt.gatewayId === gatewayId
    || attempt.execution?.gatewayId === gatewayId
    || attempt.execution?.gateway?.id === gatewayId
    || attempt.executionManifest?.gatewayId === gatewayId;
}

async function activeGatewayReferences(root, gatewayId) {
  const references = [];
  for (const run of await listRuns(root)) {
    for (const task of Object.values(run.tasks || {})) {
      for (const attempt of task?.attempts || []) {
        if (attemptReferencesGateway(attempt, gatewayId)) {
          references.push({ runId: run.id, taskId: task.definition?.id ?? task.id ?? null, attemptId: attempt.id ?? null });
        }
      }
    }
  }
  return references;
}

export class GatewayManager {
  constructor({ root, profiles, spawnProcess = spawn, serverPath = null, startupTimeoutMs = STARTUP_TIMEOUT_MS } = {}) {
    if (typeof root !== 'string' || root.length === 0) {
      throw gatewayError('invalid_gateway_manager', 'GatewayManager requires root');
    }
    this.root = root;
    this.profiles = profiles;
    this.spawnProcess = spawnProcess;
    this.serverPath = serverPath;
    this.startupTimeoutMs = startupTimeoutMs;
  }

  async start({ id = randomUUID(), profileIds, snapshots, requireCapabilities = [], allowShared = false } = {}) {
    validateId(id);
    if (profileIds !== undefined && (!Array.isArray(profileIds) || profileIds.some((profileId) => typeof profileId !== 'string'))) {
      throw gatewayError('invalid_gateway_start', 'profileIds must be a string array');
    }
    if (!Array.isArray(requireCapabilities) || requireCapabilities.some((capability) => typeof capability !== 'string')) {
      throw gatewayError('invalid_gateway_start', 'requireCapabilities must be a string array');
    }

    const lockDirectory = path.join(this.root, 'locks', `gateway-start-${id}`);
    return withLock(lockDirectory, () => this.#startLocked({ id, profileIds, snapshots, requireCapabilities, allowShared }), {
      timeoutMs: this.startupTimeoutMs,
    });
  }

  async #startLocked({ id, profileIds, snapshots, requireCapabilities, allowShared }) {
    const directory = gatewayRoot(this.root, id);
    const handleFile = path.join(directory, 'handle.json');
    const existing = await readJson(handleFile, { optional: true });
    if (existing) throw gatewayError('gateway_exists', 'Gateway already exists', { id });

    const resolvedProfiles = await resolveProfiles(this.profiles, { profileIds, snapshots });
    assertCompatibleProfiles(resolvedProfiles, { requireCapabilities, allowShared });
    const { env: secretEnvValues, secretEnv } = await resolveSecrets(resolvedProfiles, this.profiles);

    await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    try {
      await mkdir(directory, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw gatewayError('gateway_exists', 'Gateway id already has an immutable evidence directory', { id });
      }
      throw error;
    }
    const ownerNonce = randomBytes(24).toString('base64url');
    const localToken = randomBytes(32).toString('base64url');
    const tokenFile = path.join(directory, 'token');
    const logFile = path.join(directory, 'gateway.log');
    const configFile = path.join(directory, 'config.json');
    const readyFile = path.join(directory, 'ready.json');
    const startupFile = path.join(directory, 'startup.json');
    const failureFile = path.join(directory, 'startup-failure.json');
    const startedAt = new Date().toISOString();
    const generation = randomUUID();

    await writeJsonAtomic(startupFile, {
      schemaVersion: 1,
      id,
      generation,
      status: 'starting',
      startedAt,
    });
    await writePrivateText(tokenFile, `${localToken}\n`);
    await writePrivateText(logFile, '');
    await writeJsonAtomic(configFile, {
      schemaVersion: 1,
      id,
      ownerNonce,
      protocol: resolvedProfiles[0].protocol,
      tokenFile,
      logFile,
      readyFile,
      bodyLimitBytes: 16 * 1024 * 1024,
      upstreamTimeoutMs: 120000,
      profiles: resolvedProfiles,
      secretEnv,
      createdAt: startedAt,
      generation,
    });

    const serverPath = this.serverPath || fileURLToPath(new URL('./server.mjs', import.meta.url));
    const childEnv = {
      ...process.env,
      ...secretEnvValues,
    };
    delete childEnv.NODE_TEST_CONTEXT;
    let child;
    let childState;
    try {
      child = this.spawnProcess(process.execPath, [serverPath, '--config', configFile], {
        detached: true,
        stdio: 'ignore',
        env: childEnv,
      });
      childState = monitorChild(child);
      child.unref?.();
    } catch (error) {
      const wrapped = gatewayError('gateway_start_failed', 'Gateway child process failed to spawn', {
        cause: error?.code ?? error?.name ?? 'spawn_error',
      });
      await writeJsonAtomic(failureFile, {
        schemaVersion: 1,
        id,
        generation,
        failedAt: new Date().toISOString(),
        error: { code: wrapped.code, cause: wrapped.details?.cause ?? null },
      }).catch(() => {});
      throw wrapped;
    }

    let ready;
    try {
      ready = await waitForReady(readyFile, Date.now() + this.startupTimeoutMs, childState);
      const health = await requestJson(`${ready.endpoint}/__cao/health`, { ownerNonce });
      if (!health.ok || health.body?.ownerProof !== ownerProof(ownerNonce)) {
        throw gatewayError('gateway_start_failed', 'Gateway health did not match owner proof', { id, status: health.status });
      }
    } catch (error) {
      await terminateChild(child, childState);
      await writeJsonAtomic(failureFile, {
        schemaVersion: 1,
        id,
        generation,
        failedAt: new Date().toISOString(),
        error: {
          code: error.code ?? 'gateway_start_failed',
          cause: error.details?.cause ?? error.name ?? null,
          exit: childState?.exit ?? null,
        },
      }).catch(() => {});
      throw error;
    }

    const handle = {
      id,
      pid: ready.pid,
      endpoint: ready.endpoint,
      protocol: resolvedProfiles[0].protocol,
      tokenFile,
      logFile,
      configFile,
      profileIds: resolvedProfiles.map((profile) => profile.id),
      ownerNonce,
      startedAt,
    };
    await writeJsonAtomic(handleFile, handle);
    return publicHandle(handle);
  }

  async status(id) {
    validateId(id);
    const directory = gatewayRoot(this.root, id);
    const handle = await readJson(path.join(directory, 'handle.json'), { optional: true });
    if (!handle) return null;
    const token = await readFile(handle.tokenFile, 'utf8').then((text) => text.trim()).catch(() => null);
    let health = null;
    if (token) {
      health = await requestJson(`${handle.endpoint}/__cao/health`, { token }).catch((error) => ({
        ok: false,
        status: 0,
        body: { error: error.message },
      }));
    }
    return {
      ...publicHandle(handle),
      running: health?.ok === true && health.body?.ownerProof === ownerProof(handle.ownerNonce),
      health: publicHealth(health?.body ?? null),
    };
  }

  async stop(id) {
    validateId(id);
    const directory = gatewayRoot(this.root, id);
    const handle = await readJson(path.join(directory, 'handle.json'), { optional: true });
    const status = await this.status(id);
    if (!status) return null;
    if (!status.running) return status;
    const references = await activeGatewayReferences(this.root, id);
    if (references.length > 0) {
      throw gatewayError('gateway_busy', 'Gateway is still referenced by active attempts', { id, references });
    }
    const response = await requestJson(`${status.endpoint}/__cao/stop`, {
      method: 'POST',
      ownerNonce: handle.ownerNonce,
    });
    if (!response.ok && response.status === 409) {
      throw gatewayError('gateway_busy', 'Gateway refused stop while requests are active', { id });
    }
    if (!response.ok) {
      throw gatewayError('gateway_stop_failed', 'Gateway refused stop', { id, status: response.status });
    }
    return { ...status, running: false, stoppedAt: new Date().toISOString() };
  }

  async list() {
    const directory = path.join(this.root, 'gateways');
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const handles = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const handlePath = path.join(directory, entry.name, 'handle.json');
        await stat(handlePath);
        handles.push(await this.status(entry.name));
      } catch {
        // Ignore incomplete evidence directories.
      }
    }
    return handles.filter(Boolean);
  }
}
