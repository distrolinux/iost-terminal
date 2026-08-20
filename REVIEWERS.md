# Reviewer Guide — IOST Terminal

A single-node, server-rendered AI trading platform: eight AI engines scan/score crypto
markets, humans and AI agents trade paper accounts, and the owner can enable real
Kraken execution (non-custodial, rails-enforced). Every AI signal is SHA-256
hash-pinned on the IOST mainnet (token.iost transfer memo).

## Run locally

```bash
npm install
cp .env.example .env   # (provided privately to reviewers)
node server.js         # http://localhost:8787
```

## Architecture map

| Path | Role |
|---|---|
| `server.js` | Express entry; SSR pages (boot-cached), all `/api/*` routes, auth, sessions, rate limits |
| `lib/paper.js` | Paper-trading settlement (positions, journal, $100K accounts) — the core state machine |
| `lib/broker/` | Venue registry (`index.js`) + adapters (`paper.js`, `kraken.js`) |
| `lib/live.js` | Live-mode manager (owner-gated enable/disable, kill switch) |
| `lib/rails.js` | Hard risk rails for live orders (max size/positions/daily loss/min cash) |
| `lib/management.js` | 60s sweep: trailing stops / trailing TP / DCA on open paper positions |
| `lib/triggers.js` | User-defined price/score/24h alerts (notify or live proposal) |
| `lib/backtest.js` | Objective-rule backtester over 300 historical bars (honesty block included) |
| `public/index.html` | Landing page (SSR, WebGL backdrop, live data rail) |
| `public/app.html` | App shell (sidebar nav, views, auth modal) — boot-cached |
| `public/js/app.js` | View renderers + interactions (~2K lines) |
| `public/js/auth.js` | Auth UI (login/signup/2FA/reset/backup codes) |
| `public/css/style.css` | Design tokens (OKLCH palette, spacing, motion) |
| `docs/PHASE2_WALLET.md` | Phase 2 non-custodial wallet design (Safe 2-of-3 + agent session keys, TEE/MPC custody, funding layer, Coinbase CDP research §9.20–9.26) |
| `docs/PHASE2_SPEC.md` | Phase 2 agent-wallet engine spec (trust staking, spend limits, approvals) — engine built + tested |

## Key flows worth reviewing

1. **Agent-key principal resolution** — how X-API-Key maps to accounts
   (`/api/agent-keys`, scopes read/trade-paper/trade-live).
2. **Option-C live proposals** — agents request, owner approves; nothing executes
   until `executeLiveOrder()` runs rails + venue checks + audit.
3. **Settlement integrity** — `lib/paper.js` is the single writer for paper state;
   never run a second instance against the same data dir.
4. **Kraken adapter** — nonce handling, IP-locked key, withdrawal-disabled posture.

## Data files (gitignored, runtime-only)

`data/` holds accounts, paper state, agent keys (hashed), live audit trail, proposals,
triggers, payments. `LIVE_EMAIL_ALLOWLIST` in `.env` is the live-trading allowlist
(fail-closed when empty).

## Design notes (08-2026)

- Agent-Responsive Design: semantic HTML + ARIA + JSON-LD, `/.well-known/agent.json`,
  machine-readable page state in the DOM (`#agent-state`).
- Motion: custom cubic-bezier easings, `:focus-visible` outlines, hover gating for
  pointer-fine devices, modal enter/exit asymmetry, reduced-motion respected.
- Wallet layer (Phase 2, `docs/PHASE2_WALLET.md`): non-custodial by design — Safe 2-of-3
  root, agent keys as revocable scoped session signers, human lane at every money
  boundary. Research-derived hard rules: CORS origin allowlists (never `*`, no localhost
  in prod), client-first gate-second rollout, EIP-712 verifying-contract restriction +
  `^IOST:` message prefix for agent lane, raw-hash-signing hard-reject, fail-secure
  policy engine (first-match, no-match = reject).
