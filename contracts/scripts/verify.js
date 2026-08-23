// Fail-closed post-deploy verification for AITT and every custody contract.
// Usage: npx hardhat run scripts/verify.js --network iostL2
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { verifyDeployment } = require("./verify-lib");

async function main() {
  const configPath = path.join(__dirname, "..", "deploy.config.json");
  if (!fs.existsSync(configPath)) throw new Error("deploy.config.json not found");
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const [signer] = await ethers.getSigners();
  const result = await verifyDeployment(cfg, signer.address, { allowLocalChain: network.name === "hardhat" || network.name === "localhost" });
  console.log(`AITT verification PASS — ${result.checks} exact invariants on chain ${result.chainId}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
