# AITT Phase 5 Execution-Readiness Plan

## Boundary

Prepare auditable launch evidence and offline rehearsal only. Do not deploy, call a public RPC, use keys/secrets, issue tokens, open conversion or transferability, enable Phase 4, create a pair, add liquidity, or mutate release gates.

## Ordered slices and checkpoints

1. **Freeze-record contract**
   - Define the release-target and evidence-index fields without adding approvals or values.
   - Checkpoint: CALLY approves the artifact contract; every field can be derived or externally supplied and content-hashed.

2. **Local evidence validator**
   - Add a standalone validator and fixtures for structure, nonzero evidence hashes, signatures/attribution references, cross-artifact target binding, and prohibited secret fields.
   - Keep it separate from `deploy.js` and runtime release gates.
   - Checkpoint: focused negative/positive tests pass; invalid, incomplete, mixed-target, and secret-bearing evidence fails closed.

3. **Release-target freeze procedure**
   - Capture clean commit, a clean-tree-proof reference and content hash, lockfiles, toolchain/compiler versions, a target-bound chain-intent reference and content hash, config payload fingerprint, creation/deployed bytecode bundle fingerprint, and candidate runbook references/hashes.
   - Checkpoint: two independent clean checkouts each provide unique run/target-bound execution-proof references and hashes while reproducing the same frozen fingerprints; no address or numeric cap is invented.

4. **External evidence intake**
   - Collect signed external-audit, counsel, Safe/config/beneficiary review, and owner evidence; record provenance, scope, limitations, hashes, and target bindings.
   - Inherit and evidence the existing go-live prerequisites: real user base, real fee revenue, and at least three months of allocation modelling.
   - Checkpoint: independent audit is clearly distinguished from internal tests/static analysis; unresolved launch-blocking findings keep HOLD.

5. **Final points package**
   - With owner-supplied cutoff and cap, produce the canonical eligible snapshot, exclusion proof, eligible total, oversubscription/shortfall result, and exact 1:1 reserve requirement.
   - Checkpoint: owner approval exists; oversubscription creates no final snapshot and no pro-rata conversion.

6. **Offline deployment and ownership-handoff rehearsal**
   - Run only on an ephemeral local Hardhat chain with ephemeral accounts and isolated configuration.
   - Capture journals, contract/config/bytecode bindings, allocations, converter reserve, Safe-role handoff simulation, zero-deployer balance, and cleanup/abort behavior.
   - Checkpoint: two clean runs reconcile and pass exact local verification; no public endpoint or production material is used.

7. **Post-deploy verification plan**
   - Specify public-chain checks to be executed only after a separately authorized deployment: chain, bytecode, source, immutable bindings, custody, reserve/liabilities, ownership, manifest, runtime fail-closed state, and evidence retention.
   - Checkpoint: every mismatch has an explicit stop condition; no failed check can open conversion or publish an active route.

8. **Abort, rollback, and incident runbook**
   - Cover pre-transaction abort, partial deployment, failed verification, RPC disagreement, signer compromise, ownership mismatch, reserve mismatch, communications, escalation, and evidence preservation.
   - Checkpoint: named responders perform a tabletop rehearsal and sign the result; rollback claims do not imply deployed immutable contracts can be erased.

9. **Final evidence review and CALLY authorization**
   - Resolve one immutable evidence index to one frozen target and obtain explicit signed CALLY authorization.
   - Checkpoint: all Phase 5 acceptance criteria pass and a separate public-chain execution gate remains closed.

10. **Separate final deployment gate — out of scope**
    - A later owner-approved procedure must name the exact target, operator, network, execution window, and stop conditions.
    - Checkpoint: no command is run merely because Phase 5 evidence is complete.

## Next smallest slice

Define the standalone Phase 5 evidence-index schema and local fixtures, then add a validator test that has no import or mutation path into deployment/runtime release gates. Do not populate real approvals, addresses, cap values, audit results, or signatures in fixtures.
