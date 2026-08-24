# Spec: AITT Pre-Launch Remediation

## Status

Approved architecture implemented in source. AITT remains undeployed; conversion and Phase 4 remain closed pending external gates.

## Objective

Make AITT's locked 1B supply, shared 800M protocol-burn floor, allocation custody, points conversion, and launch gates enforceable end-to-end before any deployment or external liquidity.

## Approved decisions

1. **Burn authority:** one `AITTFeeRouter` is the sole external protocol-burn path. `AITT` keeps internal AMM burns and a one-time-locked router address. Every protocol burn reduces `totalSupply()` via `_burn`; protocol policy and tooling never use sink-address transfers.
2. **Supply floor:** all protocol burn paths share `totalSupply() - 800M` headroom, deriving a 200M cumulative protocol-burn cap from the fixed 1B initial supply. Excess burn share redirects 70/30 to stakers/treasury. User transfers to arbitrary nonzero sink addresses are excluded because address spendability cannot be proven on-chain.
3. **Post-cap platform fees:** redirect only the 20% burn share 70/30. Overall platform-fee distribution becomes 64% stakers / 36% treasury at the floor.
4. **Allocation custody:** no allocation goes directly to a transferable wallet except the funded PointsConverter reserve. Ecosystem uses a 48-month linear emission vault. Team/advisors keep current vesting. Treasury, partners, community, and reserve use separate 48-hour queued milestone vaults.
5. **Conversion identity:** users bind a MetaMask/EVM address with an EIP-191 challenge/signature. Claims use explicit atomic states and 1 point = 1 whole AITT = `10**8` base units.
6. **Revenue/legal:** keep the proposed staker-revenue model frozen pending refreshed counsel approval; public surfaces must label it proposed/inactive.
7. **Bridge:** BSC/PancakeSwap Phase 4 remains blocked until canonical IOST L2 launch is stable and an audited wrapper/supply/burn design exists.

## Contracts

### AITT

- Fixed initial supply: 1,000,000,000 AITT, 8 decimals.
- `SUPPLY_FLOOR`: 800,000,000 AITT.
- One-time `setFeeRouter(address)` and `setAmmPair(address)`; both nonzero and permanent.
- `protocolBurn(uint256)` callable only by the locked fee router; burns from router balance.
- Shared internal burn helper clamps at floor and redirects excess 70/30.
- Swap tax remains 3% on the single canonical pair: 1.8% requested burn, 0.8% stakers, 0.4% treasury.
- No protocol sink-address burn path and no mint after construction; arbitrary user sink transfers are not counted as burns.

### AITTFeeRouter

- Immutable AITT, stakers recipient, treasury recipient.
- `payPlatformFee(amount)`: pulls exact AITT from payer; routes 50% stakers, 20% through `AITT.protocolBurn`, 30% treasury. At/near floor the token redirects unburnable remainder 70/30.
- `executeDaoBurn(amount)`: owner/DAO queues or submits owned AITT through the same protocol-burn path; protocol tooling does not use sink-address transfers.
- Exact-balance-delta checks; nonReentrant; events for fee, burn, and redirect amounts.

### Allocation vaults

- `AITTLinearEmissionVault`: 48-month linear release, fixed total, immutable beneficiary; ecosystem allocation minus converter reserve.
- Existing `AITTVesting`: team 12-month cliff + 36-month linear; advisors 12-month cliff + 24-month linear.
- `AITTMilestoneVault`: fixed allocation; owner must be governance Safe; queue `(recipient, amount, evidenceHash)`; execute only after 48 hours; cancelable before execution; cumulative release cannot exceed allocation.
- Separate milestone vaults: treasury 200M, partners 100M, community 100M, reserve 100M.
- Directly transferable at deployment: only PointsConverter reserve.

## Points conversion

- EIP-191 challenge includes domain, chain ID 182, user ID, EVM address, nonce, issued/expiry timestamps.
- Challenges are single-use and expire.
- Signature recovery must equal the requested EVM address.
- One EVM address may bind to only one account; rebinding requires a fresh signature and no active claim.
- Claim states: `eligible -> reserved -> approved_onchain -> claimed_onchain` or `failed/released`.
- Points are reserved before on-chain approval; retries use an idempotency key; points are permanently debited only after confirmed conversion receipt.
- Operator snapshot script deterministically converts `points * 10**8`, submits `approveClaims`, records tx hash/block, and reconciles reserve/outstanding totals.
- `conversionOpen` is necessary but insufficient: machine gates below must all pass.

## Release gates

Conversion/TGE remains closed unless all are true:

- status is `deployed`;
- token/router/converter/vault addresses are nonzero and bytecode-verified on chain 182;
- shared protocol-burn path and allocation totals pass verification;
- converter on-chain reserve covers all reserved/approved point liabilities;
- independent contract audit gate is recorded;
- refreshed counsel gate for revenue sharing/transferability is recorded;
- Phase 4 bridge flag remains false;
- explicit owner release approval is recorded.

The former circular requirements (500 staked agents and 40% staked before staking exists) become post-launch adoption targets, not code prerequisites.

## Tooling and deployment

- Harden `setAmmPair` with bytecode, factory, token0/token1, quote asset, chain ID, and typed confirmation checks.
- `verify.js` must compare exact base units, require every address, verify chain/bytecode/owners/immutables/schedules/router/converter/vaults, and exit nonzero on any mismatch.
- Add a complete isolated local deployment rehearsal.
- Keep Hardhat 2 build isolated while a separate Hardhat 3/toolbox 7 migration is tested; no forced audit fix.

## Commands

- Contract tests: `cd contracts && npm test`
- Compile: `cd contracts && npx hardhat compile`
- Platform tests: `npm test`
- Slither/Mythril: commands in `docs/PHASE1_SPEC.md`
- No mainnet deployment command may run without explicit owner authorization after all gates pass.

## Boundaries

### Always

- Test first; use scratch/local chains; exact base-unit accounting; update TOKENOMICS/whitepaper/runbook together.

### Ask first

- Any percentage, allocation, schedule, recipient-control, legal posture, bridge design, deployment, pair lock, or conversion-open change not listed above.

### Never

- Deploy AITT, set an AMM pair, open conversion, add external liquidity, commit keys, use dead-address burns, or bypass counsel/audit gates during this remediation.

## Success criteria

- Every protocol burn source reduces `totalSupply()` through `_burn` under one 800M floor; arbitrary user sink-address transfers remain outside the guarantee.
- Deployment leaves only converter reserve directly transferable.
- Every other allocation is contract-locked under its approved schedule/control.
- Points conversion is EVM-bound, base-unit correct, idempotent, and receipt-reconciled.
- Verification fails closed on any mismatch.
- Full tests/static analysis/independent review pass.
- AITT remains pre-launch until a separate explicit deploy authorization.
