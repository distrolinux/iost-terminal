const { expect } = require("chai");
const { ethers } = require("hardhat");

const SUPPLY = 1_000_000_000n * 10n ** 8n;
const FLOOR = 800_000_000n * 10n ** 8n;
const BPS = 10000n;
const BURN_BPS = 180n;
const STAKERS_BPS = 80n;
const TREASURY_BPS = 40n;

describe("AITT (ERC-20)", function () {
  let aitt, owner, alice, bob, treasury, stakersPool, pair;

  beforeEach(async function () {
    [owner, alice, bob, treasury, stakersPool, pair] = await ethers.getSigners();
    const AITT = await ethers.getContractFactory("AITT");
    aitt = await AITT.deploy(owner.address, treasury.address, stakersPool.address);
    await aitt.waitForDeployment();
  });

  it("has the locked identity: name, symbol, 8 decimals, 1B fixed supply", async function () {
    expect(await aitt.name()).to.equal("Agent Intelligence Trading Token");
    expect(await aitt.symbol()).to.equal("AITT");
    expect(await aitt.decimals()).to.equal(8n);
    expect(await aitt.totalSupply()).to.equal(SUPPLY);
  });

  it("mints the full supply to the deployer (allocation distributor), untaxed", async function () {
    expect(await aitt.balanceOf(owner.address)).to.equal(SUPPLY);
  });

  it("has NO mint function and no external burn — supply is immutable, burns are protocol-only", async function () {
    // No mint/burn in the ABI: supply can never be created after deployment,
    // and no one (not even the owner) can burn on demand.
    const names = aitt.interface.fragments.map((f) => f.name);
    expect(names).to.not.include("mint");
    expect(names).to.not.include("burn");
    await expect(aitt.transfer(ethers.ZeroAddress, 1n))
      .to.be.revertedWithCustomError(aitt, "ERC20InvalidReceiver")
      .withArgs(ethers.ZeroAddress);
  });

  it("supports untaxed wallet-to-wallet transfers (0% fee before AND after pair is set)", async function () {
    await aitt.setAmmPair(pair.address);
    await aitt.transfer(alice.address, 1_000_000_000n);
    expect(await aitt.balanceOf(alice.address)).to.equal(1_000_000_000n);
    await aitt.connect(alice).transfer(bob.address, 500_000_000n);
    expect(await aitt.balanceOf(bob.address)).to.equal(500_000_000n);
    expect(await aitt.totalSupply()).to.equal(SUPPLY); // no burn on wallet moves
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

describe("AITT swap tax (TOKENOMICS.md v1.4)", function () {
  let aitt, owner, alice, bob, treasury, stakersPool, pair;

  beforeEach(async function () {
    [owner, alice, bob, treasury, stakersPool, pair] = await ethers.getSigners();
    const AITT = await ethers.getContractFactory("AITT");
    aitt = await AITT.deploy(owner.address, treasury.address, stakersPool.address);
    await aitt.waitForDeployment();
  });

  it("charges NO tax before the pair is set", async function () {
    await aitt.transfer(pair.address, 1_000_000_000n);
    expect(await aitt.balanceOf(pair.address)).to.equal(1_000_000_000n);
    expect(await aitt.totalSupply()).to.equal(SUPPLY);
  });

  it("setAmmPair is owner-only, one-time, and rejects the zero address", async function () {
    await expect(aitt.connect(alice).setAmmPair(pair.address)).to.be.revertedWithCustomError(
      aitt,
      "OwnableUnauthorizedAccount"
    );
    await expect(aitt.setAmmPair(ethers.ZeroAddress)).to.be.revertedWith("AITT: zero pair");
    await aitt.setAmmPair(pair.address);
    await expect(aitt.setAmmPair(bob.address)).to.be.revertedWith("AITT: pair already set");
    expect(await aitt.ammPair()).to.equal(pair.address);
  });

  it("sell (user→pair): pair receives 97%, burn 1.8%, stakers 0.8%, treasury 0.4%", async function () {
    await aitt.setAmmPair(pair.address);
    const V = 1_000_000_000n; // 10 AITT
    const burn = (V * BURN_BPS) / BPS;
    const stakersShare = (V * STAKERS_BPS) / BPS;
    const treasuryShare = (V * TREASURY_BPS) / BPS;

    await aitt.transfer(pair.address, V);

    expect(await aitt.balanceOf(pair.address)).to.equal(V - burn - stakersShare - treasuryShare);
    expect(await aitt.balanceOf(stakersPool.address)).to.equal(stakersShare);
    expect(await aitt.balanceOf(treasury.address)).to.equal(treasuryShare);
    expect(await aitt.totalSupply()).to.equal(SUPPLY - burn); // supply decreased by the burn
  });

  it("buy (pair→user): user receives 97% of the pair's transfer", async function () {
    await aitt.setAmmPair(pair.address);
    const V = 1_000_000_000n;
    await aitt.transfer(pair.address, V); // fund the pair (sell/LP-add direction, taxed)
    const pairBalance = await aitt.balanceOf(pair.address);

    const sellValue = 500_000_000n;
    const burn = (sellValue * BURN_BPS) / BPS;
    const stakersShare = (sellValue * STAKERS_BPS) / BPS;
    const treasuryShare = (sellValue * TREASURY_BPS) / BPS;

    await aitt.connect(pair).transfer(alice.address, sellValue);

    expect(await aitt.balanceOf(alice.address)).to.equal(sellValue - burn - stakersShare - treasuryShare);
    expect(await aitt.balanceOf(pair.address)).to.equal(pairBalance - sellValue);
    expect(await aitt.totalSupply()).to.equal(SUPPLY - (V * BURN_BPS) / BPS - burn);
  });

  it("rounding: dust stays with the recipient — no value is ever lost", async function () {
    await aitt.setAmmPair(pair.address);
    // 1 base unit: every share rounds to 0 — the full unit passes through.
    await aitt.transfer(pair.address, 1n);
    expect(await aitt.balanceOf(pair.address)).to.equal(1n);
    expect(await aitt.totalSupply()).to.equal(SUPPLY);
    // Awkward remainder: shares truncate, recipient keeps the difference.
    const V = 9999n;
    const burn = (V * BURN_BPS) / BPS;
    const stakersShare = (V * STAKERS_BPS) / BPS;
    const treasuryShare = (V * TREASURY_BPS) / BPS;
    await aitt.transfer(pair.address, V);
    expect(await aitt.balanceOf(pair.address)).to.equal(1n + V - burn - stakersShare - treasuryShare);
    // Burn + fees + recipient always sum to the transferred value.
    const supplyAfter = SUPPLY - burn;
    expect(await aitt.totalSupply()).to.equal(supplyAfter);
  });

  it("LP add/remove also touch the pair and are taxed (documented standard behavior)", async function () {
    await aitt.setAmmPair(pair.address);
    const V = 1_000_000_000n;
    await aitt.transfer(pair.address, V);
    // Remove liquidity direction (pair→user) is the same as a sell.
    const pb = await aitt.balanceOf(pair.address);
    await aitt.connect(pair).transfer(owner.address, pb);
    expect(await aitt.totalSupply()).to.be.lt(SUPPLY);
  });

  it("enforces the 800M supply floor — never burns below it; excess redirects 70/30", async function () {
    await aitt.setAmmPair(pair.address);

    // Circulate the full supply through the pair until the floor is reached.
    for (let i = 0; i < 60; i++) {
      const ob = await aitt.balanceOf(owner.address);
      if (ob > 0n) await aitt.connect(owner).transfer(pair.address, ob);
      const pb = await aitt.balanceOf(pair.address);
      if (pb > 0n) await aitt.connect(pair).transfer(owner.address, pb);
      const s = await aitt.totalSupply();
      expect(s).to.be.gte(FLOOR); // never below the floor, at any step
      if (s <= FLOOR) break;
    }
    expect(await aitt.totalSupply()).to.equal(FLOOR);

    // At the floor: further pair transfers burn nothing; the 1.8% share
    // redirects to stakers (70%) and treasury (30%).
    const stakersBefore = await aitt.balanceOf(stakersPool.address);
    const treasuryBefore = await aitt.balanceOf(treasury.address);
    const V = 1_000_000_000n;
    await aitt.transfer(pair.address, V);
    expect(await aitt.totalSupply()).to.equal(FLOOR); // zero burn at floor
    expect(await aitt.balanceOf(stakersPool.address)).to.be.gt(stakersBefore);
    expect(await aitt.balanceOf(treasury.address)).to.be.gt(treasuryBefore);

    // Redirect split is exactly 70/30 of the would-be burn share, ON TOP of
    // the regular stakers (0.8%) and treasury (0.4%) shares.
    const burnShare = (V * BURN_BPS) / BPS;
    const stakersGain = (await aitt.balanceOf(stakersPool.address)) - stakersBefore;
    const treasuryGain = (await aitt.balanceOf(treasury.address)) - treasuryBefore;
    expect(stakersGain).to.equal((V * STAKERS_BPS) / BPS + (burnShare * 70n) / 100n);
    expect(treasuryGain).to.equal((V * TREASURY_BPS) / BPS + (burnShare - (burnShare * 70n) / 100n));
  });
});
