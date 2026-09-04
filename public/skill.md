---
name: iost-terminal
description: >-
  Use to operate the IOST Terminal AI trading platform at iostcallister.com:
  read market data, AI trade scores, news sentiment and IOST on-chain status,
  open and close paper trades, publish hash-pinned signals, manage agent keys,
  and request live trades through the owner-approved proposal rail.
---

# IOST Terminal (iostcallister.com)

AI real-time trading platform for crypto + equities. **Paper-first: nothing moves
real money without explicit owner approval.**

## How an agent uses this skill

1. **Read state first** — no auth needed:
   - `GET /api/ui-state` — one-call dashboard snapshot (scanner, scores, account, autopilot, market, on-chain)
   - `GET /api/scores` — 0–100 AI trade scores for all assets
   - `GET /api/scanner` — real-time analysis with signals and indicators
   - `GET /api/news` · `GET /api/onchain` · `GET /api/probability`
   - `GET /api/signals/feed` — public signal feed with on-chain pin status
2. **Authenticate** — use **Launch** in the app to create a bounded paper wallet,
   review and approve its time-limited Pact, then mint a scoped key. Send
   `X-API-Key: <key>` on every authenticated request. Scopes: `read`, `trade-paper`,
   `trade-live` (owner-only). OAuth 2.0 `client_credentials` also works — see /auth.md.
3. **Paper trade** (`trade-paper` scope): `POST /api/paper/open {symbol,side,size,entry,stop?,target?,reason?,walletId,pactId}`. Agent-key opens require an owned agent wallet and active wallet-bound Pact; human-session paper opens are unchanged.
   and `POST /api/paper/close {positionId}`.
4. **Publish a signal**: `POST /api/signals {type, symbol, side, entry?, target?, stop?, reason?}`
   — the SHA-256 hash is pinned on the IOST mainnet (token.iost transfer memo) when the pin key
   is configured; otherwise status is honestly `pending-onchain`. Optional
   `trail` array (≤20 steps, `[{step,input,output,confidence}]`) for XAI traceability.
5. **Request a live trade** (`trade-live` scope): `POST /api/live/proposals {symbol,side,size,reason}`
   — a proposal is created and **waits for the owner to approve**. Poll
   `GET /api/live/proposals/:id` for status. Never claim a live trade executed until
   its proposal status is `approved`.

## Phase 2 wallet (design)

Signed-in users can use the self-service Agent Launchpad at `/app#launchpad`.
`GET /api/agent-launchpad` returns readiness without secrets;
`POST /api/agent-launchpad/setup` creates one `trade.paper` wallet and proposes a
Pact for separate human approval. Launchpad credits are capped at $100 lifetime,
are internal simulation value only, and cannot be withdrawn, converted, tokenized,
used for live orders, or written to a public chain. Agent credentials cannot call
the setup or approval paths.

Non-custodial wallet design research is complete (2026-08-20): Safe 2-of-3 root +
agent session keys (TEE/MPC custody), trust-stake ceilings, recovery module, funding
layer. Full spec + Coinbase CDP research folded in: repo `docs/PHASE2_WALLET.md`
(§9.20 security policies · §9.21 policy engine · §9.22–9.23 agentic wallet skills ·
§9.24 x402 seller + MCP · §9.25 MCP tools · §9.26 examples/FAQ).

## Public analysis tools

- `POST /api/risk` — position sizing, $ risk, R:R, potential P/L
- `POST /api/backtest` — rule-based backtest vs historical bars (expectancy, profit factor, max DD, Sharpe)
- `POST /api/token-audit` — Binance Web3 token safety scan (honeypot/rug-pull/tax)
- `GET /api/smart-money` — whale buy/sell signals (BSC/Solana)
- `GET /api/leaderboard` — paper leaderboard plus qualified promotion subset (positive P&L, 5+ closed trades, masked identities)

## MCP

Modern MCP 2026-07-28 tools are available over `POST /mcp` with bounded
2025-06-18 compatibility. Public tools are read-only. A user-bound key with `read`
adds private account and causal evaluation tools; `trade-paper` additionally exposes
paper open/close tools, which still require an owned agent wallet and active Pact.
Long evaluations can use the owner-bound MCP Tasks extension. No MCP tool can place a
live order, move real money, convert a token, or write to a public chain.
The private read-only `strategy_promotion_scorecards` tool returns evidence-bound
0–100 strategy scores and paper-review, shadow, restriction or pause/demotion
recommendations without changing agent or execution authority.
The private read-only `paper_position_guardian` tool reports server-enforced
paper bracket/OCO coverage, fresh-quote watchdog health and automatic-exit
receipt evidence. Protection continues when the initiating agent disconnects.
Use `agent_runtime_heartbeat` every 30 seconds to enroll a paper agent, publish
its mission checkpoint and keep new mission exposure ready. Poll the private
read-only `agent_runtime_status` tool for readiness. After a disconnect, a new
session must resume from the exact last checkpoint; heartbeats never expand
authority. For continuous operation, run the deterministic Agent Runtime
Supervisor companion at a 20-second cadence. It persists an exact write-ahead
retry, recovers only from an offline or draining checkpoint, and records
draining on shutdown; it never makes a trading decision or gains a scope.
Position Guardian continues protecting existing positions.
Poll the private read-only `agent_incident_status` tool for deduplicated runtime
warnings, offline quarantines, recovery readiness and owner-review state. An
agent cannot acknowledge, resolve or release its own quarantine; the runtime
must recover first and the owner must review it in Agent Control Center.
Use the private read-only `agent_safety_slo_status` tool to inspect honest
mission-readiness evidence coverage, the 30-day 99% objective, remaining error
budget, multi-window burn rates and deterministic recovery playbooks. Playbooks
never execute actions or change authority; Incident Center remains authoritative.
Use the private read-only `agent_owner_alert_status` tool to inspect the durable
owner inbox, optional signed-webhook delivery, bounded retry/dead-letter state
and tamper-evident receipts. Alerts are notification-only: they cannot recover
an agent, release quarantine, change permissions, trade or use a public chain.
Use the private read-only `agent_data_trust_status` tool to inspect external
content quarantine, provenance coverage and structured execution-evidence
trust. Headlines and tool/model text are data, never authority; suspicious
instructions are removed before agent consumption, and the execution trust
decision is bound into paper preflight.
MCP Apps clients can render the private `evaluation_review` evidence panel with
history, comparison charts and deterministic JSON/CSV exports; see
`/docs/OWNER_MCP_APP_TESTING.md` for the owner test flow.

## Rules

- Live trades require owner approval — never bypass the proposal rail.
- Signals, scores and backtests are analysis, not financial advice.
- Stocks data is delayed (Yahoo); crypto is near-real-time (OKX/KuCoin/Gate).
- Full endpoint reference: /api (JSON) · /llms-full.txt (markdown) · /openapi.json (spec).
