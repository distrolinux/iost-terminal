# IOST Terminal — Product Brief

**One-liner:** A real-time AI trading command center for crypto & stocks — built for humans, usable by AI agents, live at **iostcallister.com**.

---

## Vision
The first trading platform designed **agent-first**: any AI agent can read the market, understand every signal's reasoning, and even act — with human approval always in control. AI agents aren't a gimmick layer; they're first-class users of the product.

## The Problem
- Traders drown in raw data and noise; AI scores exist but are opaque black boxes ("trust me").
- Trading platforms are built for eyeballs, not for AI agents — which increasingly drive how people discover and use financial tools.
- No one offers honest, probabilistic AI signals with visible reasoning, for free, on-chain verifiable.

## The Product
**IOST Terminal** — a dark-neon command deck (Unite.AI aesthetic) with 13 live views:

| View | What it does |
|---|---|
| Markets | AI market scanner — unusual volume, breakouts, RSI/MACD, S/R, MA crosses, whale activity |
| Scores | 0–100 AI score per asset → honest upside **probability** (e.g. "61% ↑, CI 53–70%") with the *why* |
| Risk | Position sizing engine (dollar risk, R:R, stop/target prefilled) |
| Portfolio | Portfolio-wide AI analysis + allocation |
| Chain | IOST on-chain dashboard |
| News | Market news + bullish/bearish/neutral sentiment engine |
| Agent | AI Trade Assistant chat — "why is IOST moving today?" |
| Journal / Perf | Trading journal + performance analytics |
| Whales | Large-trade (whale) activity log |
| Agents | Decentralized AI agents marketplace — every signal SHA-256 **hash-pinned on IOST mainnet** |
| Points | Referral & points system (1:1 AIT conversion planned at TGE) |
| Wallet | **Free real IOST mainnet wallet** per account — browser-side keygen, we never hold keys, we pay the fee |

## What Makes It Different
1. **Transparent AI** — every score shows its drivers, confidence interval, and audit trail. No black boxes.
2. **Agent-first architecture (ARD)** — server-rendered data, semantic HTML, JSON-LD knowledge graph, machine-readable state, `llms.txt` — an AI agent can fetch the page with zero JavaScript and still get data + actions. AI crawlers explicitly welcomed.
3. **Human-in-the-loop autonomy** — the autopilot computes entries with full reasoning but queues them for **human approval** before execution (or approves via agent key).
4. **On-chain proof** — signals pinned on IOST mainnet; every account gets a real IOST wallet; the ring (biometric DID) is the future identity layer.
5. **Free to start** — $100K paper account, no fees, no credit card, browse without signup.

## Business Model (current & planned)
- **Now:** Free platform — growth via referrals + points (retention), live trading for the owner on Kraken (pilot).
- **Planned:** 1:1 AIT token conversion at TGE (points → token), premium tiers, agent API access, copy-trading marketplace.
- **Live trading:** Kraken-backed, owner-only, IP-locked, withdrawals disabled, hard rails ($25 max order / 2 positions / $10 daily loss cap) + kill switch.

## Security
CSP + hardened headers · session auth + 2FA + backup codes · agent auth via API keys · fail-closed allowlists · non-custodial wallets (we never see private keys) · full audit log API · every trade journaled.

## Tech Stack
Node.js/Express 5 · vanilla JS SPA · Docker + Traefik + Let's Encrypt on Hostinger VPS · JSON persistence · IOST mainnet RPC · OKX/KuCoin/Gate + Yahoo market data · Kraken live execution.

## Status
**Live** at iostcallister.com · paper trading fully operational · live Kraken pilot active · free IOST wallets built (awaiting funded account key) · roadmap: leaderboard, alerts, AIT token, agent API public tier.

---
*IOST Terminal — AI Command Center. Proven on IOST. Free to trade. Built for humans, designed for agents.*
