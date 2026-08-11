// lib/broker/index.js — venue registry. Execution boundary for IOST Terminal.
// See README.md for the full interface contract. Add live venues here (v2).
import { createPaperBroker } from './paper.js';
import { createKrakenBroker } from './kraken.js';

const REGISTRY = {
  paper: createPaperBroker,
  kraken: createKrakenBroker,
};

/**
 * Resolve a broker by venue name.
 * @param {string} name - 'paper' (default). 'kraken'/'ibkr' land with v2.
 * @returns broker instance implementing the contract (see README.md)
 * @throws {Error} unknown venue name
 */
export function getBroker(name = 'paper') {
  const factory = REGISTRY[name];
  if (!factory) throw new Error(`Unknown broker venue: ${name}`);
  return factory();
}

export const venues = Object.keys(REGISTRY);
