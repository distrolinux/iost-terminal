// Submit or safely resume a deterministic owner-reviewed PointsConverter snapshot.
// Input JSON: {"claims":[{"claimId":"...","address":"0x...","points":123}]}
// Required env: AITT_CLAIMS_FILE. Converter address from CONVERTER_ADDRESS or deploy config.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers, network } = require("hardhat");
const { buildApprovalBatch, serializeApprovalClaims, chunkApprovalBatch, planApprovalResume } = require("./claim-snapshot-lib");

const UNIT = 10n ** 8n;

async function main() {
  if (network.config.chainId !== 182 && network.name !== "hardhat" && network.name !== "localhost") throw new Error(`wrong chain ${network.config.chainId}`);
  const inputPath = process.env.AITT_CLAIMS_FILE;
  if (!inputPath || !fs.existsSync(inputPath)) throw new Error("AITT_CLAIMS_FILE is required");
  const inputBytes = fs.readFileSync(inputPath);
  const input = JSON.parse(inputBytes.toString("utf8"));
  if (!Array.isArray(input.claims) || input.claims.length === 0) throw new Error("non-empty claims array required");
  const snapshotHash = `0x${crypto.createHash("sha256").update(inputBytes).digest("hex")}`;
  const output = process.env.AITT_APPROVAL_MANIFEST || `${inputPath}.approved.json`;

  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deploy.config.json"), "utf8"));
  const converterAddress = ethers.getAddress(process.env.CONVERTER_ADDRESS || cfg.contracts?.pointsConverter || "");
  const converter = await ethers.getContractAt("PointsConverter", converterAddress);
  const reserve = await converter.reserve();

  let manifest = null;
  if (fs.existsSync(output)) {
    manifest = JSON.parse(fs.readFileSync(output, "utf8"));
    if (manifest.snapshotHash !== snapshotHash || ethers.getAddress(manifest.converterAddress) !== converterAddress) {
      throw new Error("existing approval manifest does not match snapshot/converter");
    }
    if (manifest.status === "completed") throw new Error("approval snapshot already completed");
    for (const approval of manifest.approvals || []) {
      if (approval.status !== "submitted") continue;
      const receipt = await ethers.provider.getTransactionReceipt(approval.txHash);
      if (!receipt) throw new Error(`approval transaction still pending: ${approval.txHash}`);
      if (Number(receipt.status) !== 1) throw new Error(`approval transaction failed: ${approval.txHash}`);
      approval.status = "confirmed";
      approval.blockNumber = receipt.blockNumber;
      approval.confirmedAt = new Date().toISOString();
    }
  }

  const enriched = await Promise.all(input.claims.map(async (claim) => ({
    ...claim,
    approvedBaseUnits: await converter.approved(claim.address),
    claimedBaseUnits: await converter.claimed(claim.address),
  })));
  // Build the canonical full snapshot independently of current approvals.
  const canonicalRows = enriched.map((claim) => ({ ...claim, approvedBaseUnits: claim.claimedBaseUnits }));
  const fullBatch = buildApprovalBatch(canonicalRows, reserve);
  const confirmedIds = new Set((manifest?.approvals || [])
    .filter((approval) => approval.status === "confirmed")
    .flatMap((approval) => approval.claimIds || []));
  const { existingOutstanding, pendingRows } = planApprovalResume(enriched, fullBatch, confirmedIds, reserve);
  const pendingBatch = pendingRows.length ? buildApprovalBatch(pendingRows, reserve - existingOutstanding) : { claims: [], users: [], amounts: [], total: 0n };

  console.log(`snapshot claims: ${fullBatch.claims.length}; pending: ${pendingBatch.claims.length}; total: ${fullBatch.total / UNIT} AITT; network: ${network.name}`);
  if (process.env.CONFIRM_AITT_APPROVAL !== `APPROVE ${fullBatch.claims.length} CLAIMS`) {
    throw new Error(`set CONFIRM_AITT_APPROVAL='APPROVE ${fullBatch.claims.length} CLAIMS' after reviewing the snapshot`);
  }

  if (!manifest) {
    manifest = {
      status: "in_progress", generatedAt: new Date().toISOString(), network: network.name, chainId: network.config.chainId,
      converterAddress, snapshotHash, approvals: [], totalBaseUnits: fullBatch.total.toString(),
      claims: serializeApprovalClaims(fullBatch.claims),
    };
  }
  const writeManifest = () => {
    const tmp = `${output}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, output);
  };
  writeManifest();

  const chunks = chunkApprovalBatch(pendingBatch, process.env.AITT_APPROVAL_CHUNK_SIZE || 100);
  for (const chunk of chunks) {
    const tx = await converter.approveClaims(chunk.users, chunk.amounts);
    const approval = {
      index: manifest.approvals.length, claims: chunk.claims.length,
      claimIds: chunk.claims.map((claim) => claim.claimId), txHash: tx.hash,
      status: "submitted", submittedAt: new Date().toISOString(),
    };
    manifest.approvals.push(approval);
    writeManifest();
    const receipt = await tx.wait();
    approval.status = "confirmed";
    approval.blockNumber = receipt.blockNumber;
    approval.confirmedAt = new Date().toISOString();
    writeManifest();
    console.log(`approved chunk ${approval.index + 1}: ${chunk.claims.length} claims; tx ${receipt.hash}`);
  }

  manifest.status = "completed";
  manifest.completedAt = new Date().toISOString();
  writeManifest();
  console.log(`approval manifest: ${output}`);
}

main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
