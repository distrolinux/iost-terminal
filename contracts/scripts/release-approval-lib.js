const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ZERO = '0x0000000000000000000000000000000000000000';
const CONTRACTS = [
  ['AITT', 'AITT.sol'],
  ['AITTFeeRouter', 'AITTFeeRouter.sol'],
  ['AITTVesting', 'AITTVesting.sol'],
  ['AITTMilestoneVault', 'AITTMilestoneVault.sol'],
  ['PointsConverter', 'PointsConverter.sol'],
];

const hash = (value) => `0x${crypto.createHash('sha256').update(value).digest('hex')}`;
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};
const canonicalJson = (value) => JSON.stringify(canonical(value));
const address = (value) => String(value || ZERO).toLowerCase();

function deploymentApprovalPayload(cfg, chainId) {
  const allocationKeys = [
    'ecosystemPool', 'treasury', 'teamBeneficiary', 'partners',
    'community', 'reserve', 'advisorBeneficiary',
  ];
  return {
    network: String(cfg.network || 'iostL2'),
    chainId: Number(chainId),
    allocations: Object.fromEntries(allocationKeys.map((key) => [key, address(cfg.allocations?.[key])])),
    pointsConversionReserve: String(cfg.pointsConversionReserve || '0'),
    operator: address(cfg.operator),
    stakersPool: address(cfg.stakersPool),
    governanceOwner: address(cfg.governanceOwner),
    ammPair: address(cfg.ammPair),
    ammFactory: address(cfg.ammFactory),
    quoteToken: address(cfg.quoteToken),
    phase4Enabled: cfg.phase4Enabled === true,
  };
}

function contractBundlePayload(rootDir) {
  return CONTRACTS.map(([name, source]) => {
    const artifactPath = path.join(rootDir, 'artifacts', 'contracts', source, `${name}.json`);
    if (!fs.existsSync(artifactPath)) throw new Error(`compiled artifact missing: ${artifactPath}`);
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    if (!artifact.bytecode || artifact.bytecode === '0x') throw new Error(`creation bytecode missing: ${name}`);
    if (!artifact.deployedBytecode || artifact.deployedBytecode === '0x') throw new Error(`deployed bytecode missing: ${name}`);
    return { name, sourceName: artifact.sourceName, bytecode: artifact.bytecode, deployedBytecode: artifact.deployedBytecode };
  });
}

function computeReleaseFingerprints(cfg, chainId, rootDir) {
  const configPayload = deploymentApprovalPayload(cfg, chainId);
  const contractPayload = contractBundlePayload(rootDir);
  return {
    governanceConfigHash: hash(canonicalJson(configPayload)),
    contractBundleHash: hash(canonicalJson(contractPayload)),
    configPayload,
  };
}

module.exports = { computeReleaseFingerprints };
