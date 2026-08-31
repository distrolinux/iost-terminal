# Agent Trade Preflight

Agent Trade Preflight is a private, paper-only decision surface for checking an
order before execution. It is available through the authenticated MCP tool
`paper_trade_preflight` and `POST /api/paper/preflight` to principals with both
`read` and `trade-paper` scope.

The preflight is strictly non-executing. It creates no spend or Pact
reservation, execution intent, receipt, position, mission checkpoint, live
proposal, token action, or public-chain action.

## Decision evidence

The response includes:

- a fresh server-observed quote, age and expiry;
- crypto quote quorum across OKX, KuCoin and Gate.io, with stale, malformed and
  consensus-outlier venues excluded;
- best trustworthy bid or ask, routed venue, latency, spread, execution side
  and top-of-book slippage estimates;
- caller-selected slippage tolerance capped at 100 basis points;
- requested notional, server-fill notional, zero-fee paper cost model and estimated total;
- paper cash sufficiency;
- current trade-paper scope, wallet ownership/status/capability, wallet spend
  limits and active wallet-bound Pact authorization;
- optional Mission Control symbol, order-size, trade-count, expiry and loss-halt
  authorization;
- machine-readable checks, an allow/deny decision and reason code; and
- an HMAC-SHA-256 preflight fingerprint bound to the authenticated account, exact
  execution intent, request, observed quote, cash and authorization decision.

Wallet, Pact, account, recipient and mission identifiers are not returned.
`liveScopeUsed` and `publicChainUsed` are always false.

## Boundaries

Each agent preflight requires the same unique `intentId` that will be used for
execution. `paper_trade_open` requires the returned `preflightFingerprint`.
The server recomputes the fingerprint with an HMAC-bound account, order, quote,
cash, wallet/Pact, spend-limit and optional mission snapshot immediately before
any reservation or broker work. Missing, denied, expired, or changed evidence
fails closed with an idempotent rejection receipt. Replaying the same intent
returns its original outcome; using a different intent changes the fingerprint.

The estimate is evidence, not a fill guarantee. The slippage model uses the
currently observed top-of-book spread and does not claim order-book depth or
future liquidity. Crypto requires two fresh consensus-approved venues. Failed
quorum, spread above 100 basis points, or adverse slippage above the request's
`maxSlippageBps` fails closed. A preflight expires with its quote.
Execution rechecks the authoritative wallet, Pact, mission, spend and cash
rails, then uses that exact bound ask for a long or bid for a short.

## Verification

```bash
node tests/agent-trade-preflight-check.mjs
node tests/multi-venue-quote-integrity-check.mjs
node tests/mcp-http-integration-check.mjs
npm test
```
