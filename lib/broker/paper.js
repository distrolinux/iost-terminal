// lib/broker/paper.js — PaperBroker: the paper venue, implementing the broker
// contract (see README.md). Thin 1:1 adapter over lib/paper.js + lib/market.js
// so the engine's execution path is identical to v1.8 — zero behavior change.
import { getState, openTrade } from '../paper.js';
import { getTicker } from '../market.js';

export function createPaperBroker() {
  return {
    name: 'paper',

    /** { ok, account } — account snapshot with live equity. */
    async getAccount(accountId) {
      const state = await getState(accountId);
      const openNotional = state.positions.reduce((a, p) => a + (p.notional || 0), 0);
      return {
        ok: true,
        account: {
          ...state.account,
          positions: state.positions,
          journal: state.journal,
          equity: Math.round((state.account.cash + openNotional) * 100) / 100,
        },
      };
    },

    /** { ok, quotes } — fresh quotes for the requested symbols. */
    async getQuotes(symbols = []) {
      const quotes = {};
      for (const symbol of symbols) {
        try {
          const t = await getTicker(symbol);
          quotes[symbol] = { last: t.last, ts: t.ts || Date.now() };
        } catch { /* symbol unavailable — omit */ }
      }
      return { ok: true, quotes };
    },

    /** { ok, positions } — open positions for the account. */
    async getPositions(accountId) {
      const state = await getState(accountId);
      return { ok: true, positions: state.positions };
    },

    /** { ok, orders } — resting orders. Paper fills instantly: none. */
    async getOrders() {
      return { ok: true, orders: [] };
    },

    /** { ok, position } — instant market fill via the existing paper engine. */
    async placeOrder(order) {
      return openTrade(order); // 1:1 delegation — identical behavior
    },

    /** Paper never has resting orders, so there is nothing to cancel. */
    async cancelOrder() {
      return { ok: false, error: 'No resting orders in paper mode' };
    },
  };
}
