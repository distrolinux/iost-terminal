# AGENTS.md — iost-terminal/contracts (AITT Phase 1)

## Purpose
Solidity build for the AITT token (Phase 1 of the roadmap in `docs/TOKENOMICS.md`):
AITT ERC-20, allocation vesting, points→AITT converter, deploy + verify scripts.

## Ownership
- Owner: PROJECT OWNER (final sign-off on any deployment or design change)
- Scope: this folder only. Design decisions live in `../docs/TOKENOMICS.md` (source of truth).

## Local Contracts (locked — do not change without PROJECT OWNER)
- Token: OpenZeppelin ERC-20, **1B fixed supply, 8 decimals, no mint / no external burn** + **swap tax (TOKENOMICS.md v1.4, locked 2026-08-19):** 3% on AMM-pair buy/sell only — 1.8% burn / 0.8% stakers / 0.4% treasury; 0% on wallet-to-wallet, staking, airdrops, platform transfers. Burn clamped at **200M cumulative (800M supply floor)**; post-cap the burn share redirects to stakers 70/30. AMM pair locked once via `setAmmPair` (owner-only, one-time, permanent — the pair only exists after the token is deployed); `treasury` + `stakersPool` recipients set at construction. After the pair is set, no privileged functions remain.
- Vesting: cliff + linear (team 12-mo cliff + 36-mo linear · advisors 12-mo cliff + 24-mo linear)
- Converter: 1:1 points→AITT, operator-approved snapshots, reserve-funded, pausable
- Allocation (sums to 1,000,000,000): ecosystem 300M · treasury 200M · team 150M · partners 100M · community 100M · reserve 100M · advisors 50M. Points-conversion reserve draws from the ecosystem pool.
- Audit gate: free tooling pass DONE (2026-08-16; **re-run 2026-08-19 after the swap tax — 36/36 tests, Slither 0H/0M, Mythril clean**); **mid-tier external audit required before Phase 2 moves real value**. Never present the tooling pass as an external audit.
- Network: IOST L2, chain 182 (`https://l2-mainnet.iost.io`), gas = BNB, explorer `https://l2-scan.iost.io`.

## Work Guidance
- Secrets never live here: `deploy.config.json` (addresses only) and `.env` are gitignored.
- Deploying needs PROJECT OWNER's explicit go-ahead; runbook: `../docs/PHASE1_SPEC.md`.
- Design-doc edits (supply, allocations, schedules, burn mechanics) must stay in sync with `../docs/TOKENOMICS.md` AND `../docs/AITT-Whitepaper-v1.0.md` (same mechanics; the public whitepaper is a condensed copy that omits the internal §15 appendix — edit TOKENOMICS first, then mirror public-facing changes).

## Verification
- `npx hardhat test` — 36 tests, all must pass before any deploy/PR.
- `npx hardhat run scripts/deploy.js --network iostL2` then `scripts/verify.js` (with AITT_ADDRESS) — allocation checks must read OK.

## Child DOX Index
None — this folder has no child AGENTS.md files.
