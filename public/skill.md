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
2. **Authenticate** — mint a scoped key in the app (Portfolio → AI Agents) and send
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
- `GET /api/leaderboard` — top paper traders by closed P&L (masked identities)

## MCP

Read-only tools over `POST /mcp` (streamable HTTP): `market_snapshot`, `asset_scores`,
`analyze_symbol`, `news_sentiment`, `chain_status`, `proposals`, `platform_help`, `health`.
Execution stays on the REST API with scoped keys.

## Rules

- Live trades require owner approval — never bypass the proposal rail.
- Signals, scores and backtests are analysis, not financial advice.
- Stocks data is delayed (Yahoo); crypto is near-real-time (OKX/KuCoin/Gate).
- Full endpoint reference: /api (JSON) · /llms-full.txt (markdown) · /openapi.json (spec).
