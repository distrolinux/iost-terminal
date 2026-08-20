---
name: iost-terminal-market-data
description: How an agent reads IOST Terminal market data — endpoints, the agent-state JSON blob, JSON-LD, markdown negotiation and the LLM index.
---

# Reading IOST Terminal market data

IOST Terminal (https://iostcallister.com) is an AI real-time trading platform for
crypto + equities. All read endpoints are **public — no auth required**. The
site is agent-first: every page server-renders its data, so a raw HTML fetch
with zero JavaScript still contains the full snapshot.

## Fastest paths

1. **`GET /api/ui-state`** — one-call full snapshot mirroring the dashboard:
   `{ ts, scores[], scan[], market{}, onchain{}, paper{}, autopilot{} }`.
   Prefer this over scraping HTML.
2. **`GET /api/scores`** — 0-100 AI trade scores for all assets
   (`composite` + `subscores.momentum/volume/news/risk` + `grade`).
3. **`GET /api/analyze/:symbol`** — full analysis for one symbol (IOST, BTC,
   ETH, SOL, XRP, DOGE, ADA, AVAX, LINK, DOT, SUI, ARB, OP, TON, NEAR, LTC,
   AAPL, MSFT, NVDA, TSLA, AMZN, GOOGL, META, SPY, QQQ).
4. **`GET /api/probability`** — honest upside probabilities with confidence
   intervals and signal drivers (`probUp`, `ciLo`, `ciHi`, `direction`,
   `drivers[]`). Converted to percentages, they shrink toward 50% — the
   platform does not overstate certainty.
5. **`GET /api/news`** — headlines + per-asset bullish/bearish/neutral counts.
6. **`GET /api/onchain`** — IOST mainnet: TPS, head block, peers, large transfers.
7. **`GET /api/scanner`** — full live analysis: signals, indicators, whale tape.

## Semantic page layer

Every HTML page ships:
- `<script type="application/json" id="agent-state">` — machine state blob
  (JSON, `</script>`-escaped).
- JSON-LD knowledge graph in `<head>` — Schema.org `FinancialProduct`/`Stock`
  nodes with `offers.priceCurrency` and ISO 8601 dates.
- A visually-hidden (sr-only) machine layer `<section data-agent-layer>` with a
  structured table, definition list and ARIA-labelled CTAs — present in the
  accessibility tree.

## Markdown negotiation

Request any page with `Accept: text/markdown` and the server returns a markdown
rendering (`Content-Type: text/markdown`) built from the same live snapshot.
Example:

```bash
curl -H 'Accept: text/markdown' https://iostcallister.com/
```

## Discovery files

- `/.well-known/agent.json` — manifest (endpoints, OAuth, MCP, skills).
- `/llms.txt` — human/LLM index of pages + machine interfaces.
- `/openapi.json` — OpenAPI 3.0.3 description of the API.
- `/.well-known/ai-catalog.json` — ARD capability manifest.
- `/.well-known/agent-skills/index.json` — this skills index.

## Caveats

- Crypto data is near-real-time (OKX/KuCoin/Gate); equities are delayed (Yahoo).
- AI scores are signals, not advice. The platform ships honest probability
  bands and "past ≠ future" caveats on backtests.
- Public endpoints are rate-limited (60 req/min default).
