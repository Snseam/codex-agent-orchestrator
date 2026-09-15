import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Tokscale } from '../../src/runtime/tokscale.mjs';
import { UsageService } from '../../src/usage.mjs';
import { createRun } from '../../src/state.mjs';

test('real Tokscale normalizes synthetic Claude/Codex logs and scopes a retried CAO task', { timeout: 120000 }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-native-usage-'));
  const root = await fs.realpath(temporary);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), cwd = path.join(root, 'project'), stateRoot = path.join(root, 'state');
  await fs.mkdir(cwd);
  const claudeDirectory = path.join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  const codexDirectory = path.join(home, '.codex', 'sessions', '2026', '09', '15');
  await fs.mkdir(claudeDirectory, { recursive: true });
  await fs.mkdir(codexDirectory, { recursive: true });
  const timestamp = new Date(2026, 8, 15, 12).toISOString();
  await fs.writeFile(path.join(claudeDirectory, 'claude-fixture.jsonl'), JSON.stringify({
    type: 'assistant', uuid: 'fixture-message', sessionId: 'claude-fixture', timestamp, cwd,
    message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5-20250929', content: [], usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 } },
  }) + '\n');
  const usage = { input_tokens: 100, cached_input_tokens: 30, output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 150 };
  await fs.writeFile(path.join(codexDirectory, 'rollout-fixture.jsonl'), [
    { timestamp, type: 'session_meta', payload: { id: 'codex-fixture', timestamp, cwd, model_provider: 'openai' } },
    { timestamp, type: 'turn_context', payload: { cwd, model: 'gpt-5' } },
    { timestamp, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const record = {
    schemaVersion: 1, id: 'usage-fixture', project: cwd, createdAt: timestamp,
    tasks: { fix: { definition: { id: 'fix', agent: 'claude', isolation: 'worktree' }, attempts: [{ id: 'first', cwd }, { id: 'retry', cwd }] } },
  };
  await createRun(stateRoot, record);
  const recordFile = path.join(stateRoot, 'runs', record.id, 'run.json');
  const before = await fs.readFile(recordFile, 'utf8');
  const service = new UsageService({ stateRoot, tokscale: new Tokscale({ binary: process.env.CAO_TOKSCALE_BIN || 'tokscale' }) });
  const machine = await service.query({ home, agent: 'claude,codex', since: '2026-09-15', until: '2026-09-15' });
  assert.equal(machine.totals.totalTokens, 350);
  const codex = machine.rows.find(row => row.agent === 'codex');
  assert.equal(codex.input, 70);
  assert.equal(codex.output, 30);
  assert.equal(codex.reasoning, 20);
  assert.equal(codex.totalTokens, 150);
  const scoped = await service.query({ home, run: record.id, task: 'fix' });
  assert.equal(scoped.totals.totalTokens, 200);
  assert.equal(scoped.attribution.exactTaskAttribution, false);
  assert.equal(scoped.coverage[0].attempts, 2);
  assert.equal(scoped.coverage[0].matchedWorkspaces, 1);
  assert.equal(await fs.readFile(recordFile, 'utf8'), before);
});
