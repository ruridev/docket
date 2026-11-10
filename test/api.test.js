// Runs the portal for real on a free port, with a temporary data folder, and starts test servers through it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let portal;
let base;
let dataDir;
const outside = [];

async function call(p, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'X-Docket-Portal': '1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  return { status: res.status, data };
}

async function waitFor(fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(400);
  }
  throw new Error('timed out');
}

const getSvc = async (id) => (await call('/api/services')).data.services.find((s) => s.id === id);

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-portal-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  portal = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js'), `--port=${port}`], { env: { ...process.env, DOCKET_PORTAL_DATA: dataDir }, stdio: 'pipe' });
  await waitFor(async () => { try { return (await fetch(base + '/')).ok; } catch { return false; } }, 10000);
});

after(async () => {
  const list = (await call('/api/services')).data?.services || [];
  for (const s of list) await call(`/api/services/${s.id}/stop`, { method: 'POST' });
  for (const p of outside) p.kill();
  portal.kill();
});

test('the API refuses calls from other pages and hosts', async () => {
  assert.equal((await fetch(base + '/api/services')).status, 403);
  assert.equal((await call('/api/services', { headers: { Origin: 'http://evil.example' } })).status, 403);
  const status = await new Promise((resolve) => {
    http.get(`${base}/api/services`, { headers: { Host: 'evil.example', 'X-Docket-Portal': '1' } }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(status, 403);
  const page = await fetch(base + '/');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('start, guess, port conflict with a portal service, and stop', { timeout: 120000 }, async () => {
  const port = await freePort();
  const a = (await call('/api/services', { method: 'POST', body: { name: 'A', url: `http://127.0.0.1:${port}`, folder: FIX, cmd: `node web.js ${port}` } })).data.service;
  assert.equal((await call(`/api/services/${a.id}/start`, { method: 'POST', body: {} })).status, 200);
  const up = await waitFor(async () => { const s = await getSvc(a.id); return s.up && s.run?.phase === 'running' && s; });
  assert.equal(up.run.movedTo, null);

  const g = (await call(`/api/guess?url=${encodeURIComponent(`http://localhost:${port}`)}`)).data;
  assert.equal(g.off, false);
  assert.equal(g.folder.toLowerCase(), ROOT.toLowerCase()); // nearest folder with package.json
  assert.equal(g.cmd, `node web.js ${port}`);
  assert.equal(g.cwd.replace(/\\$/, '').toLowerCase(), FIX.toLowerCase());

  const scan = (await call('/api/scan')).data.servers.find((x) => x.port === port);
  assert.equal(scan.title, 'fixture');
  assert.deepEqual(scan.registered, ['A']);

  const b = (await call('/api/services', { method: 'POST', body: { name: 'B', url: `http://127.0.0.1:${port}`, folder: FIX, cmd: `node web.js ${port}` } })).data.service;
  const c = await call(`/api/services/${b.id}/start`, { method: 'POST', body: {} });
  assert.equal(c.status, 409);
  assert.equal(c.data.conflict.kind, 'service');
  assert.equal(c.data.conflict.id, a.id);

  assert.equal((await call(`/api/services/${b.id}/start`, { method: 'POST', body: { stopOwner: true } })).status, 200);
  await waitFor(async () => (await getSvc(b.id)).run?.phase === 'running');
  assert.equal((await getSvc(a.id)).run, null);

  await call(`/api/services/${b.id}/stop`, { method: 'POST' });
  await waitFor(async () => !(await getSvc(b.id)).up);
  assert.equal((await call(`/api/guess?url=${encodeURIComponent(`http://localhost:${port}`)}`)).data.off, true);
});

test('a program the portal did not start is reported, not stopped', { timeout: 60000 }, async () => {
  const port = await freePort();
  const ext = spawn(process.execPath, [path.join(FIX, 'web.js'), String(port)], { stdio: 'ignore' });
  outside.push(ext);
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/`)).ok; } catch { return false; } });
  const s = (await call('/api/services', { method: 'POST', body: { name: 'C', url: `http://127.0.0.1:${port}`, folder: FIX, cmd: `node web.js ${port}` } })).data.service;
  const r = await call(`/api/services/${s.id}/start`, { method: 'POST', body: { stopOwner: true } });
  assert.equal(r.status, 409);
  assert.equal(r.data.conflict.kind, 'process');
  assert.equal(r.data.conflict.pid, ext.pid);
  assert.equal(ext.exitCode, null);
});

test('a server that moves to another port is noticed', { timeout: 60000 }, async () => {
  // The address says one free port; the command asks for a busy one and falls back to the next.
  const port = await freePort();
  const busy = await freePort();
  const blocker = net.createServer().listen(busy, '127.0.0.1');
  await new Promise((res) => blocker.on('listening', res));
  const s = (await call('/api/services', { method: 'POST', body: { name: 'D', url: `http://127.0.0.1:${port}`, folder: FIX, cmd: `node web.js ${busy} --fallback` } })).data.service;
  assert.equal((await call(`/api/services/${s.id}/start`, { method: 'POST', body: {} })).status, 200);
  const moved = await waitFor(async () => (await getSvc(s.id)).run?.movedTo, 40000);
  assert.equal(moved, busy + 1);
  blocker.close();
  await call(`/api/services/${s.id}/dismiss`, { method: 'POST' });
  assert.equal((await getSvc(s.id)).run.movedTo, null);
  await call(`/api/services/${s.id}/stop`, { method: 'POST' });
});

test('a server that exits early shows its exit code and output', { timeout: 60000 }, async () => {
  const port = await freePort();
  const s = (await call('/api/services', { method: 'POST', body: { name: 'E', url: `http://127.0.0.1:${port}`, folder: FIX, cmd: `node web.js ${port} --fail` } })).data.service;
  assert.equal((await call(`/api/services/${s.id}/start`, { method: 'POST', body: {} })).status, 200);
  const r = await waitFor(async () => { const x = await getSvc(s.id); return x.run?.phase === 'failed' && x.run; });
  assert.equal(r.exitCode, 3);
  assert.match((await call(`/api/services/${s.id}/log`)).data.log, /Error: boom/);
  assert.equal((await call(`/api/services/${s.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(await getSvc(s.id), undefined);
});

test('missing folder and command are refused before starting', async () => {
  const s = (await call('/api/services', { method: 'POST', body: { name: 'F', url: 'http://127.0.0.1:1' } })).data.service;
  assert.equal((await call(`/api/services/${s.id}/start`, { method: 'POST', body: {} })).data.error, 'no_command');
  await call(`/api/services/${s.id}`, { method: 'PUT', body: { name: 'F', url: 'http://127.0.0.1:1', folder: path.join(FIX, 'nope'), cmd: 'x' } });
  assert.equal((await call(`/api/services/${s.id}/start`, { method: 'POST', body: {} })).data.error, 'no_folder');
  assert.equal((await call(`/api/commands?folder=${encodeURIComponent(ROOT)}`)).data.commands[0], 'npm start');
});
