# Spot settlement evidence — HOLD

`previewSpotLedgerEvidence` is an offline, pure arithmetic preview. It accepts an expected reference and exact base/quote asset identifiers plus exactly two ordinary spot trade ledger legs. It rejects missing/duplicate legs, mismatched references/assets/directions/amounts, unsupported subtypes, margin entries and malformed decimals. Fees stay in their reported asset; net change is amount minus fee. Arithmetic uses fixed-point integers, never floating point.

Kraken distinguishes a trade-history fee estimate in quote currency from actual ledger fees. Each ledger entry's amount and fee are in that entry's asset:

- https://support.kraken.com/articles/360001169383-how-to-interpret-ledger-history-fields
- https://support.kraken.com/au/articles/115000302707-differences-between-ledger-and-trades-history
- https://docs.kraken.com/api-reference/account-data/get-ledgers-info

## Deliberately incomplete

Matching two supplied legs is not proof of authenticated, complete settlement. This helper cannot prove their origin, account/wallet ownership, fill-to-reference linkage, pagination completeness, reversals, or continuity of venue balances. Those require a separate authenticated acquisition and reconciliation layer. Never derive a ledger reference from an order ID or infer missing records. Third-asset fees (including KFEE), rebates and split legs are unsupported, not silently normalized.

Every result retains `settlementVerified: false`, `releaseAllowed: false`, and `executionAuthorized: false`. No endpoint, MCP tool, exchange request, accounting write, hold release or trading permission is added. It is not yet wired into the broker. Draft #104 remains HOLD pending authenticated settlement acquisition, replay-safe ledger posting and the other lifecycle acceptance requirements.

Verification uses synthetic buy/sell fixtures, base/quote fees, invalid records and immutable safety flags. Production is unchanged.

## Authenticated window reader (internal)

`broker.getLedgerWindow(hold, ownerId, window)` now checks the exact credential and venue account binding and fresh `query-ledger` permission before reading `Ledgers`. It uses the existing signed, bounded, serialized transport. It reads only the default wallet, a maximum 24-hour historical window, at most four pages / 200 entries, and requires stable counts, exact page sizes, unique IDs and valid timestamps/fields. It strips balance and unrecognized fields from returned private rows. Unsupported asset suffixes and trade subtypes fail closed. No retry, route, MCP exposure, scheduler or financial posting is added.

`windowCountMatched` describes only the observed pagination count. `snapshotComplete` and `settlementVerified` remain false: offset pages are not an atomic snapshot; late ledger entries, fill/reference linkage, default-wallet continuity, reversals and full settlement coverage still require verification. Do not feed arbitrary window records into accounting or release a hold based on this result. The earlier arithmetic helper remains separate. An uncertain transport failure retains the existing coordination lock; no lock cleanup is added.

## Explicit fill-to-ledger linkage

`linkSpotFillLedgerEvidence` first verifies the order's exact fill totals, then requires two explicit ledger IDs per non-margin fill. Every supplied ledger entry must be used exactly once; duplicate IDs, reuse across fills, missing/extra records, conflicting references and incorrect leg amounts fail closed. Output preserves the actual fee asset and deterministic fill ordering. It never adds amounts to balances, posts journal entries, releases holds or permits execution.

Kraken's [trade export field documentation](https://support.kraken.com/articles/360001184886-how-to-interpret-trades-history-fields) describes a `ledgers` column with corresponding ledger IDs. This helper accepts a normalized array from that explicit provider evidence, not a guessed `refid == trade ID` join. The current QueryTrades adapter has **not** been verified to return this export field; therefore automatic acquisition/wiring remains blocked. No CSV import endpoint, export creation call or fabricated field is added. Account-bound acquisition and trusted pair/asset metadata must be established separately. Matching supplied links still reports settlementVerified/releaseAllowed/executionAuthorized false. Duplicate rejection is within an evidence set, not durable exactly-once accounting across calls or restarts.

## Supported REST acquisition follow-up

The [TradesHistory API](https://docs.kraken.com/api-reference/account-data/get-trades-history) documents `ledgers=true`. `getLinkedSettlementEvidence` now uses this route, explicitly sets `consolidate_taker=false`, and retrieves exact linked IDs using [QueryLedgers](https://docs.kraken.com/api-reference/account-data/query-ledgers) in batches of at most 20. This supersedes the automatic-acquisition limitation above, without assuming QueryTrades has the field.

This first internal adapter supports BTC/USD ordinary spot on the default wallet only. It validates owner/credential/account binding, ledger permission, held order identity and fill totals. The historical window is at most 24 hours; histories over 100 records fail closed instead of truncating. Missing links, additional same-order fills, changed totals, reused IDs and missing ledger results fail closed. Only normalized linked evidence is returned, never private balances. No report-generation side effect or credential change is needed.

Offline transport fixtures verify the request options and broker integration. Production API behavior has not been exercised. Snapshot finality, later fills/reversals, independently verified wallet continuity, durable exactly-once financial posting and safe hold release remain unresolved. Every result still denies settlement verification and execution/release authority. No public route, automatic scheduler or live enablement is added.

## Persistent evidence deduplication

`createLiveSettlementHistory` stores private, hash-linked batches of new evidence only. Exact fill replays add nothing, including after process restart. Changed order/account/credential binding or fill contents hold; any ledger ID reused for a different fill holds. Cumulative snapshots append only previously unseen fills. Uniqueness is conservatively owner-wide, so conflicting IDs across different venue accounts require review rather than automatic reuse.

Files use exclusive sequence creation, file/directory sync, private permissions, bounded reads and no-follow file opens. Corrupt/partial files, sequence gaps and capacity exhaustion fail closed. Concurrent append losers hold and can be reviewed/re-read; no lock stealing, deletion or repair API exists. The internal `recordHeldSettlementEvidence` helper separates this explicit local write from read-only broker queries. No HTTP/MCP route or scheduler is wired.

This is evidence deduplication, **not** exactly-once accounting: no balances, spend counters, portfolio quantities or financial journal are updated. Privileged deletion/replacement, backup rollback, power-loss behavior and distributed storage are not certified. Finality, subsequent corrections, authenticated default-wallet continuity and hold release remain launch blockers. All authority and settlement-verification flags remain false.
