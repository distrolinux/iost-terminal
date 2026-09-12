import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';

export function createCredentialVault({ activeKeyId, keys } = {}) {
  const fail = () => { throw new Error('vault configuration unavailable'); };
  if (!keys || typeof keys !== 'object' || Array.isArray(keys) || !/^[a-zA-Z0-9_-]{1,64}$/.test(activeKeyId || '')) fail();
  const ring = new Map();
  const entries = Object.entries(keys);
  if (!entries.length || entries.length > 8) fail();
  for (const [id, value] of entries) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || typeof value !== 'string') fail();
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32 || key.toString('base64') !== value) fail();
    ring.set(id, key);
  }
  if (!ring.has(activeKeyId)) fail();
  const aad = (owner, provider, id) => {
    if (typeof owner !== 'string' || !owner || owner.length > 256 || typeof provider !== 'string' || !provider || provider.length > 64) throw new Error('invalid credential context');
    return Buffer.from(JSON.stringify(['iost-credential', 1, owner, provider, id]));
  };
  return {
    activeKeyId,
    seal(owner, provider, plaintext) {
      if (typeof plaintext !== 'string' || !plaintext || Buffer.byteLength(plaintext) > 16384) throw new Error('invalid credential payload');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', ring.get(activeKeyId), iv);
      cipher.setAAD(aad(owner, provider, activeKeyId));
      const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return { version: 1, keyId: activeKeyId, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    },
    open(owner, provider, blob) {
      try {
        if (blob?.version !== 1 || !ring.has(blob.keyId) || typeof blob.data !== 'string' || blob.data.length > 22000) return null;
        const iv = Buffer.from(blob.iv, 'base64');
        const tag = Buffer.from(blob.tag, 'base64');
        if (iv.length !== 12 || tag.length !== 16) return null;
        const decipher = createDecipheriv('aes-256-gcm', ring.get(blob.keyId), iv);
        decipher.setAAD(aad(owner, provider, blob.keyId));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]).toString('utf8');
      } catch { return null; }
    },
  };
}

export function configuredCredentialVault() {
  try {
    const file = process.env.IOST_CREDENTIAL_VAULT_FILE;
    if (file) {
      if (!isAbsolute(file) || process.env.IOST_CREDENTIAL_VAULT_KEYS || process.env.IOST_CREDENTIAL_VAULT_ACTIVE_KEY_ID) throw Error('ambiguous source');
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || ![0o400, 0o600].includes(stat.mode & 0o7777) || stat.uid !== process.geteuid() || stat.size < 1 || stat.size > 8192) throw Error('unsafe vault file');
        const buffer = Buffer.alloc(8193);
        let total = 0, count;
        while (total < buffer.length && (count = readSync(fd, buffer, total, buffer.length - total, null)) > 0) total += count;
        if (total > 8192) throw Error('oversized vault file');
        return createCredentialVault(JSON.parse(buffer.subarray(0, total).toString('utf8')));
      } finally { closeSync(fd); }
    }
    return createCredentialVault({ activeKeyId: process.env.IOST_CREDENTIAL_VAULT_ACTIVE_KEY_ID, keys: JSON.parse(process.env.IOST_CREDENTIAL_VAULT_KEYS || '') });
  } catch { throw new Error('vault configuration unavailable'); }
}
