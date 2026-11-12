import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { parseNetstat, parseLsof, parseTasklist, titleOf, iconOf, blocksFraming, probe } from '../server/ports.js';
import { validateService, portOf } from '../server/store.js';
import { simplifyCommand, guessLaunch, folderCommands, projectRoot, descendants, safeCommand, startTimeOf, stillOurs } from '../server/procs.js';
import { serviceEnv, Runner, stoppable, isCompose } from '../server/runner.js';
import { spawn } from 'node:child_process';

test('services do not inherit the portal port', () => {
  const env = serviceEnv({ PORT: '4600', Port: '1', DOCKET_PORTAL_DATA: 'x', PATH: 'p', DOCKET_DATA: 'keep' });
  assert.deepEqual(env, { PATH: 'p', DOCKET_DATA: 'keep' });
});

test('parseNetstat keeps only listening TCP rows, in any language', () => {
  const text = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2424',
    '  TCP    127.0.0.1:4649         0.0.0.0:0              ABHOEREN        100',
    '  TCP    127.0.0.1:50000        127.0.0.1:4649         ESTABLISHED     7',
    '  TCP    [::1]:5173             [::]:0                 LISTENING       200',
    '  UDP    0.0.0.0:5353           *:*                                    9',
  ].join('\r\n');
  assert.deepEqual(parseNetstat(text), [
    { host: '0.0.0.0', port: 135, pid: 2424 },
    { host: '127.0.0.1', port: 4649, pid: 100 },
    { host: '::1', port: 5173, pid: 200 },
  ]);
});

test('parseLsof reads pid and listening address', () => {
  assert.deepEqual(parseLsof('p10\nn*:3000\nn127.0.0.1:3001\np11\nn[::1]:5173\n'), [
    { host: '0.0.0.0', port: 3000, pid: 10 },
    { host: '127.0.0.1', port: 3001, pid: 10 },
    { host: '::1', port: 5173, pid: 11 },
  ]);
});

test('parseTasklist maps pid to name', () => {
  const m = parseTasklist('"node.exe","1234","Console","1","50,000 K"\r\n"System","4","Services","0","100 K"\r\n');
  assert.equal(m.get(1234), 'node.exe');
  assert.equal(m.get(4), 'System');
});

test('titleOf and iconOf read the page head', () => {
  const html = '<head><title> My &amp; App </title><link rel="shortcut icon" href="/static/i.png"></head>';
  assert.equal(titleOf(html), 'My & App');
  assert.equal(iconOf(html, 'http://localhost:3000'), 'http://localhost:3000/static/i.png');
  assert.equal(iconOf('<link rel="icon" href="data:image/svg+xml,%3Csvg%3E">', 'http://x:1'), 'data:image/svg+xml,%3Csvg%3E');
  assert.equal(iconOf('<p>no icon</p>', 'http://localhost:8765'), 'http://localhost:8765/favicon.ico');
  // Only web and image data URLs: anything else falls back to /favicon.ico
  // Icons on another host would tell that host you opened the portal: only the page's own origin
  for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'https://cdn.example/i.png', '//cdn.example/i.png', 'http://localhost:4000/i.png']) {
    assert.equal(iconOf(`<link rel="icon" href="${bad}">`, 'http://localhost:3000'), 'http://localhost:3000/favicon.ico', bad);
  }
  assert.equal(iconOf('<link href="icon.svg" rel="icon" type="image/svg+xml">', 'http://127.0.0.1:8765'), 'http://127.0.0.1:8765/icon.svg');
});

test('blocksFraming spots X-Frame-Options and frame-ancestors', () => {
  assert.equal(blocksFraming({}), false);
  assert.equal(blocksFraming({ 'x-frame-options': 'DENY' }), true);
  assert.equal(blocksFraming({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }), true);
  assert.equal(blocksFraming({ 'content-security-policy': 'frame-ancestors http://localhost:*' }), false);
});

test('validateService checks name, address and folder', () => {
  assert.equal(validateService({ name: '', url: 'http://localhost:1' }).error, 'name');
  assert.equal(validateService({ name: 'a', url: 'localhost:1' }).error, 'url');
  assert.equal(validateService({ name: 'a', url: 'ftp://x' }).error, 'url');
  assert.equal(validateService({ name: 'a', url: 'http://localhost:1', folder: 'rel/dir' }).error, 'folder');
  const v = validateService({ name: ' A ', url: 'http://localhost:4649/', folder: '', cmd: 'npm start' }).value;
  assert.deepEqual(v, { name: 'A', url: 'http://localhost:4649', desc: '', folder: '', cmd: '' });
  assert.equal(portOf('http://localhost'), 80);
  assert.equal(portOf('https://127.0.0.1:8443/x'), 8443);
});

test('simplifyCommand drops the program path', () => {
  assert.equal(simplifyCommand('"C:\\Program Files\\nodejs\\node.exe" server.js'), 'node server.js');
  assert.equal(simplifyCommand('C:\\Python312\\python.exe main.py --port 8188'), 'python main.py --port 8188');
  assert.equal(simplifyCommand('/usr/local/bin/node agent/index.js'), 'node agent/index.js');
});

test('guessLaunch walks up to the package manager', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.mkdirSync(path.join(dir, 'agent'));
  const table = [
    { pid: 1, ppid: 0, name: 'node.exe', cmd: '"C:\\nodejs\\node.exe" "C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" run dev', cwd: null },
    { pid: 2, ppid: 1, name: 'cmd.exe', cmd: 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c node agent/index.js', cwd: null },
    { pid: 3, ppid: 2, name: 'node.exe', cmd: 'node  agent/index.js', cwd: path.join(dir, 'agent') },
  ];
  const g = guessLaunch(table, 3);
  assert.equal(g.folder, dir);
  assert.equal(g.cmd, 'npm run dev');
  assert.equal(g.proc, 'node.exe');
  const plain = guessLaunch([{ pid: 9, ppid: 1, name: 'python.exe', cmd: '"C:\\py\\python.exe" main.py', cwd: dir }], 9);
  assert.equal(plain.cmd, 'python main.py');
  assert.deepEqual([...descendants(table, 1)].sort(), [1, 2, 3]);
  assert.equal(projectRoot(path.join(dir, 'agent')), dir);
});

test('folderCommands lists scripts with the right package manager', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x', dev: 'vite', start: 'node a', build: 'b' } }));
  assert.deepEqual(folderCommands(dir).commands, ['npm start', 'npm run dev']);
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
  assert.deepEqual(folderCommands(dir).commands, ['pnpm start', 'pnpm dev']);
  const py = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-'));
  fs.writeFileSync(path.join(py, 'main.py'), '');
  assert.deepEqual(folderCommands(py).commands, [process.platform === 'win32' ? 'python main.py' : 'python3 main.py']);
  assert.equal(folderCommands(path.join(py, 'nope')).exists, false);
});

test('only plain commands are suggested', () => {
  for (const ok of ['npm start', 'npm run dev', 'pnpm dev:web', 'bun run serve', 'node web.js 4600', 'python3 app/main.py', 'npm run dev -- --port=5174']) assert.equal(safeCommand(ok), ok);
  for (const bad of ['npm run dev; curl x|sh', 'npm run dev:x; touch /tmp/p #', 'node a.js && id', 'node ${rotation}', 'npx vite', 'npm run $(id)', 'node a.js\nid']) assert.equal(safeCommand(bad), '');
  const table = [{ pid: 1, ppid: 0, name: 'node', cmd: '/usr/bin/node /x/npm-cli.js run dev; curl x|sh', cwd: os.tmpdir() }];
  assert.equal(guessLaunch(table, 1).cmd, '');
  assert.equal(guessLaunch([{ pid: 2, ppid: 0, name: 'node', cmd: 'node ${rotation}', cwd: os.tmpdir() }], 2).cmd, '');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { 'dev:x; touch /tmp/p #': 'x', dev: 'vite' } }));
  assert.deepEqual(folderCommands(dir).commands, ['npm run dev']);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ main: 'a.js && id' }));
  assert.deepEqual(folderCommands(dir), { exists: true, commands: [] });
});

test('a run is ours only while its pid keeps the same start time', async () => {
  const procStart = await startTimeOf(process.pid);
  assert.ok(procStart);
  const now = new Date().toISOString();
  assert.equal(await stillOurs({ pid: process.pid, procStart, startedAt: now }), true);
  assert.equal(await stillOurs({ pid: process.pid, procStart: 'other', startedAt: now }), false);
  // Without a start time: trusted only for a moment after the start, since the pid may be reused later.
  assert.equal(await stillOurs({ pid: process.pid, startedAt: now }), true);
  assert.equal(await stillOurs({ pid: process.pid, startedAt: new Date(Date.now() - 5 * 60_000).toISOString() }), false);
});

test('tail reads only the end of a big log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-'));
  const lines = Array.from({ length: 20000 }, (_, i) => `line ${i}`);
  fs.writeFileSync(path.join(dir, 'x.log'), lines.join('\n') + '\n');
  const runner = new Runner(null, dir);
  assert.equal(runner.tail('x', 2), 'line 19998\nline 19999');
  assert.equal(runner.tail('x', 1e6).split('\n').length < 20000, true);
  assert.equal(runner.tail('missing'), '');
});

test('probe gives up on a server that drips bytes', async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const t = setInterval(() => res.write('x'), 50);
    res.on('close', () => clearInterval(t));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const began = Date.now();
    const r = await probe(`http://127.0.0.1:${srv.address().port}/`, { timeout: 400, wantBody: true });
    assert.equal(r.ok, false);
    assert.ok(Date.now() - began < 2000);
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

test('only plain servers are stopped by port, never forwarders', () => {
  for (const name of ['node', 'python3', 'memos', 'ruby']) assert.equal(stoppable(name), true, name);
  for (const name of ['ssh', 'com.docker.backend', 'docker-proxy', 'vpnkit', 'limactl', 'OrbStack Helper', 'kubectl', '']) assert.equal(stoppable(name), false, name);
});

test('isCompose spots docker compose up commands', () => {
  assert.equal(isCompose('docker compose up'), true);
  assert.equal(isCompose('docker compose up -d'), true);
  assert.equal(isCompose('docker-compose up'), true);
  assert.equal(isCompose('npm run dev'), false);
  assert.equal(isCompose('docker run -p 80:80 nginx'), false);
});

test('stop ends a server the portal did not start, found by its port', async () => {
  const child = spawn(process.execPath, ['-e', "require('http').createServer((q, s) => s.end('ok')).listen(0, '127.0.0.1', function () { console.log(this.address().port); })"], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const port = await new Promise((r) => child.stdout.once('data', (d) => r(Number(String(d).trim()))));
    const svcs = { a: { id: 'a', url: `http://127.0.0.1:${port}`, folder: '', cmd: '' } };
    const store = { runs: {}, get: (id) => svcs[id], getRun: () => null, setRun() {} };
    const r = await new Runner(store, os.tmpdir()).stop('a');
    assert.deepEqual(r, { ok: true });
    await new Promise((res) => (child.exitCode !== null || child.signalCode ? res() : child.once('exit', res)));
    assert.equal(child.signalCode, 'SIGTERM');
  } finally {
    child.kill();
  }
});

test('stopping a service started elsewhere never touches a local process for a remote address', async () => {
  for (const url of ['https://example.com', 'http://192.0.2.1:5432', 'http://localhost.example.com:3000']) {
    const runner = new Runner({ get: () => ({ id: 'x', url, folder: '', cmd: '' }) }, os.tmpdir());
    assert.deepEqual(await runner.stopOutside('x'), { error: 'not_stoppable' }, url);
  }
});
