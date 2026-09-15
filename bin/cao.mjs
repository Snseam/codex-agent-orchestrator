#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Orchestrator } from '../src/orchestrator.mjs';
import { Herdr } from '../src/runtime/herdr.mjs';
import { capabilities } from '../src/adapters.mjs';
import { validateTask } from '../src/task.mjs';
import { OrchestratorError } from '../src/errors.mjs';
import { runCommand } from '../src/process.mjs';

export const help = `Codex Agent Orchestrator (CAO) 0.1.0

Usage: node bin/cao.mjs <command> [options]

  init       --project PATH [--id ID] [--max-parallel 4]
  validate   --file TASK.json
  dispatch   --run ID --file TASK.json
  status     [--run ID]
  inspect    --run ID --task ID [--output]
  collect    --run ID --task ID [--wait-ms 45000]
  verify     --run ID --task ID
  retry      --run ID --task ID [--feedback-file PATH]
  resume     --run ID --task ID
  input      --run ID --task ID (--keys enter | --text-file PATH)
  integrate  --run ID --task ID
  recover    --run ID --task ID (recheck failed checkout or integration)
  cancel     --run ID --task ID
  cleanup    --run ID
  doctor

Global: --state-dir PATH (outside project), --help, --json
All command results are JSON. Keys can be comma-separated.
dispatch submits once; collect waits without resubmitting.
verify checks a stopped candidate; integrate applies and rechecks it.
No automatic commits, pushes, provider changes or plugin installation.
`;

const optionsByCommand = {
  init: ['project', 'id', 'max-parallel'], validate: ['file'], dispatch: ['run', 'file'],
  status: ['run'], inspect: ['run', 'task', 'output'], collect: ['run', 'task', 'wait-ms'],
  verify: ['run', 'task'], retry: ['run', 'task', 'feedback-file'], resume: ['run', 'task'],
  input: ['run', 'task', 'keys', 'text-file'], integrate: ['run', 'task'],
  recover: ['run', 'task'], cancel: ['run', 'task'], cleanup: ['run'], doctor: [],
};

export function parseArgs(argv) {
  const values = {};
  let command;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      if (!command) { command = token; continue; }
      throw new OrchestratorError('invalid_arguments', `Unexpected argument: ${token}`);
    }
    const [name, ...inlineParts] = token.slice(2).split('=');
    if (Object.hasOwn(values, name)) throw new OrchestratorError('invalid_arguments', `Duplicate option: --${name}`);
    if (['help', 'json', 'output'].includes(name)) {
      if (inlineParts.length) throw new OrchestratorError('invalid_arguments', `--${name} takes no value`);
      values[name] = true;
    } else {
      const value = inlineParts.length ? inlineParts.join('=') : argv[++i];
      if (value === undefined || (!inlineParts.length && value.startsWith('--'))) throw new OrchestratorError('invalid_arguments', `Missing value for --${name}`);
      values[name] = value;
    }
  }
  if (values.help || !command) return { command: 'help', values };
  if (!Object.hasOwn(optionsByCommand, command)) throw new OrchestratorError('invalid_arguments', `Unknown command: ${command}`);
  const allowed = new Set(['state-dir', 'json', ...optionsByCommand[command]]);
  for (const name of Object.keys(values)) if (!allowed.has(name)) throw new OrchestratorError('invalid_arguments', `Unknown option for ${command}: --${name}`);
  return { command, values };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, values: o } = parseArgs(argv);
  if (command === 'help') return { help };
  const required = key => {
    if (!o[key]) throw new OrchestratorError('invalid_arguments', `--${key} is required`);
    return o[key];
  };
  const read = file => fs.readFile(path.resolve(file), 'utf8');
  const orchestrator = new Orchestrator({ stateRoot: o['state-dir'], herdr: new Herdr({ binary: process.env.CAO_HERDR_BIN || 'herdr' }) });
  const taskArgs = () => [required('run'), required('task')];
  switch (command) {
    case 'init': return orchestrator.init({ project: required('project'), id: o.id, maxParallel: Number(o['max-parallel'] || 4) });
    case 'validate': return validateTask(JSON.parse(await read(required('file'))));
    case 'dispatch': return orchestrator.dispatch(required('run'), JSON.parse(await read(required('file'))));
    case 'status': return orchestrator.status(o.run);
    case 'inspect': return orchestrator.inspect(...taskArgs(), { output: !!o.output });
    case 'collect': return orchestrator.collect(...taskArgs(), { waitMs: Number(o['wait-ms'] || 0) });
    case 'verify': return orchestrator.verify(...taskArgs());
    case 'retry': return orchestrator.retry(...taskArgs(), o['feedback-file'] ? await read(o['feedback-file']) : '');
    case 'resume': return orchestrator.resume(...taskArgs());
    case 'input': return orchestrator.input(...taskArgs(), { keys: o.keys?.split(','), text: o['text-file'] ? await read(o['text-file']) : undefined });
    case 'integrate': return orchestrator.integrate(...taskArgs());
    case 'recover': return orchestrator.recover(...taskArgs());
    case 'cancel': return orchestrator.cancel(...taskArgs());
    case 'cleanup': return orchestrator.cleanup(required('run'));
    case 'doctor': {
      const tools = {};
      for (const name of ['node', 'git', 'herdr', 'claude', 'pi', 'opencode', 'codex']) {
        try { const r = await runCommand([name, '--version'], { timeoutMs: 10000 }); tools[name] = { available: r.code === 0, version: r.stdout.trim() || r.stderr.trim() }; }
        catch (error) { tools[name] = { available: false, error: error.code || 'error' }; }
      }
      return { tools, capabilities, note: 'Native child reporting is a contract, not verified telemetry or a hard concurrency limit.' };
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(data => {
    if (data?.help) process.stdout.write(data.help);
    else process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
  }).catch(error => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: error.code || 'error', message: error.message, details: error.details || {} } }, null, 2)}\n`);
    process.exitCode = error.code === 'invalid_arguments' ? 2 : 1;
  });
}
