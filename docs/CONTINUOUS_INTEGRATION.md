# Continuous integration safety checks

The `Safety checks` workflow runs for pull requests, pushes to `main`, and manual
dispatches. It has read-only repository permissions and contains no production,
deployment, live-trading, token, liquidity, or public-chain credentials or steps.

## Required jobs

- **Application safety suite:** installs the root lockfile without lifecycle
  scripts, runs `npm test`, syntax-checks JavaScript and shell files, and fails on
  high-severity production dependency advisories.
- **Local-only contract suite:** selects Hardhat's in-memory network, runs the
  complete contract tests, forces compilation, and audits the contract toolchain.
  It never selects `iostL2` or reads a public RPC credential.
- **High-confidence secret scan:** checks tracked files for private-key headers
  and well-known credential formats without echoing any matched value. GitHub's
  repository secret scanning remains an additional control.

All external actions are pinned to immutable commit SHAs. Dependency installation
uses committed lockfiles. The workflow does not deploy or alter production when a
check passes; merging and deployment remain separate owner-approved actions.

After the workflow is merged, configure the `main` branch ruleset in GitHub to
require all three jobs before merging. Ruleset changes are repository-owner
administration and are not performed by this workflow.
