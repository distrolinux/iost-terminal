# AITT Build Toolchain Containment

## Current state

The Hardhat 2/toolbox 5 dependency tree is development-only and does not ship in bytecode, but the full npm audit reports high transitive advisories. Runtime audits remain clean.

## Mandatory containment until migration

- Use only committed source/config and trusted RPC responses.
- Install with `npm ci --ignore-scripts`; never run arbitrary downloaded projects through this toolchain.
- Run builds in an isolated disposable workspace/container with no production secrets.
- Inject a throwaway deployer key only for local/approved deployment and never persist it.
- Do not process untrusted ZIPs, WebSocket endpoints, templates, or coverage inputs.
- Use frozen lockfile and verify the diff before any dependency change.
- No `npm audit fix --force`.

## Migration gate

Test Hardhat 3 + toolbox 7 in an isolated branch/worktree. Migration passes only when all contract tests, deploy rehearsal, exact verifier, Slither, Mythril, and IOST L2 config checks pass with no economic/bytecode surprise. Until then, the contained Hardhat 2 runner is tooling-only and cannot authorize deployment.
