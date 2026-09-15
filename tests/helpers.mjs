import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { OrchestratorError } from '../src/errors.mjs';

export async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-flow-'));
  const project = path.join(base, 'project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.mkdir(path.join(project, 'tests'));
  await fs.writeFile(path.join(project, 'src/math.mjs'), 'export const add = (a, b) => a - b;\n');
  await fs.writeFile(path.join(project, 'tests/math.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.mjs';\ntest('adds positive and negative inputs', () => { assert.equal(add(3, 4), 7); assert.equal(add(-3, 2), -1); });\n");
  const git = args => execFileSync('git', ['-C', project, ...args], { stdio: 'pipe' });
  git(['init', '-b', 'main']);
  git(['add', '.']);
  git(['-c', 'user.name=CAO Test', '-c', 'user.email=cao@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Establish a fixture for behavior checks']);
  return { base, project, stateRoot: path.join(base, 'state'), remove: () => fs.rm(base, { recursive: true, force: true }) };
}

export const task = (extra = {}) => ({
  id: 'fix-add', objective: 'Fix add to add its two inputs; preserve the existing tests.',
  agent: 'claude', allowedPaths: ['src/math.mjs'],
  checks: [{ name: 'math', argv: [process.execPath, '--test', 'tests/math.test.mjs'], timeoutMs: 10000 }],
  ...extra,
});

export function promptData(prompt) {
  const value = label => prompt.match(new RegExp(`^- ${label}: (.+)$`, 'm'))?.[1];
  return {
    taskId: value('taskId'), attemptId: value('attemptId'), nonce: value('nonce'),
    cwd: value('working directory'), resultFile: value('result file'),
  };
}

export async function writeResult(prompt, { fix = true, overrides = {} } = {}) {
  const data = promptData(prompt);
  if (fix) await fs.writeFile(path.join(data.cwd, 'src/math.mjs'), 'export const add = (a, b) => a + b;\n');
  await fs.writeFile(data.resultFile, JSON.stringify({
    taskId: data.taskId, attemptId: data.attemptId, nonce: data.nonce,
    status: 'submitted', summary: 'Prepared candidate', changedFiles: fix ? ['src/math.mjs'] : [],
    checks: [], children: [], unresolved: [], ...overrides,
  }));
  return data;
}

export class FakeHerdr {
  constructor(onPrompt = prompt => writeResult(prompt)) {
    this.onPrompt = onPrompt; this.workers = new Map(); this.panes = new Map();
    this.prompts = []; this.serial = 0; this.starts = 0; this.closed = []; this.stops = [];
  }
  async ensureServer() { return { started: true, pid: 123 }; }
  async createWorkspace(session, cwd, label) {
    if (this.beforeCreate) await this.beforeCreate();
    const n = ++this.serial;
    const pane = { pane_id: `w${n}:p1`, terminal_id: `term-${n}`, workspace_id: `w${n}`, cwd, label };
    this.panes.set(pane.pane_id, pane);
    return { result: { root_pane: pane } };
  }
  async startAgent(session, name, kind, paneId) {
    this.starts++;
    const pane = this.panes.get(paneId);
    this.workers.set(name, { ...pane, agent: kind, name, agent_status: 'idle', interactive_ready: true });
    if (this.afterStart) await this.afterStart(name);
    return this.getAgent(session, name);
  }
  async getAgent(session, name) {
    const agent = this.workers.get(name);
    if (!agent) throw new OrchestratorError('agent_not_found', 'Agent is absent');
    return { result: { agent } };
  }
  async getPane(session, id) {
    const pane = this.panes.get(id);
    if (!pane) throw new OrchestratorError('pane_not_found', 'Pane is absent');
    return { result: { pane } };
  }
  async getProcessInfo(session, id) {
    return { result: { process_info: { foreground_process_group_id: this.panes.get(id)?.group || 23456, shell_pid: 23000 } } };
  }
  async prompt(session, name, prompt) {
    this.prompts.push(prompt);
    await this.onPrompt(prompt, this.workers.get(name));
    return { result: { type: 'agent_prompted' } };
  }
  async readAgent() { return this.prompts.length ? `CAO_RESULT ${promptData(this.prompts.at(-1)).attemptId}` : 'Ready'; }
  async keys() { return { result: { type: 'ok' } }; }
  async closePane(session, id) {
    this.closed.push(id); this.panes.delete(id);
    for (const [name, worker] of this.workers) if (worker.pane_id === id) this.workers.delete(name);
    return { result: { type: 'ok' } };
  }
  async stopServer(session) { this.stops.push(session); return { stopped: true }; }
  async snapshot() { return { result: { panes: [...this.panes.values()] } }; }
}
