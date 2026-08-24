# AITT Token Smart-Contract Independent Review — 2026-08-24

> **Post-review remediation:** The same-day readiness pass addressed the actionable source findings: protocol-burn wording now excludes arbitrary sink transfers; verification checks every token binding/allocation/clean state with a derived count; governance claims are labeled proposed; new approvals can be closed irreversibly; claim snapshots are resumable with receipt-event evidence; deployment approval is bound to the exact config plus creation and deployed bytecode; every deployment transaction is journaled at submission/confirmation; DEX activation requires live pair verification; and live release accounting survives legitimate claims/releases. The full platform suite and **72 contract tests** pass. Remaining holds are external audit/toolchain migration, refreshed counsel, governance Safe configuration, final snapshot/reserve, and Phase 4 bridge/liquidity design. No public-chain deployment occurred.

## Current disposition

| Area | Current status |
|---|---|
| Protocol-burn guarantee | Resolved: 200M protocol-burn cap is derived from fixed 1B supply and the shared 800M `totalSupply()` floor; arbitrary sink transfers are explicitly excluded. |
| Verification | Resolved: token bindings, allocations, schedules, initial state and derived assertion count are checked with negative tests. |
| Conversion closure | Resolved: new approvals can be closed irreversibly while existing approved claims remain payable. |
| Deployment approval | Resolved in source: approval is bound to the exact config, chain and compiled contract bundle before the first transaction. |
| Deployment/claim recovery | Resolved in source: every transaction is journaled at submission/confirmation and chunked claim approvals resume only from confirmed manifest evidence. |
| Wallet/DEX activation | Resolved in source: Add Token requires live deployment verification; DEX activation requires live pair/factory/assets verification and exact swap-token URL binding. |
| External audit, counsel, Safe, final reserve, Phase 4 bridge/liquidity | **Still HOLD.** These require external evidence and explicit CALLY approval. |

The remainder of this document is the **historical pre-remediation review snapshot**. Findings marked open below describe the source as it existed when reviewed and are superseded by the current disposition above plus `AITT_LAUNCH_READINESS.md`.

## Historical review snapshot (pre-remediation)

**Verdict: NOT SOUND for deployment.** The fixed-supply ERC-20, swap-tax arithmetic, FeeRouter split, vesting math, converter liability accounting, and milestone-vault timelock are internally sound, but the locked global burn-cap promise is still not enforceable against dead-address transfers and several verification, governance, tooling, bridge, and counsel-level gaps remain open.

This was a read-only review. No deployment, transaction, compilation, contract test, or state-changing command was run. The scoped JavaScript files passed `node --check`; allocation arithmetic was independently checked as 1,000,000,000 whole AITT; `npm audit --json` reported 0 Critical, 17 High, 10 Moderate, and 19 Low development-tree advisories. The apparent truncation in `hardhat.config.js:26` was treated as a tool-display artifact because byte inspection and `node --check` succeeded; no syntax finding is filed.

## 2. Severity table

| Severity | File:line | Issue | Recommendation |
|---|---|---|---|
| **High** | `contracts/contracts/AITT.sol:149-153`; `docs/TOKENOMICS.md:91,159`; `contracts/AGENTS.md:12` | **The promised global 200M cap across contract burns plus dead-address burns remains unenforceable.** All sanctioned swap/router burns share the 800M `totalSupply()` floor, but an ordinary untaxed transfer to any nonzero sink/dead address still passes through `super._update`; it does not reduce `totalSupply()` and is invisible to burn headroom. This is explicitly deployment-blocking in the local contract. | Either redefine the enforceable guarantee as “contract/protocol burns stop at 800M total supply” and remove the global dead-address claim, or reject an explicit canonical sink set and account for those balances. No ERC-20 can prove that every arbitrary address is spendable, so do not promise a global usable-supply floor. |
| **Medium** | `contracts/scripts/verify-lib.js:53-70,78-90` | **Post-deploy verification can pass contracts with wrong immutable token bindings or wrong team/advisor allocations.** It does not verify `converter.token()`, vesting/vault `token()`, or team/advisor `totalAllocated()`. A contract with a compatible ABI could hold the expected AITT balance while releasing a different token or vesting the wrong amount. The function also hard-codes `checks: 46` rather than deriving the count. | Verify every custody contract's `token()` equals `C.token`; verify team/advisor `totalAllocated()`, start constraints, and initial `released/queued` state; increment a real check counter inside `pass()` and return it. Add negative tests for each mismatched immutable/invariant. |
| **Medium** | `docs/TOKENOMICS.md:66,202,244-245`; `contracts/contracts/AITTFeeRouter.sol:24-27`; `contracts/contracts/AITTMilestoneVault.sol:59-68` | **DAO enforceability claims exceed implementation.** Tokenomics says category reallocations require >66% of staked AITT and all fee parameters are DAO-adjustable, but fee splits are immutable constants and a vault owner can queue any recipient/amount without an on-chain vote, quorum, category restriction, or council veto. | Mark these as future/proposed governance policy, or place owner roles behind audited governance/timelock contracts that enforce proposal, quorum, supermajority, veto, and parameter-update rules. Immutable fee ratios must not be described as DAO-adjustable. |
| **Medium** | `docs/TOKENOMICS.md:175,186-188,233,257`; `docs/AITT-Whitepaper-v1.0.md:166,177-179,221,245` | **“AITT holders earn nothing/no implied return” conflicts with platform-fee and swap-fee revenue paid to stakers plus fee-share APY language.** The documents acknowledge the conflict and the refreshed-counsel gate is still open. | Keep staking revenue and external transferability inactive; obtain signed refreshed counsel guidance and replace the conflicting public language before release. |
| **Medium** | `docs/TOKENOMICS.md:43,269,297`; `docs/PHASE1_SPEC.md:104`; `contracts/contracts/AITT.sol:49-50,149-164` | **BSC/PancakeSwap bridge and tax portability remain unimplemented.** A single IOST-L2 AMM pair and token-owned supply floor cannot automatically govern a wrapped BSC token. Phase 4 is correctly blocked, but the promised external-liquidity design is not complete. | Keep Phase 4 disabled until an audited canonical bridge/wrapper design specifies lock/mint or burn/mint accounting, global supply reconciliation, wrapped-token tax behavior, emergency controls, and a verified pair. |
| **Medium** | `contracts/package.json:15-17`; `docs/PHASE1_SPEC.md:20-23` | **The isolated Hardhat development tree still has 17 High advisories.** `npm audit --json` returned 46 total vulnerabilities: 17 High, 10 Moderate, 19 Low, 0 Critical. These do not ship in token bytecode, but they affect build, RPC, verification, archive, and test tooling. | Keep builds isolated and accept only trusted inputs/RPCs. Test a separate Hardhat 3/toolbox 7 migration; do not apply a forced major upgrade immediately before launch. |
| **Low** | `contracts/contracts/AITTVesting.sol:84-90`; `docs/PHASE1_SPEC.md:10` | **`release()` is anyone-callable despite the runbook claiming beneficiary-only claims.** Funds can only reach the immutable beneficiary, so there is no theft, but a third party can force release timing and create accounting/privacy/operational grief. | Either require `msg.sender == beneficiary` or document keeper-style public triggering consistently. |
| **Low** | `contracts/contracts/PointsConverter.sol:128-150` | **The documented conversion window has no explicit close timestamp or terminal closed state.** Pausing is reversible and owner-controlled; existing approvals otherwise remain claimable indefinitely. | Add an immutable or governance-timelocked expiry/close state with defined treatment for outstanding approvals, then permit final reserve recovery only under that state. |
| **Info** | `contracts/contracts/AITTMilestoneVault.sol:59-82` | **A nonzero `evidenceHash` is metadata, not milestone validation.** The contract proves a hash was queued for 48 hours, but it cannot prove the evidence exists, matches a milestone, or was approved by a DAO. | Describe this as a governance-controlled delayed release with evidence anchoring, or add an audited approval/oracle/governance layer if “milestone-gated” is intended as an on-chain guarantee. |

### Explicit clean-category statements

- **No findings in category reentrancy.** FeeRouter, vesting, converter, and milestone-vault transfer paths are `nonReentrant` where needed; accounting/state is committed before outbound transfers. AITT inherits vanilla OpenZeppelin ERC-20 and introduces no receiver hooks.
- **No findings in category overflow/underflow.** Solidity 0.8 checked arithmetic protects relevant paths; reviewed subtraction invariants are maintained.
- **No findings in category ERC-20 compliance.** `AITT.sol:73-87` mints exactly once in the constructor, `AITT.sol:62-64` returns 8 decimals, no post-construction mint or public burn exists, and standard OZ allowance/transfer behavior is retained.
- **No findings in category vesting math.** `AITTVesting.sol:68-76` returns zero before the cliff, linearly vests after the cliff, and returns exactly `totalAllocated` at full vesting; `released <= vestedAmount` is preserved by transactional revert semantics.
- **No findings in category converter accounting.** `PointsConverter.sol:97-112` correctly handles re-approval and duplicate addresses, blocks approval below claimed, and checks aggregate outstanding after the loop; `PointsConverter.sol:121-140` preserves reserve/outstanding liabilities and withdrawal headroom.
- **No findings in category swap-tax arithmetic.** `AITT.sol:156-164` is symmetric for pair→wallet and wallet→pair, untaxed for wallet-to-wallet, and value-conserving: burn + stakers + treasury + recipient equals the input, with rounding dust left to the recipient.

## 3. Status of the 2026-08-23 findings

| # | Prior finding | Status | Current evidence |
|---:|---|---|---|
| 1 | Global 200M burn cap was not global | **PARTIALLY FIXED** | Sanctioned swap and router burns now share `_routeBurn` and the 800M floor (`AITT.sol:114-139`, `AITTFeeRouter.sol:88-100`), but arbitrary nonzero dead/sink transfers remain outside `totalSupply()` accounting (`AITT.sol:149-153`); `contracts/AGENTS.md:12` still marks this deployment-blocking. |
| 2 | 800M sent to ordinary wallets; custody/emission/timelock/DAO restrictions unenforced | **PARTIALLY FIXED** | Deployment now funds ecosystem vesting and four milestone vaults (`deploy.js:105-125,141-154`), but >66% DAO reallocation and governance claims remain policy-only (`TOKENOMICS.md:66,244-245`; `AITTMilestoneVault.sol:59-68`). |
| 3 | Points conversion lacked EVM binding, base-unit approval, atomic state, and receipt reconciliation | **FIXED** | Snapshot units and duplicate rejection are implemented (`claim-snapshot-lib.js:11-35`); EIP-191 binding and atomic reserved→approved→claimed plumbing are present (`lib/evm-wallets.js:27-71`, `lib/aitt-claims.js:39-85`); receipts are verified (`lib/aitt-chain.js:10-37`). |
| 4 | “Holders earn nothing” conflicted with staker revenue | **STILL OPEN** | Conflict remains explicit in `TOKENOMICS.md:175,186-188,233,257` and whitepaper `:166,177-179,221,245`; refreshed counsel remains an open gate (`PHASE1_SPEC.md:100`). |
| 5 | Circular launch gates; Boolean-only conversion gate | **FIXED** | Machine release gates now require deployed status, every address, manifest hash, audit, counsel, owner approval, Phase 4 disabled, and live verification (`lib/aitt-release-gates.js:12-35,38-43`; `PHASE1_SPEC.md:106-110`). Circular staking targets are no longer code prerequisites. |
| 6 | 50/20/30 fee split, staker accounting, burns, governance, DAO-adjustable parameters absent | **PARTIALLY FIXED** | FeeRouter now enforces 50/20/30 and shared burns (`AITTFeeRouter.sol:73-92`), but staking-accounting/governance contracts are absent and ratios are immutable despite DAO-adjustable documentation (`AITTFeeRouter.sol:24-27`; `TOKENOMICS.md:202`). |
| 7 | BSC/PancakeSwap bridge/tax/global-supply design absent | **STILL OPEN** | Explicitly listed as open and Phase 4 remains blocked (`PHASE1_SPEC.md:104`; `TOKENOMICS.md:269,297`). |
| 8 | One-time AMM setter lacked a guarded script | **FIXED** | `setAmmPair.js:13-41` verifies chain 182, bytecode, pair assets, factory result, current owner/router/pair state, typed confirmation, and post-call state. |
| 9 | `verify.js` exited zero, compared divided units, skipped addresses/invariants | **PARTIALLY FIXED** | Failure now propagates to nonzero exit (`verify.js:17-20`) and exact checks cover chain/bytecode/core balances (`verify-lib.js:15-22,35-89`), but token-binding and team/advisor-allocation invariants are still omitted (`verify-lib.js:53-70,78-90`). |
| 10 | Example emission schedule exceeded 100% | **FIXED** | The over-100% monthly example was removed; docs now specify exact 48-month linear emission (`TOKENOMICS.md:206-218`) and deployment uses a four-year linear vesting primitive (`deploy.js:105-117`). |
| 11 | Hardhat tree had 17 High advisories | **STILL OPEN** | Current `npm audit --json`: 17 High, 10 Moderate, 19 Low, 0 Critical; roots remain `package.json:15-17`. |
| 12 | Signal points lacked quality/Sybil/cap/expiry policy | **STILL OPEN** | Tokenomics still promises quality-verified rewards and 1:1 conversion (`TOKENOMICS.md:96-100,115-116`), while reserve/snapshot/anti-Sybil/expiry policy remains a pre-TGE operational requirement; no scoped contract enforces eligibility quality. |

**Baseline totals: 4 FIXED · 4 PARTIALLY FIXED · 4 STILL OPEN.**

## 4. New-contract findings

### AITTFeeRouter.sol — NEW review

**No new security finding.** The contract uses immutable token/recipient bindings, constructor zero-address guards (`:42-50`), exact balance-delta pulls (`:52-55`), `nonReentrant` external paths (`:59-66,96`), state-before-transfer accounting (`:73-92`), owner-only DAO burns (`:95-100`), and correct 50/20/30→64/36 routing. `platformFeePending` intentionally carries at most nine base units; this is documented and not economically material.

### AITTMilestoneVault.sol — NEW review

**One Info finding:** the required `evidenceHash` is only nonzero metadata (`:59-82`) and is not an on-chain proof that a milestone was met. Otherwise, no security defect was found: queue/cancel are owner-only (`:59-91`), the immutable 48-hour delay cannot be shortened (`:17,71,93-97`), execution is state-before-transfer and `nonReentrant` (`:93-103`), cumulative queued/released value is allocation-bounded (`:67-68,81,89,99-100`), excess recovery preserves all remaining liabilities (`:105-115`), and constructor/recipient/amount guards are present (`:50-66,106-108`). Anyone-callable execution cannot redirect funds and is suitable for keeper execution.

## 5. Doc-consistency check

**Overall: FAIL.** Core numerical mechanics match; governance, global dead-address-cap, counsel language, and future bridge promises do not yet match enforceable code.

| Item | Result | Evidence |
|---|---|---|
| 1B fixed supply; 8 decimals; no post-constructor mint/public burn | **PASS** | `AITT.sol:24-28,62-64,73-87,114-123` |
| Swap tax 3% = 1.8% burn + 0.8% stakers + 0.4% treasury; pair-only; symmetric | **PASS** | `AITT.sol:30-38,142-165`; `TOKENOMICS.md:88-93` |
| Sanctioned swap/platform/DAO burns share one 800M `totalSupply()` floor | **PASS** | `AITT.sol:114-139`; `AITTFeeRouter.sol:73-100` |
| Global 200M cap including dead-address burns | **FAIL** | `AITT.sol:149-153` permits ordinary transfers to any nonzero sink; `contracts/AGENTS.md:12` explicitly marks the global cap unresolved. |
| FeeRouter 50/20/30 before floor and 64/36 at floor | **PASS** | `AITTFeeRouter.sol:73-92`; `AITT.sol:131-139` |
| Allocation table sums to exactly 1B | **PASS** | `TOKENOMICS.md:55-63`; `deploy.js:14,107-124,141-150`; exact sum checked as 1,000,000,000. |
| Converter reserve drawn from ecosystem | **PASS** | `deploy.js:14,52-57,111-117,127-149` |
| Team/advisor schedules | **PASS** | `deploy.js:105-117`; `TOKENOMICS.md:59,63,211-212` |
| Ecosystem 48-month linear custody | **PASS** | `deploy.js:111-117,143`; `TOKENOMICS.md:57,210` |
| Treasury/partners/community/reserve 48h vault custody | **PASS** | `deploy.js:119-125,144-149`; `AITTMilestoneVault.sol:17,59-103` |
| Converter 1:1, operator snapshots, reserve-funded, pausable | **PASS** | `PointsConverter.sol:10-24,62-80,84-152`; `claim-snapshot-lib.js:3-35` |
| Conversion window expiry/closure | **FAIL** | `PointsConverter.sol:128-150` has pause/unpause and withdrawal but no expiry or irreversible closure state. |
| >66% DAO reallocation, governance veto, DAO-adjustable fee ratios | **FAIL** | Claims: `TOKENOMICS.md:66,202,244-245`; immutable/owner-only implementation: `AITTFeeRouter.sol:24-27`, `AITTMilestoneVault.sol:59-68`. |
| “Holders earn nothing” vs staker revenue share | **FAIL** | `TOKENOMICS.md:175,186-188,233,257`; whitepaper `:166,177-179,221,245`. |
| Network IOST L2 chain 182 | **PASS** | `hardhat.config.js:15-20`; `setAmmPair.js:13`; `TOKENOMICS.md:43` |
| BSC bridge/wrapped-token tax and supply reconciliation | **FAIL / DEFERRED** | `TOKENOMICS.md:269,297`; `PHASE1_SPEC.md:104` explicitly keeps this open and Phase 4 blocked. |
| PHASE1 “beneficiary-only claims” wording | **FAIL** | Claim: `PHASE1_SPEC.md:10`; public trigger: `AITTVesting.sol:84-90`. |
| Current deploy configuration is launch-ready | **FAIL / EXPECTED HOLD** | `deploy.config.json:1-15` omits required `stakersPool` and `governanceOwner`; preflight rejects them at `deploy.js:42-44`. This is fail-closed and matches the documented governance-config hold, not a contract vulnerability. |

## 6. Top 3 ranked recommendations

1. **Resolve the burn guarantee before deployment.** Choose an enforceable statement/design: protocol burns capped by the 800M `totalSupply()` floor, or a narrowly defined canonical sink accounting rule. Remove the impossible broad promise that all dead/inaccessible-address transfers are globally capped.
2. **Make deployment verification prove every immutable and allocation invariant.** Add token-binding checks for converter/vesting/vaults, team/advisor `totalAllocated`, clean initial state, and a derived check count; add negative verification tests.
3. **Align governance/legal promises with what is actually enforceable.** Keep fee revenue and Phase 4 inactive, complete refreshed counsel review, and either deploy audited governance contracts or relabel DAO voting, fee adjustability, veto, and milestone validation as future/off-chain policy.

## Review limitations

- This review did not execute Hardhat tests or compile contracts because the request prohibited executing state-changing work; even local-chain tests mutate ephemeral chain state and compilation writes artifacts/cache. Existing claims of 58/58 tests, Slither, and Mythril results were read as project records, not independently rerun.
- No live chain was queried and no deployment addresses were verified because the project is documented as undeployed/pre-launch.
- Existing unrelated working-tree changes were not modified.
