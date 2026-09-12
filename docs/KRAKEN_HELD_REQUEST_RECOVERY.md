# Held Kraken requests — recovery remains HOLD

The internal owner-bound broker recovery check reads local coordination metadata
only. It never calls Kraken, modifies a lock, changes a nonce or authorizes retry.
It is not yet exposed by HTTP/MCP or the website.

## Interpretation

- `held`: a request lock is present. The request may still be running; process
  liveness is unknown. A read-only request class does not prove other outstanding
  orders are safe or permit the lock to be removed.
- `unavailable`: storage, permissions, schema or nonce evidence could not be
  verified. Preserve the files and fail closed.
- `not-observed` / `no-lock-observed`: point-in-time absence only. Not a trading
  approval, a proof of no outstanding orders, or a recovery completion signal.
- Legacy plain-text locks are classified `unknown`, never automatically released.

## Required recovery work before a release mechanism

1. Establish exclusive control of every process/client using the key. An elapsed
   timeout or a PID check alone is not proof that an exchange request stopped.
2. Preserve private coordination, hold, acknowledgement and history evidence in
   a consistent protected backup; do not paste it into chat or public issues.
3. For a possible order action, reconcile the exact owner, credential, account,
   client/venue order identity, fills, cancellations and settlement records.
   Absence from open orders is not proof of rejection.
4. Design and test a separate authenticated recovery-read lane with monotonic
   nonce coordination that cannot submit or cancel orders. This is not implemented.
5. Require an audited, evidence-bound owner recovery decision and prove crash,
   race and replay behavior before any lock-release operation is implemented.

There is intentionally no unlock command, stale-lock expiry or automatic retry.
Restarting alone will not clear a held request. Current diagnostic classification
is a prerequisite for recovery, not a completed recovery workflow.
