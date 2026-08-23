# Phase 1 build spec — AITT on IOST L2
> Status: **BUILT + TOOLING-REVIEWED, PRE-LAUNCH HOLD, not deployed.** Do not deploy until the blockers in `AITT_REVIEW_2026-08-23.md` are resolved and the owner explicitly approves.
> Source of truth for numbers: `docs/TOKENOMICS.md` v1.9 remediation design.

## What this delivers

| Piece | Contract | Notes |
|---|---|---|
| Token + FeeRouter | `contracts/AITT.sol` + `AITTFeeRouter.sol` | **1B fixed supply, 8 decimals.** Swap/platform/DAO burns share one token-owned 800M floor; no dead-address path. Platform fees 50/20/30 while headroom exists and 64/36 at floor. AMM remains unset/Phase 4 disabled. |
| Vesting | `contracts/AITTVesting.sol` | Cliff + linear. Team: 12-mo cliff + 36-mo linear (150M). Advisors: 12-mo cliff + 24-mo linear (50M). Beneficiary-only claims; owner can only sweep foreign tokens. |
| Converter | `contracts/PointsConverter.sol` | Points → AITT **1:1** at TGE. Operator approves ledger snapshots; users claim; reserve-funded; pausable; owner can withdraw only what is not owed. |
| Tests | `test/*.test.js` | **58 tests, all passing** — token/router burn accounting, vault custody, corrected vesting, converter/snapshot accounting, and isolated deployment verification. |
| Deploy | `scripts/deploy.js` + `deploy.config.example.json` | One-shot deploy + allocation moves + reserve funding. |
| Verify | `scripts/verify.js` | Post-deploy balance checks vs the locked allocation plan. |

## Audit pass (free tooling — Phase 1 strategy, Option A)

| Tool | Result |
|---|---|
| **Slither** (95 detectors) | **0 High, 0 Medium.** 3 Low/Info (re-run 2026-08-19 after swap tax): timestamp usage in vesting (inherent to any vesting schedule — worst case a few seconds of drift) · gas in the converter's batch loop (admin-only call, acceptable). |
| **Mythril** (symbolic execution) | AITT clean; expected timestamp notices; PointsConverter generic funding warning constrained by immutable AITT; FeeRouter run incomplete after local OOM and must be rerun in a larger isolated worker. |
| **Oyente** | **Excluded** — unmaintained since ~2018 (Python 2), its successor is Mythril (ran above). Documented, not silently skipped. |
| Test suite | 58/58 passing (Hardhat, re-run 2026-08-23). |

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
#    allocations.ecosystemPool|treasury|partners|community|reserve  -> the DAO/ops wallets
#    allocations.teamBeneficiary / advisorBeneficiary               -> the actual people
#    operator                                                       -> platform backend key
#    stakersPool                                                    -> staker-rewards recipient (Phase 1: DAO wallet; Phase 2: staking contract — pre-TGE redeploy is the escape hatch)
#    ammPair                                                        -> OPTIONAL: set after liquidity exists; otherwise call setAmmPair later
#    pointsConversionReserve                                        -> 0 for now (set at TGE)

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
1. Deploys `AITT` — full 1B minted to deployer.
2. Deploys `TeamVesting` (150M) + `AdvisorVesting` (50M) and funds them.
3. Deploys `PointsConverter` (operator = platform backend).
4. Moves: ecosystem 300M · treasury 200M · team vesting 150M · partners 100M ·
   community 100M · reserve 100M · advisor vesting 50M (**= 1,000M exactly**).
5. Funds the converter reserve when `pointsConversionReserve > 0` (set to the live
   points-ledger snapshot at TGE — conversion is an earn-event, 1:1).

### Post-deploy hygiene
- **Deployer holds 0 AITT** when all moves land (verify.js checks this).
- AITT has no mint and no external burn; the only privileged action is the
  **one-time `setAmmPair`** (must be called once liquidity is created — before
  that, swaps are untaxed). After the pair lock, ownership is inert; renouncing
  is optional and cosmetic.
- LP add/remove touch the pair and are taxed like buy/sell (standard
  fee-token behavior; LPs price it in). The 3% tax is buy+sell on the single
  locked pair; wallet-to-wallet, staking, airdrops and platform transfers are 0%.
- Keep `deploy.config.json` and `.env` out of the public repo (`.gitignore` covers both). Deployment and verification scripts are intentionally public for reproducibility and review.

## Re-running the free audit pass
```bash
cd /opt/data/iost-terminal/contracts
npm test                                           # 58 tests
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
- [ ] Points conversion end-to-end plumbing: verified EVM address binding, `points × 10**8` approval submission, point debit/freeze, tx receipt reconciliation, idempotent retry, and UI status. Existing UI/gate shell remains closed.
- [ ] Reserve amount = live points-ledger total (needs the final snapshot)
- [ ] Mid-tier external audit before Phase 2 (real value)
- [ ] Supply/allocation modeling on ≥3 months real fee data
- [ ] Contract addresses recorded in TOKENOMICS.md §2 + whitepaper once deployed

## Phase gates (unchanged)
TGE gates: 10k users · 500 staked agents · ≥40% of circulating staked. Phase 2
(agent wallet) does not start before Phase 1 is stable and externally audited.

---
*IOST Terminal — AI Command Center. Proven on IOST. Free to trade. Built for humans, designed for agents.*
