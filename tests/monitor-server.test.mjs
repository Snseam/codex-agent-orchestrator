import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMonitorServer } from '../src/monitor/server.mjs';

async function assets(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-monitor-assets-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><title>monitor</title>');
  await fs.writeFile(path.join(root, 'app.mjs'), 'export {};');
  await fs.writeFile(path.join(root, 'styles.css'), 'body{}');
  return root;
}

function request(endpoint, { method = 'GET', path = '/', token = null, ownerToken = null, host = null, origin = null } = {}) {
  const url = new URL(path, endpoint);
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (ownerToken) headers.authorization = `Bearer ${ownerToken}`;
    if (host) headers.host = host;
    if (origin) headers.origin = origin;
    const req = http.request(url, { method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = text; }
        resolve({ status: res.statusCode, headers: res.headers, body, text });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function collector(snapshot, { delayMs = 0 } = {}) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async snapshot() {
      calls++;
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      if (snapshot instanceof Error) throw snapshot;
      return snapshot;
    },
  };
}

const emptySnapshot = { scope: { mode: 'project', project: '/p', runId: null }, projects: [], nodes: [], sources: [] };

test('startMonitorServer serves authenticated snapshots and local static assets', async t => {
  const c = collector(emptySnapshot);
  const service = await startMonitorServer({ token: 'ui-token', ownerToken: 'owner-token', collector: c, assetsRoot: await assets(t) });
  t.after(service.close);
  assert.ok(service.server);
  assert.match(service.endpoint, /^http:\/\/127\.0\.0\.1:/);

  assert.equal((await request(service.endpoint, { path: '/api/snapshot' })).status, 401);
  const snapshot = await request(service.endpoint, { path: '/api/snapshot', token: 'ui-token' });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.schemaVersion, 1);
  assert.equal(snapshot.body.scope.mode, 'project');

  assert.equal((await request(service.endpoint, { path: '/' })).status, 200);
  assert.equal((await request(service.endpoint, { path: '/app.mjs' })).status, 200);
  assert.equal((await request(service.endpoint, { path: '/styles.css' })).status, 200);
  assert.equal((await request(service.endpoint, { path: '/secret.txt' })).status, 404);
});

test('monitor server rejects bad host, origin, query tokens, and write methods', async t => {
  const service = await startMonitorServer({ token: 'ui-token', ownerToken: 'owner-token', collector: collector(emptySnapshot), assetsRoot: await assets(t) });
  t.after(service.close);

  assert.equal((await request(service.endpoint, { path: '/api/snapshot', token: 'ui-token', host: 'evil.example' })).status, 403);
  assert.equal((await request(service.endpoint, { path: '/api/snapshot', token: 'ui-token', origin: 'http://evil.example' })).status, 403);
  assert.equal((await request(service.endpoint, { path: '/api/snapshot?token=ui-token', token: 'ui-token' })).status, 400);
  const post = await request(service.endpoint, { method: 'POST', path: '/api/snapshot', token: 'ui-token' });
  assert.equal(post.status, 405);
  assert.equal(post.body.error, 'read_only');
});

test('owner stop and health require owner token and never accept the UI token', async t => {
  const service = await startMonitorServer({ token: 'ui-token', ownerToken: 'owner-token', collector: collector(emptySnapshot), assetsRoot: await assets(t) });
  t.after(service.close);

  assert.equal((await request(service.endpoint, { path: '/_cao/health', token: 'ui-token' })).status, 401);
  const health = await request(service.endpoint, { path: '/_cao/health', ownerToken: 'owner-token' });
  assert.equal(health.status, 200);
  assert.equal(health.body.running, true);
  assert.ok(health.body.ownerProof);

  assert.equal((await request(service.endpoint, { method: 'POST', path: '/_cao/stop', token: 'ui-token' })).status, 401);
  const stopped = await request(service.endpoint, { method: 'POST', path: '/_cao/stop', ownerToken: 'owner-token' });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.stopping, true);
});

test('snapshot errors are sanitized and concurrent API requests share one collection', async t => {
  const errorService = await startMonitorServer({ token: 'ui-token', ownerToken: 'owner-token', collector: collector(new Error('CANARY_SECRET_STACK')), assetsRoot: await assets(t) });
  t.after(errorService.close);
  const failed = await request(errorService.endpoint, { path: '/api/snapshot', token: 'ui-token' });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error, 'snapshot_unavailable');
  assert.doesNotMatch(JSON.stringify(failed.body), /CANARY_SECRET_STACK/);

  const c = collector(emptySnapshot, { delayMs: 80 });
  const service = await startMonitorServer({ token: 'ui-token', ownerToken: 'owner-token', collector: c, refreshMs: 10_000, assetsRoot: await assets(t) });
  t.after(service.close);
  const responses = await Promise.all(Array.from({ length: 8 }, () => request(service.endpoint, { path: '/api/snapshot', token: 'ui-token' })));
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(c.calls, 1);
});
