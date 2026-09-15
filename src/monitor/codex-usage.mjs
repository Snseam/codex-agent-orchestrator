const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];

function safeInteger(value) {
  if (typeof value === 'bigint') return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function firstInt(...values) {
  for (const value of values) {
    const parsed = safeInteger(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function makeUsage({ total = null, input = null, output = null, cacheRead = null, cacheWrite = null, reasoning = null, scope = 'observed', source, complete = false } = {}) {
  const usage = {
    total: firstInt(total),
    input: firstInt(input),
    output: firstInt(output),
    cacheRead: firstInt(cacheRead),
    cacheWrite: firstInt(cacheWrite),
    reasoning: firstInt(reasoning),
    scope: ['session', 'turn', 'observed'].includes(scope) ? scope : 'observed',
    source: typeof source === 'string' && source.length > 0 ? source.slice(0, 80) : 'unknown',
    complete: complete === true,
  };
  if (usage.total === null) {
    if (usage.input !== null || usage.output !== null) {
      usage.total = (usage.input ?? 0) + (usage.output ?? 0);
    }
  }
  if (usage.total === null && fields.every(field => usage[field] === null)) return null;
  return usage;
}

function usageNumbers(value) {
  if (!value || typeof value !== 'object') return {};
  return {
    total: firstInt(value.total, value.totalTokens, value.total_tokens),
    input: firstInt(value.input, value.inputTokens, value.input_tokens),
    output: firstInt(value.output, value.outputTokens, value.output_tokens),
    cacheRead: firstInt(value.cacheRead, value.cache_read, value.cacheReadTokens, value.cache_read_tokens, value.cache_read_input_tokens, value.cachedInputTokens, value.cached_input_tokens),
    cacheWrite: firstInt(value.cacheWrite, value.cache_write, value.cacheWriteTokens, value.cache_write_tokens, value.cache_creation_input_tokens),
    reasoning: firstInt(value.reasoning, value.reasoningTokens, value.reasoning_tokens, value.reasoningOutputTokens, value.reasoning_output_tokens),
  };
}

function best(current, candidate) {
  if (!candidate) return current || null;
  if (!current) return candidate;
  if (candidate.complete !== current.complete) return candidate.complete ? candidate : current;
  const rank = { session: 3, turn: 2, observed: 1 };
  if (rank[candidate.scope] !== rank[current.scope]) return rank[candidate.scope] > rank[current.scope] ? candidate : current;
  if ((candidate.total ?? -1) !== (current.total ?? -1)) return (candidate.total ?? -1) > (current.total ?? -1) ? candidate : current;
  return current;
}

export function attachUsage(node, usage) {
  const selected = best(node.tokenUsage, usage);
  node.tokenUsage = selected || null;
  node.tokens = selected?.total ?? null;
}

export function usageFromStateThread(row) {
  return makeUsage({ total: row?.tokens_used, scope: 'session', source: 'state.threads.tokens_used', complete: safeInteger(row?.tokens_used) !== null });
}

export function usageFromProxyThread(thread) {
  const usage = thread?.tokenUsage || thread?.token_usage || thread?.usage || null;
  const tokensUsed = firstInt(thread?.tokensUsed, thread?.tokens_used);
  if (!usage || typeof usage !== 'object') {
    return makeUsage({ total: tokensUsed, scope: 'session', source: 'app-server.thread.tokensUsed', complete: tokensUsed !== null });
  }
  const totalUsage = usage.total && typeof usage.total === 'object' ? usage.total : null;
  const lastUsage = usage.last && typeof usage.last === 'object' ? usage.last : null;
  if (totalUsage || lastUsage) {
    const selected = usageNumbers(totalUsage ?? lastUsage);
    return makeUsage({
      ...selected,
      total: firstInt(selected.total, tokensUsed),
      scope: totalUsage ? 'session' : 'turn',
      source: 'app-server.thread.tokenUsage',
      complete: Boolean(totalUsage && selected.total !== null),
    });
  }
  const selected = usageNumbers(usage);
  return makeUsage({
    ...selected,
    total: firstInt(selected.total, tokensUsed),
    scope: usage.scope === 'turn' ? 'turn' : 'session',
    source: 'app-server.thread.tokenUsage',
    complete: firstInt(selected.total, tokensUsed) !== null,
  });
}

function rowUsage(row) {
  const scopeValue = typeof row.usage_scope === 'string' ? row.usage_scope : null;
  return makeUsage({
    total: firstInt(row.total, row.total_tokens, row.totalTokens, row.info_total_tokens, row.info_totalTokens),
    input: firstInt(row.input, row.input_tokens, row.inputTokens, row.info_input_tokens, row.info_inputTokens),
    output: firstInt(row.output, row.output_tokens, row.outputTokens, row.info_output_tokens, row.info_outputTokens),
    cacheRead: firstInt(row.cache_read, row.cacheRead, row.cache_read_tokens, row.cache_read_input_tokens, row.info_cached_input_tokens, row.info_cachedInputTokens),
    cacheWrite: firstInt(row.cache_write, row.cacheWrite, row.cache_write_tokens, row.cache_creation_input_tokens),
    reasoning: firstInt(row.reasoning, row.reasoning_tokens, row.reasoningTokens, row.info_reasoning_output_tokens, row.info_reasoningOutputTokens),
    scope: scopeValue === 'session' ? 'session' : (scopeValue === 'turn' ? 'turn' : 'turn'),
    source: 'history.thread_items.tokenUsage',
    complete: scopeValue === 'session' && firstInt(row.total, row.total_tokens, row.totalTokens, row.info_total_tokens, row.info_totalTokens) !== null,
  });
}

function addUsage(sum, usage) {
  if (!usage) return;
  if (usage.total !== null) sum.total = (sum.total ?? 0) + usage.total;
  for (const field of fields) if (usage[field] !== null) sum[field] = (sum[field] ?? 0) + usage[field];
}

export function usageFromHistoryRows(rows) {
  const sessionCandidates = [];
  const byTurn = new Map();
  const byItem = new Map();
  for (const row of rows || []) {
    const usage = rowUsage(row);
    if (!usage) continue;
    if (usage.scope === 'session' && usage.complete) {
      sessionCandidates.push(usage);
      continue;
    }
    const turnKey = typeof row.turn_id === 'string' && row.turn_id ? row.turn_id : null;
    if (turnKey) {
      const current = byTurn.get(turnKey);
      if (!current || (row.created_at_ms ?? 0) >= (current.created_at_ms ?? 0)) byTurn.set(turnKey, { usage, created_at_ms: row.created_at_ms ?? 0 });
    } else {
      const itemKey = typeof row.item_id === 'string' && row.item_id ? row.item_id : JSON.stringify(usage);
      byItem.set(itemKey, { usage, created_at_ms: row.created_at_ms ?? 0 });
    }
  }
  const session = sessionCandidates.reduce((acc, usage) => best(acc, usage), null);
  if (session) return session;
  const aggregate = { total: null, input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null };
  for (const value of byTurn.values()) addUsage(aggregate, value.usage);
  for (const value of byItem.values()) addUsage(aggregate, value.usage);
  return makeUsage({ ...aggregate, scope: 'observed', source: 'history.thread_items.tokenUsage', complete: false });
}
