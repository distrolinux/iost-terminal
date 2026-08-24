const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Phase 4 local BSC PancakeSwap v2 readiness constants", function () {
  it("pins the exact BSC chain, factory, and router identities", async function () {
    const readiness = await (await ethers.getContractFactory("Phase4PancakeV2BscReadiness")).deploy();

    expect(await readiness.BSC_CHAIN_ID()).to.equal(56n);
    expect(await readiness.PANCAKE_V2_FACTORY()).to.equal("0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73");
    expect(await readiness.PANCAKE_V2_ROUTER()).to.equal("0x10ED43C718714eb63d5aA57B78B54704E256024E");
  });
});
