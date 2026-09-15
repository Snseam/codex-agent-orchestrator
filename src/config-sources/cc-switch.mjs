import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { invariant } from '../errors.mjs';

const supportedApps = new Set(['claude', 'codex', 'pi', 'opencode']);
const supportedProtocols = new Set(['anthropic', 'openai-responses', 'openai-chat']);
const secretFields = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];
const modelFields = ['ANTHROPIC_MODEL', 'DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME'];
const secretValueMaxBytes = 64 * 1024;

function sha(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function defaultDirectory() {
  return path.join(os.homedir(), '.cc-switch');
}

function dbPath(directory) {
  const root = path.resolve(directory || process.env.CC_SWITCH_HOME || defaultDirectory());
  for (const name of ['cc-switch.db', 'cc-switch.sqlite', 'database.sqlite']) {
    const file = path.join(root, name);
    if (existsSync(file)) return { root, file };
  }
  return { root, file: path.join(root, 'cc-switch.db'), missing: true };
}

async function openReadOnly(file) {
  const sqlite = await import('node:sqlite');
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  return db;
}

function getColumns(db, table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name); }
  catch { return []; }
}

function requireColumns(columns, required) {
  const missing = required.filter(column => !columns.includes(column));
  invariant(!missing.length, 'cc_switch_unsupported_schema', 'CC Switch database schema is not supported.', { missing });
}

function readUserVersion(db) {
  try { return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0); }
  catch { return 0; }
}

function parseJson(value, fallback = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function base64urlEncode(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function base64urlDecode(value) {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function safeIdentifier(value, field, max = 256) {
  invariant(typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value), 'invalid_arguments', `${field} must be a nonempty safe string.`);
  return value;
}

function safeSecretValue(value) {
  invariant(typeof value === 'string', 'invalid_secret', 'Secret value must be a string.');
  const normalized = value.endsWith('\n') ? value.slice(0, -1) : value;
  invariant(normalized.length > 0, 'secret_not_found', 'CC Switch secret reference is not available.');
  invariant(Buffer.byteLength(normalized, 'utf8') <= secretValueMaxBytes, 'invalid_secret', 'Secret value is too large.');
  invariant(!/[\x00-\x1f\x7f]/.test(normalized), 'invalid_secret', 'Secret value must not contain control characters.');
  return normalized;
}

function safeUrl(value, fallback = null) {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return fallback;
    return url.toString().replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

function proxyEndpoint(proxy) {
  if (!proxy || !proxy.enabled) return null;
  const host = proxy.listenAddress || '127.0.0.1';
  const port = proxy.listenPort;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${bracketed}:${port}/v1`;
}

function coerceSqlBool(value) {
  return value === true || value === 1;
}

function firstString(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === 'string' && value.length > 0) return { key, value };
  }
  return { key: null, value: null };
}

function hasOAuthShape(settings, meta) {
  const auth = settings?.auth;
  if (auth && typeof auth === 'object') {
    if (auth.tokens && typeof auth.tokens === 'object') return true;
    if (typeof auth.access_token === 'string' || typeof auth.refresh_token === 'string') return true;
  }
  const serializedMeta = JSON.stringify(meta || {}).toLowerCase();
  return serializedMeta.includes('oauth');
}

function makeSecretRef({ directory, app, providerId, field }) {
  return `cc-switch:${base64urlEncode({ directory: path.resolve(directory), app, providerId, field })}`;
}

function parseSecretRef(ref) {
  invariant(typeof ref === 'string' && ref.startsWith('cc-switch:'), 'invalid_secret_ref', 'Secret ref must use cc-switch: prefix.');
  const decoded = base64urlDecode(ref.slice('cc-switch:'.length));
  invariant(decoded, 'invalid_secret_ref', 'CC Switch secret ref is invalid.');
  return decoded;
}

function publicProxyConfig(row) {
  if (!row) return null;
  return {
    appType: row.app_type,
    enabled: coerceSqlBool(row.enabled ?? row.proxy_enabled),
    proxyEnabled: coerceSqlBool(row.proxy_enabled ?? row.enabled),
    listenAddress: typeof row.listen_address === 'string' && row.listen_address.length > 0 ? row.listen_address : '127.0.0.1',
    listenPort: Number(row.listen_port),
    autoFailoverEnabled: coerceSqlBool(row.auto_failover_enabled),
    liveTakeoverActive: coerceSqlBool(row.live_takeover_active),
  };
}

function classifyProvider(row, proxy, directory) {
  const settings = parseJson(row.settings_config);
  const meta = parseJson(row.meta);
  const env = settings.env && typeof settings.env === 'object' ? settings.env : {};
  const reasons = [];
  const providerId = String(row.id);
  const appType = String(row.app_type || '');
  const app = supportedApps.has(appType) ? appType : appType;
  const isCurrent = coerceSqlBool(row.is_current);
  const sharedProxyEndpoint = isCurrent ? proxyEndpoint(proxy) : null;

  let model = null;
  let protocol = null;
  let endpoint = null;
  let authKind = 'unsupported';
  let credentialField = null;
  let secretRef = null;
  let requiresGateway = false;

  if (!supportedApps.has(appType)) reasons.push('unsupported_app');

  if (appType === 'claude') {
    protocol = 'anthropic';
    endpoint = safeUrl(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1');
    model = firstString(env, modelFields).value || 'claude-sonnet';
    credentialField = firstString(env, secretFields).key;
    if (credentialField) {
      authKind = 'claude-api';
      secretRef = makeSecretRef({ directory, app: appType, providerId, field: credentialField });
    } else if (hasOAuthShape(settings, meta)) {
      authKind = 'oauth';
      requiresGateway = true;
      reasons.push('requires_gateway');
    } else if (sharedProxyEndpoint) {
      authKind = 'active-proxy';
      reasons.push('shared_route_requires_explicit_allow');
    } else {
      reasons.push('missing_api_credential');
    }
  } else if (appType === 'codex') {
    protocol = 'openai-responses';
    model = 'codex';
    endpoint = 'https://api.openai.com/v1';
    authKind = hasOAuthShape(settings, meta) ? 'oauth' : 'unsupported';
    requiresGateway = authKind === 'oauth';
    reasons.push(requiresGateway ? 'requires_gateway' : 'unsupported_codex_import');
  } else if (supportedApps.has(appType)) {
    reasons.push('unsupported_app_import');
  }

  if (protocol && !supportedProtocols.has(protocol)) reasons.push('unsupported_protocol');
  if (!endpoint) reasons.push('unsupported_endpoint');

  const proxyPublic = publicProxyConfig(proxy);
  const publicConfig = {
    providerId,
    app: appType,
    name: row.name || null,
    providerType: row.provider_type || null,
    isCurrent,
    protocol,
    endpoint,
    model,
    authKind,
    credentialField,
    sharedProxyEndpoint,
    proxy: proxyPublic,
  };

  return {
    providerId,
    app,
    appType,
    name: row.name || providerId,
    model,
    protocol,
    endpoint,
    authKind,
    credentialField,
    secretRef,
    isCurrent,
    providerType: row.provider_type || null,
    supported: reasons.length === 0,
    requiresGateway,
    reasons: [...new Set(reasons)],
    sharedProxyAvailable: Boolean(sharedProxyEndpoint),
    proxyEndpoint: sharedProxyEndpoint,
    fingerprint: sha(publicConfig),
  };
}

function readProxyConfigs(db, columns) {
  if (!columns.length) return new Map();
  requireColumns(columns, ['app_type', 'listen_address', 'listen_port']);
  const rows = db.prepare('SELECT * FROM proxy_config').all();
  return new Map(rows.map(row => [row.app_type, publicProxyConfig(row)]));
}

async function readInventory(directory) {
  const location = dbPath(directory);
  if (location.missing) {
    return { schemaVersion: null, directory: location.root, database: location.file, supported: false, providers: [], proxyConfig: [], reasons: ['database_not_found'] };
  }

  let db;
  try {
    db = await openReadOnly(location.file);
    const userVersion = readUserVersion(db);
    invariant(userVersion === 18, 'cc_switch_unsupported_schema', 'CC Switch database schema is not supported.', { userVersion });
    const providerColumns = getColumns(db, 'providers');
    requireColumns(providerColumns, ['id', 'app_type', 'name', 'settings_config', 'provider_type', 'meta', 'is_current']);
    const proxyColumns = getColumns(db, 'proxy_config');
    const proxyByApp = readProxyConfigs(db, proxyColumns);
    const rows = db.prepare(`
      SELECT id, app_type, name, settings_config, provider_type, meta, is_current
      FROM providers
      ORDER BY app_type, id
    `).all();
    return {
      schemaVersion: userVersion,
      directory: location.root,
      database: location.file,
      supported: true,
      providers: rows.map(row => classifyProvider(row, proxyByApp.get(row.app_type), location.root)),
      proxyConfig: [...proxyByApp.values()],
      reasons: [],
    };
  } finally {
    db?.close();
  }
}

export async function discoverCCSwitch({ directory } = {}) {
  return readInventory(directory);
}

export async function resolveCCSwitchSecret(refOrInput) {
  const input = typeof refOrInput === 'string' ? parseSecretRef(refOrInput) : refOrInput;
  invariant(input && typeof input === 'object', 'invalid_secret_ref', 'CC Switch secret reference is invalid.');
  const { directory, field } = input;
  const app = safeIdentifier(input.app, 'app', 64);
  const providerId = safeIdentifier(input.providerId, 'providerId');
  invariant(typeof directory === 'string' && directory.length > 0, 'invalid_secret_ref', 'CC Switch secret reference is missing directory.');
  invariant(secretFields.includes(field), 'invalid_secret_ref', 'CC Switch secret reference uses an unsupported field.');

  const location = dbPath(directory);
  invariant(!location.missing, 'secret_not_found', 'CC Switch secret reference is not available.');
  let db;
  try {
    db = await openReadOnly(location.file);
    const userVersion = readUserVersion(db);
    invariant(userVersion === 18, 'cc_switch_unsupported_schema', 'CC Switch database schema is not supported.', { userVersion });
    const providerColumns = getColumns(db, 'providers');
    requireColumns(providerColumns, ['id', 'app_type', 'settings_config']);
    const row = db.prepare('SELECT settings_config FROM providers WHERE id = ? AND app_type = ?').get(providerId, app);
    invariant(row, 'cc_switch_provider_not_found', 'CC Switch provider was not found.');
    const env = parseJson(row.settings_config).env || {};
    const value = env[field];
    return safeSecretValue(value);
  } finally {
    db?.close();
  }
}

export async function importCCSwitchProfile({ directory, providerId, app, id, model, allowShared = false } = {}) {
  providerId = safeIdentifier(providerId, 'providerId');
  app = safeIdentifier(app, 'app', 64);
  const inventory = await discoverCCSwitch({ directory });
  const provider = inventory.providers.find(row => row.providerId === providerId && row.app === app);
  invariant(provider, 'cc_switch_provider_not_found', 'CC Switch provider was not found.');

  if (provider.supported) {
    return {
      id: id || `${app}-${sha({ app, providerId }).slice(0, 16)}`,
      name: `${provider.name}`,
      agent: app,
      model: model || provider.model,
      protocol: provider.protocol,
      endpoint: provider.endpoint,
      credential: { type: 'cc-switch', providerId, app, field: provider.credentialField, secretRef: provider.secretRef, authScheme: provider.credentialField === 'ANTHROPIC_AUTH_TOKEN' ? 'bearer' : 'api-key' },
      source: { type: 'cc-switch', directory: inventory.directory, providerId, app, fingerprint: provider.fingerprint, route: 'direct', allowShared: false },
      enabled: true,
      capabilities: [],
      priority: 0,
      account: { id: null, maxParallel: 1 },
      quota: { state: 'unknown', observedAt: null, expiresAt: null, remainingTokens: null },
      quality: null,
      speed: null,
      costPerMillion: null,
      modelMap: {},
      fallbacks: [],
    };
  }

  if (provider.sharedProxyAvailable) {
    invariant(allowShared, 'cc_switch_shared_route_required', 'Active proxy reuse requires explicit shared routing.');
    return {
      id: id || `${app}-${sha({ app, providerId }).slice(0, 16)}`,
      name: `${provider.name} shared proxy`,
      agent: app,
      model: model || provider.model,
      protocol: provider.protocol,
      endpoint: provider.proxyEndpoint,
      credential: { type: 'none' },
      source: { type: 'cc-switch', directory: inventory.directory, providerId, app, fingerprint: provider.fingerprint, route: 'active-proxy', allowShared: true },
      enabled: true,
      capabilities: [],
      priority: 0,
      account: { id: null, maxParallel: 1 },
      quota: { state: 'unknown', observedAt: null, expiresAt: null, remainingTokens: null },
      quality: null,
      speed: null,
      costPerMillion: null,
      modelMap: {},
      fallbacks: [],
    };
  }

  if (provider.requiresGateway) {
    invariant(false, 'cc_switch_requires_gateway', 'CC Switch provider requires a gateway route and cannot be imported as a direct profile.', { reasons: provider.reasons });
  }

  invariant(false, 'cc_switch_provider_unsupported', 'CC Switch provider is not supported.', { reasons: provider.reasons });
}
