# AGENTS.md — iost-terminal/contracts (AITT Phase 1)

## Purpose
Solidity build for the AITT token (Phase 1 of the roadmap in `docs/TOKENOMICS.md`):
AITT ERC-20, allocation vesting, points→AITT converter, deploy + verify scripts.

## Ownership
- Owner: project owner (final sign-off on any deployment or design change)
- Scope: this folder only. Design decisions live in `../docs/TOKENOMICS.md` (source of truth).

## Local Contracts (locked — do not change without owner approval)
- Token: OpenZeppelin ERC-20, **1B fixed supply, 8 decimals, no mint / no external burn** + **swap tax (TOKENOMICS.md v1.4, locked 2026-08-19):** 3% on AMM-pair buy/sell only — 1.8% contract burn / 0.8% stakers recipient / 0.4% treasury; 0% on wallet-to-wallet, staking, airdrops, platform transfers. Contract burns stop at an **800M `totalSupply()` floor**; the promised global 200M cap across contract + dead-address burns is unresolved and deployment-blocking (`docs/AITT_REVIEW_2026-08-23.md`). AMM pair is one-time/permanent; `treasury` + `stakersPool` recipients are set at construction.
- Vesting: cliff + linear (team 12-mo cliff + 36-mo linear · advisors 12-mo cliff + 24-mo linear)
- Converter: 1:1 points→AITT, operator-approved snapshots, reserve-funded, pausable
- Allocation (sums to 1,000,000,000): ecosystem 300M · treasury 200M · team 150M · partners 100M · community 100M · reserve 100M · advisors 50M. Points-conversion reserve draws from the ecosystem pool.
- Audit gate: tooling pass re-run 2026-08-23 (**40/40 tests, Slither 0H/0M; Mythril AITT clean with expected vesting/generic converter notices**). Pre-launch review verdict is HOLD. External audit timing and real-value gate require owner/counsel resolution. Never present tooling as an external audit.
- Network: IOST L2, chain 182 (`https://l2-mainnet.iost.io`), gas = BNB, explorer `https://l2-scan.iost.io`.

## Work Guidance
- Secrets never live here: `deploy.config.json` (addresses only) and `.env` are gitignored.
- Deploying needs the owner's explicit go-ahead; runbook: `../docs/PHASE1_SPEC.md`.
- Design-doc edits (supply, allocations, schedules, burn mechanics) must stay in sync with `../docs/TOKENOMICS.md` AND `../docs/AITT-Whitepaper-v1.0.md` (same mechanics; the public whitepaper is a condensed copy that omits the internal §15 appendix — edit TOKENOMICS first, then mirror public-facing changes).

## Verification
- `npm test` — 40 tests, all must pass before any deploy/PR.
- `npx hardhat run scripts/deploy.js --network iostL2` then `scripts/verify.js` (with AITT_ADDRESS) — allocation checks must read OK.

## Child DOX Index
None — this folder has no child AGENTS.md files.
