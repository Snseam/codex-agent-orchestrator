import fs from 'node:fs/promises';
import path from 'node:path';
import { invariant } from './errors.mjs';
import { readJson, writeJsonAtomic } from './state.mjs';

export const MAX_RESULT_BYTES = 131072;

export function validateResult(value, task, attempt) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'invalid_result', 'Result must be an object.');
  invariant(value.taskId === task.id && value.attemptId === attempt.id && value.nonce === attempt.nonce, 'stale_result', 'Result does not match this task, attempt and nonce.');
  invariant(['submitted', 'needs_input'].includes(value.status), 'invalid_result', 'Result status must be submitted or needs_input.');
  invariant(typeof value.summary === 'string' && Array.isArray(value.changedFiles) && value.changedFiles.every(x => typeof x === 'string'), 'invalid_result', 'Result must contain summary and changedFiles.');
  invariant(Array.isArray(value.checks) && Array.isArray(value.children) && Array.isArray(value.unresolved), 'invalid_result', 'Result must contain checks, children and unresolved arrays.');
  const ids = new Set();
  for (const child of value.children) {
    invariant(child && typeof child.id === 'string' && !ids.has(child.id) && ['completed', 'cancelled', 'running', 'unknown'].includes(child.status), 'invalid_result', 'Invalid or duplicate child record.');
    ids.add(child.id);
  }
  invariant(value.children.length <= task.maxChildren, 'child_budget_exceeded', 'Reported children exceed the task budget. This budget is a reporting contract, not a sandbox.');
  invariant(Buffer.byteLength(JSON.stringify(value, null, 2) + '\n') <= MAX_RESULT_BYTES, 'invalid_result', 'Result exceeds 128 KiB.');
  return value;
}

// A worker can atomically submit a report without gaining access to the run ledger.
// Identity is validated again against the authoritative attempt during collection.
export async function submitResult(attemptDirectory, value) {
  const directory = path.resolve(attemptDirectory);
  const stat = await fs.lstat(directory);
  invariant(stat.isDirectory() && !stat.isSymbolicLink(), 'invalid_result_directory', 'Attempt directory must be a real directory.');
  for (const name of ['task.json', 'submission.json']) {
    const file = await fs.lstat(path.join(directory, name));
    invariant(file.isFile() && !file.isSymbolicLink() && file.size <= MAX_RESULT_BYTES, 'invalid_result', 'Invalid local submission contract.');
  }
  const [task, contract] = await Promise.all([readJson(path.join(directory, 'task.json')), readJson(path.join(directory, 'submission.json'))]);
  invariant(contract.schemaVersion === 1 && contract.resultFile === 'result.json', 'invalid_result', 'Unsupported submission contract.');
  validateResult(value, task, contract);
  const file = path.join(directory, 'result.json');
  try {
    const existing = await fs.lstat(file);
    invariant(existing.isFile() && !existing.isSymbolicLink(), 'invalid_result', 'Refusing to replace a non-regular result file.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeJsonAtomic(file, value);
  return { attemptId: contract.id, status: 'reported', accepted: false, resultFile: file };
}
