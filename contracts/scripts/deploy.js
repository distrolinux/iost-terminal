// Phase 1 deployment script — AITT pre-launch contracts on IOST L2 (chain 182).
// No deployment may run without the owner-approved release gates in the spec.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("hardhat");
const { verifyDeployment } = require("./verify-lib");
const { computeReleaseFingerprints } = require("./release-approval-lib");

const DAY = 24n * 60n * 60n;
const YEAR = 365n * DAY;
const TOKEN = 10n ** 8n;
const B = (n) => BigInt(n) * TOKEN;
const ZERO_ADDRESS = ethers.ZeroAddress;
const ECOSYSTEM_ALLOCATION = B(300_000_000);
const JOURNAL_PATH = path.join(__dirname, "..", "deployment-journal.json");
const EVIDENCE_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const isEvidenceHash = (value) => EVIDENCE_HASH_RE.test(String(value || "")) && !/^0x0{64}$/i.test(String(value));

function writeJournal(journal) {
  const tmp = `${JOURNAL_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(journal, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, JOURNAL_PATH);
}

function loadConfig() {
  const p = path.join(__dirname, "..", "deploy.config.json");
  if (!fs.existsSync(p)) throw new Error("deploy.config.json not found — copy deploy.config.example.json and fill it in");
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  const requiredAllocations = [
    "ecosystemPool", "treasury", "teamBeneficiary", "partners",
    "community", "reserve", "advisorBeneficiary",
  ];
  if (!cfg.allocations || typeof cfg.allocations !== "object") throw new Error("deploy.config.json: allocations object is required");
  for (const key of requiredAllocations) {
    if (!Object.prototype.hasOwnProperty.call(cfg.allocations, key)) throw new Error(`deploy.config.json: allocations.${key} is required`);
  }
  const requireAddress = (label, value, { allowZero = false } = {}) => {
    if (!value || !ethers.isAddress(value)) throw new Error(`deploy.config.json: ${label} is not a valid address`);
    const normalized = ethers.getAddress(value);
    if (!allowZero && normalized === ZERO_ADDRESS) throw new Error(`deploy.config.json: ${label} is not set`);
    return normalized;
  };
  for (const [k, v] of Object.entries(cfg.allocations)) cfg.allocations[k] = requireAddress(`allocations.${k}`, v);
  cfg.operator = requireAddress("operator", cfg.operator);
  cfg.stakersPool = requireAddress("stakersPool", cfg.stakersPool);
  cfg.governanceOwner = requireAddress("governanceOwner", cfg.governanceOwner);
  if (cfg.ammPair) cfg.ammPair = requireAddress("ammPair", cfg.ammPair, { allowZero: true });
  if (cfg.ammFactory) cfg.ammFactory = requireAddress("ammFactory", cfg.ammFactory, { allowZero: true });
  if (cfg.quoteToken) cfg.quoteToken = requireAddress("quoteToken", cfg.quoteToken, { allowZero: true });
  if (cfg.phase4Enabled === true || (cfg.ammPair && cfg.ammPair !== ZERO_ADDRESS)) {
    throw new Error("deploy.config.json: Phase 4 and AMM pair must remain disabled during canonical Phase 1 launch");
  }

  const totalReserve = BigInt(cfg.pointsConversionReserve || "0");
  if (totalReserve < 0n || totalReserve >= ECOSYSTEM_ALLOCATION) {
    throw new Error("deploy.config.json: pointsConversionReserve exceeds 300M ecosystem pool");
  }
  cfg._totalReserve = totalReserve;
  return cfg;
}

function loadReleaseApproval(cfg) {
  const approvalPath = process.env.AITT_RELEASE_APPROVAL_FILE;
  if (!approvalPath || !fs.existsSync(approvalPath)) {
    throw new Error("AITT_RELEASE_APPROVAL_FILE is required before deployment");
  }
  const approval = JSON.parse(fs.readFileSync(approvalPath, "utf8"));
  for (const key of ["auditApproved", "counselApproved", "ownerApproved", "governanceSafeReviewed"]) {
    if (approval[key] !== true) throw new Error(`release approval missing: ${key}`);
  }
  for (const key of ["auditReportHash", "counselApprovalHash", "ownerApprovalHash", "governanceConfigHash", "contractBundleHash"]) {
    if (!isEvidenceHash(approval[key])) throw new Error(`release approval evidence hash missing: ${key}`);
  }
  const expected = computeReleaseFingerprints(cfg, network.config.chainId, path.join(__dirname, ".."));
  if (approval.governanceConfigHash.toLowerCase() !== expected.governanceConfigHash.toLowerCase()) {
    throw new Error("release approval governanceConfigHash does not match deploy.config.json");
  }
  if (approval.contractBundleHash.toLowerCase() !== expected.contractBundleHash.toLowerCase()) {
    throw new Error("release approval contractBundleHash does not match compiled contract bytecode");
  }
  return {
    approval,
    hash: `0x${crypto.createHash("sha256").update(JSON.stringify(approval)).digest("hex")}`,
  };
}

async function deployMilestoneVault(factory, token, amount, owner, label, key, journalTx) {
  const vault = await factory.deploy(token, amount, owner);
  const address = await vault.getAddress();
  await journalTx(`deploy.${key}`, vault.deploymentTransaction(), { [key]: address });
  console.log(`${label.padEnd(19)} @ ${await vault.getAddress()}  (${amount / TOKEN} AITT, 48h queue)`);
  return vault;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const cfg = loadConfig(); // all validation occurs before the first transaction
  const releaseApproval = loadReleaseApproval(cfg);
  const A = cfg.allocations;
  const totalReserve = cfg._totalReserve;
  delete cfg._totalReserve;
  if (fs.existsSync(JOURNAL_PATH)) throw new Error("deployment-journal.json already exists; inspect it before any rerun");
  const journal = {
    status: "in_progress", network: network.name, chainId: network.config.chainId,
    startedAt: new Date().toISOString(), deployerAddress: deployer.address,
    releaseApprovalHash: releaseApproval.hash, contracts: {}, steps: [],
  };
  const journalTx = async (step, tx, contracts = {}, metadata = {}) => {
    const entry = { step, at: new Date().toISOString(), status: "submitted", txHashes: [tx.hash], ...metadata };
    journal.steps.push(entry);
    Object.assign(journal.contracts, contracts);
    writeJournal(journal);
    try {
      const receipt = await tx.wait();
      entry.status = "confirmed";
      entry.blockNumber = receipt.blockNumber;
      entry.confirmedAt = new Date().toISOString();
      writeJournal(journal);
      return receipt;
    } catch (error) {
      entry.status = "failed";
      entry.error = String(error?.shortMessage || error?.message || error).slice(0, 300);
      writeJournal(journal);
      throw error;
    }
  };
  writeJournal(journal);

  console.log(`\n=== AITT pre-launch deployment on ${network.name} (${network.config.chainId}) ===`);
  console.log(`deployer: ${deployer.address}`);
  console.log(`governance: ${cfg.governanceOwner}\n`);

  // 1. Fixed-supply token.
  const AITT = await ethers.getContractFactory("AITT");
  const aitt = await AITT.deploy(deployer.address, A.treasury, cfg.stakersPool);
  const tokenAddress = await aitt.getAddress();
  await journalTx("deploy.token", aitt.deploymentTransaction(), { token: tokenAddress });
  if (process.env.AITT_DEPLOY_FAIL_AFTER === "token") throw new Error("simulated failure after token");
  console.log(`AITT                @ ${tokenAddress}`);

  // 2. Sole external fee/DAO burn router; token locks it once.
  const FeeRouter = await ethers.getContractFactory("AITTFeeRouter");
  const feeRouter = await FeeRouter.deploy(tokenAddress, cfg.governanceOwner);
  const feeRouterAddress = await feeRouter.getAddress();
  await journalTx("deploy.feeRouter", feeRouter.deploymentTransaction(), { feeRouter: feeRouterAddress });
  await journalTx("bind.feeRouter", await aitt.setFeeRouter(feeRouterAddress));
  console.log(`AITTFeeRouter       @ ${await feeRouter.getAddress()}`);

  console.log("  -> AMM pair NOT set (Phase 4 remains blocked)");

  // 3. Team/advisor vesting plus ecosystem 48-month linear emission.
  const Vesting = await ethers.getContractFactory("AITTVesting");
  const teamVest = await Vesting.deploy(tokenAddress, A.teamBeneficiary, 0n, YEAR, 3n * YEAR, B(150_000_000));
  await journalTx("deploy.teamVesting", teamVest.deploymentTransaction(), { teamVesting: await teamVest.getAddress() });
  const advisorVest = await Vesting.deploy(tokenAddress, A.advisorBeneficiary, 0n, YEAR, 2n * YEAR, B(50_000_000));
  await journalTx("deploy.advisorVesting", advisorVest.deploymentTransaction(), { advisorVesting: await advisorVest.getAddress() });
  const ecosystemAmount = ECOSYSTEM_ALLOCATION - totalReserve;
  const ecosystemEmission = await Vesting.deploy(tokenAddress, A.ecosystemPool, 0n, 0n, 4n * YEAR, ecosystemAmount);
  await journalTx("deploy.ecosystemEmission", ecosystemEmission.deploymentTransaction(), { ecosystemEmission: await ecosystemEmission.getAddress() });
  console.log(`TeamVesting         @ ${await teamVest.getAddress()}  (150M, 12mo + 36mo)`);
  console.log(`AdvisorVesting      @ ${await advisorVest.getAddress()}  (50M, 12mo + 24mo)`);
  console.log(`EcosystemEmission   @ ${await ecosystemEmission.getAddress()}  (${ecosystemAmount / TOKEN} AITT, linear 48mo)`);

  // 4. Four governance-owned fixed-allocation 48h milestone vaults.
  const MilestoneVault = await ethers.getContractFactory("AITTMilestoneVault");
  const treasuryVault = await deployMilestoneVault(MilestoneVault, tokenAddress, B(200_000_000), cfg.governanceOwner, "TreasuryVault", "treasuryVault", journalTx);
  const partnersVault = await deployMilestoneVault(MilestoneVault, tokenAddress, B(100_000_000), cfg.governanceOwner, "PartnersVault", "partnersVault", journalTx);
  const communityVault = await deployMilestoneVault(MilestoneVault, tokenAddress, B(100_000_000), cfg.governanceOwner, "CommunityVault", "communityVault", journalTx);
  const reserveVault = await deployMilestoneVault(MilestoneVault, tokenAddress, B(100_000_000), cfg.governanceOwner, "ReserveVault", "reserveVault", journalTx);

  // 5. Reserve-funded points converter.
  const Converter = await ethers.getContractFactory("PointsConverter");
  const converter = await Converter.deploy(tokenAddress, cfg.operator);
  await journalTx("deploy.pointsConverter", converter.deploymentTransaction(), { pointsConverter: await converter.getAddress() });
  console.log(`PointsConverter     @ ${await converter.getAddress()}  (operator: ${cfg.operator})`);
  if (totalReserve > 0n) {
    await journalTx("converterReserve.approve", await aitt.approve(await converter.getAddress(), totalReserve));
    await journalTx("converterReserve.fund", await converter.fundReserve(totalReserve));
    console.log(`  -> converter reserve: ${totalReserve / TOKEN} AITT`);
  } else {
    console.log("  -> converter reserve NOT funded; conversion remains closed");
  }

  // 6. Every non-converter allocation lands in a contract, never a direct wallet.
  const moves = [
    ["ecosystem emission", await ecosystemEmission.getAddress(), ecosystemAmount],
    ["treasury vault", await treasuryVault.getAddress(), B(200_000_000)],
    ["team vesting", await teamVest.getAddress(), B(150_000_000)],
    ["partners vault", await partnersVault.getAddress(), B(100_000_000)],
    ["community vault", await communityVault.getAddress(), B(100_000_000)],
    ["reserve vault", await reserveVault.getAddress(), B(100_000_000)],
    ["advisor vesting", await advisorVest.getAddress(), B(50_000_000)],
  ];
  for (const [label, to, amount] of moves) {
    await journalTx(`allocation.${label.replaceAll(" ", "-")}`, await aitt.transfer(to, amount), {}, { to, amount: amount.toString() });
    console.log(`  -> ${label.padEnd(20)} ${amount / TOKEN} AITT -> ${to}`);
  }

  // 7. Governance handoff. Remaining owner-only setters are one-time locks.
  for (const [label, contract] of [["token", aitt], ["teamVesting", teamVest], ["advisorVesting", advisorVest], ["ecosystemEmission", ecosystemEmission], ["pointsConverter", converter]]) {
    await journalTx(`ownership.${label}`, await contract.transferOwnership(cfg.governanceOwner), {}, { newOwner: cfg.governanceOwner });
  }

  cfg.allocations.teamVesting = await teamVest.getAddress();
  cfg.allocations.advisorVesting = await advisorVest.getAddress();
  cfg.contracts = {
    token: tokenAddress,
    feeRouter: await feeRouter.getAddress(),
    ecosystemEmission: await ecosystemEmission.getAddress(),
    treasuryVault: await treasuryVault.getAddress(),
    partnersVault: await partnersVault.getAddress(),
    communityVault: await communityVault.getAddress(),
    reserveVault: await reserveVault.getAddress(),
    teamVesting: await teamVest.getAddress(),
    advisorVesting: await advisorVest.getAddress(),
    pointsConverter: await converter.getAddress(),
  };
  cfg.deployerAddress = deployer.address;
  cfg.releaseApprovalHash = releaseApproval.hash;
  fs.writeFileSync(path.join(__dirname, "..", "deploy.config.json"), JSON.stringify(cfg, null, 2));

  const verification = await verifyDeployment(cfg, { allowLocalChain: network.name === "hardhat" || network.name === "localhost" });
  console.log(`post-deploy verification: PASS (${verification.checks} exact invariants)`);
  const manifest = { network: network.name, chainId: network.config.chainId, contracts: cfg.contracts, governanceOwner: cfg.governanceOwner, deployerAddress: deployer.address, releaseApprovalHash: releaseApproval.hash, pointsConversionReserve: cfg.pointsConversionReserve };
  journal.status = "completed";
  journal.completedAt = new Date().toISOString();
  journal.contracts = { ...cfg.contracts };
  journal.deploymentManifest = manifest;
  journal.deploymentManifestHash = `0x${crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`;
  writeJournal(journal);

  const supply = await aitt.totalSupply();
  const held = await aitt.balanceOf(deployer.address);
  console.log("\n=== DONE ===");
  console.log(`total supply: ${supply / TOKEN} AITT`);
  console.log(`deployer holds: ${held / TOKEN} AITT`);
  console.log("direct wallet allocations: 0 AITT (converter reserve only; all other pools contract-locked)");
  console.log("Verification: npx hardhat run scripts/verify.js --network iostL2");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
