# AITT Tokenomics — Professional Design Draft (v2.4)

> **Status: DESIGN DRAFT — pre-launch. No public sale; utility-only; not an investment (§10).**
> Supersedes `docs/tokenomics-vision.md` (v0.1) in design intent; that file remains as historical record.
> This draft incorporates the Hermes review notes: 1B supply, proposed future revenue-backed incentive concepts, legal-first sequencing, utility framing.
> **Go-live gate:** real user base + real fee revenue + legal counsel sign-off (Canada/CSA review). No TGE before that.
> v1.1 (2026-08-17): burn cap sync with TOKENOMICS.md v1.3 — cumulative burn (fee-burn + DAO buy-back/burn) capped at 200M → 800M supply floor; the proposed future post-cap distribution parameter redirects the 20% fee share to stakers (70/30 split), but is not active at Phase 1.
> v1.2 (2026-08-19): swap tax sync with TOKENOMICS.md v1.4 — proposed future 3% buy/sell tax on AMM-pair swaps only (1.8% burn / 0.8% stakers / 0.4% treasury), not active at Phase 1; 0% on wallet-to-wallet, staking, airdrops, platform transfers. The proposed burn share uses the same 200M cap and would redirect to stakers (70/30) post-cap. Platform-fee split (50/20/30) unchanged.
> v1.3 (2026-08-20): Agentic Payments Readiness positioning section added (§15) — verified chain stats + agentic trust rows; H1 version corrected.
> v1.4 (2026-08-20): status banner reworded to match TOKENOMICS.md v1.5 — "pre-launch"; stays accurate once the token is deployed. Posture unchanged.
> v1.5 (2026-08-20): Quantum Readiness posture added (§16, condensed from TOKENOMICS §16).
> v1.6 (2026-08-20): audit checklist item replaced with Phase 2 timing note (mirror of TOKENOMICS v1.7).
> v1.7 (2026-08-23): pre-launch review hold added; no locked economics changed. Deployment/conversion remain frozen pending burn, custody, conversion, bridge, phase-gate, and legal remediation.
> v1.9 (2026-08-23): owner-approved remediation implemented, still pre-launch — authoritative FeeRouter burn path, contract-locked allocations, signed EVM wallet binding, atomic claim states/receipt verification, machine-enforced release gates, and Phase 4 hard-disable. Audit/counsel/owner gates remain closed.
> v2.0 (2026-08-24): owner-approved burn guarantee correction mirrored from TOKENOMICS.md — swap and FeeRouter/DAO protocol burns share the 800M `totalSupply()` floor, deriving a 200M cumulative protocol-burn cap. Arbitrary user sink-address transfers are excluded because spendability cannot be proven on-chain.
> v2.1 (2026-08-24): governance claims aligned to enforceable scope (owner-approved), mirrored from TOKENOMICS.md — DAO voting/fee adjustability relabeled future policy; Phase 1 enforcement = Safe-controlled 48h milestone-vault releases + immutable fee ratios.
> v2.2 (2026-08-24): staker-revenue/fee-share language reframed as future Phase 2+ proposal, inactive at Phase 1; “holders earn nothing” utility posture preserved (owner-approved 2026-08-24). v2.3 (2026-08-24): rewards programs (signal/copy-trading/referral) reframed as proposed future programs — not active at Phase 1 (owner-approved).
> v2.4 (2026-08-24): final points-snapshot accounting design mirrored from TOKENOMICS.md — eligible points only, deterministic cutoff/hash, configured funded cap, immutable finalization, and fail-closed oversubscription preserving the planned 1:1 rule. No cap amount is approved here.

---

## 1. Executive Summary

**AITT (Agent Intelligence Trading Token)** is the utility token of the **IOST Terminal** platform — a real-time AI trading command center for crypto & stocks, live at iostcallister.com, built for humans and designed for AI agents.

AITT is designed to power the platform's **agentic payments economy** as the trust and fee layer for machine-executed transactions, with staking and governance planned for Phase 2+. It is **not** the settlement asset — agent spending settles in stablecoin/USD credits so budgets never fluctuate. Any future earned distribution or staking use remains proposed, not active or guaranteed; AITT is not sold.

- **Standard:** **ERC-20 on IOST L2** (fully EVM-compatible, OP Stack rollup; IOST's official recommendation for high-frequency/low-cost scenarios — MetaMask, OpenZeppelin, x402/AP2 SDKs compatible). **AITT requires an EVM wallet (e.g. MetaMask) on IOST L2 chain 182 — it is not supported by the official IOST L1 wallet (iostaccount.io), which manages native IOST mainnet accounts only.** IOST L1 remains home to the platform's producer node (`iost_4_life`) as the payments facilitator/verifier.
- **Total supply:** 1,000,000,000 (1B) — fixed, no uncapped minting
- **Core roles:** proposed future trust-staking collateral · fee utility · earned activity rewards · planned Phase 2+ governance
- **Proposed future Phase 2+ mechanics (not active at Phase 1):** platform-fee parameters of 50% stakers / 20% protocol burn / 30% treasury, staking lock-up, FeeRouter/DAO buy-back burns, and a Phase 4 DEX buy/sell swap tax of 3% (1.8% protocol burn / 0.8% stakers / 0.4% treasury); all protocol burns share the 800M supply floor
- **Proposed emission discipline:** any future rewards would be funded by revenue first; emission pool releases linearly over 48 months; team fully vested over 4 years

---

## 2. Token Overview

| Attribute | Value |
|---|---|
| Name | Agent Intelligence Trading Token |
| Symbol | AITT ✅ *(verified free 2026-08-16 on CoinGecko/CMC; "AIT" taken by AIT Protocol, AiMalls, AICHAIN, AI Trader)* |
| Standard | **ERC-20 on IOST L2** (EVM, OP Stack rollup) |
| Total supply | 1,000,000,000 (1B), fixed |
| Decimals | 8 (ERC-20 supports custom; USDC uses 6) |
| Home chain | IOST L2 (network ID 182, `l2-mainnet.iost.io`); L1 node as facilitator · BSC bridge for liquidity in Phase 4 |
| Contract | OpenZeppelin-standard ERC-20 on IOST L2 (subject to final audit) |
| Inflation | None — any future proposed rewards would draw from allocation pools + real revenue, not new minting |
| Deflation | Swap and FeeRouter platform/DAO burns use token-owned `_burn` under one 800M `totalSupply()` floor, deriving a 200M cumulative protocol-burn cap. Arbitrary user sink-address transfers are excluded. |
| Initial circulating | Only the funded converter reserve is directly claimable; every other allocation is contract-locked. |

**Design rationale for 1B:** supply is modeled from platform economics (fee volume, staking demand, reward budget), not round-number marketing. 21B (v0.1) was rejected as retail-bait.

---

## 3. Allocation

| Category | % | Amount | Vesting / Release |
|---|---|---|---|
| Ecosystem & Agent Rewards Pool | 30% | 300M | 48-month linear emission vault; converter reserve deducted first |
| Treasury (future DAO policy) | 20% | 200M | Safe-controlled 48-hour queued milestone vault in Phase 1 |
| Team & Core Contributors | 15% | 150M | 12-mo cliff + 36-mo linear (4 yrs total) |
| Strategic Partners & Ecosystem | 10% | 100M | 48-hour queued milestone vault |
| Community & Adoption Fund | 10% | 100M | 48-hour queued milestone vault |
| Reserve Fund | 10% | 100M | 48-hour queued milestone vault |
| Early Supporters & Advisors | 5% | 50M | 12-mo cliff + 24-mo linear |

- No founder/team tokens are tradable before month 12.
- Future governance target: category reallocations require a supermajority DAO vote (>66% of staked AITT). Phase 1 milestone-vault releases are Safe-controlled with a 48-hour public delay; this voting rule is not yet enforced on-chain.
- Unallocated/unearned rewards at end of emission schedule return to Treasury.

---

## 4. Utility — the Agentic Payments Layer

### 4.1 Trust Staking (the differentiator)
Agents and agent-operators stake AITT as **collateral** to obtain a **Trust Score**, which determines their **spending authority** (credit line):

- **Trust Score** = f(stake amount, lock duration, compliance history) − slashing events
- **Spend limits** scale with Trust Score: per-transaction cap, daily budget, weekly cap
- **Credit line**: staked AITT backs a working balance for agent settlements (settled in USD credits/stablecoin)
- **Slashing** for violations: unauthorized spending, failed settlement (insufficient backing), policy breach, misrepresentation of intent
- This solves the industry's #1 problem — **"how do I trust an agent with my money?"** — with economic incentives instead of hope
- **This is a "chain of intent"** (Accenture/Google/Mastercard terminology, 2026): legal authorization turned into auditable, cryptographic, economically-enforced constraints. Legacy rails rely on static API credentials and human checkpoints; trust staking makes agent authority dynamically verifiable and "always on" within defined limits — humans monitor exceptions instead of approving every step.
- **KYA — Know Your Agent, enforced economically:** the industry (FIDO Alliance, card networks, regulators) is making KYA as routine as KYC. Trust staking is KYA with teeth — a market mechanism (stake → Trust Score → credit line, slash for misbehavior) instead of a paper registry.
- **Three-token mandate model** (maps to AP2's consent/intent/payment layers): consent token = user-signed mandate · intent token = spend limits & categories · payment token = settlement authority. The Phase 2 agent wallet issues these on IOST; every transaction binds to its mandate on-chain — a tamper-resistant record that survives dispute adjudication.

### 4.2 Fee Utility
- Platform and agent-network fees paid in AITT receive a **50% discount** vs fiat-denominated fees
- **Staking and fee-revenue distribution are future Phase 2+ proposals and are NOT active; nothing in Phase 1 pays holders or stakers any revenue, yield, APY, or return. Holding AITT earns nothing. Any future reward mechanism requires a separate audited staking contract, refreshed counsel approval, and explicit owner launch, and may be designed differently or never launched.**
- **Proposed Phase 2+ distribution for the future staking mechanism — not active at Phase 1:** **50% stakers / 20% burn / 30% treasury** while burn headroom exists; burn-share redirect would yield **64%/36% overall** at the floor
- **Proposed Phase 4 DEX distribution for the future staking mechanism — not active at Phase 1:** 3% on AMM-pair buy/sell only — 1.8% burn / 0.8% stakers / 0.4% treasury. 0% on wallet-to-wallet, staking, airdrops, and platform transfers. The dormant token-contract mechanism uses an `_update` override gated on the AMM pair address (one-time lock at setup; no privileged functions after)
- Proposed future AITT-denominated fees could create utility demand and protocol burn; neither is a promise of value or return
- **Authoritative burn mechanism:** swap-tax and FeeRouter platform/DAO burns call token-owned floor/clamp logic and OZ `_burn`. Fixed 1B initial supply plus the 800M floor derives the 200M cumulative protocol-burn cap; no separate counter exists. Protocol tooling never uses sink-address burns. User transfers to arbitrary nonzero sinks are outside the guarantee because spendability cannot be proven on-chain.
- **Fee rounding:** the dormant router keeps at most 9 base units pending until an exact 50/20/30 split is possible; fragmentation cannot alter the proposed future parameters, and no distribution is active at Phase 1.
- **Proposed post-floor behavior — not active at Phase 1:** only the burn share would redirect 70/30, preserving the locked base shares.

### 4.3 Rewards (proposed future programs — NOT active at Phase 1)
- **Proposed:** signal providers would earn AITT per quality-verified signal (existing hash-pinned-on-IOST mechanic)
- **Proposed:** copy-trading creators would earn a share of their copiers' fee volume
- **Proposed:** referrals, AI-feedback rewards (rate-limited), agent-compute providers
- All rewards are **earned**, never sold — and none are active, guaranteed, or implemented in Phase 1 contracts; each requires launch gates, an audited distribution path, and explicit owner approval before any token is distributed.

### 4.4 Future Governance Target (Phase 2+, not active in Phase 1)
Proposed stake-weighted voting policy for future separately audited governance contracts:
- Spend-limit defaults & approval thresholds for agent transactions
- Merchant/counterparty allowlists
- Slashing rules and appeal process
- Fee schedule
- Treasury allocations & buy-back/burn decisions
- Proposed threshold: 0.1% of staked supply; quadratic voting optional

Phase 1 has no governance contracts. FeeRouter ratios are immutable, and each owner-controlled contract exposes a single-address owner role intended to be configured to the reviewed Safe rather than enforcing token voting, quorum, category restrictions, or council veto on-chain.

### 4.5 Access & Tiers
- Minimum stake for agent API tiers (public tier planned)
- Priority settlement, higher throughput, advanced audit tooling at higher stake

### 4.6 Points → AITT Conversion
Live off-chain points include a +1 signup award that remains provisional until explicit activation. Only eligible points at the final approved snapshot are planned to convert **1:1 to AITT** — conversion is an earn-event, not a purchase, and remains *"planned, not guaranteed."* The snapshot uses an explicit UTC-millisecond cutoff, excludes provisional entries, sorts owner balances canonically, and binds the cutoff, configured funded cap, eligible total, and balances in a deterministic SHA-256 hash. Identical finalization is idempotent; a finalized snapshot is immutable.

The funded cap is an owner-approved positive whole-point configuration input backed 1:1 by the intended converter reserve; no numeric amount is set here. If eligible points exceed it, finalization fails with the exact shortfall and creates no snapshot. There is no automatic pro-rata reduction or silent change to the 1:1 rule. Proposed future release target, not implemented or guaranteed in this slice: 25% at TGE and 75% linearly over 12 months, subject to all release gates and final implementation review.

### 4.7 Payment Sessions & Atomic Budget Enforcement
- Every agent payment runs inside a **payment session** — a scoped, time-bounded context (task, budget, expiry) with built-in spend-limit enforcement (AWS AgentCore pattern, 2026).
- Enforcement is **3-phase and atomic**: reserve (deduct amount from session budget) → process (execute payment) → commit or roll back (restore on failure). Parallel agent payments can never overspend — no stale reads, no lock bugs; deterministic at the protocol level (on-chain escrow equivalent).
- Each completed payment yields a **payment proof** (on-chain tx receipt) the agent presents to unlock the paid service — the audit trail doubles as the access mechanism.

### 4.8 AP2-Compatible Mandate Model (the protocol layer)
- **Role mapping (AP2 v0.2):** Shopping Agent = platform/third-party agents · Trusted Surface = IOST Terminal's approval UI (the one role that MUST be non-agentic — user consent lives here) · Credential Provider + Merchant Payment Processor = platform settlement layer (stablecoin/USD credits) · Merchant = paid API/content providers. One entity may play multiple roles.
- **Mandates = Verifiable Digital Credentials (key-bound SD-JWTs), each Open or Closed:** Checkout Mandate (what's authorized): Open = user constraints/goals, Closed = specific finalized order · Payment Mandate (how it's paid): Open = budget + allowed instruments, Closed = specific amount bound to the checkout hash.
- **Token mapping (extends §4.1):** consent token ↔ user-signed open mandates · intent token ↔ closed checkout mandate · payment token ↔ closed payment mandate. Mandates hash-link to each other and to the merchant-signed checkout JWT (ECDSA-signed to prevent rainbow-table attacks); on IOST, bindings are additionally anchored as tx hashes.
- **Two modes:** Human Present = user signs closed mandates via the Trusted Surface (today's per-trade approval) · Human Not Present = user signs open mandates once, agent signs closed mandates within constraints (autopilot with budget). AP2's `unresolved_constraint` escalation — merchant/credential provider returns the error and pulls the user back into the loop — is the spec-level equivalent of the platform's "approval above thresholds" rule.
- **Dispute chain:** checkout mandate → checkout_jwt hash → checkout receipt reference → payment mandate → payment receipt reference; the full chain verifies who saw what. On IOST this is a permanent, on-chain, machine-verifiable audit trail.
- **Standardization:** AP2 v0.2 was donated to the FIDO Alliance (Agentic Authentication + Payments Technical Working Groups) — the KYA standard (see §4.1). Reference repo: github.com/google-agentic-commerce/AP2 (Apache 2.0; includes a human-not-present + x402 sample — the Phase 3 blueprint).
- **Positioning:** first AP2-compatible implementation on a non-EVM L1.

### 4.9 x402 Payment Scheme (the Phase 3 protocol)
- **The handshake (Coinbase CDP docs, 9 steps):** client requests a resource → server responds HTTP 402 with price / payee / accepted options → client signs a payment and re-attaches proof → server (or facilitator) verifies → work executes → settlement confirms → resource delivered.
- **Network-agnostic by design:** the same handshake works on any chain — EVM and Solana today; IOST becomes a payment rail, not a fork. First x402 on a non-EVM/Solana chain is the land-grab.
- **Asset-agnostic:** USDC is the default elsewhere; on IOST, an IRC20 stablecoin (or IOST itself) settles, AITT is the fee/trust layer.
- **Pricing modes:** fixed price · authorize-max-settle-actual (the §4.7 reserve→process→commit escrow in protocol terms) · **deferred/batch settlement** — batch-settle many micro-payments to cut tx count and cost on high-frequency flows.
- **The facilitator role:** a trusted party verifies + settles on the seller's behalf. IOST Terminal runs a producer node — the natural x402 facilitator for the IOST ecosystem; facilitator fees are a monetization layer beyond platform fees (node infrastructure → facilitator infrastructure).
- **Agentic accounts:** give agents their own funded account to pay for x402 services — the Phase 2 agent wallet, in Coinbase's vocabulary.

---

## 5. Token Flows & Value Accrual

```
              ┌─────────────────────────────────────────────┐
              │  USERS / AGENTS (earn, stake, pay fees)      │
              └──────────────┬──────────────────────────────┘
                             │
              ┌──────────────▼──────────────┐
              │   PLATFORM FEES (AITT)        │
              └──────────────┬──────────────┘
                             │
          ┌─────────┬────────┴────────┬─────────┐
          ▼         ▼                 ▼         ▼
     50% Stakers  20% BURN*        30% Treasury
     (proposed future Phase 2+ distribution — not active at Phase 1)

  * Protocol burns are capped at 200M cumulative by the shared 800M `totalSupply()` floor; the proposed future post-floor distribution would redirect the 20% share 70/30 and is not active at Phase 1. User sink-address transfers are outside this guarantee.

  Agent stakes AITT ──► Trust Score ──► Spend limits ──► Settles in USD credits/stablecoin
  Slashing events  ──► reduce stake + score (misbehavior penalty)
```

**Proposed future design summary — not active at Phase 1:** potential utility demand from fee discounts and trust staking; supply constraints from burn, vesting locks, and staking lock-up; no naked inflation. This is not a promise of value or return.

---

## 6. Revenue & Fairness Model

**Principle: the platform earns business fees for services; AITT holders earn nothing. All revenue is service revenue, never token-holder returns.** (Legal posture §10.)

### 6.1 Revenue streams (in order they activate)
| Stream | Phase | Mechanics |
|---|---|---|
| Node block rewards | Now | Producer node `iost_4_life` earns IOST block rewards once in rotation; covers infrastructure cost first |
| x402 facilitator fees | 3 | Verify + settle agent payments on IOST as the ecosystem facilitator — tiny % per micro-payment, volume-driven; the Visa/Stripe role on IOST |
| Agent-network fees | 2+ | Platform/agent-network fees for trading & settlement; currently free by design; 50% discount when paid in AITT |
| Premium tiers | 2+ | Priority settlement, advanced audit tooling, higher agent API limits (individual agents stay free) |

### 6.2 Proposed future fee distribution (locked design parameters; not active at Phase 1)
- **50% → stakers** — proposed Phase 2+ distribution for a future staking mechanism; no holder or staker receives this share at Phase 1
- **20% → protocol burn** — proposed future burn parameter; shares the 800M `totalSupply()` floor with swap and FeeRouter/DAO burns; post-floor this share would redirect 70/30 if the future mechanism launches
- **30% → treasury** — development + proposed future DAO-voted buy-back/burn; Phase 1 routing is immutable and transparent on-chain

### 6.3 Fairness commitments (why costs stay low for everyone)
- **Sub-cent microtransactions:** IOST fees are fractions of a cent vs cards' $0.30 + 3% floor — agent payments below $1 are only viable on chain-native rails
- **Batch settlement:** many micro-payments settle in one tx (x402 deferred settlement) — per-payment cost approaches zero
- **Optional fee discount:** paying fees in AITT saves 50%; nobody is required to hold or buy AITT
- **Future rewards, if launched:** no minting to pay yield — no inflation tax on holders (emission pool is declining, 48-month); no reward, yield, APY, or return is active or promised
- **Earned, not sold:** no ICO/IDO; tokens may be earned through separately launched activity programs or issued as vested grants; staking does not currently earn tokens or revenue
- **Progressive pricing:** enterprises pay for premium tiers; individual agents and small operators use core features free

### 6.4 Economic honesty
- Profitability is volume-dependent: node rewards first, then facilitator + network fees
- The fairness design is the growth engine: cheapest rails attract the most agents; 30% of large volume > 100% of none
- Phase 1 FeeRouter ratios are immutable. Future fee discounts/facilitator parameters may become DAO-adjustable only through separately audited governance contracts.

---

## 7. Emission Schedule

| Pool | Schedule |
|---|---|
| Ecosystem & Rewards | 48-month linear release from the ecosystem emission vault |
| Team | 12-mo cliff, then 36-mo linear (100% vested at month 48) |
| Advisors | 12-mo cliff, then 24-mo linear |
| Partners/Marketing | Milestone-gated: users, volume, agent adoption targets |
| Initial circulating | Final funded PointsConverter reserve only; no target percentage. The reserve is set from the owner-approved eligible-points snapshot immediately before launch. |
| Points conversion release target | Proposed only: 25% at TGE, then 75% linearly over 12 months; not implemented or guaranteed until gates and implementation review pass. |

**Proposed future hard rule — not active at Phase 1:** if a separately approved reward mechanism were launched and emissions would exceed available revenue + pool balance in a period, emissions would scale down — the platform **never mints** to pay yield.

---

## 8. Staking & Trust Mechanics (parameters — to be modeled on live data)

| Parameter | Proposed value |
|---|---|
| Minimum stake (agent) | 1,000 AITT |
| Lock periods | 7 / 30 / 90 / 365 days |
| Stake multiplier | 1× / 1.25× / 1.5× / 2× (Trust Score weight) |
| Unstake cooldown | 7 days |
| Slashing — unauthorized spend | −10% stake + score reset |
| Slashing — failed settlement | −5% stake |
| Appeal window | 14 days, owner review in Phase 1; future DAO review proposed |
| Future fee-revenue distribution / APY | Not active or promised; any Phase 2+ mechanism would be variable, separately approved, and may never launch |

---

## 9. Proposed Governance Parameters (not active in Phase 1)

These values are future Phase 2+ policy targets only. No Phase 1 contract enforces token voting, proposal thresholds, quorum, supermajority, category restrictions, or council veto. Phase 1 FeeRouter ratios are immutable at deployment. Milestone-vault owner roles are single-address controls intended for the reviewed Safe; that owner may queue any recipient and amount within the fixed allocation, subject only to the immutable 48-hour public delay and cancellation/release accounting.

| Parameter | Value |
|---|---|
| Voting power | 1 AITT staked = 1 vote (time-weighted optional) |
| Proposal threshold | 0.1% of staked supply |
| Quorum | 20% of staked supply |
| Pass threshold | >50% (supermajority 66% for allocation changes) |
| Veto | Proposed timelock + DAO council veto (24-hr); not enforced in Phase 1 |

---

## 10. Legal & Regulatory Posture

- **Utility framing:** AITT confers use-rights within the platform (fees, staking, governance). No profit-sharing promises, no dividend rights, no implied investment return.
- **Earned, not sold:** no public sale, no ICO/IDO/IEO. Tokens are earned (points, rewards) or granted under contract (team/partners, vested).
- **Canada (CSA):** rewards/yield/buy-back language can trigger securities characterization — counsel review required before any external transferability or yield feature.
- **Geo-restrictions:** platform already blocks restricted jurisdictions; token features inherit the same allowlists.
- **Public communication:** all docs and UI must state AITT has no guaranteed value, is not an investment, and is not listed/transferable until a compliant path exists.
- **Before TGE:** contract audit + final numbers modeled on ≥3 months of real fee data. *(Legal opinion ✓ cleared 2026-08-16; ticker ✓ AITT verified 2026-08-16.)*
- **2026-08-24 posture:** staker fee-revenue/APY and external transferability remain future proposals, are not active, and require refreshed counsel review plus explicit owner launch. Holding AITT earns nothing.

---

## 11. Phased Rollout

| Phase | Scope | Trigger |
|---|---|---|
| **0 — Points (LIVE)** | Off-chain points ledger, referral + rewards | Done — in production |
| **1 — ERC-20 deployment** | AITT ERC-20 on IOST L2, allocations + vesting contracts, points→AITT conversion tool | Contract audit *(legal ✓ 08-16, ticker ✓ 08-16)* |
| **2 — Agent wallet** | Trust staking, spend limits, approval flows, slashing; consent/intent/payment tokens (AP2-style layered mandates) | Phase 1 stable + ≥X agents onboarded |
| **3 — x402-style agent payments on IOST** | Pay-per-request API payments in stablecoin, AITT as fee/trust layer; payment sessions with 3-phase atomic budget enforcement (reserve→process→commit/rollback); AP2-compatible open/closed checkout + payment mandates (SD-JWT VDCs); IOST x402 facilitator (verify + settle, batch settlement) | Platform agent traffic + IOST ecosystem fit confirmed |
| **4 — External liquidity** | DEX listing + EVM bridges (BSC first — PancakeSwap liquidity, CMC price data) — only after full legal review | Demand + compliance path exists |

---

## 12. Key Metrics (targets for phase gates)

| Metric | Target |
|---|---|
| Registered users | 10,000 before TGE |
| Fee-generating agents | 500 staked agents |
| AITT staked | ≥40% of circulating |
| Fee volume (AITT-denominated) | ≥30% of platform fees |
| Trust-score coverage | 100% of agent transactions audited on-chain |

---

## 13. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Regulatory recharacterization | Utility-only design, no sale, counsel gate, geo-blocks |
| Token concentration | Team 15% fully vested over 4 yrs; earned-only distribution; future supermajority policy target (not enforced in Phase 1) |
| Adoption shortfall | Phased rollout; token deferred until real demand (Phase 0 → 4 sequence) |
| Smart-contract risk | Independent audit before TGE; bug-bounty; timelock on treasury |
| Market volatility | AITT never the settlement asset; budgets in USD credits/stablecoin |
| Hallucinated agent spend | Trust staking + slashing + human approval above thresholds + on-chain audit trail |
| Agent-ecosystem fraud (impersonation, prompt manipulation, synthetic identities, machine-speed fraud) | Agent identity attestation at registration · on-chain audit trail · slashing + appeal · approval above thresholds (flagged by Accenture as the top agentic-payment risk) |
| Unauthorized/contested agent charges (disputes) | Mandate + agent identity + tamper-resistant on-chain record defend at dispute stage (AP2-style binding; Visa Dispute Recovery Manager analog) |
| Bridge / multi-chain risk (wrapped copies, bridge exploits) | One canonical home chain (IOST L2); wrapped copies only via audited bridges (IOST bridge now, Chainlink CCIP optional later); no per-chain minting |

---

## 14. Review Checklist (before this doc is finalized)

- [x] Ticker availability verified — AITT (2026-08-16)
- [x] Name trademark-checked — 2026-08-16: "AIgent" dropped (registered USPTO by Ubiquity Global Services, enforced); renamed "Agent Intelligence Trading Token"
- [ ] Supply/allocation modeled on real fee + staking projections (post Phase 1 data)
- [x] Canadian legal counsel review — CLEARED 2026-08-16 (counsel: "good to go")
- [x] **Pre-launch contracts/remediation built:** full Hardhat suite passing; Slither 0 High/Medium; AITT Mythril clean; FeeRouter Mythril pending larger isolated worker after local OOM. Not an external audit.
- Note: independent external audit required BEFORE Phase 2 moves real value — a Phase 2 gate, not a Phase 1 deploy gate (owner decision 2026-08-20; the free tooling pass is not an external audit).
- [x] **Points→AITT plumbing built pre-launch:** EIP-191 binding, base-unit snapshot, atomic states/idempotency, receipt verification, and confirmed-only debit. Gate remains closed pending audit/counsel/owner checks.
- [x] **Protocol-burn cap corrected 2026-08-24 (owner-approved)** — fixed 1B supply plus the shared 800M `totalSupply()` floor derives a 200M cumulative cap across swap and FeeRouter/DAO burns; arbitrary user sink-address transfers are excluded — synced with TOKENOMICS.md v2.1
- [x] **Readiness section added 2026-08-20** — §15 Agentic Payments Readiness (verified 2026-08-20 explorer pulls; positioning draft)
- [ ] Community/DAO charter drafted
- [ ] Final version controlled with date + version

---

## 15. Agentic Payments Readiness (positioning)

The platform's home chain is not just EVM-compatible — it is live and provable. Chain numbers below were **verified by direct explorer pulls (2026-08-20)**. Competitor figures are as reported in their own published comparison (Chainspect & Token Terminal, 2026-08-20).

| Metric | IOST L2 (AITT's home chain) | Algorand | Base | Polygon | Solana |
|---|---|---|---|---|---|
| Architecture | L2 rollup · EVM (chain 182) | L1 | L2 | Sidechain | L1 |
| Block time | **1.0 s** (verified) | Instant | 13 min | 5 s | 12.8 s |
| Avg tx fee | **$0.000** — gas price 0.0 (verified) | $0.0002 fixed | $0.015 | $0.01 | $0.003 |
| Throughput | **345,594 tx/day** (verified) · 8K+ TPS claimed (L1 bench, live bench pending) | 10,000 max (claimed) | 3,600 | 3,800 | 65,000 |
| Consensus | 17 producers (PoB) | 1,541 validators | 1 sequencer | 105 validators | 690 validators |
| Uptime | **471,005,961 continuous blocks** since Feb 2019 (verified) | 100% (claimed) | Past downtime | Past downtime | Past downtime |
| x402 volume | $0 — Phase 3 (the land-grab) | $250K (95% in last 2 wks) | $45M | $850K | $9.3M |
| PQC | Phase 3 program | Falcon-1024 | — | — | — |

**What the comparison never charts — agentic trust (live in IOST Terminal today):**
- **Mandates (chain of intent):** AP2-compatible consent / intent / payment tokens, Open & Closed, hash-linked on-chain (§4.8)
- **Human control:** per-trade approval on live agent trades (Human Present); autopilot within budget (Human Not Present)
- **Trust & slashing:** stake → Trust Score → spend limits → slashing — KYA with economic teeth (§4.1)
- **Agent identity:** scoped API keys (read / paper / live) with per-agent spend rails
- **Track records:** signals hash-pinned on IOST L1 — machine-verifiable audit trails
- **Working product:** iostcallister.com live — 60s autopilot loop, paper + live lanes, 73/100 agent-native scan

**Stated gaps:** 17 producers (smaller set by PoB design) · PQC Phase 3 · peak TPS live benchmark pending · x402 volume $0 — the land-grab, not a footnote.

*Verified 2026-08-20 via l2-scan.iost.io (Blockscout) · IOSTscan · api.iost.io. Full positioning draft: `docs/AGENTIC-PAYMENTS-READINESS.md`.*

---

## 16. Quantum Readiness (posture & path)

A token is not itself quantum-resistant — the chain is. AITT inherits IOST L2 (EVM) security; its durable records are hash-anchored (SHA-256) on IOST L1, which is already quantum-strong (Grover halves 256-bit → ~128-bit). The layer we control — agent identity and payment signing — migrates to **NIST PQC standards (ML-DSA / FIPS 204)** in Phase 2–3, so the agent wallet, mandate VDCs, and x402 handshake become PQC-ready without protocol change. IOST's own L1/L2 PQC roadmap has been formally requested from the IOST team (2026-08-20). No chain in the current comparison set is end-to-end quantum-secure today — our claim is the honest version: *hash-anchored records quantum-strong now, PQC-ready agent layer by Phase 3.*

---

*IOST Terminal — AI Command Center. Proven on IOST. Free to trade. Built for humans, designed for agents.*
