import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Herdr } from '../../src/runtime/herdr.mjs';
import { OrchestratorError } from '../../src/errors.mjs';

test('Herdr ensureServer treats real nonexistent session snapshot as server_not_running', async () => {
  const session = `cao-probe-${randomUUID().slice(0, 8)}`;
  const herdr = new Herdr();
  await assert.rejects(
    herdr.snapshot(session),
    (error) => error instanceof OrchestratorError && error.code === 'server_not_running',
  );
});
