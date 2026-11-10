// Which TCP ports are listening on this PC (read from the OS table, no port scanning),
// and small HTTP checks against them.
import { execFile } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';

const IS_WIN = process.platform === 'win32';

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 15000, ...opts }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout));
    });
  });
}

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

/** Answers whether an HTTP server answers at url. Any response (even 404) counts. */
export function probe(url, { timeout = 1500, wantBody = false } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ ok: false }); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { timeout, rejectUnauthorized: false, headers: { accept: 'text/html,*/*' } }, (res) => {
      const headers = res.headers;
      if (!wantBody) { res.resume(); return resolve({ ok: true, status: res.statusCode, headers }); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 65536) res.destroy(); });
      const done = () => resolve({ ok: true, status: res.statusCode, headers, body });
      res.on('end', done);
      res.on('close', done);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ ok: false }));
  });
}

export function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 120) : '';
}

function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" })[e]);
}

/** Finds the page's icon: a <link rel="icon"> (data: URLs are kept as they are) or /favicon.ico. */
export function iconOf(html, pageUrl) {
  for (const m of (html || '').matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?[^"'>]*\bicon\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const v = href && (href[2] ?? href[3] ?? href[4]);
    if (!v) continue;
    if (v.startsWith('data:')) return v;
    try { return new URL(v, pageUrl + '/').href; } catch { /* next */ }
  }
  try { return new URL('/favicon.ico', pageUrl).href; } catch { return ''; }
}

/** True when the page forbids being shown inside another page (iframe). */
export function blocksFraming(headers = {}) {
  const xfo = String(headers['x-frame-options'] || '').toLowerCase();
  if (xfo === 'deny' || xfo === 'sameorigin') return true;
  const csp = String(headers['content-security-policy'] || '');
  const fa = /frame-ancestors([^;]*)/i.exec(csp);
  if (!fa) return false;
  const v = fa[1].trim();
  return v === "'none'" || v === "'self'" || v === '';
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

export { run };
