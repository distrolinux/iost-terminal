// Scratch-backed EIP-191 wallet binding + atomic AITT claim-state regression.
import { rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet, Interface } from 'ethers';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = join(ROOT, '.tmp-aitt-conversion-test');
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
process.env.IOST_DATA_DIR = SCRATCH;

const points = await import('../lib/points.js');
const wallets = await import('../lib/evm-wallets.js');
const claims = await import('../lib/aitt-claims.js');
const gates = await import('../lib/aitt-release-gates.js');
const chain = await import('../lib/aitt-chain.js');
const metadata = await import('../lib/aitt.js');

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};

try {
  const blocked = gates.evaluateReleaseGates({ conversionOpen: true, status: 'design' });
  ok('conversionOpen alone cannot bypass release gates', !blocked.ready && blocked.failed.length > 0);
  const readyConfig = {
    conversionOpen: true, status: 'deployed', contractAddress: `0x${'1'.repeat(40)}`,
    deploymentManifestHash: `0x${'b'.repeat(64)}`,
    releaseApprovalHash: `0x${'e'.repeat(64)}`,
    feeRouterAddress: `0x${'2'.repeat(40)}`, converterAddress: `0x${'3'.repeat(40)}`,
    vaultAddresses: {
      ecosystemEmission: `0x${'4'.repeat(40)}`, treasury: `0x${'5'.repeat(40)}`,
      partners: `0x${'6'.repeat(40)}`, community: `0x${'7'.repeat(40)}`,
      reserve: `0x${'8'.repeat(40)}`, team: `0x${'9'.repeat(40)}`, advisor: `0x${'a'.repeat(40)}`,
    },
    chainVerification: { verified: true, chainId: 182 },
    reserveVerification: { verified: true },
    releaseGates: { auditApproved: true, counselApproved: true, ownerApproved: true },
    governanceOwner: `0x${'c'.repeat(40)}`,
    deployerAddress: `0x${'d'.repeat(40)}`,
    phase4Enabled: false,
  };
  ok('approval booleans and fabricated addresses cannot authorize conversion', !gates.evaluateReleaseGates(readyConfig).ready);
  const liveReady = await gates.evaluateLiveReleaseGates(readyConfig, { probe: async () => ({ verified: true }) });
  ok('complete intent plus successful live probe can authorize conversion', liveReady.ready);
  ok('Phase 4 flag blocks conversion during canonical launch', !gates.evaluateReleaseGates({ ...readyConfig, phase4Enabled: true }).ready);
  const prelaunchTrade = gates.evaluateTradingAccess({
    status: 'design', phase4Enabled: false,
    trading: { enabled: false, dex: 'PancakeSwap', chainId: 56, tokenAddress: '', pairAddress: '', factoryAddress: '', quoteToken: '', swapUrl: '' },
  });
  ok('buy/swap access remains disabled before deployment', !prelaunchTrade.ready && prelaunchTrade.failed.includes('phase4_enabled'));
  const maliciousTrade = gates.evaluateTradingAccess({
    status: 'deployed', phase4Enabled: true,
    trading: { enabled: true, dex: 'PancakeSwap', chainId: 56, tokenAddress: `0x${'1'.repeat(40)}`, pairAddress: `0x${'2'.repeat(40)}`, factoryAddress: `0x${'3'.repeat(40)}`, quoteToken: `0x${'4'.repeat(40)}`, swapUrl: 'https://evil.example/swap' },
  }, { liveVerified: true });
  ok('buy/swap access rejects non-PancakeSwap URLs', !maliciousTrade.ready && maliciousTrade.failed.includes('approved_swap_url'));
  const mismatchedTokenTrade = gates.evaluateTradingAccess({
    status: 'deployed', phase4Enabled: true,
    trading: { enabled: true, dex: 'PancakeSwap', chainId: 56, tokenAddress: `0x${'1'.repeat(40)}`, pairAddress: `0x${'2'.repeat(40)}`, factoryAddress: `0x${'3'.repeat(40)}`, quoteToken: `0x${'4'.repeat(40)}`, swapUrl: `https://pancakeswap.finance/swap?outputCurrency=0x${'5'.repeat(40)}` },
  }, { liveVerified: true });
  ok('buy/swap access rejects a route for another token', !mismatchedTokenTrade.ready && mismatchedTokenTrade.failed.includes('swap_url_token_match'));
  const unverifiedTrade = gates.evaluateTradingAccess({
    status: 'deployed', phase4Enabled: true,
    trading: { enabled: true, dex: 'PancakeSwap', chainId: 56, tokenAddress: `0x${'1'.repeat(40)}`, pairAddress: `0x${'2'.repeat(40)}`, factoryAddress: `0x${'3'.repeat(40)}`, quoteToken: `0x${'4'.repeat(40)}`, swapUrl: `https://pancakeswap.finance/swap?outputCurrency=0x${'1'.repeat(40)}` },
  });
  ok('buy/swap access requires live pair verification', !unverifiedTrade.ready && unverifiedTrade.failed.includes('live_pair_verified'));
  const readyTrade = gates.evaluateTradingAccess({
    status: 'deployed', phase4Enabled: true,
    trading: { enabled: true, dex: 'PancakeSwap', chainId: 56, tokenAddress: `0x${'1'.repeat(40)}`, pairAddress: `0x${'2'.repeat(40)}`, factoryAddress: `0x${'3'.repeat(40)}`, quoteToken: `0x${'4'.repeat(40)}`, swapUrl: `https://pancakeswap.finance/swap?outputCurrency=0x${'1'.repeat(40)}` },
  }, { liveVerified: true });
  ok('buy/swap access requires every Phase 4 integration field', readyTrade.ready);
  const postActivityAccounting = chain.verifyReleaseAccounting({
    configuredReserve: 1_000n, reserve: 700n, outstanding: 200n, reserved: 100n, converterBalance: 700n,
    allocations: [{ expected: 1_000n, totalAllocated: 1_000n, released: 250n, balance: 750n }],
  });
  ok('live release accounting remains valid after legitimate claims and vault releases', postActivityAccounting);
  ok('live release accounting rejects over-distribution', !chain.verifyReleaseAccounting({
    configuredReserve: 1_000n, reserve: 700n, outstanding: 200n, reserved: 100n, converterBalance: 700n,
    allocations: [{ expected: 1_000n, totalAllocated: 1_000n, released: 251n, balance: 750n }],
  }));
  const manifest = {
    network: 'iostL2', chainId: 182, governanceOwner: readyConfig.governanceOwner,
    deployerAddress: readyConfig.deployerAddress, releaseApprovalHash: readyConfig.releaseApprovalHash,
    pointsConversionReserve: '0',
    contracts: {
      token: readyConfig.contractAddress, feeRouter: readyConfig.feeRouterAddress, pointsConverter: readyConfig.converterAddress,
      ecosystemEmission: readyConfig.vaultAddresses.ecosystemEmission, treasuryVault: readyConfig.vaultAddresses.treasury,
      partnersVault: readyConfig.vaultAddresses.partners, communityVault: readyConfig.vaultAddresses.community,
      reserveVault: readyConfig.vaultAddresses.reserve, teamVesting: readyConfig.vaultAddresses.team, advisorVesting: readyConfig.vaultAddresses.advisor,
    },
  };
  const manifestHash = `0x${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`;
  const boundConfig = { ...readyConfig, deploymentManifestHash: manifestHash, reserveAITT: 0 };
  const journal = { status: 'completed', deploymentManifest: manifest, deploymentManifestHash: manifestHash };
  ok('deployment manifest binds digest and every release-gate address', metadata.verifyDeploymentJournalBinding(boundConfig, journal));
  ok('manifest tamper or config address drift fails closed', !metadata.verifyDeploymentJournalBinding({ ...boundConfig, contractAddress: `0x${'d'.repeat(40)}` }, journal) && !metadata.verifyDeploymentJournalBinding(boundConfig, { ...journal, deploymentManifest: { ...manifest, chainId: 1 } }));

  const userId = 'user:conversion-test';
  for (let i = 0; i < 10; i++) points.credit({ ownerId: userId, event: 'signal', refId: `sig-${i}` });
  ok('fixture has 100 whole points', points.getBalance(userId) === 100);

  const signer = Wallet.createRandom();
  const challenge = wallets.createChallenge({ userId, address: signer.address });
  const signature = await signer.signMessage(challenge.message);
  const bound = wallets.verifyChallenge({ challengeId: challenge.challengeId, signature });
  ok('valid EIP-191 signature binds the wallet', bound.ok && bound.binding.address === signer.address);
  ok('challenge is single use', !wallets.verifyChallenge({ challengeId: challenge.challengeId, signature }).ok);

  const attacker = Wallet.createRandom();
  const badChallenge = wallets.createChallenge({ userId: 'user:attacker-test', address: attacker.address });
  const wrongSignature = await signer.signMessage(badChallenge.message);
  ok('wrong signer cannot bind another address', !wallets.verifyChallenge({ challengeId: badChallenge.challengeId, signature: wrongSignature }).ok);

  const collision = wallets.createChallenge({ userId: 'user:second-account', address: signer.address });
  const collisionSig = await signer.signMessage(collision.message);
  ok('one EVM address cannot bind to two accounts', !wallets.verifyChallenge({ challengeId: collision.challengeId, signature: collisionSig }).ok);

  const claim = claims.reserveClaim({ userId, evmAddress: signer.address, points: 100, idempotencyKey: 'claim-1' });
  ok('claim reserves whole points in 8-decimal base units', claim.ok && claim.claim.baseUnits === '10000000000');
  const replay = claims.reserveClaim({ userId, evmAddress: signer.address, points: 100, idempotencyKey: 'claim-1' });
  ok('claim reservation is idempotent', replay.ok && replay.claim.id === claim.claim.id);
  ok('parallel claim cannot exceed available points', !claims.reserveClaim({ userId, evmAddress: signer.address, points: 1, idempotencyKey: 'claim-2' }).ok);

  const converterAddress = Wallet.createRandom().address;
  const iface = new Interface([
    'event Approved(address indexed user,uint256 amount)',
    'event Converted(address indexed user,uint256 amount)',
  ]);
  const approvedLog = iface.encodeEventLog(iface.getEvent('Approved'), [signer.address, 100n * 10n ** 8n]);
  const approvalReceipt = { status: 1, to: converterAddress, blockNumber: 123, logs: [{ address: converterAddress, ...approvedLog }] };
  ok('approval receipt requires matching converter event/address/amount', chain.verifyApprovalReceipt({ receipt: approvalReceipt, converterAddress, user: signer.address, amount: 100n * 10n ** 8n }).ok);
  ok('wrong approval amount is rejected', !chain.verifyApprovalReceipt({ receipt: approvalReceipt, converterAddress, user: signer.address, amount: 99n * 10n ** 8n }).ok);
  const convertedLog = iface.encodeEventLog(iface.getEvent('Converted'), [signer.address, 100n * 10n ** 8n]);
  const claimReceipt = { status: 1, to: converterAddress, blockNumber: 124, logs: [{ address: converterAddress, ...convertedLog }] };
  ok('conversion receipt requires matching Converted event', chain.verifyConversionReceipt({ receipt: claimReceipt, converterAddress, user: signer.address, amount: 100n * 10n ** 8n }).ok);

  const approved = claims.markApprovedOnchain({ claimId: claim.claim.id, txHash: `0x${'1'.repeat(64)}`, blockNumber: 123, expectedApprovalBaseUnits: claim.claim.baseUnits });
  ok('operator approval transition is explicit', approved.ok && approved.claim.status === 'approved_onchain');
  const convertedTx = `0x${'a'.repeat(64)}`;
  const confirmed = claims.confirmClaimedOnchain({ claimId: claim.claim.id, txHash: convertedTx, blockNumber: 124 });
  ok('confirmed receipt debits points and finalizes claim', confirmed.ok && confirmed.claim.status === 'claimed_onchain' && points.getBalance(userId) === 0);
  const confirmedAgain = claims.confirmClaimedOnchain({ claimId: claim.claim.id, txHash: convertedTx.toUpperCase().replace('0X', '0x'), blockNumber: 124 });
  ok('receipt reconciliation is idempotent', confirmedAgain.ok && points.getBalance(userId) === 0);

  const replayUser = 'user:tx-replay-test';
  const replayWallet = Wallet.createRandom();
  for (let i = 0; i < 10; i++) points.credit({ ownerId: replayUser, event: 'signal', refId: `replay-${i}` });
  const replayChallenge = wallets.createChallenge({ userId: replayUser, address: replayWallet.address });
  wallets.verifyChallenge({ challengeId: replayChallenge.challengeId, signature: await replayWallet.signMessage(replayChallenge.message) });
  const replayClaim = claims.reserveClaim({ userId: replayUser, evmAddress: replayWallet.address, points: 100, idempotencyKey: 'replay-claim' });
  claims.markApprovedOnchain({ claimId: replayClaim.claim.id, txHash: `0x${'3'.repeat(64)}`, blockNumber: 125, expectedApprovalBaseUnits: replayClaim.claim.baseUnits });
  ok('one Converted tx hash cannot finalize two claims despite case changes', !claims.confirmClaimedOnchain({ claimId: replayClaim.claim.id, txHash: convertedTx.toUpperCase().replace('0X', '0x'), blockNumber: 126 }).ok);

  const other = Wallet.createRandom();
  const otherUser = 'user:release-test';
  points.credit({ ownerId: otherUser, event: 'signal', refId: 'release-sig' });
  const ch = wallets.createChallenge({ userId: otherUser, address: other.address });
  wallets.verifyChallenge({ challengeId: ch.challengeId, signature: await other.signMessage(ch.message) });
  const pending = claims.reserveClaim({ userId: otherUser, evmAddress: other.address, points: 10, idempotencyKey: 'release-1' });
  claims.releaseClaim({ claimId: pending.claim.id, reason: 'operator rejected snapshot' });
  ok('released claim restores point availability', claims.availablePoints(otherUser) === 10 && points.getBalance(otherUser) === 10);
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);
