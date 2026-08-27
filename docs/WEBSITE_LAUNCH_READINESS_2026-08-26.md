# Website launch-readiness audit — 2026-08-26

## Continuation audit — production revision 493473f

- Source and reported production baseline:
  `493473f3d796374341693016053432ee2b84d8d1`.
- The in-app browser could not reach either the public site or the isolated local
  copy because its admin security policy could not be verified. No browser
  security control was bypassed, so the desktop/mobile visual pass and live
  browser-console capture remain pending.
- Static navigation, account, onboarding, form, link, accessibility, SEO,
  legal-page, security-header, API-contract, and paper-only safety checks were
  repeated against the exact baseline. The production dependency audit reported
  zero vulnerabilities and the local-only contract suite passed 124 tests.
- The complete application suite reaches only the Linux deployment integration
  checks on macOS; those checks require `flock` and remain delegated to the
  protected Ubuntu CI job.

### Findings addressed

| Finding | Risk | Improvement |
|---|---|---|
| Sign-up exposed its password field as `current-password` | Password managers could offer or overwrite the wrong credential | Sign-in now explicitly uses `current-password`; sign-up explicitly uses `new-password` |
| The reset-password overlay was outside the dialog focus trap and opener restoration path | Keyboard focus could escape behind the modal or fail to return | Included the reset overlay in focus containment, focused the new-password field, and restored the prior focus on close |
| Landing-page data loops kept polling in hidden tabs | Unnecessary client work and API load | Paused recurring landing, visor, and leaderboard requests while hidden; refresh resumes when visible without overlapping requests |
| Terminal navigation disappeared below 860px | Most product views were unreachable on mobile | Reflowed the full primary navigation into a sticky, horizontally scrollable mobile command bar |
| Autonomous actions lacked a dedicated inspection surface | Agent behavior and safety decisions were harder to review | Added a signed-in, read-only Decision Trace covering inputs, scoring, risk gates, approvals, paper execution, proposals, and recent reasoning |

### Legal review completed for the paper-only website scope

- Canadian counsel approved the public website legal posture on 2026-08-26.
  Counsel identity and address are retained privately rather than published in
  this repository. Counsel directed that no exclusive jurisdiction be selected
  for the independently developed open-source project.
- Terms, Privacy, and Risk Disclosure now have an effective date, the existing
  public project contact, no unresolved placeholders, and an explicit paper-only
  launch boundary. They are indexable and included in the sitemap.
- This approval is limited to the paper-only website. It is not approval for
  real-money trading, token deployment, conversion, staking, liquidity, or any
  public-chain action, and it does not change any AITT release gate.
- Real-money execution, exchange-key connection, signal pin broadcasts, and
  IOST account-creation broadcasts now fail closed unless their separate,
  explicit server-side launch flags are enabled. Those flags remain off.
- Real-money trading, token deployment, conversion, staking, liquidity, and
  public-chain release actions remain disabled and separately gated.

## Scope and safety boundary

- Source baseline: GitHub `main` at `d43d17cb5d1bf2d3c7ee3a5d5f402a6d20c7828a`.
- Production baseline reported by the owner: `365ccebac7bf6a50f91e32279f575be578eab106`.
- This audit used read-only production requests and local scratch data only.
- No deployment, restart, live order, token deployment, conversion, staking,
  liquidity, or public-chain action was performed.

## Verified baseline

- GitHub's three protected checks passed on the source baseline:
  Application safety suite, Local-only contract suite, and High-confidence
  secret scan.
- The full offline application safety suite passed locally.
- `node --check server.js` and all checked `lib/` and `public/js/` modules passed.
- `npm audit --omit=dev --audit-level=high` reported zero vulnerabilities.
- Read-only requests to `/`, `/api/health`, `/robots.txt`, and `/token` returned
  HTTP 200 before these changes; security headers included CSP, HSTS,
  `X-Content-Type-Options`, and frame denial.

## Findings addressed in this change

| Finding | Risk | Improvement |
|---|---|---|
| "AI Real-Trading" branding could be read as real-money availability | User expectation / launch honesty | Changed public and agent-facing titles to "AI Trading Platform — Paper-First" |
| Monitored asset prices were marked up as products offered by IOST Terminal and "InStock" | Search-engine accuracy | Replaced sale offers with explicitly observed USD market-price properties |
| `/aitt` and `/token` were both indexed even though they served the same page | Duplicate discovery | Made `/aitt` canonical, redirected `/token` permanently, and removed the alias from the sitemap |
| The public Arena page was absent from the sitemap | Discoverability | Added `/arena` to the sitemap |
| Landing and AITT pages lacked a keyboard bypass link | Accessibility | Added visible-on-focus skip links and explicit main landmarks |
| These properties had no dedicated regression coverage | Regression risk | Added `tests/website-launch-readiness-check.mjs` to `npm test` |

## Follow-up browser safeguards

- Extended visible-on-focus skip links and explicit main landmarks to the
  Terminal, Agent Trust Arena, and 3D Automation Hub.
- Paused the landing-page WebGL shader and Hub animation loop when their tabs
  are hidden, then resumed them safely when visible.
- Suppressed the Hub's clock and market-data refresh polling while hidden.
- Added these behaviors to the launch-readiness regression contract and bumped
  the Terminal stylesheet cache version.

## Remaining pre-launch checks

- Complete an owner-reviewed browser pass on current desktop and mobile targets,
  including sign-up, sign-in, first-run paper guide, legal links, and locked AITT
  controls.
- Obtain final owner/legal approval for public terms, privacy, risk, and token copy.
- Keep all real-money and AITT launch gates closed until their separate approval
  requirements are satisfied.

## Repeatable web performance profile — 2026-08-27

- `performance-budgets.json` records deterministic raw-source and gzip-level-9
  byte ceilings for the landing page, its lazy operator image, the 3D Hub,
  Three.js, OrbitControls, the Hub texture, and shared WebMCP client.
- `tests/web-performance-budget-check.mjs` fails CI if an individual asset or the
  Hub's complete initial payload exceeds its reviewed ceiling.
- Express response compression now covers ordinary HTML, CSS, JavaScript, JSON,
  and text responses while explicitly bypassing `/api/events` so SSE delivery is
  never buffered. Static assets receive a one-hour browser cache lifetime;
  server-rendered product pages remain `no-store`.
- The existing readiness contract continues to disable the landing WebGL loop on
  mobile and pause both landing and Hub animation/background refresh work while
  hidden.
