# AITT Launch-Readiness Matrix

> Status: **SOURCE COMPLETE FOR PRE-LAUNCH REVIEW — HOLD.** No token is deployed, conversion is closed, and Phase 4 liquidity is disabled. This matrix is the operational checklist; `TOKENOMICS.md` remains the economic source of truth.

## Component coverage

| Component | Source status | Evidence | Launch dependency |
|---|---|---|---|
| Token smart contract | Complete | `contracts/contracts/AITT.sol`: 1B fixed supply, 8 decimals, no mint/external burn, shared 800M floor | Independent audit + owner deployment approval |
| Fee/DAO burn routing | Complete | `AITTFeeRouter.sol`; token binds one router; 50/20/30 and post-floor redirect tested | Governance Safe/config + audit |
| Allocation custody | Complete | Team/advisor/ecosystem vesting plus four 48-hour milestone vaults | Governance Safe owners and final beneficiary review |
| Points converter | Complete, closed | `PointsConverter.sol`, EIP-191 binding, claim state machine and receipt reconciliation | Final snapshot/reserve + all release gates |
| Token website | Complete in source | `/aitt` and `/token`; identity, allocation, utility, roadmap, wallet dashboard, explorer and swap status | Production restart/cache refresh when CALLY chooses to publish source changes |
| Wallet connection | Complete in source | Public EVM connection/network switch/add-token controls; signed conversion-wallet binding in Points view | Add-token remains disabled until verified contract address exists |
| Token dashboard | Complete in source | Public status dashboard plus Terminal AITT view | Live contract/reserve data appears only after verified deployment config |
| Buy/swap interface | Prepared, fail-closed | Requires Phase 4 status, BSC wrapper/pair/factory/quote addresses, live pair bytecode/assets/factory verification, and an approved PancakeSwap HTTPS URL whose `outputCurrency` exactly matches the wrapper | Audited bridge/wrapper, real liquidity pair, refreshed counsel, Phase 4 approval |
| Tokenomics page | Complete | `docs/TOKENOMICS.md` v2.0 | Keep public mechanics synchronized after any owner-approved design change |
| Whitepaper | Complete | `/whitepaper` serves `docs/AITT-Whitepaper-v1.0.md` | External review and final deployed-address appendix |
| Deployment scripts | Complete, not run on a public chain | Address/Phase-4 preflight, release approval bound to exact config + compiled bytecode, complete transaction journal, custody deployment, governance handoff, provider-only exact verification | Explicit owner approval; private key supplied by owner only |
| AMM lock script | Complete, Phase 4 only | `scripts/setAmmPair.js` validates chain, bytecode, factory pair, assets, owner and typed confirmation | Phase 4 approval; irreversible after execution |
| Contract testing | Complete | 70 Hardhat tests; full Solidity compile | Must remain green after audit fixes |
| Platform testing | Complete | Offline safety suite includes AITT release gates, wallet binding, idempotent claims and receipt verification | Must remain green before production restart |
| Admin/owner functions | Complete for pre-launch | On-chain `onlyOwner` controls; owner-only receipt reconciliation APIs; read-only owner dashboard for gates/claims | Governance Safe/config; no web deploy or gate-flip control by design |
| Blockchain configuration | Complete | IOST L2 chain 182, BNB gas, canonical RPC | Reconfirm RPC/chain immediately before deployment |
| Explorer integration | Complete | `https://l2-scan.iost.io`; token address link activates only after deployment | Source verification after deployment |
| Platform integration | Complete, gated | `/api/aitt/info`, points claim, wallet binding, claims and owner reconciliation | Deployment journal/address binding + live chain/reserve probe |

## Machine-enforced holds

Conversion opens only when every release check passes: explicit conversion request, deployed status, all contract/vault addresses, deployment-manifest hash, nonzero release-approval artifact hash, independent-audit approval, refreshed-counsel approval, explicit owner approval, Phase 4 disabled, and live chain/reserve verification. Live accounting remains valid after legitimate conversions and vault releases by checking `balance + released = allocation` and remaining converter liabilities instead of requiring untouched initial balances.

Trading opens only when every Phase 4 check passes: explicit trading request, Phase 4 enabled, deployed status, BSC chain 56, wrapper/pair/factory/quote addresses, exact PancakeSwap venue, an allowlisted HTTPS PancakeSwap URL targeting that wrapper, and live pair/factory/assets verification. Failed checks remove the swap URL from the public API.

## External items that code cannot manufacture

- Independent smart-contract audit, including FeeRouter symbolic-analysis rerun.
- Refreshed Canadian counsel decision for staker revenue, transferability and external liquidity.
- Governance Safe owners/thresholds and final public addresses.
- Final eligible-points snapshot and funded converter reserve.
- Audited BSC bridge/wrapped-token global-supply/burn design and real PancakeSwap liquidity.
- Explicit CALLY deployment approval.

The deployment script independently requires `AITT_RELEASE_APPROVAL_FILE` with all four approvals, nonzero external evidence hashes, the exact deployment-config hash and compiled-contract-bundle hash before it can send its first transaction. Its journal records the approval hash plus router binding, reserve funding, every allocation transfer and every governance handoff transaction.

Until these are complete, the correct state is: `status=design`, empty contract addresses, `conversionOpen=false`, `phase4Enabled=false`, `trading.enabled=false`.
