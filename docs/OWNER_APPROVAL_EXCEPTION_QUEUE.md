# Owner Approval & Exception Queue

IOST Terminal uses a non-agentic owner surface for paper-order approvals. An
agent may request approval only after an allowed preflight; it cannot approve,
reject, or broaden the mandate itself.

## Closed mandate

Every request is bound by SHA-256 to the account, requesting credential,
execution intent, preflight fingerprint, side, symbol, size, entry, protective
stop, target, slippage limit, wallet, Pact, and mission. Raw private identifiers
are replaced with opaque references before persistence.

- Requests expire after two minutes and never later than ten minutes.
- Changed order or preflight evidence requires a new owner decision.
- Approval is single-use and is consumed inside the idempotent execution lane.
- Exact request retries return the same queue record; conflicting intent reuse
  fails closed.
- Lifecycle events form a tamper-evident hash chain.
- Approval never bypasses current preflight, runtime, incident, SLO, Position
  Guardian, data-trust, wallet, Pact, mission, risk, or reconciliation controls.

## Mission policy

- `within-pact`: no per-order owner decision.
- `per-order`: every paper open requires an exact approval.
- `exceptions`: approval is required for a large order (at least half the
  mission cap), confidence below 70 or unavailable, a preflight warning, or a
  volatility regime outside calm/normal.

Owner decisions are available only through the signed-in Control Center. MCP
agents receive `paper_approval_request` and the read-only
`paper_approval_requests`; no MCP tool can approve its own request.

This feature is paper-only. It cannot execute live trades, move tokens, send
wallet funds, or perform a public-chain action.
