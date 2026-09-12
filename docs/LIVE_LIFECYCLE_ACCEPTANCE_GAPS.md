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
releaseAllowed remains false. The inspector remains read-only; a separate internal
recordHeldLiveOrderEvidence helper explicitly writes private evidence history.

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
when their totals disagree. Owner/credential binding, production integration and ledger
evidence are still required before these internal helpers can be exposed.
Reference: https://docs.kraken.com/api-reference/account-data/query-trades-info

Persistent reconciliation history now records immutable, hash-linked snapshots
under a caller-supplied private directory (0700 directories, 0600 files). Exact
replays add no record. Prior fill IDs/digests must remain present and unchanged;
quantities/costs/fees cannot decrease and terminal snapshots cannot change.
Records are bounded to 128 per owner, with at most 20 fills each. Capacity,
corruption, incomplete writes, sequence gaps and concurrent append conflicts
hold rather than overwriting/deleting history. Files and directories are synced.
Offline tests exercise a new process and concurrent processes, not real power loss.

This is evidence deduplication, NOT exactly-once financial posting. There is no
ledger or balance mutation. The hash chain is not externally anchored or signed;
it cannot prove absence of tail deletion or replacement by a privileged writer.
Conflicting observations are rejected, not permanently quarantined by this helper.
No HTTP/MCP route or scheduler invokes the writer. Account/credential binding and
operational backup/recovery acceptance remain required. No hold is released.

Connection continuity update: per-user brokers now derive a private opaque HMAC
binding from owner ID and the exact credential pair. New submission holds and
history retain this binding. Reconciliation rejects missing/mismatching bindings
before venue requests, including owner changes and key/secret rotation. This is
credential continuity, NOT independently verified exchange-account identity.
It does not detect the same exchange account connected under multiple owners.
Partial explicit credentials can no longer mix with environment fallback keys;
environment-only brokers cannot submit through the owner-bound execution path.
Bindings must never be returned in HTTP/MCP, discovery or logs.

Old unbound holds/history remain held; there is no automatic migration or rebinding.
These changes are still draft-only. Reconnecting/rotating credentials while an
order is held needs a reviewed recovery workflow rather than deleting evidence.
Actual HTTP owner isolation and venue account identity checks remain unfinished.

Venue-reported identity update: the adapter now queries GetApiKeyInfo, validates
the echoed key, nonempty bounded account identifier, key expiry and allowed
permissions, and privately HMAC-binds the reported account to owner/credential.
Submission additionally requires modify/close permissions. Reconciliation checks
the current reported identity against the persisted hold before querying orders.
Raw account identifiers and echoed keys are never returned by this helper.
New holds/history require both bindings; unbound draft-era records stay blocked.
Reference: https://docs.kraken.com/api-reference/account-data/get-api-key-info

This is authenticated venue-reported continuity, not independent identity/KYC,
jurisdiction eligibility, settlement proof, or cross-owner account deduplication.
Broker-instance nonces now increase within the same millisecond; global ordering
across multiple instances/processes sharing a key remains a launch blocker.
No real API calls were made. HTTP lifecycle/owner isolation, global request
coordination, settlement accounting and recovery acceptance remain unfinished.

Shared process coordinator update: broker instances and connection verification
now share one serialized request lane per hashed API key. Nonces increase even
when the clock moves backward. Queue depth (32), key registry (4096) and queue
wait (10 seconds) are bounded; capacity/deadline failures do not retry requests.
No raw keys are stored in the lane registry. Failed calls do not poison the lane.
This is PROCESS-LOCAL, not cross-process or restart-durable coordination. External
clients sharing the key and process restarts still require a reviewed operational
design before live readiness. Offline integration verifies broker/verifier overlap.

Durable coordinator update: server boot configures a private directory under
IOST_DATA_DIR/kraken-request-coordination. Server broker and verifier calls now
use exclusive per-key filesystem locks and a nonce persisted/synced before the
request. Processes sharing this exact local directory cannot overlap that key.
A fresh process advances beyond the saved nonce even after clock rollback.
Success removes only its request lock; callback failure, malformed state, or a
crash retains the lock and blocks further requests. There is no automatic stale
lock cleanup. Do not delete coordination files to retry an unknown order.

This intentionally also holds after read-only provider errors, trading availability
for fail-closed behavior. A reviewed recovery workflow is required before release.
Backups must preserve both lock and nonce state; restoring old nonce state is not
safe without recovery review. Tests simulate process exit and competing processes,
not power loss, network partitions, backup restore or distributed filesystems.
External clients and servers with different coordination directories are not
coordinated. Standalone library tests without server configuration still use the
process-local lane. No live execution or production deployment was performed.

Recovery diagnostics update: new lock records retain only a request class
(read-only, submission, cancellation, unknown). A private owner-bound broker
method inspects bounded local files without exposing IDs, keys or nonce values.
It distinguishes held/absent/unavailable evidence but always denies release/retry.
Legacy locks remain unknown; corrupt records fail closed. This is an internal
diagnostic, not an HTTP/MCP route or completed recovery mechanism. See
KRAKEN_HELD_REQUEST_RECOVERY.md for the still-required recovery-read lane and
evidence-bound owner release design. Tests verify inspection leaves files unchanged.

Separate recovery reader update: an internal broker method uses a different,
verified read-only key to inspect an acknowledged order on the original reported
account. Its only methods are GetApiKeyInfo and QueryOrders. It rejects original
trading-key reuse, wrong owner/account, missing bindings and trading permissions.
The original lane stays locked and untouched. Empty order evidence stays unknown;
no unlock, execution, settlement or credential storage was added. This is not yet
an owner-facing recovery workflow, and lost acknowledgements remain unresolved.

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
