// Builds a fail-closed release-approval template bound to deploy config + bytecode.
// This sends no transaction and never reads a private key.
const fs = require('fs');
const path = require('path');
const { network } = require('hardhat');
const { computeReleaseFingerprints } = require('./release-approval-lib');

async function main() {
  const root = path.join(__dirname, '..');
  const configPath = path.join(root, 'deploy.config.json');
  if (!fs.existsSync(configPath)) throw new Error('deploy.config.json not found');
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const fingerprints = computeReleaseFingerprints(cfg, network.config.chainId, root);
  const output = process.env.AITT_RELEASE_APPROVAL_FILE || path.join(root, 'release-approval.json');
  if (fs.existsSync(output)) throw new Error(`refusing to overwrite existing approval file: ${output}`);
  const zero = `0x${'0'.repeat(64)}`;
  const template = {
    auditApproved: false,
    counselApproved: false,
    ownerApproved: false,
    governanceSafeReviewed: false,
    auditReportHash: zero,
    counselApprovalHash: zero,
    ownerApprovalHash: zero,
    governanceConfigHash: fingerprints.governanceConfigHash,
    contractBundleHash: fingerprints.contractBundleHash,
  };
  fs.writeFileSync(output, JSON.stringify(template, null, 2), { mode: 0o600 });
  console.log(`release approval template written: ${output}`);
  console.log(`governance config hash: ${fingerprints.governanceConfigHash}`);
  console.log(`contract bundle hash: ${fingerprints.contractBundleHash}`);
}

main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
