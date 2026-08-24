const { expect } = require("chai");
const { ethers } = require("hardhat");

const RECEIPT_TX = ethers.keccak256(ethers.toUtf8Bytes("approved-bootstrap-receipt"));
const OPERATION_ID = ethers.keccak256(ethers.toUtf8Bytes("approved-bootstrap-operation"));
const RECEIPT_LOG_INDEX = 0n;
function receiptCommitment(pair, txHash = RECEIPT_TX, logIndex = RECEIPT_LOG_INDEX, operationId = OPERATION_ID) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "bytes32", "uint256", "bytes32", "bytes32"], [pair, txHash, logIndex, operationId, ethers.keccak256(ethers.toUtf8Bytes("BootstrapVerified(address,bytes32,uint256,uint256,bytes32,bytes32)"))]));
}

describe("Phase 4 local PancakeSwap and LP custody harness", function () {
  async function fixture({ reserve0 = 1000n, reserve1 = 2000n, wrapperDecimals = 8, quoteDecimals = 18, expectedWrapperDecimals = wrapperDecimals, expectedQuoteDecimals = quoteDecimals } = {}) {
    const [owner, other] = await ethers.getSigners();
    const factory = await (await ethers.getContractFactory("Phase4MockFactory")).deploy();
    const router = await (await ethers.getContractFactory("Phase4MockRouter")).deploy(factory.target);
    const Token = await ethers.getContractFactory("Phase4MockDecimalsToken");
    const wrapper = await Token.deploy(wrapperDecimals); const quote = await Token.deploy(quoteDecimals);
    const Custody = await ethers.getContractFactory("Phase4MockCustody");
    const multisig = await Custody.deploy(); const lock = await Custody.deploy();
    const pair = await (await ethers.getContractFactory("Phase4MockPair")).deploy(wrapper.target, quote.target, reserve0, reserve1);
    await factory.setPair(wrapper.target, quote.target, pair.target);
    const pairCodeHash = ethers.keccak256(await ethers.provider.getCode(pair.target));
    const approvedEvidence = receiptCommitment(pair.target);
    const harness = await (await ethers.getContractFactory("Phase4DexHarness")).deploy(factory.target, router.target, wrapper.target, quote.target, multisig.target, lock.target, expectedWrapperDecimals, expectedQuoteDecimals, 1n, 10_000n, owner.address);
    await harness.configureApprovedEvidence(pairCodeHash, approvedEvidence);
    return { owner, other, factory, router, wrapper, quote, multisig, lock, pair, harness, pairCodeHash };
  }
  async function verifyPair(ctx) { await ctx.harness.verifyRouterFactory(ctx.router.target); await ctx.harness.verifyPair(ctx.pair.target); }
  async function approveEvidence(ctx, overrides = {}) {
    const block = await ethers.provider.getBlock("latest");
    return ctx.harness.approveBootstrapEvidence(ctx.pair.target, RECEIPT_TX, RECEIPT_LOG_INDEX, OPERATION_ID, block.number, block.hash, overrides);
  }

  it("accepts only the exact approved factory and router identity", async function () {
    const ctx = await fixture();
    await expect(ctx.harness.verifyRouterFactory(ctx.router.target)).to.emit(ctx.harness, "DexVerified").withArgs(ctx.factory.target, ctx.router.target);
  });
  it("binds pair verification to immutable approved code evidence", async function () {
    const ctx = await fixture(); await verifyPair(ctx);
    expect(await ctx.harness.verifiedPair()).to.equal(ctx.pair.target);
    expect(await ctx.harness.approvedPairCodeHash()).to.equal(ctx.pairCodeHash);
    const otherPair = await (await ethers.getContractFactory("Phase4MockPair")).deploy(ctx.wrapper.target, ctx.quote.target, 1000n, 2000n);
    await expect(ctx.harness.verifyPair(otherPair.target)).to.be.revertedWith("pair-already-verified");
  });
  it("rejects a second pair verification without rebinding the verified pair", async function () {
    const ctx = await fixture(); await verifyPair(ctx);
    const verifiedPair = await ctx.harness.verifiedPair();
    const verifiedPairCodeHash = await ctx.harness.verifiedPairCodeHash();
    await expect(ctx.harness.verifyPair(ctx.pair.target)).to.be.revertedWith("pair-already-verified");
    expect(await ctx.harness.pairVerified()).to.equal(true);
    expect(await ctx.harness.verifiedPair()).to.equal(verifiedPair);
    expect(await ctx.harness.verifiedPairCodeHash()).to.equal(verifiedPairCodeHash);
  });
  it("fails closed on router, decimals, and reserve mismatches", async function () {
    const ctx = await fixture({ reserve0: 0n });
    await expect(ctx.harness.connect(ctx.other).verifyRouterFactory(ctx.router.target)).to.be.revertedWith("not-approved-verifier");
    await ctx.harness.verifyRouterFactory(ctx.router.target);
    await expect(ctx.harness.verifyPair(ctx.pair.target)).to.be.revertedWith("reserve-out-of-bounds");
    const decimalCtx = await fixture({ wrapperDecimals: 6, expectedWrapperDecimals: 8 });
    await decimalCtx.harness.verifyRouterFactory(decimalCtx.router.target);
    await expect(decimalCtx.harness.verifyPair(decimalCtx.pair.target)).to.be.revertedWith("wrapper-decimals-mismatch");
  });
  it("requires pair verification and approved current receipt evidence before bootstrap amounts", async function () {
    const ctx = await fixture(); await ctx.harness.verifyRouterFactory(ctx.router.target);
    const latest = await ethers.provider.getBlock("latest");
    await expect(ctx.harness.approveBootstrapEvidence(ctx.pair.target, RECEIPT_TX, RECEIPT_LOG_INDEX, OPERATION_ID, latest.number, latest.hash)).to.be.revertedWith("pair-not-verified");
    await verifyPair(ctx);
    const current = await ethers.provider.getBlock("latest");
    await expect(ctx.harness.approveBootstrapEvidence(ctx.pair.target, ethers.ZeroHash, RECEIPT_LOG_INDEX, OPERATION_ID, current.number, current.hash)).to.be.revertedWith("bootstrap-evidence-mismatch");
    await approveEvidence(ctx);
    await expect(ctx.harness.verifyBootstrapAmounts(100n, 200n, 50n, 10_001, 10n ** 18n)).to.be.revertedWith("invalid-slippage");
  });
  it("rejects unauthorized flag promotion and requires bootstrap before custody", async function () {
    const ctx = await fixture();
    await expect(ctx.harness.connect(ctx.other).verifyRouterFactory(ctx.router.target)).to.be.revertedWith("not-approved-verifier");
    await verifyPair(ctx);
    await expect(ctx.harness.connect(ctx.other).approveBootstrapEvidence(ctx.pair.target, RECEIPT_TX, RECEIPT_LOG_INDEX, OPERATION_ID, 0, ethers.ZeroHash)).to.be.revertedWith("not-approved-verifier");
    await expect(ctx.harness.verifyCustody(ctx.pair.target, ctx.multisig.target, 1000000000000n)).to.be.revertedWith("bootstrap-not-verified");
  });
  it("locks approved evidence configuration to the approved verifier", async function () {
    const ctx = await fixture();
    await expect(ctx.harness.connect(ctx.other).configureApprovedEvidence(ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWith("not-approved-verifier");
    await expect(ctx.harness.configureApprovedEvidence(ctx.pairCodeHash, ethers.ZeroHash)).to.be.revertedWith("evidence-already-configured");
  });
  it("persists bootstrap evidence and accepts custody only for the verified pair", async function () {
    const ctx = await fixture();
    await verifyPair(ctx);
    await approveEvidence(ctx);
    await expect(ctx.harness.verifyBootstrapAmounts(100n, 200n, 50n, 100, 10n ** 18n)).to.emit(ctx.harness, "BootstrapVerified");
    expect(await ctx.harness.bootstrapEvidenceCommitment()).to.not.equal(ethers.ZeroHash);
    await expect(ctx.harness.verifyCustody(ctx.quote.target, ctx.multisig.target, 10n ** 18n)).to.be.revertedWith("lp-pair-identity-mismatch");
    await ctx.pair.seed(ctx.multisig.target, 50n);
    await expect(ctx.harness.verifyCustody(ctx.pair.target, ctx.multisig.target, 10n ** 18n)).to.emit(ctx.harness, "CustodyVerified");
  });
});
