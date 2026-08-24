const { expect } = require("chai");
const { ethers } = require("hardhat");
const { verifyDeployment } = require("../scripts/verify-lib");

const TOKEN = 10n ** 8n;
const B = (n) => BigInt(n) * TOKEN;
const DAY = 24n * 60n * 60n;
const YEAR = 365n * DAY;

async function deployVerificationFixture({ wrongTokenBindings = false, wrongAllocations = false, futureStarts = false } = {}) {
  const signers = await ethers.getSigners();
  const [deployer, ecosystemPool, treasury, teamBeneficiary, partners, community, reserve, advisorBeneficiary, operator, stakersPool, governance] = signers;
  const AITT = await ethers.getContractFactory("AITT");
  const token = await AITT.deploy(deployer.address, treasury.address, stakersPool.address);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();

  const Router = await ethers.getContractFactory("AITTFeeRouter");
  const router = await Router.deploy(tokenAddress, governance.address);
  await router.waitForDeployment();
  await token.setFeeRouter(await router.getAddress());

  let custodyToken = tokenAddress;
  if (wrongTokenBindings) {
    const otherToken = await AITT.deploy(deployer.address, treasury.address, stakersPool.address);
    await otherToken.waitForDeployment();
    custodyToken = await otherToken.getAddress();
  }

  const Vesting = await ethers.getContractFactory("AITTVesting");
  const latest = await ethers.provider.getBlock("latest");
  const start = futureStarts ? BigInt(latest.timestamp) + YEAR : 0n;
  const team = await Vesting.deploy(custodyToken, teamBeneficiary.address, start, YEAR, 3n * YEAR, wrongAllocations ? B(149_000_000) : B(150_000_000));
  const advisor = await Vesting.deploy(custodyToken, advisorBeneficiary.address, start, YEAR, 2n * YEAR, wrongAllocations ? B(49_000_000) : B(50_000_000));
  const ecosystem = await Vesting.deploy(custodyToken, ecosystemPool.address, start, 0n, 4n * YEAR, B(300_000_000));
  await Promise.all([team.waitForDeployment(), advisor.waitForDeployment(), ecosystem.waitForDeployment()]);

  const Vault = await ethers.getContractFactory("AITTMilestoneVault");
  const treasuryVault = await Vault.deploy(custodyToken, B(200_000_000), governance.address);
  const partnersVault = await Vault.deploy(custodyToken, B(100_000_000), governance.address);
  const communityVault = await Vault.deploy(custodyToken, B(100_000_000), governance.address);
  const reserveVault = await Vault.deploy(custodyToken, B(100_000_000), governance.address);
  await Promise.all([treasuryVault.waitForDeployment(), partnersVault.waitForDeployment(), communityVault.waitForDeployment(), reserveVault.waitForDeployment()]);

  const Converter = await ethers.getContractFactory("PointsConverter");
  const converter = await Converter.deploy(custodyToken, operator.address);
  await converter.waitForDeployment();

  const contracts = {
    token: tokenAddress,
    feeRouter: await router.getAddress(),
    ecosystemEmission: await ecosystem.getAddress(),
    treasuryVault: await treasuryVault.getAddress(),
    partnersVault: await partnersVault.getAddress(),
    communityVault: await communityVault.getAddress(),
    reserveVault: await reserveVault.getAddress(),
    teamVesting: await team.getAddress(),
    advisorVesting: await advisor.getAddress(),
    pointsConverter: await converter.getAddress(),
  };
  const funding = [
    [contracts.ecosystemEmission, B(300_000_000)],
    [contracts.treasuryVault, B(200_000_000)],
    [contracts.teamVesting, B(150_000_000)],
    [contracts.partnersVault, B(100_000_000)],
    [contracts.communityVault, B(100_000_000)],
    [contracts.reserveVault, B(100_000_000)],
    [contracts.advisorVesting, B(50_000_000)],
  ];
  for (const [address, amount] of funding) await token.transfer(address, amount);
  for (const contract of [token, team, advisor, ecosystem, converter]) await contract.transferOwnership(governance.address);

  return {
    cfg: {
      allocations: {
        ecosystemPool: ecosystemPool.address,
        treasury: treasury.address,
        teamBeneficiary: teamBeneficiary.address,
        partners: partners.address,
        community: community.address,
        reserve: reserve.address,
        advisorBeneficiary: advisorBeneficiary.address,
      },
      pointsConversionReserve: "0",
      operator: operator.address,
      stakersPool: stakersPool.address,
      governanceOwner: governance.address,
      deployerAddress: deployer.address,
      contracts,
    },
    governance,
    vesting: [ecosystem, team, advisor],
    vaults: [treasuryVault, partnersVault, communityVault, reserveVault],
    converter,
  };
}

describe("Post-deploy verification", function () {
  this.timeout(180_000);

  it("passes a canonical deployment and reports the derived assertion count", async function () {
    const { cfg } = await deployVerificationFixture();
    const result = await verifyDeployment(cfg, { allowLocalChain: true });
    expect(result).to.deep.include({ ok: true, chainId: 31337 });
    expect(result.checks).to.be.greaterThan(46);
  });

  it("rejects wrong token bindings for every custody contract", async function () {
    const { cfg } = await deployVerificationFixture({ wrongTokenBindings: true });
    await expect(verifyDeployment(cfg, { allowLocalChain: true })).to.be.rejectedWith("converter token binding mismatch");
    for (const label of ["ecosystem", "team", "advisor"]) {
      await expect(verifyDeployment(cfg, { allowLocalChain: true })).to.be.rejectedWith(`${label} token binding mismatch`);
    }
    for (const label of ["treasury", "partners", "community", "reserve"]) {
      await expect(verifyDeployment(cfg, { allowLocalChain: true })).to.be.rejectedWith(`${label} vault token binding mismatch`);
    }
  });

  it("rejects wrong team and advisor total allocations in base units", async function () {
    const { cfg } = await deployVerificationFixture({ wrongAllocations: true });
    await expect(verifyDeployment(cfg, { allowLocalChain: true })).to.be.rejectedWith("team allocation mismatch");
    await expect(verifyDeployment(cfg, { allowLocalChain: true })).to.be.rejectedWith("advisor allocation mismatch");
  });

  it("rejects vesting starts that are after the verification block", async function () {
    const { cfg } = await deployVerificationFixture({ futureStarts: true });
    for (const label of ["ecosystem", "team", "advisor"]) {
      await expect(verifyDeployment(cfg, { allowLocalChain: true })).to.be.rejectedWith(`${label} start mismatch`);
    }
  });

  it("rejects nonzero released and queued initial state", async function () {
    const { cfg, governance, vesting, vaults, converter } = await deployVerificationFixture();
    await ethers.provider.send("evm_increaseTime", [Number(5n * YEAR)]);
    await ethers.provider.send("evm_mine", []);
    for (const contract of vesting) await contract.release();
    for (const vault of vaults) await vault.connect(governance).queueRelease(governance.address, 1n, ethers.id("verification-test"));
    await converter.connect(governance).closeApprovals();

    const verification = verifyDeployment(cfg, { allowLocalChain: true });
    for (const label of ["ecosystem", "team", "advisor"]) {
      await expect(verification).to.be.rejectedWith(`${label} released state not clean`);
    }
    for (const label of ["treasury", "partners", "community", "reserve"]) {
      await expect(verification).to.be.rejectedWith(`${label} vault initial state not clean`);
    }
    await expect(verification).to.be.rejectedWith("converter approval window unexpectedly closed");
  });
});
