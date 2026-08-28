// lib/session-store.js — dependency-free file-backed session store.
// express-session's MemoryStore wipes every login on restart; this one
// survives container restarts (customers stay signed in up to the cookie
// maxAge). Atomic writes, debounced flush, 0600 perms.
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, chmodSync } from 'node:fs';
import session from 'express-session';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { Store } = session;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.IOST_DATA_DIR || join(ROOT, 'data');
const FILE = join(DATA_DIR, 'sessions.json');

let sessions = load();
let dirty = false;
let timer = null;

function load() {
  try {
    if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch { /* corrupt -> fresh */ }
  return {};
}

function flush() {
  if (!dirty) return;
  dirty = false;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(sessions), { mode: 0o600 });
    renameSync(tmp, FILE);
    chmodSync(FILE, 0o600);
  } catch { /* sessions must never crash the app */ }
}

function scheduleFlush() {
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(flush, 500);
}

export class FileSessionStore extends Store {
  get(sid, cb) { try { cb(null, sessions[sid] || null); } catch (e) { cb(e); } }
  set(sid, sess, cb) { sessions[sid] = sess; scheduleFlush(); cb && cb(null); }
  destroy(sid, cb) { delete sessions[sid]; scheduleFlush(); cb && cb(null); }
  touch(sid, sess, cb) { if (sessions[sid]) { sessions[sid] = sess; scheduleFlush(); } cb && cb(null); }
  length(cb) { cb(null, Object.keys(sessions).length); }
  clear(cb) { sessions = {}; scheduleFlush(); cb && cb(null); }
}
