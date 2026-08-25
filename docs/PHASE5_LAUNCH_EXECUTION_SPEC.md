# AITT Phase 5 — Audited TGE/Launch Execution Readiness

**Status:** SPECIFICATION — evidence incomplete, launch HOLD, not deployed

**Owner:** CALLY

> Phase 5 prepares an audited, reproducible launch package. It does not authorize or perform deployment, token issuance, conversion opening, external transferability, Phase 4 activation, pair creation, or liquidity.

## Scope

Phase 5 covers only:

1. Freeze one reviewed release target: source commit, dependency lockfiles, compiler/tool versions, deployment configuration payload, compiled creation/deployed bytecode fingerprints, and candidate runbooks.
2. Collect signed, independently attributable external-audit, counsel, governance/Safe-review, beneficiary/config-review, and owner evidence. Internal tests, Slither, Mythril, and project review records are supporting evidence, not an independent external audit.
3. Finalize the owner-approved eligible-points cutoff, whole-point cap, canonical snapshot hash, eligible total, exact shortfall result (if any), and 1:1 converter-reserve requirement without inventing values.
4. Rehearse deployment, verification, allocation custody, and ownership handoff offline on an ephemeral local Hardhat chain using no production keys, production configuration, or public RPC.
5. Record reproducible build evidence, the post-deploy verification plan, rollback/abort boundaries, incident response, communications ownership, and explicit CALLY launch authorization.

## Dependencies

- `docs/PHASE1_SPEC.md`, `docs/TOKENOMICS.md`, and `docs/AITT-Whitepaper-v1.0.md` remain authoritative for approved Phase 1 mechanics.
- `docs/AITT_LAUNCH_READINESS.md` remains the operational hold matrix.
- `docs/AITT_REVIEW_2026-08-24.md` records the current review disposition; historical findings are not silently rewritten.
- `docs/PHASE4_BRIDGE_DEX_SPEC.md` remains separate and disabled. Phase 5 does not satisfy any Phase 4 gate.
- The current release-approval fingerprints and deployment journal are internal enforcement mechanisms. They do not create external audit, counsel, Safe, beneficiary, or owner approval.

## Hard holds

Launch execution remains blocked if any item is absent, stale, inconsistent, unsigned, untraceable, or not bound to the frozen release target:

- Independent external smart-contract audit and disposition of every launch-blocking finding.
- Signed counsel evidence for the exact launch posture; prior Phase 1 utility-framing clearance is not approval for staking revenue/APY, external transferability, or Phase 4 liquidity.
- Existing go-live prerequisites are satisfied and evidenced: a real user base, real fee revenue, and at least three months of allocation modelling. These are launch dependencies, not assumptions created by the Phase 5 evidence package.
- Reviewed Safe owners/threshold/configuration, final beneficiaries, operator, inactive future-distribution recipient, and Phase 4-disabled deployment configuration.
- Owner-approved eligible-points cutoff and numeric cap, successful canonical snapshot finalization, and exact 1:1 funded reserve requirement. Oversubscription remains fail-closed with no pro-rata rewrite.
- Reproducible source/build/config fingerprints and an offline rehearsal whose outputs reconcile exactly.
- Approved post-deploy verification, abort/incident runbook, named responders, and evidence-retention location.
- Explicit, signed CALLY authorization for the frozen target after all evidence is complete.
- A separate final public-chain deployment gate. Phase 5 acceptance alone must never trigger a transaction.

## Required evidence artifacts

Artifacts must be immutable or content-hashed, dated, attributable, and reference the frozen target where applicable. No private keys, secrets, raw credentials, or sensitive signer material may be stored.

| Artifact | Minimum content |
|---|---|
| Release-target record | Commit ID; clean-tree proof reference and nonzero content hash; lockfile/toolchain versions; target-bound fixture-only chain-intent reference and nonzero content hash; canonical config payload hash; contract creation/deployed bytecode bundle hash; required candidate-runbook references and hashes |
| External-audit evidence | Signed final report identity/hash; auditor identity; scope; version/commit reviewed; finding disposition; explicit limitations |
| Counsel evidence | Signed advice identity/hash; jurisdiction and exact approved launch posture; exclusions and conditions |
| Governance/config review | Safe identity and threshold review; beneficiary/operator/recipient review; Phase 4-disabled confirmation; reviewer signatures/hashes |
| Points package | Cutoff; approved cap; canonical eligible balances hash; eligible total; provisional-point exclusion proof; oversubscription result; reserve base units; owner approval |
| Offline rehearsal record | Local-only network proof; ephemeral accounts; commands; tool versions; transaction journal; deployed bytecode/config hashes; verification results; ownership-handoff checks; cleanup/abort result |
| Reproducible build record | Exactly two clean checkout inputs; unique target/run-bound execution-proof references and nonzero content hashes; dependency/compiler versions; deterministic artifact hashes; target-matched candidate-runbook references/hashes; independent rerun comparison |
| Verification plan | Exact post-deploy chain, bytecode, binding, allocation, reserve, ownership, manifest, source-verification, and fail-closed runtime checks; evidence capture and stop conditions |
| Incident/rollback runbook | Pre-first-transaction abort; partial-deployment stop/reconcile; compromised signer response; RPC mismatch; failed verification; communications, escalation, and evidence preservation |
| CALLY authorization | Signed explicit authorization naming the frozen target and evidence index; separate from any key use or transaction execution |

### Local reproducible-build record procedure

`lib/phase5-reproducible-build.js` validates fixture-only metadata for exactly two independently evidenced local, ephemeral, clean-tree build runs against one validated release-target record. The frozen target requires a clean-tree-proof reference/content hash and one reference/content hash for each deployment, verification, and incident candidate runbook. Each run must carry a unique execution-proof reference/content hash explicitly bound to its run ID and target ID, reproduce the target's clean-tree proof, runbooks, source, root and contract lockfiles, Node/npm/Hardhat/solc references, compiler settings, configuration, and creation/deployed bytecode bundle hashes, and reject reused proof evidence. Fixture references stand in for required immutable artifacts in tests; later evidence population must resolve the references to real content-hashed proof artifacts rather than treating a run ID or asserted tree state as proof. The helper reads no Git state, production configuration, environment secrets, private keys, public RPC, or deployment output; callers must obtain clean-tree and execution proof independently from actual clean checkouts and content-hash them before validation.

A passing local record is supporting reproducibility evidence only. It is not an independent external audit, release authorization, approval, deployment instruction, or proof that the current working tree is clean. The schema therefore accepts only `local-fixture`/`local-ephemeral` records under explicit HOLD with both audit and authorization claims set to false.

## Acceptance criteria

Phase 5 is ready for final launch authorization review only when:

1. One immutable evidence index resolves every required artifact and binds it to the same source/config/bytecode target.
2. External audit and counsel evidence are signed and independently attributable; internal tooling is labeled accurately.
3. The real-user-base, real-fee-revenue, and three-month allocation-modelling prerequisites are evidenced with no unresolved exception.
4. Safe, beneficiaries, operator, future recipient, and Phase 4-disabled configuration have no unresolved mismatch.
5. The points snapshot is final, owner-approved, within the approved cap, and matched by the exact reserve requirement; otherwise HOLD.
6. Two clean offline build/rehearsal runs reproduce the required fingerprints and pass all local verification and ownership-handoff checks.
7. The post-deploy verification and incident runbooks define named owners, stop conditions, evidence capture, and no unsafe automatic continuation.
8. CALLY signs the final authorization for that exact evidence index and frozen target.
9. Repository/runtime state remains pre-launch: no public-chain deployment, issuance, conversion, transferability, Phase 4, pair, or liquidity action has occurred.

## No-deployment boundary

This specification authorizes preparation and local rehearsal only. Public RPC calls, funded accounts, private keys, production deployment configuration, token issuance, conversion opening, contract-address publication, ownership transfer on a public chain, Phase 4 activation, pair creation, and liquidity operations are prohibited during Phase 5 readiness work. A later, separately approved final gate must name the exact frozen target, operator, network, execution window, and stop conditions before any public-chain command may run.
