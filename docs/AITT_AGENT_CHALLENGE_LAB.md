# AITT Agent Challenge Lab

The AITT Agent Challenge Lab tests a paper strategy against deterministic adverse
execution conditions before an owner considers it for paper review. It is private,
evidence-bound and advisory. A challenge cannot promote an agent, grant authority,
reserve funds, place a trade, use live scope or write to a public chain.

## Locked challenge set

Every successful evaluation produces five comparable scenarios from the same frozen
strategy and immutable candle snapshot:

1. Nominal execution assumptions.
2. Higher fees.
3. Thin-book spread and slippage.
4. Delayed fills.
5. Combined fee, liquidity and delay stress.

Each scenario records return, maximum drawdown, cost, trade count, degradation from
nominal performance and its deterministic evaluation hash. The challenge adds a
separate integrity hash over the complete package.

## Decision boundary

`resilient` means all five scenarios met the disclosed drawdown and degradation
thresholds. `hold` means at least one scenario failed. Both outcomes are historical
paper evidence, not forecasts or permissions. The existing owner-controlled strategy
promotion policy remains separate and cannot be bypassed by challenge results.

## Private access

- `GET /api/agent-challenges` returns only the authenticated owner's retained results.
- `agent_challenge_scorecards` exposes the same read-only evidence over authenticated MCP.
- Retention, owner isolation, cache controls and tamper checks reuse the private
  Evaluation Lab evidence store.

## Reproducibility

Re-running an unchanged strategy, candle snapshot and evaluation configuration produces
the same scenario evidence. Any change to metrics, scenarios or assumptions invalidates
the challenge or enclosing evaluation hash.
