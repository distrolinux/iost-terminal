# Agent Evaluation Lab

The Agent Evaluation Lab is a read-only, paper-only strategy evidence system. It does not promote a strategy into live trading and cannot authorize token deployment, conversion, staking, liquidity, or public-chain writes.

## Validity boundary

- Strategy parameters are frozen before rolling walk-forward folds are created.
- A signal at bar `i` can observe only bars `0..i`; execution occurs at bar `i+1` open.
- Training and test ranges never overlap. Only test-fold results enter the reported KPIs and promotion gate.
- Fees apply on entry and exit. Half-spread and slippage are applied adversely to each fill.
- If a bar touches both stop and target, the stop is assumed to execute first.
- An open position is closed at the end of each fold, preventing exposure from crossing evaluation boundaries.

## Evidence

The response contains win rate, profit factor, expectancy, maximum drawdown, a trade-return Sharpe-like ratio, costs, sample warnings, confidence Brier score and expected calibration error. Results are compared with cash, cost-adjusted buy-and-hold, and a causal 20/50 SMA long-or-cash baseline.

Strategy, candle snapshot, and complete result hashes make an evaluation reproducible. Authenticated agent calls also enter the existing payload-hash audit log.

## Fail-closed promotion

`promotion.allowed` defaults to false unless all evidence checks pass: at least 30 out-of-sample trades across at least three folds, drawdown at or below 20%, Sharpe-like performance at or above 0.5, acceptable confidence calibration, valid audit evidence, and returns above both trading baselines. Client configuration may make the sample requirement stricter but cannot lower the 30-trade or three-fold safety floors.

Passing produces only `ELIGIBLE_FOR_PAPER_REVIEW`. Human review remains required and all existing live-money and launch controls remain independent and closed.
