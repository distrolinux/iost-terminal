# IOST Terminal — Security & Code-Quality Review

Date: 2026-08-20 · Reviewer: DeepSeek v4-pro (isolated, read-only) · Mode: codebase + live-site, passive checks only

## 1. Executive summary

Sound for its intended deployment scale (single-instance, paper-first, low-traffic, owner-allowlisted live lane). The auth/session/key-custody and Solidity layers are genuinely well-built, free trading is enforced in code (not just UI-stripped), and the XSS discipline is clean. Two High findings sit on the machine/agent and live-venue paths rather than the core human flows: the raw platform agent key leaks through the public audit endpoint, and per-user Kraken key connection is broken by a parameter-name mismatch (customer self-custody trading silently non-functional). Both are latent or functional rather than immediately exploitable theft, but both should be fixed before scale or real-money launch.

## 2. Findings

| Sev | file:line | Issue | Recommendation |
|---|---|---|---|
| High | server.js:228 + 2354 | Raw platform agent key persisted to `data/agent-audit.jsonl` (`agentId: agent:${req.agentKey}`) and served verbatim by the **unauthenticated** `GET /api/audit`. The sha256-hash fix in `signalIdentity()` (line 2111) was never applied to the audit logger. Blast radius: a platform key has full agent access to the shared `default` paper account + signal publishing. Dormant today (AGENT_KEYS commented out in `.env`) but activates the moment a platform key is configured. | Use `signalIdentity(req).agentId` (hashed) in the audit entry; gate `/api/audit` behind `requireUser` + owner, or scope results to the caller's own agentId. |
| High | server.js:1723 vs lib/broker/kraken.js:64,68 | `PUT /api/account/kraken` passes `{ apiKey, apiSecret }`, but `createKrakenBroker` destructures `{ apiKey: keyOverride, secret: secretOverride }` — it reads `secret`, never `apiSecret`. The user's secret is silently dropped and `process.env.KRAKEN_API_SECRET` (platform secret) is substituted → HMAC mismatch → Kraken rejects every user key → **customers cannot connect their own keys** (the v3 self-custody live lane is non-functional). | Fix the destructure (accept `apiSecret`); add an end-to-end test that connects a mock key. |
| Medium | server.js:1492-1504 | `/api/stake/unstake` and `/api/stake/withdraw` call the mutating `stakes.requestUnstake()/withdraw()` (which `save()`) **before** checking `s.ownerId !== ident.agentId`. A caller who knows a foreign `stakeId` can start a victim's 7-day cooldown, then (after cooldown) mark their stake `withdrawn` — cross-tenant mutation of the trust-stake ledger. | Fetch the stake, verify ownership, then mutate. |
| Medium | lib/paper.js:111,115-123,176 | Paper `openTrade`/`closeTrade` accept raw client values with no type/range validation: a non-numeric `size` yields `notional = NaN` and poisons the account (`cash -= NaN`, recoverable only by reset); arbitrary `entry`/`exitPrice` let a user fabricate any P&L, gaming the public leaderboard, agent win-rates, and the weekly +500 bounty. | Coerce+validate `size`/`entry`/`exitPrice` as finite positive numbers; prefer market-only fills for leaderboard integrity. |
| Medium | server.js:1794-1796 (+ rails.js:45) | The `maxDailyLoss` kill-switch computes `todayPnlUsd` from `st.journal.filter(j => j.live …)`, but live fills are never journaled with `live:true` (they go to `live-audit.jsonl`). `todayPnlUsd` is always 0 → the daily-loss halt never fires. | Journal live fills with `live:true`, or derive daily P&L from the venue/audit. |
| Medium | lib/rails.js:29-33 | The `maxOrderUsd` notional cap applies only `if (price)`; market orders (`entry` omitted) skip it, leaving live market-order `size` unbounded (limited only by the account's own balance). | Fetch a last-price quote for market orders and apply the notional cap. |
| Low | server.js:1520-1523 | `/api/slashes/:id/appeal` has no ownership check — any authenticated principal can file/overwrite an appeal on any open slash. | Verify the caller is the slash owner. |
| Low | lib/points.js:187-195 | `awardFeedback` does not block `signalOwnerId === raterId`; an author can rate their own signal for +5 points. Off-chain, low value (conversion gate closed). | Reject self-rating. |
| Low | live response header | `X-Powered-By: Express` exposed — framework fingerprinting. | `app.disable('x-powered-by')`. |
| Info | data/*.json (perms 644) | `users.json` (bcrypt hashes + plaintext TOTP secrets + AES-GCM Kraken blobs), `agent-keys.json` (SHA-256 key hashes), `accounts.json` are world-readable in-container. Not served publicly (outside `public/`, gitignored), but tighten for defense-in-depth. | `chmod 600 users.json agent-keys.json accounts.json`. |
| Info | lib/agent-keys.js:105 | `verifySecret` compares `k.hash !== sha256(secret)` non-constant-time. Negligible (256-bit random secrets). | Constant-time compare if convenient. |
| Info | lib/auth-routes.js:99 | `GET /api/auth/me` echoes the raw platform key back to its holder (self-referential; caller already has it). | Return `{agent:true}` without the key. |
| Info | all JSON stores | Shared fixed `${FILE}.tmp` tmp+rename under concurrency → possible lost-update/corruption; `agentKeys.touch()` (server.js:148) rewrites `agent-keys.json` on every per-user-key request. Low-traffic single-instance today. | Unique tmp names / debounced write / skip touch persist when unchanged. |

## 3. Secrets handling note (no values disclosed)

- **Storage:** `.env`, `.agent-live-key`, `contracts/.env` are gitignored and `600`. Platform secrets (KRAKEN_API_KEY/SECRET, SESSION_SECRET, LIVE rails) live in `.env` (real env vars win). Per-user Kraken credentials are AES-256-GCM encrypted on the user record, key derived from the session secret (`data/session-secret`, `600`) — at-rest encryption is defense-in-depth, since ciphertext and key material are readable by the same container user. Per-user agent keys (`itk_…`) are stored SHA-256-hash-only, shown once. TOTP secrets are plaintext server-side (required for verification); backup codes and reset tokens are hash-only.
- **Transport:** HTTPS only (HSTS, `secure:'auto'` cookie). No secret over plaintext.
- **Logging:** append-only agent audit stores payload **hashes**, never raw bodies/keys/emails/passwords; live audit masks keys. **Exception:** the agent audit `agentId` field stores the raw platform key (Finding #1).

## 4. Top 3 recommendations (ranked)

1. Fix the audit-log raw-key leak and gate `/api/audit` (hash the agentId; owner-only read).
2. Fix the `createKrakenBroker` parameter mismatch so per-user Kraken keys actually connect (accept `apiSecret`).
3. Enforce ownership *before* mutating in `/api/stake/unstake|withdraw`, and add type/range validation on `openTrade`/`closeTrade` (size/entry/exitPrice) to stop NaN account corruption and P&L fabrication.

## 5. Explicitly checked and found clean

- **Auth/session:** bcrypt cost 12; `session.regenerate` on login (anti-fixation); login lockout (10 fails → 15 min) + generic error messages (no user enumeration); TOTP + hashed backup codes; reset tokens hashed, single-use, 45-min TTL, "always 200" reset-request; cookie `httpOnly` + `sameSite=lax` + `secure:'auto'` + 4h. No Host-header reset-link poisoning (`SITE_URL` is a hardcoded constant, not `req.get('host')`).
- **Agent keys:** hash-only storage, scopes enforced in route handlers (`trade-paper`/`trade-live` checks), `trade-live` creation is owner-only, fail-closed (no default key), instant revocation.
- **Free trading enforced in code:** `canTrade()` → `{ok:true}`, `burnCredits()` → `{burn:0}`, `fee-config.json` `burnRate 0 / minCreditsToTrade 0 / wallet {}` — not just UI-stripped.
- **Injection/path traversal:** JSON-file stores only (no SQL/NoSQL); no `exec`/`eval`/`spawn` on user input; static files via `express.static` + fixed filenames; `/whitepaper` serves a fixed filename. None found.
- **XSS:** `esc()` (escapes `& < > " '`) is applied to every untrusted value in `innerHTML` sinks — agent names, signal `content`/`reason`, XAI trail steps. CSP `frame-ancestors 'none'` + `X-Frame-Options: DENY` + `nosniff`. No hardcoded `sk-`/`privateKey`/API keys in frontend or server code (scanned). No credentials in `localStorage` (only a gate-dismiss flag).
- **Ownership gates:** `walletOwnedBy` on all `/api/spend/*` + wallet usage routes; `isOwnerSession` on admin/autopilot/freeze/slash-decide/pact-decide/bounty; per-route ownership on wallet fund/policies/suspend/reactivate.
- **Smart contracts (static):** AITT — no reentrancy vector (pure `_update`/`super._update`), 3% AMM-pair-only swap tax with 200M burn cap / 800M floor / 70-30 post-cap redirect, integer math verified to conserve value, zero-address guards. PointsConverter — checks-effects-interactions, `nonReentrant`, `totalOutstanding ≤ reserve` invariant, `CannotReduceApproval` underflow guard, owner-only reserve withdrawal that can't go below outstanding. AITTVesting — immutable schedule, `nonReentrant` release, guarded sweep.
- **Rate limiting:** auth 10/min/IP, public 60/min/IP, oauth 20/min, site-wide 600/min with standard `RateLimit-*` headers. (`/mcp` and `/api/events` SSE rely on the site-wide limiter only — noted, acceptable at current scale.)
- **Live rail structure present** (order cap / position cap / cash buffer) — two of its rails have the gaps in Findings 5 & 6.

## 6. Review meta

- **Files touched:** 1 written — this report. No application files modified.
- **Mode:** read-only (code reads via read_file/search_files; live site via `curl -sI` + `curl -s` GET only; `node --check` syntax verification; no fuzzing, no brute-force, no chain interaction).
- **Git state:** working tree clean on `main` (HEAD 15dce68). Reviewed what RUNS (production = host docker container `iost-terminal`; local code identical to committed HEAD).
- **Budget:** ~40 tool calls (skill-allocated pattern); all High/Critical claims re-verified against raw source before reporting.
