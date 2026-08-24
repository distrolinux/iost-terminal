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

async function deployMilestoneVault(factory, token, amount, owner, label) {
  const vault = await factory.deploy(token, amount, owner);
  await vault.waitForDeployment();
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
  const record = (step, contracts = {}, txHashes = []) => {
    journal.steps.push({ step, at: new Date().toISOString(), txHashes });
    Object.assign(journal.contracts, contracts);
    writeJournal(journal);
  };
  writeJournal(journal);

  console.log(`\n=== AITT pre-launch deployment on ${network.name} (${network.config.chainId}) ===`);
  console.log(`deployer: ${deployer.address}`);
  console.log(`governance: ${cfg.governanceOwner}\n`);

  // 1. Fixed-supply token.
  const AITT = await ethers.getContractFactory("AITT");
  const aitt = await AITT.deploy(deployer.address, A.treasury, cfg.stakersPool);
  await aitt.waitForDeployment();
  const tokenAddress = await aitt.getAddress();
  record("token", { token: tokenAddress }, [aitt.deploymentTransaction().hash]);
  if (process.env.AITT_DEPLOY_FAIL_AFTER === "token") throw new Error("simulated failure after token");
  console.log(`AITT                @ ${tokenAddress}`);

  // 2. Sole external fee/DAO burn router; token locks it once.
  const FeeRouter = await ethers.getContractFactory("AITTFeeRouter");
  const feeRouter = await FeeRouter.deploy(tokenAddress, cfg.governanceOwner);
  await feeRouter.waitForDeployment();
  const setFeeRouterReceipt = await (await aitt.setFeeRouter(await feeRouter.getAddress())).wait();
  record("feeRouter", { feeRouter: await feeRouter.getAddress() }, [feeRouter.deploymentTransaction().hash, setFeeRouterReceipt.hash]);
  console.log(`AITTFeeRouter       @ ${await feeRouter.getAddress()}`);

  console.log("  -> AMM pair NOT set (Phase 4 remains blocked)");

  // 3. Team/advisor vesting plus ecosystem 48-month linear emission.
  const Vesting = await ethers.getContractFactory("AITTVesting");
  const teamVest = await Vesting.deploy(tokenAddress, A.teamBeneficiary, 0n, YEAR, 3n * YEAR, B(150_000_000));
  await teamVest.waitForDeployment();
  const advisorVest = await Vesting.deploy(tokenAddress, A.advisorBeneficiary, 0n, YEAR, 2n * YEAR, B(50_000_000));
  await advisorVest.waitForDeployment();
  const ecosystemAmount = ECOSYSTEM_ALLOCATION - totalReserve;
  const ecosystemEmission = await Vesting.deploy(tokenAddress, A.ecosystemPool, 0n, 0n, 4n * YEAR, ecosystemAmount);
  await ecosystemEmission.waitForDeployment();
  record("vesting", { teamVesting: await teamVest.getAddress(), advisorVesting: await advisorVest.getAddress(), ecosystemEmission: await ecosystemEmission.getAddress() }, [teamVest.deploymentTransaction().hash, advisorVest.deploymentTransaction().hash, ecosystemEmission.deploymentTransaction().hash]);
  console.log(`TeamVesting         @ ${await teamVest.getAddress()}  (150M, 12mo + 36mo)`);
  console.log(`AdvisorVesting      @ ${await advisorVest.getAddress()}  (50M, 12mo + 24mo)`);
  console.log(`EcosystemEmission   @ ${await ecosystemEmission.getAddress()}  (${ecosystemAmount / TOKEN} AITT, linear 48mo)`);

  // 4. Four governance-owned fixed-allocation 48h milestone vaults.
  const MilestoneVault = await ethers.getContractFactory("AITTMilestoneVault");
  const treasuryVault = await deployMilestoneVault(MilestoneVault, tokenAddress, B(200_000_000), cfg.governanceOwner, "TreasuryVault");
  const partnersVault = await deployMilestoneVault(MilestoneVault, tokenAddress, B(100_000_000), cfg.governanceOwner, "PartnersVault");
  const communityVault = await deployMilestoneVault(MilestoneVault, tokenAddress, B(100_000_000), cfg.governanceOwner, "CommunityVault");
  const reserveVault = await deployMilestoneVault(MilestoneVault, tokenAddress, B(100_000_000), cfg.governanceOwner, "ReserveVault");
  record("milestoneVaults", { treasuryVault: await treasuryVault.getAddress(), partnersVault: await partnersVault.getAddress(), communityVault: await communityVault.getAddress(), reserveVault: await reserveVault.getAddress() }, [treasuryVault.deploymentTransaction().hash, partnersVault.deploymentTransaction().hash, communityVault.deploymentTransaction().hash, reserveVault.deploymentTransaction().hash]);

  // 5. Reserve-funded points converter.
  const Converter = await ethers.getContractFactory("PointsConverter");
  const converter = await Converter.deploy(tokenAddress, cfg.operator);
  await converter.waitForDeployment();
  record("pointsConverter", { pointsConverter: await converter.getAddress() }, [converter.deploymentTransaction().hash]);
  console.log(`PointsConverter     @ ${await converter.getAddress()}  (operator: ${cfg.operator})`);
  if (totalReserve > 0n) {
    const approveReceipt = await (await aitt.approve(await converter.getAddress(), totalReserve)).wait();
    const fundReceipt = await (await converter.fundReserve(totalReserve)).wait();
    record("converterReserveFunded", {}, [approveReceipt.hash, fundReceipt.hash]);
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
  const allocationTxHashes = [];
  for (const [label, to, amount] of moves) {
    const receipt = await (await aitt.transfer(to, amount)).wait();
    allocationTxHashes.push(receipt.hash);
    console.log(`  -> ${label.padEnd(20)} ${amount / TOKEN} AITT -> ${to}`);
  }
  record("allocationFunding", {}, allocationTxHashes);

  // 7. Governance handoff. Remaining owner-only setters are one-time locks.
  const ownershipTxHashes = [];
  for (const contract of [aitt, teamVest, advisorVest, ecosystemEmission, converter]) {
    const receipt = await (await contract.transferOwnership(cfg.governanceOwner)).wait();
    ownershipTxHashes.push(receipt.hash);
  }
  record("governanceHandoff", {}, ownershipTxHashes);

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
