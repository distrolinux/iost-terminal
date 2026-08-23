const { ethers } = require("hardhat");

const TOKEN = 10n ** 8n;
const B = (n) => BigInt(n) * TOKEN;
const ZERO = ethers.ZeroAddress;

async function verifyDeployment(cfg, deployerAddress, { allowLocalChain = false } = {}) {
  const failures = [];
  const pass = (condition, message) => { if (!condition) failures.push(message); };
  const C = cfg.contracts || {};
  const required = [
    "token", "feeRouter", "ecosystemEmission", "treasuryVault", "partnersVault",
    "communityVault", "reserveVault", "teamVesting", "advisorVesting", "pointsConverter",
  ];
  for (const key of required) {
    pass(ethers.isAddress(C[key] || '') && C[key] !== ZERO, `missing/invalid contracts.${key}`);
  }
  if (failures.length) throw new Error(`AITT verification failed:\n- ${failures.join('\n- ')}`);

  const network = await ethers.provider.getNetwork();
  pass(allowLocalChain ? network.chainId === 31337n : network.chainId === 182n, `wrong chain id ${network.chainId}`);
  for (const key of required) pass((await ethers.provider.getCode(C[key])) !== "0x", `no bytecode at ${key}`);

  const token = await ethers.getContractAt("AITT", C.token);
  const router = await ethers.getContractAt("AITTFeeRouter", C.feeRouter);
  const converter = await ethers.getContractAt("PointsConverter", C.pointsConverter);
  const ecosystem = await ethers.getContractAt("AITTVesting", C.ecosystemEmission);
  const team = await ethers.getContractAt("AITTVesting", C.teamVesting);
  const advisor = await ethers.getContractAt("AITTVesting", C.advisorVesting);
  const treasuryVault = await ethers.getContractAt("AITTMilestoneVault", C.treasuryVault);
  const partnersVault = await ethers.getContractAt("AITTMilestoneVault", C.partnersVault);
  const communityVault = await ethers.getContractAt("AITTMilestoneVault", C.communityVault);
  const reserveVault = await ethers.getContractAt("AITTMilestoneVault", C.reserveVault);

  const reserveAmount = BigInt(cfg.pointsConversionReserve || "0");
  const governance = ethers.getAddress(cfg.governanceOwner);
  pass(await token.name() === "Agent Intelligence Trading Token", "wrong token name");
  pass(await token.symbol() === "AITT", "wrong token symbol");
  pass(await token.decimals() === 8n, "wrong decimals");
  pass(await token.totalSupply() === B(1_000_000_000), "wrong total supply");
  pass(await token.SUPPLY_FLOOR() === B(800_000_000), "wrong supply floor");
  pass(await token.owner() === governance, "token owner not governance");
  pass(await token.feeRouter() === C.feeRouter, "fee router not locked in token");
  pass(await token.ammPair() === ZERO, "AMM pair must remain unset in Phase 1");
  pass(await token.treasury() === ethers.getAddress(cfg.allocations.treasury), "token treasury mismatch");
  pass(await token.stakersPool() === ethers.getAddress(cfg.stakersPool), "stakers pool mismatch");

  pass(await router.owner() === governance, "router owner not governance");
  pass(await router.token() === C.token, "router token mismatch");
  pass(await router.treasury() === await token.treasury(), "router treasury mismatch");
  pass(await router.stakersPool() === await token.stakersPool(), "router stakers mismatch");

  pass(await converter.owner() === governance, "converter owner not governance");
  pass(await converter.operator() === ethers.getAddress(cfg.operator), "converter operator mismatch");
  pass(await converter.reserve() === reserveAmount, "converter reserve mismatch");
  pass(await token.balanceOf(C.pointsConverter) === reserveAmount, "converter token balance mismatch");

  const ecosystemAmount = B(300_000_000) - reserveAmount;
  pass(await ecosystem.owner() === governance, "ecosystem emission owner mismatch");
  pass(await ecosystem.beneficiary() === ethers.getAddress(cfg.allocations.ecosystemPool), "ecosystem beneficiary mismatch");
  pass(await ecosystem.cliffDuration() === 0n && await ecosystem.duration() === 4n * 365n * 24n * 60n * 60n, "ecosystem schedule mismatch");
  pass(await ecosystem.totalAllocated() === ecosystemAmount, "ecosystem allocation mismatch");
  pass(await token.balanceOf(C.ecosystemEmission) === ecosystemAmount, "ecosystem vault balance mismatch");

  pass(await team.owner() === governance && await team.beneficiary() === ethers.getAddress(cfg.allocations.teamBeneficiary), "team vesting ownership/beneficiary mismatch");
  pass(await team.cliffDuration() === 365n * 24n * 60n * 60n && await team.duration() === 3n * 365n * 24n * 60n * 60n, "team schedule mismatch");
  pass(await token.balanceOf(C.teamVesting) === B(150_000_000), "team balance mismatch");
  pass(await advisor.owner() === governance && await advisor.beneficiary() === ethers.getAddress(cfg.allocations.advisorBeneficiary), "advisor vesting ownership/beneficiary mismatch");
  pass(await advisor.cliffDuration() === 365n * 24n * 60n * 60n && await advisor.duration() === 2n * 365n * 24n * 60n * 60n, "advisor schedule mismatch");
  pass(await token.balanceOf(C.advisorVesting) === B(50_000_000), "advisor balance mismatch");

  const milestoneChecks = [
    [treasuryVault, C.treasuryVault, B(200_000_000), "treasury"],
    [partnersVault, C.partnersVault, B(100_000_000), "partners"],
    [communityVault, C.communityVault, B(100_000_000), "community"],
    [reserveVault, C.reserveVault, B(100_000_000), "reserve"],
  ];
  for (const [vault, address, amount, label] of milestoneChecks) {
    pass(await vault.owner() === governance, `${label} vault owner mismatch`);
    pass(await vault.totalAllocated() === amount, `${label} allocation mismatch`);
    pass(await vault.RELEASE_DELAY() === 48n * 60n * 60n, `${label} delay mismatch`);
    pass(await token.balanceOf(address) === amount, `${label} vault balance mismatch`);
  }

  pass(await token.balanceOf(deployerAddress) === 0n, "deployer retains AITT");
  const heldByContracts = reserveAmount + ecosystemAmount + B(200_000_000) + B(150_000_000) + B(100_000_000) + B(100_000_000) + B(100_000_000) + B(50_000_000);
  pass(heldByContracts === B(1_000_000_000), "allocation sum mismatch");

  if (failures.length) throw new Error(`AITT verification failed:\n- ${failures.join('\n- ')}`);
  return { ok: true, chainId: Number(network.chainId), checks: 46 };
}

module.exports = { verifyDeployment };
