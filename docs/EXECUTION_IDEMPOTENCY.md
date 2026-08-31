# Execution Idempotency and Replay Protection v1

Paper opens and closes use durable execution intents so an agent can safely
retry after a timeout without creating a duplicate position or closing twice.
This is an execution-safety boundary, not a live-trading feature.

## Client contract

MCP `paper_trade_open` and `paper_trade_close` require an `intentId` containing
8-128 safe characters. Agent REST calls provide the same field or an identical
`Idempotency-Key` header. Browser paper orders generate an intent before the
request and reuse it after a network interruption.

- A new intent is persisted before authorization or broker work.
- An exact retry of a succeeded intent returns the original result.
- An exact retry of a failed intent returns the original error and receipt.
- Reusing an intent for different request data returns
  `execution-intent-conflict` without reaching authorization or the broker.
- Concurrent duplicate requests share one in-process execution.

Open request hashes cover every submitted execution field except the intent
value itself. The required preflight fingerprint separately binds that intent,
the requested price, maximum slippage, fresh multi-venue quorum and exclusions,
selected bid/ask and venue, server-fill notional, portfolio-risk decision and
authorization evidence. A retry cannot substitute a different stop or reuse a
fingerprint after exposure, drawdown, daily-loss or other bound risk evidence
has changed.
The volatility evidence age timer is intentionally excluded because it advances
between two immediate checks of the same observation. Source, freshness class,
regime, dynamic cap and calculated capacity remain bound and invalidate changed
evidence.
Close fingerprints cover the position identifier;
legacy client exit prices remain ignored and cannot manufacture paper P&L.

## Crash behavior

The store writes `pending` before the execution rail. If the process stops
before a terminal outcome is durably recorded, a later retry returns
`execution-intent-outcome-unknown`. It never guesses that the earlier attempt
failed and never automatically executes it again. Operators can inspect this
state through the private status surfaces and reconcile it against the paper
account and execution receipts.

This conservative rule prefers an explicit review over a duplicate order.

## Privacy and operations

`data/execution-intents.json` is atomic and mode `0600`. Account IDs, client
intent IDs and submitted wallet/Pact values are represented only by domain-
separated SHA-256 references or request hashes. Terminal results are retained
privately so an exact retry can receive the original result, including the
paper position handle needed by the same authenticated account.

Per-account history is capped at 10,000 records. The server fails closed at the
cap instead of deleting replay protection. Archival must preserve intent
tombstones before capacity can be reclaimed.

Private read surfaces:

- MCP: `paper_execution_intents`
- REST list: `GET /api/execution-intents?limit=1..200`
- REST lookup: `GET /api/execution-intents/:intentId`

Execution receipts store only an opaque intent reference and identify whether
the execution was retry-protected. No live order, token action, or public-chain
action is added.

## Verification

- `node tests/execution-idempotency-check.mjs`
- `node tests/mcp-http-integration-check.mjs`
- `npm test`
