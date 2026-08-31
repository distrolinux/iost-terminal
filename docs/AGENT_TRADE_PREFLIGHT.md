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
- bid, ask, spread and top-of-book slippage estimates when available;
- requested notional, zero-fee paper cost model and estimated total;
- paper cash sufficiency;
- current trade-paper scope, wallet ownership/status/capability, wallet spend
  limits and active wallet-bound Pact authorization;
- optional Mission Control symbol, order-size, trade-count, expiry and loss-halt
  authorization;
- machine-readable checks, an allow/deny decision and reason code; and
- a SHA-256 preflight fingerprint bound to the authenticated account, exact
  request, observed quote and decision.

Wallet, Pact, account, recipient and mission identifiers are not returned.
`liveScopeUsed` and `publicChainUsed` are always false.

## Boundaries

The estimate is evidence, not a fill guarantee. The slippage model uses the
currently observed top-of-book spread and does not claim order-book depth or
future liquidity. A preflight expires with its quote and execution rechecks the
authoritative wallet, Pact, mission, spend and cash rails. Execution remains a
separate idempotent `paper_trade_open` call with a unique `intentId`.

## Verification

```bash
node tests/agent-trade-preflight-check.mjs
node tests/mcp-http-integration-check.mjs
npm test
```
