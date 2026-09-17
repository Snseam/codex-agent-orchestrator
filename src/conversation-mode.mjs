import fs from 'node:fs/promises';
import path from 'node:path';
import { OrchestratorError, invariant } from './errors.mjs';
import { readJson, validateId, withLock, writeJsonAtomic } from './state.mjs';

const AGENTS = new Set(['auto', 'claude', 'pi', 'opencode', 'codex']);
const STRATEGIES = new Set(['delegated', 'shadow']);
const PREFERENCES = new Set(['balanced', 'fastest', 'subscription-first', 'quality-first']);

function modeError(code, message, details = {}) {
  return new OrchestratorError(code, message, details);
}

function now() {
  return new Date().toISOString();
}

export function resolveThreadId(explicitThread, env = process.env) {
  return explicitThread || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || null;
}

function validateThreadId(threadId) {
  try {
    return validateId(threadId);
  } catch (error) {
    throw modeError('invalid_thread', 'Thread id must be 1-64 characters of letters, numbers, underscore, or hyphen.', { threadId });
  }
}

function conversationDirectory(root, threadId) {
  return path.join(path.resolve(root), 'conversations', validateThreadId(threadId));
}

function conversationFile(root, threadId) {
  return path.join(conversationDirectory(root, threadId), 'mode.json');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function inside(parent, child) {
  return child === parent || child.startsWith(parent + path.sep);
}

async function statOptional(file) {
  try {
    return await fs.stat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function resolvePotentialPath(file) {
  const resolved = path.resolve(file);
  const parts = resolved.split(path.sep);
  const prefix = resolved.startsWith(path.sep) ? path.sep : '';
  const start = prefix ? 1 : 0;
  for (let end = parts.length; end >= start; end--) {
    const candidate = (prefix + parts.slice(start, end).join(path.sep)) || prefix || '.';
    const stats = await statOptional(candidate);
    if (!stats) continue;
    const real = await fs.realpath(candidate);
    return path.join(real, ...parts.slice(end));
  }
  return resolved;
}

async function realDirectory(project) {
  const resolved = await fs.realpath(path.resolve(project));
  const stats = await fs.stat(resolved);
  invariant(stats.isDirectory(), 'invalid_project', '--project must resolve to a directory.', { project });
  return resolved;
}

async function assertStateOutsideProject(stateRoot, project) {
  if (!project) return;
  const statePath = await resolvePotentialPath(stateRoot);
  if (inside(project, statePath)) {
    throw modeError('state_inside_project', 'State directory must be outside the project working tree.', {
      stateRoot,
      project,
    });
  }
}

function parsePositiveInteger(value, field, max) {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(String(value))) {
    throw modeError('invalid_arguments', `${field} must be an integer from 1 to ${max}.`, { field, value });
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) {
    throw modeError('invalid_arguments', `${field} must be an integer from 1 to ${max}.`, { field, value });
  }
  return number;
}

async function normalizedUpdates(options) {
  const updates = {};
  if (options.strategy !== undefined) {
    invariant(STRATEGIES.has(options.strategy), 'invalid_arguments', 'strategy must be delegated or shadow; active adaptive routing is not enabled.');
    updates.strategy = options.strategy;
  }
  if (options.preference !== undefined) {
    invariant(PREFERENCES.has(options.preference), 'invalid_arguments', 'Invalid routing preference.');
    updates.preference = options.preference;
  }
  if (options.agent !== undefined) {
    invariant(AGENTS.has(options.agent), 'invalid_arguments', '--agent must be auto, claude, pi, opencode, or codex.', { agent: options.agent });
    updates.agent = options.agent;
  }
  if (options.profile !== undefined) {
    updates.profile = options.profile === '' ? null : validateId(options.profile);
  }
  if (options.project !== undefined) {
    updates.project = options.project === '' ? null : await realDirectory(options.project);
  }
  const maxParallel = parsePositiveInteger(options.maxParallel, '--max-parallel', 64);
  if (maxParallel !== undefined) updates.maxParallel = maxParallel;
  const maxAttempts = parsePositiveInteger(options.maxAttempts, '--max-attempts', 20);
  if (maxAttempts !== undefined) updates.maxAttempts = maxAttempts;
  return updates;
}

function nullableString(value, field) {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  throw modeError('mode_state_invalid', `${field} in mode state must be a string or null.`, { field });
}

function validateStoredPositiveInteger(value, field, max) {
  if (Number.isInteger(value) && value >= 1 && value <= max) return value;
  throw modeError('mode_state_invalid', `${field} in mode state must be an integer from 1 to ${max}.`, { field, value });
}

function validateStoredRecord(record, threadId) {
  if (record === null) return null;
  if (!isPlainObject(record)) {
    throw modeError('mode_state_invalid', 'Mode state must be a JSON object.');
  }
  if (![1, 2].includes(record.schemaVersion)) {
    throw modeError('mode_state_invalid', 'Mode state uses an unsupported schema version.', { schemaVersion: record.schemaVersion });
  }
  if (record.schemaVersion === 2) invariant(STRATEGIES.has(record.strategy) && PREFERENCES.has(record.preference), 'mode_state_invalid', 'Invalid strategy/preference in version 2 mode.');
  else invariant(record.strategy === undefined && record.preference === undefined, 'mode_state_invalid', 'Strategy preferences require mode schema version 2.');
  if (record.threadId !== threadId) {
    throw modeError('mode_thread_mismatch', 'Mode state belongs to a different thread.', { expected: threadId, actual: record.threadId });
  }
  if (typeof record.enabled !== 'boolean') {
    throw modeError('mode_state_invalid', 'enabled in mode state must be boolean.', { enabled: record.enabled });
  }
  const agent = record.agent === null ? null : record.agent;
  if (agent !== null && !AGENTS.has(agent)) {
    throw modeError('mode_state_invalid', 'agent in mode state is not supported.', { agent });
  }
  const profile = nullableString(record.profile, 'profile');
  if (profile !== null) validateId(profile);
  const project = nullableString(record.project, 'project');
  const maxParallel = validateStoredPositiveInteger(record.maxParallel, 'maxParallel', 64);
  const maxAttempts = validateStoredPositiveInteger(record.maxAttempts, 'maxAttempts', 20);
  const createdAt = typeof record.createdAt === 'string' ? record.createdAt : null;
  const updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt : null;
  return {
    schemaVersion: record.schemaVersion,
    threadId,
    enabled: record.enabled,
    project,
    agent,
    profile,
    maxParallel,
    maxAttempts,
    createdAt,
    updatedAt,
    ...(record.schemaVersion === 2 ? { strategy: record.strategy, preference: record.preference } : {}),
  };
}

function emptyStatus(root, threadId, identityAvailable) {
  return {
    schemaVersion: 1,
    threadId,
    identityAvailable,
    enabled: false,
    strategy: 'delegated', preference: 'balanced',
    project: null,
    agent: null,
    profile: null,
    maxParallel: 2,
    maxAttempts: 3,
    modePath: threadId ? conversationFile(root, threadId) : null,
    updatedAt: null,
  };
}

function publicStatus(root, threadId, record) {
  const source = record || {};
  return {
    schemaVersion: source.schemaVersion ?? 1,
    threadId,
    identityAvailable: true,
    enabled: source.enabled ?? false,
    strategy: source.strategy ?? 'delegated', preference: source.preference ?? 'balanced',
    project: source.project ?? null,
    agent: source.agent ?? null,
    profile: source.profile ?? null,
    maxParallel: source.maxParallel ?? 2,
    maxAttempts: source.maxAttempts ?? 3,
    modePath: conversationFile(root, threadId),
    updatedAt: source.updatedAt ?? null,
  };
}

export async function statusConversationMode({ stateRoot, thread, env = process.env } = {}) {
  const threadId = resolveThreadId(thread, env);
  if (!threadId) return emptyStatus(stateRoot, null, false);
  validateThreadId(threadId);
  const record = await readJson(conversationFile(stateRoot, threadId), { optional: true });
  return publicStatus(stateRoot, threadId, validateStoredRecord(record, threadId));
}

export async function enableConversationMode({ stateRoot, thread, project, agent, profile, maxParallel, maxAttempts, strategy, preference, env = process.env } = {}) {
  const threadId = resolveThreadId(thread, env);
  invariant(threadId, 'thread_unavailable', 'Pass --thread or run inside a Codex conversation with CODEX_THREAD_ID/CODEX_SESSION_ID set.');
  validateThreadId(threadId);
  const updates = await normalizedUpdates({ project, agent, profile, maxParallel, maxAttempts, strategy, preference });
  if (updates.project) await assertStateOutsideProject(stateRoot, updates.project);
  const file = conversationFile(stateRoot, threadId);
  const lock = path.join(conversationDirectory(stateRoot, threadId), '.lock');
  return withLock(lock, async () => {
    const existing = validateStoredRecord(await readJson(file, { optional: true }), threadId);
    await assertStateOutsideProject(stateRoot, updates.project ?? existing?.project ?? null);
    const upgraded = existing?.schemaVersion === 2 || strategy !== undefined || preference !== undefined;
    const record = {
      schemaVersion: upgraded ? 2 : 1,
      threadId,
      enabled: true,
      project: existing?.project ?? null,
      agent: existing?.agent ?? null,
      profile: existing?.profile ?? null,
      maxParallel: existing?.maxParallel ?? 2,
      maxAttempts: existing?.maxAttempts ?? 3,
      createdAt: existing?.createdAt ?? now(),
      ...(upgraded ? { strategy: existing?.strategy ?? 'delegated', preference: existing?.preference ?? 'balanced' } : {}),
      ...updates,
      updatedAt: now(),
    };
    await writeJsonAtomic(file, record);
    return publicStatus(stateRoot, threadId, record);
  });
}

export async function disableConversationMode({ stateRoot, thread, env = process.env } = {}) {
  const threadId = resolveThreadId(thread, env);
  invariant(threadId, 'thread_unavailable', 'Pass --thread or run inside a Codex conversation with CODEX_THREAD_ID/CODEX_SESSION_ID set.');
  validateThreadId(threadId);
  const file = conversationFile(stateRoot, threadId);
  const lock = path.join(conversationDirectory(stateRoot, threadId), '.lock');
  return withLock(lock, async () => {
    const existing = validateStoredRecord(await readJson(file, { optional: true }), threadId);
    const record = {
      schemaVersion: existing?.schemaVersion ?? 1,
      threadId,
      enabled: false,
      project: existing?.project ?? null,
      agent: existing?.agent ?? null,
      profile: existing?.profile ?? null,
      maxParallel: existing?.maxParallel ?? 2,
      maxAttempts: existing?.maxAttempts ?? 3,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
      ...(existing?.schemaVersion === 2 ? { strategy: existing.strategy, preference: existing.preference } : {}),
    };
    await writeJsonAtomic(file, record);
    return publicStatus(stateRoot, threadId, record);
  });
}
