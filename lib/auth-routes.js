// lib/auth-routes.js — /api/auth endpoints (register, login, 2FA, reset)
// All routes are rate-limited ~10/min/IP. Session or X-API-Key can be used for /me.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import qrcode from 'qrcode';
import * as auth from './auth.js';
import * as points from './points.js';

const AUTH_LIMIT = Number.parseInt(process.env.AUTH_RATE_LIMIT || '10', 10) || 10;

export const authLimiter = rateLimit({
  windowMs: 60_000, limit: AUTH_LIMIT, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'too many auth requests — try again in a minute' },
});
export const credsLimiter = rateLimit({
  windowMs: 60_000, limit: AUTH_LIMIT, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'too many attempts — try again in a minute' },
});

function sessionUser(req) { return req.session?.userId ? auth.findById(req.session.userId) : null; }

// Browser CSRF defense: reject explicitly cross-site state changes and Origin
// mismatches. Requests without browser provenance headers remain usable by CLI/
// native clients; SameSite=Lax remains a second browser-side boundary.
export function sameOriginMutation(siteUrl) {
  const allowed = new URL(siteUrl).origin;
  return (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
    if (fetchSite === 'cross-site') return res.status(403).json({ error: 'cross-site request blocked' });
    const origin = req.get('origin');
    if (origin) {
      let actual;
      try { actual = new URL(origin).origin; } catch { return res.status(403).json({ error: 'invalid request origin' }); }
      if (actual !== allowed) return res.status(403).json({ error: 'request origin not allowed' });
    }
    next();
  };
}

function loginSession(req, user) {
  return new Promise((resolve) => {
    req.session.regenerate((err) => {
      if (err) return resolve(false);
      req.session.userId = user.id;
      auth.trackSession(user, req.sessionID);
      resolve(true);
    });
  });
}
export async function completeLoginSession(req, res, user, successBody) {
  const logged = await loginSession(req, user);
  if (!logged) return res.status(503).json({ error: 'sign-in temporarily unavailable' });
  return res.json(successBody);
}
export async function completeRegistrationSession(req, res, user, successBody) {
  const logged = await loginSession(req, user);
  if (!logged) {
    return res.status(503).json({
      error: 'Account created, but automatic sign-in is temporarily unavailable',
      accountCreated: true,
    });
  }
  return res.status(201).json({ ...successBody, session: true });
}

const PENDING_TOTP_TTL_MS = 5 * 60 * 1000;
function clearPendingTotp(req) { if (req.session?.pendingTotp) delete req.session.pendingTotp; }
export function savePendingTotp(req, user) {
  req.session.pendingTotp = { userId: user.id, expiresAt: Date.now() + PENDING_TOTP_TTL_MS };
  return new Promise((resolve) => req.session.save((err) => resolve(!err)));
}

export function authRouter(siteUrl = 'https://iostcallister.com') {
  const r = Router();
  r.use(sameOriginMutation(siteUrl));

  r.post('/register', async (req, res) => {
    const result = await auth.registerUser(req.body?.email, req.body?.password);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    const signupAward = points.awardSignup(`user:${result.user.id}`);
    let refAward = null;
    const refCode = String(req.body?.ref || '').trim();
    if (refCode) refAward = points.applyReferralCode({ refCode, refereeOwnerId: `user:${result.user.id}` });
    return completeRegistrationSession(req, res, result.user, {
      user: auth.toPublic(result.user), signupAward, refAward,
    });
  });

  r.post('/login', credsLimiter, async (req, res) => {
    const result = await auth.verifyLogin(req.body?.email, req.body?.password);
    if (result.ok) return completeLoginSession(req, res, result.user, { user: auth.toPublic(result.user) });
    if (result.totpRequired) {
      const saved = await savePendingTotp(req, result.user);
      if (!saved) {
        clearPendingTotp(req);
        return res.status(503).json({ error: 'sign-in temporarily unavailable' });
      }
      return res.json({ totpRequired: true, email: result.user.email });
    }
    clearPendingTotp(req);
    const body = { error: result.error };
    if (result.lockedUntil) body.lockedUntil = result.lockedUntil;
    res.status(result.status || 401).json(body);
  });

  r.post('/login/totp', credsLimiter, async (req, res) => {
    const pending = req.session?.pendingTotp;
    const user = pending && pending.expiresAt > Date.now() ? auth.findById(pending.userId) : null;
    if (!user || !user.totpEnabled || user.email !== String(req.body?.email || '').trim().toLowerCase()) {
      clearPendingTotp(req); return res.status(401).json({ error: 'invalid email or code' });
    }
    const check = auth.checkTotp(user, req.body?.totpCode);
    if (!check.ok) { clearPendingTotp(req); return res.status(401).json({ error: 'invalid email or code' }); }
    clearPendingTotp(req);
    return completeLoginSession(req, res, user, { user: auth.toPublic(user), usedBackup: !!check.usedBackup });
  });

  r.post('/logout', (req, res) => {
    const user = sessionUser(req);
    const sessionId = req.sessionID;
    req.session.destroy((err) => {
      if (err) return res.status(503).json({ error: 'sign-out temporarily unavailable' });
      if (user) auth.untrackSession(user, sessionId);
      return res.json({ ok: true });
    });
  });

  r.get('/me', (req, res) => {
    const user = sessionUser(req);
    if (user) return res.json({ user: auth.toPublic(user) });
    if (req.agentKey || req.userAgent) return res.json({ agent: true });
    res.status(401).json({ error: 'auth required' });
  });

  function requireSessionUser(req, res) {
    const user = sessionUser(req);
    if (!user) { res.status(401).json({ error: 'auth required' }); return null; }
    return user;
  }

  r.post('/2fa/enable', async (req, res) => {
    const user = requireSessionUser(req, res); if (!user) return;
    if (user.totpEnabled) return res.status(400).json({ error: '2FA is already enabled' });
    const { secret, otpauthUrl } = auth.startTotpSetup(user);
    res.json({ secret, otpauthUrl, qrDataUrl: await qrcode.toDataURL(otpauthUrl) });
  });
  r.post('/2fa/confirm', (req, res) => {
    const user = requireSessionUser(req, res); if (!user) return;
    const result = auth.confirmTotp(user, req.body?.totpCode);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true, backupCodes: result.backupCodes });
  });
  r.post('/2fa/disable', (req, res) => {
    const user = requireSessionUser(req, res); if (!user) return;
    const result = auth.disableTotp(user, req.body?.totpCode);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
  });

  r.post('/reset/request', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const user = auth.findByEmail(email);
    if (user) {
      const token = auth.createResetToken(user);
      await auth.sendResetEmail(user.email, token, String(siteUrl).replace(/^https?:\/\//, ''));
    }
    res.json({ message: 'if that email exists, a reset link was sent' });
  });
  r.get('/reset/validate', (req, res) => {
    const found = auth.validateResetToken(req.query.token);
    if (!found) return res.status(400).json({ valid: false });
    res.json({ valid: true });
  });
  r.post('/reset/confirm', credsLimiter, async (req, res) => {
    const result = await auth.consumeResetToken(req.body?.token, req.body?.password);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    for (const sid of result.sessionIds) req.sessionStore.destroy(sid, () => {});
    res.json({ ok: true });
  });

  return r;
}
