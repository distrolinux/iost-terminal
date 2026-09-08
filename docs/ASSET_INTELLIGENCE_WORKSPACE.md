# Asset Intelligence Workspace

The Asset Intelligence Workspace is IOST Terminal's read-only Asset 360 surface for people and AI agents. It consolidates current market evidence without collapsing research, authorization and execution into one unsafe action.

## What it contains

- server-observed price, range, change, source and freshness;
- the six existing deterministic score dimensions and their weights;
- a bounded directional estimate with an uncertainty interval;
- technical signals, volatility and large-trade context;
- asset-specific trusted news and sentiment;
- provenance coverage and external-content quarantine counts;
- visible paper-portfolio context; and
- explicit links into separate research, risk, audit and decision-trace workflows.

The browser view is `/app#intelligence`. Agents receive the same normalized public evidence through `asset_intelligence { "symbol": "IOST" }` or `GET /api/asset-intelligence/IOST`.

## Trust boundary

The workspace has no execution authority. It cannot preflight, approve, reserve funds, create a receipt, open or close a position, change permissions, use a live scope or submit a public-chain action. Its output is descriptive evidence, not financial advice or a buy/sell recommendation.

External headlines are data only. The Data Trust Firewall quarantines suspicious instruction-like content and excludes it from the asset view. Missing evidence is reported as missing rather than inferred.

Any later execution remains a separate workflow requiring fresh server evidence, Agent Execution Readiness, scoped credentials, an active wallet-bound Pact, mission policy, risk controls and any applicable owner approval.
