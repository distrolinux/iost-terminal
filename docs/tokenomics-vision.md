# AIT Tokenomics — Vision Document (v0.1, not issued)

> **Status: VISION ONLY — no token has been created, minted, or sold.**
> This document describes a *future* tokenomics design. The live platform runs an
> off-chain **points system** (see mapping below) with zero securities exposure.
> Revisit only after: real users, real trading fees, and legal counsel sign-off.

> **Superseded by `docs/TOKENOMICS.md` (v1.0). Decisions 2026-08-16: symbol locked to AITT (verified free — "AIT" taken by AIT Protocol, AiMalls, AICHAIN, AI Trader); name changed from "AIgent Intelligence Trading Token" to "Agent Intelligence Trading Token" (trademark conflict — "AIgent" registered by Ubiquity Global Services, USPTO 2020, actively enforced). This file is a historical record.**
> **Legal framing note (2026-08-24): the revenue/APY concepts below are rejected legacy proposals, not active or promised. Nothing in Phase 1 pays holders or stakers revenue, yield, APY, or return. Holding AITT earns nothing. Any future mechanism requires a separate audited staking contract, refreshed counsel approval, and explicit owner launch, and may be designed differently or never launched.**

## 1. Token Overview
- **Name:** AIgent Intelligence Trading Token
- **Symbol:** AIT *(⚠️ verify ticker collision — "AIT" likely taken by existing projects)*
- **Total supply:** 21,000,000,000 (21B) *(review note: cut to 1B — see §5)*
- **Network:** IOST L2 (low fees)
- **Core philosophy:** Align AI model performance with user rewards; incentivize long-term holding; liquidity for trading fees.

## 2. Allocation (as proposed)
| Category | % | Amount | Purpose |
|---|---|---|---|
| Community & Rewards | 40% | 8.4B | Staking rewards, fee rebates, airdrops |
| Ecosystem & Liquidity | 20% | 4.2B | DEX/CEX pools, partnerships |
| Team & Advisors | 15% | 3.15B | 1-yr cliff + 3-yr linear vesting |
| Governance & DAO | 10% | 2.1B | Community proposals, treasury, buy-backs |
| Marketing & Growth | 10% | 2.1B | Milestone-gated releases |
| Reserve Fund | 5% | 1.05B | Emergency liquidity, buy-back/burn (DAO-controlled) |

## 3. Utility
- **Governance:** voting on AI algorithms, fee structure, treasury; 0.1% supply proposal threshold; optional quadratic voting.
- **Rejected legacy staking proposal — never active:** lock AIT → proposed share of trading fees; proposed tiered APY parameters (3-mo → 10%, 2-yr → 25%). These figures are historical, not promised, and are superseded by `docs/TOKENOMICS.md` v2.2.
- **Payments:** 50% fee discount paying with AIT; premium features gated; internal transfers in AIT.
- **Rewards:** trading bounties (AI-verified), referral program, AI feedback rewards.

## 4. Mechanisms
- **Rejected legacy inflation proposal — never active:** staking-pool parameter of ~5% annual starting, −1%/yr.
- **Rejected legacy deflation proposal — never active:** 20% of trading fees burned; Reserve buy-back/burn at low liquidity.
- **Vesting:** Team 1-yr cliff + 36-mo linear; Marketing/Reserve milestone-gated ($10M TVL, 100k users).
- **Rejected legacy fee-split proposal — never active:** 50% stakers / 20% burn / 30% treasury.

## 5. Review Notes (Hermes/Coder review, Aug 2026) — apply before any issuance
1. **Cut supply to 1B** — 21B is arbitrary (BTC 21M × 1000) and reads as retail-bait. Model supply from fee burn + staking math instead.
2. **Rejected yield concept** — the historical 10–25% APY proposal was unsustainable and is not active or promised; see the future/conditional posture in `docs/TOKENOMICS.md` v2.2.
3. **Legal:** rewards/yield/buy-backs make AIT likely a SECURITY in CA/US. Public sale = unregistered offering risk. Obtain counsel + geo-restrictions (site already blocks restricted countries). No TGE until then.
4. **Sequence:** users + fees FIRST, then token. Design will be re-modeled on real numbers anyway.
5. **AI honesty:** token name promises "AI intelligence" — the AI must stay transparent (scores show why; audit logs public) or the name overpromises.

## 6. Live Implementation — Off-chain Points (now)
Points replicate the incentive design 1:1-ready for future AIT conversion.

| Event | Points | Notes |
|---|---|---|
| Publish signal | +10 | per signal |
| Gain a follower | +5 | per follower (author) |
| Referral (referee joins) | +50 ref / +10 referee | self-referral blocked |
| Weekly top paper trader | +500 | computed from journal PnL |
| AI feedback (quality) | +5 | rate-limited, per signal |

- Points ledger: `data/points.json` (atomic writes); balance per user/agent.
- **Conversion:** 1 point → 1 AIT at TGE (planned, not guaranteed — honest label in UI).
- Points are non-spendable until TGE (utility = accrual only). Spend/utility = phase 2.

## 7. Flow (conceptual)
```
[Rejected legacy proposal — never active]
[Users Trade] → [Platform Fees] → proposed (50% stakers) + (20% burn) + (30% treasury)
[Users Stake] → [Proposed Rewards] ← Community pool
[DAO Votes]   → [Treasury] → marketing, dev, buy-backs
```
