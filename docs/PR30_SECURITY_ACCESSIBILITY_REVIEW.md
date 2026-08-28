# PR #30 Security, Privacy and Accessibility Review

## Scope

This review covers the authentication, authorization, session, storage, audit,
evaluation-history, export and browser UI paths present after PR #29. It is a
targeted engineering review against common OWASP risks and WCAG 2.2 AA
requirements; it is not a third-party certification or penetration test.

Real-money trading, token conversion and public-chain writes remain disabled by
their existing fail-closed release gates. No change in this PR grants execution
authority or promotes an evaluation beyond human paper review.

## Changes

- Password-reset validation now accepts the token only in a rate-limited POST
  body, keeping bearer-like reset credentials out of URLs, history and routine
  access logs.
- New passwords are limited to 72 UTF-8 bytes, matching bcrypt's effective input
  boundary, including multibyte password cases.
- Authenticated, authentication and known-private API responses explicitly use
  private no-store caching and vary on every supported credential boundary.
- Security headers add cross-origin opener/resource isolation and disable legacy
  cross-domain policy files and unused browser capabilities.
- Session secrets, audit logs and mutable account stores consistently honor
  `IOST_DATA_DIR`. Exercised stores are atomically persisted with owner-only
  `0600` permissions, with boot-time repair and verification as defense in depth.
- Scanner rows work with Enter and Space. Shared detail dialogs receive a
  contextual accessible name, trap focus, close with Escape and restore focus to
  their opener. Asset-detail tabs expose tab/tabpanel relationships and arrow-key
  navigation.
- Evaluation canvases expose image semantics plus a textual result summary. The
  low-emphasis text color now meets WCAG AA contrast on terminal cards.

## Verification

- Regression contracts cover reset-token transport, cache policy, response
  headers, password byte limits, isolated storage, file permissions, modal focus,
  table keyboard activation, tabs, chart alternatives and color contrast.
- Runtime tests exercise ASCII and multibyte bcrypt boundaries and ten mutable
  stores in a scratch `IOST_DATA_DIR` without touching production data.
- Existing authorization/privacy tests continue to cover per-user evaluation
  history, cross-user denial, deterministic JSON/CSV export, evidence hashes,
  retention limits and comparison performance.
- Existing origin, session-regeneration, TOTP, agent-scope, paper rails,
  evaluation causality, calibration and fail-closed promotion-gate tests remain
  mandatory in the full suite.
- Secret scanning and dependency audit results are recorded in the PR checks.

## Residual risk and follow-up

- The legacy landing and terminal documents still require CSP `unsafe-inline`
  for existing inline scripts and styles. Dynamic evaluation is not permitted.
  Migrating inline assets to nonce- or hash-based CSP should be a dedicated,
  browser-regression-heavy follow-up.
- The JSON file stores are appropriate for the current single-writer deployment.
  A future multi-writer topology must move locking, isolation and retention to a
  transactional store before scaling horizontally.
- Linux-only deployment integration tests require `flock`; on hosts without it,
  source contracts and all platform-independent suites run, while Linux CI must
  execute the lock/rollback integrations.
