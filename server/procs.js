// Facts about running processes: parent/child tree, command line, working folder.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ROOT } from './paths.js';

const IS_WIN = process.platform === 'win32';
const PS1 = path.join(ROOT, 'server', 'procinfo.ps1');

const missing = new Set();

export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 15000, ...opts }, (err, stdout) => {
      // Without lsof (not installed by default on some Linux distributions) docket finds no servers: say so once
      if (err?.code === 'ENOENT' && !missing.has(cmd)) {
        missing.add(cmd);
        console.warn(`docket: \`${cmd}\` was not found, so running servers can't be found. Install it and restart docket.`);
      }
      resolve(err && !stdout ? '' : String(stdout));
    });
  });
}

/** Parses `tasklist /FO CSV /NH` into pid -> image name. */
export function parseTasklist(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line);
    if (m) map.set(Number(m[2]), m[1]);
  }
  return map;
}

export async function processNames() {
  if (IS_WIN) return parseTasklist(await run('tasklist', ['/FO', 'CSV', '/NH']));
  const map = new Map();
  for (const line of (await run('ps', ['-axo', 'pid=,comm='])).split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) map.set(Number(m[1]), m[2].split('/').pop());
  }
  return map;
}

/** All processes as [{ pid, ppid, name, cmd, cwd }]; cwd is filled only for the pids in withCwd. */
export async function processTable(withCwd = []) {
  if (IS_WIN) {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-Ids', withCwd.join(',') || '0']);
    try { return JSON.parse(out.trim() || '[]'); } catch { return []; }
  }
  const rows = [];
  // Other users' command lines can hold their secrets, so only this user's are kept
  const me = process.getuid?.();
  for (const line of (await run('ps', ['-axo', 'pid=,ppid=,uid=,comm=,args='])).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[4].split('/').pop(), cmd: Number(m[3]) === me ? m[5] : '', cwd: null });
  }
  for (const r of rows) {
    if (!withCwd.includes(r.pid)) continue;
    const out = await run('lsof', ['-a', '-p', String(r.pid), '-d', 'cwd', '-Fn']);
    const n = out.split('\n').find((l) => l.startsWith('n'));
    if (n) r.cwd = n.slice(1);
  }
  return rows;
}

/** pid and every process started under it. */
export function descendants(table, pid) {
  const kids = new Map();
  for (const p of table) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p.pid);
  }
  const seen = new Set([pid]);
  const stack = [pid];
  while (stack.length) {
    for (const k of kids.get(stack.pop()) || []) {
      if (!seen.has(k)) { seen.add(k); stack.push(k); }
    }
  }
  return seen;
}

export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** When the process started, as the OS reports it; '' when it can't be read. Tells a reused pid apart. */
export async function startTimeOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  if (IS_WIN) return (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToString('o')`])).trim();
  return (await run('ps', ['-o', 'lstart=', '-p', String(pid)])).trim();
}

/**
 * True when the run's pid is still the process the portal started. A different start time means
 * the pid was reused. A run without a start time (it is saved a moment after the start) is trusted
 * only for a short while, since a pid can be reused any time after its process exits.
 */
const START_TIME_GRACE_MS = 60_000;
export async function stillOurs(r) {
  if (!r || !isAlive(r.pid)) return false;
  if (r.procStart) return (await startTimeOf(r.pid)) === r.procStart;
  return Date.parse(r.startedAt) > Date.now() - START_TIME_GRACE_MS;
}

/** The nearest folder at or above dir that looks like a project root. */
export function projectRoot(dir) {
  if (!dir) return '';
  let cur = path.resolve(dir);
  for (let i = 0; i < 8; i++) {
    for (const marker of ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', '.git']) {
      if (fs.existsSync(path.join(cur, marker))) return cur;
    }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return path.resolve(dir);
}

const RUNNERS = [
  [/npm-cli\.js"?\s+(.+)$/i, 'npm'],
  [/npx-cli\.js"?\s+(.+)$/i, 'npx'],
  [/yarn(?:\.js|\.cjs)?"?\s+(.+)$/i, 'yarn'],
  [/pnpm(?:\.cjs|\.js)?"?\s+(.+)$/i, 'pnpm'],
  [/(?:^|[\\/"])bun(?:\.exe)?"?\s+(.+)$/i, 'bun'],
];

// Suggested commands run through the shell, but come from other programs' command lines and from
// package.json files. Only these plain forms are suggested: no shell syntax can get through.
const SAFE_CMD = /^(?:(?:npm|yarn|pnpm|bun)(?: run)? [\w:.-]+|(?:node|python3?) [\w./@-]+)(?: [\w./@:=-]+)*$/;
export const safeCommand = (cmd) => (SAFE_CMD.test(cmd) ? cmd : '');

/** Turns a raw command line into something to type: `"C:\...\node.exe" a.js` -> `node a.js`. */
export function simplifyCommand(cmd) {
  const s = String(cmd || '').trim();
  const m = /^("([^"]+)"|(\S+))\s*(.*)$/.exec(s);
  if (!m) return s;
  const exe = path.win32.basename(path.posix.basename(m[2] || m[3])).replace(/\.exe$/i, '');
  return `${exe}${m[4] ? ' ' + m[4] : ''}`.trim();
}

/**
 * Guesses how a running server was started: the project folder and the command.
 * Walks up from the process to the package manager that launched it (npm/yarn/pnpm/bun).
 */
export function guessLaunch(table, pid) {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const self = byPid.get(pid);
  if (!self) return null;
  let cmd = '';
  let p = self;
  for (let i = 0; i < 5 && p; i++) {
    for (const [re, name] of RUNNERS) {
      const m = re.exec(p.cmd || '');
      if (m) { cmd = `${name} ${m[1].trim()}`; break; }
    }
    if (cmd) break;
    p = byPid.get(p.ppid);
  }
  if (!cmd) cmd = simplifyCommand(self.cmd);
  return { pid, proc: self.name, cwd: self.cwd || '', folder: projectRoot(self.cwd), cmd: safeCommand(cmd) };
}

/** Start commands to offer for a folder: package.json scripts (with its package manager) or Python entry files. */
export function folderCommands(folder) {
  const out = [];
  if (!folder || !fs.existsSync(folder)) return { exists: false, commands: out };
  const has = (f) => fs.existsSync(path.join(folder, f));
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    const scripts = Object.keys(pkg.scripts || {});
    const order = ['start', 'dev', 'serve', 'preview'];
    scripts.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    for (const s of scripts) {
      if (!/^(start|dev|serve|preview|server|web|ui)(:|$)/.test(s)) continue;
      out.push(s === 'start' || pm !== 'npm' ? `${pm} ${s === 'start' ? 'start' : s}` : `npm run ${s}`);
    }
    if (!out.length && pkg.main) out.push(`node ${pkg.main}`);
  } catch { /* no package.json */ }
  for (const f of ['server.js', 'index.js', 'app.js']) if (!out.length && has(f)) out.push(`node ${f}`);
  // macOS and most Linux distributions have only python3
  const py = IS_WIN ? 'python' : 'python3';
  for (const f of ['main.py', 'app.py', 'server.py']) if (has(f)) out.push(`${py} ${f}`);
  if (has('manage.py')) out.push(`${py} manage.py runserver`);
  return { exists: true, commands: [...new Set(out.filter(safeCommand))].slice(0, 6) };
}
