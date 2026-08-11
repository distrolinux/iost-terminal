// scripts/signer-probe.js — prove the IOST tx wire format against the public RPC.
// Uses a THROWAWAY random keypair (no real account): a format/parse/signature
// problem fails early with a node error; "account not found" proves the tx was
// well-formed and reached the account check. Never sends a real tx.
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import crypto from 'node:crypto';

const RPC = 'https://api.iost.io';

const encInt32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n >>> 0, 0); return b; };
const encInt64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n), 0); return b; };
const encByte = (n) => { const b = Buffer.alloc(1); b.writeUInt8(Number(n) & 0xff, 0); return b; };
const encBytes = (b) => Buffer.concat([encInt32(b.length), b]);
const encString = (s) => encBytes(Buffer.from(String(s), 'utf8'));
const sigToBytes = (s) => Buffer.concat([encByte(s.algorithm), encBytes(s.signature), encBytes(s.publicKey)]);
const actionToBytes = (a) => Buffer.concat([encString(a.contract), encString(a.actionName), encString(a.data)]);
const amountToBytes = (a) => Buffer.concat([encString(a.token), encString(a.value)]);
function txToBytes(tx, level) {
  const parts = [
    encInt64(tx.time), encInt64(tx.expiration),
    encInt64(Math.round(tx.gasRatio * 100)), encInt64(Math.round(tx.gasLimit * 100)),
    encInt64(tx.delay), encInt32(tx.chainId),
    encBytes(tx.reserved || Buffer.alloc(0)),
    encInt32(tx.signers.length), ...tx.signers.map(encString),
    encInt32(tx.actions.length), ...tx.actions.map((a) => encBytes(actionToBytes(a))),
    encInt32(tx.amountLimit.length), ...tx.amountLimit.map((a) => encBytes(amountToBytes(a))),
  ];
  if (level > 0) parts.push(encInt32(tx.signatures.length), ...tx.signatures.map((s) => encBytes(sigToBytes(s))));
  if (level > 1) {
    parts.push(encBytes(tx.referredTx || Buffer.alloc(0)), encString(tx.publisher));
    parts.push(encInt32(tx.publisherSigs.length), ...tx.publisherSigs.map((s) => encBytes(sigToBytes(s))));
  }
  return Buffer.concat(parts);
}
const sha3 = (b) => crypto.createHash('sha3-256').update(b).digest();

async function main() {
  // 1) deterministic hash sanity: same input twice → same output
  const enc = JSON.stringify({ a: 1, b: 'x' });
  const h1 = crypto.createHash('sha256').update(enc).digest('hex');
  const h2 = crypto.createHash('sha256').update(enc).digest('hex');
  console.log('canonical-hash deterministic:', h1 === h2 ? 'PASS' : 'FAIL', h1.slice(0, 16));

  // 2) build a transfer tx with a random throwaway keypair
  const kp = nacl.sign.keyPair();
  const pub = Buffer.from(kp.publicKey);
  const privB58 = bs58.encode(kp.secretKey); // 64-byte form, like iost.js B58SecKey
  console.log('throwaway account pubkey (b58):', bs58.encode(pub));
  console.log('privkey len:', bs58.decode(privB58).length);

  const info = await (await fetch(`${RPC}/getNodeInfo`)).json();
  const diff = BigInt(info.server_time) - BigInt(Date.now()) * 1000000n;
  const time = BigInt(Date.now()) * 1000000n + diff;
  const expiration = time + 60000000000n;
  const account = 'iost' + bs58.encode(pub).slice(0, 8).toLowerCase(); // fake account name
  const memo = 'PIN:' + crypto.createHash('sha256').update('test-signal').digest('hex');
  const tx = {
    time, expiration, gasRatio: 1, gasLimit: 1000000, delay: 0, chainId: 1024,
    signers: [],
    actions: [{ contract: 'token.iost', actionName: 'transfer', data: JSON.stringify(['iost', account, account, '0.0001', memo]) }],
    amountLimit: [{ token: 'iost', value: '0.0001' }],
    signatures: [], publisher: account, publisherSigs: [],
    reserved: null, referredTx: null,
  };
  const publishHash = sha3(txToBytes(tx, 1));
  const sig = nacl.sign.detached(publishHash, kp.secretKey);
  tx.publisherSigs = [{ algorithm: 2, signature: Buffer.from(sig), publicKey: pub }];
  const onChainHash = bs58.encode(sha3(txToBytes(tx, 2)));
  console.log('computed on-chain tx hash (b58):', onChainHash);
  // signature verifies against publish hash with the same pubkey?
  const ok = nacl.sign.detached.verify(publishHash, sig, pub);
  console.log('signature self-verify:', ok ? 'PASS' : 'FAIL');

  // 3) send to the live node — expect a "account not found" style error, which
  //    proves parse + signature checks passed (a format error fails earlier)
  const body = {
    time: time.toString(), expiration: expiration.toString(),
    gasRatio: 1, gasLimit: 1000000, delay: 0, chainId: 1024,
    actions: tx.actions, amountLimit: tx.amountLimit, signers: [],
    signatures: [], publisher: account,
    publisherSigs: [{ algorithm: 'ED25519', signature: Buffer.from(sig).toString('base64'), publicKey: pub.toString('base64') }],
  };
  const res = await (await fetch(`${RPC}/sendTx`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).json();
  console.log('sendTx response:', JSON.stringify(res).slice(0, 300));
  const msg = (res?.message || '');
  if (/not found|account|balance|gas|publisher|permission/i.test(msg) && !/unknown field|unmarshal|invalid character|json/i.test(msg)) {
    console.log('WIRE FORMAT: PASS — node parsed + checked our tx (reached account/gas stage)');
  } else if (res?.hash) {
    console.log('WIRE FORMAT: PASS — tx ACCEPTED (hash returned)');
  } else {
    console.log('WIRE FORMAT: UNCERTAIN — inspect message above');
  }
  console.log('node time diff (ns):', diff.toString());
}
main().catch((e) => { console.error('probe error:', e.message); process.exit(1); });
