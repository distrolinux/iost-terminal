// lib/auth-routes.js — /api/auth endpoints (register, login, 2FA, reset)
// All routes are rate-limited ~10/min/IP. Session or X-API-Key can be used for /me.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import qrcode from 'qrcode';
import * as auth from './auth.js';
import * as points from './points.js';

// ~10/min/IP across all auth endpoints (override with AUTH_RATE_LIMIT for test suites)
const AUTH_LIMIT = Number.parseInt(process.env.AUTH_RATE_LIMIT || '10', 10) || 10;

export const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: AUTH_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too many auth requests — try again in a minute' },
});

// stricter limiter for credential endpoints (login attempts + reset confirm)
export const credsLimiter = rateLimit({
  windowMs: 60_000,
  limit: AUTH_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too many attempts — try again in a minute' },
});

function sessionUser(req) {
  return req.session?.userId ? auth.findById(req.session.userId) : null;
}

// create a fresh session for `user` (regenerate guards against fixation)
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

const PENDING_TOTP_TTL_MS = 5 * 60 * 1000;
function clearPendingTotp(req) {
  if (req.session?.pendingTotp) delete req.session.pendingTotp;
}
function savePendingTotp(req, user) {
  req.session.pendingTotp = { userId: user.id, expiresAt: Date.now() + PENDING_TOTP_TTL_MS };
  return new Promise((resolve) => req.session.save(() => resolve()));
}

export function authRouter(siteUrl = 'https://iostcallister.com') {
  const r = Router();

  // POST /api/auth/register {email,password,ref?} → 201 + auto-login
  // Optional `ref` = referral code (tokenomics §6): referee +10, referrer +50.
  // Anti-abuse: self-referral blocked, one credit per referee. Unknown code is
  // a no-op — registration always succeeds.
  r.post('/register', async (req, res) => {
    const result = await auth.registerUser(req.body?.email, req.body?.password);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    const logged = await loginSession(req, result.user);
    const signupAward = points.awardSignup(`user:${result.user.id}`);
    let refAward = null;
    const refCode = String(req.body?.ref || '').trim();
    if (refCode) {
      refAward = points.applyReferralCode({ refCode, refereeOwnerId: `user:${result.user.id}` });
    }
    res.status(201).json({ user: auth.toPublic(result.user), session: logged, signupAward, refAward });
  });

  // POST /api/auth/login {email,password}
  r.post('/login', credsLimiter, async (req, res) => {
    const result = await auth.verifyLogin(req.body?.email, req.body?.password);
    if (result.ok) {
      return completeLoginSession(req, res, result.user, { user: auth.toPublic(result.user) });
    }
    if (result.totpRequired) {
      await savePendingTotp(req, result.user);
      return res.json({ totpRequired: true, email: result.user.email });
    }
    clearPendingTotp(req);
    const status = result.status || 401;
    const body = { error: result.error };
    if (result.lockedUntil) body.lockedUntil = result.lockedUntil;
    res.status(status).json(body);
  });

  // POST /api/auth/login/totp {email, totpCode} — verifies TOTP or a backup code
  r.post('/login/totp', credsLimiter, async (req, res) => {
    const pending = req.session?.pendingTotp;
    const user = pending && pending.expiresAt > Date.now() ? auth.findById(pending.userId) : null;
    if (!user || !user.totpEnabled || user.email !== String(req.body?.email || '').trim().toLowerCase()) {
      clearPendingTotp(req);
      return res.status(401).json({ error: 'invalid email or code' });
    }
    const check = auth.checkTotp(user, req.body?.totpCode);
    if (!check.ok) {
      clearPendingTotp(req);
      return res.status(401).json({ error: 'invalid email or code' });
    }
    clearPendingTotp(req);
    return completeLoginSession(req, res, user, { user: auth.toPublic(user), usedBackup: !!check.usedBackup });
  });

  // POST /api/auth/logout
  r.post('/logout', (req, res) => {
    const user = sessionUser(req);
    if (user) auth.untrackSession(user, req.sessionID);
    req.session.destroy(() => res.json({ ok: true }));
  });

  // GET /api/auth/me — session user OR agent key
  r.get('/me', (req, res) => {
    const user = sessionUser(req);
    if (user) return res.json({ user: auth.toPublic(user) });
    // agent key: caller already holds the key — never echo it back
    if (req.agentKey || req.userAgent) return res.json({ agent: true });
    res.status(401).json({ error: 'auth required' });
  });

  // ---- 2FA (session user required) ----
  function requireSessionUser(req, res) {
    const user = sessionUser(req);
    if (!user) { res.status(401).json({ error: 'auth required' }); return null; }
    return user;
  }

  // POST /api/auth/2fa/enable → {secret, otpauthUrl, qrDataUrl}
  r.post('/2fa/enable', async (req, res) => {
    const user = requireSessionUser(req, res);
    if (!user) return;
    if (user.totpEnabled) return res.status(400).json({ error: '2FA is already enabled' });
    const { secret, otpauthUrl } = auth.startTotpSetup(user);
    const qrDataUrl = await qrcode.toDataURL(otpauthUrl);
    res.json({ secret, otpauthUrl, qrDataUrl });
  });

  // POST /api/auth/2fa/confirm {totpCode} → {ok, backupCodes (shown once)}
  r.post('/2fa/confirm', (req, res) => {
    const user = requireSessionUser(req, res);
    if (!user) return;
    const result = auth.confirmTotp(user, req.body?.totpCode);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true, backupCodes: result.backupCodes });
  });

  // POST /api/auth/2fa/disable {totpCode}
  r.post('/2fa/disable', (req, res) => {
    const user = requireSessionUser(req, res);
    if (!user) return;
    const result = auth.disableTotp(user, req.body?.totpCode);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
  });

  // ---- password reset ----
  // POST /api/auth/reset/request {email} — always 200 (no user enumeration)
  r.post('/reset/request', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const user = auth.findByEmail(email);
    if (user) {
      const token = auth.createResetToken(user);
      await auth.sendResetEmail(user.email, token, String(siteUrl).replace(/^https?:\/\//, ''));
    }
    res.json({ message: 'if that email exists, a reset link was sent' });
  });

  // GET /api/auth/reset/validate?token=
  r.get('/reset/validate', (req, res) => {
    const found = auth.validateResetToken(req.query.token);
    if (!found) return res.status(400).json({ valid: false });
    res.json({ valid: true });
  });

  // POST /api/auth/reset/confirm {token, password} — destroys the user's sessions
  r.post('/reset/confirm', credsLimiter, async (req, res) => {
    const result = await auth.consumeResetToken(req.body?.token, req.body?.password);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    // destroy every tracked session for this user (forces re-login with new password)
    for (const sid of result.sessionIds) {
      req.sessionStore.destroy(sid, () => {});
    }
    res.json({ ok: true });
  });

  return r;
}
