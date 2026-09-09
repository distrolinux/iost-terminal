# AITT Verified Agent Benchmark

## Purpose

The AITT Verified Agent Benchmark converts an owner-private paper evaluation
into a deterministic, replayable evidence package. It answers whether an agent
was evaluated under locked rules and whether the retained result is intact. It
does not predict future performance, publish private strategy evidence, promote
an agent, or authorize execution.

## Locked manifest

Every new evaluation seals the asset, timeframe, strategy and candle hashes,
strategy direction and rule, modeled fees/spread/slippage, train/test/step
windows, minimum evidence target, causal information boundary, next-bar fill
rule, ambiguous-bar policy, evaluation window, folds, and baseline set. The
canonical manifest receives a SHA-256 checksum. Changing any locked input
creates a different checksum.

## Evidence scorecard

The benchmark reuses the Strategy Promotion Engine's risk-adjusted score rather
than inventing a competing metric. It retains total score, grade, evidence
confidence, component scores, benchmark alpha, positive-fold percentage and the
overfit-risk proxy. The trace section hashes the causal simulated-trade record
and reports evidence coverage. A no-trade run remains visible but is never
presented as profitable trading evidence.

## Privacy and authority boundary

- Benchmarks are owner-isolated and private by default.
- Publication is not implemented and would require an explicit owner action.
- The full strategy, private identifiers and credentials are never made public.
- A benchmark grants no execution authority and cannot change permissions.
- Automatic promotion is prohibited; lifecycle recommendations remain advisory.
- Live scope, token actions and public-chain writes are unavailable.

## Interfaces

- The Agent Evaluation Lab renders the verified manifest checksum, trace
  coverage, baseline count, privacy state and evidence hash.
- `GET /api/agent-benchmarks` returns the authenticated owner's retained
  benchmark scorecards.
- `agent_benchmark_scorecards` exposes the same private read-only evidence to
  authorized MCP agents.

Legacy retained evaluations remain readable and are labelled `legacy` because
they predate the benchmark envelope. New evaluations include the benchmark in
the existing result hash, so benchmark tampering invalidates the complete
evaluation record.
