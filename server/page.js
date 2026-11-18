// Small HTTP checks against a page, and the facts read from its HTML and headers.
import http from 'node:http';
import https from 'node:https';

/**
 * Answers whether an HTTP server answers at url. Any response (even 404) counts.
 * tries > 1 asks again after a miss, so a server busy for a moment isn't taken for stopped
 * (a refused connection fails at once, so a stopped server costs no extra wait).
 */
export async function probe(url, { tries = 1, ...opts } = {}) {
  let res;
  for (let i = 0; i < tries && !res?.ok; i++) res = await probeOnce(url, opts);
  return res;
}

function probeOnce(url, { timeout = 1500, wantBody = false } = {}) {
  return new Promise((done) => {
    let u;
    try { u = new URL(url); } catch { return done({ ok: false }); }
    let deadline;
    const resolve = (v) => { clearTimeout(deadline); done(v); };
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { timeout, rejectUnauthorized: false, headers: { accept: 'text/html,*/*' } }, (res) => {
      const headers = res.headers;
      if (!wantBody) { res.destroy(); return resolve({ ok: true, status: res.statusCode, headers }); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 65536) res.destroy(); });
      const done = () => resolve({ ok: true, status: res.statusCode, headers, body });
      res.on('end', done);
      res.on('close', done);
    });
    // The socket timeout only catches silence; a server that sends a byte now and then needs a deadline.
    deadline = setTimeout(() => { req.destroy(); resolve({ ok: false }); }, timeout);
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

/**
 * Finds the page's icon: a <link rel="icon"> (data: URLs are kept as they are) or /favicon.ico.
 * Only the page's own origin: an icon on another host would tell that host each time the portal is opened.
 */
export function iconOf(html, pageUrl) {
  for (const m of (html || '').matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?[^"'>]*\bicon\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const v = href && (href[2] ?? href[3] ?? href[4]);
    if (!v) continue;
    if (/^data:image\//i.test(v)) return v;
    try {
      const u = new URL(v, pageUrl + '/');
      if (u.origin === new URL(pageUrl).origin) return u.href;
    } catch { /* next */ }
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
