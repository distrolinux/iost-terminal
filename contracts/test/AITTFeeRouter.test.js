const { expect } = require("chai");
const { ethers } = require("hardhat");

const TOKEN = 10n ** 8n;
const B = (n) => BigInt(n) * TOKEN;
const SUPPLY = B(1_000_000_000);
const FLOOR = B(800_000_000);

describe("AITT authoritative burn router", function () {
  let token, router, owner, alice, treasury, stakers, pair;

  beforeEach(async function () {
    [owner, alice, treasury, stakers, pair] = await ethers.getSigners();
    const AITT = await ethers.getContractFactory("AITT");
    token = await AITT.deploy(owner.address, treasury.address, stakers.address);
    await token.waitForDeployment();

    const Router = await ethers.getContractFactory("AITTFeeRouter");
    router = await Router.deploy(await token.getAddress(), owner.address);
    await router.waitForDeployment();
    await token.setFeeRouter(await router.getAddress());
    await token.approve(await router.getAddress(), SUPPLY);
  });

  it("locks one fee router and rejects every other protocol-burn caller", async function () {
    expect(await token.feeRouter()).to.equal(await router.getAddress());
    await expect(token.setFeeRouter(alice.address)).to.be.revertedWith("AITT: fee router already set");
    await expect(token.connect(alice).protocolBurn(1n)).to.be.revertedWith("AITT: fee router only");

    const AITT = await ethers.getContractFactory("AITT");
    const fresh = await AITT.deploy(owner.address, treasury.address, stakers.address);
    await fresh.waitForDeployment();
    await expect(fresh.setFeeRouter(alice.address)).to.be.revertedWith("AITT: fee router has no code");

    const wrongToken = await AITT.deploy(owner.address, treasury.address, stakers.address);
    await wrongToken.waitForDeployment();
    const Router = await ethers.getContractFactory("AITTFeeRouter");
    const wrongRouter = await Router.deploy(await wrongToken.getAddress(), owner.address);
    await wrongRouter.waitForDeployment();
    await expect(fresh.setFeeRouter(await wrongRouter.getAddress())).to.be.revertedWith("AITT: router token mismatch");
  });

  it("routes platform fees 50/20/30 before the floor", async function () {
    const amount = B(100);
    const supplyBefore = await token.totalSupply();
    await router.payPlatformFee(amount);
    expect(await token.balanceOf(stakers.address)).to.equal(B(50));
    expect(await token.balanceOf(treasury.address)).to.equal(B(30));
    expect(await token.totalSupply()).to.equal(supplyBefore - B(20));
    expect(await token.balanceOf(await router.getAddress())).to.equal(0n);
  });

  it("derives canonical recipients and preserves aggregate split under fragmentation", async function () {
    expect(await router.treasury()).to.equal(treasury.address);
    expect(await router.stakersPool()).to.equal(stakers.address);
    const supplyBefore = await token.totalSupply();
    for (let i = 0; i < 100; i++) await router.payPlatformFee(1n);
    expect(await token.balanceOf(stakers.address)).to.equal(50n);
    expect(await token.balanceOf(treasury.address)).to.equal(30n);
    expect(await token.totalSupply()).to.equal(supplyBefore - 20n);
    expect(await token.balanceOf(await router.getAddress())).to.equal(0n);
  });

  it("processes direct AITT transfers instead of trapping them", async function () {
    await router.payPlatformFee(1n);
    await expect(router.processHeldPlatformFee(1n)).to.be.revertedWithCustomError(router, "TransferAmountMismatch");
    await token.transfer(await router.getAddress(), B(100));
    await router.processHeldPlatformFee(B(100));
    expect(await token.balanceOf(stakers.address)).to.equal(B(50));
    expect(await token.balanceOf(treasury.address)).to.equal(B(30));
    expect(await token.balanceOf(await router.getAddress())).to.equal(1n);
    expect(await router.platformFeePending()).to.equal(1n);
  });

  it("uses the same floor for DAO burns and redirects excess 70/30", async function () {
    await router.executeDaoBurn(B(200_000_000));
    expect(await token.totalSupply()).to.equal(FLOOR);

    const stakersBefore = await token.balanceOf(stakers.address);
    const treasuryBefore = await token.balanceOf(treasury.address);
    await router.payPlatformFee(B(100));

    // Base split 50/30 plus the unburnable 20 redirected 70/30.
    expect((await token.balanceOf(stakers.address)) - stakersBefore).to.equal(B(64));
    expect((await token.balanceOf(treasury.address)) - treasuryBefore).to.equal(B(36));
    expect(await token.totalSupply()).to.equal(FLOOR);
  });

  it("shares burn headroom between protocol burns and swap-tax burns", async function () {
    await router.executeDaoBurn(B(199_999_990));
    expect(await token.totalSupply()).to.equal(FLOOR + B(10));

    await token.setAmmPair(pair.address);
    await token.transfer(pair.address, B(1_000));
    expect(await token.totalSupply()).to.equal(FLOOR);

    // The swap's requested burn above the remaining 10 is redirected, not burned.
    expect(await token.totalSupply()).to.equal(FLOOR);
  });

  it("allows only the router owner to submit DAO-held burns", async function () {
    await token.transfer(alice.address, B(10));
    await token.connect(alice).approve(await router.getAddress(), B(10));
    await expect(router.connect(alice).executeDaoBurn(B(10))).to.be.revertedWithCustomError(router, "OwnableUnauthorizedAccount");
  });
});
