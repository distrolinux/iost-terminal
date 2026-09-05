# Execution Reconciliation Engine

IOST Terminal 1.39 adds a deterministic, read-only truth check across each
paper account's execution intents, tamper-evident receipts, positions, journal,
and cash ledger. New agent exposure fails closed when those records disagree.
Existing positions remain under Position Guardian protection.

## Safety contract

- Pending work recovered after a restart is `outcome-unknown`. It is never
  automatically retried. The owner must review the durable evidence.
- A terminal intent must resolve to exactly one chained execution receipt.
- Intent and receipt actions must agree.
- Accepted opens and closes must agree with the paper journal and position
  lifecycle. Legacy open receipts without a position link are reported as a
  coverage warning, not silently invented.
- Position/journal pairs, status transitions, and the cash identity are checked.
- Receipt-chain corruption, unknown outcomes, duplicate terminal evidence, or
  ledger contradictions block new agent exposure.
- The engine cannot reserve funds, place or close a trade, change permissions,
  use live scope, or perform a public-chain action.

The MCP tool `paper_execution_reconciliation` and private no-store REST route
`GET /api/execution-reconciliation` expose sanitized findings using opaque
references only. Agent Execution Readiness consumes the same result, so the
decision is bound into later preflight evidence.

## Standards alignment

The state model follows the separation of an execution event from current order
status described by the [FIX Trading Community order-state specification](https://www.fixtrading.org/online-specification/order-state-changes/).
Its retry policy follows [AWS durable execution idempotency guidance](https://docs.aws.amazon.com/durable-execution/patterns/best-practices/idempotency/):
external side effects with an unknown outcome require at-most-once handling, not
an unsafe claim of exactly-once execution. Reusing an idempotency token returns
the original result, while changed parameters remain a conflict, consistent
with the [AWS Well-Architected idempotency practice](https://docs.aws.amazon.com/wellarchitected/2024-06-27/framework/rel_prevent_interaction_failure_idempotent.html).

## Owner interpretation

- `healthy`: all available durable evidence reconciles.
- `attention`: execution remains consistent, but historical evidence has a
  documented coverage gap.
- `blocked`: a critical contradiction exists. New agent exposure is denied and
  owner review is required. No automatic repair or retry is attempted.
