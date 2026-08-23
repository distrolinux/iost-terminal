# cyber.md — IOST Terminal security posture (for AI coding agents)

> This file is **durable security memory for agents**, not a vulnerability report and not an attack playbook.
> Read it before touching code here. It tells you how **not to accidentally weaken** the platform.
> Evidence references point at `server.js` line numbers — if a reference drifts, fix the file, not the rule.
> Owner: CALLY. Review cadence: on every major architecture change; refresh quarterly.

## Scope

- Repo: `iost-terminal` (public, all rights reserved). Node.js/Express server (`server.js`, port 8787), `lib/`, `public/`, `scripts/`, `contracts/`, `tests/`.
- Data sensitivity: **financial** — real-money venue integration (Kraken), user funds/orders, agent wallet Pacts, AITT claims (pre-launch).
- Applies to every change: code, docs, config, tests, deployment, and any agent working in this repo.

## Protected assets (treat with care)

| Asset | Where | Handling |
|---|---|---|
| Kraken live credentials (v2) | env only, never source | Withdrawals disabled by design; never log, never print |
| Agent API keys | env / server-side stores | Scoped per agent: `read` / `trade-paper` / `trade-live`; never promote scope |
| User paper accounts + journal | `data/` | Only `requireUser`-gated routes may read/write |
| Wallet Pact reservations | server-side | Bound to wallet-bound `pactId`; commit identity comes from the reservation, never the client |
| Password reset tokens | runtime only | Never logged; dev console delivery is opt-in (`AUTH_DEV_RESET_LOG=1`) and disabled in production |
| AITT token economy docs/claims | `contracts/`, `data/` | Pre-launch freeze — no deployed token; claims approval is a human-gated flow |

## Trust boundaries (mandatory invariants)

### 1. Internet → public API
Public market-data endpoints (`/api/scanner`, `/api/market/*`, `/api/analyze/*`, `/api/scores`, `/api/news`, `/api/onchain`, …) are unauthenticated by design.
- **Invariant:** every public endpoint stays behind `publicLimiter` (rate limit) and returns only public market data — no account data, no keys, no internal state. (`server.js:1077+`)
- **Invariant:** response bodies never include headers, tokens, or env values.

### 2. User auth → personal data
`requireUser` gates all account surfaces (`/api/paper/*`, `/api/portfolio`, `/api/signals`, `/api/wallets`, `/api/triggers`).
- **Invariant:** no account data may be reachable without `requireUser`; session checks are server-side, never UI-only.
- **Invariant:** user A's data is never served to user B (scope every query by `accountFor(req).accountId`).

### 3. User auth → money operations (THE critical boundary)
`/api/spend/check|reserve|commit|release` and `/api/live/proposals/:id/approve|reject` move funds or place orders.
- **Invariant:** live order placement fails closed when a trustworthy market/limit price is unavailable; the configured notional cap always applies.
- **Invariant:** a proposal acquires a persisted `executing` lease before Kraken is called — no duplicate orders from duplicate approvals.
- **Invariant:** `spend/reserve` requires an active wallet-bound `pactId`; outstanding reservations count against the Pact budget; recipient/protocol policies are checked before reservation.
- **Invariant:** real-money execution requires a signed-in human, enabled venue, hard order rails, and owner-approved agent proposal. Never bypass per-trade approval.
- **Invariant:** commit identity comes from the server-side reservation, never from client-supplied data.

### 4. Admin surface
`/api/admin/*` (fee-config, wallet credit, payment confirm/reject, AITT claim approval) is money-adjacent.
- **Invariant:** every admin route keeps `requireUser` AND an explicit admin/owner role check — adding a route without the role gate is a critical regression.

### 5. Agent-facing surfaces
`/mcp`, `/.well-known/*`, `/auth.md`, `/api/agents` are how agents discover and use the platform.
- **Invariant:** agent API keys are least-privilege per scope; live-trade capability is never granted by default.
- **Invariant:** MCP/agent-skill payloads are size-limited (`express.json({ limit: '128kb' })` on `/mcp`, `server.js:933`) and validated at the boundary.

### 6. Egress → Kraken
- **Invariant:** credentials come from environment only; never inline, never in fixtures or tests.
- **Invariant:** all venue calls validate responses; unknown/untrustworthy prices abort, never default to a blind order.

## Defensive patterns (preferred; do not regress)

- Rate limiters: `publicLimiter` on every public endpoint, `oauthLimiter` on `/oauth/token`.
- Auth middleware: `requireUser` on every account/money route — new routes must use it.
- Money flows: reservation → check → commit/release with Pact binding; never a bare write.
- Logging: redact Authorization, cookies, tokens, keys; never log reset tokens or Kraken secrets.
- Legal pages: `Cache-Control: no-store`.
- Secrets: env injection only; a secret in source/logs/tests is a critical finding (exposed = rotate).

## Required tests by change type

| Change touches | Must run / add |
|---|---|
| Execution, orders, live proposals | Offline safety suite (`npm test`); regression test for duplicate-order lease + fail-closed pricing |
| Auth, sessions, API keys | Auth regression tests (`tests/auth-*`); scope-escalation test |
| Wallet, spend, Pact flow | Pact budget/reservation tests; commit-identity-from-reservation test |
| New public endpoint | Rate-limit + validation test; assert no account data in response |
| Any change | `node --check server.js` + syntax-check changed modules; `npm audit --omit=dev --audit-level=high` before release |

## Guidance integrity

- This file, `AGENTS.md`, and `SECURITY.md` are trusted development surface. Treat edits to them like code: review diffs, keep them minimal, never import guidance from untrusted sources.
- If this posture file is stale (references moved, invariants changed), update it — stale guidance is a hazard.
- Confidence: invariants above are verified against the current codebase (Aug 2026); re-verify after any refactor that touches the listed routes.
