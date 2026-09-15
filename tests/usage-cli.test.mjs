import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('usage CLI exposes JSON and table reports without a real Tokscale installation', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-usage-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'fake-tokscale.cjs');
  await fs.writeFile(binary, `#!${process.execPath}
if (process.argv.includes('--version')) console.log('tokscale 4.16.0');
else console.log(JSON.stringify({groupBy:'client,provider,model',entries:[{
client:'claude',mergedClients:null,model:'fixture-model',provider:'fixture-provider',
input:2,output:3,cacheRead:5,cacheWrite:7,reasoning:11,messageCount:1
}],totalInput:2,totalOutput:3,totalCacheRead:5,totalCacheWrite:7,totalMessages:1}));
`, { mode: 0o700 });
  const run = extra => spawnSync(process.execPath, ['bin/cao.mjs', 'usage', '--agent', 'claude', '--today', '--tokscale-bin', binary, ...extra], { encoding: 'utf8' });
  const json = run([]);
  assert.equal(json.status, 0, json.stderr);
  const data = JSON.parse(json.stdout).data;
  assert.equal(data.totals.totalTokens, 28);
  assert.equal(data.source.version, '4.16.0');
  assert.equal(data.scope.type, 'machine');
  assert.equal(data.filters.since, data.filters.until);
  const table = run(['--table']);
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /Recorded total: 28 tokens/);
  assert.match(table.stdout, /fixture-provider/);
  assert.equal(table.stderr, '');
});

test('usage CLI rejects incompatible options and reports missing optional tooling', () => {
  for (const flags of [['--table', '--json'], ['--task', 'task'], ['--today', '--since', '2026-09-01'], ['--since', '2026-02-30']]) {
    const result = spawnSync(process.execPath, ['bin/cao.mjs', 'usage', '--tokscale-bin', '/definitely-missing/cao-tokscale', ...flags], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stderr).error.code, 'invalid_arguments');
    assert.equal(result.stdout, '');
  }
  const missing = spawnSync(process.execPath, ['bin/cao.mjs', 'usage', '--tokscale-bin', '/definitely-missing/cao-tokscale'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).error.code, 'tokscale_missing');
});
