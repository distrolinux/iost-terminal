# Agentic Payments Readiness — IOST L2 & AITT

> **Status: POSITIONING DRAFT** — for the AITT whitepaper and `/aitt` page. Chain numbers **verified by direct live pulls** (2026-08-20) from l2-scan.iost.io (Blockscout), IOSTscan (gw.iostscan.com), and api.iost.io. Competitor figures are as reported in their own published comparison (Chainspect / Token Terminal, data as of 2026-08-20).
> Positioning line: *agent networks run, agent payments settle.* AITT is the agentic payments + trust layer; IOST is the rail.

---

## 1. Chain readiness — the rows every network charts

| Metric | **IOST L2 (AITT)** | Algorand | Base | Polygon | Solana |
|---|---|---|---|---|---|
| Architecture | L2 rollup, EVM-compatible (chain 182) | L1 | L2 | Sidechain | L1 |
| Block time / finality | **1.0 s blocks** *(verified)*; L1 anchors finality | Instant | 13 min | 5 s | 12.8 s |
| Avg. tx fee | **$0.000** — gas price 0.0 *(verified, 40-tx sample)* | $0.0002 (fixed) | $0.015 (gas) | $0.01 (gas) | $0.003 (gas) |
| Throughput | **345,594 tx / day live** *(verified, 2026-08-20)*; 8,000+ TPS claimed (L1, official benchmark — pending live benchmark on L2) | 10,000 max TPS (claimed) | 3,600 | 3,800 | 65,000 |
| Consensus / participants | PoB, 17 elected producers *(smaller set — by design; decentralization trade-off stated)* | 1,541 validators | 1 sequencer | 105 validators | 690 validators |
| Uptime | **Continuous production — 471,005,961 L1 blocks since Feb 2019, no mainnet halt** *(verified; 1.04B all-time L1 transactions)* | 100% (claimed) | Past downtime | Past downtime | Past downtime |
| x402 all-time volume | $0 — Phase 3 integration planned; EVM L2 = drop-in `@x402/evm` | $250K (95% in last 2 wks) | $45M | $850K | $9.3M |
| PQC readiness | None yet — Phase 3 post-quantum program (same "readiness" nature as the Falcon claim) | Falcon-1024 | No | No | No |

*Verified IOST numbers, 2026-08-20: L2 total tx 140,847,437 · tx today 345,594 · avg block time 1.0 s · gas price slow/avg/fast = 0.0 · 90,477 addresses · network utilization 0.05%. L1: 1,038,627,857 all-time tx · 471,005,961 blocks · RPC healthy (30 peers, empty tx pool).*

## 2. Agentic trust readiness — the rows they don't chart

Chain speed is table stakes. An agent paying with your money needs **authorization, limits, and accountability** — this is the layer Algorand's deck never measures, and where IOST Terminal + AITT already ships.

| Capability | **IOST Terminal + AITT** | Algorand et al. |
|---|---|---|
| Mandates (chain of intent) | **AP2-compatible mandate model** — consent / intent / payment tokens, Open & Closed, hash-linked, on-chain (TOKENOMICS §4.8) | Not charted; no public product equivalent |
| Human control | **Per-trade approval on live agent trades** — Human Present mode live today; Human Not Present (autopilot within budget) designed | Not charted |
| Trust & slashing | **Trust staking** — stake → Trust Score → spend limits → slashing for misbehavior (KYA with economic teeth, §4.1) | Not charted |
| Agent identity | **Scoped agent API keys** (read / trade-paper / trade-live) with per-agent spend rails | Not charted |
| Provable track records | **Signals hash-pinned on IOST L1** — machine-verifiable audit trail for every agent action | Not charted |
| Working product | **iostcallister.com live** — AI trading command center, 60s autopilot loop, paper + live lanes, 73/100 agent-native scan | None |

## 3. Honest gaps (stated, not hidden)

- **Consensus set:** 17 elected producers vs Algorand's 1,541 validators — smaller set by PoB design; decentralization posture must be argued, not hidden.
- **PQC:** none today; Falcon-1024 is a readiness claim, ours is a roadmap item — comparable honesty, later timing.
- **Peak TPS:** the 8,000+ figure is an official L1 benchmark, not a live L2 measurement — publish only after a real L2 benchmark.
- **x402 volume: $0** — the gap *and* the land-grab: first x402 on a non-EVM/Solana chain, with a live product to generate real agent traffic.

## 4. The claim

IOST L2 is **free** (gas price 0.0) and **provably up** (471M continuous blocks). AITT adds what no chart in the category measures: **mandates, trust staking, slashing, and human control at the money boundary** — the difference between a fast chain and a chain you can trust with an agent's wallet.

---
*Data as of: August 20, 2026. Sources: l2-scan.iost.io (Blockscout v2 API) · IOSTscan (gw.iostscan.com) · api.iost.io — direct verified pulls, script at `/opt/data/scripts/verify_l1_l2_stats.py`. Competitor data as reported by Chainspect & Token Terminal (Algorand comparison deck, 2026-08-20). · AITT: positioning draft.*
