// Starts and stops registered services. The command runs exactly as registered, in its folder:
// the portal never changes the port. Started processes keep running when the portal stops,
// and are picked up again from data/state.json.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { listListening, processNames } from './ports.js';
import { processTable, descendants, isAlive, startTimeOf, stillOurs } from './procs.js';
import { portOf } from './store.js';
import { ROOT } from './paths.js';

const LAUNCH = path.join(ROOT, 'server', 'launch.js');

const IS_WIN = process.platform === 'win32';
const WATCH_MS = 90_000; // how long to wait for the port after starting
const MOVED_GRACE_MS = 4_000; // a different port counts as "moved" after this long without the expected one
const TAIL_BYTES = 64 * 1024; // how much of the end of a log the UI reads

export class Runner {
  constructor(store, logDir) {
    this.store = store;
    this.logDir = logDir;
    this.watching = new Map(); // id -> timer
  }

  /** What the UI needs to know about the portal-started process of a service. */
  info(id) {
    const r = this.store.getRun(id);
    if (!r) return null;
    const alive = isAlive(r.pid);
    if (!alive && r.phase !== 'failed') {
      // Ended while nobody was watching (e.g. the portal was restarted): forget it.
      this.store.setRun(id, null);
      return null;
    }
    return { pid: r.pid, phase: r.phase, startedAt: r.startedAt, movedTo: r.movedTo || null, exitCode: r.exitCode ?? null, alive };
  }

  logFile(id) { return path.join(this.logDir, `${id}.log`); }

  tail(id, lines = 40) {
    let fd;
    try {
      fd = fs.openSync(this.logFile(id), 'r');
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length);
      let text = buf.toString('utf8');
      if (buf.length < size) text = text.slice(text.indexOf('\n') + 1); // drop the cut first line
      return text.split(/\r?\n/).filter((l) => l.trim()).slice(-lines).join('\n');
    } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  /** Who holds the port: a service the portal started, or another program. Null when free. */
  async portOwner(port, exceptId) {
    const rows = (await listListening()).filter((r) => r.port === port);
    if (!rows.length) return null;
    const pids = new Set(rows.map((r) => r.pid));
    const runs = [];
    for (const [id, r] of Object.entries(this.store.runs)) if (id !== exceptId && await stillOurs(r)) runs.push([id, r]);
    if (runs.length) {
      const table = await processTable();
      for (const [id, r] of runs) {
        const tree = descendants(table, r.pid);
        if ([...pids].some((p) => tree.has(p))) {
          const s = this.store.get(id);
          return { kind: 'service', id, name: s ? s.name : id, pid: r.pid };
        }
      }
    }
    const pid = rows[0].pid;
    const names = await processNames();
    return { kind: 'process', pid, proc: names.get(pid) || '' };
  }

  /**
   * Starts a service. Returns { ok } or { conflict } when its port is taken.
   * With stopOwner, a portal-started service holding the port is stopped first.
   */
  async start(id, { stopOwner = false } = {}) {
    const s = this.store.get(id);
    if (!s) return { error: 'not_found' };
    if (!s.folder || !s.cmd) return { error: 'no_command' };
    if (!fs.existsSync(s.folder)) return { error: 'no_folder' };
    const current = this.info(id);
    if (current && current.alive) return { ok: true, already: true };

    const port = portOf(s.url);
    let owner = await this.portOwner(port, id);
    if (owner && owner.kind === 'service' && stopOwner) {
      await this.stop(owner.id);
      for (let i = 0; i < 20 && owner; i++) {
        await sleep(250);
        owner = await this.portOwner(port, id);
      }
    }
    if (owner) return { conflict: { port, ...owner } };

    fs.mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
    const file = this.logFile(id);
    fs.writeFileSync(file, `--- ${new Date().toISOString()}  ${s.folder}\n> ${s.cmd}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600); // a log from before keeps its old mode otherwise
    let child;
    try {
      // launch.js runs the command (through the shell) and writes its output to the log.
      child = spawn(process.execPath, [LAUNCH, file, s.folder, s.cmd], { detached: true, windowsHide: true, stdio: 'ignore', env: serviceEnv() });
    } catch (e) {
      return { error: 'spawn', message: e.message };
    }
    if (!child.pid) return { error: 'spawn' };
    child.unref();
    const run = { pid: child.pid, phase: 'starting', startedAt: new Date().toISOString(), port };
    this.store.setRun(id, run);
    child.on('exit', (code) => {
      const r = this.store.getRun(id);
      if (!r || r.pid !== child.pid) return;
      this.unwatch(id);
      // Ending before the port opened is a failed start; ending later just means it is off now.
      if (r.phase === 'starting') this.store.setRun(id, { ...r, phase: 'failed', exitCode: code });
      else this.store.setRun(id, null);
    });
    // Remember when it started, so a later reused pid is not taken for it (see stillOurs).
    const procStart = await startTimeOf(child.pid);
    const cur = this.store.getRun(id);
    if (procStart && cur && cur.pid === child.pid) this.store.setRun(id, { ...cur, procStart });
    this.watch(id);
    return { ok: true, pid: child.pid };
  }

  /** Follows a starting service until its port opens, it opens another port, or it ends. */
  watch(id) {
    this.unwatch(id);
    const began = Date.now();
    let otherSince = 0;
    const tick = async () => {
      const r = this.store.getRun(id);
      if (!r || r.phase !== 'starting') return this.unwatch(id);
      if (!isAlive(r.pid)) return this.unwatch(id); // the exit handler records it
      const [table, rows] = await Promise.all([processTable(), listListening()]);
      const tree = descendants(table, r.pid);
      const mine = rows.filter((x) => tree.has(x.pid)).map((x) => x.port);
      const cur = this.store.getRun(id);
      if (!cur || cur.pid !== r.pid || cur.phase !== 'starting') return this.unwatch(id);
      if (mine.includes(r.port)) {
        this.store.setRun(id, { ...cur, phase: 'running' });
        return this.unwatch(id);
      }
      if (mine.length) {
        otherSince ||= Date.now();
        if (Date.now() - otherSince >= MOVED_GRACE_MS) {
          this.store.setRun(id, { ...cur, phase: 'running', movedTo: Math.min(...mine) });
          return this.unwatch(id);
        }
      }
      if (Date.now() - began > WATCH_MS) {
        this.store.setRun(id, { ...cur, phase: 'running' }); // still alive; leave it to the status check
        return this.unwatch(id);
      }
      this.watching.set(id, setTimeout(tick, 700));
    };
    this.watching.set(id, setTimeout(tick, 500));
  }

  unwatch(id) {
    clearTimeout(this.watching.get(id));
    this.watching.delete(id);
  }

  clearMoved(id) {
    const r = this.store.getRun(id);
    if (r && r.movedTo) this.store.setRun(id, { ...r, movedTo: null });
  }

  /** Forgets a failed run (after the UI showed it). */
  clearFailed(id) {
    const r = this.store.getRun(id);
    if (r && r.phase === 'failed') this.store.setRun(id, null);
  }

  /** Stops the process tree the portal started for this service. */
  async stop(id) {
    const r = this.store.getRun(id);
    if (!r) return { ok: true };
    this.unwatch(id);
    this.store.setRun(id, { ...r, phase: 'stopping' });
    // Never kill a pid that now belongs to another process: just forget the run.
    if (await stillOurs(r)) {
      if (IS_WIN) {
        await new Promise((res) => execFile('taskkill', ['/PID', String(r.pid), '/T', '/F'], { windowsHide: true }, () => res()));
      } else {
        try { process.kill(-r.pid, 'SIGTERM'); } catch { try { process.kill(r.pid, 'SIGTERM'); } catch { /* gone */ } }
      }
      for (let i = 0; i < 20 && isAlive(r.pid); i++) await sleep(150);
    }
    this.store.setRun(id, null);
    return { ok: true };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The environment a service starts with: the portal's own, minus what was meant for the portal.
 * A PORT set for the portal (by a launcher or dev tool) would otherwise move services that read
 * PORT onto the portal's port.
 */
export function serviceEnv(env = process.env) {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    if (/^(PORT|DOCKET_PORTAL_.*)$/i.test(k)) delete out[k];
  }
  return out;
}
