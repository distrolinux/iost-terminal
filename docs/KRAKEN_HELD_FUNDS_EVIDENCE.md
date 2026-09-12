# Optional Kraken USD held-funds evidence

The existing owner-only verification flow has an unchecked optional held-funds checkbox. Selection adds a fixed `BalanceEx` call after `GetApiKeyInfo` and `Balance`. Unsupported permissions prevent balance calls. Onboarding does not request the option. No platform-key fallback, order API, new MCP tool or live flag is added.

Only positive/zero/negative/unavailable status is returned, never balances or account identifiers. Existing shared 10-second deadline, bounded response, no redirects, rate limit, owner single-flight and credential-change discard remain in effect. Extended-call failure produces unavailable evidence even when basic connectivity is reachable.

Kraken documents available balance as balance + credit - credit_used - hold_trade. This conservative indication excludes offered credit: balance - credit_used - hold_trade. It is not an affordability test or spending authorization. Held amounts cover spot non-margin orders, not all margin obligations.

Only an unambiguous USD/ZUSD row with all four decimal-string fields is supported. Missing fields, numeric JSON values, invalid decimals, duplicate aliases and reward/staked suffixes remain unavailable. No missing value is assumed zero. BigInt arithmetic preserves precision; negatives are not clamped into a pass. The documentation's numeric examples or other provider schema differences may therefore produce unavailable evidence; no live acceptance is claimed.

Snapshot only: fees, eligibility, margin coverage and order affordability remain unverified. No snapshot is an execution token. Tests use synthetic responses; customer onboarding and trading stay separately gated.

Official reference reviewed September 12, 2026: [Kraken extended balances](https://docs.kraken.com/api-reference/account-data/get-extended-balance).
