import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const MAX_USAGE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_USAGE_LINE_BYTES = 512 * 1024;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const usageCache = new Map();

function safeInt(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function addNullable(a, b) {
  if (a === null && b === null) return null;
  return (a || 0) + (b || 0);
}

export function claudeProjectSlug(value) {
  return path.resolve(value).replace(/[^A-Za-z0-9]/g, '-');
}

function safePathId(value) {
  return typeof value === 'string' && SAFE_ID_RE.test(value) ? value : null;
}

function sumObjectIntegers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let total = null;
  for (const item of Object.values(value)) {
    const n = safeInt(item);
    if (n !== null) total = (total || 0) + n;
  }
  return total;
}

function usageNumbers(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const input = safeInt(usage.input_tokens);
  const output = safeInt(usage.output_tokens);
  const cacheRead = safeInt(usage.cache_read_input_tokens);
  const cacheWrite = safeInt(usage.cache_creation_input_tokens) ?? sumObjectIntegers(usage.cache_creation);
  const details = usage.output_tokens_details && typeof usage.output_tokens_details === 'object' ? usage.output_tokens_details : null;
  const reasoning = safeInt(details?.thinking_tokens) ?? safeInt(details?.reasoning_tokens) ?? safeInt(usage.reasoning_tokens);
  const total = [input, output, cacheRead, cacheWrite].reduce(addNullable, null);
  if (total === null && reasoning === null) return null;
  return { input, output, cacheRead, cacheWrite, reasoning, total };
}

function betterUsage(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (b.total || 0) >= (a.total || 0) ? b : a;
}

function emptyTotals() {
  return { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, total: null };
}

function addUsage(totals, usage) {
  totals.input = addNullable(totals.input, usage.input);
  totals.output = addNullable(totals.output, usage.output);
  totals.cacheRead = addNullable(totals.cacheRead, usage.cacheRead);
  totals.cacheWrite = addNullable(totals.cacheWrite, usage.cacheWrite);
  totals.reasoning = addNullable(totals.reasoning, usage.reasoning);
  totals.total = addNullable(totals.total, usage.total);
}

function resultFromMessages(byMessage, complete) {
  if (byMessage.size === 0) return null;
  const totals = emptyTotals();
  for (const usage of byMessage.values()) addUsage(totals, usage);
  return {
    total: totals.total,
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    reasoning: totals.reasoning,
    scope: complete ? 'session' : 'observed',
    source: 'claude-jsonl',
    complete,
  };
}

async function parseUsageFile(file, maxBytes) {
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const key = path.resolve(file);
    const cached = usageCache.get(key);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.maxBytes === maxBytes) return cached.result;
    const windowed = stat.size > maxBytes;
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
    let complete = !windowed;
    let text = buffer.toString('utf8');
    if (windowed) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline >= 0) text = text.slice(firstNewline + 1);
      complete = false;
    }
    const byMessage = new Map();
    for (const line of text.split('\n')) {
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_USAGE_LINE_BYTES) { complete = false; continue; }
      let record;
      try { record = JSON.parse(line); } catch { complete = false; continue; }
      const message = record?.message && typeof record.message === 'object' ? record.message : null;
      if (!message?.usage || record.type !== 'assistant') continue;
      const id = typeof message.id === 'string' && message.id ? message.id : null;
      if (!id) { complete = false; continue; }
      const usage = usageNumbers(message.usage);
      if (!usage) { complete = false; continue; }
      byMessage.set(id, betterUsage(byMessage.get(id), usage));
    }
    const result = resultFromMessages(byMessage, complete);
    usageCache.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, maxBytes, result });
    if (usageCache.size > 512) usageCache.delete(usageCache.keys().next().value);
    return result;
  } finally {
    await handle.close();
  }
}

export function claudeTranscriptPath({ home, cwd, sessionId, agentId = null }) {
  const safeSession = safePathId(sessionId);
  if (!cwd || !safeSession) return null;
  const root = path.join(home || path.join(os.homedir(), '.claude'), 'projects', claudeProjectSlug(cwd));
  if (agentId) {
    const safeAgent = safePathId(agentId);
    if (!safeAgent) return null;
    return path.join(root, safeSession, 'subagents', `agent-${safeAgent}.jsonl`);
  }
  return path.join(root, `${safeSession}.jsonl`);
}

export async function readClaudeUsage(file, { maxBytes = MAX_USAGE_FILE_BYTES } = {}) {
  if (!file) return null;
  return parseUsageFile(path.resolve(file), maxBytes).catch(() => null);
}

export async function usageForClaudeSession({ home, cwd, sessionId, agentId = null } = {}) {
  const file = claudeTranscriptPath({ home, cwd, sessionId, agentId });
  return readClaudeUsage(file);
}
