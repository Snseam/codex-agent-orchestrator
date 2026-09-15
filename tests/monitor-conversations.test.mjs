import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveConversations } from '../src/monitor/conversations.mjs';

function root(id, overrides = {}) {
  return {
    id: `codex:${id}`,
    parentId: null,
    agent: 'codex',
    kind: 'coordinator',
    nativeSessionId: id,
    conversationTitle: null,
    projectId: '/project',
    status: 'unknown',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function node(id, parentId, overrides = {}) {
  return {
    id,
    parentId,
    agent: 'claude',
    kind: 'agent',
    nativeSessionId: null,
    conversationTitle: null,
    projectId: '/project',
    status: 'running',
    updatedAt: '2026-01-01T00:00:01.000Z',
    tokens: null,
    tokenUsage: null,
    ...overrides,
  };
}

test('deriveConversations keeps two conversations in the same project separate', () => {
  const result = deriveConversations([
    root('thread-a', { conversationTitle: 'Conversation A', status: 'idle' }),
    node('cao:run-a:task:attempt', 'codex:thread-a'),
    root('thread-b', { conversationTitle: 'Conversation B', status: 'completed' }),
    node('cao:run-b:task:attempt', 'codex:thread-b'),
  ]);

  assert.deepEqual(result.conversations.map(conversation => conversation.id).sort(), ['thread-a', 'thread-b']);
  assert.equal(result.nodes.find(item => item.id === 'cao:run-a:task:attempt').conversationId, 'thread-a');
  assert.equal(result.nodes.find(item => item.id === 'cao:run-b:task:attempt').conversationId, 'thread-b');
  assert.deepEqual(result.conversations.find(item => item.id === 'thread-a').projectIds, ['/project']);
});

test('deriveConversations walks multi-layer Codex, CAO, Claude, and native child ancestry', () => {
  const result = deriveConversations([
    root('root-thread', { conversationTitle: 'Root Conversation', status: 'idle' }),
    node('codex:planner-child', 'root-thread', { agent: 'codex', kind: 'subagent', nativeSessionId: 'planner-child', status: 'completed' }),
    node('cao:run-one:task-one:attempt-one', 'codex:planner-child', { agent: 'claude', kind: 'agent', nativeSessionId: 'claude-parent', status: 'waiting' }),
    node('claude:claude-parent:researcher', 'cao:run-one:task-one:attempt-one', { agent: 'claude', kind: 'subagent', status: 'running' }),
  ], { currentConversationId: 'claude:claude-parent:researcher' });

  assert.equal(result.currentConversationId, 'root-thread');
  assert.equal(result.conversations.length, 1);
  assert.deepEqual(result.conversations[0], {
    id: 'root-thread',
    title: 'Root Conversation',
    rootNodeId: 'codex:root-thread',
    projectIds: ['/project'],
    status: 'running',
    updatedAt: '2026-01-01T00:00:01.000Z',
    agentCount: 4,
    current: true,
  });
  assert.deepEqual(result.nodes.map(item => item.conversationId), ['root-thread', 'root-thread', 'root-thread', 'root-thread']);
});

test('deriveConversations resolves current conversation from bare or codex-prefixed IDs', () => {
  const nodes = [
    root('root-thread'),
    node('codex:child-thread', 'codex:root-thread', { agent: 'codex', kind: 'subagent', nativeSessionId: 'child-thread' }),
  ];

  assert.equal(deriveConversations(nodes, { currentConversationId: 'child-thread' }).currentConversationId, 'root-thread');
  assert.equal(deriveConversations(nodes, { currentConversationId: 'codex:child-thread' }).currentConversationId, 'root-thread');
  assert.equal(deriveConversations(nodes, { currentConversationId: 'codex:root-thread' }).currentConversationId, 'root-thread');
});

test('deriveConversations leaves legacy and unlinked rows null', () => {
  const result = deriveConversations([
    node('legacy-cao', null, { relation: 'unlinked', label: 'Looks like root', conversationTitle: 'Not real' }),
    node('codex:orphan-child', null, { agent: 'codex', kind: 'subagent', nativeSessionId: 'orphan-child', conversationTitle: 'Child title' }),
  ]);

  assert.equal(result.conversations.length, 0);
  assert.deepEqual(result.nodes.map(item => item.conversationId), [null, null]);
});

test('deriveConversations rejects missing parents, cycles, and ambiguous ancestry', () => {
  const result = deriveConversations([
    node('codex:missing-child', 'codex:missing-root', { agent: 'codex', kind: 'subagent', nativeSessionId: 'missing-child' }),
    node('cycle-a', 'cycle-b'),
    node('cycle-b', 'cycle-a'),
    root('ambiguous-a', { nativeSessionId: 'same-native' }),
    root('ambiguous-b', { nativeSessionId: 'same-native' }),
    node('ambiguous-child', 'same-native'),
  ]);

  assert.equal(result.nodes.find(item => item.id === 'codex:missing-child').conversationId, null);
  assert.equal(result.nodes.find(item => item.id === 'cycle-a').conversationId, null);
  assert.equal(result.nodes.find(item => item.id === 'cycle-b').conversationId, null);
  assert.equal(result.nodes.find(item => item.id === 'ambiguous-child').conversationId, null);
});

test('deriveConversations continues through middle coordinators to the top coordinator', () => {
  const result = deriveConversations([
    root('top-root', { conversationTitle: 'Top Conversation' }),
    root('middle-root', { parentId: 'codex:top-root', conversationTitle: 'Middle Must Not Win' }),
    node('child-agent', 'codex:middle-root'),
  ]);

  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].id, 'top-root');
  assert.equal(result.conversations[0].title, 'Top Conversation');
  assert.equal(result.nodes.find(item => item.id === 'codex:middle-root').conversationId, 'top-root');
  assert.equal(result.nodes.find(item => item.id === 'child-agent').conversationId, 'top-root');
});

test('deriveConversations does not group coordinator cycles', () => {
  const result = deriveConversations([
    root('coordinator-a', { parentId: 'codex:coordinator-b' }),
    root('coordinator-b', { parentId: 'codex:coordinator-a' }),
    node('cycle-child', 'codex:coordinator-a'),
  ]);

  assert.equal(result.conversations.length, 0);
  assert.deepEqual(result.nodes.map(item => item.conversationId), [null, null, null]);
});

test('deriveConversations does not let duplicate root ids or aliases self-resolve', () => {
  const result = deriveConversations([
    root('duplicate-id', { conversationTitle: 'First' }),
    root('duplicate-id', { conversationTitle: 'Second' }),
    root('alias-a', { nativeSessionId: 'shared-native' }),
    root('alias-b', { nativeSessionId: 'shared-native' }),
    node('id-child', 'codex:duplicate-id'),
    node('alias-child', 'shared-native'),
  ]);

  assert.equal(result.conversations.length, 0);
  assert.deepEqual(result.nodes.map(item => item.conversationId), [null, null, null, null, null, null]);
});

test('deriveConversations preserves unknown root status over completed children', () => {
  const result = deriveConversations([
    root('unknown-root', { status: 'unknown' }),
    node('completed-child-a', 'codex:unknown-root', { status: 'completed' }),
    node('completed-child-b', 'codex:unknown-root', { status: 'completed' }),
  ]);

  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].status, 'unknown');
});

test('deriveConversations allows recorded CAO coordinator placeholder as an unknown conversation anchor', () => {
  const result = deriveConversations([
    root('cao-root', {
      confidence: 'unknown',
      conversationTitle: null,
      relation: 'cao',
      startedAt: null,
      updatedAt: null,
    }),
    node('cao:run:task:attempt', 'codex:cao-root', { relation: 'cao', status: 'completed' }),
  ], { currentConversationId: 'cao-root' });

  assert.equal(result.currentConversationId, 'cao-root');
  assert.deepEqual(result.conversations, [{
    id: 'cao-root',
    title: null,
    rootNodeId: 'codex:cao-root',
    projectIds: ['/project'],
    status: 'unknown',
    updatedAt: '2026-01-01T00:00:01.000Z',
    agentCount: 2,
    current: true,
  }]);
  assert.deepEqual(result.nodes.map(item => item.conversationId), ['cao-root', 'cao-root']);
});

test('deriveConversations keeps source-less unknown placeholders unlinked', () => {
  const result = deriveConversations([
    root('unknown-placeholder', {
      confidence: 'unknown',
      conversationTitle: null,
      relation: 'native',
      startedAt: null,
      updatedAt: null,
    }),
    node('placeholder-child', 'codex:unknown-placeholder', { status: 'running' }),
  ]);

  assert.equal(result.conversations.length, 0);
  assert.deepEqual(result.nodes.map(item => item.conversationId), [null, null]);
});

test('deriveConversations uses only conversationTitle for titles', () => {
  const result = deriveConversations([
    root('with-title', { conversationTitle: 'Actual Title', label: 'Ignored label', preview: 'Ignored preview', prompt: 'Ignored prompt' }),
    root('without-title', { conversationTitle: null, label: 'Coordinator Label', preview: 'Preview text', prompt: 'Prompt text' }),
  ]);

  assert.equal(result.conversations.find(item => item.id === 'with-title').title, 'Actual Title');
  assert.equal(result.conversations.find(item => item.id === 'without-title').title, null);
});

test('deriveConversations does not mutate input and preserves token counters without aggregation', () => {
  const tokenUsage = { total: 100, input: 60, output: 30, cacheRead: 20, cacheWrite: null, reasoning: null, scope: 'turn', source: 'test', complete: true };
  const input = [
    root('token-root', { tokens: 100, tokenUsage }),
    node('token-child', 'token-root', { tokens: 50, tokenUsage: { ...tokenUsage, total: 50 } }),
  ];
  const before = structuredClone(input);
  const result = deriveConversations(input);

  assert.deepEqual(input, before);
  assert.equal(result.nodes[0].tokens, 100);
  assert.equal(result.nodes[0].tokenUsage, tokenUsage);
  assert.equal(result.nodes[1].tokens, 50);
  assert.equal(Object.hasOwn(result.conversations[0], 'tokens'), false);
  assert.equal(Object.hasOwn(result.conversations[0], 'tokenUsage'), false);
  assert.equal(result.conversations[0].agentCount, 2);
});
