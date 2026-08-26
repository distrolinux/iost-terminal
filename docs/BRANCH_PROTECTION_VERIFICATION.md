# Protected CI verification

This change verifies that repository protections and the read-only safety
workflow operate on pull requests targeting `main`.

Verification is complete when:

- direct changes to `main` remain restricted;
- the pull request safety workflow starts automatically;
- workflow permissions remain read-only;
- application, local-contract, and secret-scan jobs pass;
- no deployment, production restart, trading action, token action, or
  public-chain action occurs.

Production dependencies fail CI on high-severity audit findings. The Hardhat
contract toolchain is development-only and public-chain use remains disabled, so
its audit blocks critical findings while continuing to report lower severities.
The reported high-severity toolchain findings require a separate breaking
Hardhat/toolbox upgrade before any token deployment or public-chain action.

After a successful run, repository administrators may require these checks in
the `main` branch ruleset.
