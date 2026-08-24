# Phase 2 Spec — Agent Wallet: Trust Staking, Spend Limits, Approvals

> Status: **ENGINE BUILT + TESTED (49 checks) — off-chain, works before the token
> deploys.** Design DRAFT for the remaining pieces: on-chain staking contract
> (post-deploy), AP2 mandate chain (Phase 3). Builds on TOKENOMICS.md
> v1.0 §4.1/§4.7/§4.8 (trust staking, payment sessions, AP2 mandate model) and the
> Phase 1 contracts (`contracts/`). Phase 2 does NOT move real value until Phase 1
> is stable and externally audited.
> Date: 2026-08-16 · Owner: project owner
> Research folded in: AWS AgentCore (reserve→process→commit) · AP2 v0.2 (mandates) ·
> Cobo Agentic Wallet guide 2026-04-28 (Pact framework, MPC, emergency freeze) ·
> ChiMoney AI agent wallets 2026-08-16 (server-side policy engine, parent-child wallets,
> agent DID passports, multi-rail settlement)

---

## 1. Purpose & Scope

Give AI agents **spending authority with economic accountability** — the industry's
"how do I trust an agent with my money?" problem, solved with stake-backed credit
instead of hope.

**What Phase 2 builds:**
1. **Trust staking engine** — agents/operators stake AITT → Trust Score → credit line
2. **Spend-limit enforcement** — per-transaction / daily / weekly budgets, enforced at
   the platform layer before anything executes
3. **Approval flows** — Human Present (per-trade approval, today's model) vs
   Human Not Present (autopilot within signed budgets)
4. **AP2 layered mandates** — consent / intent / payment tokens (mapped from
   TOKENOMICS §4.8) issued by the agent wallet
5. **Fee collection + burn execution** — when AITT-denominated fees activate, the fee
   router splits 50/20/30 (TOKENOMICS §6.2) and sends the **20% to the canonical null
   address** (`0x0000…dEaD`) — permanent supply reduction with zero privileged
   functions (burn mechanism per TOKENOMICS §4.2). Transparency: label the burn
   address on the explorer (Blockscout) so destroyed supply is visible to anyone.

**What Phase 2 does NOT do:**
- ❌ Move settlement off USD credits/stablecoin — AITT stays the trust/fee layer
- ❌ Mint anything — supply is fixed (1B)
- ❌ Open the points→AITT conversion gate (that's TGE, gated separately)

**Phase 2 gates (from TOKENOMICS §11):** Phase 1 stable · external audit done ·
≥X agents onboarded (X to be set with real usage data).

---

## 2. Core Entities

| Entity | Shape | Notes |
|---|---|---|
| **Agent** | `agent:<key>` (existing identity) or registered agent profile | Same identity model as Phase 1 signals |
| **Stake** | `{agentId, amountAITT, lockDays, startTs, endTs, status: active\|unstaking\|slashed\|withdrawn}` | On-chain after token deploy; off-chain ledger before |
| **Trust Score** | `0–100` integer, derived, never stored raw | `f(stake, lock duration, compliance history) − slashing events` |
| **Spend Limits** | `{perTxUSD, dailyUSD, weeklyUSD, remainingDaily, remainingWeekly}` | Reset windows UTC-aligned |
| **Slash Event** | `{agentId, reason, pct, stakeReduced, ts, appealDeadline}` | Unauthorized spend −10% + score reset · failed settlement −5% |
| **Appeal** | `{slashId, agentId, statement, status: pending\|accepted\|rejected, decidedBy}` | 14-day window, DAO review |
| **Mandate** | `{id, kind: consent\|intent\|payment, open\|closed, constraints, signer, chainHash?}` | AP2 v0.2 mapping (§4.8) |

---

## 3. Trust Score Model

```
score = clamp(0..100,
    base(25)
  + stakeTier(amount)      // 1k=10, 10k=25, 100k=40 (AITT)
  × lockMultiplier          // 7d=1.0 · 30d=1.25 · 90d=1.5 · 365d=2.0 (capped weight)
  + complianceHistory       // +5 per 30 clean days, max +15
  − slashingPenalties       // unauthorized spend: score reset to 10; failed settlement: −25
)
```

- Score → credit line: `creditUSD = score/100 × stakeUSD × 10` (illustrative; calibrate
  on live data after Phase 1)
- Score is **recomputed on every event** (stake change, slash, compliance day-roll) —
  no stored mutable number to game

---

## 4. Spend-Limit Engine (enforcement layer)

**Where:** server-side, in the existing trade/paper/live execution path — a `lib/limits.js`
check runs **before** every order (paper, live, proposal approval). Same rails philosophy
as `executeLiveOrder` — never bypassable.

```
POST /api/agent/spend  {agentId, amountUSD, purpose}
  → 200 {approved, remainingToday, remainingWeek}
  → 402-style rejection {approved:false, reason:'daily-cap'|'per-tx-cap'|'no-stake', unmetConstraint}
```

- **Per-tx cap** from Trust Score · **daily/weekly budgets** reset on UTC boundaries
- Parallel-safety: reserve→check→commit (Phase 3's atomic session pattern, applied now
  at the ledger level so two concurrent agent calls can never overspend)
- Every rejected attempt is **audited** (append-only `data/agent-audit.jsonl`), same
  hashing rules as Phase 1

---

## 5. Staking Mechanics (Phase 2 → on-chain)

**Sequence (respects the deploy-block):**
1. **Now (no token yet):** off-chain stake ledger (`data/stakes.json`) + engine fully
   functional on paper — the UI, score, limits, slashing all work against a mirror
2. **After deploy:** stakes migrate to the on-chain contract (Phase 1 `contracts/`
   provides the pattern); the engine reads on-chain balances via the RPC; slashing =
   contract-level burn/transfer

**Parameters (locked in TOKENOMICS §8):**
- Min stake 1,000 AITT · locks 7/30/90/365d · multipliers 1×/1.25×/1.5×/2×
- Unstake cooldown 7d (status `unstaking` → withdraw)
- Slash — unauthorized spend: −10% stake + Trust reset · failed settlement: −5%
- Appeal window 14 days, DAO review (owner until DAO exists)

---

## 6. AP2 Mandate Model (agent wallet)

Three-token model from TOKENOMICS §4.8, issued server-side per agent:

| Token | Kind | Open (autopilot) | Closed (human present) |
|---|---|---|---|
| **Consent** | user-signed mandate | goals + constraints, signed once | specific action, signed per use |
| **Intent** | checkout mandate | budget + allowed instruments | final order hash |
| **Payment** | settlement authority | within budget | amount bound to intent hash |

- **Human Present** = today's per-trade approval (option C) — closed mandates
- **Human Not Present** = autopilot with budget — open mandates, agent signs closed
  intents within constraints
- `unresolved_constraint` = amount above thresholds → pull the user back in (AP2
  escalation, already the platform's "approval above thresholds" rule)
- Mandates hash-link; on-chain anchoring via IOST L1 tx hashes (existing pin
  infrastructure) — Phase 3 formalizes the x402 handshake on top

---

## 6.5 Pact-based Task Authorization (industry research: Cobo, 2026-04)

The Cobo agentic-wallet model reframes the mandate layer as **task-scoped agreements
("Pacts")** instead of standing permissions. Fold-in — our consent/intent/payment
mandate chain (§6) becomes the *inside* of a Pact:

**Pact = Intent + Execution plan + Policies + Completion conditions:**
1. **Intent** — natural-language task ("DCA $1,000 into ETH over 30 days")
2. **Plan** — the agent's proposed steps + estimated costs + risks
3. **Policies (hard limits, enforced by the platform rails, never agent code):**
   - spend caps per tx / daily / total
   - **whitelisted recipients + protocols** (adds to §4/§6: counterparty allowlists —
     consistent with TOKENOMICS §4.4 governance)
   - approved tokens/chains · required human approval above thresholds
4. **Completion conditions — auto-expiry:** time limit, budget exhausted, or goal
   achieved ⇒ pact expires ⇒ **permissions auto-revoke** (no standing access)

**Lifecycle:** intent declared → agent proposes pact → human reviews/edits/approves
(Human Present) or signs open constraints once (Human Not Present) → enforced
execution → completion → expiry → summary + audit trail.

**Emergency freeze (new first-class feature):** one-tap "freeze all agents" —
pauses every active pact instantly, stops all execution, revocable per-pact or
globally. Analog to the existing live-disable/autopilot-stop kill switches, now
generalized to the whole agent layer. Data: `data/freeze.json {frozen, reason, ts}`;
engine checks it before every execution (same rails as limits).

**Honest note on MPC (Cobo's core security claim):** full MPC threshold signing is
a custodian-scale capability (Cobo holds the second key share). This platform is
**self-custody + platform-enforced**: agent keys never touch user funds (Kraken
keys are user-held; IOST wallets are browser-generated, server never sees private
keys; AITT settlement stays on-chain escrow). Our "infrastructure-level" enforcement
= the execution rails (`executeLiveOrder`, proposal approval, limits + freeze
checks) — unbypassable by agent code, which is the same *property* Cobo achieves
cryptographically. If the platform ever offers custodial agent wallets (Phase 3+),
Cobo-style 2/2 MPC or an equivalent TSS provider is the integration path — noted,
not committed.

## 6.6 Wallet Hierarchy + Agent Identity (industry research: ChiMoney, 2026-08)

ChiMoney's model (Interledger wallets + APort DID passports, policy engine enforced
server-side) adds two structural upgrades and externally validates our enforcement
choice:

1. **Parent-child wallet hierarchy (new):** a user's wallet is the **parent**; each
   agent gets a **child wallet**. Parent controls: creation, policy inheritance,
   funding, freeze. Mirrors our existing user→agent-key ownership but formalizes it:
   `data/wallets.json {walletId, kind: user|agent, parentWalletId, ownerId, limits, capabilities, status}`.
   Enterprise shape later (org → users → agents), same pattern.
2. **Agent identity = KYA implemented (new):** ChiMoney issues W3C-DID "passports"
   with KYC/KYB for agents. This is exactly our **Know Your Agent** concept
   (TOKENOMICS §4.1) in production form — and it composes with the AP2 SD-JWT VDC
   mandate layer (§6). Phase 2 issues an agent identity record
   (`{agentId, did, attestationHash, status}`) anchored on IOST L1 (existing pin
   rails); full verifiable credentials come with the mandate system.
3. **Server-side enforcement — externally validated:** ChiMoney enforces
   `maxPerTx`/`dailyCap` server-side with clear rejection messages ("no manual
   tracking required") = the same rails design as §4/§5. Their create payload is a
   good API reference:
   ```json
   { "name": "...", "email": "...", "limits": { "USD": { "maxPerTx": 50000, "dailyCap": 100000 } },
     "approvalRequired": false, "capabilities": ["finance.payment.payout"] }
   ```
   Note the **capabilities** list — grantable scopes per agent (trade-paper,
   trade-live, pay, mandate-sign). We already have scopes on agent keys; make them
   first-class wallet capabilities.
4. **Real-time monitoring + alerts (new):** on top of the immutable audit trail,
   surface alerts for: policy violations, budget-threshold crossings, unusual
   velocity. Phase 2: `GET /api/wallet/events?since=` + a watchdog cron pushing
   Telegram alerts (same pattern as live-audit-watch).
5. **Multi-rail horizon (Phase 3+, note only):** ChiMoney routes across 10+
   payment methods / 130 countries / 5 chains / 20+ stablecoins with Interledger
   payment pointers. Our Phase 3 x402 facilitator role is the natural place for
   multi-rail settlement (stablecoin now → ILP/mobile-money later). Not Phase 2
   scope; noted so the wallet model keeps `rails` as a field.

## 6.7 Audited reference implementation (ChiMoney agent-wallet examples, MIT)

Cloned to `/opt/data/research/chimoney` (ai-passport-and-wallet-examples) 2026-08-16.
**MIT license — reusable.** What the audit confirms/adopts (API *contract*, not
their hosted backend):

- **Limits in minor units:** `limits.USD.maxPerTx/dailyCap` are cents — our
  `lib/limits.js` should use integer minor units (avoid float drift)
- **Capabilities whitelist:** `finance.*` / `wallet.*` scope strings (e.g.
  `finance.payment.payout`, `wallet.transfer`) — adopt for agent wallet capabilities
- **Rejection convention:** limit violations return **400/403 with a clear error
  message** — adopt for our spend endpoint (reject, never silently truncate)
- **Agent-to-agent payments:** pay by `email` or `interledgerWalletAddress` via a
  `subAccount`-scoped payout — the Phase 3 x402/agent-pay pattern, mirrored in our
  API shape (`POST /api/wallets/:id/pay {toAgent, amount, narration}`)
- **Transaction log:** local `transaction_log` on the agent — we already have the
  append-only audit trail (superset)

**Not portable (by design):** their hosted wallet/passport backend + ILP rails.
We self-host; we take shapes + semantics.

## 7. API Surface (sketch)

```
POST /api/stake            {amountAITT, lockDays}          → stake created (off-chain now)
POST /api/stake/unstake    {stakeId}                       → cooldown starts (7d)
POST /api/stake/withdraw   {stakeId}                       → after cooldown
GET  /api/trust/score      → {agentId, score, creditUSD, limits}
GET  /api/trust/history    → score recomputations + reasons
POST /api/mandates         {kind, open|closed, constraints} → mandate minted
GET  /api/mandates/:id     → full chain (consent→intent→payment hashes)
POST /api/slashes/:id/appeal → appeal filed
POST /api/pacts            {intent, plan?, policies, completion}   → pact proposed (agent)
POST /api/pacts/:id/approve | /reject | /terminate                → human control
GET  /api/pacts            → active pacts + history + expiry state
POST /api/freeze           {on:true, reason?} | {on:false}        → emergency freeze (all agents)
POST /api/wallets          {name, limits:{USD:{maxPerTx,dailyCap}}, approvalRequired, capabilities[]} → create agent wallet (child of caller)
GET  /api/wallets          → my wallet tree (parent → child agents)
GET  /api/wallet/events?since= → policy violations, budget crossings, velocity alerts
```
All agent-key authenticated, audited, hashed — same conventions as Phase 1.

---

## 8. Data Model (off-chain stores now)

- `data/stakes.json` — stakes + cooldowns
- `data/trust.json` — per-agent score components (stake tier, lock, compliance days, penalties)
- `data/slashes.json` — slash events + appeals
- `data/mandates.json` — consent/intent/payment tokens + hash chain
- `data/limits.json` — daily/weekly budgets + remaining (UTC reset)
- Append-only audit: existing `agent-audit.jsonl`

Atomic tmp+rename writes, boot-cached stores — same rules as every other store.

---

## 9. What Stays Locked (do not relitigate)

- AITT is NOT the settlement asset — budgets are USD credits/stablecoin
- 1B supply, no minting — staking uses existing allocation (ecosystem pool)
- Utility framing — staking is proposed platform usage, not an investment return; holding AITT earns nothing
- Phase 3 (x402) builds on this wallet; Phase 4 (DEX/bridge) only after legal review

---

## Implementation status (2026-08-16)
- **Built & tested — 56/56 checks pass** (`node tests/agent-wallet-check.mjs`, scratch data dir via `IOST_DATA_DIR`; production data never touched).
- Modules: `lib/wallets.js` (parent-child + balances + policies) · `lib/limits.js` (per-tx/daily/weekly, UTC windows, reserve→commit/release) · `lib/freeze.js` · `lib/stakes.js` (min 1,000 AITT, locks 7/30/90/365, 7d cooldown) · `lib/slashes.js` (10%/5%, 14d appeals) · `lib/trust.js` (derived score, tiers 1k/10k/100k) · `lib/pacts.js` (time/budget/goal auto-expiry).
- API live: `/api/wallets*` · `/api/spend/check|reserve|commit|release` · `/api/stake*` · `/api/trust/score` · `/api/slashes*` · `/api/pacts*` · `/api/freeze`. In API_INDEX + `/.well-known/agent.json`. Explicit spend endpoints require an active Pact bound to the same owner + wallet; pact/recipient/protocol metadata is persisted with the reservation, outstanding reservations consume Pact budget immediately, release restores capacity, and commit converts reserved capacity to spent.
- **Permissive default:** no wallet ⇒ no enforcement; execution-rail hook (`AGENT_SPEND_ENFORCE=1` opt-in, paper-open only) — existing flows byte-for-byte unchanged with the env off.
- Stores: `data/wallets.json` · `limits.json` · `freeze.json` · `stakes.json` · `slashes.json` · `pacts.json` (all atomic tmp+rename).
- NOT yet built: on-chain staking (post-deploy), AP2 mandate tokens, UI views, audit-event alerts cron.

## Open Items (decision points for the owner)

1. [ ] Credit-line formula calibration (`stakeUSD × multiplier`) — propose numbers after Phase 1 fee data
2. [ ] Future staking rewards remain undecided and inactive. The 50% stakers split is a proposed Phase 2+ design parameter only; any launch requires a separate audited staking contract, refreshed counsel approval, and explicit owner launch, and may be designed differently or never launched. **Phase 1 pays no holder or staker revenue, yield, APY, or return.**
3. [ ] Human Present default for ALL live trades (keep option C) — autopilot budgets opt-in
4. [ ] X agents onboarded gate — propose 20 agents after the wallet ships
5. [ ] On-chain staking contract — reuse Phase 1 pattern post-deploy; same free audit pass

---

*IOST Terminal — AI Command Center. Proven on IOST. Free to trade. Built for humans, designed for agents.*
