# Phase 2 Wallet Architecture — Agentic Wallets & Spend Rails (design draft)

> Status: **RESEARCH COMPLETE (2026-08-20)** — design draft for owner review.
> Source of truth for economics: `docs/TOKENOMICS.md` §4.1–4.9, §15. This doc is the
> wallet/security implementation layer. Nothing here is deployed; all addresses are
> chain-state verification results, not deployments by us.
> Companion doc: `docs/PHASE2_SPEC.md` (off-chain engine: trust staking, spend-limit
> enforcement, approval flows, AP2 mandates, fee/burn — built + tested 49 checks).
> This doc answers the "what wallet contract stack backs it" question that PHASE2_SPEC
> defers. Read PHASE2_SPEC first for the platform-layer design, this doc for on-chain.
> References: ERC-4337/7579/6900/7715/7710/1271 specs, Safe docs, Biconomy/ZeroDev/Alchemy
> implementation docs, Coinbase CDP Payments docs (reviewed 2026-08-20, §§9.7-9.13),
> Privy/Lit/Turnkey agent-wallet patterns. Full source lists in the research cache
> (`/opt/data/cache/delegation/`).

## Contents
- §0 TL;DR — chosen stack
- §1 Chain-state facts (verified)
- §2 Non-negotiables
- §3 Architecture (agent/human lanes, key lifecycle)
- §4 Trust-staking → ceiling mapping
- §5 Audit & provability
- §6 Why not ERC-4337 modular account (deferred)
- §7 Failure modes designed against
- §8 Open items before build
- §9 Funding layer (2026-08-20):
  - 9.1 Deposit address = user's own wallet · 9.2 Deposit detection · 9.3 The bridge
  - 9.4 Gas solution · 9.5 Deposit ledger & reconciliation · 9.6 Fiat on/off-ramp
  - 9.7 Coinbase Payments comparison · 9.8 Coinbase outbound stack (withdrawal template)
  - 9.9 Webhook pattern to adopt · 9.10 Payment Acceptance (session state machine)
  - 9.11 PA webhooks · 9.12 Coinbase Onramp/Offramp (not a fit) · 9.13 Onramp security
  - 9.14 Non-Custodial Wallets (closest analog) · 9.15 Auth menu + delegation webhooks
  - 9.16 MFA + custom auth · 9.17 Delegated signing (agent model) + sessions
  - 9.18 Client SDKs (N/A, 2 patterns) · 9.19 Ecosystem compatibility (adapter pattern)

## 0. TL;DR — the chosen stack

| Layer | Choice | Why |
|---|---|---|
| Root account | **Safe multisig** (2-of-3 owners, ≥1 hardware wallet) | Battle-tested, EVM-portable, module ecosystem, threshold = human gate |
| Agent authority | **Safe AllowanceModule** + **Zodiac Roles Modifier** | Per-token per-period ceilings, contract-scoped, on-chain enforced |
| Agent key custody | **TEE-wrapped session key or 2-of-2 MPC** (never plaintext) | Bounded leak: stolen key spends ≤ ceiling until revoked |
| Execution | Direct submission (gas ≈ 0 on L2); 4337 optional later | No bundler/paymaster infra needed on day one |
| Human lane | 2-of-3 Safe threshold + Recovery Module + Telegram approval | Big moves above ceiling require humans |
| Recovery | 2-of-3 guardians, 24–48h cancelable delay | Social recovery with abort window |

**Alternative considered:** ERC-4337 modular account (ZeroDev Kernel v4 / Biconomy Nexus /
Alchemy MAv2) with session-key validators. **Deferred** — see §6.

## 1. Chain-state facts (verified 2026-08-20, explorer API)

- IOST L2 = EVM chain **182**, gas = **BNB**, RPC `l2-mainnet.iost.io`, explorer
  `l2-scan.iost.io`, avg block ~143s (explorer stats), 100M block gas limit (registry).
- **ERC-4337 EntryPoint v0.6 IS deployed** at canonical `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789`
  (0 recorded txs — pre-deployed, unused; verify via RPC when reachable).
- **Uniswap Permit2 IS deployed** at `0x000000000022D473030F116dDEE9F6B43aC78BA3` (0 txs).
- EntryPoint v0.7, Safe factory, Kernel/ZeroDev factories: **NOT deployed**.
- **Only one ERC-20 on L2: IOSToken** (`0x753c1FFF50B19280f7d8Ddb34776f9eb0e9996af`,
  15 holders). **No USDT/USDC** — stablecoin gate = bridge "coming soon" (watchdog cron
  `IOST L2 stablecoin watch` alerts on arrival).
- Caveat: explorer shows `is_contract: True` but 0 tx; canonical addresses suggest real
  pre-deployments. Re-verify EntryPoint/Permit2 against RPC when network access is available.

## 2. Non-negotiables (from TOKENOMICS + the owner's stated posture)

1. **Non-custodial-with-delegation.** User owns the root authority; platform can never move
   funds alone; agent holds scoped, revocable, expiring signing power.
2. **Human at the money boundary.** Above-ceiling moves require human approval; agent handles
   the 60s autopilot lane within ceilings.
3. **On-chain enforcement for hard limits.** The EVM enforces ceilings; the platform policy
   engine is the speed layer, not the safety layer.
4. **Every agent action is provable.** Signature + policy hash + context pinned on-chain
   (matches existing hash-pinned-signal mechanic on IOST L1).
5. **Trust staking scales authority.** Spend ceiling = f(AITT trust stake, track record) —
   slashing for violations. (TOKENOMICS §4.1)

## 3. Architecture

```
┌────────────────────────────┐         ┌──────────────────────────────┐
│ HUMAN (2-of-3 Safe owners) │         │ AGENT (autopilot loop, 60s)  │
│ • 1 hardware wallet        │         │ • TEE/MPC session key        │
│ • Telegram approval UI     │         │ • policy engine (<1s decide) │
└────────────┬───────────────┘         └──────────────┬───────────────┘
             │ threshold txs                           │ session-key ops
             ▼                                         ▼
        ┌───────────────────────────────────────────────────┐
        │            SAFE (user-owned smart account)        │
        │  ┌─────────────┐  ┌──────────────┐  ┌──────────┐  │
        │  │ Allowance-  │  │ Zodiac Roles │  │ Recovery │  │
        │  │ Module      │  │ Modifier     │  │ Module   │  │
        │  │ (agent      │  │ (scope agent │  │ (2-of-3  │  │
        │  │  delegate,  │  │  to DEX +    │  │  guard-  │  │
        │  │  per-token  │  │  settlement  │  │  ians,   │  │
        │  │  ceilings)  │  │  contracts)  │  │  delay)  │  │
        │  └─────────────┘  └──────────────┘  └──────────┘  │
        │  funds: USDT (bridge), AITT, BNB (gas ~0)          │
        └───────────────────────────────────────────────────┘
             │                       │
             ▼                       ▼
     DEX router (swap)      Settlement contracts (x402 Phase 3)
```

### 3.1 Agent lane (autonomous, per-trade, 60s)
1. Policy engine (off-chain, our server) evaluates the trade intent: asset, amount,
   router, path. Checks trust-score ceiling, daily budget, category rules, circuit breakers
   (§15.2 FinOps) — **sub-second**.
2. Agent session key signs `executeAllowanceTransfer` (Safe AllowanceModule, EIP-191 hash)
   or the scoped router call under Zodiac Roles.
3. Submit directly (gas ≈ 0 on L2; no paymaster needed). On-chain AllowanceModule enforces
   the hard per-token ceiling at execution.
4. Each action logged: signer/session id, counterparty, asset+amount, policy decision,
   tx hash; decision hash pinned on-chain (IOST L1 hash-pin pattern).

### 3.2 Human lane (above ceiling / privileged)
- Withdrawals, owner changes, module install/remove, big transfers → Safe threshold (2-of-3).
- Out-of-band approval (Telegram) for large moves — existing IOST Terminal approval gate.
- Zodiac Delay Modifier on the human lane: timelock high-privilege ops.

### 3.3 Agent key lifecycle
- **Issue:** fresh short-lived session key per trading window (hours–days). Enrolled as
  AllowanceModule delegate with ceilings; registered on-chain with policy hash.
- **Rotate:** per window by default; instantly on suspicion.
- **Revoke (fastest first):** (1) policy-layer kill (milliseconds), (2) on-chain
  delegate removal / module disable (block-bounded, ~143s), (3) module uninstall.
  Ceilings sized so a leaked key can lose ≤ ~1 period ceiling before revocation lands.
- **Custody verdicts:** plain env/DB = FAIL for mainnet. Server HSM = fine for
  platform operator keys, awkward per-agent. TEE (Nitro) or 2-of-2 MPC = correct for
  agent keys (agent runtime + platform share; neither signs alone).

## 4. Trust-staking → ceiling mapping (TOKENOMICS §4.1)

- `ceiling(agent) = base(asset) × trust_score_factor(AITT stake, lock, history) − slashes`
- Per-token ceilings (USDT trading budget, AITT fee budget), per-period resets
  (AllowanceModule reset interval), per-tx value caps.
- Violations (unauthorized spend, failed settlement, policy breach) → slash → ceiling drops.

## 5. Audit & provability

- On-chain: tx + AllowanceModule delegate registration + policy hash = immutable.
- EIP-1271: the Safe validates agent-signed messages, so dApps/contracts can verify
  "the agent did X under policy P" (session pubkey + policy hash registered at session
  creation; every action is a signed digest binding action/token/amount/recipient/nonce).
- Hash-pinning: decision context (prompt/params hash, policy version, key id) committed
  on-chain — production precedent: x402 Signed Offers & Receipts, ERC-8021 Builder Code.
- Off-chain: append-only hash-chained signing log (each entry chains to previous).

## 6. Why not ERC-4337 modular account for the base? (deferred, not rejected)

- EntryPoint v0.6 exists on L2 but **no public bundler/paymaster** — we'd self-deploy the
  whole stack (EntryPoint, bundler, mempool, paymaster). Real infra cost, no day-one benefit
  on near-zero gas.
- 60s loop verdict from research: **feasible with 10–30x headroom** (session-key flow = no
  human per trade; per-op cost <$0.001 on BNB gas) — but Safe + AllowanceModule delivers the
  same scoped-automation with far less new infrastructure and Safe's longer audit history.
- Revisit when: x402 Phase 3 needs gasless UX at scale, or modular composability (passkeys,
  custom validators) becomes a product requirement. The Safe7579 Adapter keeps that door open
  without changing the root account.
- Biconomy Smart Sessions / ZeroDev Kernel v4 are the strongest 4337 session-key
  implementations if we go that route later (target/selector/calldata-bounds/spend-caps/
  expiry all enforced in validateUserOp).

## 7. Failure modes designed against

| Failure | Defense |
|---|---|
| Stolen agent key | Ceiling-bounded spend; revoke ladder; short sessions; TEE/MPC custody |
| Arbitrary execution / phishing | Zodiac Roles scoping (only DEX + settlement selectors); value=0; no delegatecall/admin in agent scope |
| Paymaster griefing (if 4337 later) | Verifying paymaster sigs, per-user quotas, deposit caps, oracle+markup, bounded gas |
| Module compromise | Audited modules, module allowlist, ERC-7484-style registry checks, timelock on module changes |
| Social engineering human approval | 2-of-3 threshold, hardware wallet owner, 24–48h cancelable recovery delay, out-of-band approval |
| Replay | Chain-bound digests, nonces, session expiries, per-session nonce namespaces |

## 9. Funding layer — deposits, detection, gas, on/off-ramp (research 2026-08-20)

### 9.1 Deposit address = the user's own wallet (non-custodial)
- Deposit address is the user's **counterfactual Safe address** (CREATE2 from owner set,
  2-of-3 incl. ≥1 hardware owner) — predictable WITHOUT deployment, so users can receive
  funds before the Safe exists; first sponsored action deploys it.
- **Same Safe address on BSC and IOST L2** (deterministic CREATE2) — the same address is a
  valid BSC address too (same EVM address space), which makes buy→bridge→trade one address.
  Wrong-network recovery becomes trivial: funds sent to the same address on BSC are visible
  on-chain and can be bridged, not lost.
- EOA fallback: user's own MetaMask/Ledger address (their seed, their keys), stored watch-only.
- **Verified blocker:** Safe singleton + SafeProxyFactory are NOT deployed on chain 182 yet
  (only EntryPoint v0.6 + Permit2 exist). Phase 2 must deploy Safe 1.4.1/1.3.0 singleton +
  factory on 182 AND BSC (same factory/singleton/saltNonce → same address both chains).

### 9.2 Deposit detection (own chain, verified)
1. **Own lightweight indexer (primary):** WS `wss://l2-mainnet.iost.io/ws` newHeads +
   `eth_getLogs` for USDT-L2/BNB/IOST `Transfer` events filtered to the user-Safe set; bridge
   arrivals = `from=0x0` mint logs on L2StandardBridge (`0x4200000000000000000000000000000000000010`,
   verified active proxy). Blocks ~0.23s, tiny (~45K gas, 1-2 tx/block), base fee 0 — trivial
   load. Native BNB deposits = tx-level (`to`+`value`), not ERC-20 events.
2. **Blockscout v2 polling (backfill only):** `GET /api/v2/tokens/{token}/transfers` with
   cursor pagination. Verified quirk: **403 without a browser User-Agent**; mint/burn render
   as `type: token_minting/token_burning`.
3. **BSC-side watch (wrong-network UX):** Moralis Streams or BSCScan API V2 (V1 deprecated
   2026). Alchemy/Covalent/QuickNode: chain 182 NOT supported — exclude.
- **Credit at 10 L2 confirmations (~2.3s)** atomically (ledger insert + balance event, one DB
  tx, unique key `(chain, tx_hash, log_index)` = idempotency; detector is the only writer).
  Withdrawals gated at 50+ confirmations. Credit ONLY on L2 — BSC USDT at user address is
  "bridge to continue" guidance, never spendable balance.

### 9.3 The bridge (verified from bridge UI bundle + docs)
- IOST L2 = **optimistic rollup on BNB Chain** (OP-Stack). OptimismPortal
  `0xbEFBd384C11a9Cce45148D8Bb91B8A8a4e925C3d` (BSC), L2StandardBridge predeploy
  `0x4200000000000000000000000000000000000010`. Deposit BSC→L2: 2-10 min typical.
  **Withdrawal L2→BSC: ~7 days finality** (FINALIZATION_PERIOD_SECONDS=604800) — UX must say so.
- **L2 gas is sponsored by IOST** — the bridge UI advertises EIP-5792 paymasterService
  (`0x95132632579b073D12a6673e18Ab05777a6B86f8`) + sessionKeys. The ecosystem already runs
  gasless L2 UX — our paymaster plan aligns.
- Assets: **BNB only today** (bundle has USDT/USDC/WBTC env wiring, not enabled). USDT =
  "coming soon" — the l2-token-watch cron fires when it lands.

### 9.4 Gas solution
- Verified: base fee = 0 today, per-tx L2 cost ≈ 0 BNB. Real costs are one-time Safe deploy
  + module setup + robustness margin.
- **Recommended: platform verifying paymaster** (ERC-4337 v0.6 is pre-deployed) sponsoring a
  whitelist: Safe deploy + AllowanceModule/Zodiac setup (one-time), first deposit/claim,
  agent ops, USDT approvals. Precedent = IOST's own bridge paymaster. Griefing controls:
  per-user quotas, whitelisted targets only, bounded gas, ERC-7562 staking.
- Auto-swap USDT→BNB: NOT available day one (no DEX/router on 182 yet) — revisit when a
  router lands. Faucet (0.0001-0.01 BNB) = fallback for EOA-direct paths only.

### 9.5 Deposit ledger & reconciliation
- `deposits(id, user_id, chain_id, asset_id, amount_raw, decimals, tx_hash, log_index,
  from_addr, to_addr, block_number, block_hash, status[pending|credited|reversed|disputed],
  confirmations_at_credit, credited_at, source[bridge_mint|direct|faucet|recovery], metadata)`
  + append-only `balance_events(user_id, asset, delta, ref_deposit_id)` — every mutation
  references its source row. Ledger = single source of truth for "what can this user trade"
  (on-chain state alone can't represent in-flight bridge deposits or fee accruals).
- Reconcile every 5-10 min: `sum(credits) - sum(debits)` == on-chain `balanceOf`; on
  mismatch → alert + quarantine user. Daily ledger snapshot for audit.

### 9.6 Fiat on/off-ramp (2026 comparison)
**Onramp recommendation: Transak primary, Ramp Network secondary.** Both support BSC + USDT
(BEP-20) directly, both deliver to a user-controlled EVM address (= the IOST L2 address,
same address space), both are merchant-of-record (provider does KYC/AML; platform stays
non-custodial, collects no PII, no money-transmitter license for the onramp).

| Provider | BSC | USDT@BSC | IOST L2 | Card fee | Bank fee | KYC (who) | Verdict |
|---|---|---|---|---|---|---|---|
| Transak | ✅ | ✅ | ❌ | 3.5-5.5% | SEPA 0.99%, ACH 1.49% | Transak (MoR) | **Primary** — widest rails, white-label, ~1 day embed |
| Ramp | ✅ | ✅ | ❌ | ~2.9% | SEPA Instant 0.49% | Ramp (MoR) | **Secondary** — cheapest EU, non-custodial ethos |
| MoonPay | ✅ | ✅ | ❌ | ~3.99%+$3.99 (7-8% all-in) | ~1.99% | MoonPay (MoR) | #3 — highest cost, brand dilution; failover only |
| Coinbase Onramp | ❌ | ❌ (USDC-first) | ❌ | ~3.99% | ACH 1% | Coinbase account | Skip — no BSC, US-centric |
| Stripe Crypto Onramp | ❌ | ❌ | ❌ | ~1.5%+$0.30 | — | Stripe (MoR) | Skip — no BSC/USDT-on-BSC |
| Sardine | negot. | negot. | ❌ | enterprise | instant ACH (US) | Sardine | Skip at Phase 2 (sales cycle) |
| Banxa | ✅ | ✅ | ❌ | 1.99-3.99% | free SEPA/Interac/PayID | Banxa | Only if user base skews AU/CA |
| Wyre | 💀 dead | — | — | — | — | — | dead since Jan 2023 |

**Off-ramp verdict: NO platform off-ramp.** User withdraws L2→bridge→BSC→their own CEX
(Kraken/Coinbase)→bank. Non-custodial integrated off-ramps exist where the PROVIDER is the
regulated entity (MoonPay Sell 1%+, Transak Sell/Stream 0.99-1.99%, Ramp sell) — add one
later ONLY if the platform must make fiat payouts (agent earnings, rewards) or retention
shows cash-out churn. Until then: clean withdrawal path + in-app docs of the CEX cash-out.

**Recommended funding journey (Route A):** "Add funds" → embedded Transak widget
(asset=USDT, network=BSC, destination=user's L2 EVM address — valid on BSC) → pay by card/
Apple Pay/local rail → USDT (BEP-20) lands on BSC → bridge to L2 (2-10 min) → trade. Buy a
small BNB (~$5-10) in the same flow for gas both sides. Sponsor first-deposit bridge gas.
**Route B (large deposits, keep):** fiat → Kraken → withdraw USDT on BEP-20 → wallet →
bridge → L2. Cheaper above ~$500, two extra steps.
**Route C rejected:** Base/USDC-first (Coinbase/Stripe) — two bridges, no BSC.

### 9.7 Coinbase CDP Payments comparison (docs reviewed 2026-08-20)
Coinbase's Payments suite is the **custodial stack** — the model IOST Terminal explicitly
rejects: Deposit Destinations auto-credit a **Coinbase custodial account**, Payment
Methods/Transfers pay out from it, fiat deposit destinations require KYC'd customers
(Customers API, `custodyFiat` capability) and are private beta, ACH-only. Requires a CDP
business account + approval. **Not a fit for a non-custodial platform.**
- Useful patterns to COPY (not use): (1) `metadata` on resources — flat string map, ≤10
  pairs, key ≤40 / value ≤500 chars, **immutable**, propagated into webhook payloads and
  transfer records (tie deposits to customer/order IDs); deposit destinations currently
  restrict values to UUID/integer strings — a sensible default for us too. (2) webhook
  `eventID` unique per (transferId, status) for idempotency. (3) `payments.transfers.processing`
  → `completed` event ladder (credit on `completed`, not `processing`). (4) liquidation
  target pattern (auto-convert incoming to target asset) = our auto-swap-to-BNB idea later.
- The non-custodial Coinbase products (Onramp, x402) are already covered above / in the
  x402 skill. x402's facilitator = the iost_4_life node play (x402-agent-payments skill).

### 9.8 Coinbase outbound stack (Payment Methods + Transfers, docs reviewed 2026-08-20)
Also custodial-only (business account + approval required), but its **lifecycle and
validation patterns are the template for our withdrawal design**:
- **Payment Methods** = external bank accounts for OUTBOUND fiat only (never inbound):
  Fedwire (USD/US), SWIFT (USD intl, 1-5 days), SEPA (EUR/EU, 1-2 days). Set up in
  Coinbase Prime UI; entity-wide. Only usable as transfer targets.
- **Transfer lifecycle to copy:** `quoted → processing → completed | failed` (+`failureReason`).
  Webhooks `payment.transfers.processing` → `completed`/`failed`. Mirror this in our
  withdrawal ledger.
- **Fee-quote-before-execute pattern (the one to adopt):** `execute: false` returns a
  `fees` array (bank/conversion/network/other) + `expiresAt`; user reviews; `POST /execute`
  before expiry. This is EXACTLY the human-at-the-money-boundary UX: quote → human approves
  → execute. Maps to Safe threshold approval + out-of-band Telegram approval.
- **`amountType`:** `source` (default; target receives minus fees) vs `target` (target gets
  exact amount, fees added to source) — pick per UX (withdrawals: `target` so user gets what
  they asked for).
- **`validateOnly: true`** preflight — validate recipient/address without persisting;
  mutually exclusive with `execute`. Adopt for our withdrawal form (validate Safe address +
  network before commit).
- **Travel rule** (`isIntermediary: true` + originator/beneficiary): required when acting as
  a VASP sending crypto for end customers. Not our Phase 2 posture (no VASP role), but the
  flag matters if we ever route through Coinbase rails for payouts (agent earnings).
- **Idempotency:** client-supplied `idempotencyKey` (UUID) on create — same pattern as our
  deposit ledger's (chain, tx_hash, log_index) uniqueness.
- Email transfers / account transfers: not relevant (no custodial accounts, no Coinbase-user
  payouts in our model).

### 9.9 Webhook pattern to adopt for ALL our receivers (Coinbase webhooks, docs 2026-08-20)
Coinbase's webhook design is the template for any inbound event feed we build (bridge
arrivals, deposit detection, Transak status, x402 callbacks):
- **HMAC signature verification (the critical part):** every request carries
  `X-Hook0-Signature` with `t=<ts>,h=<signed-header-names>,v1=<hmac>`. Verify:
  `hmac_sha256(secret, "${timestamp}.${headerNames}.${headerValues}.${rawBody}")`
  using **constant-time compare** (`timingSafeEqual` / `hmac.compare_digest`), AND reject
  if `timestamp` older than ~5 min (replay protection). Raw unmodified body required —
  use `express.raw()` / `request.get_data(as_text=True)` style, never parsed JSON.
  Reference implementations (TS/Python/Go/Ruby/PHP/Java) on the docs page.
- **Subscription config:** eventTypes list (`quoted/processing/completed/failed`),
  target URL, `isEnabled`, per-subscription `secret`; subscriptions auto-disable after
  sustained delivery failures → monitor + re-enable.
- **Event envelope:** `{ eventId (idempotency), eventType, timestamp, data }` — dedupe on
  `eventId`; act on `completed`, not `processing`.
- **Receiver best practices:** acknowledge `200` fast, process in background, support
  concurrent delivery, monitor delivery health + alert on failures.
- Apply this verbatim to: our own webhook endpoint (deposit credits), any Transak
  status-callback integration, and the x402 facilitator hooks.

### 9.10 Payment Acceptance — the closest analog to our payment sessions (docs 2026-08-20)
Coinbase Payment Acceptance is Coinbase's PSP/marketplace stablecoin stack — and its
**payment-session lifecycle is a productionized version of TOKENOMICS §4.7's
reserve→process→commit/rollback**. Enterprise-only (onboarding ~1 month, API-only), so
**not for us to use** — but the state machine is our reference design:
- **Session lifecycle:** `created → (authorize) → authorization_succeeded (funds HELD) →
  (capture) → capture_succeeded (funds SETTLED)` with `canceled/void/refund` branches.
  Exactly the AWS AgentCore reserve→process→commit pattern: authorize = reserve,
  capture = commit, void = rollback, refund = post-commit reversal.
- **Balances per session:** `capturable / captured / refundable / refunded` — running
  totals with partial captures (up to authorized) and partial refunds (up to captured).
  This is the shape our payment-session ledger should take (§4.7 atomic budget).
- **Expiries (guards, not transitions):** `authorizationExpiresAt (1d) <=
  captureExpiresAt (7d) <= refundExpiresAt (30d)`; a passed deadline BLOCKS the action but
  does NOT auto-transition — explicit cancel/void required. Adopt this semantics.
- **Capture modes:** `autoCapture: true` (instant delivery) vs manual with partial captures
  + `finalCapture: true` releases remaining hold. Maps to our autopilot (auto) vs
  human-approved (manual) lanes.
- **Authorization payload types:** `eip3009` / `permit2` / `spend_permission` /
  `erc20_approval` — same signature primitives as our x402/wallet design (EIP-3009
  preferred, Permit2 fallback).
- **x402 native:** sessions with wallet targets expose an `x402Url` for agents; `PAYMENT
  SIGNATURE` header → `402` + `PAYMENT-REQUIRED` on failure. Confirms x402 is the agent
  payment lane of the same lifecycle (Phase 3 alignment).
- **Idempotency everywhere:** `X-Idempotency-Key` (UUID v4) on authorization/capture/
  disbursement endpoints — duplicate requests return identical responses.
- **Reserved metadata keys → report columns** (`captureReference`, `merchantReference`,
  `paymentShortCode`...): settlement reports read them out of `metadata`. Nice pattern for
  our reconciliation exports.
- **Disbursements** = session-independent payouts (rebates, goodwill, agent earnings) —
  `pending → succeeded | failed` + webhooks; our "rewards/payouts not tied to a session"
  future. Reports: recurring CSV via SFTP (daily/weekly/monthly, 00:00-02:00 UTC) for
  reconciliation/audit — copy the cadence, not the SFTP.

### 9.11 Payment Acceptance webhooks (docs 2026-08-20) — confirmations + deltas
Same CDP webhook infra as §9.9 (X-Hook0-Signature HMAC, eventId dedupe, ACK-200-then-process,
auto-disable on sustained failures). Deltas worth recording:
- **Full event set:** 14 `acceptance.payment_session.*` events (created, canceled,
  authorization/capture/void/refund × pending/succeeded/failed) + 3
  `acceptance.disbursement.*` (pending/succeeded/failed). Subscribe to ONLY the terminal
  outcomes (authorization_succeeded/failed, capture_succeeded/failed) to halve noise.
- **Payload shape:** `data.paymentSession` (summary: status/amount/balances/
  externalReferenceId/metadata) ALWAYS present; action-triggered events add a sibling
  `data.authorization|capture|void|refund` with onchainTransactions hashes. Session-level
  events (created/canceled) have no action field.
- **Errors:** action events carry `error: {code, message, occurredAt}` (e.g.
  `insufficient_funds`) — the `failed` events are the alert triggers, mirror in our ledger.
- **Quirk:** `void_succeeded` webhook events are reserved but NOT yet emitted — don't
  build logic that depends on void webhooks; poll or use capture/refund events instead.
- **Reports:** Payment Acceptance reports are NOT self-serve (contact-team-only today),
  unlike Transfers reports (Portal recurring + SFTP). Our reconciliation should follow the
  Transfers report column model (source/target/fees breakdown) regardless.

### 9.12 Coinbase Onramp/Offramp (docs 2026-08-20) — confirmed NOT a fit, patterns to copy
**Verdict update: Coinbase Onramp is NOT a fit for IOST Terminal's funding journey**, on
three counts:
1. **Supported networks exclude BSC and IOST L2** — L1s (Bitcoin, Ethereum, Solana,
   Polygon, Avalanche) + L2s (Base, Optimism, Arbitrum) only. No BSC → USDT-on-BSC route
   (our §9.6 Route A) impossible. Confirms Transak/Ramp as primary.
2. **Guest Checkout (debit card/Apple Pay via hosted widget) is DEPRECATED June 30, 2026** —
   the only no-Coinbase-account path dies; remaining hosted path requires Coinbase account.
3. **Headless Onramp is US-only, card-only, $2.5K/wk cap, access fee** — the opposite of
   IOST Terminal's global-retail, lean posture.

**What Coinbase Onramp looks like (for reference):** session token (single-use, 5-min
expiry) → one-click-buy URL (`pay.coinbase.com/buy/select-asset?sessionToken=...&defaultAsset=
&defaultNetwork=&presetFiatAmount=&partnerUserRef=&redirectUrl=`) → user pays card/Apple
Pay/ACH/Coinbase balance → crypto lands at the destination wallet address bound to the
token. Quote API returns `payment_total / payment_subtotal / coinbase_fee / network_fee /
quote_id` + ready `onramp_url` when `destination_address` provided. Offramp exists too
(ACH US, PayPal select countries, Coinbase balances) but is hosted-only.

**Patterns to copy:**
- **Session token binding:** server creates a single-use, short-expiry token bound to the
  destination wallet address + client IP. Our widget integration (Transak) should do the
  same — token per user session, bound to their Safe address.
- **Config/Options discovery APIs:** Onramp Config (country → payment methods incl. US
  state subdivisions) + Onramp Options (fiat → crypto assets, each with networks +
  `chain_id` + `contract_address`). This is exactly the "which assets can this user buy"
  pattern our funding UI needs; we should serve a similar options endpoint for
  (country, subdivision) → (USDT-on-BSC, BNB) availability.
- **Quote structure:** `payment_total` vs `payment_subtotal` + separate `coinbase_fee` /
  `network_fee` line items — copy for our fee transparency (§9.8 amountType pattern).
- **`partnerUserRef`** (<50 chars) for transaction tracking — we already have
  externalReferenceId/metadata; keep one consistent ref field across all integrations.
- **Limits model:** $500/wk default → dynamic up to $2.5K; 15 lifetime tx cap → upgrade
  via SSN-last-4 + DOB (identity, not full KYC). Shows the *shape* of a lean limits ladder
  (relevant to trust-staking spend limits in TOKENOMICS §4.1-4.9) — we'd use stake-based
  limits, not SSN.
- **OTP verification API:** initiate → submit → 60-day validity, no self-built OTP infra.
  Useful if we ever need phone/email verification for agent-key recovery.

### 9.13 Onramp API surface + security requirements (docs 2026-08-20)
**API reference (for completeness):** Session Token `POST /onramp/v1/token` (addresses[]
with per-address blockchains, clientIp — REQUIRED, do NOT trust X-Forwarded-For, optional
assets filter) → single-use 5-min token. Transaction Status
`GET /onramp/v1/buy|sell/user/{partnerUserRef}/transactions` (paged). Buy/Sell Quote
`POST /onramp/v1/buy|sell/quote` — **rate limited 10 req/s per app ID (429
rate_limit_exceeded)**. Buy/Sell Config & Options for country/asset discovery. All
server-side (never client-side): the API key must never ship to the browser.

**Security requirements — apply verbatim to OUR funding endpoints (the valuable part):**
1. **CORS strict allowlist:** `Access-Control-Allow-Origin` must list only approved origins
   — NEVER `*`. A malicious site must not be able to drive our backend into creating
   onramp sessions / funding operations. If an endpoint is mobile-only, return NO CORS
   header at all (denies all cross-origin browser calls).
2. **Authenticated session creation:** require user auth before minting session tokens —
   wallet-signature verification (user signs message containing wallet address + timestamp,
   proving key ownership without exposing it) OR existing JWT/session auth. We already have
   both primitives: Safe owner signature (EIP-1271) + platform JWTs. **This is the
   anti-hijack control for our Transak widget integration too** — never create a widget
   session for an unauthenticated caller.
3. **Domain allowlist for redirects:** `redirectUrl` must match the allowlist or it's
   SILENTLY IGNORED (transaction completes, user isn't redirected back). Formats:
   `https://app.com` (all sub-paths), `https://*.domain.com` (wildcard subdomain),
   `custom-scheme://path` (mobile deep links). Silent-ignore is a good default posture for
   our own redirect validation — never fail loudly with user funds in flight.
4. **Session binding recap (from §9.12):** token bound to destination wallet address +
   client IP; single-use; 5-min expiry. Any widget flow (Transak/Ramp) should mint an
   equivalent one-time session scoped to the user's Safe address.

### 9.14 Coinbase Non-Custodial Wallets — the closest product analog (docs 2026-08-20)
Coinbase's non-custodial wallet stack is **the same architecture we designed, shipped as a
managed service** — a strong validation of the PHASE2_WALLET choices, and its open-source
Spend Permission Manager is a direct reference for our AllowanceModule:
- **Two auth models:** User (email/SMS/social login, React SDK, `createOnLogin: eoa|smart`)
  and API key (server-controlled, `CDP_WALLET_SECRET`, TS+Python SDKs). Private keys live
  in a **Trusted Execution Environment** — Coinbase's answer to agent-key custody is
  exactly our TEE recommendation (§3.3). Their "non-custodial" = user can export keys
  anytime, but the ENCLAVE operates them. We self-host the same pattern.
- **Smart Accounts = ERC-4337** (same as our §6 deferred path): batch calls, gas
  sponsorship via ERC-7677 paymaster (CDP's native paymaster is Base-only; custom
  `paymasterUrl` for everything else), builder codes (ERC-8021). **Supported on BNB Chain
  mainnet** — relevant since our bridge anchor is BSC. NOT on IOST L2, as expected.
- **EIP-7702 (worth tracking):** upgrades an existing EOA in place with smart-account
  capabilities (batch, sponsorship, spend permissions) KEEPING THE SAME ADDRESS — Coinbase
  sponsors the delegation tx on mainnets. If chain 182 ever supports EIP-7702, this is a
  lighter alternative to deploying Safe factories (no CREATE2 proxy needed; the EOA itself
  becomes the account). Note: our §9.1 counterfactual-Safe design already gives same-address
  properties without 7702, so this is a "watch" item, not a pivot.
- **Send/sign surface:** `sendTransaction` auto-handles gas estimation/nonce/signing/
  broadcast on supported chains; `signTransaction` for custom RPC chains (our chain 182
  path = sign + broadcast via our own RPC, exactly like the IOST L2 pattern); EIP-191 /
  EIP-712 typed-data / raw hash signing all available — same primitives as our
  x402/wallet design.
- **Swaps:** `getSwapPrice` (price + slippage + `issues.allowance` preflight) then
  `executeSwap`; **Permit2-based** (per-swap permit signed automatically, ERC-20 approval
  to Permit2 contract required); native gas token via sentinel address
  `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`. Good reference shape for our future
  on-L2 swap UI once a DEX/router lands.

**★ Spend Permissions — the direct AllowanceModule analog (open-source, copyable):**
- **Spend Permission Manager contract** (`0xf85210B21cC50302F477BA56686d2019dC9b67Ad`,
  deployed on Arbitrum/Avalanche/Base/Ethereum/Optimism/Polygon; source:
  github.com/coinbase/spend-permissions) enforces **onchain** spend limits — account grants
  a spender a per-token allowance over a time period; spender calls `useSpendPermission`
  within limits; `getCurrentPeriod` returns spent-so-far.
- **Permission tuple:** `{account, spender, token, allowance(uint160), period(uint48),
  start, end, salt, extraData}` — per-token ceilings with rolling or fixed windows, salt
  for permission uniqueness, extraData for context. This is functionally Safe
  AllowanceModule's model and validates our §3.1/§4 design (per-token ceilings,
  per-period resets).
- **Lifecycle ops:** create (user op), list (as account or spender), `useSpendPermission`
  (spender side), revoke (by permission hash). **Revoke is a first-class op** — mirrors
  our §3.3 revocation ladder (on-chain delegate removal).
- **Verdict:** don't deploy their contract (not on 182, and Safe AllowanceModule is our
  chosen root) — but use it as a **second reference implementation** alongside Safe's
  AllowanceModule when we draft our module allowlist and ceiling semantics. The
  `{token, allowance, period, salt, extraData}` tuple is the cleanest public spec of
  "agent can spend X of token Y per Z days."

### 9.15 Wallets: onramp UX, auth menu, delegation webhooks (docs 2026-08-20)
- **Onramp UX (skip):** Apple Pay onramp = US-only/iOS-only/React-Native-only + verified
  email+SMS; Cross-Platform FundModal = Coinbase Onramp widget (no BSC/182, §9.12).
  Nothing to adopt; our Transak embed (§9.6) is the right shape. Noted UX pattern: the
  FundModal flow (wallet → fund → widget → success modal) is the reference for our "Add
  funds" UX.
- **Auth menu for non-custodial wallets (the useful part):** CDP user wallets offer
  email OTP (10-min expiry), SMS OTP (5-min; **explicit SIM-swap risk warning in docs** —
  good caution for us), social login (Google/Apple/X/Telegram OAuth), SIWE (EIP-4361),
  and optional TOTP MFA for high-value ops. Device-bound wallets, ≤5 devices, Wallet
  Secret rotation. For IOST Terminal: our human lane already uses Telegram approval; if we
  add wallet UI auth, mirror this menu (email OTP + MFA on withdrawals) minus the SMS-SIM
  risk. Custom OAuth (bring-your-own Google/Apple/X/Telegram apps) exists but binds
  redirect URLs to Coinbase domains — only relevant if we used their product.
- **★ Delegation webhooks (the keeper):** `wallet.delegation.created` /
  `wallet.delegation.revoked` + every `wallet.transaction.*` / signing webhook carries
  `user_id` + `delegation_id` when the operation ran via a delegation grant — **exact
  on-chain-attribution pattern we want**: every agent action attributable to (user,
  delegation grant). Our equivalent: session-key enrollment + policy hash on-chain (§5),
  ledger rows keyed by (session_id, policy_id). Transaction lifecycle events
  (`created → signed → broadcast → confirmed|failed`, plus `pending` after 30s with gas
  params for replacement decisions) = a fine template for our own tx-status webhook
  ladder (already covered by §9.9/§9.11; this confirms the `pending`-is-not-failure
  semantics).
- **x402 buyer-side (Phase 3):** CDP's `useX402` hook (`fetchWithPayment`) auto-handles
  402 → sign → retry for user wallets — the consumer-side of our x402 facilitator (Phase
  3). Works with Smart Accounts/EOAs/Solana. Confirms the pattern; we build the
  server/facilitator side ourselves (x402-agent-payments skill).

### 9.16 MFA + custom auth (docs 2026-08-20) — the human-lane guard pattern
- **MFA protects ALL signing/sending/key-export ops** (signEvmHash/TypedData/Message/
  Transaction, sendTransaction, sendUserOperation, key-export iframe). Enrolled users get
  an automatic prompt; unenrolled users aren't enforced. This maps directly onto our
  human lane (§3.2): MFA-as-gate on above-ceiling/privileged ops = our Telegram-approval
  UX, but with TOTP as the standard complement.
- **Methods:** TOTP (any authenticator app) + SMS (E.164; SIM-swap risk noted in docs).
  Enrollment = QR scan → 6-digit confirm; verification = initiate → submit 6-digit; error
  code `MFA_REQUIRED` on protected ops when verification is pending. Both methods
  enrollable for backup; lost-device recovery = other method or primary-auth reset.
- **★ MFA session scoping (the design detail):** CDP-managed auth → MFA session scoped
  to the ACCESS TOKEN (per-tab/per-device; one tab's verification doesn't satisfy another;
  carries over on token refresh). Custom auth → scoped to USER IDENTITY (one verification
  satisfies all sessions). Per-token scoping is the safer default for a trading platform —
  our approval session should be scoped to the session/device, not globally to the user.
- **Custom auth (JWKS + JWT from your own IdP):** CDP validates your IdP's RS256/ES256
  JWTs against a configured JWKS endpoint; user identity = `sub` claim (or configured
  claim: email/user_id — must be unique, stable, non-empty, lowercase+underscore ≤64).
  JWT max TTL 7 days; `getJwt` callback always fetches fresh tokens; sessions managed by
  your IdP. **Relevant pattern:** IOST Terminal already has its own auth — if we ever
  embed CDP-style wallets this is the integration path, and the "identity claim must be
  stable (changing it creates a new wallet)" rule is a good warning for our own
  user-identity design. Mutual exclusivity note: custom auth and CDP built-in auth can't
  both be enabled (per project).
- **SIWE (EIP-4361)** — already covered in §9.15: wallet-signature auth as an option;
  CDP has a one-line "Sign in with Base" for Base apps; we already have Safe-owner
  signatures (EIP-1271) for the same purpose.

### 9.17 Delegated signing, sessions, linking, best practices (docs 2026-08-20)
- **★ Delegated signing = our agent-delegation model, productionized:** user grants a
  TIME-BOUND delegation from the frontend; backend then signs/sends on their behalf with
  only API-key + Wallet Secret (user offline). This is exactly our §3.3 agent-session
  lifecycle: grant (createDelegation w/ expiry) → operate (signEvmTransaction/
  sendEvmTransaction/sendUserOperation by userId+address) → revoke (either side, before
  expiry).
  - **Two scopes:** user-scoped (all of a user's accounts; 1 active per user; revoke =
    all at once) vs account-scoped (one account; 1 per account; revoke = one at a time).
    Account-scoped is the finer-grained default for agent keys — matches our per-account
    session keys. **Mutually exclusive per user** — switch requires revoking all first.
  - **Security notes:** only the ONE grant step needs the user present; expiry is the
    hard backstop (use shortest expiry that fits); revocation is a first-class op (both
    sides). Mirrors our revocation ladder (policy kill → on-chain delegate removal).
  - Delegation webhooks (`wallet.delegation.created/revoked` + attribution) were already
    captured in §9.15 — this page is the mechanism behind them.
- **Auth method linking (multi-factor identity):** link email + SMS + OAuth + SIWE to ONE
  wallet; each linked method verified before linking. Auto-linking merges Google/Apple
  sign-in to an existing email-OTP account with the same @gmail.com/@icloud.com email
  (prevents duplicate accounts). **UX pattern to copy:** progressive security — prompt to
  add a second factor as account value grows (basic user → 1 method; funded user → 2;
  high-value → multiple). Maps to our trust-stake scaling (§4). Errors: METHOD_ALREADY_LINKED,
  ACCOUNT_EXISTS.
- **Session model:** dual-token — access token 15-min expiry, refresh token 7 days (re-auth
  after 7d). MFA sessions expire independently of tokens. For us: our approval sessions
  should similarly be short-lived + refreshable, with MFA/approval re-prompt on expiry
  (aligns with §9.16 per-token scoping).
- **Server-side validation:** frontend access token → backend `validateAccessToken` →
  get endUser. Standard pattern we already follow for IOST Terminal JWTs.
- **Best practices checklist (adopt):** domain allowlist + HTTPS-only + rate limiting on
  auth endpoints + session timeouts; check auth state before starting flows; avoid
  redundant verification; clear messaging/error/loading/success states; choose
  component/hooks/direct-API by customization need (we're direct-API / custom-UI).

### 9.18 Client-side SDKs (React/RN/Swift/Next.js/theming, docs 2026-08-20) — N/A, 2 patterns
Coinbase's prebuilt UI components, hooks, React Native/Swift SDKs, and Next.js template
are their product's integration layer — **not applicable** since we're not embedding their
wallets (they don't support chain 182 and we self-host). Two patterns worth noting for OUR
frontend work (iostcallister.com, plain HTML/JS app):
- **Next.js-style server/client separation:** root layout stays a server component (no
  wallet imports), all wallet/auth functionality in `"use client"` components; provider
  wraps the app; viem used for read-only chain data while the wallet SDK handles signing.
  This is the correct architecture if IOST Terminal ever moves to Next.js — and matches
  our existing split (server.js backend + app.html frontend).
- **Semantic-token theming system:** a small set of semantic tokens (bg/fg/line/typography)
  inherited by component tokens; override a few semantic tokens → whole UI re-themes;
  dark/light via CSS variables in `@media (prefers-color-scheme)`. Clean pattern for the
  IOST Terminal dark neon theme — define semantic tokens once, derive everything else.
  (Also: their default font stack "Rethink Sans" + "DM Mono" is a decent starting point.)
- React Native + Swift SDKs: only relevant if a mobile app is ever planned (not in Phase 2
  scope). Apple Pay onramp (US/iOS-only, §9.15) is the only mobile-specific feature, also
  not in scope.

### 9.19 Ecosystem compatibility — how a custom wallet plugs into standard tooling (2026-08-20)
The important takeaway isn't the CDP packages (we don't use their wallets) — it's the
**compatibility pattern**: any non-standard account can be wrapped to work with the whole
standard EVM tooling stack:
- **viem:** CDP accounts wrap via `toAccount(cdpAccount)` → viem Custom Account → works
  with `createWalletClient`/`createPublicClient` everywhere. This is EXACTLY the pattern
  our Safe-based stack should adopt: implement a viem Custom Account adapter for the Safe
  (sign via AllowanceModule/Zodiac-scoped session key, broadcast via our chain-182 RPC),
  and every viem-based tool (frontend, scripts, tests, x402 facilitator) works unchanged.
- **eth-account/web3 (Python):** `EvmLocalAccount(cdpAccount)` wrapper gives
  `sign_message` / `sign_typed_data` / `sign_transaction` against the eth-account signer
  interface → drop-in for web3.py code. Our Python tooling (backtest gate, cron scripts,
  deposit indexer) should expose the same `LocalAccount`-shaped wrapper around the agent
  session signer so web3.py code paths can sign without change.
- **wagmi (React):** `CDPEmbeddedWalletConnector` implements the wagmi Connector
  interface (EIP-1193 provider) → all wagmi hooks (`useSendTransaction`, `useAccount`,
  etc.) work. For us: a wagmi `Connector`-shaped adapter around our Safe session key would
  make the whole React dapp ecosystem usable — but IOST Terminal is a plain HTML/JS app,
  so this is only relevant if we adopt wagmi later.
- **Wallet Standard (Solana):** universal wallet interface (connect/disconnect/events/
  signMessage/signAndSendTransaction) so wallets work across dapps without vendor lock-in.
  The `cdp:` custom feature flag pattern (namespaced features) is a nice idea for our own
  agent-wallet interface — namespace agent-specific capabilities (policy check, ceiling
  query) as custom features so standard tooling ignores them and our platform uses them.
- **Verdict:** adopt the adapter pattern — implement viem `toAccount`-compatible + eth-
  account `LocalAccount`-compatible wrappers around our Safe session signer at build time
  (cheap, high leverage: unlocks every standard EVM tool for testing, scripting, and the
  x402 facilitator).

### 9.20 CDP Wallets security & policies (docs 2026-08-20) — custody validation + client-boundary patterns
Five docs: Security Overview, Domain Allowlisting, App Attestation (overview/iOS/Android).
We don't use their wallet service — extract the security postures that map to us:

- **TEE custody validated (Security Overview):** CDP runs wallet keys in AWS Nitro
  Enclaves with **no persistent storage, no interactive access/SSH, no external
  networking**; keys are encrypted/decrypted inside the enclave and never leave it in
  plaintext. This is exactly our agent-key custody choice (TEE Nitro or 2-of-2 MPC §3).
  Copy the non-negotiable: enclave has no network path except VSOCK-style local IPC to the
  request handler.
- **Two credential classes, split by role (Security Overview):** (1) **Temporary Wallet
  Secret** — device-specific key material generated/stored locally on the end-user's
  device (user-auth); (2) **Wallet Secret** — developer-managed, **rotatable** key
  material (API-key auth). Mirrors our model: user-owned Safe owner keys (device/hardware)
  vs agent session keys (server/TEE, rotated per window §3.3). Both are ECDSA P-256 for
  CDP's own API auth — irrelevant to our secp256k1 chain keys; the pattern (device-bound
  user credential + server-managed rotatable credential) is what transfers.
- **2FA ladder (Security Overview):** physical security keys / passkeys > authenticator
  apps / push > **SMS last — "avoid SMS as a primary 2FA method"**. Confirms our §9.16
  call (skip SMS, SIM-swap risk). Adopt: passkey/TOTP on high-value ops (withdrawals,
  module installs).
- **OFAC sanctions screening (Security Overview):** CDP blocks transfers to sanctioned
  addresses **before they are submitted onchain** — no extra integration. For us: optional
  platform-layer address screening (blocklist check pre-broadcast, free-tier list or defer
  to Phase 3; compliance posture belongs in TOKENOMICS §15.3 pass).
- **Domain allowlisting (Domain Allowlisting):** CDP Portal enforces a CORS allowlist —
  only listed origins (`<scheme>://<host>:<port>`, ≤50 domains) may call wallet APIs;
  protects against malicious sites hijacking the wallet integration. **Never allow
  `localhost` in production** (local malware can impersonate the frontend). Applies to OUR
  web surface too: any browser-callable endpoint (Transak session creation, x402
  facilitator, wallet API) must carry a strict origin allowlist, never `*` — we already
  committed to this in §9.13; now it's a hard rule with a concrete format.
- **App attestation = mobile-only, enforced at the AUTH boundary (overview):** iOS =
  Apple App Attest (device-bound key, physical device, iOS 14+, simulators rejected);
  Android = Google Play Integrity (Play Store-distributed only — any track incl. Internal
  Testing, release-signed, ADB installs rejected, Android 6+). Attestation runs at login:
  reject the unauthenticated client once and **every downstream action is protected**.
  Web is NOT covered — attestation has no effect on web apps; the web analog is domain
  allowlisting (above).
- **For us: N/A until a mobile app exists** (IOST Terminal is a web app). But the
  *enforcement point* transfers: authenticate the CLIENT (domain + session binding + MFA
  at session creation) and every subsequent action inherits the protection — no per-action
  client checks needed. If an RN mobile client ever ships, Apple App Attest / Play
  Integrity is the standard to adopt (teamID.bundleID / package name + Play Integrity API
  service account).
- **Rollout pitfall (overview/iOS/Android):** enabling attestation in the portal takes
  effect IMMEDIATELY — users still on old clients without the attestation package get
  hard authentication errors. Operational rule for us: never flip a mandatory auth gate
  until the new client code is fully rolled out (matters with our boot-cached docker
  restart ship loop — ship client first, gate second).

### 9.21 Policy Engine (docs 2026-08-20) — the reference rule-engine shape for our policy layer
Four docs: Policy Engine Overview, EVM Policies, Solana Policies, Solana IDL Policies.
This is Coinbase's off-chain transaction-governance engine — the closest production analog
to our off-chain policy engine (§3, §4). Copy the evaluation semantics + criterion taxonomy:

- **Evaluation semantics (Overview) — adopt verbatim:**
  - Policy = `{scope, rules[]}`; rule = `{action: accept|reject, operation, criteria[]}`;
    criteria are logical expressions on the operation's parameters.
  - **Rules evaluated in order; FIRST matching rule's action applies.** No match →
    **REJECTED (fail-secure default).** This is exactly our §3/§4 posture (and our
    AGENT_KEYS fail-closed memory) — now backed by a production reference impl.
  - **Scope layering: project-level policy evaluated first, then account-level.** Mirrors
    our trust-staking: platform baseline caps (global: per-trade max, network allowlist)
    + per-account ceilings (user trust-stake-derived). Two layers, project wins on first
    match — no ambiguity about precedence.
  - Policy mutation requires a privileged scope ("Manage (modify policies)") — for us:
    only the owner/human lane may edit policies, never the agent.
- **EVM criterion taxonomy (EVM Policies) — the checkable dimensions:**
  - `evmAddress` in/`not in` — recipient allowlist/denylist.
  - `ethValue` <= — native value cap.
  - `netUSDChange` (changeCents, <=) — fiat spend limit; **their caveat: only evaluated
    for mainnet txs** — for us this needs a price oracle on chain 182 (no native USD
    feed); defer or implement as AITT/USDT-denominated ceiling instead.
  - `evmNetwork` in — chain restriction (we: chainId==182 only).
  - `evmMessage` regex (`^MyApp:.*`) — **app-prefix restriction on EIP-191 messages**.
    Adopt: agent-signed messages must match `^IOST:` — kills phishing-by-arbitrary-sign.
  - `evmTypedDataVerifyingContract` in — **restrict EIP-712 to our known verifying
    contract** (settlement contract address). Adopt: agent lane signs EIP-712 ONLY for
    our settlement contract; everything else rejected.
  - `signEvmHash` supports NO criteria — their example is **reject-all hash signing**.
    Adopt for agent keys: raw hash signing (eth_sign / EIP-191 personal_sign / blind
    hash) = hard-reject. Agents sign structured, restricted EIP-712 only.
- **Token-level restriction (Solana Policies):** `mintAddress` in — only USDC/USDT mints
  allowed; `programId` in — only System/Token programs. EVM equivalent = per-token
  allowlist by contract address + calldata amount checks. Confirms our "wrong token, not
  wrong recipient" rule (§3): per-token caps, token contract allowlist for agent lane.
- **Instruction-level calldata validation (Solana IDL Policies) — the deep pattern:**
  `solData` decodes instruction data against an IDL and validates **argument-level**
  conditions before signing (`amount <= 100000`, `decimals == 6`); conditions OR within
  a criterion, params AND within a condition; operators `==,<=,>=,<,>,!=,in,not in`.
  On EVM this = selector allowlist (Zodiac Roles, already ours) PLUS abi.decode calldata
  arg checks where cheap (limit `amountIn` on swaps, `amount` on token transfers, exact
  `decimals`). Add arg-level ceilings for the settlement-contract calls the agent lane
  is scoped to — mirrors solData at near-zero cost (static ABI, no IDL infra).
  Their discriminator tables (4-byte u32 SystemProgram, 8-byte SHA256 Anchor) = our
  selectors; we already whitelist target+selector in Zodiac — arg checks are the next
  depth level.
- **Decimals reference (Solana Policies):** SOL 9, USDC/USDT 6 — trivial but keep a
  canonical token-decimals table for the policy engine (BEP-20 USDT = 18 on our chains —
  never assume 6 from the Solana docs; per-chain metadata table required).
- **Verdict:** our policy engine design is validated end-to-end; add these four specifics
  at build time: (1) ordered first-match fail-secure evaluation with project→account
  layering, (2) EIP-712 verifying-contract restriction + `^IOST:` message prefix for agent
  lane, (3) raw-hash-signing hard-reject for agent keys, (4) token-contract allowlist +
  calldata arg ceilings on the scoped settlement calls.

### 9.22 Agentic Wallet (docs 2026-08-20) — Coinbase's productized version of our Phase 2/3
Three docs: Agentic Wallet Overview, CLI Welcome, CLI Quickstart. Coinbase now ships the
exact product we're building (agent wallet + spending limits + x402) — custodial, Base/
Polygon/Solana only. **Not a fit** (no IOST L2/BSC, keys live in Coinbase infra — violates
our non-custodial + chain-182 constraints), but it's the strongest validation + reference
for our Phase 2/3 shape:

- **Product = our roadmap, shipped:** agent holds stablecoins, sends, trades, pays x402,
  with per-session + per-transaction spending limits enforced BEFORE any transaction,
  KYT + OFAC screening. That's §3 + §9.21 + Phase 3 facilitator, productized by the
  biggest exchange. We're on the right track; they validate the whole category.
- **Two interfaces (CLI vs MCP):** CLI (`npx awal ...`) = wallet ops (send/trade) +
  skills library (`npx skills add coinbase/agentic-wallet-skills` — Vercel AI SDK skills:
  authenticate/fund/send/trade/search-for-service/pay-for-service/monetize-service);
  MCP (`@coinbase/payments-mcp`) = pay-only, no send/trade, for any MCP client.
  **The agent-facing surface is a skills/tool library, not a bespoke API** — matches our
  model (Hermes skills + agent API keys). Our Phase 3 agent UX = same shape: skills for
  the agent, CLI/API for testing.
- **Auth = initiate/verify OTP (Quickstart):** `awal auth login <email>` → `flowId` →
  `awal auth verify <flowId> <otp>` → `status`. Two-step auth with an explicit flowId is
  the production pattern; our email-OTP (§9.16) should expose the same initiate/verify
  shape (flowId + code + expiry), not a one-shot magic link.
- **CLI surface worth mirroring (Quickstart):** `status` / `balance [--chain]` / `address`
  / `send <amount> <recipient> [--chain]` / `trade <amount> <from> <to>` / `x402 bazaar
  search <query>` / `x402 pay <url>`; `--json` on every command for machine-readable
  output; `persistence enable` for long-running agent sessions. This is the right minimal
  agent-wallet CLI — adopt the command set + --json convention for our own agent ops CLI
  (Phase 2 build time; cheap, familiar to any agent).
- **x402 = the money protocol (CLI Welcome + Overview):** both interfaces do x402
  (`search-for-service` / `pay-for-service`). `awal x402 pay <url>` is the **buyer-side**
  client — the reference implementation for testing our Phase 3 facilitator's seller side
  (we build the facilitator + x402 Signed Offers & Receipts, §3/§9.19). Use awal as a
  test client against our facilitator once Phase 3 lands (Base-only caveat: our tests
  run on chain 182, so adapt the flow, not the client).
- **AgentKit comparison (CLI Welcome):** AgentKit = full onchain SDK (deploy contracts,
  multi-network); Agentic Wallet CLI = wallet-ops only. Neither fits (custodial, wrong
  chains) — viem + Safe + our own policy engine stays the build path (§9.19 adapter
  pattern covers the standard-tooling gap).
- **Networks:** Base, Base Sepolia, Polygon, Solana, Solana Devnet; trade = Base mainnet
  only. No BSC, no IOST L2 — chain-182 stays a first-mover advantage for agentic-wallet
  platforms, not a deficiency.
- **Verdict:** don't use, DO copy — the skills-library agent interface, initiate/verify
  OTP, minimal CLI command set + `--json`, and awal-as-x402-buyer-test-client. All four
  land at Phase 2/3 build time.

### 9.23 Agentic Wallet skills library (docs 2026-08-20) — the agent-facing surface, skill by skill
Six docs: Skills Overview, authenticate-wallet, fund, send-usdc, trade, search-for-service
(+ pay-for-service / monetize-service referenced from overview). The 7-skill set is the
reference decomposition of "agent wallet ops" into agent-callable capabilities — the exact
shape our Hermes-skill-based agent surface should take:

- **Skill anatomy (Overview) — the structure to copy:** each skill = Name, **Description
  (trigger phrases, e.g. "send money, pay someone, transfer USDC, tip, donate")**,
  Instructions (step-by-step), CLI Commands, and **Allowed Tools — commands the agent can
  run WITHOUT prompting**. The Allowed Tools field IS the permission boundary: it declares
  per-skill which ops are autonomous vs which need human confirmation. Our skills must
  carry the same declared-allowed-tools contract (maps to §9.21 policy engine + our
  per-agent spend rails).
- **The 7 skills = our capability checklist:** authenticate-wallet, fund, send-usdc,
  trade, search-for-service, pay-for-service, monetize-service. Every one of these has an
  IOST Terminal analog (auth / Transak-fund / send / swap / service discovery / x402 pay /
  monetize = Phase 3 facilitator). Build our skill set to mirror this naming so any agent
  familiar with the category maps over with zero friction.
- **Authenticate (authenticate-wallet):** two-step email OTP (login→flowId→verify);
  "If the agent has access to the user's email, it can read the OTP code directly —
  otherwise ask the user." Notable trust decision: the agent MAY complete the auth loop
  itself when it holds mailbox access; the skill decides. For us: agent keys are
  TEE/session-based (never OTP-gated), but the *skill-level* decision "can this agent
  complete this flow autonomously" belongs in our skill metadata, same as them.
- **Fund (fund):** `awal show` opens a companion UI → preset amounts ($10/$20/$50) or
  custom → payment method (Apple Pay / Coinbase / card / bank) → Coinbase Pay → USDC on
  Base. **Preset-amount + custom funding UI = the shape for our Transak embed** (§9.6);
  "instant card/Apple Pay, 1-3 days bank" = the processing-time ladder to show users;
  direct-transfer fallback (`awal address` → send USDC to wallet address) = our deposit
  address §9.1.
- **Send (send-usdc) — amount parsing + error contract:** `send <amount> <recipient>
  [--chain] [--json]`; amounts: `$1.00` / `1.00` / atomic (integers >100 = atomic units).
  Errors are **actionable and agent-readable**: "Not authenticated → run auth login",
  "Insufficient balance → check balance and fund", "Could not resolve ENS name",
  "Invalid recipient". Adopt: our agent ops CLI returns the same error shape (code +
  resolution hint), never raw stack traces — agents need machine-actionable failures.
- **Trade (trade):** `trade <amount> <from> <to> [-s slippage_bps] [--json]`; slippage in
  basis points (100 = 1%); **token alias registry** (usdc/eth/weth → contract address +
  decimals) so agents never hand-write addresses. For us: AITT/usdt/bnb/iost aliases →
  address + decimals per chain (validates our §9.21 decimals-table requirement; aliases
  are the agent ergonomics layer on top). Errors: invalid token, self-trade,
  TRANSFER_FROM_FAILED (= insufficient balance or approval — the classic agent trap),
  no liquidity, decimals-mismatch.
- **Search for service (search-for-service) — the free-discovery pattern:** `x402 bazaar
  search <query> [-k n] [--force-refresh] [--json]`, `x402 bazaar list [--network]
  [--full]`, and **`x402 details <url>` — probes an endpoint until 402 and shows price,
  accepted payment schemes, network, input/output schemas WITHOUT paying**. No auth or
  balance needed to search. Local cache ~/.config/awal/bazaar/, 12h refresh. Adopt for
  our facilitator: discovery/preview endpoints are free and machine-readable (402-gate
  only the actual request); search + details = the buyer-side UX every agent expects.
- **Verdict:** our skill-based agent surface is the right call — copy their skill
  anatomy (trigger phrases + allowed-tools boundary), amount parsing, alias registry,
  actionable-error contract, and free-discovery x402 pattern. All land at Phase 2/3.

### 9.24 x402 seller side + MCP distribution (docs 2026-08-20) — our facilitator reference impl
Four docs: pay-for-service, monetize-service, MCP Overview, MCP Quickstart.
**monetize-service is the reference implementation for our Phase 3 facilitator** — the
seller-side x402 pattern spelled out end to end. MCP adds the distribution channel.

- **The x402 flow (monetize-service) — what we build server-side:** client hits protected
  endpoint without paying → server returns **HTTP 402 with payment requirements** → client
  signs a USDC payment → retries with a payment header → **facilitator verifies + settles**
  → server returns the response. Our facilitator on chain 182 = same protocol, our
  settlement contract + our own facilitator (not x402.org/CDP).
- **The seller middleware shape (x402-express) — adopt for our facilitator:**
  `paymentMiddleware(payTo, routes, facilitator?)`; route key = `"METHOD /path"`; value =
  price string or config `{price, network, config: {description, inputSchema
  {bodyType, bodyFields}, outputSchema, maxTimeoutSeconds}}`. Register **free endpoints
  (health/status) BEFORE the payment middleware** — only routes after it are gated. This
  is the exact free-discovery + 402-gating pattern from §9.23, productionized.
- **Buyer-side (pay-for-service):** `x402 pay <url> [-X method] [-d json] [-q params]
  [-h headers] [--max-amount <n>] [--correlation-id <id>] [--json]`. **`--max-amount` =
  per-call spend cap in atomic units — the buyer-side bound on worst-case loss from a
  compromised/leaked agent key.** Make max-amount MANDATORY in our x402 client (never
  default to unlimited). `--correlation-id` groups related ops → map to our payment-
  session idempotency/ledger (§9.10) for reconciliation.
- **Pricing guidelines (monetize-service) — the AITT service price ladder:** simple data
  lookup $0.001–0.01; API proxy/enrichment $0.01–0.10; compute-heavy query $0.10–0.50;
  AI inference $0.05–1.00. Use as the default price bands when listing AITT/agent
  services on our future bazaar.
- **MCP distribution (MCP welcome/quickstart):** `npx @coinbase/payments-mcp` installs
  into Claude Desktop / Claude Code / Codex / Gemini CLI / any stdio-compatible client;
  agents discover + pay x402 services with **no API keys, no seed phrases**; wallet UI =
  auth (email OTP), fund (Onramp or Receive/QR), **spending-limit tracker (max per call
  + max per session)**. "**Your agent can't change these — only you can.**" = the human
  boundary again, now as an explicit product rule (matches our §9.21 human-lane-only
  policy edits + per-trade approval).
- **Spending limits UX (Quickstart):** two numbers — max per call (e.g. $0.05) + max per
  session (e.g. $5.00) — set in the wallet UI, agent cannot touch. Adopt this two-knob
  model verbatim in our wallet UI (maps to §9.21 per-op ceiling + §3.3 per-session
  ceiling; the visual tracker is a nice UX affordance for our dashboard).
- **For us: MCP = future distribution channel, not Phase 2.** Our agent surface is
  Hermes skills + agent API keys (§9.22/9.23). But the stdio-MCP shape (discover → pay →
  report) is the universal agent interface; expose our facilitator via MCP at Phase 3+
  so any MCP client can pay our endpoints without our SDK. Also copy: the Bazaar
  **Discover tab with copy-ready prompts** per service — the agent-onboarding UX.
- **Verdict:** monetize-service = build our facilitator to the same contract (402 flow,
  route config, free-before-gated ordering, pricing bands); make max-amount mandatory in
  our buyer client; keep MCP as the Phase 3+ distribution channel.

### 9.25 MCP tool surface (docs 2026-08-20) — the least-privilege agent toolset, tool by tool
Eight docs: MCP Tools Overview, get-wallet-address, get-wallet-balance, show-wallet-app,
check-sign-in-status, list-bazaar-resources, get-resource-details, make-x402-request
(+ check-payment-requirements, 8th tool referenced in overview). **The most valuable page
yet for our agent-tool design: the MCP tool surface is the minimal, least-privilege agent
toolset — 8 tools total, and the money actions are human-only.**

- **The tool surface (Overview) — adopt the split verbatim:**
  - **Wallet tools (4, all read/UX):** get-wallet-address, get-wallet-balance,
    show-wallet-app (opens UI: sign-in, fund, Bazaar browse, history, limits),
    check-sign-in-status (runs automatically at agent-session start — adopt: our agent
    session bootstrap checks auth status first).
  - **Payment tools (4):** list-bazaar-resources (discover), get-resource-details
    (docs before paying), make-x402-request (the ONE spend tool), check-payment-
    requirements (price check without paying).
  - **Check-payment-requirements (8th tool, final page):** probes a NON-Bazaar x402 URL
    and returns required payment amount, accepted payment schemes, accepted networks,
    endpoint details — WITHOUT paying. Bazaar-listed services use get-resource-details
    instead (richer: schemas + descriptions). So the discovery ladder is: Bazaar search
    → get-resource-details (listed) OR check-payment-requirements (arbitrary URL) →
    make-x402-request. Adopt the same two-tier pre-pay inspection in our facilitator
    client (curated registry docs vs on-the-fly 402 probe, §9.23/9.24).
  - **What agents CAN'T do (Overview) — the money boundary as product rule:** set
    spending limits, **transfer funds to arbitrary addresses**, add funds (onramp) — all
    UI-only, human-only. **Agents can ONLY pay for x402 services**, inside limits.
    This is the least-privilege pattern our agent keys need: agent toolset = read +
    discover + ONE bounded spend path; anything else requires the human lane (§9.21
    policy edits, per-trade approval). No arbitrary `send` for agents, ever.
- **Deterministic address per identity (get-wallet-address):** "The address is fixed to
  your authenticated email — it doesn't change between sessions." = our counterfactual
  Safe property (§9.1): same address every session, predictable pre-deploy. Confirms the
  pattern; ours is stronger (same address across BSC + 182 via CREATE2).
- **Balance = pre-payment gate (get-wallet-balance):** agent checks USDC balance before
  paying, human-readable ($5.00). Our agent loop already does balance checks — keep
  human-readable amounts + "if zero, fund" next-step hint in the tool response.
- **Discovery with trust signals (list-bazaar-resources):** returns per service: name,
  description, **price per call, quality score, transaction count** (e.g. "Gloria AI
  News $0.01 · Score 0.87 · 529 txs"). Adopt for our bazaar: price + quality score +
  tx count = the ranking/trust display agents and humans both read.
- **Docs-before-pay (get-resource-details):** agent calls this automatically BEFORE
  paying to understand the API (endpoint, method, params, body schema, payment amount/
  network, response schema). Pay nothing until you know how to use it — enforce the
  same ordering in our facilitator client flow.
- **The one spend tool (make-x402-request):** discover → pay USDC → call API with
  payment proof → return response. "Payments are instant and onchain — they cannot be
  reversed"; gas sponsored; **"If the payment exceeds your spending limits, the agent
  will notify you before proceeding"** = limit-check-then-ask escalation, the exact
  pattern for our agent lane when a trade would breach a ceiling (propose → human
  approval, §3.3).
- **Verdict:** our agent API-key scopes (read/trade-paper/trade-live) map cleanly onto
  this tool taxonomy; add the missing pieces at build time: agent-session auth-status
  bootstrap, bazaar trust signals (score + tx count), docs-before-pay ordering,
  limit-breach → human-approval escalation, and NO arbitrary-send tool for agents.

### 9.26 MCP examples + FAQ (docs 2026-08-20) — cost-transparency UX + the custody contrast
Two docs: Example Workflows, FAQ. The workflow examples are the product UX we should
mirror; the FAQ settles the custody question and confirms the boundary rules.

- **Cost transparency in every agent answer (Examples) — adopt:** every example
  workflow ends with a spend line ("Total: $0.02 USDC"; news digest "Total: $0.03 USDC";
  token analysis "Total: $0.04 USDC"). The agent reports exactly what it paid, broken
  out per service. **Our agent loop should do the same: every trade/signal report shows
  the cost line** — pairs with our hash-pinned track records (provable outcome + provable
  cost). This is the trust UX that makes spend rails visible instead of scary.
- **Multi-service composition (Examples):** agents compose 2-3 paid services per task
  (CoinGecko + Twitter; Gloria AI + TechCrunch + aggregator; CoinGecko + Twitter Intel +
  RootData), each $0.01-0.02, score + tx count shown per source. That's our future bazaar
  shape: per-service price + trust signals, agent composes, total reported.
- **Custody answer (FAQ) — note the contrast:** "Is this custodial? No. You control your
  embedded wallet through email/OTP." — but the CLI security page said "private keys stay
  in Coinbase infrastructure." Either way the weak point is: **wallet is tied to the
  email — "lose access to your email → work with your email provider."** Ours is strictly
  stronger: Safe 2-of-3 + Recovery Module guardians (24-48h cancelable delay) — no single
  email as the root of failure. Differentiator to keep in the competitive note.
- **Payment-fail semantics (FAQ):** "No funds are deducted" on failed payment (insufficient
  balance / network / service unavailable); agent notifies and can retry. Adopt in our
  settlement flow: idempotent failure, never partial deduction, retry path with
  notification. Refunds: x402 is instant/onchain — refunds depend on the service provider,
  contact them directly (matches §9.24 irreversibility; our AITT services should define a
  refund policy explicitly, they punt to the provider).
- **Cost model (FAQ):** MCP free, wallet creation free, **gas sponsored**, x402 service
  calls vary, onramp standard fees. = our model exactly (free platform, sponsored L2 gas
  via paymaster §9.4, fees only at fiat on/off-ramp).
- **No API keys (FAQ):** auth = embedded wallet email/OTP. Ours differs deliberately:
  scoped agent API keys (read/trade-paper/trade-live) ARE the auth for autonomous agents
  — we keep both lanes (§9.25 boundary + human OTP lane).
- **Troubleshooting patterns (FAQ):** `status` / `install --force` / `--verbose` /
  reinstall ladder; security = HackerOne + SECURITY.md. Copy: a SECURITY.md + private
  disclosure path in the iost-terminal repo (we're PUBLIC-no-license — a disclosure path
  is table stakes).
- **Verdict:** examples/FAQ close the MCP story — adopt cost-transparency lines, idempotent
  no-deduction failure, explicit AITT refund policy, and a SECURITY.md disclosure path.

## 8. Open items before build

**Wallet core (§1-7):**
- [ ] Verify EntryPoint v0.6 / Permit2 via RPC (network access) — confirm real pre-deploys
- [ ] Confirm USDT bridge timeline (watchdog will fire) — stablecoin is the pay asset
- [ ] Decide agent-key custody: TEE enclave (self-hosted, Turnkey/Openfort-style) vs
      2-of-2 MPC (Privy Model 2 fastest compliant option)
- [ ] Draft Zodiac Roles scope: exact DEX router + settlement contract allowlist
- [ ] Mid-tier external audit BEFORE Phase 2 moves real value (TOKENOMICS §11 gate)
- [ ] KYA/AML posture (§15.3) before Phase 2

**Funding layer (§9, added 2026-08-20):**
- [ ] Deploy Safe singleton 1.4.1/1.3.0 + SafeProxyFactory on chain 182 **AND BSC**
      (same factory/singleton/saltNonce → identical user Safe address both chains;
      prerequisite for counterfactual deposit addresses §9.1)
- [ ] Build the deposit micro-indexer (§9.2): WS newHeads + eth_getLogs → Postgres ledger;
      Blockscout v2 poller as backfill
- [ ] Design the withdrawal ledger with Coinbase-style lifecycle (§9.8): quoted →
      processing → completed|failed, fee-quote-before-execute, validateOnly preflight,
      idempotencyKey
- [ ] Embed Transak widget (primary onramp, §9.6) with session-token binding + CORS
      allowlist + authenticated session creation (§9.13) — never mint widget sessions for
      unauthenticated callers
- [ ] Webhook receiver with X-Hook0-style HMAC verification + eventId dedupe (§9.9)
- [ ] Payment-session ledger mirroring reserve→process→commit + capturable/captured/
      refundable/refunded balances + expiry-as-guard semantics (§9.10)
- [ ] Reconciliation job (5-10 min): ledger vs on-chain balanceOf; quarantine on mismatch
      (§9.5); daily snapshot; Transfers-report column model for exports (§9.11)
- [ ] Decide paymaster: verify IOST's EIP-5792 paymasterService pattern before building our
      own; gas ≈ 0 today makes this non-urgent (§9.4)
- [ ] Origin allowlist module for ALL browser-callable endpoints (Transak session creation,
      x402 facilitator, wallet API): strict CORS allowlist, scheme://host:port format,
      never `*`, no localhost in prod (§9.20)
- [ ] Decide OFAC-style address screening (platform-layer blocklist pre-broadcast, free
      list vs Phase 3 deferral; feeds TOKENOMICS §15.3 posture) (§9.20)
- [ ] Rollout rule for auth gates: ship client code fully, THEN enable mandatory
      auth/attestation gates (boot-cached restart loop — client first, gate second) (§9.20)
- [ ] Policy engine: ordered first-match fail-secure rules, project→account scope layering,
      policy edits owner/human-lane-only (§9.21)
- [ ] Agent-lane signing restrictions: EIP-712 verifying-contract allowlist (settlement
      contract), `^IOST:` prefix on EIP-191 messages, raw-hash signing hard-reject (§9.21)
- [ ] Token-contract allowlist + calldata arg ceilings (abi.decode) on scoped settlement
      calls; per-chain token-decimals metadata table (never assume 6) (§9.21)
- [ ] Agent-ops CLI mirroring awal: status/balance/address/send/trade + `--json`, agent
      skills library as the agent-facing surface (skills, not bespoke API) (§9.22)
- [ ] Email-OTP auth as initiate/verify (flowId + code + expiry), not one-shot magic link
      (§9.22)
- [ ] Phase 3: awal CLI `x402 pay` as buyer-side test client against our facilitator
      (§9.22)
- [ ] Skill anatomy for agent surface: per-skill Allowed Tools (autonomous vs
      human-confirm boundary), trigger-phrase descriptions, actionable error codes
      (code + resolution hint, never raw stacks) (§9.23)
- [ ] Token alias registry in agent CLI: AITT/usdt/bnb/iost → address + decimals per
      chain; amount parser ($ / decimal / atomic) (§9.23)
- [ ] x402 free-discovery for facilitator: search + `x402 details`-style preview (price,
      schemes, schemas) gated only at actual request; 12h cache (§9.23)
- [ ] Facilitator = x402-express-style middleware: route config {price, network,
      description, input/outputSchema}, free endpoints before gated ones, 402 flow with
      our settlement contract (§9.24)
- [ ] Buyer-side x402 client: MANDATORY --max-amount per-call cap, --correlation-id →
      payment-session idempotency (§9.24)
- [ ] Spending-limits UX: two-knob max-per-call + max-per-session in wallet UI, agent
      cannot change (§9.24)
- [ ] Phase 3+: MCP adapter for facilitator (stdio) so any MCP client can pay our
      endpoints; Bazaar Discover tab with copy-ready prompts (§9.24)
- [ ] Agent toolset = least-privilege: read + discover + ONE bounded spend tool; NO
      arbitrary-send for agents; agent-session auth-status bootstrap (§9.25)
- [ ] Bazaar trust signals (price + quality score + tx count); docs-before-pay ordering
      in client flow; limit-breach → human-approval escalation (§9.25)
- [ ] Cost-transparency line in every agent report (per-service + total spend); idempotent
      no-deduction payment failure + retry; explicit AITT refund policy (§9.26)
- [ ] SECURITY.md + private disclosure path in iost-terminal repo (public repo = table
      stakes) (§9.26)
