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

Strategy, candle snapshot, and complete result hashes make an evaluation reproducible. The version 2 result hash covers folds, metrics, trades, chart series, baselines, calibration, methodology, warnings, audit evidence, and the paper-review decision. Authenticated platform-agent calls also enter the existing payload-hash audit log.

## Private history and comparison

Successful runs are retained in a private per-user store. Browser sessions and revocable agent credentials bound to the same user share that history; anonymous callers and unbound platform keys cannot use it. Store filenames use one-way owner digests, files are mode `0600`, the directory is mode `0700`, and every stored record and result hash is checked before it is returned. A failed integrity check closes history access instead of serving partial evidence.

The default retention policy is the newest 25 runs for 90 days. Operators can lower or raise those values with `EVALUATION_HISTORY_MAX_RUNS` and `EVALUATION_HISTORY_RETENTION_DAYS`, within hard ceilings of 100 runs and 365 days. Comparison accepts exactly two run IDs from the same owner and reports second-minus-first metric deltas without changing either run or any strategy state.

Each result includes equity, drawdown, causal buy-and-hold, causal 20/50 SMA, cash, and confidence-calibration series. The client renders these with local, dependency-free canvas charts.

## Deterministic exports

`GET /api/evaluation-lab/history/:id/export?format=json|csv` returns private, non-cacheable evidence. JSON uses canonical key ordering. CSV uses fixed columns and row ordering and neutralizes spreadsheet formulas. Neither format includes the run ID, creation time, user ID, email, or storage filename, so exporting the same stored evidence twice is byte-identical. Both formats carry the result hash.

## Fail-closed promotion

`promotion.allowed` defaults to false unless all evidence checks pass: at least 30 out-of-sample trades across at least three folds, drawdown at or below 20%, Sharpe-like performance at or above 0.5, acceptable confidence calibration, valid audit evidence, and returns above both trading baselines. Client configuration may make the sample requirement stricter but cannot lower the 30-trade or three-fold safety floors.

Passing produces only `ELIGIBLE_FOR_PAPER_REVIEW`. Human review remains required and all existing live-money and launch controls remain independent and closed.
