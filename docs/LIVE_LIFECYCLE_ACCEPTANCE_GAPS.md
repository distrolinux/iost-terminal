# Live lifecycle acceptance — HOLD

## Remediation update

Durable submission guard added: exclusive owner-scoped file, file/directory sync
before outbound submission, persistent UUID sent as Kraken cl_ord_id. Another
submission for that owner is blocked regardless of acceptance or failure. No hold
release/expiry API exists. This is conservative lockout, not completed recovery.
Do not manually delete holds to retry. A corrupt/incomplete hold stays blocking.
The directory lives under IOST_DATA_DIR/live-submission-holds and must be preserved
in operational backups; this change does not establish a backup recovery rehearsal.

Tests now exercise a fresh child process, concurrent child processes, corruption
and separate owners. Actual power-loss/filesystem durability is not proven.
Kraken client IDs identify open orders; they are not claimed as venue-wide exactly-once
guarantees. Reference: https://docs.kraken.com/api-reference/trading/add-order

A reconciliation preview recognizes partial/filled/terminal evidence and holds
on conflicting terminal observations or decreasing quantities. An internal
read-only inspector now queries Kraken QueryOrders using an immutable persisted
acknowledgement sidecar. It compares client ID, venue ID, pair, direction, quantity
and limit terms; missing evidence remains unknown. There is no HTTP/MCP exposure,
scheduler, ledger integration or hold release. Fees remain unverified and
releaseAllowed remains false. This inspector does not yet persist observation
history, so cross-query monotonicity remains an integration requirement.

The sidecar is exclusively created and synced; failures leave the original hold
blocking. A lost acknowledgement requires further recovery work, not a guessed
venue ID or retry. Corrupt sidecars fail closed. QueryOrders requires venue IDs,
so unknown submissions without one remain unresolved. No real authenticated
exchange call has been used in verification; tests replace transport entirely.
Reference: https://docs.kraken.com/api-reference/account-data/query-orders-info

The internal inspector now follows the order's explicit fill IDs with one
QueryTrades request (maximum 20 IDs). It rejects duplicate/missing/extra fills,
wrong order/pair/direction, margin fills, malformed decimals and aggregate
quantity/cost/fee mismatches. Totals use fixed-scale integer arithmetic, not
floating point. Pair aliases are normalized in the adapter. Larger histories
remain unknown; there is no truncation, retry or inferred fill.

`fill-totals-matched` means provider-reported totals agree, NOT settled funds or
verified fee currency. `feesVerified` and `feeSettlementVerified` remain false.
No ledger writes, balance adjustments or hold release are implemented. The two
queries are not an atomic snapshot: changes between responses remain unknown
when their totals disagree. Owner/credential binding, durable history and ledger
evidence are still required before these internal helpers can be exposed.
Reference: https://docs.kraken.com/api-reference/account-data/query-trades-info

The five initial broker regressions now pass: bounded no-redirect transport,
explicit accepted status, missing-ID rejection, unknown submission outcomes and
exact partial-fill quantity evidence. Server acceptance no longer invents a fill
or burns credits. Unknown proposals persist as unknown and cannot be reclaimed.
The probe now runs in the offline suite. These fixes do NOT complete live readiness.

Still blocking: confirmed fill/fee ingestion, owner-bound reconciliation exposure
and unknown-outcome recovery,
verified hold release, end-to-end cancel/fill races, full recovery and
HTTP execution-path acceptance. Keep this PR draft and do not deploy it as a live
readiness upgrade. The historical baseline findings below explain the regressions.

Baseline: 6aa386fd6796984b05b8b22c01b70c1083e0f302.
Run `node tests/live-lifecycle-acceptance.mjs` in a disposable local test process.
It replaces fetch before importing the broker, supplies fixture credentials and
uses a fresh temporary proposal store. No server is booted; no real exchange is
contacted. The test exits nonzero intentionally while release blockers remain.
The historical baseline failed; the remediated checks now run in the offline suite.

## Observed blockers

1. AddOrder success has no explicit accepted-versus-filled state. Source inspection
   of executeLiveOrder also shows a journal entry labelled venue fill using the
   submitted size and requested/last price immediately after broker acceptance.
   Acceptance is not fill evidence. The source observation was not an HTTP test.
2. The broker request lacks a deadline and redirect rejection.
3. An empty successful provider result returns ok with a null order identifier.
4. A simulated submission timeout returns generic failure, not outcome-unknown.
   The adapter did not retry, but a safe reconciliation path remains missing.
5. OpenOrders drops vol_exec, losing evidence that an order was partly filled.

## Checks that passed

- No automatic adapter retry of the simulated timeout.
- Duplicate approval cannot acquire a second proposal execution lease.
- A lease remains executing after reloading the module from the persisted store.
  This is not a power-loss durability, full process restart or venue reconciliation test.

## Required work before live acceptance

- Persist submission intent and stable client identity before network submission.
- Keep accepted, partial, filled, rejected, cancelled and unknown outcomes distinct.
- Query and reconcile unknown outcomes before any resubmission; do not infer a fill
  from an acknowledgement or absence from open orders.
- Journal actual confirmed quantity, price and fee evidence, not requested values.
- Prove cancel/fill races, partial-fill fee accounting, replay, restart and
  independent owner/account isolation using fixtures and the actual execution path.
- Preserve launch locks and independent audit/eligibility requirements.

Runtime remediation is now included but no deployment was performed. Passing
the limited regressions is not live readiness, certification or permission to
trade. Keep the draft on HOLD until the remaining lifecycle work is verified.
