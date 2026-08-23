# AITT Tokenomics — Professional Design Draft (v1.8)

> **Status: DESIGN DRAFT — pre-launch. No public sale; utility-only; not an investment (§10).**
> Supersedes `docs/tokenomics-vision.md` (v0.1) in design intent; that file remains as historical record.
> This draft incorporates the Hermes review notes: 1B supply, revenue-backed incentives, legal-first sequencing, utility framing.
> **Go-live gate:** real user base + real fee revenue + legal counsel sign-off (Canada/CSA review). No TGE before that.
> v1.1 (2026-08-17): burn cap sync with TOKENOMICS.md v1.3 — cumulative burn (fee-burn + DAO buy-back/burn) capped at 200M → 800M supply floor; post-cap the 20% fee share redirects to stakers (70/30 split).
> v1.2 (2026-08-19): swap tax sync with TOKENOMICS.md v1.4 — 3% buy/sell tax on AMM-pair swaps only (1.8% burn / 0.8% stakers / 0.4% treasury); 0% on wallet-to-wallet, staking, airdrops, platform transfers. Burn share feeds the same 200M cap; post-cap redirects to stakers (70/30). Platform-fee split (50/20/30) unchanged.
> v1.3 (2026-08-20): Agentic Payments Readiness positioning section added (§15) — verified chain stats + agentic trust rows; H1 version corrected.
> v1.4 (2026-08-20): status banner reworded to match TOKENOMICS.md v1.5 — "pre-launch"; stays accurate once the token is deployed. Posture unchanged.
> v1.5 (2026-08-20): Quantum Readiness posture added (§16, condensed from TOKENOMICS §16).
> v1.6 (2026-08-20): audit checklist item replaced with Phase 2 timing note (mirror of TOKENOMICS v1.7).
> v1.7 (2026-08-23): pre-launch review hold added; no locked economics changed. Deployment/conversion remain frozen pending burn, custody, conversion, bridge, phase-gate, and legal remediation.
> v1.8 (2026-08-23): owner-approved remediation implemented, still pre-launch — authoritative FeeRouter burn path, contract-locked allocations, signed EVM wallet binding, atomic claim states/receipt verification, and Phase 4 hard-disable. Audit/counsel/owner gates remain closed.

---

## 1. Executive Summary

**AITT (Agent Intelligence Trading Token)** is the utility token of the **IOST Terminal** platform — a real-time AI trading command center for crypto & stocks, live at iostcallister.com, built for humans and designed for AI agents.

AITT powers the platform's **agentic payments economy**: it is the trust, fee, and governance layer for machine-executed transactions. It is **not** the settlement asset — agent spending settles in stablecoin/USD credits so budgets never fluctuate. AITT is earned and staked, not sold.

- **Standard:** **ERC-20 on IOST L2** (fully EVM-compatible, OP Stack rollup; IOST's official recommendation for high-frequency/low-cost scenarios — MetaMask, OpenZeppelin, x402/AP2 SDKs compatible). IOST L1 remains home to the platform's producer node (`iost_4_life`) as the payments facilitator/verifier.
- **Total supply:** 1,000,000,000 (1B) — fixed, no uncapped minting
- **Core roles:** Trust staking collateral · fee utility · rewards · governance
- **Value drivers:** real fee revenue (50% stakers / 20% burn / 30% treasury — burn capped at 200M) + staking lock-up + discretionary buy-back/burn (same cap) + 3% DEX buy/sell swap tax (1.8% burn / 0.8% stakers / 0.4% treasury, same cap)
- **Emission discipline:** rewards funded by revenue first; emission pool releases linearly over 48 months; team fully vested over 4 years

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
| Inflation | None — rewards drawn from allocation pools + real revenue |
| Deflation | Swap burns plus FeeRouter platform/DAO burns share one token-owned 800M `totalSupply()` floor; no dead-address burn path. |
| Initial circulating | Only the funded converter reserve is directly claimable; every other allocation is contract-locked. |

**Design rationale for 1B:** supply is modeled from platform economics (fee volume, staking demand, reward budget), not round-number marketing. 21B (v0.1) was rejected as retail-bait.

---

## 3. Allocation

| Category | % | Amount | Vesting / Release |
|---|---|---|---|
| Ecosystem & Agent Rewards Pool | 30% | 300M | 48-month linear emission vault; converter reserve deducted first |
| Treasury (DAO-controlled) | 20% | 200M | 48-hour queued milestone vault |
| Team & Core Contributors | 15% | 150M | 12-mo cliff + 36-mo linear (4 yrs total) |
| Strategic Partners & Ecosystem | 10% | 100M | 48-hour queued milestone vault |
| Community & Adoption Fund | 10% | 100M | 48-hour queued milestone vault |
| Reserve Fund | 10% | 100M | 48-hour queued milestone vault |
| Early Supporters & Advisors | 5% | 50M | 12-mo cliff + 24-mo linear |

- No founder/team tokens are tradable before month 12.
- No category may be reallocated except by supermajority DAO vote (>66% of staked AITT).
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
- Fee split: **50% stakers / 20% burn / 30% treasury** while burn headroom exists; burn-share redirect yields **64%/36% overall** at the floor
- **Swap tax (Phase 4, DEX):** 3% on AMM-pair buy/sell only — 1.8% burn / 0.8% stakers / 0.4% treasury. 0% on wallet-to-wallet, staking, airdrops, and platform transfers. Implemented in the token contract via an `_update` override gated on the AMM pair address (one-time lock at setup; no privileged functions after)
- AITT-denominated fees create ongoing demand + deflation
- **Authoritative burn mechanism:** swap-tax burns and FeeRouter platform/DAO burns all call token-owned floor/clamp logic; dead-address burns are prohibited.
- **Fee rounding:** at most 9 base units remain pending until an exact 50/20/30 split is possible; fragmentation cannot bypass burn/staker shares.
- **Post-floor behavior:** only the burn share redirects 70/30, preserving the locked base shares.

### 4.3 Rewards
- Signal providers earn AITT per quality-verified signal (existing hash-pinned-on-IOST mechanic)
- Copy-trading creators earn share of their copiers' fee volume
- Referrals, AI-feedback rewards (rate-limited), agent-compute providers
- All rewards are **earned**, never sold

### 4.4 Governance
Stake-weighted voting on platform policy parameters:
- Spend-limit defaults & approval thresholds for agent transactions
- Merchant/counterparty allowlists
- Slashing rules and appeal process
- Fee schedule
- Treasury allocations & buy-back/burn decisions
- Proposal threshold: 0.1% of staked supply; quadratic voting optional

### 4.5 Access & Tiers
- Minimum stake for agent API tiers (public tier planned)
- Priority settlement, higher throughput, advanced audit tooling at higher stake

### 4.6 Points → AITT Conversion
Live off-chain points (per the v0.1 mapping: signals +10, followers +5, referrals +50/+10, weekly top paper trader +500, AI feedback +5) convert **1:1 to AITT at TGE** — conversion is an earn-event, not a purchase. UI must label this honestly: *"planned, not guaranteed."*

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
     (fee share)  (deflation)      (DAO: dev, liquidity, buy-back/burn)

  * Burn capped at 200M cumulative (fee-burn + buy-back/burn) → 800M supply floor; post-cap the 20% redirects to stakers (70/30).

  Agent stakes AITT ──► Trust Score ──► Spend limits ──► Settles in USD credits/stablecoin
  Slashing events  ──► reduce stake + score (misbehavior penalty)
```

**Accrual summary:** demand from fee discount + trust staking + rewards; supply pressure from burn, vesting locks, and staking lock-up; no naked inflation.

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

### 6.2 Fee split (locked)
- **50% → stakers** — participants who secure the network with AITT staking receive the majority share (revenue-backed, never minted)
- **20% → burned** — deflation benefiting all holders equally; capped at 200M cumulative (800M supply floor); post-cap this share redirects to stakers (70/30 split)
- **30% → treasury** — development + DAO-voted buy-back/burn; transparent on-chain

### 6.3 Fairness commitments (why costs stay low for everyone)
- **Sub-cent microtransactions:** IOST fees are fractions of a cent vs cards' $0.30 + 3% floor — agent payments below $1 are only viable on chain-native rails
- **Batch settlement:** many micro-payments settle in one tx (x402 deferred settlement) — per-payment cost approaches zero
- **Optional fee discount:** paying fees in AITT saves 50%; nobody is required to hold or buy AITT
- **Revenue-backed rewards only:** no minting to pay yield — no inflation tax on holders (emission pool is declining, 48-month)
- **Earned, not sold:** no ICO/IDO; tokens are earned (points, rewards, staking) or vested grants
- **Progressive pricing:** enterprises pay for premium tiers; individual agents and small operators use core features free

### 6.4 Economic honesty
- Profitability is volume-dependent: node rewards first, then facilitator + network fees
- The fairness design is the growth engine: cheapest rails attract the most agents; 30% of large volume > 100% of none
- All fee parameters (split ratios, discount, facilitator %) are DAO-adjustable (§9 governance) — fairness is enforceable, not promised

---

## 7. Emission Schedule

| Pool | Schedule |
|---|---|
| Ecosystem & Rewards | 48-month linear release from the ecosystem emission vault |
| Team | 12-mo cliff, then 36-mo linear (100% vested at month 48) |
| Advisors | 12-mo cliff, then 24-mo linear |
| Partners/Marketing | Milestone-gated: users, volume, agent adoption targets |
| Initial circulating | ≈10% at TGE (points conversion + seed ecosystem) |

**Hard rule:** if reward emissions would exceed available revenue + pool balance in a period, emissions scale down — the platform **never mints** to pay yield.

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
| Appeal window | 14 days, DAO review |
| Fee share APY | Variable — derived from real fee volume, never guaranteed |

---

## 9. Governance Parameters

| Parameter | Value |
|---|---|
| Voting power | 1 AITT staked = 1 vote (time-weighted optional) |
| Proposal threshold | 0.1% of staked supply |
| Quorum | 20% of staked supply |
| Pass threshold | >50% (supermajority 66% for allocation changes) |
| Veto | Timelock + DAO council veto (24-hr) |

---

## 10. Legal & Regulatory Posture

- **Utility framing:** AITT confers use-rights within the platform (fees, staking, governance). No profit-sharing promises, no dividend rights, no implied investment return.
- **Earned, not sold:** no public sale, no ICO/IDO/IEO. Tokens are earned (points, rewards) or granted under contract (team/partners, vested).
- **Canada (CSA):** rewards/yield/buy-back language can trigger securities characterization — counsel review required before any external transferability or yield feature.
- **Geo-restrictions:** platform already blocks restricted jurisdictions; token features inherit the same allowlists.
- **Public communication:** all docs and UI must state AITT has no guaranteed value, is not an investment, and is not listed/transferable until a compliant path exists.
- **Before TGE:** contract audit + final numbers modeled on ≥3 months of real fee data. *(Legal opinion ✓ cleared 2026-08-16; ticker ✓ AITT verified 2026-08-16.)*
- **2026-08-23 hold:** staker fee-revenue/APY and external transferability require refreshed counsel review because they conflict with the current “holders earn nothing/no implied return” wording. These mechanics are not active.

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
| Token concentration | Team 15% fully vested over 4 yrs; earned-only distribution; supermajority rules |
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
- [x] **Pre-launch contracts/remediation built:** 58/58 tests; Slither 0 High/Medium; AITT Mythril clean; FeeRouter Mythril pending larger isolated worker after local OOM. Not an external audit.
- Note: independent external audit required BEFORE Phase 2 moves real value — a Phase 2 gate, not a Phase 1 deploy gate (owner decision 2026-08-20; the free tooling pass is not an external audit).
- [x] **Points→AITT plumbing built pre-launch:** EIP-191 binding, base-unit snapshot, atomic states/idempotency, receipt verification, and confirmed-only debit. Gate remains closed pending audit/counsel/owner checks.
- [x] **Burn cap locked 2026-08-17 (owner decision)** — 200M cumulative cap across fee-burn + DAO buy-back/burn → 800M supply floor; post-cap 20% redirects to stakers (70/30) — synced with TOKENOMICS.md v1.3
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
