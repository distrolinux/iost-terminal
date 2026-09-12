# Live lifecycle acceptance — HOLD

## Remediation update

The five initial broker regressions now pass: bounded no-redirect transport,
explicit accepted status, missing-ID rejection, unknown submission outcomes and
exact partial-fill quantity evidence. Server acceptance no longer invents a fill
or burns credits. Unknown proposals persist as unknown and cannot be reclaimed.
The probe now runs in the offline suite. These fixes do NOT complete live readiness.

Still blocking: durable per-submission identity, cross-request/account retry
control, confirmed fill/fee ingestion, cancel/fill races, full process recovery and
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
