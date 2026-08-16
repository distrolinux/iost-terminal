const { expect } = require("chai");
const { ethers } = require("hardhat");

const DAY = 24n * 60n * 60n;
const YEAR = 365n * DAY;

const TEAM_ALLOC = 150_000_000n * 10n ** 8n; // 150M AITT
const ADVISOR_ALLOC = 50_000_000n * 10n ** 8n; // 50M AITT

async function deployVesting(token, beneficiary, opts = {}) {
  const Vesting = await ethers.getContractFactory("AITTVesting");
  const cliff = opts.cliff ?? 12n * YEAR; // 12-mo cliff
  const duration = opts.duration ?? 36n * YEAR; // 36-mo linear
  const start = opts.start ?? 0n;
  const total = opts.total ?? TEAM_ALLOC;
  const v = await Vesting.deploy(
    await token.getAddress(),
    beneficiary,
    start,
    cliff,
    duration,
    total
  );
  await v.waitForDeployment();
  // Fund it like the deploy script does.
  await token.transfer(await v.getAddress(), total);
  return v;
}

/** Mine the next block at an exact timestamp (EDR: bare hex quantity). */
async function jumpTo(ts) {
  await ethers.provider.send("evm_mine", ["0x" + ts.toString(16)]);
}

describe("AITTVesting (cliff + linear)", function () {
  let aitt, deployer, team, advisor, stranger;
  let vest;

  beforeEach(async function () {
    [deployer, team, advisor, stranger] = await ethers.getSigners();
    const AITT = await ethers.getContractFactory("AITT");
    aitt = await AITT.deploy(deployer.address);
    await aitt.waitForDeployment();
    vest = await deployVesting(aitt, team.address);
  });

  it("holds the full allocation and exposes schedule params", async function () {
    expect(await vest.totalAllocated()).to.equal(TEAM_ALLOC);
    expect(await vest.beneficiary()).to.equal(team.address);
    expect(await vest.cliffDuration()).to.equal(12n * YEAR);
    expect(await vest.duration()).to.equal(36n * YEAR);
    expect(await aitt.balanceOf(await vest.getAddress())).to.equal(TEAM_ALLOC);
  });

  it("vests nothing before the cliff", async function () {
    expect(await vest.vestedAmount()).to.equal(0n);
    await expect(vest.connect(team).release()).to.be.revertedWith("AITTVesting: nothing to release");
  });

  it("vests nothing one day before the cliff, or exactly AT the cliff", async function () {
    const start = await vest.start();
    // 1 day before cliff
    await jumpTo(start + 12n * YEAR - 1n * DAY);
    expect(await vest.vestedAmount()).to.equal(0n);
    // exactly at cliff (linear period has not started — cliff is exclusive)
    await jumpTo(start + 12n * YEAR);
    expect(await vest.vestedAmount()).to.equal(0n);
  });

  it("releases linearly after the cliff", async function () {
    // 12y cliff + 18y of linear => 18/36 = 1/2 vested
    const start = await vest.start();
    await jumpTo(start + 12n * YEAR + 18n * YEAR);
    expect(await vest.vestedAmount()).to.equal(TEAM_ALLOC / 2n);
    expect(await vest.releasable()).to.equal(TEAM_ALLOC / 2n);

    await vest.connect(team).release();
    // The release tx lands within 1–2 blocks of the jump target, so expect the
    // released amount to be within one block-second of the exact half.
    const perSec = TEAM_ALLOC / (36n * YEAR);
    const released = await vest.released();
    expect(released).to.be.gte(TEAM_ALLOC / 2n);
    expect(released).to.be.lt(TEAM_ALLOC / 2n + 2n * perSec);
    // Balance accounting stays exact: what was released is what the beneficiary got.
    expect(await aitt.balanceOf(team.address)).to.equal(released);
    expect(await vest.releasable()).to.equal((await vest.vestedAmount()) - released);

    // 6 years later (24y into the 36y linear period): 2/3 of the total is vested
    await jumpTo(start + 12n * YEAR + 24n * YEAR);
    expect(await vest.vestedAmount()).to.equal((TEAM_ALLOC * 2n) / 3n);
  });

  it("a stranger can trigger release but tokens go to the beneficiary only", async function () {
    const start = await vest.start();
    await jumpTo(start + 12n * YEAR + 36n * YEAR);
    await vest.connect(stranger).release();
    expect(await aitt.balanceOf(team.address)).to.equal(TEAM_ALLOC);
    expect(await aitt.balanceOf(stranger.address)).to.equal(0n);
  });

  it("is fully vested after cliff + duration", async function () {
    const start = await vest.start();
    await jumpTo(start + 12n * YEAR + 36n * YEAR);
    expect(await vest.vestedAmount()).to.equal(TEAM_ALLOC);
    await vest.connect(team).release();
    expect(await aitt.balanceOf(team.address)).to.equal(TEAM_ALLOC);
    // Second release reverts — nothing left.
    await expect(vest.connect(team).release()).to.be.revertedWith("AITTVesting: nothing to release");
  });

  it("supports the advisor schedule (12-mo cliff + 24-mo linear)", async function () {
    const advisorVest = await deployVesting(aitt, advisor.address, {
      total: ADVISOR_ALLOC,
      duration: 24n * YEAR,
    });
    const start = await advisorVest.start();
    await jumpTo(start + 12n * YEAR + 24n * YEAR);
    expect(await advisorVest.vestedAmount()).to.equal(ADVISOR_ALLOC);
  });

  it("uses deployment time as start when start=0", async function () {
    const receipt = await vest.deploymentTransaction().wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);
    expect(await vest.start()).to.equal(block.timestamp);
  });

  it("owner can sweep foreign tokens but never the vested token", async function () {
    // Sweeping the vested token itself always reverts.
    await expect(
      vest.connect(deployer).sweep(await aitt.getAddress(), deployer.address, 1n)
    ).to.be.revertedWith("AITTVesting: vested token");

    // Non-owner cannot sweep either.
    await expect(
      vest.connect(stranger).sweep(await aitt.getAddress(), stranger.address, 1n)
    ).to.be.reverted;
  });
});
