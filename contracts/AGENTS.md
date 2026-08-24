# AGENTS.md — iost-terminal/contracts (AITT Phase 1)

## Purpose
Solidity build for the AITT token (Phase 1 of the roadmap in `docs/TOKENOMICS.md`):
AITT ERC-20, allocation vesting, points→AITT converter, deploy + verify scripts.

## Ownership
- Owner: project owner (final sign-off on any deployment or design change)
- Scope: this folder only. Design decisions live in `../docs/TOKENOMICS.md` (source of truth).

## Local Contracts (locked — do not change without owner approval)
- Token: OpenZeppelin ERC-20, **1B fixed supply, 8 decimals, no mint / no public burn** + **swap tax (TOKENOMICS.md v2.3, locked 2026-08-19, burn guarantee corrected 2026-08-24):** 3% on AMM-pair buy/sell only — 1.8% protocol burn / 0.8% stakers recipient / 0.4% treasury; 0% on wallet-to-wallet, staking, airdrops, platform transfers. All protocol burns reduce `totalSupply()` and stop at an **800M floor**. Transfers to arbitrary inaccessible/sink addresses are ordinary ERC-20 transfers, are not recognized as protocol burns, and are outside the protocol burn-cap guarantee. AMM pair is one-time/permanent; `treasury` + `stakersPool` recipients are set at construction.
- Vesting: cliff + linear (team 12-mo cliff + 36-mo linear · advisors 12-mo cliff + 24-mo linear)
- Converter: 1:1 points→AITT, operator-approved snapshots, reserve-funded, pausable; owner can irreversibly close new approvals while preserving existing claims. Chunked snapshot resumes trust only receipt-confirmed exact `Approved` event evidence.
- Allocation (sums to 1,000,000,000): ecosystem 300M · treasury 200M · team 150M · partners 100M · community 100M · reserve 100M · advisors 50M. Points-conversion reserve draws from the ecosystem pool.
- Burn authority: `AITTFeeRouter` is the sole external protocol-burn path; swap/router burns share AITT's 800M floor. The protocol never treats sink-address transfers as burns. Platform fees are 50/20/30 before floor and 64/36 after burn-share redirect.
- Allocation custody: only converter reserve is directly claimable; ecosystem uses 48-month linear vesting; treasury/partners/community/reserve use separate 48h milestone vaults.
- Audit gate: full Hardhat suite must pass (73 tests as of 2026-08-24), Slither 0H/0M, AITT Mythril clean; router Mythril incomplete after local OOM. Refreshed counsel sign-off CLEARED 2026-08-24 (utility framing; staker revenue reframed future/inactive). Pre-launch HOLD remains until independent external audit and explicit owner gates pass.
- Network: IOST L2, chain 182 (`https://l2-mainnet.iost.io`), gas = BNB, explorer `https://l2-scan.iost.io`.

## Work Guidance
- Secrets never live here: `deploy.config.json` (addresses only) and `.env` are gitignored.
- Deploying needs the owner's explicit go-ahead; runbook: `../docs/PHASE1_SPEC.md`.
- Generate release approval with `scripts/prepare-release-approval.js`; deployment must reject approval evidence whose config, creation bytecode, or deployed bytecode fingerprints differ from the current build.
- Design-doc edits (supply, allocations, schedules, burn mechanics) must stay in sync with `../docs/TOKENOMICS.md` AND `../docs/AITT-Whitepaper-v1.0.md` (same mechanics; the public whitepaper is a condensed copy that omits the internal §15 appendix — edit TOKENOMICS first, then mirror public-facing changes).

## Verification
- `npm test` — all tests must pass before any deploy/PR.
- `npx hardhat run scripts/deploy.js --network iostL2` then `scripts/verify.js` (with AITT_ADDRESS) — allocation checks must read OK.

## Child DOX Index
None — this folder has no child AGENTS.md files.
