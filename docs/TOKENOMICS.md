# AITT Tokenomics — Professional Design Draft (v1.7)

> **Status: DESIGN DRAFT — pre-launch. No public sale; utility-only; not an investment (§10).**
> Supersedes `docs/tokenomics-vision.md` (v0.1) in design intent; that file remains as historical record.
> This draft incorporates the Hermes review notes: 1B supply, revenue-backed incentives, legal-first sequencing, utility framing.
> **Go-live gate:** real user base + real fee revenue + legal counsel sign-off (Canada/CSA review). No TGE before that.
> v1.1 (2026-08-16): IOST 3.0 tokenomics-alignment pass — Growth Acceleration Pool (§5), fair-ordering/MEV commitment (§4.2), community-first ratio (§1, §3).
> v1.2 (2026-08-17): diligence-pass appendix (§15) — Agent Cards/DIDs identity layer, FinOps circuit breakers, KYA/AML posture. Doc-only; no locked mechanics changed (pre-launch freeze).
> v1.3 (2026-08-17): **burn cap locked (owner decision)** — cumulative burn (fee-burn + DAO buy-back/burn) capped at 200M → 800M supply floor; post-cap the 20% fee share redirects to stakers (70/30 split). Guarantees agent-operable supply.
> v1.4 (2026-08-19): **swap tax locked (owner decision)** — 3% buy/sell tax on AMM-pair swaps only (1.8% burn / 0.8% stakers / 0.4% treasury); 0% on wallet-to-wallet, staking, airdrops, platform transfers. Burn share feeds the same 200M cumulative cap; post-cap it redirects to stakers (70/30). Rationale: LP/trader-friendly — supersedes the earlier 20%-of-everything reading; platform-fee split (50/20/30) unchanged.
> v1.5 (2026-08-20): **status banner reworded (owner decision, token creation imminent)** — "pre-launch" wording stays accurate after deployment; posture unchanged (no public sale, utility-only, not an investment).
> v1.6 (2026-08-20): **quantum-readiness posture added (§16)** — hash-anchored records quantum-strong today; PQC-ready agent signing (ML-DSA) Phase 2/3; chain-level PQC question raised with the IOST team.
> v1.7 (2026-08-20): **audit checklist item replaced with Phase 2 timing note (owner decision)** — external audit remains a Phase 2 gate (before real value moves), removed as a Phase 1 checklist item.

---

## 1. Executive Summary

**AITT (Agent Intelligence Trading Token)** is the utility token of the **IOST Terminal** platform — a real-time AI trading command center for crypto & stocks, live at iostcallister.com, built for humans and designed for AI agents.

AITT powers the platform's **agentic payments economy**: it is the trust, fee, and governance layer for machine-executed transactions. It is **not** the settlement asset — agent spending settles in stablecoin/USD credits so budgets never fluctuate. AITT is earned and staked, not sold.

- **Standard:** **ERC-20 on IOST L2** (fully EVM-compatible, OP Stack rollup; IOST's official recommendation for high-frequency/low-cost scenarios — MetaMask, OpenZeppelin, x402/AP2 SDKs compatible). IOST L1 remains home to the platform's producer node (`iost_4_life`) as the payments facilitator/verifier.
- **Total supply:** 1,000,000,000 (1B) — fixed, no uncapped minting
- **Core roles:** Trust staking collateral · fee utility · rewards · governance
- **Value drivers:** real fee revenue (50% stakers / 20% burn / 30% treasury — burn capped at 200M) + staking lock-up + discretionary buy-back/burn (same cap) + 3% DEX buy/sell swap tax (1.8% burn / 0.8% stakers / 0.4% treasury, same cap)
- **Emission discipline:** rewards funded by revenue first; emission pool releases on a 48-month declining schedule; team fully vested over 4 years
- **Community-first:** 70% of supply is community/DAO-controlled (30% ecosystem rewards + 10% community + 10% reserve + 20% DAO treasury) vs 30% insider (team, partners, advisors)

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
| Deflation | Burn sources share one **200M cumulative cap (800M supply floor)**: (1) 20% of all AITT-denominated platform fees, (2) 1.8% of AITT buy/sell swap volume (3% swap tax, Phase 4 DEX), (3) DAO-voted buy-back/burn from treasury. Post-cap, all burn shares redirect to stakers (70/30) |
| Initial circulating | ≈10% at TGE (earned points conversion + ecosystem seed); remainder vesting/locked |

**Design rationale for 1B:** supply is modeled from platform economics (fee volume, staking demand, reward budget), not round-number marketing. 21B (v0.1) was rejected as retail-bait.

---

## 3. Allocation

| Category | % | Amount | Vesting / Release |
|---|---|---|---|
| Ecosystem & Agent Rewards Pool | 30% | 300M | 48-month declining emission; revenue-backed top-ups |
| Treasury (DAO-controlled) | 20% | 200M | Milestone-gated (users, volume, agent adoption) |
| Team & Core Contributors | 15% | 150M | 12-mo cliff + 36-mo linear (4 yrs total) |
| Strategic Partners & Ecosystem | 10% | 100M | Milestone-gated; partner contracts only |
| Community & Adoption Fund | 10% | 100M | Airdrops (earned only), liquidity incentives, grants |
| Reserve Fund | 10% | 100M | Insurance, emergency liquidity, buy-back/burn — DAO-voted |
| Early Supporters & Advisors | 5% | 50M | 12-mo cliff + 24-mo linear |

- No founder/team tokens are tradable before month 12.
- No category may be reallocated except by supermajority DAO vote (>66% of staked AITT).
- Unallocated/unearned rewards at end of emission schedule return to Treasury.
- **Community-first ratio:** community/DAO-controlled pools total 70% (30% Ecosystem + 10% Community + 10% Reserve + 20% Treasury) vs 30% insider — the honest analog of IOST 3.0's 97/3 community-first framing for its Growth Reserve.

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
- Fee split: **50% stakers / 20% burn / 30% treasury** until the burn cap (below) is reached; thereafter **70% stakers / 30% treasury**
- **Swap tax (Phase 4, DEX):** 3% on AMM-pair buy/sell only — 1.8% burn / 0.8% stakers / 0.4% treasury. 0% on wallet-to-wallet, staking, airdrops, and platform transfers. Implemented in the token contract via an `_update` override gated on the AMM pair address (pair set at construction or one-time, preserving the zero-privileged-functions stance); buy = user→pair, sell = pair→user
- AITT-denominated fees create ongoing demand + deflation
- **Burn mechanism:** two paths, neither granting admin "burn power": (1) **Platform-fee burn** at the settlement layer — 20% of every AITT-denominated fee is sent to the canonical null address (`0x0000…dEaD`), permanently destroyed (effect identical to a contract burn, no privileged function); (2) **Swap-tax burn** — the 3% buy/sell tax (v1.4) is burned inside the token contract by immutable protocol logic in `_update` (hardcoded split; no key can change it). DAO-voted buy-back/burn from treasury (§5) uses mechanism (1).
- **Burn cap — 200M cumulative / 800M supply floor (locked 2026-08-17; swap tax added 2026-08-19):** cumulative destruction across ALL burn sources (20% platform-fee burn + 1.8% swap-tax burn + DAO buy-back/burn) is capped at **200M AITT** = 20% of total supply, so total supply never falls below **800M** — agents always retain a working token supply. On-chain enforcement for contract burns (swap tax) = direct supply-floor check (`totalSupply() − amount ≥ 800M`); null-address burns (platform fees) are enforced at the settlement layer, where the null-address balance IS the running counter. Once 200M is reached: (1) every burn share redirects to stakers (70/30); (2) DAO buy-back/burn stops destroying — further buy-backs are held or redistributed. Platform-fee burn alone would need ~1B in cumulative AITT fees; the swap tax accelerates deflation (≈11.1B cumulative swap volume to the cap at 1.8%) — the floor remains insurance, not a constraint.
- **Fair ordering (no MEV):** as facilitator/sequencer-adjacent operator, the platform never exploits private order flow; any MEV-like surplus from transaction ordering accrues to burn. Fair ordering is part of the trust contract — slashing-enforced (IOST 3.0's MEV-redistribution principle, adapted).

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
- **Open standard (2026):** x402 is now governed by the **x402 Foundation** with reference SDKs (`@x402/core` + `@x402/evm`/`@x402/svm`, framework adapters for express/fastify/hono/next, Python, Go). Phase 3 integrates the standard — and contributes **IOST as a supported (scheme, network) pair**: the first non-EVM/Solana network in the ecosystem. Coinbase's org is a development fork of the standard, not the gatekeeper.

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

  * Burn capped at 200M cumulative (fee-burn + swap-tax burn + buy-back/burn) → 800M supply floor; post-cap burn shares redirect to stakers (70/30).

  * Swap tax (Phase 4 DEX): 3% on AMM buy/sell only → 1.8% burn (same cap) / 0.8% stakers / 0.4% treasury; 0% wallet-to-wallet.

  Agent stakes AITT ──► Trust Score ──► Spend limits ──► Settles in USD credits/stablecoin
  Slashing events  ──► reduce stake + score (misbehavior penalty)
```

**Accrual summary:** demand from fee discount + trust staking + rewards; supply pressure from burn, vesting locks, and staking lock-up; no naked inflation.

**Growth Acceleration Pool:** the DAO-controlled Treasury runs a named program funding bridge-liquidity support (Phase 4), developer grants, merchant-adoption incentives, and the security-audit fund — allocations DAO-voted, mirroring IOST 3.0's Growth Reserve priorities.

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
- **Swap tax (v1.4, separate from platform fees):** 3% on DEX buy/sell only, split 1.8% burn / 0.8% stakers / 0.4% treasury; shares the same 200M burn cap; 0% on wallet-to-wallet and platform-internal transfers

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
| Ecosystem & Rewards | 48-month linear decline (e.g., month 1–12: 6.25%/mo of pool → declining to 1%/mo by year 4) |
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

---

## 11. Phased Rollout

| Phase | Scope | Trigger |
|---|---|---|
| **0 — Points (LIVE)** | Off-chain points ledger, referral + rewards | Done — in production |
| **1 — ERC-20 deployment** | AITT ERC-20 on IOST L2, allocations + vesting contracts, points→AITT conversion tool | Contract audit *(legal ✓ 08-16, ticker ✓ 08-16)* |
| **2 — Agent wallet** | Trust staking, spend limits, approval flows, slashing; consent/intent/payment tokens (AP2-style layered mandates) | Phase 1 stable + ≥X agents onboarded |
| **3 — x402-style agent payments on IOST** | Pay-per-request API payments in stablecoin, AITT as fee/trust layer; payment sessions with 3-phase atomic budget enforcement (reserve→process→commit/rollback); AP2-compatible open/closed checkout + payment mandates (SD-JWT VDCs); IOST x402 facilitator (verify + settle, batch settlement). **Integrates the x402 open standard (x402 Foundation, `@x402/*` SDKs) and contributes IOST as a supported network** — not a from-scratch implementation | Platform agent traffic + IOST ecosystem fit confirmed |
| **4 — External liquidity** | DEX listing + EVM bridges (BSC first — PancakeSwap liquidity, CMC price data) — only after full legal review. **CEX listings (e.g., Crypto.com) explicitly out of scope.** | Demand + compliance path exists |

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
- [x] **Phase 1 contracts BUILT + free tooling audit DONE 2026-08-16** (re-run 2026-08-19 after swap tax: **36/36 tests**, Slither 0 High/Medium, Mythril clean) — `contracts/` (AITT + vesting + converter). Runbook: `docs/PHASE1_SPEC.md`
- Note: independent external audit required BEFORE Phase 2 moves real value — a Phase 2 gate, not a Phase 1 deploy gate (owner decision 2026-08-20; the free tooling pass is not an external audit).
- [x] **Points→AITT conversion mechanics BUILT 2026-08-16** (rate 1:1 locked · claim endpoint + Points UI with honesty labels "planned, not guaranteed" · gate closed until deploy + TGE gates · reserve = live points-ledger snapshot via `data/aitt-config.json`) — public AITT page `/aitt` + `/whitepaper` live (CMC-ready infra)
- [x] **Burn cap locked 2026-08-17 (owner decision)** — 200M cumulative cap across fee-burn + DAO buy-back/burn → 800M supply floor; post-cap 20% redirects to stakers (70/30)
- [x] **Swap tax locked 2026-08-19 (owner decision)** — 3% buy/sell-only AMM tax (1.8% burn / 0.8% stakers / 0.4% treasury), same 200M cap, post-cap 70/30; 0% wallet-to-wallet. Phase 1 contracts to be updated accordingly (contract-level `_update` override + supply-floor check)
- [ ] Community/DAO charter drafted
- [ ] **Agent Cards + DID identity layer spec'd (diligence appendix §15.1)** — Phase 2 scope
- [ ] **FinOps circuit-breaker thresholds modeled (diligence appendix §15.2)** — Phase 2/3 scope
- [ ] **KYA/AML posture drafted into §10 (diligence appendix §15.3)** — before Phase 2
- [ ] **Quantum-readiness posture drafted (§16) 2026-08-20** — ML-DSA agent-key migration Phase 2/3; chain-level PQC roadmap question raised with IOST team (t.me/iostdev)
- [ ] Final version controlled with date + version

---

## 15. Diligence Appendix — Agent-Platform Blueprint Review (2026-08-17)

> Scope note: folded in as design intent for later phases; **no locked mechanics changed** (pre-launch freeze respected). Source: general agent-platform blueprint (multi-agent architecture, A2A/Agent Cards, token/identity/reputation, security & governance, regulation). ≈80% of it was already covered in this doc; the delta is below.

### 15.1 Agent Cards & DID-based Identity (Phase 2–3)
- Agents publish a machine-readable **Agent Card**: capabilities, constraints, identity (DID), and on-chain reputation — enabling dynamic discovery and peer selection (agents choose counterparts by score).
- Extends §4.1: the Trust Score becomes portable reputation bound to the agent's DID, not only a platform-internal number.
- **Differentiator:** pair with the IOST Signet Ring RWA identity stack — agent DIDs issued under the same identity layer. No other agentic-payments project pairs RWA identity with agent identity.
- Formalizes the §13 risk-table line "agent identity attestation at registration" into a first-class identity layer.

### 15.2 FinOps Circuit Breakers (Phase 2–3)
- Beyond static spend limits (§4.1) and payment sessions (§4.7): continuous anomaly detection on agent spend — velocity spikes, category shifts, failed-settlement clusters — **revokes payment permissions mid-flight** until human review.
- Ex-ante complement to slashing (ex-post); answers Accenture's machine-speed fraud vector.
- Implementation: session-level tripwires + DAO-configurable thresholds (§4.4 governance already owns policy parameters).

### 15.3 KYA/AML Posture (legal extension)
- §10 covers CSA utility framing; this adds explicit **KYA** (Know Your Agent, FIDO-standardized) and AML responsibility language: agent operators (principals) are the accountable parties; the chain of intent (mandates + on-chain audit trail) is the evidence trail for KYC/AML inquiries.
- Positions existing mechanics in the regulatory vocabulary of 2026 agentic commerce. No new mechanism.

### Deferred to Phase 3 (operational, not token design)
- **A2A protocol** (Google A2A / ASAP — task-handoff beside AP2's payment mandates) and **semantic firewalls** (prompt-injection defense) — product-layer work for when the agent network exists.

---

## 16. Quantum Readiness (posture & path)

> Added 2026-08-20 (owner-requested diligence item, pre-launch freeze respected). Goal: an honest, defensible post-quantum posture — no overclaims.

### 16.1 The reality (what "quantum-resistant" means for an ERC-20)
- **A token is not itself quantum-resistant — the chain is.** AITT is an ERC-20 on IOST L2 (EVM); its on-chain security inherits the chain's signature schemes (ECDSA on EVM, Ed25519 on IOST L1) and consensus. "Quantum-resistant token" claims elsewhere are chain-level readiness claims, not token properties.
- Honest benchmark framing (Aug 2026): no network in the agentic-payments comparison set is end-to-end quantum-secure today; Algorand's Falcon-1024 is a readiness claim on its state-proof path, not live transaction security.

### 16.2 What is already quantum-strong today
- **Hash-pinned signal records on IOST L1 (SHA-256):** Grover's algorithm halves 256-bit security to ~128-bit — still strong for decades. Tamper-evidence relies on hashes, not signatures. This is the durable-record layer and it is already PQC-robust.
- No reliance on single-party signatures for audit integrity; the mandate→receipt chain (§4.8) is hash-linked.

### 16.3 What we control — the agent signing layer (the real migration path)
- **Phase 2 (agent wallet):** agent identity keys migrate to **NIST-standard ML-DSA (FIPS 204)** / SLH-DSA (FIPS 205) for long-lived agent identities and mandate VDCs (SD-JWTs can carry PQC keys — the AP2 layer upgrades without protocol change).
- **Phase 3 (x402/AP2):** PQC-ready signing in the payment handshake (facilitator verification paths).
- Platform API keys (today Ed25519/ECDSA) get a documented PQC upgrade path before long-lived credentials are issued at scale.

### 16.4 What is IOST's call (asked, not assumed)
- IOST L1 signature scheme + PQC roadmap; IOST L2 (EVM) PQC direction. Formal question raised with the IOST team (2026-08-20, t.me/iostdev). AITT's posture updates when the chain's roadmap is confirmed.

### 16.5 Claim we will make (and no more)
*"Hash-anchored records quantum-strong today; PQC-ready agent signing layer by Phase 3; chain-level PQC roadmap formally requested from IOST."* — that is the honest version of any Falcon-style readiness badge.

---

*IOST Terminal — AI Command Center. Proven on IOST. Free to trade. Built for humans, designed for agents.*
