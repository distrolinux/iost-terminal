// Phase 1 deployment script — AITT on IOST L2 (chain 182).
//
// Prereqs:
//   1. cp deploy.config.example.json deploy.config.json  (fill in addresses)
//   2. export PRIVATE_KEY=0x...   (deployer with BNB on IOST L2 for gas)
//   3. npx hardhat run scripts/deploy.js --network iostL2
//
// Deploys, in order: AITT (1B, 8 decimals) -> Team vesting -> Advisor vesting
// -> PointsConverter, then moves every allocation and funds the conversion
// reserve. Prints a summary + verification commands. Re-running deploys a
// fresh set (no upgrade path — token is immutable by design).

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const DAY = 24n * 60n * 60n;
const YEAR = 365n * DAY;
const TOKEN = 10n ** 8n; // 1 AITT
const B = (n) => BigInt(n) * TOKEN;
const ZERO_ADDRESS = ethers.ZeroAddress;

function loadConfig() {
  const p = path.join(__dirname, "..", "deploy.config.json");
  if (!fs.existsSync(p)) {
    throw new Error("deploy.config.json not found — copy deploy.config.example.json and fill it in");
  }
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  const requiredAllocations = [
    "ecosystemPool", "treasury", "teamBeneficiary", "partners",
    "community", "reserve", "advisorBeneficiary",
  ];
  if (!cfg.allocations || typeof cfg.allocations !== "object") {
    throw new Error("deploy.config.json: allocations object is required");
  }
  for (const key of requiredAllocations) {
    if (!Object.prototype.hasOwnProperty.call(cfg.allocations, key)) {
      throw new Error(`deploy.config.json: allocations.${key} is required`);
    }
  }
  const requireAddress = (label, value, { allowZero = false } = {}) => {
    if (!value || !ethers.isAddress(value)) throw new Error(`deploy.config.json: ${label} is not a valid address`);
    const normalized = ethers.getAddress(value);
    if (!allowZero && normalized === ZERO_ADDRESS) throw new Error(`deploy.config.json: ${label} is not set`);
    return normalized;
  };
  for (const [k, v] of Object.entries(cfg.allocations)) {
    cfg.allocations[k] = requireAddress(`allocations.${k}`, v);
  }
  cfg.operator = requireAddress("operator", cfg.operator);
  cfg.stakersPool = requireAddress("stakersPool", cfg.stakersPool);
  if (cfg.ammPair) cfg.ammPair = requireAddress("ammPair", cfg.ammPair, { allowZero: true });
  return cfg;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const cfg = loadConfig();
  const A = cfg.allocations;
  console.log(`\n=== AITT Phase 1 deployment on ${network.name} (${network.config.chainId}) ===`);
  console.log(`deployer: ${deployer.address}\n`);

  const totalReserve = BigInt(cfg.pointsConversionReserve || "0");
  const ecosystemAllocation = B(300_000_000);
  if (totalReserve < 0n || totalReserve > ecosystemAllocation) {
    throw new Error("deploy.config.json: pointsConversionReserve exceeds 300M ecosystem pool");
  }

  // 1. Token (swap tax per TOKENOMICS.md v1.4: 3% buy/sell only —
  //    1.8% burn / 0.8% stakers / 0.4% treasury)
  const AITT = await ethers.getContractFactory("AITT");
  const aitt = await AITT.deploy(deployer.address, A.treasury, cfg.stakersPool);
  await aitt.waitForDeployment();
  console.log(`AITT             @ ${await aitt.getAddress()}`);
  console.log(`  swap tax: 3% on AMM buy/sell (1.8% burn / 0.8% stakers / 0.4% treasury), 0% wallet-to-wallet`);

  // 1b. Lock the taxed AMM pair — only possible after the DEX pair exists
  //     (createPair), so this is a manual one-time step. Optional in config;
  //     can also be run later: npx hardhat run scripts/setAmmPair.js --network iostL2
  if (cfg.ammPair && cfg.ammPair !== ZERO_ADDRESS) {
    await (await aitt.setAmmPair(cfg.ammPair)).wait();
    console.log(`  -> AMM pair locked: ${cfg.ammPair}`);
  } else {
    console.log(`  -> AMM pair NOT set (set it via setAmmPair once liquidity is created)`);
  }

  // 2. Vesting contracts (team: 12-mo cliff + 36-mo linear; advisors: 12-mo cliff + 24-mo linear)
  const Vesting = await ethers.getContractFactory("AITTVesting");
  const teamVest = await Vesting.deploy(
    await aitt.getAddress(), A.teamBeneficiary, 0n, 12n * YEAR, 36n * YEAR, B(150_000_000)
  );
  await teamVest.waitForDeployment();
  const advisorVest = await Vesting.deploy(
    await aitt.getAddress(), A.advisorBeneficiary, 0n, 12n * YEAR, 24n * YEAR, B(50_000_000)
  );
  await advisorVest.waitForDeployment();
  console.log(`TeamVesting      @ ${await teamVest.getAddress()}  (150M, cliff 12mo, linear 36mo)`);
  console.log(`AdvisorVesting   @ ${await advisorVest.getAddress()}  (50M, cliff 12mo, linear 24mo)`);

  // Record vesting addresses back into the config so verify.js can check them.
  cfg.allocations.teamVesting = await teamVest.getAddress();
  cfg.allocations.advisorVesting = await advisorVest.getAddress();
  fs.writeFileSync(path.join(__dirname, "..", "deploy.config.json"), JSON.stringify(cfg, null, 2));

  // 3. Points converter
  const Converter = await ethers.getContractFactory("PointsConverter");
  const converter = await Converter.deploy(await aitt.getAddress(), cfg.operator);
  await converter.waitForDeployment();
  console.log(`PointsConverter  @ ${await converter.getAddress()}  (operator: ${cfg.operator})`);

  // 4. Fund the conversion reserve FIRST (from the deployer's minted supply),
  //    before allocations move — the reserve is part of the ~10% initial
  //    circulating bucket (points conversion + ecosystem seed).
  let ecosystemAmount = B(300_000_000);
  if (totalReserve > 0n) {
    await (await aitt.approve(await converter.getAddress(), totalReserve)).wait();
    await (await converter.fundReserve(totalReserve)).wait();
    ecosystemAmount -= totalReserve; // reserve comes out of the ecosystem pool
    console.log(`  -> converter reserve funded with ${totalReserve / TOKEN} AITT (drawn from ecosystem pool)`);
  } else {
    console.log(`  -> conversion reserve NOT funded (set pointsConversionReserve > 0 when the points snapshot is final)`);
  }

  // 5. Move allocations (sums to 1,000,000,000 AITT including the reserve)
  const moves = [
    ["ecosystem pool", A.ecosystemPool, ecosystemAmount],
    ["treasury", A.treasury, B(200_000_000)],
    ["team vesting", await teamVest.getAddress(), B(150_000_000)],
    ["partners", A.partners, B(100_000_000)],
    ["community", A.community, B(100_000_000)],
    ["reserve", A.reserve, B(100_000_000)],
    ["advisor vesting", await advisorVest.getAddress(), B(50_000_000)],
  ];
  for (const [label, to, amount] of moves) {
    await (await aitt.transfer(to, amount)).wait();
    console.log(`  -> ${label.padEnd(16)} ${amount / TOKEN} AITT  -> ${to}`);
  }

  // 6. Summary
  const supply = await aitt.totalSupply();
  const held = await aitt.balanceOf(deployer.address);
  console.log(`\n=== DONE ===`);
  console.log(`total supply:    ${supply / TOKEN} AITT`);
  console.log(`deployer holds:  ${held / TOKEN} AITT (should be 0 if all allocations moved)`);
  console.log(`\nVerification:`);
  console.log(`  npx hardhat run scripts/verify.js --network iostL2`);
  console.log(`Explorer: https://l2-scan.iost.io/address/${await aitt.getAddress()}`);
  console.log(`Verify source: https://l2-scan.iost.io/address/${await aitt.getAddress()}#code`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
