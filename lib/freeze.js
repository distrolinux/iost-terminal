// lib/freeze.js — Phase 2 emergency freeze (one-tap stop for ALL agent ops)
// Checked by lib/limits.js before every execution. Store: data/freeze.json.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.IOST_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA_DIR, 'freeze.json');

function load() {
  try {
    if (existsSync(FILE)) {
      const p = JSON.parse(readFileSync(FILE, 'utf8'));
      if (p && typeof p.frozen === 'boolean') return p;
    }
  } catch { /* corrupt → unfrozen */ }
  return { frozen: false, reason: null, ts: null, by: null };
}

export function isFrozen() {
  return load().frozen === true;
}

export function freezeState() {
  return load();
}

export function setFrozen(frozen, { reason = '', by = '' } = {}) {
  const state = { frozen: !!frozen, reason: frozen ? String(reason).slice(0, 300) : null, ts: frozen ? Date.now() : null, by: frozen ? by : null };
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, FILE);
  chmodSync(FILE, 0o600);
  return state;
}
