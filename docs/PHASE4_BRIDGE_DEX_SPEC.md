# AITT Phase 4 — Bridge, Wrapper, and PancakeSwap Architecture

**Status:** DESIGN SPECIFICATION — not implemented, not audited, not deployed

**Owner:** CALLY

**Last reviewed:** 2026-08-24

**Security companion checklist:** `/opt/data/profiles/secbot/workspace/2026-08-24-aitt-phase4-security-requirements.md`

> This document defines the minimum architecture required before AITT Phase 4 external liquidity can be considered. It does not authorize deployment, bridge activation, pair creation, liquidity addition, token transfer, or release-gate changes.

## 1. Locked facts and scope

### Locked facts

- AITT's canonical home chain is IOST L2, chain ID 182.
- AITT has a fixed initial supply of 1,000,000,000 tokens and 8 decimals.
- Protocol burns share the existing 800,000,000 total-supply floor.
- Phase 4 is disabled; AITT remains pre-launch.
- The intended DEX is PancakeSwap on BNB Smart Chain, chain ID 56.
- The existing L2 AMM tax is a dormant, pair-gated mechanism. It is not automatically portable to another chain or wrapper.

### Scope

This specification covers:

1. Canonical-supply-preserving movement between IOST L2 and BSC.
2. A BSC representation of AITT, if external liquidity remains approved.
3. PancakeSwap pair creation, verification, liquidity custody, and public-route gating.
4. Monitoring, incident response, tests, audit evidence, and release gates.

### Non-goals

- No independent BSC token supply.
- No second canonical AITT origin.
- No bridge implementation in this document.
- No public-chain deployment or liquidity operation.
- No token sale, yield promise, staking-revenue activation, or governance activation.

## 2. Recommended canonical supply model

The recommended model is **canonical L2 escrow plus authenticated BSC wrapper minting**:

- AITT on IOST L2 remains canonical.
- A bridge escrow on L2 holds canonical AITT before an equivalent BSC representation is minted.
- A BSC wrapper mints only after an authenticated, finalized L2 lock message.
- BSC wrapper tokens are burned before an authenticated, finalized BSC burn message releases escrowed canonical AITT on L2.
- The BSC wrapper never mints from an operator balance and never creates independent supply.

The global conservation invariant must be machine-checked:

```text
L2 circulating supply
+ L2 escrowed canonical supply
+ BSC wrapper supply
+ finalized/pending bridge liabilities
= initial supply - protocol burns
```

All quantities must be normalized to 8-decimal AITT base units. Pending messages must be represented explicitly so a temporary observation gap cannot be mistaken for available supply.

The bridge must reject any operation that would make the invariant negative, exceed the initial supply, or create an unmatched liability.

## 3. Transfer lifecycle

### L2 → BSC

1. User requests a transfer with destination chain, recipient, amount, and a unique operation ID.
2. L2 escrow locks the exact amount.
3. Escrow emits a canonical lock event containing the operation ID, source domain, destination domain, token origin, amount, sender, recipient, and finality reference.
4. Bridge observers wait for the configured L2 finality threshold.
5. An authenticated threshold message is submitted to the BSC wrapper.
6. The wrapper verifies domain, token origin, amount, recipient, operation ID, nonce, signer threshold, and non-consumption.
7. The wrapper marks the operation consumed and mints exactly the locked amount.

### BSC → L2

1. User burns the exact wrapper amount.
2. Wrapper emits a burn event with the same binding fields and a unique operation ID.
3. Observers wait for configured BSC confirmations/finality.
4. An authenticated threshold message is submitted to L2 escrow.
5. Escrow verifies the message and that the operation has not been consumed.
6. Escrow marks the operation consumed and releases exactly the locked amount to the bound recipient.

Partial execution, duplicate execution, changed recipient, changed amount, wrong domain, wrong token origin, and reused operation IDs must all fail.

Every operation must have an explicit state machine:

```text
initiated → source-finalized → message-attested → destination-executed → completed
                                      ↘ failed/refundable
```

State transitions must be atomic, monotonic, event-logged, and idempotent. A retry may advance an incomplete operation but may never mint, release, refund, or close the same operation twice. A governance-marked failed proof is terminally non-executable: its consume path must revert permanently, and only the explicitly bound refund/recovery path may resolve it subject to expiry, failure state, and recipient rules.

## 4. Message and authorization requirements

Every bridge message must be domain-separated and bind at least:

```text
protocol identifier
message version
source chain ID and domain
destination chain ID and domain
canonical token address
wrapper address
operation ID
monotonic nonce
amount in canonical base units
source sender
 destination recipient
source event transaction/block reference
expiry or validity window
```

Required controls:

- EIP-712 or equivalent typed-data hashing.
- Separate source and destination domain separators.
- Monotonic nonce and consumed-message mapping.
- One-message/one-mint and one-message/one-release enforcement.
- Threshold authorization; never a single EOA relayer.
- Signer set, quorum, and rotation recorded on-chain.
- Signer rotation protected by a timelock and multisig governance.
- Explicit contract and implementation version binding.
- No message acceptance from an unfinalized source event.

## 5. Finality and reorganization policy

Before activation, the project must define and test:

- L2 confirmation/finality threshold.
- BSC confirmation/finality threshold.
- Maximum reorg depth tolerated.
- Behavior when an observed source event disappears or changes.
- Observer disagreement handling.
- RPC failure and stale-head handling.
- Reconciliation after a bridge pause or chain reorganization.

Activation proofs must record the observed finalized block number and block hash. A single latest-RPC observation is insufficient for release.

## 6. Emergency controls and recovery

The bridge and wrapper must support independent controls for:

- Deposits/locks.
- Authenticated minting.
- Authenticated releases.
- Wrapper transfers, if the tax policy requires a pause.

Required safety properties:

- Pause authority is a reviewed multisig, not one EOA.
- Pause and resume actions are timelocked where practical and fully logged.
- Per-message and per-day limits exist.
- Rate-limit trips fail closed.
- Rescue cannot withdraw locked backing or create supply.
- Stranded-message refunds are deterministic, recipient-bound, and cannot double-pay.
- Emergency upgrades, if allowed at all, are timelocked, version-pinned, and externally audited.
- Incident mode preserves an auditable state transition and requires post-incident reconciliation before resume.

## 7. Wrapper economics and tax policy

### Recommended launch policy

Use **no tax on bridge custody, wrapper mint/burn, or ordinary BSC wrapper transfers**. Keep the current 3% pair-gated tax explicitly L2-only unless a separately audited BSC tax design is approved.

This avoids:

- Tax-on-tax during bridge operations.
- Ambiguous cross-chain burn attribution.
- Decimal and rounding drift.
- LP add/remove surprises during bootstrap.
- A BSC burn being incorrectly counted against the L2 floor.

If BSC buy/sell tax is later required, it must be a separate audited mechanism with:

- Pair-only classification.
- Explicit LP add/remove behavior.
- Exact recipient accounting.
- A defined relationship to the single global burn floor.
- Fee-on-transfer-compatible router operations.
- Dedicated tests for all rounding and floor-boundary cases.

Wrapper decimals, total supply, mint/burn roles, allowance behavior, and rounding must be explicitly specified and tested. No assumption may be made that L2 `_update` behavior carries across chains.

## 8. PancakeSwap deployment and verification

PancakeSwap must be treated as a separate deployment stage after bridge verification.

Before any public route is exposed, verify at a finalized BSC block:

- Chain ID is 56.
- Wrapper bytecode exists and matches the audited implementation or approved immutable code hash.
- Wrapper is bound to the canonical L2 token and the approved bridge.
- Exact PancakeSwap factory address is allowlisted.
- Exact PancakeSwap router address is allowlisted and its factory matches the approved factory.
- Pair bytecode exists.
- Pair assets are exactly wrapper + approved quote token.
- Factory lookup resolves to the exact pair.
- Wrapper decimals and quote-token decimals are expected.
- Pair reserves are nonzero and within approved launch bounds.
- Pair creation and initial-liquidity receipts are recorded.
- LP ownership is held by the approved multisig or audited lock mechanism.
- The public swap URL pins chain, wrapper, quote asset, and approved route parameters.

The current L2-only `setAmmPair.js` must not be reused as a BSC deployment workflow.

## 9. Liquidity bootstrap

Liquidity bootstrap requires a dedicated, reviewed multisig-owned liquidity manager or an equivalent approved custody process.

The runbook must define:

- Initial price and reserve calculation.
- Exact token and quote amounts.
- Allowance/permit scope.
- Deadline and minimum-output/slippage limits.
- Fee-on-transfer handling, if applicable.
- Pair creation receipt and reserve verification.
- LP token custody, lock duration, and recovery policy.
- A no-trade/no-route window until all post-bootstrap proofs pass.

No liquidity may be added from an unreviewed EOA or through an unverified router.

## 10. Runtime and UI gates

The existing fail-closed gates remain necessary but are insufficient for Phase 4. Trading access must additionally require verified proofs for:

- Canonical L2 token ↔ bridge escrow binding.
- Bridge escrow ↔ BSC wrapper binding.
- Wrapper supply versus escrow reconciliation.
- Authenticated signer set and quorum.
- Finalized verification block/hash.
- Exact allowlisted PancakeSwap factory and router.
- Pair reserves and quote-token identity.
- Bridge pause state and rate-limit state.
- Fresh monitoring heartbeat.

Any RPC error, stale proof, disagreement, or mismatch must blank the swap URL and report Phase 4 as disabled.

## 11. Monitoring and incident response

Before activation, the project must monitor and retain tamper-evident records for:

- Canonical supply, escrow solvency, wrapper supply, and pending liabilities.
- Aged messages, nonce gaps, duplicate attempts, signer anomalies, and mint/release velocity.
- RPC/finality health, code hashes, proxy implementations, role changes, signer rotation, and upgrades.
- Pair reserves, price deviation, LP custody, bridge fees, and abnormal DEX execution.

Critical invariant breaches, reserve shortfalls, finality disagreements, signer anomalies, and abnormal velocity must page responders and automatically pause the affected lane where safe. The incident runbook must define pause order, signer revocation, evidence preservation, user communication, refunds, reconciliation, and controlled reopening. Monitoring must have an owner and exercised recovery drills.

## 12. Required test matrix

A local dual-chain fixture must cover:

- Lock/mint happy path.
- Burn/release happy path.
- Wrong chain/domain.
- Wrong canonical token or wrapper.
- Wrong recipient or amount.
- Duplicate operation and replay.
- Nonce gap and reuse.
- Invalid signer threshold.
- Signer rotation and timelock.
- Unfinalized source event.
- Reorg/disappearing event.
- RPC disagreement and stale head.
- Pause/resume and rate limits.
- Stranded-message refund.
- Escrow insolvency.
- Supply cap and global-invariant violation.
- Decimal conversion and rounding.
- Wrapper transfer/tax policy.
- L2 800M burn-floor boundary.
- Pair/router/factory mismatch.
- LP add/remove behavior.
- Reserve and slippage bounds.
- UI/API fail-closed behavior for every failed proof.

## 13. Release gates

Phase 4 remains closed until all of the following exist and are independently verified:

1. Approved architecture and threat model.
2. Implemented bridge escrow and BSC wrapper.
3. Local dual-chain test suite passing.
4. Static analysis and adversarial testing.
5. External bridge/wrapper smart-contract audit.
6. External review of PancakeSwap and liquidity custody flow.
7. Refreshed counsel approval covering external transferability and liquidity.
8. Reviewed governance Safe, signer quorum, and recovery contacts.
9. Finalized deployment manifests and code hashes.
10. Testnet rehearsal with reconciliation evidence.
11. Mainnet deployment approval explicitly signed by CALLY.
12. Live finalized-chain proofs before exposing any swap route.

## 14. Open decisions for owner approval

Before implementation, CALLY must approve:

- The bridge messaging model: audited third-party bridge versus project-controlled threshold attestation.
- BSC wrapper tax: recommended **zero tax** at launch.
- BSC quote asset and PancakeSwap version.
- Signer quorum, multisig owners, and rotation policy.
- Confirmation/finality thresholds.
- LP custody and lock policy.
- Bridge fee policy and fee recipient.
- Emergency pause and refund authority.
- Whether external liquidity is still required after the L2-only launch review.

**Current disposition:** `status=design`, `phase4Enabled=false`, `trading.enabled=false`, no token deployed, no bridge deployed, no pair created, and no liquidity added.

## 15. #4B local prototype disposition

The first #4B slice exists only as a Hardhat-local prototype under
`contracts/contracts/Phase4*.sol` with tests in `contracts/test/Phase4Prototype.test.js`.
It demonstrates and tests:

- fixed-supply local canonical fixture → escrow lock → threshold-attested wrapper mint;
- wrapper burn → threshold-attested escrow release;
- domain/token/wrapper binding, replay rejection, nonce checks, pause behavior, expiry checks, and a complete round-trip supply/backing check.

The prototype is **not** an implementation of the Phase 4 release architecture and
does not authorize deployment. This slice adds only a manually driven local source-event
proof harness: source contracts register lock/burn records, tests explicitly mark those
records finalized, and destination execution binds and consumes the exact proof fields.
The local finality toggle is not a real chain finality oracle and provides no production chain or RPC safety. The local-only prototype now includes a DEX/LP harness and a separate fixture pinning the official PancakeSwap v2 BSC chain, factory, and router identities. These fixtures do not prove live BSC code, router/factory state, pair identity, receipt-bound bootstrap amounts, production custody, or UI fail-closed integration. Multisig/timelocked governance, incident reconciliation, production-grade rate-limit operations, live finalized-chain verification, and independently reviewed liquidity custody remain mandatory before any testnet or public-chain work.

The local proof harness also keeps one global operation registry shared by both
directions: a lock/mint operation ID cannot be reused for burn/release, and vice
versa. Slice 1 additionally binds the local attestation context to a protocol
identifier, message version, chain IDs, verifier/bridge instance, escrow, wrapper,
and canonical token; adds a local multisig/timelock harness for signer rotation and
revocation; and applies per-message plus rolling-window daily limits. Configuration/finality/limit controls are governance-only after an
explicit one-time local bootstrap that activates and locks the binding; the owner
cannot reconfigure those controls afterward. The verifier also exposes an explicit
local operation-state vocabulary (`initiated`, `source-finalized`, `message-attested`,
`destination-executed`, `completed`, `failed`, `refundable`, `refunded`). Slice 2
adds deterministic, recipient-bound lock refunds and original-sender burn recovery
only for locally registered expired/failed proofs that remain unconsumed, plus local
backing/supply/liability reconciliation assertions. These are atomic local fixture
operations, not real chain finality or production recovery. The governance harness rejects
revoked verifier signers from approving verifier security proposals. Governance
provenance is also bound to the canonical local `Phase4GovernanceFactory`: the
verifier checks the factory runtime code hash and accepts only governance addresses
recorded by that factory. An EOA, arbitrary contract, or contract that merely
spoofs the old marker cannot satisfy this check.

This factory/registry is a local provenance harness, not production governance or
a deployment authority. `Phase4Governance` is not a production Safe, and the
factory, verifier, escrow, and wrapper must not be deployed to a public chain or
used as evidence of Safe ownership, production timelocks, bridge security, or
release readiness. The finality toggle is not a chain oracle, and no real chain
finality, reorg safety, observer quorum, deployment, or bridge security is claimed.
