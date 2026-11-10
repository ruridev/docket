// docket portal UI. Plain JS, no build step.
'use strict';

// ---------- language ----------
const LANGS = { ja: '日本語', ko: '한국어', en: 'English' };
const LANG_KEY = 'docket-portal-lang';
let lang = (() => {
  try { const saved = localStorage.getItem(LANG_KEY); if (LANGS[saved]) return saved; } catch { /* ignore */ }
  const nav = (navigator.language || 'en').slice(0, 2);
  return LANGS[nav] ? nav : 'en';
})();
const tr = (key, p = {}) => (I18N[lang][key] ?? I18N.en[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => (k in p ? p[k] : m));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (sel, root = document) => root.querySelector(sel);

// ---------- state ----------
let services = [];
let view = 'home';
let modal = null; // { type: 'list' | 'edit' | 'settings' | 'conflict', ... }
const frames = new Map(); // id -> { el, src, wasUp }
const logs = new Map(); // id -> text
let pollTimer = 0;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'X-Docket-Portal': '1', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, ok: res.ok, data };
}

function toast(text) {
  const box = $('#toastBox');
  box.innerHTML = `<div class="toast" role="status">${esc(text)}</div>`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { box.innerHTML = ''; }, 3500);
}

// ---------- service helpers ----------
const svc = (id) => services.find((s) => s.id === id);
const run = (s) => s.run || null;
const isStarting = (s) => run(s)?.phase === 'starting';
const isFailed = (s) => run(s)?.phase === 'failed';
function movedUrl(s) {
  const to = run(s)?.movedTo;
  if (!to) return '';
  try {
    const u = new URL(s.url);
    u.port = String(to);
    return /\/$/.test(s.url) ? u.href : u.href.replace(/\/$/, '');
  } catch { return ''; }
}
const isLive = (s) => s.up || (!!run(s)?.movedTo && run(s).alive);
const effectiveUrl = (s) => (!s.up && run(s)?.movedTo ? movedUrl(s) : s.url);
const canStart = (s) => !!s.cmd && !isLive(s) && !(run(s)?.alive);
const canStop = (s) => !!run(s)?.alive && run(s).phase !== 'stopping';
const portOf = (url) => { try { const u = new URL(url); return Number(u.port || (u.protocol === 'https:' ? 443 : 80)); } catch { return null; } };

const TINTS = ['#0969da', '#1a7f37', '#8250df', '#bc4c00', '#bf3989', '#0a7b83', '#6e7781', '#9a6700'];
const tintOf = (name) => TINTS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % TINTS.length];

function statusOf(s) {
  if (isLive(s)) return { cls: 'up', label: tr('up') };
  if (isStarting(s)) return { cls: 'starting', label: tr('starting') };
  return { cls: '', label: tr('down') };
}

function iconHtml(s) {
  const letter = esc((s.name.replace(/^docket-/, '')[0] || '?').toUpperCase());
  const fallback = `<span class="svc-icon" style="background:${tintOf(s.name)}">${letter}</span>`;
  if (!s.icon) return fallback;
  return `<span class="svc-icon"><img src="${esc(s.icon)}" alt="" data-fallback="${esc(letter)}" data-tint="${tintOf(s.name)}"></span>`;
}

// Broken icons turn into the letter tile.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName !== 'IMG' || !img.dataset.fallback) return;
  const box = img.parentElement;
  box.style.background = img.dataset.tint;
  box.textContent = img.dataset.fallback;
}, true);

// ---------- header ----------
function renderHeader() {
  const up = services.filter(isLive).length;
  const down = services.length - up;
  $('#brand').setAttribute('aria-label', tr('home'));
  $('#addBtn').setAttribute('aria-label', tr('register'));
  $('#addBtn').title = tr('register');
  $('#settingsBtn').setAttribute('aria-label', tr('settings'));
  $('#settingsBtn').title = tr('settings');
  $('#counts').innerHTML = `
    <button class="count" type="button" data-list="up" aria-label="${esc(tr('up'))} ${up}"><span class="dot up"></span><span class="lbl">${esc(tr('up'))}</span> <strong>${up}</strong></button>
    <button class="count" type="button" data-list="down" aria-label="${esc(tr('down'))} ${down}"><span class="dot"></span><span class="lbl">${esc(tr('down'))}</span> <strong>${down}</strong></button>`;
  const s = svc(view);
  document.body.classList.toggle('in-view', !!s);
  if (!s) document.body.classList.remove('hdr-open');
  $('#fab').hidden = !s;
  $('#fab').setAttribute('aria-label', 'docket');
  $('#fab').setAttribute('aria-expanded', String(document.body.classList.contains('hdr-open')));
  $('#fab').innerHTML = s ? `${$('#brand .logo').outerHTML}<span class="dot ${statusOf(s).cls}"></span>` : '';
  placeFab();
  $('#current').innerHTML = s ? `
    <button class="count" type="button" data-list="all" title="${esc(tr('switchTitle'))}">
      <span class="dot ${statusOf(s).cls}"></span>
      <span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.name)}</span>
      <span class="mono small muted" style="white-space:nowrap">${esc(effectiveUrl(s))}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
    </button>` : '';
  $('#viewTools').innerHTML = s ? `
    <button class="icon-btn" type="button" data-act="reload" aria-label="${esc(tr('reload'))}" title="${esc(tr('reload'))}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/></svg>
    </button>
    <a class="icon-btn" href="${esc(effectiveUrl(s))}" target="_blank" rel="noopener" aria-label="${esc(tr('openNewTab'))}" title="${esc(tr('openNewTab'))}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>
    </a>
    <span class="sep"></span>` : '';
}

// ---------- floating button: drag to move, position kept in this browser ----------
// Stored as 0..1 of the free space so it stays on screen when the window is resized.
const FAB_KEY = 'docket-portal-fab';
let fabPos = (() => { try { return JSON.parse(localStorage.getItem(FAB_KEY)); } catch { return null; } })();
let fabDrag = null;
let fabMoved = false;

function placeFab() {
  const f = $('#fab');
  if (!fabPos || f.hidden) return;
  Object.assign(f.style, {
    left: `${Math.round(fabPos.x * (innerWidth - f.offsetWidth))}px`,
    top: `${Math.round(fabPos.y * (innerHeight - f.offsetHeight))}px`,
    bottom: 'auto',
    transform: 'none',
  });
}

$('#fab').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const f = e.currentTarget;
  const r = f.getBoundingClientRect();
  fabDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY };
  fabMoved = false;
  f.setPointerCapture(e.pointerId); // keeps the drag going over the service iframe
});
$('#fab').addEventListener('pointermove', (e) => {
  if (!fabDrag) return;
  if (!fabMoved && Math.hypot(e.clientX - fabDrag.x0, e.clientY - fabDrag.y0) < 4) return;
  fabMoved = true;
  const f = e.currentTarget;
  const clamp = (v) => Math.min(1, Math.max(0, v));
  fabPos = {
    x: clamp((e.clientX - fabDrag.dx) / (innerWidth - f.offsetWidth)),
    y: clamp((e.clientY - fabDrag.dy) / (innerHeight - f.offsetHeight)),
  };
  placeFab();
});
$('#fab').addEventListener('pointerup', () => {
  if (fabDrag && fabMoved) try { localStorage.setItem(FAB_KEY, JSON.stringify(fabPos)); } catch { /* ignore */ }
  fabDrag = null;
});
window.addEventListener('resize', placeFab);

// ---------- home ----------
const editIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>';

function renderHome() {
  const up = services.filter(isLive).length;
  if (!services.length) {
    $('#home').innerHTML = `<div class="home-inner"><div class="empty">
      <h1 style="margin:0;font-size:20px;color:var(--text)">${esc(tr('emptyTitle'))}</h1>
      <span>${esc(tr('emptyText'))}</span>
      <button class="btn btn-primary" type="button" data-act="add">+ ${esc(tr('register'))}</button></div></div>`;
    return;
  }
  $('#home').innerHTML = `<div class="home-inner">
    <div class="home-title"><h1>${esc(tr('homeTitle'))}</h1><span class="muted">${esc(tr('summary', { n: services.length, up }))}</span></div>
    <div class="grid">${services.map((s) => {
      const st = statusOf(s);
      return `<article class="card">
        <div class="card-head">${iconHtml(s)}
          <div><h3 title="${esc(s.name)}">${esc(s.name)}</h3><span class="addr mono">${esc(s.url)}</span></div>
          <span class="pill ${st.cls}">${esc(st.label)}</span></div>
        <p>${esc(s.desc || tr('noDesc'))}</p>
        <div class="actions">
          <button class="btn btn-primary" type="button" data-open="${s.id}">${esc(tr('open'))}</button>
          ${canStart(s) ? `<button class="btn" type="button" data-start="${s.id}">${esc(tr('run'))}</button>` : ''}
          <a class="btn" href="${esc(effectiveUrl(s))}" target="_blank" rel="noopener">${esc(tr('newTab'))}</a>
          <span class="grow"></span>
          <button class="icon-btn" type="button" data-edit="${s.id}" aria-label="${esc(tr('edit'))}" title="${esc(tr('edit'))}">${editIcon}</button>
        </div></article>`;
    }).join('')}</div></div>`;
}

// ---------- service view ----------
function ensureFrame(s) {
  const src = effectiveUrl(s);
  let f = frames.get(s.id);
  if (!f) {
    const el = document.createElement('iframe');
    // No top-navigation: a framed service can't move the portal page away.
    el.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals');
    el.title = s.name;
    el.src = src;
    $('#frames').appendChild(el);
    f = { el, src, wasUp: true };
    frames.set(s.id, f);
  } else if (f.src !== src || !f.wasUp) {
    // Address changed, or the server came back: load it again.
    f.el.src = src;
    f.src = src;
    f.wasUp = true;
  }
  return f;
}

function renderView() {
  const s = svc(view);
  $('#home').hidden = !!s;
  $('#view').hidden = !s;
  for (const [id, f] of frames) {
    const t = svc(id);
    if (!t) { f.el.remove(); frames.delete(id); continue; }
    if (!isLive(t)) f.wasUp = false;
  }
  if (!s) { for (const f of frames.values()) f.el.hidden = true; return; }

  const r = run(s);
  $('#banner').innerHTML = r?.movedTo ? `<div class="banner"><span style="color:var(--warn)">⚠</span>
    <span>${esc(tr('movedText', { want: portOf(s.url), got: r.movedTo }))}</span>
    <button class="btn btn-primary" type="button" data-act="useMoved">${esc(tr('useActual', { got: r.movedTo }))}</button>
    <button class="btn" type="button" data-act="keepMoved">${esc(tr('keep'))}</button></div>` : '';

  const showFrame = isLive(s) && s.framable;
  for (const [id, f] of frames) f.el.hidden = !(showFrame && id === s.id);
  if (showFrame) ensureFrame(s).el.hidden = false;
  $('#frames').hidden = !showFrame;

  const state = $('#state');
  state.hidden = showFrame;
  if (showFrame) { state.innerHTML = ''; return; }
  let box;
  if (isLive(s)) {
    box = `<h2>${esc(s.name)}</h2><p>${esc(tr('frameBlocked', { name: s.name }))}</p>
      <a class="btn btn-primary" href="${esc(effectiveUrl(s))}" target="_blank" rel="noopener">${esc(tr('openNewTab'))}</a>`;
  } else if (isStarting(s)) {
    box = `<h2>${esc(tr('startingTitle', { name: s.name }))}</h2><p>${esc(tr('startingText', { port: portOf(s.url) }))}</p>
      <pre class="log">${esc(logs.get(s.id) || `> ${s.cmd}`)}</pre>
      <div class="actions" style="justify-content:center"><button class="btn" type="button" data-stop="${s.id}">${esc(tr('stop'))}</button></div>`;
  } else {
    const failed = isFailed(s);
    box = `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--orange)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/></svg>
      <h2>${esc(tr('downTitle', { name: s.name }))}</h2>
      <p>${esc(tr('cannotConnect', { url: s.url }))} ${esc(s.cmd ? tr('downCmd') : tr('downNoCmd'))}</p>
      ${failed ? `<div style="width:100%;display:flex;flex-direction:column;gap:6px;text-align:left">
        <span class="small" style="color:var(--danger)">${esc(tr('failedText', { code: r.exitCode ?? '?' }))}</span>
        <pre class="log">${esc(logs.get(s.id) || '')}</pre></div>` : ''}
      <div class="actions" style="justify-content:center">
        ${canStart(s) ? `<button class="btn btn-primary" type="button" data-start="${s.id}">${esc(tr('startServer'))}</button>` : ''}
        <button class="btn" type="button" data-act="retry">${esc(tr('retry'))}</button>
        <button class="btn" type="button" data-edit="${s.id}">${esc(tr('changeSettings'))}</button>
      </div>`;
  }
  state.innerHTML = `<div class="state-box">${box}</div>`;
}

// ---------- modals ----------
const closeIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function closeModal() {
  modal = null;
  $('#modal').innerHTML = '';
}

function renderList() {
  const f = modal.filter;
  const up = services.filter(isLive).length;
  const listed = services.filter((s) => (f === 'up' ? isLive(s) : f === 'down' ? !isLive(s) : true));
  // The list re-renders on every poll; carry scroll position and expanded commands across.
  const prev = $('#modal .list-body');
  const scroll = prev ? prev.scrollTop : 0;
  const opened = new Set([...document.querySelectorAll('#modal details.cmd[open]')].map((d) => d.dataset.id));
  const tab = (key, label, n) => `<button class="ftab${f === key ? ' on' : ''}" type="button" data-filter="${key}">${esc(label)} ${n}</button>`;
  const body = listed.map((s) => {
    const st = statusOf(s);
    return `<div class="row${view === s.id ? ' cur' : ''}">
      <div class="row-main">
        <div class="row-title"><b>${esc(s.name)}</b><span class="pill ${st.cls}">${esc(st.label)}</span><span class="mono small muted">${esc(s.url)}</span></div>
        <span class="small muted">${esc(s.desc || tr('noDesc'))}</span>
        ${s.folder ? `<details class="cmd mono small muted" data-id="${s.id}"${opened.has(s.id) ? ' open' : ''}><summary>${esc(s.folder)}</summary><pre>${esc(s.cmd)}</pre></details>` : `<span class="small muted">${esc(tr('noFolder'))}</span>`}
      </div>
      <div class="actions">
        ${canStart(s) ? `<button class="btn" type="button" data-start="${s.id}">${esc(tr('run'))}</button>` : ''}
        ${canStop(s) ? `<button class="btn" type="button" data-stop="${s.id}">${esc(tr('stop'))}</button>` : ''}
        <button class="btn btn-primary" type="button" data-open="${s.id}">${esc(tr('open'))}</button>
        <a class="btn" href="${esc(effectiveUrl(s))}" target="_blank" rel="noopener">${esc(tr('newTab'))}</a>
        <button class="icon-btn" type="button" data-edit="${s.id}" aria-label="${esc(tr('edit'))}">${editIcon}</button>
      </div></div>`;
  }).join('');
  $('#modal').innerHTML = `<div class="overlay" data-overlay><section class="dlg list-dlg" role="dialog" aria-modal="true" aria-label="${esc(tr('listTitle'))}">
    <div class="dlg-head"><h2>${esc(tr('listTitle'))}</h2>
      ${tab('all', tr('all'), services.length)}${tab('up', tr('up'), up)}${tab('down', tr('down'), services.length - up)}
      <span class="grow"></span>
      <button class="btn btn-primary" type="button" data-act="add">+ ${esc(tr('register'))}</button>
      <button class="icon-btn" type="button" data-act="close" aria-label="${esc(tr('close'))}">${closeIcon}</button></div>
    <div class="list-body">${body || `<p class="muted" style="text-align:center;margin:24px 0">${esc(tr('noMatch'))}</p>`}</div>
  </section></div>`;
  $('#modal .list-body').scrollTop = scroll;
}

function openList(filter) {
  modal = { type: 'list', filter };
  renderList();
}

// --- add / edit ---
function openEdit(id) {
  const s = id ? svc(id) : null;
  modal = { type: 'edit', id: s ? s.id : null, auto: false, scan: null, guessSeq: 0, cmdSeq: 0 };
  const v = s || { name: '', url: '', folder: '', cmd: '', desc: '' };
  $('#modal').innerHTML = `<div class="overlay" data-overlay><form class="dlg" id="editForm" style="max-width:540px" novalidate>
    <div class="dlg-head"><h2>${esc(tr(s ? 'editTitle' : 'newTitle'))}</h2><span class="grow"></span>
      <button class="icon-btn" type="button" data-act="close" aria-label="${esc(tr('close'))}">${closeIcon}</button></div>
    <div class="dlg-body">
      <label class="field">${esc(tr('fName'))}<input name="name" value="${esc(v.name)}" placeholder="docket-gits" autocomplete="off"></label>
      <label class="field">${esc(tr('fUrl'))}<input name="url" value="${esc(v.url)}" placeholder="http://localhost:3000" autocomplete="off" spellcheck="false"></label>
      <p class="note warn" id="dupNote" hidden></p>
      <label class="field">${esc(tr('fFolder'))}<input name="folder" class="mono" value="${esc(v.folder)}" placeholder="C:\\Users\\me\\workspace\\my-app" autocomplete="off" spellcheck="false"></label>
      <p class="note" id="guessNote" hidden></p>
      <div class="field" id="cmdBox" hidden>
        <label class="field">${esc(tr('fCmd'))}<input name="cmd" class="mono" value="${esc(v.cmd)}" placeholder="npm start" autocomplete="off" spellcheck="false"></label>
        <div class="chips" id="cmdChips"></div>
        <span class="small">${esc(tr('cmdHint'))}</span>
      </div>
      <label class="field">${esc(tr('fDesc'))}<textarea name="desc">${esc(v.desc)}</textarea></label>
      ${s ? '' : `<section class="ports"><span class="small muted" style="font-size:13px">${esc(tr('openPorts'))}</span><div id="scanBox"><p class="small muted" style="margin:0">${esc(tr('scanning'))}</p></div></section>`}
      <p class="note err" id="formErr" hidden style="margin:0"></p>
      <div class="dlg-foot">
        ${s ? `<button class="btn btn-danger" type="button" data-act="delete" style="margin-right:auto">${esc(tr('delete'))}</button>` : ''}
        <button class="btn" type="button" data-act="close">${esc(tr('cancel'))}</button>
        <button class="btn btn-primary" type="submit">${esc(tr(s ? 'save' : 'add'))}</button>
      </div>
    </div></form></div>`;
  const form = $('#editForm');
  form.name.focus();
  updateDup();
  updateCmdBox();
  if (!s) runScan();
}

const field = (n) => $('#editForm')?.elements[n];

function updateDup() {
  const note = $('#dupNote');
  if (!note) return;
  const port = portOf(field('url').value.trim());
  const dups = port && /^https?:\/\//i.test(field('url').value.trim()) ? services.filter((s) => s.id !== modal.id && portOf(s.url) === port) : [];
  note.hidden = !dups.length;
  note.textContent = dups.length ? `⚠ ${tr('dupPort', { name: dups.map((s) => s.name).join(', '), port })}` : '';
}

async function updateCmdBox() {
  const folder = field('folder').value.trim();
  $('#cmdBox').hidden = !folder;
  const seq = ++modal.cmdSeq;
  const chips = $('#cmdChips');
  if (!folder) { chips.innerHTML = ''; return; }
  const { data } = await api(`/api/commands?folder=${encodeURIComponent(folder)}`);
  if (!modal || modal.type !== 'edit' || seq !== modal.cmdSeq) return;
  const cmds = data.commands || [];
  if (!data.exists) {
    chips.innerHTML = `<span class="small" style="color:var(--warn)">${esc(tr('errNoFolder', { folder }))}</span>`;
    return;
  }
  const cur = field('cmd').value.trim();
  chips.innerHTML = cmds.length ? `<span class="small">${esc(tr('pkgCmds'))}</span>${cmds.map((c) => `<button type="button" class="chip${c === cur ? ' on' : ''}" data-cmd="${esc(c)}">${esc(c)}</button>`).join('')}` : '';
}

async function updateGuess() {
  const note = $('#guessNote');
  const url = field('url').value.trim();
  const port = portOf(url);
  const seq = ++modal.guessSeq;
  if (!port || !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(url)) { note.hidden = true; return; }
  note.hidden = false;
  note.className = 'note';
  note.textContent = tr('guessing', { port });
  const { data } = await api(`/api/guess?url=${encodeURIComponent(url)}`);
  if (!modal || modal.type !== 'edit' || seq !== modal.guessSeq) return;
  if (data.off) { note.textContent = tr('guessOff', { port }); return; }
  if (!data.folder) { note.textContent = tr('guessNoCwd', { port, proc: data.proc || '?', pid: data.pid }); return; }
  // Fill only an empty folder, or one this dialog filled in itself.
  if (field('folder').value.trim() && !modal.auto) { note.hidden = true; return; }
  field('folder').value = data.folder;
  field('cmd').value = data.cmd || '';
  modal.auto = true;
  note.className = 'note ok';
  note.textContent = `✓ ${tr('guessFound', { port, proc: data.proc, pid: data.pid })}`;
  updateCmdBox();
}

async function runScan() {
  const { data } = await api('/api/scan');
  if (!modal || modal.type !== 'edit') return;
  modal.scan = data.servers || [];
  const box = $('#scanBox');
  if (!box) return;
  box.innerHTML = modal.scan.length ? `<div style="display:flex;flex-direction:column;gap:6px">${modal.scan.map((d, i) => `
    <button type="button" class="pick" data-pick="${i}">
      <span class="port mono">:${d.port}</span>
      <span class="ttl">${esc(d.title || tr('untitled'))}</span>
      ${d.registered.length ? `<span class="pill muted">${esc(tr('regTag', { name: d.registered.join(', ') }))}</span>` : ''}
      <span class="small muted">${esc(d.proc)}</span>
    </button>`).join('')}</div>` : `<p class="small muted" style="margin:0">${esc(tr('noPorts'))}</p>`;
}

async function saveEdit(e) {
  e.preventDefault();
  const body = { name: field('name').value, url: field('url').value, folder: field('folder').value, cmd: field('cmd').value, desc: field('desc').value };
  const id = modal.id;
  const res = id ? await api(`/api/services/${id}`, { method: 'PUT', body }) : await api('/api/services', { method: 'POST', body });
  if (!res.ok) {
    const err = $('#formErr');
    const key = { name: 'errName', url: 'errUrl', folder: 'errFolder' }[res.data.error];
    err.hidden = false;
    err.textContent = key ? tr(key) : tr('errGeneric', { message: res.data.error || res.status });
    return;
  }
  closeModal();
  await refresh();
}

async function deleteService() {
  const s = svc(modal.id);
  if (!s || !confirm(tr('deleteConfirm', { name: s.name }))) return;
  await api(`/api/services/${s.id}`, { method: 'DELETE' });
  if (view === s.id) view = 'home';
  closeModal();
  await refresh();
}

// --- settings ---
const PREVIEW = {
  light: { bg: '#f6f8fa', panel: '#ffffff', border: '#d0d7de', text: '#1f2328', muted: '#656d76', accent: '#0969da', bar: '#ffffff', barText: '#1f2328', font: 'inherit', sample: 'docket' },
  dark: { bg: '#0d1117', panel: '#161b22', border: '#30363d', text: '#e6edf3', muted: '#8d96a0', accent: '#2f81f7', bar: '#161b22', barText: '#e6edf3', font: 'inherit', sample: 'docket' },
  green: { bg: '#0b1410', panel: '#111d17', border: '#24412f', text: '#d6f2e0', muted: '#8fb39d', accent: '#2bff88', bar: '#0b1410', barText: '#2bff88', font: "'Barlow Condensed', sans-serif", sample: 'DOCKET' },
  g6: { bg: '#e2e2e0', panel: '#f1f1ef', border: '#8a8a88', text: '#1b1b1b', muted: '#4f4f4f', accent: '#1b1b1b', bar: '#1b1b1b', barText: '#f1f1ef', font: "'Fusion Pixel KO', monospace", sample: '[docket]' },
};

function renderSettings() {
  const pane = modal.pane;
  const cur = window.docketTheme.current();
  const cards = [['', 'tSystem', [PREVIEW.light, PREVIEW.dark]], ['light', 'tLight', [PREVIEW.light]], ['dark', 'tDark', [PREVIEW.dark]], ['green', 'tGreen', [PREVIEW.green]], ['g6', 'tPixel', [PREVIEW.g6]]]
    .map(([id, label, parts]) => `<button type="button" class="theme-card${cur === id ? ' on' : ''}" role="radio" aria-checked="${cur === id}" data-theme-pick="${id}">
      <span class="prev" aria-hidden="true">${parts.map((p) => `<span class="prev-part" style="background:${p.bg}">
        <span class="prev-bar" style="background:${p.bar};color:${p.barText};font-family:${p.font};box-shadow:inset 0 -1px 0 ${p.border}">${esc(p.sample)}</span>
        <span class="prev-body"><i style="height:18px;background:${p.panel};box-shadow:inset 0 0 0 1px ${p.border}"></i><i style="height:6px;width:70%;background:${p.text}"></i><i style="height:5px;width:50%;background:${p.muted}"></i><i style="margin-top:auto;height:10px;width:44%;background:${p.accent}"></i></span>
      </span>`).join('')}</span>
      <span style="font-size:13px">${esc(tr(label))}</span></button>`).join('');
  const langs = Object.entries(LANGS).map(([id, label]) => `<button type="button" class="radio${lang === id ? ' on' : ''}" role="radio" aria-checked="${lang === id}" data-lang-pick="${id}"><span class="ring"></span>${esc(label)}</button>`).join('');
  $('#modal').innerHTML = `<div class="overlay" data-overlay><section class="dlg settings-dlg" role="dialog" aria-modal="true" aria-label="${esc(tr('settings'))}">
    <div class="dlg-head"><h2>${esc(tr('settings'))}</h2><span class="grow"></span>
      <button class="icon-btn" type="button" data-act="close" aria-label="${esc(tr('close'))}">${closeIcon}</button></div>
    <div class="settings-body">
      <nav class="snav" aria-label="${esc(tr('settings'))}">
        <button type="button" class="${pane === 'theme' ? 'on' : ''}" data-pane="theme">${esc(tr('theme'))}</button>
        <button type="button" class="${pane === 'lang' ? 'on' : ''}" data-pane="lang">${esc(tr('language'))}</button>
      </nav>
      <div class="spane">${pane === 'theme'
        ? `<h3>${esc(tr('theme'))}</h3><p>${esc(tr('themeHelp'))}</p><div class="theme-grid" role="radiogroup" aria-label="${esc(tr('theme'))}">${cards}</div>`
        : `<h3>${esc(tr('language'))}</h3><p>${esc(tr('langHelp'))}</p><div class="radios" role="radiogroup" aria-label="${esc(tr('language'))}">${langs}</div>`}
      </div>
    </div></section></div>`;
}

function openSettings() {
  modal = { type: 'settings', pane: 'theme' };
  renderSettings();
}

// --- port conflict ---
function openConflict(id, c) {
  const s = svc(id);
  modal = { type: 'conflict', id, c };
  const who = c.kind === 'service' ? tr('whoService', { name: c.name, pid: c.pid }) : tr('whoProc', { proc: c.proc || '?', pid: c.pid });
  $('#modal').innerHTML = `<div class="overlay" data-overlay><section class="dlg" role="alertdialog" aria-modal="true" style="max-width:480px" aria-label="${esc(tr('conflictTitle', { port: c.port }))}">
    <div class="dlg-head"><h2>${esc(tr('conflictTitle', { port: c.port }))}</h2></div>
    <div class="dlg-body">
      <p style="margin:0">${esc(tr('conflictText', { name: s ? s.name : '' }))}</p>
      <pre class="log">${esc(who)}</pre>
      ${c.kind === 'service' ? '' : `<p class="small muted" style="margin:0;font-size:13px">${esc(tr('conflictUnknownHint'))}</p>`}
      <div class="dlg-foot">
        <button class="btn" type="button" data-act="close">${esc(tr('cancel'))}</button>
        ${c.kind === 'service' ? `<button class="btn btn-primary" type="button" data-act="stopAndRun">${esc(tr('stopAndRun', { name: c.name }))}</button>` : ''}
      </div></div></section></div>`;
}

// ---------- actions ----------
async function start(id, opts = {}) {
  const res = await api(`/api/services/${id}/start`, { method: 'POST', body: opts });
  if (res.status === 409) return openConflict(id, res.data.conflict);
  if (!res.ok) {
    const s = svc(id);
    const e = res.data.error;
    toast(e === 'no_folder' ? tr('errNoFolder', { folder: s?.folder || '' }) : e === 'no_command' ? tr('errNoCommand') : tr('errGeneric', { message: res.data.message || e || res.status }));
    return;
  }
  logs.delete(id);
  await refresh();
}

async function stop(id) {
  await api(`/api/services/${id}/stop`, { method: 'POST' });
  await refresh();
}

function openView(id) {
  view = id;
  document.body.classList.remove('hdr-open');
  closeModal();
  render();
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, a, [data-overlay]');
  if (!t) return;
  if (t.matches('[data-overlay]')) { if (e.target === t && modal?.type !== 'edit') closeModal(); return; }
  const d = t.dataset;
  if (t.id === 'fab') {
    if (fabMoved) { fabMoved = false; return; } // end of a drag, not a click
    document.body.classList.toggle('hdr-open');
    return renderHeader();
  }
  if (t.id === 'brand') { view = 'home'; return render(); }
  if (t.id === 'addBtn') return openEdit(null);
  if (t.id === 'settingsBtn') return openSettings();
  if (d.list) return openList(d.list);
  if (d.filter) { modal.filter = d.filter; return renderList(); }
  if (d.open) return openView(d.open);
  if (d.edit) return openEdit(d.edit);
  if (d.start) { if (modal?.type === 'list') closeModal(); return start(d.start); }
  if (d.stop) return stop(d.stop);
  if (d.cmd !== undefined && t.classList.contains('chip')) { field('cmd').value = d.cmd; return updateCmdBox(); }
  if (d.pick !== undefined) {
    const p = modal.scan[Number(d.pick)];
    if (!field('name').value.trim() && p.title) field('name').value = p.title;
    field('url').value = `http://localhost:${p.port}`;
    updateDup();
    return updateGuess();
  }
  if (d.pane) { modal.pane = d.pane; return renderSettings(); }
  if (d.themePick !== undefined) { window.docketTheme.apply(d.themePick); return renderSettings(); }
  if (d.langPick) {
    lang = d.langPick;
    try { localStorage.setItem(LANG_KEY, lang); } catch { /* ignore */ }
    document.documentElement.lang = lang;
    render();
    return renderSettings();
  }
  switch (d.act) {
    case 'close': return closeModal();
    case 'add': return openEdit(null);
    case 'delete': return deleteService();
    case 'reload': { const f = frames.get(view); if (f) f.el.src = f.src; return refresh(); }
    case 'retry': return refresh();
    case 'stopAndRun': { const { id } = modal; closeModal(); return start(id, { stopOwner: true }); }
    case 'useMoved': {
      const s = svc(view);
      const url = movedUrl(s);
      await api(`/api/services/${s.id}`, { method: 'PUT', body: { ...s, url } });
      return refresh();
    }
    case 'keepMoved': await api(`/api/services/${view}/dismiss`, { method: 'POST' }); return refresh();
    default:
  }
});

let typingTimer = 0;
document.addEventListener('input', (e) => {
  if (modal?.type !== 'edit') return;
  const n = e.target.name;
  if (n === 'url') { updateDup(); clearTimeout(typingTimer); typingTimer = setTimeout(updateGuess, 450); }
  if (n === 'folder') { modal.auto = false; clearTimeout(typingTimer); typingTimer = setTimeout(updateCmdBox, 350); }
  if (n === 'cmd') for (const c of document.querySelectorAll('#cmdChips .chip')) c.classList.toggle('on', c.dataset.cmd === e.target.value.trim());
});
document.addEventListener('submit', (e) => { if (e.target.id === 'editForm') saveEdit(e); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (modal) closeModal();
  else if (document.body.classList.contains('hdr-open')) { document.body.classList.remove('hdr-open'); renderHeader(); }
});

// ---------- refresh loop ----------
function render() {
  document.title = svc(view) ? `${svc(view).name} · docket` : 'docket';
  renderHeader();
  renderHome();
  renderView();
  if (modal?.type === 'list') renderList();
}

async function refresh() {
  clearTimeout(pollTimer);
  try {
    const { ok, data } = await api('/api/services');
    if (ok) services = data.services;
    if (view !== 'home' && !svc(view)) view = 'home';
    // Logs for services that are starting or failed (shown in the view).
    await Promise.all(services.filter((s) => isStarting(s) || isFailed(s)).filter((s) => s.id === view).map(async (s) => {
      const r = await api(`/api/services/${s.id}/log?lines=${isFailed(s) ? 20 : 12}`);
      if (r.ok) logs.set(s.id, r.data.log);
    }));
    render();
  } catch { /* the portal server is down; try again */ }
  pollTimer = setTimeout(refresh, services.some(isStarting) ? 1000 : 4000);
}

document.documentElement.lang = lang;
refresh();
