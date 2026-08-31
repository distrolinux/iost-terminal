# Strategy Evaluation and Promotion Engine

Version 1.30 adds an evidence-bound governance layer to the paper-only Agent Evaluation Lab. Its purpose is to answer a narrower question than “did this backtest make money?”: does the available out-of-sample evidence justify owner review, continued shadow observation, restriction, or pause/demotion?

## Trust boundary

The engine is deterministic and read-only. It cannot activate an agent, grant a scope, change a wallet or Pact, reserve paper cash, place a simulated trade, submit a live order, move money, perform a token action, or write to a public chain. Every lifecycle output is a recommendation with `applied: false`, `ownerReviewRequired: true`, and `executionPermissionsChanged: false`.

## Score

The score is bounded from 0 to 100:

| Component | Weight | Evidence |
| --- | ---: | --- |
| Risk-adjusted performance | 25% | Sharpe-like ratio and per-trade expectancy |
| Drawdown control | 20% | Maximum out-of-sample peak-to-trough drawdown |
| Benchmark edge | 20% | Net return above the strongest cash, buy-and-hold, or causal SMA baseline |
| Confidence calibration | 15% | Brier score and expected calibration error |
| Fold consistency | 10% | Positive-fold share and dispersion across unseen windows |
| Evidence depth | 10% | Out-of-sample trades, walk-forward folds, and calibration observations |

The scorecard also reports a grade, evidence-confidence tier, positive-fold rate, fold-return dispersion, best and worst fold, benchmark alpha, and an overfitting-risk proxy. The proxy is deliberately described as a warning, not proof of future performance.

## Hard gates

Scoring never bypasses the existing minimum safety floor:

- valid hashed evaluation evidence;
- at least 30 out-of-sample trades;
- at least three walk-forward folds;
- maximum drawdown no greater than 20%;
- Sharpe-like score at least 0.5;
- Brier score no greater than 0.25;
- calibration error no greater than 0.15;
- positive alpha over the strongest baseline;
- at least half of test folds profitable.

Callers may request stricter limits but cannot weaken these floors.

## Lifecycle recommendations

- `PAPER_REVIEW` / `PROMOTE_TO_PAPER_REVIEW`: every hard gate passes and the score is at least 75. This grants no authority; an owner may review the evidence.
- `SHADOW` / `KEEP_IN_SHADOW`: evidence is promising but incomplete. Continue observation without execution authority.
- `RESTRICTED` / `RESTRICT_AND_REEVALUATE`: evidence is weak or multiple gates fail. Reduce trust and require a new evaluation.
- `PAUSED` / `PAUSE_AND_DEMOTE`: evidence integrity, severe drawdown, material loss, or a very weak score demands a fail-closed recommendation.

## Owner and agent surfaces

- The Evaluation Lab displays the total score, grade, evidence confidence, all six components, lifecycle recommendation, fold consistency, benchmark alpha, overfit-risk proxy, and unchanged execution authority.
- Private evaluation history shows each retained run's score and lifecycle stage.
- `GET /api/strategy-governance` returns owner-bound retained scorecards with private no-store caching.
- The authenticated read-only MCP tool `strategy_promotion_scorecards` exposes the same evidence to agents with `read` scope.
- Evaluation JSON and CSV exports remain deterministic and include the hash-bound promotion evidence.

No public or anonymous endpoint exposes private scorecard history.
