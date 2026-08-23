# Security Policy

Security policy for the IOST Terminal platform (`iostcallister.com`). This repo is public with **all rights reserved** (no license) — treat every file as proprietary unless stated otherwise.

## Supported Versions

The latest release on the default branch is supported. Security fixes may be backported at maintainer discretion.

## Reporting a Vulnerability

**Preferred: GitHub Private Vulnerability Reporting** — use the repository's Security → "Report a vulnerability" flow. If private reporting is unavailable, open no public issue; contact the maintainer directly through GitHub.

Please **do not** disclose vulnerabilities publicly before they are validated and a fix is coordinated.

### What to include

- **Impact summary** — what can an attacker do, and does it touch funds, orders, keys, or other users?
- **Affected components** — `server.js`, `lib/`, `public/`, `contracts/`, API routes, or deployment.
- **Minimal reproduction steps** (safe, non-destructive — no live orders, no real keys).
- **Suggested fix or mitigation**, if you have one.

### Response timeline (targets)

| Stage | Target |
|---|---|
| Acknowledgment | within 72 hours |
| Initial assessment | within 7 days |
| Fix or mitigation plan | within 30 days (severity-dependent) |

## Security rules for contributors and AI agents

This project is an AI-agent-native trading platform. The rules in `AGENTS.md` are binding for every human and every agent working in this repo. Highlights:

- **Secrets never appear in source, responses, logs, tests, or screenshots** — exchange keys (Kraken v2, withdrawals disabled by design), agent API keys, wallet private keys, reset tokens, and raw credentials are injected at runtime via environment only. An exposed secret is treated as compromised and rotated immediately.
- **Money boundaries are human-gated** — real-money execution requires a signed-in human, enabled venue, hard order rails, and owner-approved agent proposals. No agent code may bypass per-trade approval.
- **Agent keys are least-privilege** — scoped per agent (`read` / `trade-paper` / `trade-live`); wallet spending is bounded by server-side Pacts and spend limits, never by client-side checks.
- **Fail closed** — live orders reject when a trustworthy price is unavailable; the notional cap always applies; reservation leases prevent duplicate orders.
- **Before release** — `npm test` (offline safety suite), `node --check server.js` + syntax-check changed modules, and `npm audit --omit=dev --audit-level=high`.

## Reporting scope (what's in)

- The trading platform: `server.js`, `lib/`, `public/`, `scripts/`, `contracts/`
- Agent execution flow: proposals, approvals, reservations, spend checks
- Auth/session handling, password reset tokens, API key scopes
- The AITT token economy docs (pre-launch — no token is deployed yet; see `docs/TOKENOMICS.md` for the launch hold)

## Out of scope

- The IOST chain itself, IOSTscan, Kraken, or any third-party venue/service — report those to their respective owners.
- Known, documented pre-launch holds (see `docs/AITT_REVIEW_2026-08-23.md`) — these are tracked project state, not vulnerabilities.
