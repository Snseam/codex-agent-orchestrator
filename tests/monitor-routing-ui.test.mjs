import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentMeta, formatDuration, nativeChildrenSummary, normalizeSnapshot, performanceSummary, routeSummary } from '../web/monitor/app.mjs';

test('monitor UI normalizes adaptive route timing and native child status from public snapshots', () => {
  const snapshot = normalizeSnapshot({
    schemaVersion: 1,
    observedAt: '2026-09-17T00:00:00.000Z',
    scope: { mode: 'project', project: '/project' },
    projects: [],
    sources: [],
    nodes: [{
      id: 'attempt',
      label: 'Fix task',
      agent: 'claude',
      executorKind: 'external',
      route: {
        mode: 'adaptive',
        resourceId: 'native-claude-grok',
        preference: 'fastest',
        reasons: ['history:3/3', '<img src=x onerror=alert(1)>'],
      },
      performance: {
        phase: 'execute',
        durationsMs: { prepare: 120, launch: 240, execute: 1250, ignored: 999 },
        blockedMs: 5000,
        blockerCategory: 'native-children',
        lastProgressAt: '2026-09-17T00:00:03.000Z',
        lastObservedAt: '2026-09-17T00:00:04.000Z',
        legacyPrehistory: true,
      },
      nativeChildren: {
        state: 'blocked',
        complete: false,
        source: 'claude-hook',
        count: 2,
      },
    }],
  });

  const node = snapshot.nodes[0];
  assert.equal(node.executorKind, 'external');
  assert.equal(node.route.resourceId, 'native-claude-grok');
  assert.equal(node.route.reasons.length, 2);
  assert.equal(node.performance.phase, 'execute');
  assert.equal(node.performance.durationsMs.execute, 1250);
  assert.equal(node.performance.durationsMs.ignored, undefined);
  assert.equal(node.nativeChildren.state, 'blocked');
  assert.equal(routeSummary(node), 'adaptive · native-claude-grok · fastest');
  assert.match(performanceSummary(node), /Execute/);
  assert.match(performanceSummary(node), /Blocked 5\.0s/);
  assert.equal(nativeChildrenSummary(node), 'Blocked · 2');
  assert.equal(agentMeta(node), 'claude · External agent · adaptive');
  assert.doesNotMatch(agentMeta(node), /native-claude-grok|Execute|Blocked|2/);
});

test('monitor UI formats minute-boundary durations without 60-second remainders', () => {
  assert.equal(formatDuration(119600), '2m');
  assert.equal(formatDuration(120400), '2m');
  assert.equal(formatDuration(121400), '2m 1s');
});

test('monitor UI keeps old snapshots compatible and avoids HTML injection sinks', async () => {
  const snapshot = normalizeSnapshot({
    schemaVersion: 1,
    observedAt: '2026-09-17T00:00:00.000Z',
    scope: {},
    projects: [],
    sources: [],
    nodes: [{ id: 'legacy', label: '<b>legacy</b>', agent: 'codex' }],
  });

  const node = snapshot.nodes[0];
  assert.equal(node.executorKind, null);
  assert.equal(node.route, null);
  assert.equal(node.performance, null);
  assert.equal(node.nativeChildren, null);
  assert.equal(routeSummary(node), null);
  assert.equal(performanceSummary(node), null);
  assert.equal(nativeChildrenSummary(node), null);
  assert.equal(agentMeta(node), 'codex · Agent');

  const source = await readFile(new URL('../web/monitor/app.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/);
});
