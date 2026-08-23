// Submit a deterministic owner-reviewed points snapshot to PointsConverter.
// Input JSON: {"claims":[{"claimId":"...","address":"0x...","points":123}]}
// Required env: AITT_CLAIMS_FILE. Converter address from CONVERTER_ADDRESS or deploy config.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { buildApprovalBatch, serializeApprovalClaims } = require("./claim-snapshot-lib");

async function main() {
  if (network.config.chainId !== 182 && network.name !== "hardhat" && network.name !== "localhost") throw new Error(`wrong chain ${network.config.chainId}`);
  const inputPath = process.env.AITT_CLAIMS_FILE;
  if (!inputPath || !fs.existsSync(inputPath)) throw new Error("AITT_CLAIMS_FILE is required");
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deploy.config.json"), "utf8"));
  const converterAddress = process.env.CONVERTER_ADDRESS || cfg.contracts?.pointsConverter;
  if (!converterAddress || !ethers.isAddress(converterAddress)) throw new Error("valid converter address required");
  const converter = await ethers.getContractAt("PointsConverter", converterAddress);
  const reserve = await converter.reserve();
  const enriched = await Promise.all(input.claims.map(async (claim) => ({
    ...claim,
    approvedBaseUnits: await converter.approved(claim.address),
    claimedBaseUnits: await converter.claimed(claim.address),
  })));
  const batch = buildApprovalBatch(enriched, reserve);
  console.log(`claims: ${batch.claims.length}; total: ${batch.total / 10n ** 8n} AITT; network: ${network.name}`);
  if (process.env.CONFIRM_AITT_APPROVAL !== `APPROVE ${batch.claims.length} CLAIMS`) {
    throw new Error(`set CONFIRM_AITT_APPROVAL='APPROVE ${batch.claims.length} CLAIMS' after reviewing the snapshot`);
  }
  const tx = await converter.approveClaims(batch.users, batch.amounts);
  const receipt = await tx.wait();
  const manifest = {
    generatedAt: new Date().toISOString(), network: network.name, chainId: network.config.chainId,
    converterAddress, approvalTxHash: receipt.hash, approvalBlock: receipt.blockNumber,
    totalBaseUnits: batch.total.toString(), claims: serializeApprovalClaims(batch.claims),
  };
  const output = process.env.AITT_APPROVAL_MANIFEST || `${inputPath}.approved.json`;
  fs.writeFileSync(output, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  console.log(`approval manifest: ${output}`);
}

main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
