import { createHash } from 'node:crypto';

// This identifies the probe configuration, not a production interactive harness.
export const PROBE_ENVIRONMENT = createHash('sha256').update(JSON.stringify({
  adapter: 'isolated-cli-print-v2', platform: process.platform, arch: process.arch,
  node: process.versions.node.split('.')[0], context: 'isolated-no-user-plugins', toolset: 'suite-controlled',
})).digest('hex');

export function providerFailure(value) {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  if (/\b401\b|unauthori[sz]ed|authentication|invalid.api.key/.test(text)) return 'probe_auth_failed';
  if (/\b403\b|forbidden/.test(text)) return 'probe_access_denied';
  if (/\b429\b|rate.limit/.test(text)) return 'probe_rate_limited';
  if (/quota|insufficient.balance|credits/.test(text)) return 'probe_quota_unavailable';
  if (/\b5\d\d\b/.test(text)) return 'probe_upstream_unavailable';
  return null;
}
