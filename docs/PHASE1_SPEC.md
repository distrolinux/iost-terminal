# Phase 1 build spec — AITT on IOST L2
> Status: **BUILT + TOOLING-REVIEWED, PRE-LAUNCH HOLD, not deployed.** Do not deploy until the blockers in `AITT_REVIEW_2026-08-23.md` are resolved and the owner explicitly approves.
> Source of truth for numbers: `docs/TOKENOMICS.md` v2.0 remediation design.

## What this delivers

| Piece | Contract | Notes |
|---|---|---|
| Token + FeeRouter | `contracts/AITT.sol` + `AITTFeeRouter.sol` | **1B fixed supply, 8 decimals.** Swap/platform/DAO protocol burns use token-owned `_burn` and share one 800M `totalSupply()` floor; arbitrary user sink-address transfers are excluded from that guarantee. Platform fees are 50/20/30 while headroom exists and 64/36 at floor. AMM remains unset/Phase 4 disabled. |
| Vesting | `contracts/AITTVesting.sol` | Cliff + linear. Team: 12-mo cliff + 36-mo linear (150M). Advisors: 12-mo cliff + 24-mo linear (50M). Anyone may trigger release, but funds can only reach the immutable beneficiary; owner can only sweep foreign tokens. |
| Converter | `contracts/PointsConverter.sol` | Points → AITT **1:1** at TGE. Operator approves ledger snapshots; users claim; reserve-funded; pausable; owner can withdraw only what is not owed. |
| Tests | `test/*.test.js` | Full Hardhat suite must pass — token/router burn accounting, vault custody, corrected vesting, converter/snapshot accounting, release approvals and isolated deployment verification. |
| Deploy | `scripts/deploy.js` + `deploy.config.example.json` | Fail-closed preflight, partial-deployment journal, contract custody, reserve funding and governance handoff. |
| Verify | `scripts/verify.js` + `verify-lib.js` | Derived-count exact chain, bytecode, token-binding, owner, router, reserve, schedule, custody, clean-state and zero-deployer-balance invariants; any mismatch exits nonzero. |

## Audit pass (free tooling — Phase 1 strategy, Option A)

| Tool | Result |
|---|---|
| **Slither** (95 detectors) | **0 High, 0 Medium.** 3 Low/Info (re-run 2026-08-19 after swap tax): timestamp usage in vesting (inherent to any vesting schedule — worst case a few seconds of drift) · gas in the converter's batch loop (admin-only call, acceptable). |
| **Mythril** (symbolic execution) | AITT clean; expected timestamp notices; PointsConverter generic funding warning constrained by immutable AITT; FeeRouter run incomplete after local OOM and must be rerun in a larger isolated worker. |
| **Oyente** | **Excluded** — unmaintained since ~2018 (Python 2), its successor is Mythril (ran above). Documented, not silently skipped. |
| Test suite | Full Hardhat suite passing; re-run for this readiness pass. |

> ⚠️ This is a **tooling pass, not an external audit**. Per the locked strategy: a
> mid-tier firm (~$3–8k) is required **before Phase 2 moves real value**. Do not
> present this report to CMC/exchanges as an independent audit.

## Deployment runbook (IOST L2, chain 182)

Network: `https://l2-mainnet.iost.io` · Explorer: `https://l2-scan.iost.io` (Blockscout)
Gas: **BNB** — bridge BNB via the official IOST bridge first. Expected cost: **~$2** total.

```bash
cd /opt/data/iost-terminal/contracts

# 1. Fill in the config (addresses only — NEVER keys)
cp deploy.config.example.json deploy.config.json
#    allocations.ecosystemPool                                     -> ecosystem emission beneficiary
#    allocations.treasury                                          -> immutable fee recipient
#    allocations.partners|community|reserve                         -> address records; token custody remains in milestone vaults
#    allocations.teamBeneficiary / advisorBeneficiary               -> the actual people
#    operator                                                       -> platform backend key
#    stakersPool                                                    -> staker-rewards recipient (Phase 1: DAO wallet; Phase 2: staking contract — pre-TGE redeploy is the escape hatch)
#    ammPair / ammFactory / quoteToken                              -> MUST remain zero in canonical Phase 1
#    pointsConversionReserve                                        -> 0 for now (set at TGE)

# 1b. Build an approval template bound to this config + compiled bytecode
npx hardhat run scripts/prepare-release-approval.js --network iostL2
# Set all four booleans true only after review; replace audit/counsel/owner
# evidence hashes. Do not alter the generated config or contract-bundle hashes.
export AITT_RELEASE_APPROVAL_FILE="$PWD/release-approval.json"

# 2. Deploy (deployer needs a little BNB on L2)
# Canonical deployer/owner MetaMask wallet (EIP-55 verified 2026-08-16):
#   0xAcF508de0Cdab772C08988Db8aA9898db6b3D769
export PRIVATE_KEY=0x...            # deployer key — do not commit, do not share
npx hardhat run scripts/deploy.js --network iostL2

# 3. Verify + record addresses
export AITT_ADDRESS=0x...           # from deploy output
npx hardhat run scripts/verify.js --network iostL2
# Then verify source on Blockscout:
#   https://l2-scan.iost.io/address/<AITT_ADDRESS>#code  (Standard JSON input)
```

### What the deploy does (single run)
1. Validates every address, reserve bound and Phase 4-disabled invariant before the first transaction.
2. Deploys `AITT` and its sole `AITTFeeRouter`, then permanently binds the router.
3. Deploys team/advisor vesting and the 48-month ecosystem emission contract.
4. Deploys four 48-hour milestone vaults for treasury, partners, community and reserve.
5. Deploys and optionally funds `PointsConverter` from the ecosystem allocation.
6. Moves the full 1B into contract custody and transfers every owner role to governance.
7. Runs exact post-deploy verification and writes a hash-bound completion journal.

### Post-deploy hygiene
- **Deployer holds 0 AITT** when all moves land (verify.js checks this).
- AITT has no mint and no public burn. Its owner retains only the one-time
  `setAmmPair` lock after the FeeRouter is bound. Router DAO burns, converter
  pause/operator/reserve controls, milestone queues and custody ownership remain
  governance-controlled and must be held by the reviewed Safe.
- LP add/remove touch the pair and are taxed like buy/sell (standard
  fee-token behavior; LPs price it in). The 3% tax is buy+sell on the single
  locked pair; wallet-to-wallet, staking, airdrops and platform transfers are 0%.
- Keep `deploy.config.json` and `.env` out of the public repo (`.gitignore` covers both). Deployment and verification scripts are intentionally public for reproducibility and review.

## Re-running the free audit pass
```bash
cd /opt/data/iost-terminal/contracts
npm test                                           # full contract suite
# Slither (needs solc 0.8.24 on PATH; venv at /opt/data/venvs/audit)
slither . --solc-remaps "@openzeppelin/=node_modules/@openzeppelin/" \
  --filter-paths "node_modules|test" --exclude naming-convention,solc-version,pragma,assembly,low-level-calls,constable-states,immutable-states
# Mythril (uses solc.json remappings)
myth analyze contracts/AITT.sol --solc-json solc.json --execution-timeout 90 -o text
myth analyze contracts/AITTVesting.sol --solc-json solc.json --execution-timeout 120 -o text
myth analyze contracts/PointsConverter.sol --solc-json solc.json --execution-timeout 150 -o text
```
Known quirks: mythril 0.24.8's jsonv2 output crashes on this solc version — use `-o text`.
Oyente is unmaintained (Python 2) — its successor Mythril is run instead.

## Open items this phase does NOT close
- [x] Points conversion plumbing: EIP-191 address binding, `points × 10**8` snapshots, idempotent reservation, approval/conversion receipt verification, confirmed-only debit and UI status are built. The gate remains closed.
- [ ] Reserve amount = live points-ledger total (needs the final snapshot)
- [ ] Independent external audit and FeeRouter symbolic-analysis rerun
- [ ] Refreshed counsel approval for revenue sharing/transferability
- [ ] Governance Safe/config and final beneficiary review
- [ ] Supply/allocation modeling on ≥3 months real fee data
- [ ] Contract addresses recorded in TOKENOMICS.md §2 + whitepaper once deployed
- [ ] Audited BSC bridge/wrapped-token design and verified PancakeSwap pair before Phase 4

## Release gates
The runtime requires deployed status, every contract/vault address, a hash-bound
deployment manifest, independent-audit approval, refreshed-counsel approval,
explicit owner approval, Phase 4 disabled, and a live chain/reserve probe before
conversion can open. See `AITT_LAUNCH_READINESS.md`.

---
*IOST Terminal — AI Command Center. Proven on IOST. Free to trade. Built for humans, designed for agents.*
