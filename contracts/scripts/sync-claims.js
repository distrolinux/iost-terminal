// Submit a deterministic owner-reviewed points snapshot to PointsConverter.
// Input JSON: {"claims":[{"claimId":"...","address":"0x...","points":123}]}
// Required env: AITT_CLAIMS_FILE. Converter address from CONVERTER_ADDRESS or deploy config.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers, network } = require("hardhat");
const { buildApprovalBatch, serializeApprovalClaims, chunkApprovalBatch } = require("./claim-snapshot-lib");

async function main() {
  if (network.config.chainId !== 182 && network.name !== "hardhat" && network.name !== "localhost") throw new Error(`wrong chain ${network.config.chainId}`);
  const inputPath = process.env.AITT_CLAIMS_FILE;
  if (!inputPath || !fs.existsSync(inputPath)) throw new Error("AITT_CLAIMS_FILE is required");
  const inputBytes = fs.readFileSync(inputPath);
  const input = JSON.parse(inputBytes.toString("utf8"));
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
  const chunks = chunkApprovalBatch(batch, process.env.AITT_APPROVAL_CHUNK_SIZE || 100);
  const output = process.env.AITT_APPROVAL_MANIFEST || `${inputPath}.approved.json`;
  const manifest = {
    status: "in_progress", generatedAt: new Date().toISOString(), network: network.name, chainId: network.config.chainId,
    converterAddress, snapshotHash: `0x${crypto.createHash("sha256").update(inputBytes).digest("hex")}`,
    approvals: [], totalBaseUnits: batch.total.toString(), claims: serializeApprovalClaims(batch.claims),
  };
  const writeManifest = () => {
    const tmp = `${output}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, output);
  };
  writeManifest();
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const tx = await converter.approveClaims(chunk.users, chunk.amounts);
    const receipt = await tx.wait();
    manifest.approvals.push({ index: i, claims: chunk.claims.length, txHash: receipt.hash, blockNumber: receipt.blockNumber });
    writeManifest();
    console.log(`approved chunk ${i + 1}/${chunks.length}: ${chunk.claims.length} claims; tx ${receipt.hash}`);
  }
  manifest.status = "completed";
  manifest.completedAt = new Date().toISOString();
  writeManifest();
  console.log(`approval manifest: ${output}`);
}

main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
