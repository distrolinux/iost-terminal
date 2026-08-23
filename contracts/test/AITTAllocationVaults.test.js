const { expect } = require("chai");
const { ethers } = require("hardhat");

const DAY = 24n * 60n * 60n;
const DELAY = 2n * DAY;
const TOKEN = 10n ** 8n;
const B = (n) => BigInt(n) * TOKEN;

async function jumpTo(ts) {
  await ethers.provider.send("evm_mine", ["0x" + BigInt(ts).toString(16)]);
}

describe("AITTMilestoneVault", function () {
  let token, vault, owner, recipient, stranger;
  const ALLOCATION = B(200_000_000);

  beforeEach(async function () {
    [owner, recipient, stranger] = await ethers.getSigners();
    const AITT = await ethers.getContractFactory("AITT");
    token = await AITT.deploy(owner.address, owner.address, owner.address);
    await token.waitForDeployment();

    const Vault = await ethers.getContractFactory("AITTMilestoneVault");
    vault = await Vault.deploy(await token.getAddress(), ALLOCATION, owner.address);
    await vault.waitForDeployment();
    await token.transfer(await vault.getAddress(), ALLOCATION);
  });

  async function queue(amount = B(10_000_000), evidence = ethers.id("users>=10000")) {
    const tx = await vault.queueRelease(recipient.address, amount, evidence);
    const receipt = await tx.wait();
    const parsed = receipt.logs.map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } }).find((x) => x?.name === "ReleaseQueued");
    return { id: parsed.args.operationId, executeAfter: parsed.args.executeAfter, amount };
  }

  it("enforces an immutable 48-hour release delay", async function () {
    expect(await vault.RELEASE_DELAY()).to.equal(DELAY);
    const op = await queue();
    await expect(vault.executeRelease(op.id)).to.be.revertedWithCustomError(vault, "ReleaseNotReady");
    await jumpTo(op.executeAfter);
    await vault.connect(stranger).executeRelease(op.id);
    expect(await token.balanceOf(recipient.address)).to.equal(op.amount);
    expect(await vault.released()).to.equal(op.amount);
  });

  it("counts queued releases against the fixed allocation", async function () {
    await queue(B(150_000_000), ethers.id("milestone-a"));
    await expect(queue(B(60_000_000), ethers.id("milestone-b"))).to.be.revertedWithCustomError(vault, "AllocationExceeded");
  });

  it("lets only the owner queue or cancel releases", async function () {
    await expect(vault.connect(stranger).queueRelease(recipient.address, B(1), ethers.id("x"))).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    const op = await queue();
    await expect(vault.connect(stranger).cancelRelease(op.id)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    await vault.cancelRelease(op.id);
    expect(await vault.queued()).to.equal(0n);
    await expect(vault.executeRelease(op.id)).to.be.revertedWithCustomError(vault, "ReleaseUnavailable");
  });

  it("rejects zero recipients, zero amounts, duplicate execution and underfunding", async function () {
    await expect(vault.queueRelease(ethers.ZeroAddress, B(1), ethers.id("x"))).to.be.revertedWithCustomError(vault, "ZeroAddress");
    await expect(vault.queueRelease(recipient.address, 0, ethers.id("x"))).to.be.revertedWithCustomError(vault, "ZeroAmount");
    await expect(vault.queueRelease(recipient.address, B(1), ethers.ZeroHash)).to.be.revertedWithCustomError(vault, "ZeroEvidenceHash");
    const op = await queue();
    await jumpTo(op.executeAfter);
    await vault.executeRelease(op.id);
    await expect(vault.executeRelease(op.id)).to.be.revertedWithCustomError(vault, "ReleaseUnavailable");
  });

  it("requires the full declared allocation to be funded before any queue", async function () {
    const Vault = await ethers.getContractFactory("AITTMilestoneVault");
    const empty = await Vault.deploy(await token.getAddress(), B(100), owner.address);
    await empty.waitForDeployment();
    await expect(empty.queueRelease(recipient.address, B(1), ethers.id("x"))).to.be.revertedWithCustomError(empty, "VaultUnderfunded");
  });

  it("recovers only accidental AITT above the fixed allocation", async function () {
    await token.transfer(await vault.getAddress(), B(1));
    await expect(vault.recoverExcessAITT(recipient.address, B(1) + 1n)).to.be.revertedWithCustomError(vault, "AllocationExceeded");
    await vault.recoverExcessAITT(recipient.address, B(1));
    expect(await token.balanceOf(recipient.address)).to.equal(B(1));
    expect(await token.balanceOf(await vault.getAddress())).to.equal(ALLOCATION);
  });
});

describe("ecosystem 48-month linear emission", function () {
  it("uses the vesting primitive with zero cliff and four-year linear release", async function () {
    const [owner, ecosystem] = await ethers.getSigners();
    const AITT = await ethers.getContractFactory("AITT");
    const token = await AITT.deploy(owner.address, owner.address, owner.address);
    await token.waitForDeployment();
    const allocation = B(300_000_000);
    const Vesting = await ethers.getContractFactory("AITTVesting");
    const vault = await Vesting.deploy(await token.getAddress(), ecosystem.address, 0, 0, 4n * 365n * DAY, allocation);
    await vault.waitForDeployment();
    await token.transfer(await vault.getAddress(), allocation);
    const start = await vault.start();
    await jumpTo(start + 2n * 365n * DAY);
    expect(await vault.vestedAmount()).to.equal(allocation / 2n);
  });
});
