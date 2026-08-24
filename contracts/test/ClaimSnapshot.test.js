const { expect } = require("chai");
const { ethers } = require("hardhat");
const { buildApprovalBatch, serializeApprovalClaims, chunkApprovalBatch } = require("../scripts/claim-snapshot-lib");
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const TOKEN = 10n ** 8n;
const row = (claimId, address, points, approvedBaseUnits = 0n, claimedBaseUnits = 0n) => ({ claimId, address, points, approvedBaseUnits, claimedBaseUnits });

describe("AITT claim snapshot builder", function () {
  it("converts whole points to exact 8-decimal base units deterministically", async function () {
    const [, alice, bob] = await ethers.getSigners();
    const batch = buildApprovalBatch([row("c2", bob.address, 6), row("c1", alice.address, 4)], 10n * TOKEN);
    expect(batch.users).to.deep.equal([alice.address, bob.address]);
    expect(batch.amounts.reduce((a, b) => a + b, 0n)).to.equal(10n * TOKEN);
    expect(batch.claims.map((c) => c.claimId)).to.deep.equal(["c1", "c2"]);
    const scratch = mkdtempSync(join(tmpdir(), "aitt-approval-manifest-"));
    try {
      const path = join(scratch, "approved.json");
      const manifest = { approvalTxHash: `0x${'a'.repeat(64)}`, claims: serializeApprovalClaims(batch.claims) };
      writeFileSync(path, JSON.stringify(manifest, null, 2));
      expect(JSON.parse(readFileSync(path, "utf8")).claims[0].deltaBaseUnits).to.equal((4n * TOKEN).toString());
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });

  it("builds repeat claims cumulatively and rejects outstanding prior approvals", async function () {
    const [, alice] = await ethers.getSigners();
    const batch = buildApprovalBatch([row("second", alice.address, 5, 10n * TOKEN, 10n * TOKEN)], 100n * TOKEN);
    expect(batch.amounts[0]).to.equal(15n * TOKEN);
    expect(batch.claims[0].deltaBaseUnits).to.equal(5n * TOKEN);
    expect(() => buildApprovalBatch([row("blocked", alice.address, 5, 12n * TOKEN, 10n * TOKEN)], 100n * TOKEN)).to.throw("outstanding prior approval");
  });

  it("rejects duplicate addresses, invalid points and reserve overcommit", async function () {
    const [, alice] = await ethers.getSigners();
    expect(() => buildApprovalBatch([row("a", alice.address, 1), row("b", alice.address, 1)], 10n * TOKEN)).to.throw("duplicate address");
    expect(() => buildApprovalBatch([row("a", alice.address, 1.5)], 10n * TOKEN)).to.throw("positive whole points");
    expect(() => buildApprovalBatch([row("a", alice.address, 11)], 10n * TOKEN)).to.throw("exceeds converter reserve");
  });

  it("chunks large approval snapshots into bounded transactions", async function () {
    const [, alice, bob, carol] = await ethers.getSigners();
    const batch = buildApprovalBatch([
      row("a", alice.address, 1), row("b", bob.address, 1), row("c", carol.address, 1),
    ], 3n * TOKEN);
    const chunks = chunkApprovalBatch(batch, 2);
    expect(chunks.map((chunk) => chunk.claims.length)).to.deep.equal([2, 1]);
    expect(chunks.flatMap((chunk) => chunk.users)).to.deep.equal(batch.users);
    expect(() => chunkApprovalBatch(batch, 251)).to.throw("chunk size");
  });
});
