# AITT Refreshed Counsel Review Brief

## Status

Required pre-launch gate. Revenue sharing, staking yield, external transferability, DEX liquidity, and conversion remain inactive until counsel records approval.

## Current posture

- No token deployed, minted, sold, transferable, or claimable.
- No ICO/IDO/IEO or public sale.
- Points are off-chain, non-spendable, and conversion is planned/not guaranteed.
- Proposed utility: fee discount, trust collateral, governance, agent access.
- Proposed economics: 50/20/30 platform-fee routing before burn cap; burn share redirects 70/30 at floor, yielding 64/36 overall; 3% future AMM tax; DAO buyback burns.
- AITT is not the settlement asset; agent spending settles in stablecoin/USD credits.

## Counsel questions requiring written answers

1. Does platform-fee revenue routed to AITT stakers create a security, investment-contract, collective-investment, dividend, or profit-sharing characterization in Canada or target jurisdictions?
2. If retained, what eligibility/KYC/KYA, accredited-investor, geo-blocking, staking-service, tax, disclosure, and marketing restrictions are required?
3. Does a 3% DEX transfer tax, buyback/burn policy, or language about demand/deflation/value drivers change the analysis?
4. Can “utility token” and “holders earn nothing” be used at all while stakers receive platform/swap revenue? Provide approved replacement language.
5. Is earned points conversion a distribution, compensation, airdrop, sale, promotion, or taxable benefit? What records/consents are required?
6. What transfer restrictions are required before/after TGE and before BSC/PancakeSwap liquidity?
7. Are DAO voting, treasury control, slashing, and milestone releases acceptable before a formal DAO entity/charter exists?
8. What sanctions/AML/KYC/KYA duties attach to EVM wallet binding, conversion, staking, fee distributions, and bridges?
9. What consumer, contest, referral, and anti-Sybil rules apply to points earned from signals, followers, feedback, referrals, and paper-trading bounties?
10. Confirm required risk statements, terms/privacy updates, jurisdiction list, retention, tax reporting, and launch sign-off evidence.

## Required output

- Written classification and approved public wording.
- Allowed/prohibited jurisdictions and user categories.
- Required identity, AML/sanctions, tax, and recordkeeping controls.
- Approved staking/revenue mechanics or required redesign.
- Approved points-conversion process and disclosures.
- Conditions for external transferability and Phase 4 liquidity.
- Named signatory/date and scope of reliance.

## Machine gate

Counsel approval is represented by `releaseGates.counselApproved=true` only after the signed review is stored and its document hash is recorded in the launch manifest. The application does not let `conversionOpen` bypass this gate.
