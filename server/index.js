// docket portal: one page for the web tools running on this PC.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, LOG_DIR, WEB_DIR, portFromArgs } from './paths.js';
import { Store, validateService, portOf } from './store.js';
import { Runner } from './runner.js';
import { probe, titleOf, iconOf, blocksFraming, scanHttp, listListening } from './ports.js';
import { processTable, guessLaunch, folderCommands, stillOurs } from './procs.js';
import { createAuth } from './auth.js';

const PORT = portFromArgs();
const auth = createAuth({ file: path.join(DATA_DIR, 'auth.json'), cookie: 'docket_portal_session' });

if (process.argv.includes('--reset-password')) {
  console.log(auth.reset() ? 'Removed the account. Open docket to create it again.' : 'There is no account.');
  process.exit(0);
}

// data/ holds the service commands: only this user may read it.
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.chmodSync(DATA_DIR, 0o700);

const store = new Store(DATA_DIR);
const runner = new Runner(store, LOG_DIR);

// Pick up processes started before the portal was restarted. A pid that now belongs to another
// process (after a reboot or pid reuse) is dropped, never adopted.
for (const [id, r] of Object.entries(store.runs)) {
  if (!store.get(id) || (r.phase !== 'failed' && !(await stillOurs(r)))) store.setRun(id, null);
  else if (r.phase === 'starting') runner.watch(id);
}

// Page facts (icon, framing) change rarely; keep them for a while.
const pageCache = new Map(); // url -> { at, icon, framable }
const PAGE_TTL = 10 * 60_000;

async function serviceStatus(s) {
  const res = await probe(s.url, { timeout: 1500 });
  let page = pageCache.get(s.url);
  if (res.ok && (!page || Date.now() - page.at > PAGE_TTL)) {
    const full = await probe(s.url, { timeout: 2500, wantBody: true });
    if (full.ok && full.status < 400) {
      page = { at: Date.now(), icon: iconOf(full.body, s.url), title: titleOf(full.body), framable: !blocksFraming(full.headers) };
      pageCache.set(s.url, page);
    }
  }
  return { ...s, port: portOf(s.url), up: res.ok, icon: page?.icon || '', framable: page ? page.framable : true, run: runner.info(s.id) };
}

// ---------- HTTP plumbing ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.json': 'application/json' };
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' };

function send(res, status, body) {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  } catch {
    res.writeHead(400, BASE_HEADERS);
    return res.end('Bad request');
  }
  // Signed out, the app page is the sign-in page (its files are public; the API is not).
  if (rel === 'index.html' && !auth.user(req)) rel = 'login.html';
  const file = path.resolve(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, BASE_HEADERS);
    return res.end('Not found');
  }
  res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

// ---------- API ----------
async function api(req, res, url) {
  // The API can run commands on this PC: only this page may call it. A custom header forces a
  // CORS preflight that this server never approves, and a sent Origin must be ours.
  const origin = req.headers.origin;
  if (req.headers['x-docket-portal'] !== '1' || (origin && !allowedOrigins.has(origin))) return send(res, 403, { error: 'forbidden' });
  const signIn = await auth.route(req, res, url.pathname, () => readBody(req));
  if (signIn) return send(res, signIn.status, signIn.body);
  if (!auth.user(req)) return send(res, 401, { error: 'signin' });

  const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
  const m = req.method;

  if (parts[0] === 'services' && parts.length === 1) {
    if (m === 'GET') {
      const list = await Promise.all(store.list().map(serviceStatus));
      return send(res, 200, { services: list });
    }
    if (m === 'POST') {
      const v = validateService(await readBody(req));
      if (v.error) return send(res, 400, { error: v.error });
      return send(res, 201, { service: store.add(v.value) });
    }
  }

  if (parts[0] === 'services' && parts[1]) {
    const id = parts[1];
    const s = store.get(id);
    if (!s) return send(res, 404, { error: 'not_found' });
    const action = parts[2];
    if (!action && m === 'PUT') {
      const v = validateService(await readBody(req));
      if (v.error) return send(res, 400, { error: v.error });
      if (v.value.url !== s.url) runner.clearMoved(id);
      return send(res, 200, { service: store.update(id, v.value) });
    }
    if (!action && m === 'DELETE') {
      runner.unwatch(id);
      store.setRun(id, null); // a process it started keeps running; the portal just forgets it
      store.remove(id);
      return send(res, 200, { ok: true });
    }
    if (action === 'start' && m === 'POST') {
      const body = await readBody(req);
      const r = await runner.start(id, { stopOwner: !!body.stopOwner });
      if (r.conflict) return send(res, 409, r);
      if (r.error) return send(res, 400, r);
      return send(res, 200, r);
    }
    if (action === 'stop' && m === 'POST') {
      const r = await runner.stop(id);
      return send(res, r.error ? 400 : 200, r);
    }
    if (action === 'dismiss' && m === 'POST') {
      runner.clearMoved(id);
      runner.clearFailed(id);
      return send(res, 200, { ok: true });
    }
    if (action === 'log' && m === 'GET') return send(res, 200, { log: runner.tail(id, Number(url.searchParams.get('lines')) || 40) });
  }

  if (parts[0] === 'scan' && m === 'GET') {
    const found = await scanHttp({ exclude: [PORT] });
    const byPort = new Map();
    for (const s of store.list()) {
      const p = portOf(s.url);
      if (!byPort.has(p)) byPort.set(p, []);
      byPort.get(p).push(s.name);
    }
    return send(res, 200, { servers: found.map((f) => ({ ...f, registered: byPort.get(f.port) || [] })) });
  }

  if (parts[0] === 'guess' && m === 'GET') {
    const port = portOf(url.searchParams.get('url') || '');
    if (!port) return send(res, 400, { error: 'url' });
    const row = (await listListening()).find((r) => r.port === port);
    if (!row) return send(res, 200, { port, off: true });
    const table = await processTable([row.pid]);
    const g = guessLaunch(table, row.pid);
    if (!g || !g.cwd) return send(res, 200, { port, off: false, pid: row.pid, proc: g?.proc || '', folder: '', cmd: '' });
    return send(res, 200, { port, off: false, ...g });
  }

  if (parts[0] === 'commands' && m === 'GET') {
    const folder = url.searchParams.get('folder') || '';
    if (!path.isAbsolute(folder)) return send(res, 200, { exists: false, commands: [] });
    return send(res, 200, folderCommands(folder));
  }

  return send(res, 404, { error: 'not_found' });
}

const server = http.createServer(async (req, res) => {
  if (!allowedHosts.has(req.headers.host || '')) { res.writeHead(403); return res.end('Forbidden host'); }
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, BASE_HEADERS); return res.end(); }
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    // Details (paths, stack) stay in the server log.
    if (!res.headersSent) send(res, 500, { error: 'internal' });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is in use. Set DOCKET_PORTAL_PORT or pass --port=<n>.`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => console.log(`docket portal: http://localhost:${PORT}`));

