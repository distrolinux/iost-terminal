# Kraken account fee evidence — staged live preparation

Owner-only connection verification accepts optional includeFeeEvidence: true.
After safe permission and balance checks, it queries TradeVolume with the fixed
spot pair XXBTZUSD. Existing timeout, response bound, no-redirect, rate limit,
single-flight and credential-change protections remain in force.

Only exact decimal-string maker/taker rates are returned; volume and fee-tier
thresholds are discarded. Missing, ambiguous, unsupported or failed responses
produce unavailable, never zero. Optional failure does not imply the basic
connection is unreachable. Fees are private, no-store, not persisted.

This first slice covers BTC/USD only. No other pair, full order affordability,
margin exposure, account eligibility, system status, validation or execution is
claimed. The UI does not automatically overwrite draft fee assumptions.
An observed schedule is not a guaranteed final fill fee. Platform fee remains $0.

Reference checked 2026-09-12:
https://docs.kraken.com/api-reference/account-data/get-trade-volume
This endpoint requires Query funds and returns pair-specific fee schedules.

Acceptance uses synthetic fixtures only. A real owner connection check remains
separate, optional and read-only. No saved credential is required to run tests.
Next stages: pair-specific draft binding, fresh usable funds and fee-aware exact
arithmetic, eligibility/system evidence, then independently reviewed order lifecycle.
