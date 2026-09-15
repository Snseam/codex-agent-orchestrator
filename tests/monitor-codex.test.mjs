import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { collectCodex, resetCodexCollectorCacheForTests } from '../src/monitor/codex.mjs';

async function tempHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-codex-monitor-'));
  await fs.mkdir(path.join(home, 'sqlite'), { recursive: true });
  return { home, cleanup: () => fs.rm(home, { recursive: true, force: true }) };
}

function makeState(home) {
  const db = new DatabaseSync(path.join(home, 'sqlite', 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads(
      id TEXT PRIMARY KEY,
      rollout_path TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      source TEXT,
      model_provider TEXT,
      cwd TEXT,
      title TEXT,
      first_user_message TEXT,
      preview TEXT,
      agent_nickname TEXT,
      agent_role TEXT,
      model TEXT,
      tokens_used INTEGER,
      reasoning_effort TEXT,
      agent_path TEXT,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      thread_source TEXT
    );
    CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT, status TEXT);
  `);
  return db;
}

function makeHistory(home) {
  const db = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
  db.exec(`
    CREATE TABLE thread_history_projection_state(thread_id TEXT, next_rollout_byte_offset INTEGER, next_rollout_ordinal INTEGER);
    CREATE TABLE thread_turns(
      thread_id TEXT,
      turn_id TEXT,
      rollout_ordinal INTEGER,
      status TEXT,
      error_json TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      duration_ms INTEGER,
      first_user_item_id TEXT,
      final_agent_item_id TEXT,
      rollout_byte_offset INTEGER,
      rollout_end_ordinal INTEGER,
      rollout_end_byte_offset INTEGER
    );
    CREATE TABLE thread_items(
      thread_id TEXT,
      turn_id TEXT,
      item_id TEXT,
      rollout_ordinal INTEGER,
      created_at_ms INTEGER,
      item_json TEXT,
      item_type TEXT,
      updated_at_ordinal INTEGER
    );
  `);
  return db;
}

function insertThread(db, row) {
  db.prepare(`INSERT INTO threads(id,created_at,updated_at,source,model_provider,cwd,title,first_user_message,preview,agent_nickname,agent_role,model,tokens_used,agent_path,created_at_ms,updated_at_ms,thread_source)
    VALUES(@id,@created_at,@updated_at,@source,@model_provider,@cwd,@title,@first_user_message,@preview,@agent_nickname,@agent_role,@model,@tokens_used,@agent_path,@created_at_ms,@updated_at_ms,@thread_source)`).run({
      created_at: 1000,
      updated_at: 1000,
      source: 'vscode',
      model_provider: 'openai',
      cwd: '/tmp/project',
      title: null,
      first_user_message: 'CANARY_PROMPT',
      preview: 'CANARY_PREVIEW',
      agent_nickname: null,
      agent_role: null,
      model: null,
      tokens_used: null,
      agent_path: null,
      created_at_ms: 1_000_000,
      updated_at_ms: 1_000_000,
      thread_source: 'user',
      ...row,
    });
}

function insertTurn(db, row) {
  db.prepare(`INSERT INTO thread_turns(thread_id,turn_id,rollout_ordinal,status,started_at,completed_at,duration_ms,first_user_item_id,final_agent_item_id,rollout_byte_offset,rollout_end_ordinal,rollout_end_byte_offset)
    VALUES(@thread_id,@turn_id,@rollout_ordinal,@status,@started_at,@completed_at,@duration_ms,NULL,NULL,0,0,0)`).run({ duration_ms: null, ...row });
}

function insertItem(db, row) {
  db.prepare(`INSERT INTO thread_items(thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json,item_type,updated_at_ordinal)
    VALUES(@thread_id,@turn_id,@item_id,@rollout_ordinal,@created_at_ms,@item_json,@item_type,0)`).run(row);
}


const NODE_KEYS = [
  'id', 'parentId', 'agent', 'kind', 'label', 'role', 'model', 'projectId', 'runId', 'taskId', 'attemptId', 'nativeSessionId', 'status', 'statusLabel', 'delivery', 'startedAt', 'updatedAt', 'finishedAt', 'observedAt', 'stale', 'source', 'confidence', 'relation', 'tokens', 'tokenUsage', 'conversationTitle',
].sort();

function assertNodeContract(node) {
  assert.deepEqual(Object.keys(node).sort(), NODE_KEYS);
}

function assertNoCanary(value) {
  const text = JSON.stringify(value);
  for (const canary of ['CANARY_PROMPT', 'CANARY_PREVIEW', 'CANARY_TOOL_TEXT', 'SECRET_CANARY']) {
    assert.doesNotMatch(text, new RegExp(canary));
  }
}

test('collectCodex maps read-only app-server proxy metadata without turns or message text', async () => {
  resetCodexCollectorCacheForTests();
  const { home, cleanup } = await tempHome();
  try {
    const result = await collectCodex({
      home,
      rootIds: ['root-1'],
      proxyRunner: async requests => {
        assert.deepEqual(requests.map(request => request.method), ['initialize', 'initialized', 'thread/loaded/list', 'thread/read', 'thread/list']);
        assert.equal(requests.find(request => request.method === 'thread/read').params.includeTurns, false);
        assert.ok(!requests.some(request => ['thread/resume', 'thread/start', 'turn/start', 'thread/subscribe'].includes(request.method)));
        return [
          { id: 1, result: { userAgent: 'codex-test', codexHome: home, platformFamily: 'unix', platformOs: 'macos' } },
          { id: 2, result: { data: ['root-1', 'child-1'], nextCursor: null } },
          { id: 10, result: { thread: { id: 'root-1', sessionId: 'root-1', parentThreadId: null, preview: 'CANARY_PREVIEW', ephemeral: false, modelProvider: 'openai', model: 'gpt-test', reasoningEffort: null, createdAt: 100, updatedAt: 110, status: { type: 'active', activeFlags: ['waitingOnUserInput'] }, cwd: '/tmp/project', cliVersion: '0.154.0', source: 'vscode', projectId: null, turns: [] } } },
          { id: 11, result: { data: [{ id: 'child-1', sessionId: 'root-1', parentThreadId: 'root-1', preview: 'CANARY_PROMPT', ephemeral: false, modelProvider: 'openai', model: null, reasoningEffort: null, createdAt: 101, updatedAt: 111, status: { type: 'idle' }, cwd: '/tmp/project', cliVersion: '0.154.0', source: { subAgent: { thread_spawn: { parent_thread_id: 'root-1', depth: 1, agent_path: '/root/worker_one', agent_nickname: null, agent_role: 'critic' } } }, projectId: null, turns: [] },
            { id: 'child-null', sessionId: 'root-1', parentThreadId: 'root-1', preview: 'CANARY_PROMPT', ephemeral: false, modelProvider: 'openai', model: null, reasoningEffort: null, createdAt: 102, updatedAt: 112, status: null, cwd: '/tmp/project', cliVersion: '0.154.0', source: { subAgent: { thread_spawn: { parent_thread_id: 'root-1', depth: 1, agent_path: '/root/null_status', agent_nickname: null, agent_role: null } } }, projectId: null, turns: [] }], nextCursor: null, backwardsCursor: null } },
        ];
      },
    });
    assert.equal(result.health.status, 'connected');
    assert.equal(result.nodes.length, 3);
    for (const node of result.nodes) assertNodeContract(node);
    const root = result.nodes.find(node => node.id === 'codex:root-1');
    const child = result.nodes.find(node => node.id === 'codex:child-1');
    const nullStatus = result.nodes.find(node => node.id === 'codex:child-null');
    assert.equal(root.status, 'waiting');
    assert.equal(root.confidence, 'live');
    assert.equal(child.parentId, 'codex:root-1');
    assert.equal(child.kind, 'subagent');
    assert.equal(child.label, 'worker_one');
    assert.equal(nullStatus.status, 'unknown');
    assert.equal(nullStatus.confidence, 'live');
    assertNoCanary(result);
  } finally {
    await cleanup();
  }
});

test('collectCodex fallback builds parent hierarchy and observed statuses from SQLite only', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const state = makeState(home);
    insertThread(state, { id: 'root-a', model: 'gpt-root', cwd: '/tmp/project' });
    insertThread(state, { id: 'child-a', source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'root-a', depth: 1, agent_path: '/root/impl_worker', agent_nickname: null, agent_role: 'worker' } } }), agent_role: 'worker', cwd: '/tmp/project' });
    state.prepare('INSERT INTO thread_spawn_edges(parent_thread_id, child_thread_id, status) VALUES(?,?,?)').run('root-a', 'child-a', 'open');
    state.close();
    const history = makeHistory(home);
    insertTurn(history, { thread_id: 'root-a', turn_id: 'turn-root', rollout_ordinal: 1, status: 'completed', started_at: 1000, completed_at: 1010, duration_ms: 10000 });
    insertTurn(history, { thread_id: 'child-a', turn_id: 'turn-child', rollout_ordinal: 1, status: 'completed', started_at: 1001, completed_at: 1005, duration_ms: 4000 });
    insertItem(history, { thread_id: 'root-a', turn_id: 'turn-root', item_id: 'item-1', rollout_ordinal: 1, created_at_ms: 1_002_000, item_type: 'subAgentActivity', item_json: JSON.stringify({ type: 'subAgentActivity', kind: 'started', agentThreadId: 'child-a', agentPath: '/root/impl_worker', content: 'CANARY_TOOL_TEXT' }) });
    insertItem(history, { thread_id: 'root-a', turn_id: 'turn-root', item_id: 'item-2', rollout_ordinal: 2, created_at_ms: 1_005_000, item_type: 'subAgentActivity', item_json: JSON.stringify({ type: 'subAgentActivity', kind: 'completed', agentThreadId: 'child-a', agentPath: '/root/impl_worker', result: 'SECRET_CANARY' }) });
    history.close();

    const result = await collectCodex({ home, rootIds: ['root-a'], proxy: false, now: 1_020_000 });
    assert.equal(result.health.status, 'partial');
    assert.equal(result.nodes.length, 2);
    for (const node of result.nodes) assertNodeContract(node);
    const root = result.nodes.find(node => node.id === 'codex:root-a');
    const child = result.nodes.find(node => node.id === 'codex:child-a');
    assert.equal(root.status, 'unknown');
    assert.equal(root.statusLabel, 'last recorded turn finished; live status unavailable');
    assert.equal(root.stale, true);
    assert.equal(child.status, 'completed');
    assert.equal(child.parentId, 'codex:root-a');
    assert.equal(child.label, 'impl_worker');
    assert.equal(child.role, 'worker');
    assert.equal(child.confidence, 'observed');
    assertNoCanary(result);
  } finally {
    await cleanup();
  }
});

test('collectCodex exposes only verified local coordinator title metadata', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const state = makeState(home);
    insertThread(state, { id: 'root-safe-title', title: 'Safe Local Conversation', first_user_message: 'CANARY_PROMPT_TITLE', preview: 'CANARY_PREVIEW_TITLE' });
    insertThread(state, { id: 'child-title', source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'root-safe-title', agent_path: '/root/title_worker' } } }), title: 'Ignored Child Title', first_user_message: 'CANARY_PROMPT_CHILD', preview: 'CANARY_PREVIEW_CHILD' });
    state.prepare('INSERT INTO thread_spawn_edges(parent_thread_id, child_thread_id, status) VALUES(?,?,?)').run('root-safe-title', 'child-title', 'open');
    state.close();

    const history = makeHistory(home);
    insertTurn(history, { thread_id: 'root-safe-title', turn_id: 'turn-root', rollout_ordinal: 1, status: 'completed', started_at: 1000, completed_at: 1001, duration_ms: 1000 });
    insertTurn(history, { thread_id: 'child-title', turn_id: 'turn-child', rollout_ordinal: 1, status: 'completed', started_at: 1000, completed_at: 1001, duration_ms: 1000 });
    insertItem(history, { thread_id: 'root-safe-title', turn_id: 'turn-root', item_id: 'title-tool', rollout_ordinal: 1, created_at_ms: 1_000_500, item_type: 'toolResult', item_json: JSON.stringify({ content: 'CANARY_TOOL_TEXT_TITLE' }) });
    history.close();

    const result = await collectCodex({ home, rootIds: ['root-safe-title'], proxy: false });
    const root = result.nodes.find(node => node.id === 'codex:root-safe-title');
    const child = result.nodes.find(node => node.id === 'codex:child-title');
    assert.equal(root.conversationTitle, 'Safe Local Conversation');
    assert.equal(child.conversationTitle, null);
    assertNoCanary(result);
  } finally {
    await cleanup();
  }
});

test('collectCodex loads native child ancestors without expanding unrelated siblings', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const state = makeState(home);
    insertThread(state, { id: 'grand-root', title: 'Grand Conversation', cwd: '/tmp/project' });
    insertThread(state, { id: 'parent-agent', source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'grand-root', agent_path: '/root/parent_agent', agent_role: 'planner' } } }), cwd: '/tmp/project-worktree-a', agent_role: 'planner' });
    insertThread(state, { id: 'native-child-root', source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'parent-agent', agent_path: '/root/native_child', agent_role: 'worker' } } }), cwd: '/tmp/project-worktree-b', agent_role: 'worker' });
    insertThread(state, { id: 'sibling-should-not-load', source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'parent-agent', agent_path: '/root/sibling_canary', agent_role: 'worker' } } }), cwd: '/tmp/project-worktree-c', agent_role: 'worker', first_user_message: 'SECRET_CANARY_SIBLING' });
    state.prepare('INSERT INTO thread_spawn_edges(parent_thread_id, child_thread_id, status) VALUES(?,?,?)').run('grand-root', 'parent-agent', 'closed');
    state.prepare('INSERT INTO thread_spawn_edges(parent_thread_id, child_thread_id, status) VALUES(?,?,?)').run('parent-agent', 'native-child-root', 'open');
    state.prepare('INSERT INTO thread_spawn_edges(parent_thread_id, child_thread_id, status) VALUES(?,?,?)').run('parent-agent', 'sibling-should-not-load', 'open');
    state.close();

    const history = makeHistory(home);
    insertTurn(history, { thread_id: 'grand-root', turn_id: 'turn-grand', rollout_ordinal: 1, status: 'completed', started_at: 1000, completed_at: 1001, duration_ms: 1000 });
    insertTurn(history, { thread_id: 'parent-agent', turn_id: 'turn-parent', rollout_ordinal: 1, status: 'completed', started_at: 1002, completed_at: 1003, duration_ms: 1000 });
    insertTurn(history, { thread_id: 'native-child-root', turn_id: 'turn-child', rollout_ordinal: 1, status: 'inProgress', started_at: 1004, completed_at: null, duration_ms: null });
    insertTurn(history, { thread_id: 'sibling-should-not-load', turn_id: 'turn-sibling', rollout_ordinal: 1, status: 'inProgress', started_at: 1004, completed_at: null, duration_ms: null });
    insertItem(history, { thread_id: 'parent-agent', turn_id: 'turn-parent', item_id: 'sibling-start', rollout_ordinal: 1, created_at_ms: 1_004_000, item_type: 'subAgentActivity', item_json: JSON.stringify({ type: 'subAgentActivity', kind: 'started', agentThreadId: 'sibling-should-not-load', agentPath: '/root/sibling_canary', content: 'SECRET_CANARY_SIBLING_ACTIVITY' }) });
    history.close();

    const result = await collectCodex({ home, rootIds: ['native-child-root'], proxy: false, now: 1_005_000 });
    assert.deepEqual(result.nodes.map(node => node.id).sort(), ['codex:grand-root', 'codex:native-child-root', 'codex:parent-agent']);
    const grand = result.nodes.find(node => node.id === 'codex:grand-root');
    const parent = result.nodes.find(node => node.id === 'codex:parent-agent');
    const child = result.nodes.find(node => node.id === 'codex:native-child-root');
    assert.equal(grand.parentId, null);
    assert.equal(grand.conversationTitle, 'Grand Conversation');
    assert.equal(parent.parentId, 'codex:grand-root');
    assert.equal(child.parentId, 'codex:parent-agent');
    assert.equal(child.status, 'running');
    assertNoCanary(result);
  } finally {
    await cleanup();
  }
});

test('collectCodex marks old in-progress fallback turns as stale unknown instead of live running', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const state = makeState(home);
    insertThread(state, { id: 'root-stale' });
    state.close();
    const history = makeHistory(home);
    insertTurn(history, { thread_id: 'root-stale', turn_id: 'turn-stale', rollout_ordinal: 1, status: 'inProgress', started_at: 1000, completed_at: null, duration_ms: null });
    history.close();
    const result = await collectCodex({ home, rootIds: ['root-stale'], proxy: false, now: 1_000_000 + 10 * 60_000 });
    assert.equal(result.nodes.length, 1);
    assert.equal(result.nodes[0].status, 'unknown');
    assert.equal(result.nodes[0].stale, true);
    assert.match(result.nodes[0].statusLabel, /in progress/);
  } finally {
    await cleanup();
  }
});


test('collectCodex keeps long in-progress fallback turn running when recent item metadata exists', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const state = makeState(home);
    insertThread(state, { id: 'root-recent-item' });
    state.close();
    const history = makeHistory(home);
    const now = 1_000_000 + 10 * 60_000;
    insertTurn(history, { thread_id: 'root-recent-item', turn_id: 'turn-long', rollout_ordinal: 1, status: 'inProgress', started_at: 1000, completed_at: null, duration_ms: null });
    insertItem(history, { thread_id: 'root-recent-item', turn_id: 'turn-long', item_id: 'recent-tool', rollout_ordinal: 2, created_at_ms: now - 60_000, item_type: 'toolResult', item_json: JSON.stringify({ content: 'SECRET_CANARY_RECENT_TOOL_CONTENT' }) });
    history.close();
    const result = await collectCodex({ home, rootIds: ['root-recent-item'], proxy: false, now });
    assert.equal(result.nodes.length, 1);
    assert.equal(result.nodes[0].status, 'running');
    assert.equal(result.nodes[0].stale, false);
    assert.equal(result.nodes[0].statusLabel, 'turn in progress');
    assert.equal(result.nodes[0].updatedAt, new Date(now - 60_000).toISOString());
    assert.doesNotMatch(JSON.stringify(result), /SECRET_CANARY_RECENT_TOOL_CONTENT/);
  } finally {
    await cleanup();
  }
});

test('collectCodex still marks long in-progress fallback turn stale when item metadata is old', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const state = makeState(home);
    insertThread(state, { id: 'root-old-item' });
    state.close();
    const history = makeHistory(home);
    const now = 1_000_000 + 10 * 60_000;
    insertTurn(history, { thread_id: 'root-old-item', turn_id: 'turn-long', rollout_ordinal: 1, status: 'inProgress', started_at: 1000, completed_at: null, duration_ms: null });
    insertItem(history, { thread_id: 'root-old-item', turn_id: 'turn-long', item_id: 'old-tool', rollout_ordinal: 2, created_at_ms: 1_060_000, item_type: 'toolResult', item_json: JSON.stringify({ content: 'SECRET_CANARY_OLD_TOOL_CONTENT' }) });
    history.close();
    const result = await collectCodex({ home, rootIds: ['root-old-item'], proxy: false, now });
    assert.equal(result.nodes.length, 1);
    assert.equal(result.nodes[0].status, 'unknown');
    assert.equal(result.nodes[0].stale, true);
    assert.match(result.nodes[0].statusLabel, /in progress/);
    assert.doesNotMatch(JSON.stringify(result), /SECRET_CANARY_OLD_TOOL_CONTENT/);
  } finally {
    await cleanup();
  }
});

test('collectCodex handles malformed SQLite schema as unavailable instead of throwing', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const db = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
    db.exec('CREATE TABLE thread_turns(not_thread_id TEXT);');
    db.close();
    const result = await collectCodex({ home, rootIds: ['missing'], proxy: false });
    assert.equal(result.health.status, 'unavailable');
    assert.deepEqual(result.nodes, []);
  } finally {
    await cleanup();
  }
});

test('collectCodex respects explicit root scope and excludes unrelated project sessions', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const state = makeState(home);
    insertThread(state, { id: 'root-keep', cwd: '/tmp/project' });
    insertThread(state, { id: 'root-drop', cwd: '/tmp/project' });
    state.close();
    const history = makeHistory(home);
    insertTurn(history, { thread_id: 'root-keep', turn_id: 'turn-keep', rollout_ordinal: 1, status: 'completed', started_at: 1000, completed_at: 1001, duration_ms: 1000 });
    insertTurn(history, { thread_id: 'root-drop', turn_id: 'turn-drop', rollout_ordinal: 1, status: 'completed', started_at: 1000, completed_at: 1001, duration_ms: 1000 });
    history.close();
    const result = await collectCodex({ home, rootIds: ['root-keep'], proxy: false });
    assert.deepEqual(result.nodes.map(node => node.id), ['codex:root-keep']);
  } finally {
    await cleanup();
  }
});

async function makeFakeCodexProxyBin(home, scriptBody) {
  const bin = path.join(home, 'bin');
  await fs.mkdir(bin, { recursive: true });
  const exe = path.join(bin, 'codex');
  await fs.writeFile(exe, `#!/usr/bin/env node\n${scriptBody}\n`);
  await fs.chmod(exe, 0o755);
  return bin;
}

test('collectCodex talks to a long-lived proxy by waiting for initialize before readonly requests', async () => {
  resetCodexCollectorCacheForTests();
  const { home, cleanup } = await tempHome();
  try {
    const bin = await makeFakeCodexProxyBin(home, String.raw`
const fs = require('node:fs');
let buffer = '';
let initialized = false;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    fs.appendFileSync(process.env.ORDER_FILE, msg.method + '\n');
    if (msg.method === 'initialize') {
      send({ method: 'window/logMessage', params: { message: 'ignored notification with CANARY_PROMPT' } });
      send({ id: msg.id, result: { userAgent: 'fake' } });
    } else if (msg.method === 'initialized') {
      initialized = true;
    } else if (!initialized) {
      send({ id: msg.id, error: { message: 'readonly request before initialized' } });
    } else if (msg.method === 'thread/loaded/list') {
      send({ id: msg.id, result: { data: [] } });
    } else if (msg.method === 'thread/read') {
      send({ id: msg.id, result: { thread: { id: msg.params.threadId, parentThreadId: null, model: 'gpt-test', createdAt: 1, updatedAt: 2, status: { type: 'idle' }, cwd: '/tmp/project', preview: 'SECRET_CANARY' } } });
    } else if (msg.method === 'thread/list') {
      send({ id: msg.id, result: { data: [{ id: 'proxy-child', parentThreadId: msg.params.ancestorThreadId, model: null, createdAt: 2, updatedAt: 3, status: { type: 'idle' }, cwd: '/tmp/other-worktree', source: { subAgent: { thread_spawn: { parent_thread_id: msg.params.ancestorThreadId, agent_path: '/root/proxy_worker' } } }, preview: 'CANARY_PREVIEW' }] } });
      setInterval(() => {}, 1000);
    }
  }
});
`);
    const orderFile = path.join(home, 'order.txt');
    const result = await collectCodex({
      home,
      rootIds: ['proxy-root'],
      project: '/tmp/project',
      environment: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ORDER_FILE: orderFile },
    });
    assert.equal(result.health.status, 'connected');
    assert.deepEqual(result.nodes.map(node => node.id).sort(), ['codex:proxy-child', 'codex:proxy-root']);
    const order = (await fs.readFile(orderFile, 'utf8')).trim().split('\n');
    assert.deepEqual(order, ['initialize', 'initialized', 'thread/loaded/list', 'thread/read', 'thread/list']);
    assertNoCanary(result);
  } finally {
    await cleanup();
  }
});

test('collectCodex proxy failure cache is scoped per CODEX_HOME', async () => {
  resetCodexCollectorCacheForTests();
  const a = await tempHome();
  const b = await tempHome();
  try {
    const badBin = await makeFakeCodexProxyBin(a.home, "process.exit(7);");
    const failed = await collectCodex({ home: a.home, rootIds: ['root-a'], environment: { ...process.env, PATH: `${badBin}${path.delimiter}${process.env.PATH}` } });
    assert.equal(failed.health.status, 'unavailable');

    const ok = await collectCodex({
      home: b.home,
      rootIds: ['root-b'],
      proxyRunner: async () => [
        { id: 1, result: { userAgent: 'fake' } },
        { id: 2, result: { data: [] } },
        { id: 10, result: { thread: { id: 'root-b', status: { type: 'idle' }, createdAt: 1, updatedAt: 2, cwd: '/tmp/project' } } },
        { id: 11, result: { data: [] } },
      ],
    });
    assert.equal(ok.health.status, 'connected');
    assert.deepEqual(ok.nodes.map(node => node.id), ['codex:root-b']);
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

test('collectCodex fallback does not scan all history when project scope has no state match', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const history = makeHistory(home);
    insertTurn(history, { thread_id: 'unrelated-history', turn_id: 'turn-1', rollout_ordinal: 1, status: 'completed', started_at: 1000, completed_at: 1001, duration_ms: 1000 });
    history.close();
    const result = await collectCodex({ home, project: '/tmp/project-with-no-state', proxy: false, environment: {} });
    assert.equal(result.health.status, 'partial');
    assert.deepEqual(result.nodes, []);
    assertNoCanary(result);
  } finally {
    await cleanup();
  }
});

test('collectCodex merges both state database locations and keeps root child in another cwd', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const first = makeState(home);
    insertThread(first, { id: 'unrelated-first-db', cwd: '/tmp/project' });
    first.close();

    const second = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    second.exec(`
      CREATE TABLE threads(id TEXT PRIMARY KEY, created_at INTEGER, updated_at INTEGER, source TEXT, cwd TEXT, agent_role TEXT, model TEXT, agent_path TEXT);
      CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT, status TEXT);
    `);
    second.prepare('INSERT INTO threads(id,created_at,updated_at,source,cwd,agent_role,model,agent_path) VALUES(?,?,?,?,?,?,?,?)').run('root-second', 1000, 1001, 'vscode', '/tmp/project', null, 'gpt-root', null);
    second.prepare('INSERT INTO threads(id,created_at,updated_at,source,cwd,agent_role,model,agent_path) VALUES(?,?,?,?,?,?,?,?)').run('child-other-cwd', 1001, 1002, JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'root-second', agent_path: '/root/cross_cwd', agent_role: 'worker' } } }), '/tmp/project-worktree', 'worker', null, '/root/cross_cwd');
    second.prepare('INSERT INTO thread_spawn_edges(parent_thread_id, child_thread_id, status) VALUES(?,?,?)').run('root-second', 'child-other-cwd', 'open');
    second.close();

    const history = makeHistory(home);
    insertTurn(history, { thread_id: 'root-second', turn_id: 'turn-root', rollout_ordinal: 1, status: 'completed', started_at: 1000, completed_at: 1001, duration_ms: 1000 });
    insertTurn(history, { thread_id: 'child-other-cwd', turn_id: 'turn-child', rollout_ordinal: 1, status: 'inProgress', started_at: 1002, completed_at: null, duration_ms: null });
    history.close();

    const result = await collectCodex({ home, rootIds: ['root-second'], project: '/tmp/project', proxy: false, now: 1_004_000 });
    assert.deepEqual(result.nodes.map(node => node.id).sort(), ['codex:child-other-cwd', 'codex:root-second']);
    const child = result.nodes.find(node => node.id === 'codex:child-other-cwd');
    assert.equal(child.parentId, 'codex:root-second');
    assert.equal(child.projectId, '/tmp/project-worktree');
    assert.equal(child.status, 'running');
  } finally {
    await cleanup();
  }
});

test('collectCodex uses newest bounded history events and clears completion on restarted subagent episode', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const state = makeState(home);
    insertThread(state, { id: 'root-restart', cwd: '/tmp/project' });
    insertThread(state, { id: 'child-restart', source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'root-restart', agent_path: '/root/restart_worker' } } }), cwd: '/tmp/project' });
    state.prepare('INSERT INTO thread_spawn_edges(parent_thread_id, child_thread_id, status) VALUES(?,?,?)').run('root-restart', 'child-restart', 'open');
    state.close();

    const history = makeHistory(home);
    insertTurn(history, { thread_id: 'root-restart', turn_id: 'old-root', rollout_ordinal: 1, status: 'completed', started_at: 1000, completed_at: 1001, duration_ms: 1000 });
    insertTurn(history, { thread_id: 'root-restart', turn_id: 'new-root', rollout_ordinal: 99, status: 'failed', started_at: 2000, completed_at: 2001, duration_ms: 1000 });
    insertTurn(history, { thread_id: 'child-restart', turn_id: 'child-old', rollout_ordinal: 1, status: 'completed', started_at: 1005, completed_at: 1006, duration_ms: 1000 });
    insertItem(history, { thread_id: 'root-restart', turn_id: 'old-root', item_id: 'old-start', rollout_ordinal: 1, created_at_ms: 1_005_000, item_type: 'subAgentActivity', item_json: JSON.stringify({ type: 'subAgentActivity', kind: 'started', agentThreadId: 'child-restart', agentPath: '/root/restart_worker' }) });
    insertItem(history, { thread_id: 'root-restart', turn_id: 'old-root', item_id: 'old-complete', rollout_ordinal: 2, created_at_ms: 1_006_000, item_type: 'subAgentActivity', item_json: JSON.stringify({ type: 'subAgentActivity', kind: 'completed', agentThreadId: 'child-restart', agentPath: '/root/restart_worker' }) });
    insertItem(history, { thread_id: 'root-restart', turn_id: 'new-root', item_id: 'new-start', rollout_ordinal: 99, created_at_ms: 2_002_000, item_type: 'subAgentActivity', item_json: JSON.stringify({ type: 'subAgentActivity', kind: 'started', agentThreadId: 'child-restart', agentPath: '/root/restart_worker' }) });
    history.close();

    const result = await collectCodex({ home, rootIds: ['root-restart'], proxy: false, now: 2_010_000, limit: 2 });
    const root = result.nodes.find(node => node.id === 'codex:root-restart');
    const child = result.nodes.find(node => node.id === 'codex:child-restart');
    assert.equal(root.status, 'unknown');
    assert.equal(root.stale, true);
    assert.equal(root.statusLabel, 'last recorded turn failed; live status unavailable');
    assert.equal(child.status, 'running');
    assert.equal(child.finishedAt, null);
    assert.equal(child.statusLabel, 'subagent start observed');
  } finally {
    await cleanup();
  }
});

test('collectCodex all=true includes project-mismatched proxy rows while project mode filters them', async () => {
  resetCodexCollectorCacheForTests();
  const { home, cleanup } = await tempHome();
  try {
    const proxyRunner = async requests => {
      const list = requests.find(request => request.method === 'thread/list' && request.params?.ancestorThreadId === undefined);
      assert.equal(list.params.cwd, list.params.sourceKinds.includes('unknown') ? null : '/tmp/project');
      return [
        { id: 1, result: { userAgent: 'fake' } },
        { id: 2, result: { data: [] } },
        { id: 10, result: { data: [
          { id: 'same-project', status: { type: 'idle' }, cwd: '/tmp/project', createdAt: 1, updatedAt: 2 },
          { id: 'other-project', status: { type: 'idle' }, cwd: '/tmp/other', createdAt: 1, updatedAt: 2 },
        ] } },
      ];
    };
    const scoped = await collectCodex({ home, project: '/tmp/project', all: false, proxyRunner, environment: {} });
    assert.deepEqual(scoped.nodes.map(node => node.id), ['codex:same-project']);
    const unscoped = await collectCodex({ home, project: '/tmp/project', all: true, proxyRunner, environment: {} });
    assert.deepEqual(unscoped.nodes.map(node => node.id).sort(), ['codex:other-project', 'codex:same-project']);
  } finally {
    await cleanup();
  }
});

test('collectCodex health detail redacts proxy stderr and arbitrary error text', async () => {
  resetCodexCollectorCacheForTests();
  const { home, cleanup } = await tempHome();
  try {
    const state = makeState(home);
    insertThread(state, { id: 'root-redact', cwd: '/tmp/project' });
    state.close();
    const history = makeHistory(home);
    insertTurn(history, { thread_id: 'root-redact', turn_id: 'turn-redact', rollout_ordinal: 1, status: 'completed', started_at: 1000, completed_at: 1001, duration_ms: 1000 });
    history.close();

    const result = await collectCodex({
      home,
      rootIds: ['root-redact'],
      proxyRunner: async () => { throw new Error('SECRET_CANARY /Users/private/app-server-control.sock SQL near item_json'); },
    });
    assert.equal(result.health.status, 'partial');
    assert.match(result.health.detail, /proxy unavailable \(connection_failed\)|proxy unavailable \(unavailable\)/);
    assert.doesNotMatch(result.health.detail, /SECRET_CANARY|Users\/private|item_json|app-server-control\.sock/);
    assertNoCanary(result.nodes);
  } finally {
    await cleanup();
  }
});

test('collectCodex exposes state session token totals without fabricating component counts', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const state = makeState(home);
    insertThread(state, { id: 'root-token-state', tokens_used: 321 });
    state.close();
    const history = makeHistory(home);
    insertTurn(history, { thread_id: 'root-token-state', turn_id: 'turn-1', rollout_ordinal: 1, status: 'inProgress', started_at: 1000, completed_at: null, duration_ms: null });
    history.close();

    const result = await collectCodex({ home, rootIds: ['root-token-state'], proxy: false, now: 1_010_000 });
    const node = result.nodes[0];
    assert.equal(node.tokens, 321);
    assert.deepEqual(node.tokenUsage, {
      total: 321,
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      reasoning: null,
      scope: 'session',
      source: 'state.threads.tokens_used',
      complete: true,
    });
  } finally {
    await cleanup();
  }
});

test('collectCodex maps proxy tokenUsage and preserves turn scope without double-counting total plus cache', async () => {
  resetCodexCollectorCacheForTests();
  const { home, cleanup } = await tempHome();
  try {
    const result = await collectCodex({
      home,
      rootIds: ['root-proxy-tokens'],
      proxyRunner: async () => [
        { id: 1, result: { userAgent: 'fake' } },
        { id: 2, result: { data: [] } },
        { id: 10, result: { thread: { id: 'root-proxy-tokens', status: { type: 'idle' }, createdAt: 1, updatedAt: 2, cwd: '/tmp/project', tokenUsage: { total: { totalTokens: 100, inputTokens: 60, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 }, last: { totalTokens: 12, inputTokens: 7, outputTokens: 5 } } } } },
        { id: 11, result: { data: [] } },
      ],
    });
    const node = result.nodes[0];
    assert.equal(node.tokens, 100);
    assert.equal(node.tokenUsage.total, 100);
    assert.equal(node.tokenUsage.input, 60);
    assert.equal(node.tokenUsage.cacheRead, 20);
    assert.equal(node.tokenUsage.reasoning, 10);
    assert.equal(node.tokenUsage.scope, 'session');
    assert.equal(node.tokenUsage.source, 'app-server.thread.tokenUsage');
    assert.equal(node.tokenUsage.complete, true);
  } finally {
    await cleanup();
  }
});

test('collectCodex supplements live proxy status with local token usage when proxy omits tokens', async () => {
  resetCodexCollectorCacheForTests();
  const { home, cleanup } = await tempHome();
  try {
    const state = makeState(home);
    insertThread(state, { id: 'root-live-local-tokens', tokens_used: 777, title: 'Local Token Title' });
    state.close();
    const history = makeHistory(home);
    insertTurn(history, { thread_id: 'root-live-local-tokens', turn_id: 'turn-1', rollout_ordinal: 1, status: 'completed', started_at: 1000, completed_at: 1001, duration_ms: 1000 });
    history.close();

    const result = await collectCodex({
      home,
      rootIds: ['root-live-local-tokens'],
      proxyRunner: async () => [
        { id: 1, result: { userAgent: 'fake' } },
        { id: 2, result: { data: [] } },
        { id: 10, result: { thread: { id: 'root-live-local-tokens', status: { type: 'active', activeFlags: [] }, createdAt: 1, updatedAt: 2, cwd: '/tmp/project' } } },
        { id: 11, result: { data: [] } },
      ],
    });
    const node = result.nodes[0];
    assert.equal(node.status, 'running');
    assert.equal(node.confidence, 'live');
    assert.equal(node.tokens, 777);
    assert.equal(node.tokenUsage.source, 'state.threads.tokens_used');
    assert.equal(node.conversationTitle, 'Local Token Title');
  } finally {
    await cleanup();
  }
});

test('collectCodex aggregates history token usage by latest turn record without duplicate retries or content leakage', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const state = makeState(home);
    insertThread(state, { id: 'root-history-tokens' });
    state.close();
    const history = makeHistory(home);
    insertTurn(history, { thread_id: 'root-history-tokens', turn_id: 'turn-a', rollout_ordinal: 1, status: 'inProgress', started_at: 1000, completed_at: null, duration_ms: null });
    insertTurn(history, { thread_id: 'root-history-tokens', turn_id: 'turn-b', rollout_ordinal: 2, status: 'inProgress', started_at: 1010, completed_at: null, duration_ms: null });
    insertItem(history, { thread_id: 'root-history-tokens', turn_id: 'turn-a', item_id: 'usage-a-old', rollout_ordinal: 3, created_at_ms: 1_001_000, item_type: 'token_usage_record', item_json: JSON.stringify({ tokenUsage: { total: 100, input: 70, output: 30, scope: 'turn' }, content: 'SECRET_CANARY_TOKEN_OLD' }) });
    insertItem(history, { thread_id: 'root-history-tokens', turn_id: 'turn-a', item_id: 'usage-a-new', rollout_ordinal: 4, created_at_ms: 1_002_000, item_type: 'token_usage_record', item_json: JSON.stringify({ tokenUsage: { total: 120, input: 80, output: 40, cacheRead: 20, scope: 'turn' }, content: 'SECRET_CANARY_TOKEN_NEW' }) });
    insertItem(history, { thread_id: 'root-history-tokens', turn_id: 'turn-b', item_id: 'usage-b', rollout_ordinal: 5, created_at_ms: 1_003_000, item_type: 'token_count', item_json: JSON.stringify({ info: { total_token_usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 2, reasoning_output_tokens: 3 } }, content: 'SECRET_CANARY_TOKEN_AGENT' }) });
    history.close();

    const result = await collectCodex({ home, rootIds: ['root-history-tokens'], proxy: false, now: 1_004_000 });
    const node = result.nodes[0];
    assert.equal(node.tokens, 135);
    assert.equal(node.tokenUsage.total, 135);
    assert.equal(node.tokenUsage.input, 90);
    assert.equal(node.tokenUsage.output, 45);
    assert.equal(node.tokenUsage.cacheRead, 22);
    assert.equal(node.tokenUsage.cacheWrite, null);
    assert.equal(node.tokenUsage.reasoning, 3);
    assert.equal(node.tokenUsage.scope, 'observed');
    assert.equal(node.tokenUsage.source, 'history.thread_items.tokenUsage');
    assert.equal(node.tokenUsage.complete, false);
    assert.doesNotMatch(JSON.stringify(result), /SECRET_CANARY_TOKEN_/);
  } finally {
    await cleanup();
  }
});

test('collectCodex keeps token fields null when no metadata exists', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const state = makeState(home);
    insertThread(state, { id: 'root-no-tokens' });
    state.close();
    const history = makeHistory(home);
    insertTurn(history, { thread_id: 'root-no-tokens', turn_id: 'turn-1', rollout_ordinal: 1, status: 'inProgress', started_at: 1000, completed_at: null, duration_ms: null });
    history.close();

    const result = await collectCodex({ home, rootIds: ['root-no-tokens'], proxy: false, now: 1_010_000 });
    assert.equal(result.nodes[0].tokens, null);
    assert.equal(result.nodes[0].tokenUsage, null);
  } finally {
    await cleanup();
  }
});
