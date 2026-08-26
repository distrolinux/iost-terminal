# Protected CI verification

This documentation-only change verifies that repository protections and the
read-only safety workflow operate on pull requests targeting `main`.

Verification is complete when:

- direct changes to `main` remain restricted;
- the pull request safety workflow starts automatically;
- application, local-contract, and secret-scan jobs pass;
- no deployment, production restart, trading action, token action, or
  public-chain action occurs.

After a successful run, repository administrators may require these checks in
the `main` branch ruleset.
