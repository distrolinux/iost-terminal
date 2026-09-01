# Position Guardian v1

Position Guardian is IOST Terminal's server-enforced paper-position protection
layer. It continues protecting a position when the initiating AI agent is idle,
disconnected, restarted, or no longer authorized to open new risk.

## Safety contract

- Paper-only. No live venue, token, wallet-send, swap, withdrawal, conversion,
  or public-chain action is available.
- Agent paper opens already require a valid protective stop. The resulting
  position is automatically armed by the server; the agent does not need a
  second tool call.
- A stop and take-profit form a bracket OCO. The first triggered leg closes the
  whole simulated position and cancels its sibling.
- Stop-loss wins any ambiguous simultaneous-trigger condition.
- Long exits are evaluated at the executable bid; short exits at the executable
  ask. The journal records the configured trigger separately from the observed
  simulated fill.
- A quote must be positive, fresh, and—where crypto quote integrity is
  required—have a trusted multi-venue quorum. Invalid evidence degrades the
  guardian and cannot fabricate a fill.
- Automatic closes are risk-reducing and remain permitted if the opening Pact
  later expires or the agent disconnects.
- Every completed automatic exit is written to the account's SHA-256 receipt
  chain with its trigger leg, cancelled leg, quote evidence, fill authority,
  paper-only boundary, and watchdog cadence.
- Existing protected positions are reconstructed from their persisted stop and
  target on boot, and the watchdog runs immediately before entering its normal
  10-second cadence.

## Agent interface

`paper_position_guardian` is a private, read-only MCP tool. It reports:

- watchdog heartbeat, cadence, duration, stale-quote and quorum failures;
- protected, armed, degraded and unprotected position counts;
- per-position OCO leg state and last decision;
- explicit guarantees that live scope and public-chain execution were unused.

The corresponding owner endpoint is `GET /api/position-guardian`. Both surfaces
are private and `no-store`. Neither can change a position.

## Industry protocol alignment

The state model follows the common OTOCO/bracket convention documented by
Binance, Coinbase Advanced Trade, and Alpaca: an entry activates protective
stop-loss/take-profit exits, and completion of one exit disables or cancels the
other. IOST Terminal additionally exposes quote-health and receipt evidence to
agents rather than treating OCO state as an opaque venue detail.

- Binance Spot WebSocket API, OTOCO/OCO order lists:
  <https://developers.binance.com/docs/binance-spot-api-docs/websocket-api/trading-requests>
- Coinbase Advanced Trade, bracket and attached TP/SL orders:
  <https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/guides/orders>
- Alpaca, bracket and OCO orders:
  <https://docs.alpaca.markets/us/docs/orders-at-alpaca>

The MCP status tool is deliberately read-only, non-destructive, idempotent, and
closed-world. Those annotations are descriptive hints; server-side authorization
and paper-only enforcement remain authoritative. This follows MCP tool guidance
and OWASP's least-agency recommendation to minimize agent functionality,
permissions, and autonomy.

- MCP tool specification:
  <https://modelcontextprotocol.io/specification/2025-06-18/server/tools>
- OWASP LLM06:2025 Excessive Agency:
  <https://genai.owasp.org/llmrisk/llm062025-excessive-agency/>

## Acceptance requirements

1. A fresh quote inside the stop/target range leaves the OCO armed.
2. A stale or failed-quorum quote creates no close, reservation, or receipt.
3. A valid trigger closes exactly once and cancels exactly one sibling leg.
4. The automatic exit creates one verified receipt and no execution intent.
5. Repeating the sweep creates no second close or receipt.
6. Cash settlement and journal P&L remain consistent with the observed exit.
7. Live scope and public-chain usage are always false.
