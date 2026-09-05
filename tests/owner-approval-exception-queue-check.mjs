import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'iost-owner-approvals-'));
process.env.IOST_DATA_DIR = scratch;

try {
  const approvals = await import('../lib/owner-approval-queue.js');
  const input = {
    accountId: 'private-account', requesterId: 'private-agent-key', intentId: 'approval-intent-0001',
    preflightFingerprint: 'a'.repeat(64),
    order: { symbol: 'IOST', side: 'long', size: 10, entry: 0.00058, stop: 0.00057,
      target: 0.00061, maxSlippageBps: 40, walletId: 'private-wallet', pactId: 'private-pact', missionId: 'msn_private' },
    evidence: { decision: 'allow', reasonCode: 'preflight-passed', quoteSource: 'OKX', quoteAgeMs: 250,
      estimatedFillPrice: 0.000581, estimatedTotalUsd: 0.00581, riskDecision: 'allow', dataTrustDecision: 'allow' },
  };
  const first = approvals.requestOwnerApproval(input, 1_000);
  assert.equal(first.replayed, false);
  assert.equal(first.approval.status, 'pending');
  assert.equal(first.approval.order.symbol, 'IOST');
  assert.equal(first.approval.liveScopeUsed, false);
  assert.match(first.approval.mandateDigest, /^[a-f0-9]{64}$/);
  const replay = approvals.requestOwnerApproval(input, 1_001);
  assert.equal(replay.replayed, true);
  assert.equal(replay.approval.approvalId, first.approval.approvalId);
  assert.throws(() => approvals.requestOwnerApproval({ ...input, order: { ...input.order, size: 11 } }, 1_002), /conflict/i);
  assert.equal(approvals.listOwnerApprovals('different-account', { now: 1_003 }).length, 0);
  assert.throws(() => approvals.decideOwnerApproval({ accountId: input.accountId, approvalId: first.approval.approvalId,
    decision: 'approved', expectedDigest: 'b'.repeat(64) }, 1_100), /evidence changed/i);
  const decided = approvals.decideOwnerApproval({ accountId: input.accountId, approvalId: first.approval.approvalId,
    decision: 'approved', expectedDigest: first.approval.mandateDigest }, 1_100);
  assert.equal(decided.status, 'approved');
  assert.throws(() => approvals.consumeOwnerApproval({ ...input, approvalId: first.approval.approvalId,
    preflightFingerprint: 'c'.repeat(64) }, 1_101), /evidence changed/i);
  const consumed = approvals.consumeOwnerApproval({ ...input, approvalId: first.approval.approvalId }, 1_101);
  assert.equal(consumed.status, 'consumed');
  assert.throws(() => approvals.consumeOwnerApproval({ ...input, approvalId: first.approval.approvalId }, 1_102), /already consumed/i);
  const lateReq = approvals.requestOwnerApproval({ ...input, intentId: 'approval-intent-late' }, 1_200, { ttlMs: 5_000 });
  approvals.decideOwnerApproval({ accountId: input.accountId, approvalId: lateReq.approval.approvalId,
    decision: 'approved', expectedDigest: lateReq.approval.mandateDigest }, 1_300);
  assert.throws(() => approvals.consumeOwnerApproval({ ...input, intentId: 'approval-intent-late',
    approvalId: lateReq.approval.approvalId }, 6_201), /expired/i);
  const expiring = approvals.requestOwnerApproval({ ...input, intentId: 'approval-intent-0002' }, 2_000, { ttlMs: 5_000 });
  assert.equal(approvals.listOwnerApprovals(input.accountId, { now: 7_001 })[0].status, 'expired');
  assert.throws(() => approvals.decideOwnerApproval({ accountId: input.accountId, approvalId: expiring.approval.approvalId,
    decision: 'approved', expectedDigest: expiring.approval.mandateDigest }, 7_001), /expired/i);
  const rejectedReq = approvals.requestOwnerApproval({ ...input, intentId: 'approval-intent-0003' }, 8_000);
  assert.equal(approvals.decideOwnerApproval({ accountId: input.accountId, approvalId: rejectedReq.approval.approvalId,
    decision: 'rejected', expectedDigest: rejectedReq.approval.mandateDigest }, 8_100).status, 'rejected');
  assert.equal(approvals.verifyOwnerApprovalChain(input.accountId).ok, true);
  const file = join(scratch, 'owner-approvals.json');
  const raw = readFileSync(file, 'utf8');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  for (const secret of ['private-account', 'private-agent-key', 'private-wallet', 'private-pact', 'msn_private']) {
    assert.equal(raw.includes(secret), false, `${secret} must not be persisted`);
  }
  const protocol = readFileSync(new URL('../lib/mcp-protocol.js', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(protocol, /paper_approval_request/);
  assert.match(protocol, /paper_approval_requests/);
  assert.match(server, /consumeOwnerApproval/);
  assert.match(server, /\/api\/paper\/approvals\/.*approve/);
  assert.match(app, /Owner Approval &amp; Exception Queue/);
  const { buildMcpTools } = await import('../lib/mcp-protocol.js');
  const tools = buildMcpTools({ authenticated: true, scopes: ['read', 'trade-paper'] });
  const requestTool = tools.find((tool) => tool.name === 'paper_approval_request');
  const listTool = tools.find((tool) => tool.name === 'paper_approval_requests');
  const openTool = tools.find((tool) => tool.name === 'paper_trade_open');
  assert.deepEqual(requestTool.annotations, { title: 'Request owner approval', readOnlyHint: false,
    destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.equal(listTool.annotations.readOnlyHint, true);
  assert.equal(listTool.annotations.destructiveHint, false);
  assert.equal(openTool.inputSchema.properties.approvalId.pattern, '^apr_[a-f0-9-]{36}$');
  console.log('owner approval and exception queue checks passed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
