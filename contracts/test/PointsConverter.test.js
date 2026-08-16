const { expect } = require("chai");
const { ethers } = require("hardhat");

const TOKEN = 10n ** 8n; // 1 AITT (8 decimals)
const RESERVE = 10_000_000n * TOKEN; // 10M AITT reserved for points conversion

describe("PointsConverter (points → AITT 1:1)", function () {
  let aitt, conv, owner, operator, alice, bob;

  beforeEach(async function () {
    [owner, operator, alice, bob] = await ethers.getSigners();
    const AITT = await ethers.getContractFactory("AITT");
    aitt = await AITT.deploy(owner.address);
    await aitt.waitForDeployment();

    const Converter = await ethers.getContractFactory("PointsConverter");
    conv = await Converter.deploy(await aitt.getAddress(), operator.address);
    await conv.waitForDeployment();

    await aitt.approve(await conv.getAddress(), RESERVE);
    await conv.fundReserve(RESERVE);
  });

  it("starts with a funded reserve and no approvals", async function () {
    expect(await conv.reserve()).to.equal(RESERVE);
    expect(await conv.operator()).to.equal(operator.address);
    expect(await conv.owner()).to.equal(owner.address);
  });

  it("converts approved points 1:1 (no discount, no fee)", async function () {
    await conv.connect(operator).approveClaims([alice.address, bob.address], [4000n * TOKEN, 6000n * TOKEN]);
    await conv.connect(alice).convert();
    expect(await aitt.balanceOf(alice.address)).to.equal(4000n * TOKEN);
    await conv.connect(bob).convert();
    expect(await aitt.balanceOf(bob.address)).to.equal(6000n * TOKEN);
    expect(await conv.reserve()).to.equal(RESERVE - 10000n * TOKEN);
  });

  it("rejects converting more than approved", async function () {
    await conv.connect(operator).approveClaims([alice.address], [100n * TOKEN]);
    await conv.connect(alice).convert();
    await expect(conv.connect(alice).convert()).to.be.revertedWithCustomError(conv, "NothingToClaim");
  });

  it("reverts when approvals exceed the funded reserve", async function () {
    await expect(
      conv.connect(operator).approveClaims([alice.address], [RESERVE + 1n])
    ).to.be.revertedWithCustomError(conv, "InsufficientReserve");
  });

  it("blocks claims when paused", async function () {
    await conv.connect(operator).approveClaims([alice.address], [100n * TOKEN]);
    await conv.pause();
    await expect(conv.connect(alice).convert()).to.be.reverted;
    await conv.unpause();
    await conv.connect(alice).convert();
    expect(await aitt.balanceOf(alice.address)).to.equal(100n * TOKEN);
  });

  it("only the operator can approve claims", async function () {
    await expect(
      conv.connect(alice).approveClaims([alice.address], [100n * TOKEN])
    ).to.be.revertedWithCustomError(conv, "NotOperator");
  });

  it("owner can rotate the operator", async function () {
    await conv.setOperator(bob.address);
    expect(await conv.operator()).to.equal(bob.address);
    await expect(
      conv.connect(operator).approveClaims([alice.address], [100n * TOKEN])
    ).to.be.revertedWithCustomError(conv, "NotOperator");
  });

  it("re-approval recomputes outstanding precisely (incl. downgrades)", async function () {
    // Approve alice 100, bob 100 -> outstanding 200
    await conv.connect(operator).approveClaims([alice.address, bob.address], [100n * TOKEN, 100n * TOKEN]);
    expect(await conv.totalOutstanding()).to.equal(200n * TOKEN);
    // alice converts her full 100 (convert() claims everything claimable) -> outstanding 100
    await conv.connect(alice).convert();
    expect(await conv.totalOutstanding()).to.equal(100n * TOKEN);
    // Re-approve: alice 50 (below her 100 already claimed → outstanding 0),
    // bob 100 (unchanged), owner 200 → outstanding 100 + 200 = 300
    await conv.connect(operator).approveClaims([alice.address, bob.address, owner.address], [50n * TOKEN, 100n * TOKEN, 200n * TOKEN]);
    expect(await conv.totalOutstanding()).to.equal(300n * TOKEN);
    expect(await conv.approved(alice.address)).to.equal(50n * TOKEN);
  });

  it("claimable() reflects approved minus claimed", async function () {
    await conv.connect(operator).approveClaims([alice.address], [100n * TOKEN]);
    expect(await conv.claimable(alice.address)).to.equal(100n * TOKEN);
    await conv.connect(alice).convert();
    expect(await conv.claimable(alice.address)).to.equal(0n);
  });

  it("owner can withdraw unused reserve (window closed)", async function () {
    await conv.connect(operator).approveClaims([alice.address], [100n * TOKEN]);
    const before = await conv.reserve();
    await conv.withdrawReserve(owner.address, 500n * TOKEN);
    expect(await conv.reserve()).to.equal(before - 500n * TOKEN);
    // Owner started with the full supply, funded the 10M reserve, got 500 back.
    expect(await aitt.balanceOf(owner.address)).to.equal(1_000_000_000n * TOKEN - RESERVE + 500n * TOKEN);
  });

  it("cannot withdraw below what is still owed to users", async function () {
    await conv.connect(operator).approveClaims([alice.address], [100n * TOKEN]);
    await expect(conv.withdrawReserve(owner.address, RESERVE)).to.be.revertedWithCustomError(conv, "ZeroAmount");
  });

  it("non-owner cannot withdraw reserve", async function () {
    await expect(conv.connect(alice).withdrawReserve(alice.address, 1n)).to.be.reverted;
  });
});
