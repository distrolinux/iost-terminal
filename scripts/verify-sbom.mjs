import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) throw new Error('usage: node scripts/verify-sbom.mjs <sbom.json>');
const sbom = JSON.parse(readFileSync(path, 'utf8'));
if (sbom.bomFormat !== 'CycloneDX') throw new Error('SBOM must use CycloneDX');
if (!/^1\.[5-9]$/.test(String(sbom.specVersion || ''))) throw new Error('unsupported CycloneDX version');
if (sbom.metadata?.component?.name !== 'iost-terminal') throw new Error('SBOM root component mismatch');
if (!Array.isArray(sbom.components) || !sbom.components.length) throw new Error('SBOM has no components');
const missingIdentity = sbom.components.filter((item) => !item.name || !item.version || !item.purl);
if (missingIdentity.length) throw new Error(`${missingIdentity.length} SBOM components lack identity evidence`);
console.log(`CycloneDX SBOM verified: ${sbom.components.length} components`);
