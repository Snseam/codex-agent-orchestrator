import crypto from 'node:crypto';
import path from 'node:path';
import { OrchestratorError } from './errors.mjs';
import { readJson, validateId, withLock, writeJsonAtomic } from './state.mjs';
import { taskDigest } from './task.mjs';

const SCHEMA_VERSION = 1;
const PREFERENCES = new Set(['balanced', 'fastest', 'subscription-first', 'quality-first']);
const FRESH_TTL_MS = 15 * 60 * 1000;
const MAX_REASONS = 12;
const MAX_CANDIDATES = 12;
const MAX_EVIDENCE_ITEMS = 8;
const RESOURCE_ID_RE = /^[A-Za-z0-9_.:@/-]{1,160}$/;

function shadowError(code, message, details = {}) {
  return new OrchestratorError(code, message, details);
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value, max = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function timeOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return stringOrNull(value, 64);
}

function cleanResourceId(value) {
  return typeof value === 'string' && RESOURCE_ID_RE.test(value) ? value : null;
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter(value => typeof value === 'string' && value.length > 0))].sort((a, b) => a.localeCompare(b));
}

function limited(values, max) {
  return values.slice(0, max);
}

function isoTime(now) {
  const value = typeof now === 'function' ? now() : now;
  if (!Number.isFinite(value)) return new Date().toISOString();
  return new Date(value).toISOString();
}

function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function evidenceFresh(record, nowMs) {
  if (!plain(record)) return false;
  const observedAt = parseTime(record.observedAt);
  if (observedAt === null || observedAt > nowMs) return false;
  const expiresAt = parseTime(record.expiresAt);
  if (expiresAt !== null) return expiresAt > nowMs;
  return nowMs - observedAt <= FRESH_TTL_MS;
}

function quotaExhausted(resource, nowMs) {
  const quota = resource.quota;
  if (!plain(quota)) return false;
  const fresh = evidenceFresh(quota, nowMs);
  return fresh && (quota.state === 'exhausted' || quota.remainingTokens === 0);
}

function safeTaskId(task) {
  return stringOrNull(task?.id, 128) || null;
}

function normalizeInventory(inventory) {
  if (!plain(inventory)) return [];
  const resources = Array.isArray(inventory.resources) ? inventory.resources : [];
  return resources.filter(plain).map(resource => ({
    id: cleanResourceId(resource.id),
    kind: stringOrNull(resource.kind, 64),
    agent: stringOrNull(resource.agent, 64),
    profileId: stringOrNull(resource.profileId, 128),
    providerId: stringOrNull(resource.providerId, 128),
    installed: resource.installed === true,
    configured: resource.configured === true,
    authentication: plain(resource.authentication) ? {
      state: stringOrNull(resource.authentication.state, 64) || 'unknown',
      source: stringOrNull(resource.authentication.source, 128) || null,
    } : { state: 'unknown', source: null },
    quota: plain(resource.quota) ? {
      state: stringOrNull(resource.quota.state, 64) || 'unknown',
      remainingTokens: Number.isFinite(resource.quota.remainingTokens) ? resource.quota.remainingTokens : null,
      observedAt: timeOrNull(resource.quota.observedAt),
      expiresAt: timeOrNull(resource.quota.expiresAt),
    } : null,
    capabilities: plain(resource.capabilities) ? {
      values: uniqueStrings(resource.capabilities.values),
      source: stringOrNull(resource.capabilities.source, 128) || 'unknown',
      unverified: resource.capabilities.unverified !== false,
    } : { values: [], source: 'unknown', unverified: true },
    probe: plain(resource.probe) ? {
      supported: resource.probe.supported === true,
      reason: stringOrNull(resource.probe.reason, 256),
    } : { supported: false, reason: null },
    callVerification: plain(resource.callVerification) ? {
      state: stringOrNull(resource.callVerification.state, 64) || 'unknown',
      observedAt: timeOrNull(resource.callVerification.observedAt),
      expiresAt: timeOrNull(resource.callVerification.expiresAt),
      errorCode: stringOrNull(resource.callVerification.errorCode, 128),
      qualityStatus: stringOrNull(resource.callVerification.qualityStatus, 64),
    } : { state: 'unknown', observedAt: null, expiresAt: null, errorCode: null, qualityStatus: null },
  })).filter(resource => resource.id);
}

function requestedCapabilities(task) {
  return uniqueStrings([
    ...uniqueStrings(task?.brief?.requiredCapabilities),
    ...uniqueStrings(task?.execution?.requireCapabilities),
  ]);
}

function fixedProfile(task, fixedProfileId) {
  const caller = stringOrNull(fixedProfileId, 128);
  const taskProfile = stringOrNull(task?.execution?.profile, 128);
  if (caller && taskProfile && caller !== taskProfile) {
    throw shadowError('shadow_fixed_profile_conflict', 'Caller fixedProfileId conflicts with task.execution.profile.', {
      fixedProfileId: caller,
      taskProfile,
    });
  }
  return caller || taskProfile;
}

function fixedAgentForTask(task, fixedAgent) {
  const explicit = stringOrNull(fixedAgent, 64);
  if (explicit) return explicit;
  if (plain(task?.execution) && Object.hasOwn(task, 'agent') && task.agent !== 'auto') return stringOrNull(task.agent, 64);
  return null;
}

function allowedSet(allowedResourceIds) {
  if (allowedResourceIds === undefined) return null;
  return new Set(uniqueStrings(allowedResourceIds).filter(cleanResourceId));
}

function evaluateResource(resource, { task, required, allowed, profileId, agent, nowMs }) {
  const reasons = [];
  let eligible = true;

  if (allowed && !allowed.has(resource.id)) {
    eligible = false;
    reasons.push('resource_not_in_allowlist');
  }
  if (profileId && resource.profileId !== profileId) {
    eligible = false;
    reasons.push('fixed_profile_mismatch');
  }
  if (agent && resource.agent !== agent) {
    eligible = false;
    reasons.push(`agent_mismatch:${resource.agent ?? 'unknown'}:${agent}`);
  }
  if (!resource.installed) {
    eligible = false;
    reasons.push('not_installed');
  }
  if (!resource.configured) {
    eligible = false;
    reasons.push('not_configured');
  }
  if (resource.authentication.state === 'missing') {
    eligible = false;
    reasons.push('authentication_missing');
  }
  if (quotaExhausted(resource, nowMs)) {
    eligible = false;
    reasons.push('quota_exhausted_fresh');
  }

  const callFresh = evidenceFresh(resource.callVerification, nowMs);
  if (resource.callVerification.state === 'unavailable' && callFresh) {
    eligible = false;
    reasons.push('call_verification_unavailable_fresh');
  }
  if (resource.callVerification.state !== 'verified' || !callFresh) {
    eligible = false;
    reasons.push(resource.callVerification.state === 'verified' ? 'call_verification_stale' : 'call_verification_not_verified');
  }

  if (required.length > 0) {
    if (resource.capabilities.unverified) {
      eligible = false;
      reasons.push('capabilities_unverified');
    }
    for (const capability of required) {
      if (!resource.capabilities.values.includes(capability)) {
        eligible = false;
        reasons.push(`capability_unavailable:${capability}`);
      }
    }
  }

  return {
    resourceId: resource.id,
    executorKind: 'external',
    eligible,
    reasons: limited([...new Set(reasons)], MAX_REASONS),
    evidence: {
      installed: resource.installed,
      configured: resource.configured,
      authentication: resource.authentication.state,
      callVerification: resource.callVerification.state,
      callVerificationFresh: callFresh,
      quota: resource.quota?.state || 'unknown',
      quotaFresh: evidenceFresh(resource.quota, nowMs),
      capabilities: required.length === 0 ? 'not-required' : resource.capabilities.unverified ? 'declared-unverified' : 'declared',
    },
    agent: resource.agent,
    profileId: resource.profileId,
    providerId: resource.providerId,
    kind: resource.kind,
  };
}

function riskLevel(task) {
  const risk = stringOrNull(task?.brief?.risk, 64)?.toLowerCase();
  if (['high', 'critical'].includes(risk)) return 'high';
  if (['low', 'trivial'].includes(risk)) return 'low';
  return risk || 'unknown';
}

function contextLevel(task) {
  const value = stringOrNull(task?.brief?.contextDependency, 64)?.toLowerCase();
  if (['high', 'deep'].includes(value)) return 'high';
  if (['low', 'none'].includes(value)) return 'low';
  return value || 'unknown';
}

function independentTask(task) {
  return task?.brief?.independent === true || ['simple', 'independent'].includes(stringOrNull(task?.brief?.taskKind, 64)?.toLowerCase());
}

function compareCandidates(a, b, preference) {
  if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
  const aq = a.evidence.quota === 'available' && a.evidence.quotaFresh;
  const bq = b.evidence.quota === 'available' && b.evidence.quotaFresh;
  if (aq !== bq) return aq ? -1 : 1;
  if (preference === 'quality-first') {
    const av = a.evidence.callVerification === 'verified' && a.evidence.callVerificationFresh;
    const bv = b.evidence.callVerification === 'verified' && b.evidence.callVerificationFresh;
    if (av !== bv) return av ? -1 : 1;
  }
  if (preference === 'subscription-first') {
    const an = a.kind === 'native';
    const bn = b.kind === 'native';
    if (an !== bn) return an ? -1 : 1;
  }
  return a.resourceId.localeCompare(b.resourceId);
}

function hostAllowed(allowed) {
  return allowed === null || allowed.has('host') || allowed.has('native-host');
}

function selectedHost() {
  return { executorKind: 'host', resourceId: null };
}

function decisionReasons({ preference, fixedProfileId, fixedAgent, hostAvailable, hostUsable, task, selected, externalEligible }) {
  const reasons = [`preference:${preference}`];
  if (fixedProfileId) reasons.push(`fixed_profile:${fixedProfileId}`);
  if (fixedAgent) reasons.push(`fixed_agent:${fixedAgent}`);
  if (!hostAvailable) reasons.push('host_unavailable');
  if (!hostUsable) reasons.push('host_not_allowed');
  if (preference === 'fastest') reasons.push('insufficient_comparative_latency_evidence');
  if (preference === 'subscription-first') reasons.push('subscription_cost_not_assumed_zero');
  if (preference === 'quality-first') reasons.push('quality_limited_to_fresh_call_evidence');
  if (riskLevel(task) === 'high') reasons.push('high_risk_prefers_host');
  if (riskLevel(task) === 'low' && contextLevel(task) === 'high') reasons.push('low_risk_high_context_dependency_prefers_host');
  if (independentTask(task)) reasons.push('independent_task_allows_external_advice');
  if (!externalEligible.length) reasons.push('no_verified_external_candidate');
  if (selected?.executorKind === 'external') reasons.push('shadow_advisory_only_not_dispatched');
  return limited([...new Set(reasons)], MAX_REASONS);
}

function sanitizeCandidates(candidates) {
  return limited(candidates, MAX_CANDIDATES).map(candidate => ({
    executorKind: candidate.executorKind,
    resourceId: candidate.resourceId,
    eligible: candidate.eligible,
    reasons: limited(candidate.reasons, MAX_REASONS),
    evidence: Object.fromEntries(Object.entries(candidate.evidence).slice(0, MAX_EVIDENCE_ITEMS)),
    ...(candidate.agent ? { agent: candidate.agent } : {}),
    ...(candidate.profileId ? { profileId: candidate.profileId } : {}),
  }));
}

function ensureSelectedCandidateReturned(selected, candidates) {
  if (selected?.executorKind !== 'external') return candidates;
  const visible = limited(candidates, MAX_CANDIDATES);
  if (visible.some(candidate => candidate.resourceId === selected.resourceId)) return visible;
  const candidate = candidates.find(item => item.resourceId === selected.resourceId);
  return candidate ? [candidate, ...visible.slice(0, Math.max(0, MAX_CANDIDATES - 1))] : visible;
}

export async function explainShadowRoute({
  task,
  inventory,
  preference = 'balanced',
  hostAvailable = true,
  allowedResourceIds,
  fixedProfileId,
  fixedAgent,
  fixedExecutorKind,
  now = Date.now(),
} = {}) {
  if (!plain(task)) throw shadowError('invalid_shadow_task', 'Shadow routing requires a task object.');
  if (!PREFERENCES.has(preference)) throw shadowError('invalid_shadow_preference', 'Shadow routing preference is invalid.', { preference });
  if (fixedExecutorKind !== undefined && !['host', 'external'].includes(fixedExecutorKind)) throw shadowError('invalid_shadow_executor', 'Executor must be host or external.');

  const nowMs = typeof now === 'function' ? now() : now;
  const observedAt = isoTime(nowMs);
  const allowed = allowedSet(allowedResourceIds);
  const hostUsable = fixedExecutorKind !== 'external' && hostAvailable === true && hostAllowed(allowed);
  const profileId = fixedProfile(task, fixedProfileId);
  const agent = fixedAgentForTask(task, fixedAgent);
  if (fixedExecutorKind === 'host' && (task.execution || profileId || (agent && agent !== 'codex'))) throw shadowError('shadow_selector_conflict', 'Current-Codex work cannot use an external profile or a different agent.');
  const required = requestedCapabilities(task);
  const resources = normalizeInventory(inventory);

  let candidates = resources.map(resource => evaluateResource(resource, { task, required, allowed, profileId, agent, nowMs }));
  candidates.sort((a, b) => compareCandidates(a, b, preference));
  const externalEligible = candidates.filter(candidate => candidate.eligible);

  const fixedExternal = fixedExecutorKind === 'external' || Boolean(profileId || fixedAgent);
  let selected = null;
  if (fixedExecutorKind === 'host') {
    selected = hostUsable ? selectedHost() : null;
  } else if (fixedExternal) {
    selected = externalEligible[0] ? { executorKind: 'external', resourceId: externalEligible[0].resourceId } : null;
  } else if (hostUsable && (riskLevel(task) === 'high' || (riskLevel(task) === 'low' && contextLevel(task) === 'high'))) {
    selected = selectedHost();
  } else if (externalEligible.length > 0 && independentTask(task)) {
    selected = { executorKind: 'external', resourceId: externalEligible[0].resourceId };
  } else if (hostUsable) {
    selected = selectedHost();
  } else if (externalEligible.length > 0) {
    selected = { executorKind: 'external', resourceId: externalEligible[0].resourceId };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    mode: 'shadow',
    applied: false,
    selected,
    reasons: [...(fixedExecutorKind ? [`explicit_executor:${fixedExecutorKind}`] : []), ...decisionReasons({ preference, fixedProfileId: profileId, fixedAgent: fixedExecutorKind === 'host' ? null : agent, hostAvailable, hostUsable, task, selected, externalEligible })],
    candidates: sanitizeCandidates(ensureSelectedCandidateReturned(selected, candidates)),
    evidence: {
      resourceCount: resources.length,
      eligibleExternalCount: externalEligible.length,
      requiredCapabilities: required,
      comparativeLatency: 'insufficient_evidence',
      price: 'not_inferred',
    },
    taskId: safeTaskId(task),
    taskDigest: taskDigest(task),
    observedAt,
  };
}

function shadowFile(root, threadId) {
  const id = validateId(threadId);
  return path.join(root, 'shadow-routing', 'threads', `${id}.json`);
}

function shadowLock(root, threadId) {
  const id = validateId(threadId);
  return path.join(root, 'locks', 'shadow-routing', id);
}

function decisionId() {
  return `shadow-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

function safeDecision(decision, id) {
  if (!plain(decision) || decision.mode !== 'shadow' || decision.applied !== false) {
    throw shadowError('invalid_shadow_decision', 'Shadow decision must be an unapplied shadow decision.');
  }
  return {
    id,
    schemaVersion: SCHEMA_VERSION,
    mode: 'shadow',
    applied: false,
    selected: plain(decision.selected) ? {
      executorKind: decision.selected.executorKind === 'external' ? 'external' : 'host',
      resourceId: decision.selected.executorKind === 'external' ? cleanResourceId(decision.selected.resourceId) : null,
    } : null,
    reasons: limited(uniqueStrings(decision.reasons), MAX_REASONS),
    candidates: sanitizeCandidates(Array.isArray(decision.candidates) ? decision.candidates.map(candidate => ({
      executorKind: candidate.executorKind === 'external' ? 'external' : 'host',
      resourceId: cleanResourceId(candidate.resourceId) || null,
      eligible: candidate.eligible === true,
      reasons: uniqueStrings(candidate.reasons),
      evidence: plain(candidate.evidence) ? Object.fromEntries(Object.entries(candidate.evidence).slice(0, MAX_EVIDENCE_ITEMS)) : {},
      agent: stringOrNull(candidate.agent, 64),
      profileId: stringOrNull(candidate.profileId, 128),
    })) : []),
    evidence: plain(decision.evidence) ? {
      resourceCount: Number.isSafeInteger(decision.evidence.resourceCount) ? decision.evidence.resourceCount : 0,
      eligibleExternalCount: Number.isSafeInteger(decision.evidence.eligibleExternalCount) ? decision.evidence.eligibleExternalCount : 0,
      requiredCapabilities: uniqueStrings(decision.evidence.requiredCapabilities),
      comparativeLatency: stringOrNull(decision.evidence.comparativeLatency, 128) || 'insufficient_evidence',
      price: stringOrNull(decision.evidence.price, 128) || 'not_inferred',
    } : {},
    taskId: stringOrNull(decision.taskId, 128),
    taskDigest: stringOrNull(decision.taskDigest, 128),
    observedAt: stringOrNull(decision.observedAt, 64) || new Date().toISOString(),
    recordedAt: new Date().toISOString(),
  };
}

export async function recordShadowDecision(root, threadId, decision) {
  if (typeof root !== 'string' || root.length === 0) throw shadowError('invalid_shadow_root', 'Shadow routing root is required.');
  return withLock(shadowLock(root, threadId), async () => {
    const file = shadowFile(root, threadId);
    const current = await readJson(file, { optional: true });
    const decisions = Array.isArray(current?.decisions) ? current.decisions : [];
    let id;
    do { id = decisionId(); } while (decisions.some(item => item?.id === id));
    const record = safeDecision(decision, id);
    await writeJsonAtomic(file, {
      schemaVersion: SCHEMA_VERSION,
      threadId: validateId(threadId),
      decisions: [...decisions, record],
    });
    return record;
  });
}
