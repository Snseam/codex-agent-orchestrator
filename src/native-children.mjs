import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_EVENTS_FILE_BYTES = 1024 * 1024;
const MAX_EVENT_BYTES = 8192;
const ACTIVE_STATUSES = new Set(['running', 'unknown']);
const COMPLETE_REPORT_STATUSES = new Set(['completed', 'cancelled']);
const CHILD_EVENTS = new Set(['SubagentStart', 'SubagentStop']);
const RECOGNIZED_SOURCE = 'claude-code-hook';

function safeText(value, fallback = null, max = 160) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
  return cleaned || fallback;
}

function safeIdPart(value, fallback = 'unknown') {
  return safeText(value, fallback, 128)?.replace(/[^a-zA-Z0-9_.:-]/g, '_') || fallback;
}

function taskId(task) {
  return task?.id || task?.definition?.id || 'unknown-task';
}

function attemptId(attempt) {
  return attempt?.id || 'unknown-attempt';
}

function agentKind(task, attempt) {
  return task?.agent || task?.definition?.agent || attempt?.agent || attempt?.agentKind || null;
}

function attemptTelemetry(attempt) {
  return attempt?.telemetry || attempt?.claudeTelemetry || attempt?.launchManifest?.telemetry || null;
}

function expectedClaudeDirectory(root, runId, task, attempt) {
  return path.join(path.resolve(root), 'monitor', 'claude', safeIdPart(runId), safeIdPart(taskId(task)), safeIdPart(attemptId(attempt)));
}

function expectedClaudeEventsFile(root, runId, task, attempt) {
  return path.join(expectedClaudeDirectory(root, runId, task, attempt), 'events.ndjson');
}

function isPathInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

async function readRegularFileBounded(file, maxBytes) {
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return { ok: false, reason: 'telemetry_file_unsafe', text: '' };
    return { ok: true, text: await handle.readFile('utf8') };
  } catch {
    return { ok: false, reason: 'telemetry_unavailable', text: '' };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function eventTime(event, index) {
  const parsed = Date.parse(event?.observedAt || event?.timestamp || '');
  return Number.isFinite(parsed) ? parsed : index;
}

function eventNativeSession(event) {
  return safeText(event?.claude?.sessionId || event?.claude?.nativeSessionId || event?.session_id || event?.sessionId, null, 256);
}

function caoMatches(event, { runId, taskId: expectedTaskId, attemptId: expectedAttemptId }) {
  const cao = event?.cao;
  return cao?.runId === runId && cao?.taskId === expectedTaskId && cao?.attemptId === expectedAttemptId;
}

function recognizedEvent(event, context) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  if (event.schemaVersion !== 1 || event.source !== RECOGNIZED_SOURCE) return false;
  if (!CHILD_EVENTS.has(event.hookEventName)) return false;
  if (!caoMatches(event, context)) return false;
  const agentId = safeText(event?.agent?.agentId, null, 128);
  return Boolean(agentId);
}

function parseEvents(text, context, declaredSession) {
  const events = [];
  let selectedSession = declaredSession || null;
  let complete = true, matchingEvidence = false;
  const lines = text.split('\n').filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (Buffer.byteLength(line) > MAX_EVENT_BYTES) { complete = false; continue; }
    let event;
    try { event = JSON.parse(line); } catch { complete = false; continue; }
    const nativeSession = eventNativeSession(event);
    if (event?.schemaVersion === 1 && event.source === RECOGNIZED_SOURCE && caoMatches(event, context) && nativeSession && (!selectedSession || selectedSession === nativeSession)) matchingEvidence = true;
    if (!recognizedEvent(event, context)) continue;
    const session = eventNativeSession(event);
    if (!session || (selectedSession && selectedSession !== session)) continue;
    if (!selectedSession && session) selectedSession = session;
    events.push({ event, index, time: eventTime(event, index) });
  }
  events.sort((a, b) => a.time - b.time || a.index - b.index);
  return { events, selectedSession, complete: complete && matchingEvidence };
}

function replayClaudeChildren(events) {
  const children = new Map();
  for (const { event } of events) {
    const id = safeText(event?.agent?.agentId, null, 128);
    if (!id) continue;
    const existing = children.get(id) || { id, status: 'unknown' };
    if (event.hookEventName === 'SubagentStart') existing.status = 'running';
    if (event.hookEventName === 'SubagentStop') existing.status = 'completed';
    children.set(id, existing);
  }
  return [...children.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function reportedChildren(report) {
  return Array.isArray(report?.children)
    ? report.children.flatMap(child => {
      const id = safeText(child?.id, null, 128);
      const status = safeText(child?.status, 'unknown', 32);
      return id ? [{ id, status }] : [];
    })
    : [];
}

function reportedComplete(children) {
  return children.every(child => COMPLETE_REPORT_STATUSES.has(child.status));
}

function reportHasChild(reportIds, child, selectedSession) {
  return reportIds.has(child.id) || (selectedSession && reportIds.has(`claude:${safeIdPart(selectedSession)}:${safeIdPart(child.id)}`));
}

function mergeChildren(observed, reported) {
  const merged = new Map(reported.map(child => [child.id, { id: child.id, status: child.status }]));
  for (const child of observed) merged.set(child.id, { id: child.id, status: child.status });
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function outcome({ state, complete, source, children, reasons }) {
  return { state, complete, source, children, reasons };
}

function reportOnly({ task, report, source = 'report-contract', reason = null }) {
  const children = reportedChildren(report);
  const reasons = [];
  const maxChildren = task?.maxChildren ?? task?.definition?.maxChildren ?? 0;
  if (!reportedComplete(children)) reasons.push('reported_child_unfinished');
  if (children.length > maxChildren) reasons.push('reported_child_budget_exceeded');
  if (reason) reasons.push(reason);
  return outcome({
    state: reasons.some(item => item !== reason) ? 'blocked' : 'reported',
    complete: reasons.length === 0 || (reasons.length === 1 && reasons[0] === reason),
    source,
    children,
    reasons,
  });
}

async function claudeTelemetryChildren({ root, runId, task, attempt }) {
  const telemetry = attemptTelemetry(attempt);
  if (!telemetry?.enabled || !telemetry?.eventsFile) return { ok: false, reason: telemetry?.reason || 'telemetry_unavailable', observed: [], selectedSession: null };
  const expectedDirectory = expectedClaudeDirectory(root, runId, task, attempt);
  const expectedFile = expectedClaudeEventsFile(root, runId, task, attempt);
  const eventsFile = path.resolve(telemetry.eventsFile);
  if (eventsFile !== expectedFile || !isPathInside(expectedDirectory, eventsFile)) {
    return { ok: false, reason: 'telemetry_path_mismatch', observed: [], selectedSession: null };
  }
  const directory = await fs.lstat(expectedDirectory).catch(() => null);
  if (!directory?.isDirectory() || directory.isSymbolicLink()) return { ok: false, reason: 'telemetry_directory_unsafe', observed: [], selectedSession: null };
  const read = await readRegularFileBounded(eventsFile, MAX_EVENTS_FILE_BYTES);
  if (!read.ok) return { ok: false, reason: read.reason, observed: [], selectedSession: null };
  const context = { runId, taskId: taskId(task), attemptId: attemptId(attempt) };
  const declaredSession = telemetry.nativeSessionId || attempt?.nativeSessionId || attempt?.nativeSession?.id || attempt?.nativeSession || null;
  const { events, selectedSession, complete } = parseEvents(read.text, context, declaredSession);
  return { ok: true, complete, reason: complete ? null : 'telemetry_incomplete', observed: replayClaudeChildren(events), selectedSession };
}

export async function checkNativeChildren({ root, runId, task, attempt, report }) {
  const reported = reportedChildren(report);
  if (!reportedComplete(reported)) {
    return outcome({ state: 'blocked', complete: false, source: 'report-contract', children: reported, reasons: ['reported_child_unfinished'] });
  }

  const maxChildren = task?.maxChildren ?? task?.definition?.maxChildren ?? 0;
  if (reported.length > maxChildren) {
    return outcome({ state: 'blocked', complete: false, source: 'report-contract', children: reported, reasons: ['reported_child_budget_exceeded'] });
  }

  const kind = agentKind(task, attempt);
  if (kind !== 'claude') {
    return reportOnly({ task, report, reason: kind ? `${kind}_telemetry_unsupported` : 'native_telemetry_unsupported' });
  }

  const telemetry = await claudeTelemetryChildren({ root, runId, task, attempt });
  if (!telemetry.ok) {
    if (maxChildren === 0 && reported.length === 0) {
      return outcome({ state: 'reported', complete: true, source: 'report-contract', children: [], reasons: [telemetry.reason] });
    }
    return outcome({ state: 'unknown', complete: false, source: 'claude-hooks', children: reported, reasons: [telemetry.reason] });
  }

  const observed = telemetry.observed;
  const reportIds = new Set(reported.map(child => child.id));
  const reasons = [];
  if (observed.length > maxChildren) reasons.push('observed_child_budget_exceeded');
  for (const child of observed) {
    if (ACTIVE_STATUSES.has(child.status)) reasons.push(`observed_child_${child.status}:${child.id}`);
    if (!reportHasChild(reportIds, child, telemetry.selectedSession)) reasons.push(`observed_child_omitted:${child.id}`);
  }
  for (const child of reported) {
    const observedMatch = observed.some(item => item.id === child.id || (telemetry.selectedSession && child.id === `claude:${safeIdPart(telemetry.selectedSession)}:${safeIdPart(item.id)}`));
    if (!observedMatch) reasons.push(`reported_child_unobserved:${child.id}`);
  }
  const children = mergeChildren(observed, reported);
  if (!reasons.length && !telemetry.complete && maxChildren > 0) return outcome({ state: 'unknown', complete: false, source: 'claude-hooks', children, reasons: ['telemetry_incomplete'] });
  return outcome({
    state: reasons.length ? 'blocked' : 'verified',
    complete: reasons.length === 0,
    source: 'claude-hooks',
    children,
    reasons,
  });
}
