import crypto from 'node:crypto';
import path from 'node:path';
import { OrchestratorError } from './errors.mjs';
import { listRuns, readJson, validateId, withLock, writeJsonAtomic } from './state.mjs';

const POLICIES = new Set(['quality', 'cost', 'speed', 'available']);
const AGENT_PROTOCOLS = {
  claude: new Set(['anthropic']),
  codex: new Set(['openai-responses']),
  opencode: new Set(['openai-chat']),
  pi: new Set(['anthropic', 'openai-responses', 'openai-chat']),
};
const RESERVATION_SCHEMA_VERSION = 1;
const OBSERVED_TTL_MS = 15 * 60 * 1000;
const ID_CHARS_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const ATTEMPT_ID_MAX = 128;

function routeError(code, message, details = {}) {
  return new OrchestratorError(code, message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function validateAttemptId(id) {
  if (typeof id !== 'string' || id.length > ATTEMPT_ID_MAX || !ID_CHARS_RE.test(id)) {
    throw routeError('invalid_id', 'Invalid attempt id', { id, maxLength: ATTEMPT_ID_MAX });
  }
  return id;
}

function validateStringArray(value, field) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || v.length === 0)) {
    throw routeError('invalid_execution', `${field} must be an array of non-empty strings.`, { field });
  }
  return [...new Set(value)];
}

function validateProfileIds(value, field) {
  const items = validateStringArray(value, field);
  if (items === undefined) return undefined;
  return items.map(id => validateId(id));
}

export function validateExecution(input) {
  if (!isPlainObject(input)) throw routeError('invalid_execution', 'Execution selector must be an object.');
  const allowed = new Set(['profile', 'policy', 'profiles', 'requireCapabilities', 'allowShared']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw routeError('invalid_execution', `Unknown execution selector field: ${key}`, { field: key });
  }

  const output = {};
  if (input.profile !== undefined) output.profile = validateId(input.profile);
  if (input.policy !== undefined) {
    if (!POLICIES.has(input.policy)) throw routeError('invalid_execution', 'Execution policy is invalid.', { policy: input.policy });
    output.policy = input.policy;
  }
  if (input.profiles !== undefined) output.profiles = validateProfileIds(input.profiles, 'profiles');
  if (input.requireCapabilities !== undefined) output.requireCapabilities = validateStringArray(input.requireCapabilities, 'requireCapabilities');
  output.allowShared = input.allowShared === true;
  if (input.allowShared !== undefined && typeof input.allowShared !== 'boolean') {
    throw routeError('invalid_execution', 'allowShared must be a boolean.', { allowShared: input.allowShared });
  }

  if (output.profile && output.policy) {
    throw routeError('invalid_execution', 'A fixed profile and an automatic policy are mutually exclusive.');
  }
  if (output.profile && output.profiles !== undefined) {
    throw routeError('invalid_execution', 'A fixed profile cannot also provide automatic candidates.');
  }
  if (!output.profile && (!output.profiles || output.profiles.length === 0)) {
    throw routeError('invalid_execution', 'Automatic routing requires at least one candidate profile.');
  }
  return output;
}

function parseTime(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFresh(record, now = Date.now()) {
  if (!isPlainObject(record)) return false;
  const expiresAt = parseTime(record.expiresAt);
  if (expiresAt !== null) return expiresAt > now;
  const observedAt = parseTime(record.observedAt ?? record.checkedAt);
  if (observedAt !== null) return now - observedAt <= OBSERVED_TTL_MS;
  return false;
}

function normalizeProtocol(protocol) {
  return typeof protocol === 'string' ? protocol.trim() : '';
}

function agentCompatibility(profile, requestedAgent) {
  const profileAgent = typeof profile.agent === 'string' ? profile.agent : null;
  if (requestedAgent && profileAgent !== requestedAgent) {
    return { compatible: false, reason: `agent_mismatch:${profileAgent ?? 'unknown'}:${requestedAgent}` };
  }
  const effectiveAgent = requestedAgent ?? profileAgent;
  if (!effectiveAgent) return { compatible: true, reason: null };
  const protocols = AGENT_PROTOCOLS[effectiveAgent];
  if (!protocols) return { compatible: true, reason: null };
  if (!protocols.has(normalizeProtocol(profile.protocol))) {
    return { compatible: false, reason: `protocol_incompatible:${effectiveAgent}:${profile.protocol ?? 'unknown'}` };
  }
  return { compatible: true, reason: null };
}

function sourceShared(profile) {
  const source = profile.source;
  return source?.shared === true || source?.allowShared === true || source?.route === 'active-proxy';
}

function sourceUnavailable(profile, now) {
  const source = profile.source;
  if (!isPlainObject(source)) return { unavailable: false, stale: false };
  const unavailable = source.available === false || source.state === 'unavailable' || source.status === 'unavailable';
  if (!unavailable) return { unavailable: false, stale: false };
  const stale = !isFresh(source, now);
  return { unavailable: !stale, stale };
}

function quotaSignal(profile, now) {
  const quota = profile.quota;
  if (!isPlainObject(quota) || typeof quota.state !== 'string') return { state: 'unknown', fresh: false, exhausted: false };
  const fresh = isFresh(quota, now);
  const remainingTokens = declaredNumber(quota.remainingTokens);
  const exhausted = fresh && remainingTokens !== null && remainingTokens <= 0;
  return { state: quota.state, fresh, exhausted };
}

function declaredNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function priority(profile) {
  return declaredNumber(profile.priority) ?? 0;
}

function scoreProfile(profile, policy, reasons) {
  if (policy === 'cost') {
    const cost = declaredNumber(profile.costPerMillion);
    if (cost === null || cost < 0) {
      reasons.push('cost_unknown');
      return { eligible: false, score: null };
    }
    reasons.push(`cost:${cost}`);
    return { eligible: true, score: -cost };
  }

  if (policy === 'quality') {
    const quality = declaredNumber(profile.quality);
    if (quality === null) {
      reasons.push('quality_unknown');
      return { eligible: true, score: -1 };
    }
    reasons.push(`quality:${quality}`);
    return { eligible: true, score: quality };
  }

  if (policy === 'speed') {
    const speed = declaredNumber(profile.speed);
    if (speed === null) {
      reasons.push('speed_unknown');
      return { eligible: true, score: -1 };
    }
    reasons.push(`speed:${speed}`);
    return { eligible: true, score: speed };
  }

  return { eligible: true, score: 0 };
}

function evaluateProfile(profile, selector, { agent = null, policy = 'available', now = Date.now() } = {}) {
  const reasons = [];
  let eligible = true;
  let score = 0;

  if (profile.enabled === false) {
    eligible = false;
    reasons.push('disabled');
  }

  const agentCheck = agentCompatibility(profile, agent);
  if (!agentCheck.compatible) {
    eligible = false;
    reasons.push(agentCheck.reason);
  }

  if (profile.credential === null || profile.credential === undefined) {
    eligible = false;
    reasons.push('credential_missing');
  }

  for (const capability of selector.requireCapabilities ?? []) {
    if (!Array.isArray(profile.capabilities) || !profile.capabilities.includes(capability)) {
      eligible = false;
      reasons.push(`missing_capability:${capability}`);
    }
  }

  if (sourceShared(profile) && !selector.allowShared) {
    eligible = false;
    reasons.push('shared_source_requires_allowShared');
  }

  const source = sourceUnavailable(profile, now);
  if (source.unavailable) {
    eligible = false;
    reasons.push('source_unavailable');
  } else if (source.stale) {
    reasons.push('source_unavailable_stale');
  }

  const quota = quotaSignal(profile, now);
  if (quota.state === 'exhausted' || quota.exhausted) {
    if (quota.fresh) {
      eligible = false;
      reasons.push('quota_exhausted');
    } else {
      reasons.push('quota_exhausted_stale');
    }
  } else if (quota.state === 'unavailable') {
    if (quota.fresh) {
      eligible = false;
      reasons.push('quota_unavailable');
    } else {
      reasons.push('quota_unavailable_stale');
    }
  } else if (quota.state === 'available') {
    if (quota.fresh) score += 2;
    reasons.push(quota.fresh ? 'quota_available' : 'quota_available_stale');
  } else {
    reasons.push('quota_unknown');
  }

  const policyScore = scoreProfile(profile, policy, reasons);
  if (!policyScore.eligible) eligible = false;
  if (policy === 'available') {
    if (quota.state === 'available' && quota.fresh && !quota.exhausted) score += 2;
    else if (quota.state === 'unknown' || !quota.fresh) score -= 1;
  } else if (policyScore.score !== null) {
    score = policyScore.score;
  }

  return { profileId: profile.id, eligible, reasons, score, priority: priority(profile) };
}

function compareCandidates(a, b) {
  if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
  if (a.score !== b.score) return b.score - a.score;
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.profileId.localeCompare(b.profileId);
}

async function resolveProfile(store, id) {
  try {
    const profile = await store.resolve(id);
    if (!isPlainObject(profile) || profile.id !== id) {
      return { profile: null, candidate: { profileId: id, eligible: false, reasons: ['profile_invalid'], score: Number.NEGATIVE_INFINITY, priority: 0 } };
    }
    return { profile: clone(profile), candidate: null };
  } catch (error) {
    return {
      profile: null,
      candidate: {
        profileId: id,
        eligible: false,
        reasons: [`profile_unresolved:${error.code || error.name || 'error'}`],
        score: Number.NEGATIVE_INFINITY,
        priority: 0,
      },
    };
  }
}

async function routeDecision(store, rawSelector, options = {}) {
  const selector = validateExecution(rawSelector);
  const policy = selector.policy ?? 'available';
  const ids = selector.profile ? [selector.profile] : selector.profiles;
  const snapshots = new Map();
  const candidates = [];

  for (const id of ids) {
    const resolved = await resolveProfile(store, id);
    if (!resolved.profile) {
      candidates.push(resolved.candidate);
      continue;
    }
    snapshots.set(id, resolved.profile);
    const candidate = evaluateProfile(resolved.profile, selector, { agent: options.agent ?? null, policy });
    if (typeof store.credentialAvailable === 'function') {
      try {
        if (!await store.credentialAvailable(resolved.profile)) {
          candidate.eligible = false;
          candidate.reasons.push('credential_unavailable');
        }
      } catch {
        candidate.eligible = false;
        candidate.reasons.push('credential_check_failed');
      }
    }
    candidates.push(candidate);
  }

  candidates.sort(compareCandidates);
  const selectedProfileId = candidates.find(candidate => candidate.eligible)?.profileId ?? null;
  return {
    selectedProfileId,
    candidates,
    policy,
    signalBasis: 'declared-and-observed',
    snapshots,
    selector,
  };
}

function publicDecision(decision) {
  return {
    selectedProfileId: decision.selectedProfileId,
    candidates: decision.candidates.map(({ profileId, eligible, reasons, score }) => ({ profileId, eligible, reasons, score })),
    policy: decision.policy,
    signalBasis: decision.signalBasis,
  };
}

export async function explainRoute(store, selector, { agent = null, root = store?.root } = {}) {
  void root;
  return publicDecision(await routeDecision(store, selector, { agent }));
}

function validateOwner(owner) {
  if (!isPlainObject(owner)) throw routeError('invalid_owner', 'Reservation owner must be an object.');
  return {
    runId: validateId(owner.runId),
    taskId: validateId(owner.taskId),
    attemptId: validateAttemptId(owner.attemptId),
  };
}

export async function selectRoute(store, selector, owner, { agent = null } = {}) {
  const cleanOwner = validateOwner(owner);
  const root = store?.root;
  if (typeof root !== 'string' || root.length === 0) throw routeError('invalid_store', 'Profile store must expose a state root.');
  const decision = await routeDecision(store, selector, { agent });
  const automatic = !decision.selector.profile;
  let lastCapacityError = null;

  for (const candidate of decision.candidates.filter(c => c.eligible)) {
    const profile = decision.snapshots.get(candidate.profileId);
    if (!profile) continue;
    try {
      const reservation = await reserveExecution(root, profile, cleanOwner);
      decision.selectedProfileId = candidate.profileId;
      return { profile, reservation, decision: publicDecision(decision) };
    } catch (error) {
      if (!(error instanceof OrchestratorError) || error.code !== 'route_capacity_exhausted' || !automatic) throw error;
      candidate.eligible = false;
      candidate.reasons.push(`capacity_exhausted:${error.details?.bucketId ?? 'unknown'}`);
      decision.selectedProfileId = decision.candidates.find(c => c.eligible)?.profileId ?? null;
      lastCapacityError = error;
    }
  }

  if (lastCapacityError) {
    lastCapacityError.details = { ...lastCapacityError.details, decision: publicDecision(decision) };
    throw lastCapacityError;
  }
  throw routeError('route_unavailable', 'No eligible execution profile is available.', { decision: publicDecision(decision) });
}

function reservationsFile(root) {
  return path.join(root, 'routing', 'reservations.json');
}

function reservationsLock(root) {
  return path.join(root, 'locks', 'routing-reservations');
}

async function readReservations(root) {
  const data = await readJson(reservationsFile(root), { optional: true });
  if (!data) return [];
  if (data.schemaVersion !== RESERVATION_SCHEMA_VERSION || !Array.isArray(data.reservations)) {
    throw routeError('reservation_registry_invalid', 'Reservation registry is invalid.', { file: reservationsFile(root) });
  }
  for (const reservation of data.reservations) {
    if (!isPlainObject(reservation)) {
      throw routeError('reservation_registry_invalid', 'Reservation registry contains an invalid reservation.', { file: reservationsFile(root) });
    }
  }
  return data.reservations;
}

async function writeReservations(root, reservations) {
  await writeJsonAtomic(reservationsFile(root), { schemaVersion: RESERVATION_SCHEMA_VERSION, reservations });
}

function normalizeLimit(value) {
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function bucketIdForProfile(profile) {
  const accountId = profile.account?.id;
  if (typeof accountId === 'string' && accountId.length > 0) return `account:${accountId}`;
  if (typeof profile.endpoint !== 'string' || profile.endpoint.length === 0) {
    return `endpoint:${profile.protocol ?? 'unknown'}:unknown`;
  }
  try {
    const url = new URL(profile.endpoint);
    return `endpoint:${url.protocol}//${url.host.toLowerCase()}`;
  } catch {
    return `endpoint:${profile.endpoint.toLowerCase()}`;
  }
}

function reservationId() {
  return `res-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

function taskRecord(run, taskId) {
  const tasks = run?.tasks;
  if (Array.isArray(tasks)) return tasks.find(task => task?.id === taskId || task?.definition?.id === taskId) ?? null;
  if (isPlainObject(tasks)) return tasks[taskId] ?? Object.values(tasks).find(task => task?.id === taskId || task?.definition?.id === taskId) ?? null;
  return null;
}

function attemptRecords(run, task) {
  const pools = [];
  if (Array.isArray(task?.attempts)) pools.push(task.attempts);
  else if (isPlainObject(task?.attempts)) pools.push(Object.values(task.attempts));
  if (Array.isArray(run?.attempts)) pools.push(run.attempts);
  else if (isPlainObject(run?.attempts)) pools.push(Object.values(run.attempts));
  return pools.flat().filter(isPlainObject);
}

function attemptRecord(run, task, attemptId) {
  return attemptRecords(run, task).find(attempt => attempt.id === attemptId || attempt.attemptId === attemptId) ?? null;
}

function attemptClosed(attempt) {
  if (attempt.workerClosed === true) return true;
  const noWorkerLaunched = !attempt.paneId && !attempt.terminalId && !attempt.launchFinishedAt;
  if (noWorkerLaunched && ['failed', 'cancelled', 'canceled'].includes(attempt.status)) return true;
  return false;
}

function reservationStillActive(reservation, runsById) {
  const run = runsById.get(reservation.runId);
  if (!run) return false;
  const task = taskRecord(run, reservation.taskId);
  if (!task) return false;
  const attempt = attemptRecord(run, task, reservation.attemptId);
  if (!attempt) return false;
  return !attemptClosed(attempt);
}

async function reconcileReservations(root, reservations) {
  const runs = await listRuns(root);
  const runsById = new Map(runs.map(run => [run.id, run]));
  return reservations.filter(reservation => reservationStillActive(reservation, runsById));
}

function sortReservations(reservations) {
  return [...reservations].sort((a, b) => a.bucketId.localeCompare(b.bucketId) || a.id.localeCompare(b.id));
}

export async function reserveExecution(root, profile, owner) {
  const cleanOwner = validateOwner(owner);
  if (!isPlainObject(profile) || typeof profile.id !== 'string') throw routeError('invalid_profile', 'Profile snapshot is invalid.');
  const bucketId = bucketIdForProfile(profile);
  const declaredLimit = normalizeLimit(profile.account?.maxParallel);

  return withLock(reservationsLock(root), async () => {
    const current = await reconcileReservations(root, await readReservations(root));
    const activeInBucket = current.filter(reservation => reservation.bucketId === bucketId);
    const activeLimits = activeInBucket.map(reservation => normalizeLimit(reservation.limit));
    const limit = Math.min(declaredLimit, ...activeLimits, Number.POSITIVE_INFINITY);
    const effectiveLimit = Number.isFinite(limit) ? limit : declaredLimit;
    const existing = activeInBucket.find(reservation => reservation.runId === cleanOwner.runId && reservation.taskId === cleanOwner.taskId && reservation.attemptId === cleanOwner.attemptId);
    const activeCount = existing ? activeInBucket.length : activeInBucket.length + 1;
    if (activeCount > effectiveLimit) {
      await writeReservations(root, sortReservations(current));
      throw routeError('route_capacity_exhausted', 'Execution bucket capacity is exhausted.', {
        bucketId,
        limit: effectiveLimit,
        active: activeInBucket.length,
        scope: 'attempt',
      });
    }
    if (existing) {
      const updated = { ...existing, limit: Math.min(normalizeLimit(existing.limit), effectiveLimit) };
      const next = sortReservations(current.map(reservation => reservation.id === existing.id ? updated : reservation));
      await writeReservations(root, next);
      return updated;
    }

    const reservation = {
      id: reservationId(),
      bucketId,
      runId: cleanOwner.runId,
      taskId: cleanOwner.taskId,
      attemptId: cleanOwner.attemptId,
      limit: effectiveLimit,
      profileId: profile.id,
    };
    const next = sortReservations([...current, reservation]);
    await writeReservations(root, next);
    return reservation;
  });
}

export async function releaseExecution(root, reservation) {
  const reservationIdValue = typeof reservation === 'string' ? reservation : reservation?.id;
  if (typeof reservationIdValue !== 'string' || reservationIdValue.length === 0) return;
  await withLock(reservationsLock(root), async () => {
    const current = await reconcileReservations(root, await readReservations(root));
    await writeReservations(root, sortReservations(current.filter(item => item.id !== reservationIdValue)));
  });
}

export async function listReservations(root) {
  return withLock(reservationsLock(root), async () => {
    const active = sortReservations(await reconcileReservations(root, await readReservations(root)));
    await writeReservations(root, active);
    return active;
  });
}
