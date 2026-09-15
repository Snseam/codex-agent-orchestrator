const MAX_NODES = 2000;
const MAX_ID = 256;
const MAX_TITLE = 160;

const statuses = ['running', 'waiting', 'failed', 'cancelled', 'unknown', 'idle', 'completed'];
const statusRank = new Map(statuses.map((status, index) => [status, index]));

function cleanString(value, max = MAX_ID) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ').trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function normalizeRef(value) {
  const id = cleanString(value);
  if (!id) return null;
  return id.startsWith('codex:') ? id.slice('codex:'.length) : id;
}

function conversationIdForRoot(node) {
  const native = cleanString(node?.nativeSessionId);
  if (native) return native;
  return normalizeRef(node?.id);
}

function isTopCodexRoot(node) {
  if (!node || node.agent !== 'codex' || node.kind !== 'coordinator') return false;
  const hasRecordedCaoAnchor = node.relation === 'cao' && cleanString(node.nativeSessionId);
  if (!hasRecordedCaoAnchor && node.confidence === 'unknown' && !node.startedAt && !node.updatedAt && !node.conversationTitle) return false;
  if (cleanString(node.parentId)) return false;
  return Boolean(conversationIdForRoot(node));
}

function hasUnambiguousConversationIdentity(node, index) {
  const key = normalizeRef(conversationIdForRoot(node));
  return Boolean(key && index.get(key) === node);
}

function validIso(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function betterStatus(left, right) {
  const a = statusRank.has(left) ? statusRank.get(left) : statusRank.get('unknown');
  const b = statusRank.has(right) ? statusRank.get(right) : statusRank.get('unknown');
  return a <= b ? left : right;
}

function safeStatus(value) {
  return statusRank.has(value) ? value : 'unknown';
}

function addAlias(index, alias, node) {
  const key = normalizeRef(alias);
  if (!key) return;
  if (!index.has(key)) index.set(key, node);
  else if (index.get(key) === null) return;
  else if (index.get(key) !== node) index.set(key, null);
}

function findRoot(node, index, cache) {
  if (!node?.id || node.relation === 'unlinked') return null;
  if (cache.has(node.id)) return cache.get(node.id);

  const seen = new Set();
  let cursor = node;
  const path = [];
  let root = null;

  while (cursor) {
    if (cursor.relation === 'unlinked') { root = null; break; }
    const cursorRef = normalizeRef(cursor.id);
    if (!cursorRef || index.get(cursorRef) !== cursor || seen.has(cursor.id)) {
      root = null;
      break;
    }
    seen.add(cursor.id);
    path.push(cursor.id);

    if (isTopCodexRoot(cursor) && hasUnambiguousConversationIdentity(cursor, index)) {
      root = cursor;
      break;
    }

    const parentRef = cleanString(cursor.parentId);
    if (!parentRef) {
      root = null;
      break;
    }
    const parent = index.get(normalizeRef(parentRef));
    if (!parent) {
      root = null;
      break;
    }
    cursor = parent;
  }

  for (const id of path) cache.set(id, root);
  return root;
}

export function deriveConversations(inputNodes, { currentConversationId = null } = {}) {
  const rawNodes = Array.isArray(inputNodes) ? inputNodes.slice(0, MAX_NODES) : [];
  const nodes = rawNodes.map(node => ({ ...(node && typeof node === 'object' ? node : {}) }));
  const byRef = new Map();

  for (const node of nodes) {
    addAlias(byRef, node.id, node);
    if (node?.agent === 'codex') addAlias(byRef, node.nativeSessionId, node);
  }

  const rootCache = new Map();
  const grouped = new Map();

  for (const node of nodes) {
    const root = findRoot(node, byRef, rootCache);
    const conversationId = root ? conversationIdForRoot(root) : null;
    node.conversationId = conversationId;
    if (!conversationId) continue;

    let conversation = grouped.get(conversationId);
    if (!conversation) {
      conversation = {
        id: conversationId,
        title: cleanString(root.conversationTitle, MAX_TITLE),
        rootNodeId: cleanString(root.id),
        projectIds: new Set(),
        status: safeStatus(root.status),
        updatedAt: null,
        agentCount: 0,
        current: false,
      };
      grouped.set(conversationId, conversation);
    }

    const projectId = cleanString(node.projectId, 1024);
    if (projectId) conversation.projectIds.add(projectId);
    conversation.status = betterStatus(conversation.status, safeStatus(node.status));
    const updatedAt = validIso(node.updatedAt);
    if (updatedAt && (!conversation.updatedAt || updatedAt > conversation.updatedAt)) conversation.updatedAt = updatedAt;
    conversation.agentCount += 1;
  }

  const currentNode = currentConversationId === null ? null : byRef.get(normalizeRef(currentConversationId));
  const currentRoot = currentNode ? findRoot(currentNode, byRef, rootCache) : null;
  const directCurrentId = currentRoot ? conversationIdForRoot(currentRoot) : normalizeRef(currentConversationId);
  const resolvedCurrentConversationId = directCurrentId && grouped.has(directCurrentId) ? directCurrentId : null;

  const conversations = [...grouped.values()].map(conversation => ({
    ...conversation,
    projectIds: [...conversation.projectIds].sort(),
    current: conversation.id === resolvedCurrentConversationId,
  })).sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    if (left.updatedAt !== right.updatedAt) return (right.updatedAt || '').localeCompare(left.updatedAt || '');
    return left.id.localeCompare(right.id);
  });

  return {
    nodes,
    conversations,
    currentConversationId: resolvedCurrentConversationId,
  };
}
