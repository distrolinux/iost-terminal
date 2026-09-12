# Live connections workspace

The landing page offers Paper Trading and Real-Money Trading (setup/readiness,
execution locked). Login URLs retain `#launchpad` or `#live`. A persistent
workspace navigation row in the terminal keeps both destinations visible with
an accessible current-state indicator. This is navigation, not an execution-mode
switch: it never persists live authority, changes account scope, or submits orders.
No recurring sign-in modal is needed to find either workspace.

`/app#live` is an owner-private, read-only workspace separate from paper Launchpad.
`GET /api/exchange-connections` requires an owner session, uses that session's user
record and returns private/no-store evidence. Agent API keys cannot access it.

Kraken configuration is projected through a fixed field whitelist. Configured
credentials do not prove account health or current permissions. No provider calls
are made. Robinhood is explicitly not integrated, not a connected venue.

The existing ten public-live readiness gates remain authoritative. Even a passing
snapshot means canary review, not permission to trade. The workspace adds no
credential entry, mutation, new MCP tool, permission, or execution path. Paper
balances and approvals cannot migrate into live authority. Direct provider calls
outside IOST are outside IOST's enforcement boundary.

Next integration work requires a dedicated vault, verified provider authentication
and permissions, exact per-order owner approval, provider preview and tradability,
idempotent submission and reconciliation, and the existing launch/audit/legal gates.
No claims of verified Robinhood third-party integration are made.

Run `node tests/exchange-connections-check.mjs` and the full offline safety suite.
Deployment is separate; server/boot-cached markup changes require container restart.
