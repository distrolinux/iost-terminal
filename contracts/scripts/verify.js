// Post-deploy verification: reads live balances/params from the chain and
// checks them against the locked allocation plan (TOKENOMICS.md §3).
// Usage: npx hardhat run scripts/verify.js --network iostL2

const { ethers } = require("hardhat");

const TOKEN = 10n ** 8n;
const EXPECTED = {
  "AITT (token)": null,
};

async function main() {
  const [deployer] = await ethers.getSigners();
  // Addresses come from deploy.config.json (fill after deploy).
  let cfg;
  try {
    cfg = JSON.parse(require("fs").readFileSync("deploy.config.json", "utf8"));
  } catch {
    cfg = { allocations: {} };
  }
  const A = cfg.allocations;

  const AITT = await ethers.getContractFactory("AITT");
  const aitt = AITT.attach(process.env.AITT_ADDRESS || "0x0000000000000000000000000000000000000000");

  if (process.env.AITT_ADDRESS) {
    console.log(`\n=== Live verification of AITT @ ${process.env.AITT_ADDRESS} ===\n`);
    console.log(`name: ${await aitt.name()}`);
    console.log(`symbol: ${await aitt.symbol()}`);
    console.log(`decimals: ${await aitt.decimals()}`);
    console.log(`totalSupply: ${(await aitt.totalSupply()) / TOKEN} AITT (expect 1,000,000,000)\n`);

    const checks = [
      ["ecosystem pool (30%)", A.ecosystemPool, 300_000_000n - (BigInt(cfg.pointsConversionReserve || "0") / TOKEN)],
      ["treasury (20%)", A.treasury, 200_000_000n],
      ["team vesting (15%)", A.teamVesting, 150_000_000n],
      ["partners (10%)", A.partners, 100_000_000n],
      ["community (10%)", A.community, 100_000_000n],
      ["reserve (10%)", A.reserve, 100_000_000n],
      ["advisor vesting (5%)", A.advisorVesting, 50_000_000n],
    ];
    for (const [label, addr, want] of checks) {
      if (!addr || addr === ethers.ZeroAddress) {
        console.log(`${label.padEnd(20)} skipped (address not in deploy.config.json)`);
        continue;
      }
      const bal = (await aitt.balanceOf(addr)) / TOKEN;
      const ok = bal === want ? "OK" : `MISMATCH (want ${want})`;
      console.log(`${label.padEnd(20)} ${bal} AITT  ${ok}`);
    }
    const held = (await aitt.balanceOf(deployer.address)) / TOKEN;
    console.log(`deployer leftover  ${held} AITT`);
  } else {
    console.log("Set AITT_ADDRESS=0x... to verify the live token (export AITT_ADDRESS first).");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
