# AITT Pre-Launch Review — 2026-08-23

## Verdict

**REMEDIATION IMPLEMENTED IN SOURCE — still HOLD for deployment/conversion.** The original findings below are preserved as the discovery record. Owner-approved v1.9 source changes resolve unified burn accounting, allocation custody, conversion plumbing, phase-gate enforcement, deployment preflight, and exact verification. Remaining external gates: independent audit (including FeeRouter Mythril rerun on a larger worker), refreshed counsel approval, governance Safe/config completion, and explicit owner deployment approval. Phase 4 remains disabled.

The fixed-supply ERC-20, swap-tax arithmetic, corrected team/advisor vesting, FeeRouter, allocation vaults, conversion state machine, and release gates are tested. This is an engineering/economic consistency review, not a legal opinion or an external smart-contract audit.

## Verified strengths

- `AITT.sol`: 1B initial supply, 8 decimals, no mint/external burn entrypoint.
- Swap tax is symmetric and value-conserving: 1.8% contract burn, 0.8% stakers recipient, 0.4% treasury recipient.
- Contract-level burns stop at an 800M `totalSupply()` floor.
- Team 150M and advisor 50M allocations use immutable cliff + linear vesting.
- `PointsConverter` keeps `totalOutstanding <= reserve`, prevents approval below already claimed, and protects conversion/withdraw paths.
- Hardhat: 58 tests pass after owner-approved remediation, including unified burn, vault custody, snapshot units, and exact deployment verification.
- Slither: no High/Medium findings; expected vesting timestamp and batch-loop gas notices.
- Mythril: AITT clean; expected vesting timestamp/external-call notices; generic `fundReserve` external-call/state-order warning, constrained by the immutable vanilla AITT dependency but worth defense-in-depth hardening.
- IOST L2 RPC answers chain ID 182.

## Original findings and current disposition

The engineering findings in the table below are the preserved discovery record. Unified burn accounting, allocation custody, conversion plumbing, machine release gates, AMM validation and exact verification were remediated in v1.9. The counsel, external-audit, governance-Safe, final snapshot and Phase 4 bridge/liquidity items remain launch holds.

| Severity | Finding | Evidence | Required resolution |
|---|---|---|---|
| High | The global 200M burn cap is not global. Dead-address fee/DAO burns do not reduce `totalSupply()` and are invisible to the swap-burn headroom. Effective usable supply could fall below 800M. | `contracts/contracts/AITT.sol:110-123`; `docs/TOKENOMICS.md:44,89-90` | Use one authoritative burn mechanism/counter. Prefer `_burn` for every path, or explicitly account for the single canonical dead-address balance in headroom and forbid alternate burn addresses. |
| High | 800M of allocations are sent to ordinary addresses. Only team/advisor 200M is contract-vested. The claimed ~10% initial circulation, 48-month emissions, milestone gates, treasury timelock, and DAO reallocation limits are not enforced. | `contracts/scripts/deploy.js:103-116`; `docs/TOKENOMICS.md:45,53-65,203-213,286` | Allocate ecosystem/treasury/partners/community/reserve to audited timelock/emission/milestone vaults or rewrite public promises to match wallet custody. |
| High | Points conversion is not an operational atomic flow. The app records an off-chain claim but does not bind a verified EVM address, submit `approveClaims`, capture a transaction, debit/freeze points atomically, or reconcile retries. | `lib/aitt.js:108-145`; `server.js:1423-1429`; `contracts/contracts/PointsConverter.sol:86-124` | Build snapshot → verified EVM address → base-unit approval (`points * 10**8`) → user claim → receipt reconciliation. Mark converted only after confirmation; make retries idempotent. |
| High | “Holders earn nothing/no profit sharing” conflicts with 50% platform-fee revenue to stakers, fee-share APY, buybacks, and 0.8% swap proceeds to a stakers pool. | `docs/TOKENOMICS.md:170-185,217-250`; `public/token.html:183-189` | Obtain fresh counsel review covering staking revenue, eligibility, transferability, geo restrictions, tax/disclosures—or remove passive revenue-share/value-accrual promises. |
| High | Launch gates are circular and code does not enforce them. TGE requires staked agents/40% staked, while staking is Phase 2 after Phase 1 issuance. `conversionOpen` is a single Boolean independent of status, addresses, reserve, users, or staking metrics. | `docs/TOKENOMICS.md:255-275`; `docs/PHASE1_SPEC.md:102-104`; `lib/aitt.js:22-37,115-124` | Replace the Boolean-only gate with a machine-verifiable release checklist and explicit human sign-off; reorder phase gates so prerequisites can exist before they are measured. |
| High | The locked 50/20/30 platform-fee split, staker accounting, fee burns, governance, and DAO-adjustable parameters are not implemented in Phase 1 contracts. | `docs/TOKENOMICS.md:182-199`; `contracts/contracts/AITT.sol:39-41,120-123` | Mark as proposed until audited fee/staking/governance contracts exist, or build those contracts before claiming enforceability. |
| Medium | BSC/PancakeSwap cannot automatically inherit the IOST L2 token’s single-pair tax or burn headroom. No wrapper/bridge accounting exists. | `contracts/contracts/AITT.sol:43-44,98-123`; `docs/TOKENOMICS.md:255-263,291` | Specify and audit canonical lock/mint or burn/mint bridge mechanics, wrapped-token tax behavior, global supply/burn reconciliation, and incident controls before Phase 4. |
| Medium | One-time `setAmmPair` accepts any nonzero address permanently. A typo, EOA, counterfeit pair, or wrong quote pair is unrecoverable. The documented follow-up script is missing. | `contracts/contracts/AITT.sol:78-89`; `contracts/scripts/deploy.js:56-64` | Add a guarded setter script that verifies chain, bytecode, factory `getPair`, `token0/token1`, quote asset, and explicit typed confirmation before the irreversible call. |
| Medium | `verify.js` prints mismatches but exits successfully, hides sub-token differences by dividing before comparison, skips missing addresses, and omits critical invariants. | `contracts/scripts/verify.js:31-60` | Verify exact base units, chain ID, bytecode, owner, recipients, pair, converter/operator/reserve, vesting schedules/beneficiaries, allocation totals, and zero deployer balance; exit nonzero on any failure. |
| Medium | The example emission schedule exceeds its pool: 6.25% monthly for year one is 75%; even 1% for every remaining month brings the minimum four-year total to 111%. | `docs/TOKENOMICS.md:203-213` | Replace the example with a schedule whose monthly weights sum to exactly 100%, then enforce it in an emission vault. |
| Medium | The Hardhat development tree reports 17 high advisories. They do not ship in bytecode, but affect build/network tooling; safe remediation requires major Hardhat/toolbox upgrades. | `contracts/package-lock.json`; `npm audit` 2026-08-23 | Isolate builds, process only trusted files/RPCs, then test a Hardhat 3/toolbox 7 migration in a separate change before deployment. Do not use forced audit fixes. |
| Medium | Signal points are awarded on publication, not quality verification, with no issuance cap/Sybil policy. Reserve limits payout but creates rationing risk against “1:1.” | `lib/signals.js:148-151`; `lib/points.js:96-104,169-181`; `docs/TOKENOMICS.md:93-113` | Define snapshot eligibility, anti-Sybil/quality rules, expiry, oversubscription treatment, and maximum conversion liability before TGE. |

## Deployment-script corrections completed during this review

- Fixed the out-of-scope zero-address variable that caused a partial deployment crash after AITT deployment.
- Added local-chain regressions for unset AMM pair, oversized conversion reserve, and malformed addresses.
- Added a 300M ecosystem-pool cap preflight for `pointsConversionReserve`.
- Added address validation/normalization before deployment.
- Fixed `npm test`, base-unit documentation, AMM buy/sell labels, public-script privacy wording, and package license metadata.

These corrections make the scripts safer; they do **not** clear the economic/architecture blockers above.

## Current frozen state

- Production status: `design`
- Contract/converter addresses: unset
- Conversion: closed
- Conversion reserve: 0
- Current public points snapshot at review time: 645 points = 645 whole AITT = 64,500,000,000 base units if that were the final TGE snapshot
- Runtime deploy config: allocation/operator addresses present; stakers pool and AMM pair unset; reserve 0

## Recommended sequence

1. Choose the global burn-accounting design.
2. Choose enforceable allocation custody versus revised public promises.
3. Resolve counsel posture for staker revenue sharing and external liquidity.
4. Build the EVM-address-bound, atomic points conversion pipeline.
5. Resolve the phase-gate circularity.
6. Specify BSC bridge/wrapped-token and DEX tax behavior.
7. Harden `setAmmPair` and `verify.js`; migrate the vulnerable dev toolchain in isolation.
8. Re-run tests, Slither, Mythril, independent audit, and full local deployment rehearsal.
9. Only then request explicit owner authorization for IOST L2 deployment.
