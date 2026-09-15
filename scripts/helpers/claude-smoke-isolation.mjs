import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SENSITIVE_PREFIXES = ['ANTHROPIC_', 'CLAUDE_'];

function withoutClaudeSecrets(environment) {
  const isolated = { ...environment };
  for (const key of Object.keys(isolated)) {
    if (SENSITIVE_PREFIXES.some(prefix => key.startsWith(prefix))) delete isolated[key];
  }
  return isolated;
}

export async function createClaudeSmokeIsolation({ root = null, environment = process.env } = {}) {
  const directory = root ? path.resolve(root) : await fs.mkdtemp(path.join(os.tmpdir(), 'cao-claude-smoke-'));
  const claudeConfigDir = path.join(directory, 'claude');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // Fail closed if a caller accidentally reuses a config containing earlier state.
  await fs.mkdir(claudeConfigDir, { mode: 0o700 });
  await fs.mkdir(path.join(claudeConfigDir, 'projects'), { mode: 0o700 });
  // A first-run notice can consume Herdr's first task prompt. This is disposable
  // test UI state only; no credentials, trust entries, or user settings are copied.
  await fs.writeFile(path.join(claudeConfigDir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }) + '\n', { mode: 0o600, flag: 'wx' });
  const env = withoutClaudeSecrets(environment);
  env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  return {
    root: directory,
    claudeConfigDir,
    environment: env,
    async cleanup() {
      if (!root) await fs.rm(directory, { recursive: true, force: true });
    },
  };
}
