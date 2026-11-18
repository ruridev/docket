// Which TCP ports are listening on this PC (read from the OS table, no port scanning).
import { run, processNames } from './procs.js';
import { probe, titleOf } from './page.js';

const IS_WIN = process.platform === 'win32';

/** Parses `netstat -ano` output into listening sockets. A listening TCP row has a foreign address of *:0. */
export function parseNetstat(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || !/^TCP/i.test(cols[0])) continue;
    const [, local, foreign] = cols;
    if (!/^(0\.0\.0\.0|\[::\]|\*):0$/.test(foreign)) continue;
    const i = local.lastIndexOf(':');
    const port = Number(local.slice(i + 1));
    const host = local.slice(0, i).replace(/^\[|\]$/g, '');
    const pid = Number(cols[cols.length - 1]);
    if (port && Number.isInteger(pid)) out.push({ host, port, pid });
  }
  return out;
}

/** Parses `lsof -nP -iTCP -sTCP:LISTEN -F pn` output (macOS / Linux). */
export function parseLsof(text) {
  const out = [];
  let pid = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n')) {
      const addr = line.slice(1);
      const i = addr.lastIndexOf(':');
      const port = Number(addr.slice(i + 1));
      const host = addr.slice(0, i).replace(/^\[|\]$/g, '');
      if (port && pid) out.push({ host: host === '*' ? '0.0.0.0' : host, port, pid });
    }
  }
  return out;
}

export async function listListening() {
  const rows = IS_WIN ? parseNetstat(await run('netstat', ['-ano'])) : parseLsof(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn']));
  const seen = new Set();
  return rows.filter((r) => {
    const key = `${r.port}/${r.pid}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Runs fn over items with at most n at a time. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/** Listening ports that answer HTTP, with process name and page title. */
export async function scanHttp({ exclude = [] } = {}) {
  const [rows, names] = await Promise.all([listListening(), processNames()]);
  const byPort = new Map();
  for (const r of rows) {
    if (exclude.includes(r.port) || byPort.has(r.port)) continue;
    if (!/^(0\.0\.0\.0|127\.0\.0\.1|::|::1|localhost)$/.test(r.host)) continue; // only reachable from localhost
    byPort.set(r.port, r);
  }
  const list = [...byPort.values()].sort((a, b) => a.port - b.port);
  const found = await pool(list, 24, async (r) => {
    const host = r.host === '::1' ? '[::1]' : '127.0.0.1';
    const res = await probe(`http://${host}:${r.port}/`, { timeout: 900, wantBody: true });
    if (!res.ok) return null;
    return { port: r.port, pid: r.pid, proc: names.get(r.pid) || '', title: titleOf(res.body) };
  });
  return found.filter(Boolean);
}
