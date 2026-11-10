import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseNetstat, parseLsof, parseTasklist, titleOf, iconOf, blocksFraming } from '../server/ports.js';
import { validateService, portOf } from '../server/store.js';
import { simplifyCommand, guessLaunch, folderCommands, projectRoot, descendants } from '../server/procs.js';
import { serviceEnv } from '../server/runner.js';

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
  assert.deepEqual(folderCommands(py).commands, ['python main.py']);
  assert.equal(folderCommands(path.join(py, 'nope')).exists, false);
});
