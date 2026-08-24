const { getAddress, Interface } = require("ethers");
const APPROVAL_EVENTS = new Interface(["event Approved(address indexed user,uint256 amount)"]);

const TOKEN = 10n ** 8n;

function buildApprovalBatch(rows, converterReserve) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("non-empty claims array required");
  const claims = rows.map((row) => {
    const claimId = String(row.claimId || "").trim();
    if (!claimId) throw new Error("claimId required");
    const address = getAddress(String(row.address || ""));
    const points = Number(row.points);
    if (!Number.isSafeInteger(points) || points <= 0) throw new Error(`positive whole points required for ${claimId}`);
    const approvedBaseUnits = BigInt(row.approvedBaseUnits ?? 0);
    const claimedBaseUnits = BigInt(row.claimedBaseUnits ?? 0);
    if (approvedBaseUnits !== claimedBaseUnits) throw new Error(`outstanding prior approval for ${address}`);
    const deltaBaseUnits = BigInt(points) * TOKEN;
    return {
      claimId, address, points, approvedBaseUnits, claimedBaseUnits, deltaBaseUnits,
      approvalBaseUnits: claimedBaseUnits + deltaBaseUnits,
    };
  }).sort((a, b) => a.claimId.localeCompare(b.claimId));
  const addresses = new Set();
  for (const claim of claims) {
    const key = claim.address.toLowerCase();
    if (addresses.has(key)) throw new Error(`duplicate address: ${claim.address}`);
    addresses.add(key);
  }
  const newOutstanding = claims.reduce((sum, claim) => sum + claim.deltaBaseUnits, 0n);
  if (newOutstanding > BigInt(converterReserve)) throw new Error("claim batch exceeds converter reserve");
  return {
    claims,
    users: claims.map((claim) => claim.address),
    amounts: claims.map((claim) => claim.approvalBaseUnits),
    total: newOutstanding,
  };
}

function serializeApprovalClaims(claims) {
  return claims.map((claim) => ({
    claimId: claim.claimId, address: claim.address, points: claim.points,
    approvedBaseUnits: claim.approvedBaseUnits.toString(),
    claimedBaseUnits: claim.claimedBaseUnits.toString(),
    deltaBaseUnits: claim.deltaBaseUnits.toString(),
    approvalBaseUnits: claim.approvalBaseUnits.toString(),
  }));
}

function chunkApprovalBatch(batch, chunkSize = 100) {
  const size = Number(chunkSize);
  if (!Number.isSafeInteger(size) || size < 1 || size > 250) throw new Error("chunk size must be an integer from 1 to 250");
  const chunks = [];
  for (let i = 0; i < batch.claims.length; i += size) {
    chunks.push({
      claims: batch.claims.slice(i, i + size),
      users: batch.users.slice(i, i + size),
      amounts: batch.amounts.slice(i, i + size),
    });
  }
  return chunks;
}

function planApprovalResume(enrichedRows, fullBatch, confirmedClaimIds, converterReserve) {
  const expectedById = new Map(fullBatch.claims.map((claim) => [claim.claimId, claim]));
  const confirmed = new Set(confirmedClaimIds || []);
  let existingOutstanding = 0n;
  const pendingRows = [];
  for (const row of enrichedRows) {
    const expected = expectedById.get(String(row.claimId));
    if (!expected) throw new Error(`claim missing from canonical snapshot: ${row.claimId}`);
    const approved = BigInt(row.approvedBaseUnits);
    const claimed = BigInt(row.claimedBaseUnits);
    if (confirmed.has(expected.claimId)) {
      if (approved !== expected.approvalBaseUnits) throw new Error(`confirmed manifest/on-chain approval mismatch for ${expected.claimId}`);
      existingOutstanding += approved - claimed;
      continue;
    }
    if (approved === expected.approvalBaseUnits) throw new Error(`on-chain approval lacks confirmed manifest evidence for ${expected.claimId}`);
    if (approved !== claimed) throw new Error(`unexpected outstanding prior approval for ${expected.address}`);
    pendingRows.push(row);
  }
  if (existingOutstanding > BigInt(converterReserve)) throw new Error("existing approvals exceed converter reserve");
  return { existingOutstanding, pendingRows };
}

function verifyApprovalReceiptEvidence(receipt, converterAddress, claimEvidence) {
  if (!receipt || Number(receipt.status) !== 1) throw new Error("approval transaction not successful");
  if (getAddress(receipt.to) !== getAddress(converterAddress)) throw new Error("approval transaction target mismatch");
  if (!Array.isArray(claimEvidence) || claimEvidence.length === 0) throw new Error("approval claim evidence missing");
  const actual = new Map();
  for (const log of receipt.logs || []) {
    if (getAddress(log.address) !== getAddress(converterAddress)) continue;
    try {
      const parsed = APPROVAL_EVENTS.parseLog(log);
      if (parsed?.name === "Approved") actual.set(getAddress(parsed.args.user), BigInt(parsed.args.amount));
    } catch { /* unrelated converter event */ }
  }
  if (actual.size !== claimEvidence.length) throw new Error("approval event count mismatch");
  for (const claim of claimEvidence) {
    const user = getAddress(claim.address);
    if (!actual.has(user) || actual.get(user) !== BigInt(claim.approvalBaseUnits)) {
      throw new Error(`approval event evidence mismatch for ${claim.claimId}`);
    }
  }
  return true;
}

module.exports = { buildApprovalBatch, serializeApprovalClaims, chunkApprovalBatch, planApprovalResume, verifyApprovalReceiptEvidence };
