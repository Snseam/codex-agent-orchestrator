import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { runCommand } from '../process.mjs';
import { ProfileStore } from '../profiles.mjs';
import { reserveExecution, releaseExecution, explainRoute, listReservations } from '../routing.mjs';
import { withLock } from '../state.mjs';
import { invariant } from '../errors.mjs';
import { CalibrationStore } from './store.mjs';
import { SUITES } from './suites.mjs';
import { preparePiProbe, observePiStream } from './pi.mjs';
import { PROBE_ENVIRONMENT, providerFailure } from './environment.mjs';
export { PROBE_ENVIRONMENT } from './environment.mjs';

const AUTH_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'];
const publicCode = error => /^[a-z][a-z0-9_]{0,79}$/.test(error?.code || '') ? error.code : 'calibration_failed';

export function observeClaudeStream({ now = Date.now, startedAt = now() } = {}) {
  const decoder = new StringDecoder('utf8');
  let pending = '', bytes = 0, firstEventMs = null, result = null, servedModel = null;
  function line(text) {
    let event;
    try { event = JSON.parse(text); } catch { return; }
    if (event?.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta' && firstEventMs === null) firstEventMs = Math.max(0, now() - startedAt);
    if (event?.type === 'assistant' && typeof event.message?.model === 'string') servedModel = event.message.model.slice(0, 256);
    if (event?.type === 'result') result = event;
  }
  return {
    onStdout(chunk) {
      bytes += chunk.length;
      invariant(bytes <= 1024 * 1024, 'calibration_output_limit', 'Probe output exceeded its limit.');
      pending += decoder.write(chunk);
      let index;
      while ((index = pending.indexOf('\n')) >= 0) { line(pending.slice(0, index)); pending = pending.slice(index + 1); }
    },
    finish() {
      pending += decoder.end(); if (pending.trim()) line(pending);
      const outputTokens = Number.isSafeInteger(result?.usage?.output_tokens) && result.usage.output_tokens >= 0 ? result.usage.output_tokens : null;
      return { result, servedModel, firstEventMs, outputTokens };
    },
  };
}

async function nativeClaudeAuth(home, environment) {
  const directory = path.resolve(environment.CLAUDE_CONFIG_DIR || path.join(home, '.claude'));
  let settings = {};
  try {
    const file = path.join(directory, 'settings.json');
    const info = await fs.lstat(file);
    invariant(info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024, 'native_config_unsupported', 'Native settings cannot be read safely.');
    try { settings = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch { invariant(false, 'native_config_invalid', 'Native settings are invalid.'); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const auth = {};
  for (const key of AUTH_KEYS) {
    const value = environment[key] ?? settings.env?.[key];
    if (typeof value === 'string' && value.length && value.length < 65536 && !/[\r\n\0]/.test(value)) auth[key] = value;
  }
  invariant(auth.ANTHROPIC_API_KEY || auth.ANTHROPIC_AUTH_TOKEN, 'native_probe_auth_unavailable', 'Isolated calibration requires explicit native API authentication; native OAuth is not copied.');
  return auth;
}

function isolatedEnvironment(base, directory, auth) {
  const env = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SystemRoot', 'WINDIR', 'COMSPEC']) if (base[key]) env[key] = base[key];
  return { ...env, HOME: directory, USERPROFILE: directory, CLAUDE_CONFIG_DIR: path.join(directory, 'claude'),
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1', DISABLE_NONESSENTIAL_TRAFFIC: '1', ...auth };
}

const INITIAL_CODE = 'export function uniqueStrings(values) { return values; }\n';
const CODE_PROMPT = 'Fix unique.mjs: uniqueStrings(values) returns a new array of the first occurrences of trimmed, nonempty strings in their original order. Ignore nonstrings. Comparisons are case sensitive. Never mutate the input. Use only file tools. Do not add files, tests, dependencies or perform unrelated work. Explain briefly when finished.';

async function verifyCode(directory, command, timeoutMs, signal) {
  const candidate = path.join(directory, 'workspace', 'unique.mjs');
  const stat = await fs.lstat(candidate);
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536, 'calibration_candidate_invalid', 'Probe candidate is invalid.');
  const marker = crypto.randomUUID();
  const verifier = path.join(directory, 'verify.mjs');
  const text = `import assert from 'node:assert/strict';\nimport { uniqueStrings } from './workspace/unique.mjs';\nconst a = Object.freeze([' a ', null, 'b', 'a', '', 7, ' A ', ' b ']);\nassert.deepEqual(uniqueStrings(a), ['a','b','A']);\nassert.deepEqual(uniqueStrings([]), []);\nassert.deepEqual(uniqueStrings([null,0,false,'   ']), []);\nfor(let k=0;k<20;k++){const s=String(k);assert.deepEqual(uniqueStrings([s,' '+s+' ',s+'!']),[s,s+'!']);}\nconst b=['x'];assert.notEqual(uniqueStrings(b),b);assert.deepEqual(b,['x']);\nprocess.stdout.write(${JSON.stringify(marker)});\n`;
  await fs.writeFile(verifier, text, { mode: 0o600, flag: 'wx' });
  const outcome = await command([process.execPath, verifier], { cwd: directory, env: { PATH: process.env.PATH }, timeoutMs: Math.min(5000, timeoutMs), maxBytes: 8192, signal });
  return outcome.code === 0 && outcome.stdout === marker && await fs.readFile(verifier, 'utf8') === text;
}

export class CalibrationRunner {
  constructor({ root, resources, profiles = new ProfileStore({ root }), store = new CalibrationStore({ root }), command = runCommand, environment = process.env, home = os.homedir(), now = Date.now, source = 'real' } = {}) {
    invariant(root && resources, 'invalid_calibration', 'Calibration requires state root and resource discovery.');
    invariant(['real', 'mock'].includes(source), 'invalid_calibration', 'Invalid evidence source.');
    Object.assign(this, { root: path.resolve(root), resources, profiles, store, command, environment, home, now, source });
  }

  async run({ resourceIds, suite = 'quick', refresh = false, timeoutMs = suite === 'quick' ? 30000 : 120000, budgetMs = suite === 'quick' ? 60000 : 240000, signal } = {}) {
    invariant(Object.hasOwn(SUITES, suite), 'invalid_calibration', 'Unknown calibration suite.');
    invariant(Array.isArray(resourceIds) && resourceIds.length > 0 && resourceIds.length <= 2 && resourceIds.every(id => typeof id === 'string'), 'invalid_calibration', 'Select one or two explicit resources.');
    invariant(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= (suite === 'quick' ? 30000 : 180000), 'invalid_calibration', 'Probe timeout exceeds the suite limit.');
    invariant(Number.isInteger(budgetMs) && budgetMs > 0 && budgetMs <= (suite === 'quick' ? 60000 : 360000), 'invalid_calibration', 'Total budget exceeds the suite limit.');
    return withLock(path.join(this.root, 'calibration', '.run.lock'), async () => {
      const started = this.now();
      const inventory = await this.resources.discover({ check: true });
      const results = [];
      for (const id of [...new Set(resourceIds)]) {
        const resource = inventory.resources.find(r => r.id === id);
        invariant(resource, 'resource_not_found', 'Resource not found.');
        const spec = SUITES[suite];
        const key = { resourceId: id, fingerprint: resource.fingerprint, suiteId: spec.id, suiteVersion: spec.version, environmentFingerprint: PROBE_ENVIRONMENT };
        const cached = await this.store.read(key);
        if (!refresh && cached.fresh) { results.push({ cached: true, record: cached.record }); continue; }
        const remaining = budgetMs - (this.now() - started);
        if (remaining <= 0 || signal?.aborted) { results.push({ resourceId: id, skipped: signal?.aborted ? 'cancelled' : 'budget_exhausted' }); continue; }
        const record = await this.#probe(resource, spec, key, Math.min(timeoutMs, remaining), signal);
        results.push({ cached: false, record: await this.store.save(record) });
      }
      return { schemaVersion: 1, suite, source: this.source, results, wallMs: this.now() - started,
        environment: 'isolated-cli-print', productionHarnessBenchmark: false, tokenRateBasis: 'reported-output-tokens / total-probe-wall-seconds' };
    }, { timeoutMs: 0 });
  }

  async #probe(resource, spec, key, timeoutMs, signal) {
    const started = this.now();
    let temporary = null, reservation = null;
    const record = { schemaVersion: 1, ...key, observedAt: this.now(), expiresAt: null, status: 'unavailable', source: this.source,
      metrics: { wallMs: null, firstEventMs: null, outputTokens: null, tokensPerSecond: null }, checks: [], errorCode: null, servedModel: null, usageComplete: false };
    const remaining = () => Math.max(1, timeoutMs - (this.now() - started));
    try {
      invariant(resource.installed && ['claude', 'pi'].includes(resource.agent), 'probe_adapter_unavailable', 'This isolated probe adapter is unavailable.');
      let auth, profile = null, preparedPi = null;
      if (resource.kind === 'profile') {
        profile = await this.profiles.get(resource.profileId);
        invariant(profile && (resource.agent === 'pi' || profile.protocol === 'anthropic'), 'probe_protocol_unavailable', 'Probe protocol is unsupported.');
        const route = await explainRoute(this.profiles, { profile: profile.id, allowShared: profile.source?.allowShared === true });
        invariant(route.selectedProfileId, 'route_unavailable', 'Profile is not eligible.');
        if (resource.agent === 'claude') {
          const secret = await this.profiles.resolveProfileSecret(profile);
          auth = { ANTHROPIC_BASE_URL: profile.endpoint, [profile.credential?.authScheme === 'bearer' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY']: secret || 'cao-loopback-probe' };
        }
      } else if (resource.agent === 'claude') auth = await nativeClaudeAuth(this.home, this.environment);
      if (auth?.ANTHROPIC_BASE_URL) {
        const url = new URL(auth.ANTHROPIC_BASE_URL);
        invariant(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'probe_endpoint_invalid', 'Probe endpoint is invalid.');
      }
      temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-calibration-'));
      const cwd = path.join(temporary, 'workspace');
      await fs.mkdir(cwd, { mode: 0o700 });
      await fs.mkdir(path.join(temporary, 'claude'), { mode: 0o700 });
      if (resource.agent === 'pi') preparedPi = await preparePiProbe(resource, { directory: temporary, home: this.home, environment: this.environment, profiles: this.profiles, suite: spec.id });
      const env = preparedPi?.env || isolatedEnvironment(this.environment, temporary, auth);
      const model = preparedPi?.model || (profile ? profile.modelMap?.[profile.model] || profile.model : resource.requestedModel);
      invariant(typeof model === 'string' && model.length, 'probe_model_unknown', 'An explicit model is required for calibration.');
      const binary = resource.executable || resource.agent;
      const help = await this.command([binary, '--help'], { env, cwd, timeoutMs: Math.min(2000, remaining()), maxBytes: 65536, signal });
      const isolationFlags = resource.agent === 'pi' ? ['--no-session', '--no-extensions', '--no-context-files', '--no-skills', '--offline'] : ['--safe-mode', '--restricted', '--no-session-persistence'];
      invariant(help.code === 0 && isolationFlags.every(flag => help.stdout.includes(flag)), 'probe_isolation_unavailable', 'Installed CLI does not expose the required isolation flags.');
      if (this.now() - started >= timeoutMs) invariant(false, 'command_timeout', 'Probe budget expired.');
      const capacityProfile = profile || preparedPi?.capacityProfile || { id: resource.id, endpoint: auth.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', protocol: 'anthropic', account: { maxParallel: 1 } };
      reservation = await reserveExecution(this.root, capacityProfile, { runId: `calibration-${crypto.randomBytes(8).toString('hex')}`, taskId: spec.id, attemptId: resource.id }, { ownerKind: 'calibration' });
      const nonce = `cao_${crypto.randomBytes(12).toString('hex')}`;
      if (spec.id === 'code') await fs.writeFile(path.join(cwd, 'unique.mjs'), INITIAL_CODE);
      const prompt = spec.id === 'quick' ? `Reply with exactly ${nonce} and no other text. Do not use tools.` : CODE_PROMPT;
      const stream = (preparedPi ? observePiStream : observeClaudeStream)({ now: this.now, startedAt: started });
      const argv = preparedPi ? [binary, ...preparedPi.argv] : [binary, '-p', prompt, '--model', model, '--safe-mode', '--restricted', '--no-session-persistence', '--setting-sources=', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--max-turns', spec.id === 'quick' ? '1' : '6'];
      if (!preparedPi) {
        if (spec.id === 'quick') argv.push('--tools=');
        else argv.push('--tools', 'Read,Write,Edit', '--allowedTools', 'Read,Write,Edit');
      }
      if (resource.effort) argv.push(preparedPi ? '--thinking' : '--effort', resource.effort);
      if (preparedPi) argv.push('--', prompt);
      const outcome = await this.command(argv, { env, cwd, timeoutMs: remaining(), maxBytes: 1024 * 1024, signal, onStdout: stream.onStdout });
      const observed = stream.finish();
      record.servedModel = observed.servedModel;
      record.metrics.firstEventMs = observed.firstEventMs;
      record.metrics.outputTokens = observed.outputTokens;
      record.usageComplete = observed.outputTokens !== null;
      const transportPassed = outcome.code === 0 && !outcome.truncated && observed.result?.is_error === false;
      record.checks.push({ id: 'completed-response', passed: transportPassed });
      // A served-model mismatch cannot be silently attributed to the requested model.
      const alias = ['haiku', 'sonnet', 'opus', 'fable'].includes(model);
      if (observed.servedModel && !alias && observed.servedModel !== model) invariant(false, 'probe_model_mismatch', 'Served model differs from requested model.');
      let passed = false;
      if (transportPassed && spec.id === 'quick') passed = observed.result.result?.trim() === nonce;
      if (transportPassed && spec.id === 'code' && this.now() - started < timeoutMs) passed = await verifyCode(temporary, this.command, remaining(), signal);
      record.checks.push({ id: spec.id === 'quick' ? 'exact-canary' : 'independent-code-check', passed });
      record.status = transportPassed ? (passed ? 'passed' : 'failed') : 'unavailable';
      if (record.status === 'failed') record.errorCode = 'probe_check_failed';
      if (!transportPassed) record.errorCode = observed.failureCode || providerFailure(observed.result?.result) || 'probe_response_unavailable';
    } catch (error) {
      record.errorCode = publicCode(error);
      record.status = error.code === 'command_timeout' ? 'timeout' : 'unavailable';
    } finally {
      // runCommand resolves/rejects only after its child has closed (including kill escalation).
      try { if (reservation) await releaseExecution(this.root, reservation); }
      finally { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); }
    }
    record.metrics.wallMs = Math.max(0, this.now() - started);
    if (spec.id === 'quick' && ['passed', 'failed'].includes(record.status) && record.metrics.outputTokens !== null && record.metrics.wallMs > 0) record.metrics.tokensPerSecond = record.metrics.outputTokens / (record.metrics.wallMs / 1000);
    record.expiresAt = this.now() + (['unavailable', 'timeout'].includes(record.status) ? 60000 : spec.ttlMs);
    return record;
  }
}

export async function releaseCalibrationReservation(root, id, { confirmedStopped = false } = {}) {
  invariant(confirmedStopped, 'calibration_stop_confirmation_required', 'Confirm the calibration process has stopped before releasing its capacity.');
  const reservation = (await listReservations(root)).find(item => item.id === id);
  invariant(reservation?.ownerKind === 'calibration', 'calibration_reservation_not_found', 'No calibration reservation matches that id.');
  await releaseExecution(root, id);
  return { id, released: true, evidence: 'operator-confirmed-stopped' };
}
