const { expect } = require("chai");
const { ethers } = require("hardhat");
const { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { computeReleaseFingerprints } = require("../scripts/release-approval-lib");

// Regressions for production deployment orchestration. Every run uses an
// isolated Hardhat chain and throwaway filesystem; no real key or network.
describe("Phase 1 deployment script", function () {
  this.timeout(180_000);

  async function runDeploy(overrides = {}, envOverrides = {}) {
    const root = join(__dirname, "..");
    const scratch = mkdtempSync(join(tmpdir(), "aitt-deploy-test-"));
    const signers = await ethers.getSigners();
    const base = {
      network: "hardhat",
      allocations: {
        ecosystemPool: signers[1].address,
        treasury: signers[2].address,
        teamBeneficiary: signers[3].address,
        partners: signers[4].address,
        community: signers[5].address,
        reserve: signers[6].address,
        advisorBeneficiary: signers[7].address,
      },
      pointsConversionReserve: "0",
      operator: signers[8].address,
      stakersPool: signers[9].address,
      governanceOwner: signers[10].address,
      ammPair: ethers.ZeroAddress,
    };
    const cfg = {
      ...base,
      ...overrides,
      allocations: { ...base.allocations, ...(overrides.allocations || {}) },
    };
    try {
      cpSync(join(root, "contracts"), join(scratch, "contracts"), { recursive: true });
      cpSync(join(root, "scripts"), join(scratch, "scripts"), { recursive: true });
      cpSync(join(root, "hardhat.config.js"), join(scratch, "hardhat.config.js"));
      cpSync(join(root, "package.json"), join(scratch, "package.json"));
      cpSync(join(root, "package-lock.json"), join(scratch, "package-lock.json"));
      symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
      mkdirSync(join(scratch, "data"), { recursive: true });
      writeFileSync(join(scratch, "deploy.config.json"), JSON.stringify(cfg, null, 2));
      const releaseApprovalPath = join(scratch, "release-approval.json");
      const fingerprints = computeReleaseFingerprints(cfg, 31337, root);
      writeFileSync(releaseApprovalPath, JSON.stringify({
        auditApproved: true, counselApproved: true, ownerApproved: true, governanceSafeReviewed: true,
        auditReportHash: `0x${'1'.repeat(64)}`, counselApprovalHash: `0x${'2'.repeat(64)}`,
        ownerApprovalHash: `0x${'3'.repeat(64)}`,
        governanceConfigHash: envOverrides.AITT_TEST_STALE_CONFIG_HASH || fingerprints.governanceConfigHash,
        contractBundleHash: envOverrides.AITT_TEST_STALE_BUNDLE_HASH || fingerprints.contractBundleHash,
      }));

      const hardhat = join(root, "node_modules", ".bin", "hardhat");
      const run = spawnSync(hardhat, ["run", "scripts/deploy.js", "--network", "hardhat"], {
        cwd: scratch,
        encoding: "utf8",
        env: { ...process.env, PRIVATE_KEY: "", AITT_RELEASE_APPROVAL_FILE: releaseApprovalPath, ...envOverrides },
        timeout: 150_000,
      });
      const journalPath = join(scratch, "deployment-journal.json");
      run.journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, "utf8")) : null;
      return run;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it("completes with a zero/unset AMM pair without a partial-deploy crash", async function () {
    const run = await runDeploy();
    expect(run.status, `${run.stdout}\n${run.stderr}`).to.equal(0);
    expect(run.stdout).to.include("AMM pair NOT set");
    expect(run.stdout).to.include("AITTFeeRouter");
    expect(run.stdout).to.include("EcosystemEmission");
    expect(run.stdout).to.include("TreasuryVault");
    expect(run.stdout).to.include("PartnersVault");
    expect(run.stdout).to.include("CommunityVault");
    expect(run.stdout).to.include("ReserveVault");
    expect(run.stdout).to.include("direct wallet allocations: 0 AITT");
    expect(run.stdout).to.include("=== DONE ===");
    expect(run.journal?.status).to.equal("completed");
    expect(run.journal?.releaseApprovalHash).to.match(/^0x[0-9a-fA-F]{64}$/);
    expect(run.journal?.steps?.find((step) => step.step === "allocationFunding")?.txHashes).to.have.length(7);
    expect(run.journal?.steps?.find((step) => step.step === "governanceHandoff")?.txHashes).to.have.length(5);
  });

  it("journals a partial deployment before a simulated post-token failure", async function () {
    const run = await runDeploy({}, { AITT_DEPLOY_FAIL_AFTER: "token" });
    expect(run.status).to.not.equal(0);
    expect(run.journal?.status).to.equal("in_progress");
    expect(run.journal?.contracts?.token).to.match(/^0x[0-9a-fA-F]{40}$/);
    expect(run.journal?.steps?.[0]?.txHashes?.[0]).to.match(/^0x[0-9a-fA-F]{64}$/);
  });

  it("rejects a conversion reserve above the 300M ecosystem pool before deployment", async function () {
    const tooLarge = (300_000_000n * 10n ** 8n + 1n).toString();
    const run = await runDeploy({ pointsConversionReserve: tooLarge });
    expect(run.status).to.not.equal(0);
    expect(`${run.stdout}\n${run.stderr}`).to.include("pointsConversionReserve exceeds 300M ecosystem pool");
    expect(run.stdout).to.not.include("AITT             @");
  });

  it("rejects malformed allocation addresses during preflight", async function () {
    const run = await runDeploy({ allocations: { treasury: "not-an-address" } });
    expect(run.status).to.not.equal(0);
    expect(`${run.stdout}\n${run.stderr}`).to.include("allocations.treasury is not a valid address");
    expect(run.stdout).to.not.include("AITT             @");
  });

  it("rejects omitted required allocation fields before deployment", async function () {
    const run = await runDeploy({ allocations: { ecosystemPool: undefined } });
    expect(run.status).to.not.equal(0);
    expect(`${run.stdout}\n${run.stderr}`).to.include("allocations.ecosystemPool is required");
    expect(run.stdout).to.not.include("AITT             @");
  });

  it("rejects deployment before any transaction when release approvals are missing", async function () {
    const run = await runDeploy({}, { AITT_RELEASE_APPROVAL_FILE: "" });
    expect(run.status).to.not.equal(0);
    expect(`${run.stdout}\n${run.stderr}`).to.include("AITT_RELEASE_APPROVAL_FILE is required before deployment");
    expect(run.journal).to.equal(null);
  });

  it("rejects approval evidence bound to a different deployment config", async function () {
    const run = await runDeploy({}, { AITT_TEST_STALE_CONFIG_HASH: `0x${'9'.repeat(64)}` });
    expect(run.status).to.not.equal(0);
    expect(`${run.stdout}\n${run.stderr}`).to.include("governanceConfigHash does not match deploy.config.json");
    expect(run.journal).to.equal(null);
  });

  it("rejects approval evidence bound to different compiled bytecode", async function () {
    const run = await runDeploy({}, { AITT_TEST_STALE_BUNDLE_HASH: `0x${'8'.repeat(64)}` });
    expect(run.status).to.not.equal(0);
    expect(`${run.stdout}\n${run.stderr}`).to.include("contractBundleHash does not match compiled contract bytecode");
    expect(run.journal).to.equal(null);
  });
});
