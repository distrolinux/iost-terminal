# IOST Terminal — AI Real-Trading Platform

AI real-time trading platform for crypto + stocks. Live market data, AI scoring,
scanner, risk engine, portfolio AI, news sentiment, IOST on-chain dashboard,
assistant, paper trading and an AI journal. **Paper execution only** — no real
money moves without exchange keys + explicit enablement.

## Design docs & specs

| Doc | What it covers |
|---|---|
| [`docs/PHASE2_WALLET.md`](docs/PHASE2_WALLET.md) | **Phase 2 non-custodial wallet design** (2026-08-20): Safe 2-of-3 + AllowanceModule + Zodiac scoping, agent session keys, TEE/MPC custody, trust-stake ceilings, recovery, funding layer (deposits/bridge/gas/on-ramp), and 7 sections of Coinbase CDP research folded in (§9.20–9.26: security policies, policy engine, agentic wallet CLI/skills, x402 seller side + MCP) |
| [`docs/PHASE2_SPEC.md`](docs/PHASE2_SPEC.md) | Phase 2 agent-wallet engine (off-chain): trust staking, spend limits, approvals, AP2 mandate chain (Phase 3) — engine built + tested |
| [`docs/AITT_LAUNCH_READINESS.md`](docs/AITT_LAUNCH_READINESS.md) | Component-by-component AITT readiness matrix, machine-enforced holds and remaining external gates |
| [`docs/AITT_REVIEW_2026-08-24.md`](docs/AITT_REVIEW_2026-08-24.md) | **Current AITT pre-launch review disposition** — deployment/conversion hold |
| [`docs/AITT_PRELAUNCH_REMEDIATION_SPEC.md`](docs/AITT_PRELAUNCH_REMEDIATION_SPEC.md) | Owner-approved burn, custody, conversion, gate, legal and bridge remediation architecture |
| [`docs/AITT_COUNSEL_REVIEW_BRIEF.md`](docs/AITT_COUNSEL_REVIEW_BRIEF.md) | Refreshed counsel questions and required written launch approval |
| [`docs/TOKENOMICS.md`](docs/TOKENOMICS.md) | AITT tokenomics v2.4 source (pre-launch hold) |
| [`docs/AITT-Whitepaper-v1.0.md`](docs/AITT-Whitepaper-v1.0.md) | Public AITT whitepaper draft synchronized to v2.4 mechanics |
| [`docs/PHASE1_SPEC.md`](docs/PHASE1_SPEC.md) | Phase 1 contracts spec |
| [`docs/PHASE4_BRIDGE_DEX_SPEC.md`](docs/PHASE4_BRIDGE_DEX_SPEC.md) | Phase 4B local-only bridge, finality, DEX-verification, and LP-custody specification; deployment and liquidity remain disabled |
| [`docs/COMPETITIVE-NOTE-etoro.md`](docs/COMPETITIVE-NOTE-etoro.md) | Competitive note: eToro copy-trading vs our agent marketplace |
| [`docs/AGENT_TRUST_ARENA.md`](docs/AGENT_TRUST_ARENA.md) | Paper-only Agent Trust Arena evidence model, scoring formulas, audit chain, API and limitations |

## Quickstart

```bash
cd /opt/data/iost-terminal
npm start          # or: node server.js  → http://localhost:8787
npm test           # offline safety/regression suite; never places live orders
```

## Production deployment

`deploy-host.sh` pulls the supported Node 24 LTS base, builds an immutable image,
boots a candidate with an isolated
scratch data mount and live credentials disabled, and waits for `/api/health`
before pausing and renaming the existing production writer. The promoted
container must pass both internal and public health checks or the previous
container is unpaused and restored automatically. Deployments are serialized
with `flock` and reject dirty working trees, unmanaged port `8787` listeners,
and duplicate app containers.

Run `PREFLIGHT_ONLY=1 ./deploy-host.sh` to build and health-check the isolated
candidate without pausing, replacing, or otherwise modifying production.

The first deployment migrates the legacy bind-mounted container to immutable
images. One paused last-known-good process is retained until the next healthy
candidate, preserving the exact prior runtime without allowing it to write.
The script never places live orders or performs public-chain writes.

Production monitoring, encrypted backups, off-host copies, isolated restore
verification, and the incident-only restore procedure are documented in
[`docs/PRODUCTION_OPERATIONS.md`](docs/PRODUCTION_OPERATIONS.md). These operations
remain separate from deployment and do not enable any money or token boundary.

## Safety boundaries

- Live orders fail closed when a trustworthy market/limit price is unavailable; the configured notional cap is always applied.
- Agent live proposals acquire a persisted `executing` lease before Kraken is called, preventing duplicate approval requests from placing duplicate orders.
- Per-user agent keys need `trade-paper` for both opening and closing paper positions.
- Agent-key paper opens fail closed unless they include a positive `entry` + `size` and an owned `walletId` with an active wallet-bound `pactId`; limits and Pact budget are reserved before execution and committed only after success. Human-session paper trading is unchanged.
- `/api/spend/check|reserve` require an active wallet-bound `pactId`; recipient/protocol policies are checked before reservation, outstanding reservations count against the Pact budget, and the pact identity is bound into the server-side reservation used at commit.
- Production password-reset tokens are never logged. Development console delivery is opt-in with `AUTH_DEV_RESET_LOG=1` and is disabled when `NODE_ENV=production`.

## Engines

| Module | What it does |
|---|---|
| `lib/scanner.js` | Real-time AI scanner: unusual volume (z-score), momentum/breakouts, RSI/MACD, support/resistance, MA crossovers, ATR volatility, whale/large-trade alerts |
| `lib/score.js` | 0–100 AI trade score per asset: momentum, technical setup, volume, news sentiment, on-chain activity, risk |
| `lib/assistant.js` | AI trade assistant — "why is IOST moving today?" answered from live data |
| `lib/risk.js` | Position sizing: account size + max risk % + entry + stop → size, $ risk, R:R, potential P/L, exposure |
| `lib/portfolio.js` | Portfolio AI: whole-portfolio exposure, concentration, composition, suggestions |
| `lib/news.js` | News + sentiment engine (RSS, key-free): headlines classified bullish/neutral/bearish |
| `lib/onchain.js` | IOST mainnet dashboard via public RPC: head block, TPS, active addresses, large transfers, gas/RAM |
| `lib/paper.js` | Paper trading engine + AI journal (every trade: entry, stop, target, reason, AI confidence, result) |

## Data sources

- Crypto: OKX (primary) → KuCoin → Gate.io (Binance/Bybit geo-blocked from this host)
- Stocks: Yahoo Finance (delayed) → FMP demo fallback
- On-chain: IOST public RPC `api.iost.io`
- News: CoinDesk / Cointelegraph / Decrypt RSS (no API key)

## Agent API (for Hermes / custom agents)

```bash
# scores for all assets
curl localhost:8787/api/scores

# analyze one symbol
curl localhost:8787/api/analyze/IOST

# risk calculation
curl -X POST localhost:8787/api/risk -H 'content-type: application/json' \
  -d '{"accountSize":10000,"maxRiskPct":1,"entryPrice":0.0006,"stopLoss":0.00057,"targetPrice":0.00065}'

# paper trade (agents can trade through the platform)
curl -X POST localhost:8787/api/paper/open -H 'content-type: application/json' \
  -H 'x-api-key: itk_…' \
  -d '{"symbol":"IOST","side":"long","size":100000,"entry":0.0006,"stop":0.00057,"reason":"breakout + volume","confidence":74,"walletId":"aw_…","pactId":"pact_…"}'

# close
curl -X POST localhost:8787/api/paper/close -H 'content-type: application/json' -d '{"positionId":"<id>"}'

# assistant
curl -X POST localhost:8787/api/assistant -H 'content-type: application/json' -d '{"question":"why is IOST moving today?"}'

# on-chain dashboard
curl localhost:8787/api/onchain
```

Real-time push: SSE at `/api/events` (scanner + scores every 20 s).

## Machine-First Agent Layer (core directive)

The platform is built agent-responsive: everything the UI shows is available to machines,
and the autopilot executes trades with zero human intervention.

**Agent discovery & navigation**

- `GET /.well-known/agent.json` — discovery manifest (what this service is + where the API lives)
- `GET /api` — full endpoint index with methods, params and purposes (machine-readable contracts)
- `GET /api/meta` — platform state: watchlist, account, engine health, data freshness
- `GET /api/ui-state` — single-call snapshot mirroring the dashboard (scanner, scores, account,
  autopilot, market, on-chain) — the "screen reader" for headless agents

**Auth & audit**

- Optional `X-API-Key` header; keys configured via `AGENT_KEYS` env (required — no default; API keys fail closed when unset)
- `GET /api/audit` — every API call logged (method, path, key, status)

**Autonomy (no human in the loop)**

- `POST /api/autopilot/start` (+ optional `{config}`), `POST /api/autopilot/stop`,
  `POST /api/autopilot/config`, `GET /api/autopilot` (status + action audit trail)
- The loop ticks every 60s: scan → score → risk-size → paper execute → journal.
  Entries require composite score ≥ `openMinScore` and risk subscore ≥ `openMaxRisk`; size is
  risk-engine-derived (`accountRiskPct` per trade); exits trigger on score decay / RSI exhaustion.
- Safety rails: `maxConcurrent` positions, `maxTradesPerDay`, daily-loss halt
  (`dailyLossHaltPct` → closes all + stops), min R:R gate. All actions audited in
  `actions` with reasons + AI confidence.
- Example (agent, one call): `curl -X POST localhost:8787/api/autopilot/start -H 'x-api-key: demo-agent-key' -d '{"config":{"openMinScore":55,"openMaxRisk":45}}'`

## AI command center shell — v1.6

The terminal is now a command center, fusing the Nexus (cyberpunk) + Kinetic
Monolith (AI glassmorphism) design languages:

- **Left icon sidebar** — Markets / Scores / Risk / Portfolio / Chain / News /
  Agent / Journal / Perf + Logs (audit) + Home; active pill glows cyan.
- **Top bar** — brand, ONLINE + latency status, paper balance, one-click
  autopilot toggle chip, Rescan.
- **Right intelligence rail** (live, 15s refresh):
  - **Market Overview gauge** — semi-circular probability gauge (red→amber→
    green arc + glow) for the top asset, "BULLISH 62%" label
  - **Agent Fusion** — recommendation (Strong Buy/Hold/Sell), confidence tag
    with CI, plain-language quote synthesized from signal drivers
  - **State Classification** — 24H high/low/volume/latency stat cells
  - **Portfolio donut** — cash + open positions allocation with legend + P/L
  - **BUY / SELL** — large gradient execution buttons (paper)
- **Glassmorphism everywhere** — panels blur, rounded 16px, neon cyan borders,
  glowing BUY/SELL; existing views (cards, tables, KPIs, modal) restyled to
  match. Machine layer, ARIA labels and deep links all intact.
- Responsive: rail hides < 1280px, sidebar < 900px.

## Performance analytics (FreqUI-style) — v1.5

- `GET /api/performance` — full analytics from the paper journal: net P&L,
  return %, current equity, win rate, **profit factor**, expectancy per trade,
  avg win/loss, max drawdown (abs + %), best/worst trade, **equity curve**
  (realized + mark-to-market, drawdown-shaded), per-symbol breakdown, recent
  closed trades.
- New **Performance** view in the terminal (`/app#performance`): KPI grid,
  equity curve canvas, per-symbol win-rate/P&L table, recent trades — the
  FreqUI monitoring pattern, agent-readable via the API.

## Probabilistic clarity + progressive disclosure — v1.4

2026-platform UX patterns on top of the machine layer:

- **Probabilistic clarity** — every asset gets an upside probability with a
  confidence interval, shrunk honestly toward 50% (`0.5 + (score-50)*0.008`),
  CI widening with subscore disagreement. Rolling probability timeline (30s
  samples, CI band, 50% midline) rendered next to the candlesticks.
  - `GET /api/probability` — per-asset `{probUp, ciLo, ciHi, direction, drivers}`
  - `GET /api/probability/:symbol/history` — timeline samples
- **Progressive disclosure** — the asset detail modal has 3 layers:
  - L1 Overview: binary event card, probability gauge, payout explanation,
    Buy/Sell buttons
  - L2 Analysis: probability timeline + candlesticks + paper trade history +
    position sizing tool
  - L3 Pro/Agent: real order book depth (OKX), contract specification
    (tick/lot/min size), raw API audit log + full `/api/analyze` payload
  - `GET /api/orderbook/:symbol`, `GET /api/contracts/:symbol`
- **Dual-format data** — prices in currency AND probability everywhere:
  scanner table `Prob ↑` column, modal (`$0.0723 ≈ 62.8%`), machine layer table.
- **Agent transparency** — each probability carries human-readable drivers
  (`Signal triggered by: Volume spike (z=3.9) + Golden MA cross`) shown on
  cards and in the modal, and the full reasoning is exposed pre-execution via
  the autopilot proposal queue (see ARD section).

## Agent-Responsive Design (ARD) — v1.3

The site adapts to autonomous workflows, not just viewports:

- **Deterministic paths** — every feature has a stable URL: `/app#scanner`,
  `/app#risk`, … (hash routing, deep-linkable). The landing engines are real
  links; the 3D hub's bot intel is available on hover AND click-pin (ESC
  unpins) plus the always-present machine layer — no info locked behind hover.
- **Transparent reasoning** — every AI score carries a human-readable rationale
  (`strong volume + golden MA stack`); the autopilot exposes its config, audit
  trail and, in `requireApproval` mode, a **proposal queue**: entries are
  computed with full reasoning (symbol, side, size, entry, stop, target,
  confidence, why) and wait for a human/agent override before executing:
  - `GET /api/autopilot/proposals` — pending queue
  - `POST /api/autopilot/proposals/:id/approve` — execute now
  - `POST /api/autopilot/proposals/:id/reject` — block this entry
  - Enable via `POST /api/autopilot/config {"requireApproval":true}`
- **No barriers** — `robots.txt` explicitly allows verified AI crawlers
  (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, …), no CAPTCHAs or
  interstitials anywhere; security-sensitive actions use `X-API-Key`, not
  challenge walls. `llms.txt` + `<link rel="llms">` give LLMs a plain-text
  index of the platform.

## Dual-layer architecture (SSR + machine layer) — v1.2

Every page ships BOTH layers in the initial HTML response (no client JS required):

1. **Human layer** — the immersive visuals, now pre-filled with live market data at
   first paint (rail, signal tape, engine stats, visor).
2. **Machine layer** — for agents / screen readers:
   - **SSR data**: prices, scores, on-chain state and execution CTAs are
     server-rendered into the HTML (30s cached snapshot, refreshed in-band).
   - **Semantic HTML + ARIA**: `<nav>/<main>/<section>/<table>/<dl>`, descriptive
     `aria-label` on every interactive control, `aria-live` on live values,
     `role="status|marquee|tooltip|timer"` where it matters.
   - **JSON-LD knowledge graph** (`<head>`): WebSite, Organization,
     SoftwareApplication + one FinancialProduct (Stock for equities) per asset,
     each with an Offer carrying explicit `priceCurrency` and ISO 8601 dates.
   - **Machine-readable state blob**: `<script type="application/json"
     id="agent-state">` holds the full platform snapshot; kept fresh by client JS.

An agent fetching `GET /` with zero JavaScript still sees live quotes, the
top-score table, account state and three ARIA-labelled CTAs.

## Honest limitations (v1)

- **Paper execution** — simulated fills at live prices. Real-money orders need
  exchange API keys (OKX/KuCoin/Gate) + explicit user enablement.
- Stocks data is delayed (Yahoo) and rate-limited from some hosts.
- On-chain "exchange inflows/outflows, staking activity, token unlocks" need a
  data vendor (Nansen-class) — v1 shows live chain metrics + whale alerts with
  clear labels.
- IOST L2: IOST 3.0 L2 is real (docs.iost.io). v1 wires the live L1 RPC for
  data; L2 settlement/smart-contract integration is a later phase.
- Assistant is a rule-based synthesis engine (no LLM key). Upgrade path: same
  context bundle → LLM call.
- Sentiment is lexicon-based over RSS headlines (honest heuristic, not an LLM).

## Live trading (v2 — real-money, Kraken)

**Architecture:** execution goes through a venue-agnostic broker layer —
`lib/broker/` (`index.js` registry, `paper.js` adapter, `kraken.js` adapter).
Settlement/journal stays engine-side (`lib/paper.js`). Paper remains the
default for every account; live mode is **owner-only** (email allowlist) and
opt-in per account.

**Enable flow (owner):**
1. Kraken API key with **Query + Trade only, no withdraw**, IP-locked to the
   VPS (`2.25.93.157`). Keys in `.env` (`KRAKEN_API_KEY` / `KRAKEN_API_SECRET`).
2. `.env`: `LIVE_EMAIL_ALLOWLIST=owner@example.com` (fail-closed when
   empty — nobody can enable live).
3. Sign in on the site → Portfolio → **Live Trading** card → **Enable live
   (Kraken)**. A red **● LIVE** chip appears in the topbar.
4. Orders: `POST /api/trade/live` `{ symbol, side, size, entry? }` (owner
   session only; agent keys get 403).

**Hard rails** (`lib/rails.js`, enforced before ANY venue call, env-tunable):

| Rail | Env | Default |
|---|---|---|
| Max order notional | `LIVE_MAX_ORDER_USD` | 50 |
| Max concurrent live positions | `LIVE_MAX_POSITIONS` | 3 |
| Daily-loss halt | `LIVE_MAX_DAILY_LOSS` | 25 |
| Min cash buffer | `LIVE_MIN_CASH_USD` | 10 |

Pilot profile (2026-08-10): 25 / 2 / 10 / 5.

**Kill switch:** `POST /api/account/live/disable` — cancels every open venue
order and disables live mode. Autopilot is forced into human-approval mode
while any account has live enabled (`liveGate` in `/api/autopilot`).

**Audit & reconciliation:** every live event appends to `data/live-audit.jsonl`
(enable/disable/order with venueOrderId). `scripts/reconcile-live.py` diffs
venue state vs audit (cron every 5 min, silent when clean);
`scripts/watch-audit.py` streams new events to chat (cron every 15 min).

**Verify:** `python3 /opt/data/scripts/kraken-check.py` (read-only balance
call), `node tests/broker-smoke.mjs`, `node tests/kraken-check.mjs`,
`node tests/live-check.mjs`, `node tests/rails-check.mjs`.

## License

**All rights reserved.** This public repository has no open-source license. No permission to copy, modify, distribute, sublicense, or sell is granted. Not financial advice.
