// Registered services (data/services.json) and the processes the portal started (data/state.json).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Checks and normalizes a service sent by the UI. Returns { value } or { error }. */
export function validateService(input) {
  const name = String(input?.name ?? '').trim();
  const url = String(input?.url ?? '').trim();
  const desc = String(input?.desc ?? '').trim();
  const folder = String(input?.folder ?? '').trim();
  const cmd = folder ? String(input?.cmd ?? '').trim() : '';
  if (!name) return { error: 'name' };
  let parsed;
  try { parsed = new URL(url); } catch { return { error: 'url' }; }
  if (!/^https?:$/.test(parsed.protocol)) return { error: 'url' };
  if (folder && !path.isAbsolute(folder)) return { error: 'folder' };
  // Keep the address as typed (localhost vs 127.0.0.1 matters to some apps), minus a trailing "/".
  return { value: { name, url: url.replace(/\/$/, ''), desc, folder, cmd } };
}

export function portOf(url) {
  try {
    const u = new URL(url);
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch { return null; }
}

export class Store {
  constructor(dataDir) {
    this.servicesFile = path.join(dataDir, 'services.json');
    this.stateFile = path.join(dataDir, 'state.json');
    this.services = readJson(this.servicesFile, { services: [] }).services || [];
    this.runs = readJson(this.stateFile, { runs: {} }).runs || {};
  }

  list() { return this.services; }
  get(id) { return this.services.find((s) => s.id === id) || null; }

  add(value) {
    const s = { id: crypto.randomBytes(6).toString('hex'), ...value, createdAt: new Date().toISOString() };
    this.services.push(s);
    this.saveServices();
    return s;
  }

  update(id, value) {
    const s = this.get(id);
    if (!s) return null;
    Object.assign(s, value);
    this.saveServices();
    return s;
  }

  remove(id) {
    const before = this.services.length;
    this.services = this.services.filter((s) => s.id !== id);
    if (this.services.length === before) return false;
    this.saveServices();
    return true;
  }

  getRun(id) { return this.runs[id] || null; }
  setRun(id, run) {
    if (run) this.runs[id] = run; else delete this.runs[id];
    writeJson(this.stateFile, { runs: this.runs });
  }

  saveServices() { writeJson(this.servicesFile, { services: this.services }); }
}
