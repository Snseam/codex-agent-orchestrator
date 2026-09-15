import { constants as fsConstants, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 8 * 1024;
const ALLOWED_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'PermissionRequest',
  'Notification',
  'SessionEnd',
]);
const STATUS_BY_EVENT = {
  SessionStart: 'running',
  UserPromptSubmit: 'running',
  SubagentStart: 'running',
  SubagentStop: 'completed',
  Stop: 'idle',
  StopFailure: 'failed',
  PermissionRequest: 'waiting',
  Notification: 'unknown',
  SessionEnd: 'completed',
};
const SAFE_NOTIFICATION_TYPES = new Set([
  'permission_prompt',
  'idle_prompt',
  'auth_success',
  'agent_needs_input',
  'agent_completed',
  'quota_exceeded',
  'quota_auto_resume_scheduled',
  'quota_auto_resume_cancelled',
  'quota_auto_resume_resumed',
]);
const SAFE_SESSION_END_REASONS = new Set(['clear', 'logout', 'prompt_input_exit', 'other']);
const SAFE_STOP_FAILURES = new Set(['timeout', 'max_turns', 'paused', 'unknown']);

function argValue(args, name) {
  const eq = `${name}=`;
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1] ?? null;
  const found = args.find(arg => arg.startsWith(eq));
  return found ? found.slice(eq.length) : null;
}

function safeString(value, max = 160) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
  return cleaned || null;
}

function safeEnum(value, allowed, fallback = null) {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

function safeStatusReason(eventName, input, notificationType) {
  if (notificationType) return notificationType;
  if (eventName === 'SessionEnd') return safeEnum(input?.reason, SAFE_SESSION_END_REASONS, eventName);
  if (eventName === 'StopFailure') return safeEnum(input?.error, SAFE_STOP_FAILURES, eventName);
  return eventName;
}

export function sanitizeHookInput(input, context = {}, observedAt = new Date().toISOString()) {
  const hookEventName = safeEnum(input?.hook_event_name, ALLOWED_EVENTS, null);
  if (!hookEventName) return null;
  const agentId = safeString(input?.agent_id || input?.agent?.id || null, 128);
  const agentType = safeString(input?.agent_type || input?.agent?.type || null, 128);
  const isSubagent = Boolean(agentId || hookEventName === 'SubagentStart' || hookEventName === 'SubagentStop');
  const notificationType = safeEnum(input?.notification_type, SAFE_NOTIFICATION_TYPES, null);
  const nativeSessionId = safeString(input?.session_id || context.nativeSessionId || null, 256);

  return {
    schemaVersion: 1,
    source: 'claude-code-hook',
    observedAt,
    hookEventName,
    cao: {
      runId: safeString(context.runId, 128),
      taskId: safeString(context.taskId, 128),
      attemptId: safeString(context.attemptId, 128),
      workerName: safeString(context.workerName, 128),
    },
    claude: {
      nativeSessionId,
      sessionId: safeString(input?.session_id || null, 256),
      promptId: safeString(input?.prompt_id || null, 256),
      cwdHash: safeString(context.cwdHash || null, 128),
      transcriptPathHash: safeString(context.transcriptPathHash || null, 128),
      version: safeString(context.version || null, 64),
    },
    agent: {
      role: isSubagent ? 'subagent' : 'parent',
      agentId,
      agentType,
      status: STATUS_BY_EVENT[hookEventName] || 'unknown',
      statusReason: safeStatusReason(hookEventName, input, notificationType),
      notificationType,
      toolName: safeString(input?.tool_name || null, 128),
    },
    privacy: {
      payloadStored: false,
      contentStored: false,
      toolInputStored: false,
    },
  };
}

async function readBoundedStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

async function ensurePrivateRegularTarget(file) {
  const directory = path.dirname(file);
  const dirStat = await fs.lstat(directory).catch(() => null);
  if (!dirStat || !dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;
  const flags = fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0);
  try {
    return await fs.open(file, flags, 0o600);
  } catch {
    return null;
  }
}

async function appendRecord(file, record) {
  if (!record || !file || path.resolve(file) !== file) return;
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line) > MAX_RECORD_BYTES) return;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await ensurePrivateRegularTarget(file);
  if (!handle) return;
  try {
    await handle.writeFile(line, 'utf8');
  } finally {
    await handle.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const out = argValue(argv, '--out');
    const context = {
      runId: argValue(argv, '--run-id'),
      taskId: argValue(argv, '--task-id'),
      attemptId: argValue(argv, '--attempt-id'),
      workerName: argValue(argv, '--worker-name'),
      nativeSessionId: argValue(argv, '--native-session-id'),
      version: argValue(argv, '--version'),
      cwdHash: argValue(argv, '--cwd-hash'),
      transcriptPathHash: argValue(argv, '--transcript-path-hash'),
    };
    const text = await readBoundedStdin();
    if (text === null) return;
    let input;
    try { input = JSON.parse(text || '{}'); } catch { input = {}; }
    await appendRecord(out, sanitizeHookInput(input, context));
  } catch {
    // Observability must never block Claude Code.
  }
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    const modulePath = fileURLToPath(import.meta.url);
    const argvPath = path.resolve(process.argv[1]);
    if (modulePath === argvPath || import.meta.url === pathToFileURL(argvPath).href) return true;
    return realpathSync.native(modulePath) === realpathSync.native(argvPath);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  await main();
}
