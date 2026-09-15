import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationTitle, normalizeConversations, resolveConversationSelection, shortId } from '../web/monitor/conversations.mjs';

test('conversation helpers use native title only and fall back to Codex short id', () => {
  assert.equal(shortId('abcdef123456'), 'abcd…3456');
  assert.equal(conversationTitle({ id: 'abcdef123456', title: 'Release thread' }, 'en'), 'Release thread');
  assert.equal(conversationTitle({ id: 'abcdef123456', title: null }, 'en'), 'Codex abcd…3456');
  assert.equal(conversationTitle({ id: 'abcdef123456' }, 'zh'), 'Codex abcd…3456');
});

test('normalizeConversations sorts current first without reading node labels', () => {
  const snapshot = {
    currentConversationId: 'b',
    conversations: [
      { id: 'a', title: null, updatedAt: '2026-09-14T00:00:00Z', agentCount: 2 },
      { id: 'b', title: 'Current thread', updatedAt: '2026-09-13T00:00:00Z', agentCount: 1 },
    ],
    nodes: [{ id: 'n', label: 'Do not use as title' }],
  };
  const normalized = normalizeConversations(snapshot, 'en');
  assert.deepEqual(normalized.map(item => item.id), ['b', 'a']);
  assert.equal(normalized[1].title, 'Codex a');
});

test('conversation selection defaults to project and conversation mode prefers current only before user selection', () => {
  const snapshot = { currentConversationId: 'b', conversations: [{ id: 'a' }, { id: 'b' }] };
  assert.deepEqual(resolveConversationSelection({ snapshot, previous: { view: 'project' } }).view, 'project');
  const firstConversation = resolveConversationSelection({ snapshot, previous: { view: 'conversation' }, userSelected: false });
  assert.equal(firstConversation.conversationId, 'b');
  const userSelection = resolveConversationSelection({ snapshot, previous: { view: 'conversation', conversationId: 'a' }, userSelected: true });
  assert.equal(userSelection.conversationId, 'a');
});

test('conversation selection preserves unlinked and reports missing current conversation', () => {
  const snapshot = { currentConversationId: 'missing', conversations: [{ id: 'a' }] };
  const unlinked = resolveConversationSelection({ snapshot, previous: { view: 'conversation', unlinked: true } });
  assert.equal(unlinked.unlinked, true);
  assert.equal(unlinked.conversationId, null);
  const missing = resolveConversationSelection({ snapshot, previous: { view: 'conversation' }, userSelected: false });
  assert.equal(missing.currentMissing, true);
  assert.equal(missing.conversationId, 'a');
});

test('conversation selection falls back to unlinked when no conversations exist', () => {
  const snapshot = { currentConversationId: null, conversations: [] };
  const selection = resolveConversationSelection({ snapshot, previous: { view: 'conversation' }, userSelected: false });

  assert.equal(selection.view, 'conversation');
  assert.equal(selection.conversationId, null);
  assert.equal(selection.unlinked, true);
  assert.equal(selection.currentMissing, false);
});

test('conversation selection preserves saved root through initial reload before snapshot arrives', () => {
  const saved = { view: 'conversation', conversationId: 'codex:root', unlinked: false };
  const loading = resolveConversationSelection({ snapshot: null, previous: saved, userSelected: false });

  assert.equal(loading.view, 'conversation');
  assert.equal(loading.conversationId, 'codex:root');
  assert.equal(loading.unlinked, false);

  const loaded = resolveConversationSelection({
    snapshot: { currentConversationId: 'codex:root', conversations: [{ id: 'codex:root', agentCount: 2 }] },
    previous: { view: loading.view, conversationId: loading.conversationId, unlinked: loading.unlinked },
    userSelected: false,
  });

  assert.equal(loaded.conversationId, 'codex:root');
  assert.equal(loaded.unlinked, false);
});
