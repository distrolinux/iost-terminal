# IOST Terminal

## Purpose

- Operate and evolve the IOST Terminal trading platform served at `iostcallister.com`.

## Ownership

- CALLY owns product, deployment, live-trading policy, and money-boundary decisions.
- Source, tests, docs, and runtime-safe scripts in this directory are project-owned.

## Local Contracts

- Security policy and vulnerability reporting live in `SECURITY.md`; it is binding alongside this file.
- Production is the only writer to `data/`; never start a second server against production stores.
- Real-money execution requires a signed-in human, enabled venue, hard order rails, and owner-approved agent proposals.
- Authentication uses password-bound, expiring server-side TOTP state; login must fail closed if session regeneration fails. Sensitive stores remain mode `0600`.
- Autopilot state, live proposals, and audit reasoning are owner-session-only; anonymous SSR and MCP surfaces must not expose them.
- Agent-wallet spending uses server-side limits and an active wallet-bound Pact; commit identity comes from the reservation, not the client.
- AITT remains pre-launch until its hash-bound audit/counsel/owner/governance approval artifact, deployment manifest, live chain/reserve checks, and explicit CALLY approval all pass. Phase 1 utility-framing counsel is cleared; future staking revenue/APY, external transferability, and Phase 4 liquidity remain inactive and separately gated.
- AITT conversion and DEX controls fail closed. Phase 4 buy/swap requires live BSC wrapper/pair/factory/quote verification and an allowlisted PancakeSwap URL targeting that exact wrapper; no web surface may deploy contracts or flip release gates.
- Secrets, reset tokens, private keys, and raw API credentials must never appear in source, responses, logs, or tests.
- IOST account opening is FREE (no creation fee since 2026-08-24; official signup iostaccount.io/en/create). `lib/iost-accounts.js` FEE_IOST = 0; the platform creates wallets via auth.iost/signUp on users' behalf, keys generated in-browser only. AITT itself is ERC-20 on L2 (chain 182) — EVM wallets only, not the L1 wallet.
- Server and boot-cached page changes require a production container restart; static asset changes require cache-version bumps.
- Phase 5 evidence, release-target, and reproducible-build tooling is preparation-only: local fixtures remain under explicit HOLD and must never authorize deployment, public RPC use, issuance, conversion, transferability, or Phase 4 activation.

## Work Guidance

- Use failing regression tests before fixing execution, authorization, wallet, or authentication defects.
- Keep live tests read-only; never place or cancel real orders during automated verification.
- Use `IOST_DATA_DIR` scratch stores for tests where supported.
- Keep `docs/TOKENOMICS.md`, the public whitepaper, `docs/PHASE1_SPEC.md`, `docs/AITT_LAUNCH_READINESS.md`, and `docs/PHASE4_BRIDGE_DEX_SPEC.md` synchronized after any owner-approved token or Phase 4 design change.

## Verification

- Run `npm test` for the offline safety suite.
- Run `npm test` in `contracts/` and `npx hardhat compile --force` for AITT changes; these use only the local Hardhat chain and must never target a public network during routine verification.
- Run `node --check server.js` and syntax-check every changed JavaScript module.
- Run `npm audit --omit=dev --audit-level=high` before release.
- Verify production through `https://iostcallister.com/api/health`; do not boot a second production-data writer.

## Child DOX Index

- `contracts/` — AITT Phase 1 Solidity contracts, deployment/reconciliation tooling, release evidence, tests, and network-specific verification (see `contracts/AGENTS.md`).
