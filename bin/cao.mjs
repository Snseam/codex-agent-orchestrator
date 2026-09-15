#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Orchestrator, defaultStateRoot } from '../src/orchestrator.mjs';
import { Herdr } from '../src/runtime/herdr.mjs';
import { capabilities } from '../src/adapters.mjs';
import { validateTask } from '../src/task.mjs';
import { OrchestratorError } from '../src/errors.mjs';
import { runCommand } from '../src/process.mjs';
import { Tokscale } from '../src/runtime/tokscale.mjs';
import { UsageService, formatUsageTable } from '../src/usage.mjs';
import { ProfileStore } from '../src/profiles.mjs';
import { discoverCCSwitch, importCCSwitchProfile } from '../src/config-sources/cc-switch.mjs';
import { explainRoute, listReservations } from '../src/routing.mjs';
import { GatewayManager } from '../src/gateway/manager.mjs';

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
  usage      [--agent claude,codex,pi,opencode] [--model MODEL]
             [--today | --since YYYY-MM-DD --until YYYY-MM-DD]
             [--run ID [--task ID]] [--home PATH] [--tokscale-bin PATH] [--table]
  doctor

  source discover [--directory CC_SWITCH_DIRECTORY]
  profile list
  profile show --id ID
  profile put --file PROFILE.json [--if-revision HASH] [--default]
  profile clone --id ID --new-id NEW_ID
  profile remove --id ID
  profile default [--id ID | --clear]
  profile export --id ID [--file PATH]
  profile import-cc-switch --provider ID --app claude --id ID
             [--directory PATH] [--model MODEL] [--allow-shared]
  profile refresh --id ID [--model MODEL]
  secret set --id ID --stdin
  secret remove --id ID
  route explain --file TASK.json
  route reservations
  gateway start --profile ID [--id ID] [--allow-shared]
  gateway status --id ID
  gateway stop --id ID
  gateway list

Global: --state-dir PATH (outside project), --help, --json
Results are JSON unless usage --table is selected. Keys can be comma-separated.
dispatch submits once; collect waits without resubmitting.
verify checks a stopped candidate; integrate applies and rechecks it.
usage queries local token records through optional Tokscale; scoped attribution is workspace-based.
Profiled tasks use isolated runtime settings; existing global provider files are not rewritten.
No automatic commits, pushes, or plugin installation.
`;

const optionsByCommand = {
  init: ['project', 'id', 'max-parallel'], validate: ['file'], dispatch: ['run', 'file'],
  status: ['run'], inspect: ['run', 'task', 'output'], collect: ['run', 'task', 'wait-ms'],
  verify: ['run', 'task'], retry: ['run', 'task', 'feedback-file'], resume: ['run', 'task'],
  input: ['run', 'task', 'keys', 'text-file'], integrate: ['run', 'task'],
  recover: ['run', 'task'], cancel: ['run', 'task'], cleanup: ['run'], doctor: [],
  usage: ['agent', 'model', 'today', 'since', 'until', 'run', 'task', 'home', 'tokscale-bin', 'table'],
  'source discover': ['directory'],
  'profile list': [], 'profile show': ['id'], 'profile put': ['file', 'if-revision', 'default'],
  'profile clone': ['id', 'new-id'], 'profile remove': ['id'], 'profile default': ['id', 'clear'],
  'profile export': ['id', 'file'], 'profile import-cc-switch': ['directory', 'provider', 'app', 'id', 'model', 'allow-shared'],
  'profile refresh': ['id', 'model'], 'secret set': ['id', 'stdin'], 'secret remove': ['id'],
  'route explain': ['file'], 'route reservations': [],
  'gateway start': ['profile', 'id', 'allow-shared'], 'gateway status': ['id'], 'gateway stop': ['id'], 'gateway list': [],
};
const namespaces = new Set(['source', 'profile', 'secret', 'route', 'gateway']);

export function parseArgs(argv) {
  const values = {};
  let command;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      if (!command) { command = token; continue; }
      if (namespaces.has(command)) { command += ` ${token}`; continue; }
      throw new OrchestratorError('invalid_arguments', `Unexpected argument: ${token}`);
    }
    const [name, ...inlineParts] = token.slice(2).split('=');
    if (Object.hasOwn(values, name)) throw new OrchestratorError('invalid_arguments', `Duplicate option: --${name}`);
    if (['help', 'json', 'output', 'today', 'table', 'default', 'clear', 'allow-shared', 'stdin'].includes(name)) {
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
  const profiles = new ProfileStore({ root: o['state-dir'] || defaultStateRoot() });
  const gateways = new GatewayManager({ root: profiles.root, profiles });
  const readProfile = async file => {
    try { return JSON.parse(await read(file)); }
    catch (error) { if (error instanceof SyntaxError) throw new OrchestratorError('invalid_profile_file', 'Profile file is not valid JSON.'); throw error; }
  };
  const orchestrator = new Orchestrator({ stateRoot: o['state-dir'], herdr: new Herdr({ binary: process.env.CAO_HERDR_BIN || 'herdr' }) });
  const taskArgs = () => [required('run'), required('task')];
  switch (command) {
    case 'source discover': return discoverCCSwitch({ directory: o.directory });
    case 'profile list': return { profiles: await profiles.list(), defaultProfileId: (await profiles.getDefault())?.id || null };
    case 'profile show': {
      const profile = await profiles.get(required('id'));
      if (!profile) throw new OrchestratorError('profile_not_found', 'Profile does not exist.');
      return profile;
    }
    case 'profile put': return profiles.put(await readProfile(required('file')), { ifRevision: o['if-revision'], makeDefault: !!o.default });
    case 'profile clone': return profiles.clone(required('id'), required('new-id'));
    case 'profile remove': return { id: required('id'), removed: await profiles.remove(o.id) };
    case 'profile default': {
      if (o.id && o.clear) throw new OrchestratorError('invalid_arguments', '--id and --clear are mutually exclusive.');
      if (o.clear || o.id) await profiles.setDefault(o.clear ? null : o.id);
      return { defaultProfileId: (await profiles.getDefault())?.id || null };
    }
    case 'profile export': {
      const exported = await profiles.export(required('id'));
      if (!o.file) return exported;
      await fs.writeFile(path.resolve(o.file), JSON.stringify(exported, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      return { exported: path.resolve(o.file), containsCredentialValues: false };
    }
    case 'profile import-cc-switch': return profiles.put(await importCCSwitchProfile({ directory: o.directory, providerId: required('provider'), app: required('app'), id: required('id'), model: o.model, allowShared: !!o['allow-shared'] }));
    case 'profile refresh': {
      const previous = await profiles.get(required('id'));
      if (!previous || previous.source.type !== 'cc-switch') throw new OrchestratorError('profile_not_external', 'Select an imported CC Switch profile.');
      const imported = await importCCSwitchProfile({ directory: previous.source.directory, providerId: previous.source.providerId, app: previous.source.app, id: previous.id, model: o.model, allowShared: previous.source.allowShared });
      return profiles.put({
        ...imported,
        name: previous.name,
        enabled: previous.enabled,
        capabilities: previous.capabilities,
        priority: previous.priority,
        account: previous.account,
        quota: previous.quota,
        quality: previous.quality,
        speed: previous.speed,
        costPerMillion: previous.costPerMillion,
        modelMap: previous.modelMap,
        fallbacks: previous.fallbacks,
      }, { ifRevision: previous.revision });
    }
    case 'secret set': {
      const id = required('id');
      if (!o.stdin || process.stdin.isTTY) throw new OrchestratorError('invalid_arguments', 'Pipe the secret on stdin and pass --stdin; never put secret values in command arguments.');
      const chunks = []; let size = 0;
      for await (const chunk of process.stdin) { size += chunk.length; if (size > 65536) throw new OrchestratorError('invalid_secret', 'Secret exceeds 64 KiB.'); chunks.push(chunk); }
      const value = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
      return { ref: await profiles.putSecret(id, value), stored: true };
    }
    case 'secret remove': await profiles.removeSecret(required('id')); return { id: o.id, removed: true };
    case 'route explain': {
      const task = validateTask(await readProfile(required('file')));
      const defaultProfile = task.execution ? null : await profiles.getDefault();
      const selector = task.execution || (defaultProfile ? { profile: defaultProfile.id } : null);
      if (!selector) return { selectedProfileId: null, mode: 'inherited-agent-config', agent: task.agent };
      return explainRoute(profiles, selector, { agent: task.agent === 'auto' ? null : task.agent });
    }
    case 'route reservations': return { reservations: await listReservations(profiles.root), scope: 'CAO-attempts' };
    case 'gateway start': {
      const primary = await profiles.resolve(required('profile'));
      return gateways.start({ id: o.id, profileIds: [primary.id, ...primary.fallbacks], allowShared: !!o['allow-shared'] });
    }
    case 'gateway status': return gateways.status(required('id'));
    case 'gateway stop': return gateways.stop(required('id'));
    case 'gateway list': return gateways.list();
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
    case 'usage': {
      if (o.table && o.json) throw new OrchestratorError('invalid_arguments', '--table and --json are mutually exclusive.');
      if (o['tokscale-bin'] !== undefined && !o['tokscale-bin']) throw new OrchestratorError('invalid_arguments', '--tokscale-bin must identify an executable.');
      const service = new UsageService({ stateRoot: o['state-dir'], tokscale: new Tokscale({ binary: o['tokscale-bin'] || process.env.CAO_TOKSCALE_BIN || 'tokscale' }) });
      const report = await service.query({ agent: o.agent, model: o.model, today: o.today, since: o.since, until: o.until, run: o.run, task: o.task, home: o.home });
      return o.table ? { usageTable: formatUsageTable(report) } : report;
    }
    case 'doctor': {
      const tools = {};
      for (const name of ['node', 'git', 'herdr', 'claude', 'pi', 'opencode', 'codex', 'tokscale']) {
        try { const r = await runCommand([name === 'tokscale' ? process.env.CAO_TOKSCALE_BIN || name : name, '--version'], { timeoutMs: 10000 }); tools[name] = { available: r.code === 0, version: r.stdout.trim() || r.stderr.trim() }; }
        catch (error) { tools[name] = { available: false, error: error.code || 'error' }; }
      }
      return { tools, capabilities, tokenUsage: { backend: 'tokscale', optional: true, testedVersion: '4.16.0' }, note: 'Native child reporting is a contract, not verified telemetry or a hard concurrency limit.' };
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(data => {
    if (data?.help) process.stdout.write(data.help);
    else if (data?.usageTable) process.stdout.write(data.usageTable);
    else process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
  }).catch(error => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: error.code || 'error', message: error.message, details: error.details || {} } }, null, 2)}\n`);
    process.exitCode = error.code === 'invalid_arguments' ? 2 : 1;
  });
}
