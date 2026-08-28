# PR #32 — MCP Apps Evaluation Review

Status: implementation plan. Base revision:
`cde4ae2b45565a42d2513a27473252eab710dde6` (merged and deployed PR #31).

## Product outcome

An authenticated AI client can open a compact, interactive Evaluation Review app
inside a supporting MCP host. The app makes existing causal paper-evaluation evidence
easier to inspect without creating a second evaluation engine or weakening any gate.

The first release must provide:

- private retained-run selection and exactly-two-run comparison;
- equity, drawdown, causal baseline and confidence-calibration charts;
- accessible metric summaries and chart-equivalent data tables;
- visible result/evidence hashes and fail-closed paper-review reasons;
- deterministic JSON and CSV evidence export actions;
- long-run task progress and owner cancellation; and
- read-only agent authorization status beside any paper-order preview.

The app does not place a paper order in v1. Agents continue to use the PR #31
`paper_trade_open` tool directly, where the server rechecks the scoped credential,
owned wallet, active Pact and spend limits. This keeps review UI separate from execution
and prevents a visual control from becoming an authority boundary.

## MCP surface

### Static application resource

- URI: `ui://iost-terminal/evaluation-review-v1.html`
- MIME type: `text/html;profile=mcp-app`
- served by modern `resources/list` and `resources/read`
- one self-contained, versioned HTML payload; no remote scripts, styles, fonts, images,
  analytics or network origins
- resource content is public/static; it never contains user data, credentials or task
  handles

### App-launch tool

Add authenticated read tool `evaluation_review` with optional `runIds` containing zero,
one or two retained run IDs. Its descriptor points to the UI resource through the MCP
Apps tool metadata. The tool returns only owner-authorized `structuredContent`:

- retention policy and history summaries;
- selected full run evidence or same-owner comparison;
- authorization/safety state; and
- server revision plus schema/app version.

The UI receives data from the tool result. Follow-up reads, comparisons, exports and task
operations go through server tools exposed by the host; the iframe never receives or
stores an API key or bearer token.

### Supporting tools

- add `evaluation_get {runId}` for one private retained run;
- add `evaluation_compare {runIds:[idA,idB]}` for exactly two same-owner runs;
- add `evaluation_export {runId,format:json|csv}` using the existing deterministic
  exporters and bounded payload sizes;
- reuse `evaluation_history`, `evaluation_run`, `tasks/get` and `tasks/cancel`;
- reuse `agent_authorization_status` for a non-executing paper readiness panel.

Every tool remains independently authorized on the server. Tool visibility is not an
authorization control.

## Application architecture

1. `lib/mcp-apps.js` owns the immutable UI resource descriptor, HTML loader and
   content hash. It contains no account or trading logic.
2. `server.js` adds modern resource methods and dispatches the new evaluation tools to
   the existing history/evidence functions.
3. `mcp-apps/evaluation-review.html` is the source document. A small build step bundles
   the official MCP Apps client bridge and local rendering code into one production
   artifact committed under `public/mcp-apps/`.
4. `mcp-apps/evaluation-review.js` renders from typed structured data, requests only
   declared server tools and clears prior run data before switching selection.
5. Existing `lib/evaluation.js` and `lib/evaluation-history.js` stay authoritative for
   causality, calibration, retention, comparison, evidence verification and exports.

No duplicate calculations are performed in the app. Chart normalization is display-only;
all reported metrics and gate decisions come from verified server evidence.

## Safety and privacy contract

- Paper-only language is persistent in the header and order-readiness panel.
- No live-order, real-money, token, conversion, swap, wallet-send or public-chain tool is
  added or referenced.
- The app cannot broaden scopes, create credentials, create/approve Pacts, or bypass the
  paper-review gate.
- Static resources may be cached publicly; authenticated tool results and exports are
  private and `no-store`.
- Run and task ownership is checked before existence is revealed, preventing enumeration.
- Untrusted strategy names, warnings and reasons render as text, never HTML.
- Resource and result payloads have explicit byte, list and nesting limits.
- The resource declares a deny-by-default content security policy with no external
  origins. Host capability requests are minimal and documented.
- Closing or reinitializing the app clears private in-memory data. No browser storage,
  cookies, telemetry or cross-window credential messaging is used.
- App metadata is versioned and truthfully advertised only after `resources/read` and the
  production bundle are available.

## Interaction and accessibility

- Initial state: retained-run table with clear HOLD/REVIEW status and evidence hash.
- One selected run: KPI strip, methodology/cost disclosure, four chart panels, warnings,
  gate reasons and export controls.
- Two selected runs: normalized equity comparison plus exact metric deltas; original
  hashes stay visible.
- Running task: determinate/indeterminate status, last-updated time, safe polling and a
  cancel control. The interface stops polling on terminal states or when hidden.
- Charts use semantic names and descriptions and have an adjacent table containing the
  same values. Color is never the only signal.
- Full keyboard operation, visible focus, logical heading order, reduced-motion support,
  zoom/reflow at 200%, AA contrast and descriptive error recovery are required.
- Unsupported MCP Apps hosts still receive complete text plus structured tool results.

## Test plan

### Protocol and compatibility

- deterministic `resources/list`, exact `resources/read` URI and MIME type;
- tool metadata references only the registered UI resource;
- modern header/name validation for resource and supporting tool requests;
- PR #31 legacy MCP clients continue to list and call their existing tools;
- non-App hosts receive useful text and structured content.

### Authorization, privacy and security

- anonymous, platform-key, browser-session, read-key and trade-paper-key matrices;
- cross-user run, comparison, export and task access return indistinguishable denial;
- wrong-audience bearer tokens remain HTTP 401 and are not revoked for their intended
  resource;
- injected names/warnings cannot create markup or executable script;
- resource CSP, no external origins, byte limits and cache headers are asserted;
- tool catalogs contain no live, token, conversion, send, swap or chain-mutation action.

### Evidence and regression

- app data preserves the stored result hash exactly;
- JSON/CSV bytes match the current deterministic exporters;
- chart tables match equity, drawdown, baseline and calibration source series;
- comparison remains exactly two same-owner runs;
- walk-forward causality, next-bar execution, confidence calibration and fail-closed
  promotion tests remain unchanged and passing;
- MCP task completion/cancellation cannot overwrite a terminal state.

### Accessibility and performance

- automated semantic/focus/reduced-motion contracts plus keyboard interaction tests;
- accessible table fallback for every chart;
- compressed app bundle budget: 60 KiB maximum;
- first render from supplied structured data: 100 ms budget on the local test fixture;
- no request loop while hidden and no more than one in-flight task poll.

## Delivery sequence

1. Add failing protocol/resource/tool authorization tests.
2. Implement static resource serving and truthful Apps metadata.
3. Add owner-bound read/compare/export tool adapters.
4. Build the self-contained accessible review UI.
5. Add task progress/cancellation and paper-readiness panel.
6. Run focused integration, full regression, dependency audit and production preflight.
7. Publish PR #32 for explicit review. Do not merge or deploy it without a new approval.

## Out of scope

- order placement from inside the iframe;
- live brokerage or exchange connections;
- token issuance, conversion or purchase;
- public-chain writes;
- portfolio rebalancing or autonomous strategy promotion;
- modifying Hermes; and
- advertising a general MCP Skills extension before it is fully implemented and tested.
