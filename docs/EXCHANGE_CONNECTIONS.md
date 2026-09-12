# Live connections workspace

The landing page offers Paper Trading and Real-Money Trading (setup/readiness,
execution locked). Login URLs retain `#launchpad` or `#live`. A persistent
workspace navigation row in the terminal keeps both destinations visible with
an accessible current-state indicator. This is navigation, not an execution-mode
switch: it never persists live authority, changes account scope, or submits orders.
No recurring sign-in modal is needed to find either workspace.

`/app#live` is an owner-private setup workspace separate from paper Launchpad.
`GET /api/exchange-connections` requires an owner session, uses that session's user
record and returns private/no-store evidence. Agent API keys cannot access it.

Kraken configuration is projected through a fixed field whitelist. Configured
credentials do not prove account health or current permissions. No provider calls
are made by this GET snapshot. Robinhood is explicitly not integrated, not a connected venue.

The existing ten public-live readiness gates remain authoritative. Even a passing
snapshot means canary review, not permission to trade. The workspace adds no
credential entry, new MCP tool, permission, or execution path. Owner-triggered
verification and deletion are described below. Paper
balances and approvals cannot migrate into live authority. Direct provider calls
outside IOST are outside IOST's enforcement boundary.

Next integration work requires a dedicated vault, verified provider authentication
and permissions, exact per-order owner approval, provider preview and tradability,
idempotent submission and reconciliation, and the existing launch/audit/legal gates.
No claims of verified Robinhood third-party integration are made.

## Owner-triggered verification

POST `/api/exchange-connections/kraken/verify` uses only the signed-in account's
existing saved credentials. It never falls back to platform environment keys.
It calls Kraken GetApiKeyInfo and, only for accepted permissions including
query-funds, Balance. It returns sanitized evidence, never keys, account IDs,
balances or upstream errors. Requests have a 10-second abort, reject redirects,
are rate limited and single-flight per account. Credential changes discard an
in-flight result. Results are not persisted and do not satisfy live launch gates.

The Live page also exposes existing credential deletion, with explicit notice
that venue orders and positions are unaffected and venue key revocation is separate.
New credential collection remains behind the existing onboarding gate. No new MCP
tools, vault claims, automatic verification or trading permissions are added.

Official schema: https://docs.kraken.com/api/docs/rest-api/get-api-key-info

Run `node tests/exchange-connections-check.mjs` and the full offline safety suite.
The owner can optionally include a `BalanceEx` query through the same verification route; see [USD held-funds evidence](KRAKEN_HELD_FUNDS_EVIDENCE.md). The option defaults off, returns no amounts, and never satisfies a live launch gate.
Deployment is separate; server/boot-cached markup changes require container restart.
