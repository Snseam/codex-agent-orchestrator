import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClaudeSmokeIsolation } from '../scripts/helpers/claude-smoke-isolation.mjs';

test('Claude smoke isolation creates a private config root without inherited Claude credentials', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-claude-isolation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const isolation = await createClaudeSmokeIsolation({
    root: path.join(root, 'runtime'),
    environment: {
      PATH: '/bin',
      HOME: '/user/home',
      ANTHROPIC_API_KEY: 'real-user-key',
      ANTHROPIC_AUTH_TOKEN: 'real-user-token',
      CLAUDE_CONFIG_DIR: '/user/.claude',
      CLAUDE_CODE_SOME_SETTING: 'from-user',
      OTHER_SETTING: 'keep-me',
    },
  });

  assert.equal(isolation.environment.HOME, '/user/home');
  assert.equal(isolation.environment.PATH, '/bin');
  assert.equal(isolation.environment.OTHER_SETTING, 'keep-me');
  assert.equal(isolation.environment.ANTHROPIC_API_KEY, undefined);
  assert.equal(isolation.environment.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(isolation.environment.CLAUDE_CODE_SOME_SETTING, undefined);
  assert.equal(isolation.environment.CLAUDE_CONFIG_DIR, isolation.claudeConfigDir);
  assert.match(isolation.claudeConfigDir, /runtime\/claude$/);
  assert.deepEqual((await fs.readdir(isolation.claudeConfigDir)).sort(), ['.claude.json', 'projects']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(isolation.claudeConfigDir, '.claude.json'), 'utf8')), { hasCompletedOnboarding: true });
  await fs.writeFile(path.join(isolation.claudeConfigDir, 'settings.json'), 'existing private settings');
  await assert.rejects(createClaudeSmokeIsolation({ root: isolation.root }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(isolation.claudeConfigDir, 'settings.json'), 'utf8'), 'existing private settings');
});
