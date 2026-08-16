const { expect } = require("chai");
const { ethers } = require("hardhat");

const SUPPLY = 1_000_000_000n * 10n ** 8n;

describe("AITT (ERC-20)", function () {
  let aitt, owner, alice, bob;

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();
    const AITT = await ethers.getContractFactory("AITT");
    aitt = await AITT.deploy(owner.address);
    await aitt.waitForDeployment();
  });

  it("has the locked identity: name, symbol, 8 decimals, 1B fixed supply", async function () {
    expect(await aitt.name()).to.equal("Agent Intelligence Trading Token");
    expect(await aitt.symbol()).to.equal("AITT");
    expect(await aitt.decimals()).to.equal(8n);
    expect(await aitt.totalSupply()).to.equal(SUPPLY);
  });

  it("mints the full supply to the deployer (allocation distributor)", async function () {
    expect(await aitt.balanceOf(owner.address)).to.equal(SUPPLY);
  });

  it("has NO mint function — supply is immutable", async function () {
    // No mint in the ABI: supply can never be created after deployment.
    const names = aitt.interface.fragments.map((f) => f.name);
    expect(names).to.not.include("mint");
    expect(names).to.not.include("burn");
  });

  it("supports transfers", async function () {
    await aitt.transfer(alice.address, 1000n);
    expect(await aitt.balanceOf(alice.address)).to.equal(1000n);
  });

  it("supports approve/transferFrom (allowance flow)", async function () {
    await aitt.approve(bob.address, 500n);
    await aitt.connect(bob).transferFrom(owner.address, bob.address, 500n);
    expect(await aitt.balanceOf(bob.address)).to.equal(500n);
    expect(await aitt.allowance(owner.address, bob.address)).to.equal(0n);
  });

  it("reverts on insufficient balance", async function () {
    await expect(aitt.transfer(alice.address, SUPPLY + 1n)).to.be.revertedWithCustomError(
      aitt,
      "ERC20InsufficientBalance"
    );
  });

  it("can renounce ownership without affecting token function", async function () {
    await aitt.renounceOwnership();
    expect(await aitt.owner()).to.equal(ethers.ZeroAddress);
    // Token still works.
    await aitt.transfer(alice.address, 100n);
    expect(await aitt.balanceOf(alice.address)).to.equal(100n);
  });
});
