// vendored from node_modules/bs58/src/esm/index.js (MIT) — browser build.
// bs58 v6: base58 encode/decode over base-x. See base-x.mjs for the encoder.
import basex from './base-x.mjs';
var ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export default basex(ALPHABET);
