import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installCaoSkill } from '../src/skills.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('installed skill wrapper resolves its physical checkout and preserves project argv/cwd', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-wrapper-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, '项目 with spaces');
  const skillsDir = path.join(root, 'skills with spaces');
  await fs.mkdir(project);
  const installed = await installCaoSkill({ skillsDir });
  const script = path.join(installed.skillPath, 'scripts/cao.mjs');
  const run = args => spawnSync(process.execPath, ['--preserve-symlinks-main', script, ...args], { cwd: project, encoding:'utf8' });

  const located = run(['--paths']);
  assert.equal(located.status, 0, located.stderr);
  const paths = JSON.parse(located.stdout);
  assert.equal(paths.repository, await fs.realpath(repository));
  await fs.access(paths.profilesGuide);
  await fs.access(paths.workflow);

  const enabled = run(['mode', 'enable', '--thread', 'wrapper-test', '--project', '.', '--state-dir', path.join(root, 'state'), '--max-parallel', '3']);
  assert.equal(enabled.status, 0, enabled.stderr);
  const mode = JSON.parse(enabled.stdout).data;
  assert.equal(mode.project, await fs.realpath(project));
  assert.equal(mode.maxParallel, 3);
  assert.equal(mode.enabled, true);
  assert.deepEqual(await fs.readdir(project), []);

  const rejected = run(['mode', 'enable', '--thread', 'bad$(touch injected)', '--state-dir', path.join(root, 'state')]);
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stderr).error.code, 'invalid_thread');
  assert.deepEqual(await fs.readdir(project), []);
});
