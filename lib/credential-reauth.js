import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
const digest = s => createHash('sha256').update(s).digest('hex');
export const credentialAuthState = user => digest(JSON.stringify([user.id, user.passHash, Boolean(user.totpEnabled), user.totpSecret || null]));
const actions = new Set(['connect', 'disconnect', 'storage-upgrade']);
const active = new Map();
const revoke = key => { const timer = active.get(key); if (!timer) return false; clearTimeout(timer); active.delete(key); return true; };
export function issueCredentialProof(session, user, action, now = Date.now()) {
  if (!actions.has(action) || session.userId !== user.id) throw Error('invalid action');
  revoke(session.credentialProof?.digest);
  if (active.size >= 1000) throw Error('authentication busy');
  const token = randomBytes(32).toString('hex');
  const key = digest(token), timer = setTimeout(() => active.delete(key), 120000); timer.unref(); active.set(key, timer);
  session.credentialProof = { digest: key, owner: user.id, action, authState: credentialAuthState(user), credentialState: digest(JSON.stringify(user.krakenKey || null)), issuedAt: now, expiresAt: now + 120000 };
  return token;
}
export function consumeCredentialProof(session, user, action, token, now = Date.now()) {
  const p = session?.credentialProof;
  if (session) delete session.credentialProof;
  if (!p || !revoke(p.digest)) return false;
  if (!p || !user || !actions.has(action) || session.userId !== user.id || p.owner !== user.id || p.action !== action || now < p.issuedAt || now >= p.expiresAt || p.authState !== credentialAuthState(user) || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
  return p.credentialState === digest(JSON.stringify(user.krakenKey || null)) && timingSafeEqual(Buffer.from(p.digest, 'hex'), Buffer.from(digest(token), 'hex'));
}
