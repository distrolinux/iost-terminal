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
4. Integrate and acceptance-test the internal separate-credential recovery reader
   through an owner-authorized workflow. It cannot submit or cancel orders; the
   owner-facing credential and recovery workflow is not yet implemented.
5. Require an audited, evidence-bound owner recovery decision and prove crash,
   race and replay behavior before any lock-release operation is implemented.

There is intentionally no unlock command, stale-lock expiry or automatic retry.
Restarting alone will not clear a held request. Current diagnostic classification
is a prerequisite for recovery, not a completed recovery workflow.

## Internal separate-credential recovery reader

The draft now includes a broker method that uses a separately provisioned
read-only credential. It accepts only GetApiKeyInfo and QueryOrders, validates
the key's reported read-only permissions/expiry, and matches its reported account
against the original private account binding. It does not send a request using
the held trading credential and never modifies that credential's lock/nonce.
The recovery key uses its own normal coordinated request lane.

Only an acknowledged, exactly bound order can be inspected. Unknown/missing
venue IDs remain unresolved; empty responses are not rejection evidence. No
fill ledger, fee settlement, history write, hold release or resubmission occurs.
The original credential remains necessary to validate the original binding.
Missing/lost original credentials need a separately reviewed recovery design.

There is no UI, HTTP/MCP endpoint, recovery-key storage or automatic provisioning
in this phase. Do not paste or send keys to an agent. A real owner-controlled
credential workflow and end-to-end acceptance review are still required.
