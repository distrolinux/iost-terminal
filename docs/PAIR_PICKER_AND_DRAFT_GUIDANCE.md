# Market selection and draft guidance

The order workspace now has three visible steps: choose a market, enter amounts, review blockers. The optional **Load Kraken USD markets** action loads a private/no-store, owner-session-only projection of the public AssetPairs catalog. Agent keys are rejected. Only online currency pairs with usable rule metadata and unambiguous symbols are listed. BTC maps explicitly to Kraken XBT; non-USD, offline, dark/invalid and ambiguous entries are excluded. This is a list supported by this draft checker, not every Kraken product or account entitlement.

The catalog uses a fixed public HTTPS endpoint, no credentials, a bounded 4 MiB body, 10,000-entry limit, eight-second timeout, single-flight fetching and a 60-second memory cache. Expired cache is never served on failure. Search happens locally. A stale/failed list disables selection; manual entry remains possible but is explicitly unverified. Selection changes only the symbol and invalidates the current review; quantity, price, limits and permissions are never adjusted automatically.

The review summary separates known draft violations (including configured-cap breaches) from unknown checks. A public market pass cannot hide a notional-cap violation or become a trading authorization. No new MCP tools, trading APIs, persisted plans, credentials or approval capabilities are added.

## Capitalise.ai product research

Reviewed the official [homepage](https://capitalise.ai/), [features](https://capitalise.ai/explore-trading-features/) and [technology overview](https://capitalise.ai/technology/).

- Useful now: approachable, plain-language descriptions and an explicit progression from describing a plan to testing it. Applied here through guided market selection and actionable draft warnings, not by copying their interface or claims.
- Useful later: structured paper-only strategy templates, simulation results and condition-based alert previews. Their published product includes natural-language automation, backtesting/simulation and notifications. Our future language layer should generate an inspectable draft, never grant execution authority.
- Deliberately excluded: direct prompt-to-live-order execution, unauthenticated webhook execution, claims that exits always happen at the planned price, or treating example strategies/backtests as profit guarantees.

IOST Terminal/AITT branding, paper/live separation, owner approval, bounded agent permissions and auditable execution remain the priority. This release is a usability improvement; it does not enable live trading or integrate Capitalise.ai.
