// Irreversible AMM pair lock — Phase 4 only, with factory/token validation.
// Required config: contracts.token, ammPair, ammFactory, quoteToken, phase4Enabled=true.
// Required typed gate: CONFIRM_AMM_PAIR="LOCK 0x..."
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const ZERO = ethers.ZeroAddress;
const PAIR_ABI = ["function token0() view returns(address)", "function token1() view returns(address)"];
const FACTORY_ABI = ["function getPair(address,address) view returns(address)"];

async function main() {
  if (network.config.chainId !== 182) throw new Error(`AMM lock requires IOST L2 chain 182, got ${network.config.chainId}`);
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deploy.config.json"), "utf8"));
  if (cfg.phase4Enabled !== true) throw new Error("Phase 4 is disabled; AMM pair cannot be set");
  const tokenAddress = ethers.getAddress(cfg.contracts?.token || "");
  const pairAddress = ethers.getAddress(cfg.ammPair || "");
  const factoryAddress = ethers.getAddress(cfg.ammFactory || "");
  const quoteAddress = ethers.getAddress(cfg.quoteToken || "");
  for (const [label, address] of [["token", tokenAddress], ["pair", pairAddress], ["factory", factoryAddress], ["quote", quoteAddress]]) {
    if (address === ZERO || await ethers.provider.getCode(address) === "0x") throw new Error(`${label} has no contract bytecode`);
  }

  const pair = new ethers.Contract(pairAddress, PAIR_ABI, ethers.provider);
  const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, ethers.provider);
  const token0 = ethers.getAddress(await pair.token0());
  const token1 = ethers.getAddress(await pair.token1());
  const assets = new Set([token0, token1]);
  if (!assets.has(tokenAddress) || !assets.has(quoteAddress)) throw new Error("pair token0/token1 do not match AITT + configured quote token");
  if (ethers.getAddress(await factory.getPair(tokenAddress, quoteAddress)) !== pairAddress) throw new Error("factory getPair does not match configured pair");

  const [signer] = await ethers.getSigners();
  const token = await ethers.getContractAt("AITT", tokenAddress);
  if (await token.owner() !== signer.address) throw new Error("signer is not current AITT owner/governance executor");
  if (await token.feeRouter() === ZERO) throw new Error("fee router is not locked");
  if (await token.ammPair() !== ZERO) throw new Error("AMM pair already locked");
  if (process.env.CONFIRM_AMM_PAIR !== `LOCK ${pairAddress}`) throw new Error(`set CONFIRM_AMM_PAIR='LOCK ${pairAddress}' after reviewing the irreversible pair lock`);

  const tx = await token.setAmmPair(pairAddress);
  const receipt = await tx.wait();
  if (await token.ammPair() !== pairAddress) throw new Error("pair lock verification failed");
  console.log(`AITT AMM pair locked: ${pairAddress}; tx: ${receipt.hash}`);
}

main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
