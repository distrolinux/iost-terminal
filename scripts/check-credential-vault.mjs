// No stores, network, key generation, credential migration or secret output.
import { configuredCredentialVault } from '../lib/credential-vault.js';
const optional = process.argv.length === 3 && process.argv[2] === '--optional';
if (process.argv.length > 2 && !optional) {
  console.error('Unsupported vault-check argument'); process.exit(2);
}
const present = ['IOST_CREDENTIAL_VAULT_FILE', 'IOST_CREDENTIAL_VAULT_KEYS', 'IOST_CREDENTIAL_VAULT_ACTIVE_KEY_ID'].some(name => Boolean(process.env[name]));
if (!present && optional) {
  console.log('Vault not configured; new credential storage remains unavailable.');
} else {
  try {
    const vault = configuredCredentialVault();
    const probe = vault.seal('local-self-check', 'kraken', 'nonsecret-roundtrip-probe');
    if (vault.open('local-self-check', 'kraken', probe) !== 'nonsecret-roundtrip-probe') throw Error('roundtrip failed');
    console.log('Vault configuration and local encryption round trip passed. No credentials changed.');
  } catch {
    console.error('Vault validation failed. Check protected file ownership, permissions, format and configuration source.');
    process.exitCode = 1;
  }
}
