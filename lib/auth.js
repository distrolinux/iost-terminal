// lib/auth.js — IOST Terminal auth engine
// Users store (JSON-file persistence, atomic writes), bcrypt password hashing,
// TOTP 2FA (otplib v13), hashed backup codes, single-use password-reset tokens,
// session tracking (for "reset destroys all sessions") and SMTP mailer.
// No plaintext passwords / TOTP secrets are ever logged.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { generateSecret, generateURI, generateSync, verifySync } from 'otplib';
import nodemailer from 'nodemailer';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const FILE = join(DATA_DIR, 'users.json');

const BCRYPT_COST = 12;
const MAX_FAILED_LOGINS = 10;          // lockout threshold
const LOCK_MS = 15 * 60 * 1000;        // 15 minute lockout
const RESET_TTL_MS = 45 * 60 * 1000;   // reset token expiry
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD = 8;

// ---------------- store (atomic writes: tmp + rename) ----------------
let users = load();

function load() {
  try {
    if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch { /* corrupt -> start empty */ }
  return [];
}

function persist() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(users, null, 2));
  renameSync(tmp, FILE);
}

/** Force a users.json persist (used by modules mutating user records, e.g. keys). */
export function persistUsers() { persist(); }

const id = () => crypto.randomBytes(12).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------------- public shape ----------------
export function toPublic(u) {
  return { id: u.id, email: u.email, totpEnabled: !!u.totpEnabled, createdAt: u.createdAt };
}

// ---------------- users ----------------
export function findByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return users.find(u => u.email === e) || null;
}
export function findById(uid) { return users.find(u => u.id === uid) || null; }

function createUser(email, passHash) {
  const user = {
    id: id(),
    email, passHash,
    totpSecret: null, totpPending: null, totpEnabled: false,
    backupCodes: [],            // [{ codeHash, used }]
    failedLogins: 0, lockedUntil: null,
    resetTokens: [],            // [{ hash, exp, used }]
    sessionIds: [],             // express-session ids, for "reset → destroy all sessions"
    createdAt: Date.now(),
  };
  users.push(user);
  persist();
  return user;
}

export async function registerUser(emailRaw, password) {
  const email = String(emailRaw || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, status: 400, error: 'valid email required' };
  if (typeof password !== 'string' || password.length < MIN_PASSWORD)
    return { ok: false, status: 400, error: `password must be at least ${MIN_PASSWORD} characters` };
  if (findByEmail(email)) return { ok: false, status: 409, error: 'email already registered' };
  const passHash = await bcrypt.hash(password, BCRYPT_COST);
  const user = createUser(email, passHash);
  return { ok: true, user };
}

// Returns { ok:true, user } | { ok:false, totpRequired:true, user } | { ok:false, status, error }
export async function verifyLogin(emailRaw, password) {
  const email = String(emailRaw || '').trim().toLowerCase();
  const user = findByEmail(email);
  if (!user) return { ok: false, status: 401, error: 'invalid email or password' }; // generic
  if (user.lockedUntil && user.lockedUntil > Date.now())
    return { ok: false, status: 423, error: 'account temporarily locked', lockedUntil: user.lockedUntil };
  const match = await bcrypt.compare(String(password || ''), user.passHash);
  if (!match) {
    user.failedLogins = (user.failedLogins || 0) + 1;
    if (user.failedLogins >= MAX_FAILED_LOGINS) {
      user.lockedUntil = Date.now() + LOCK_MS;
      user.failedLogins = 0;
      persist();
      return { ok: false, status: 401, error: 'invalid email or password' };
    }
    persist();
    return { ok: false, status: 401, error: 'invalid email or password' };
  }
  user.failedLogins = 0;
  user.lockedUntil = null;
  persist();
  if (user.totpEnabled) return { ok: false, totpRequired: true, user };
  return { ok: true, user };
}

export async function setPassword(user, password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD)
    return { ok: false, error: `password must be at least ${MIN_PASSWORD} characters` };
  user.passHash = await bcrypt.hash(password, BCRYPT_COST);
  user.failedLogins = 0;
  user.lockedUntil = null;
  persist();
  return { ok: true };
}

// ---------------- TOTP 2FA ----------------
export function startTotpSetup(user) {
  const secret = generateSecret();
  user.totpPending = secret; // stored only after confirm
  persist();
  const otpauthUrl = generateURI({ issuer: 'IOST Terminal', label: user.email, secret });
  return { secret, otpauthUrl };
}

export function confirmTotp(user, codeRaw) {
  const secret = user.totpPending;
  if (!secret) return { ok: false, error: 'no pending 2FA setup — call enable first' };
  const code = String(codeRaw || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code) || !verifySync({ token: code, secret, window: 1 }).valid)
    return { ok: false, error: 'invalid code' };
  user.totpSecret = secret;
  user.totpEnabled = true;
  user.totpPending = null;
  const backupCodes = generateBackupCodes(user);
  persist();
  return { ok: true, backupCodes };
}

export function disableTotp(user, codeRaw) {
  const code = String(codeRaw || '').replace(/\s+/g, '');
  const okCode = user.totpSecret && /^\d{6}$/.test(code) && verifySync({ token: code, secret: user.totpSecret, window: 1 }).valid;
  const okBackup = !okCode && consumeBackupCode(user, code);
  if (!okCode && !okBackup) return { ok: false, error: 'invalid code' };
  user.totpEnabled = false;
  user.totpSecret = null;
  user.totpPending = null;
  user.backupCodes = [];
  persist();
  return { ok: true };
}

export function checkTotp(user, codeRaw) {
  const code = String(codeRaw || '').replace(/\s+/g, '');
  if (!user.totpSecret) return { ok: false };
  // 6-digit codes → TOTP; anything else (e.g. XXXX-XXXX-XXXX) → backup codes
  if (/^\d{6}$/.test(code) && verifySync({ token: code, secret: user.totpSecret, window: 1 }).valid) return { ok: true };
  if (consumeBackupCode(user, code)) return { ok: true, usedBackup: true };
  return { ok: false };
}

// 10 codes of form XXXX-XXXX-XXXX, only SHA-256 hashes stored
function generateBackupCodes(user) {
  const plain = [];
  const hashes = [];
  for (let i = 0; i < 10; i++) {
    const raw = crypto.randomBytes(6).toString('hex').toUpperCase();
    const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
    plain.push(code);
    hashes.push({ codeHash: sha256(code.replace(/-/g, '')), used: false });
  }
  user.backupCodes = hashes;
  return plain;
}

function consumeBackupCode(user, codeRaw) {
  const norm = String(codeRaw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const hit = user.backupCodes.find(b => !b.used && b.codeHash === sha256(norm));
  if (!hit) return false;
  hit.used = true;
  persist();
  return true;
}

// ---------------- password reset tokens ----------------
// Plaintext token (randomBytes 32 hex) is shown once / emailed; only its hash is stored.
export function createResetToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  user.resetTokens = user.resetTokens || [];
  user.resetTokens.push({ hash: sha256(token), exp: Date.now() + RESET_TTL_MS, used: false });
  user.resetTokens = user.resetTokens.slice(-5); // keep last 5
  persist();
  return token;
}

export function validateResetToken(token) {
  if (!token) return null;
  const hash = sha256(token);
  const user = users.find(u => (u.resetTokens || []).some(t => t.hash === hash));
  if (!user) return null;
  const entry = user.resetTokens.find(t => t.hash === hash);
  if (entry.used || entry.exp < Date.now()) return null;
  return { user, entry };
}

export async function consumeResetToken(token, password) {
  const found = validateResetToken(token);
  if (!found) return { ok: false, status: 400, error: 'invalid or expired reset token' };
  const { user, entry } = found;
  const set = await setPassword(user, password);
  if (!set.ok) return { ok: false, status: 400, error: set.error };
  entry.used = true;
  const sids = [...user.sessionIds];
  user.sessionIds = [];
  persist();
  return { ok: true, user, sessionIds: sids };
}

// ---------------- session tracking ----------------
export function trackSession(user, sid) {
  if (!user || !sid) return;
  if (!user.sessionIds) user.sessionIds = [];
  if (!user.sessionIds.includes(sid)) {
    user.sessionIds.push(sid);
    user.sessionIds = user.sessionIds.slice(-20);
    persist();
  }
}
export function untrackSession(user, sid) {
  if (!user || !user.sessionIds) return;
  user.sessionIds = user.sessionIds.filter(s => s !== sid);
  persist();
}

// ---------------- mailer ----------------
// SMTP_USER / SMTP_PASS from .env (Gmail app password, smtp.gmail.com:465).
// If unset: dev/test mode — log the token to console so the flow stays testable.
export function sendResetEmail(email, token, host) {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const base = host ? `https://${host}` : 'http://localhost:8787';
  const link = `${base}/app#reset?token=${token}`;
  if (!user || !pass) {
    const devConsole = process.env.NODE_ENV !== 'production' && process.env.AUTH_DEV_RESET_LOG === '1';
    if (devConsole) {
      console.log(`[mail] development reset token: ${token}`);
      return { sent: false, mode: 'console' };
    }
    return { sent: false, mode: 'disabled' };
  }
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user, pass },
  });
  return transport.sendMail({
    from: `"IOST Terminal" <${user}>`,
    to: email,
    subject: 'IOST Terminal — reset your password',
    text: `A password reset was requested for ${email}.\n\nOpen this link within 45 minutes (single use):\n${link}\n\nIf you did not request this, ignore this email.`,
  }).then(() => ({ sent: true, mode: 'smtp' }))
    .catch((e) => {
      console.error(`[mail] send failed: ${e.message}`);
      return { sent: false, mode: 'error', error: e.message };
    });
}
