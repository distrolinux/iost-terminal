// Internal bounded reader. Count agreement is not atomic snapshot/settlement proof.
export async function readKrakenLedgerWindow(read, window) {
  const unknown = { status: 'unknown', settlementVerified: false, releaseAllowed: false, executionAuthorized: false };
  try {
    const { start, end } = window;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start > 86400 || end > Math.floor(Date.now() / 1000)) return unknown;
    const rows = [], seen = new Set(); let count;
    for (let page = 0; page < 4; page++) {
      const response = await read('Ledgers', { start: String(start), end: String(end), ofs: String(rows.length), type: 'trade', asset: 'all', without_count: 'false' });
      if (!response || !Number.isSafeInteger(response.count) || response.count < 0 || response.count > 200 || (count !== undefined && response.count !== count)) return unknown;
      count = response.count;
      if (!response.ledger || typeof response.ledger !== 'object' || Array.isArray(response.ledger)) return unknown;
      const entries = Object.entries(response.ledger);
      if (entries.length !== Math.min(50, count - rows.length)) return unknown;
      for (const [id, r] of entries) {
        if (!/^[A-Za-z0-9-]{1,80}$/.test(id) || seen.has(id) || !r || typeof r.refid !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(r.refid) || !Number.isFinite(r.time) || r.time <= start || r.time > end || r.type !== 'trade' || r.subtype !== '' || r.aclass !== 'currency' || typeof r.asset !== 'string' || !/^[A-Z0-9]{2,12}$/.test(r.asset)) return unknown;
        for (const field of ['amount', 'fee']) if (typeof r[field] !== 'string' || !/^-?(0|[1-9]\d{0,19})(\.\d{1,10})?$/.test(r[field])) return unknown;
        if (r.fee.startsWith('-')) return unknown;
        seen.add(id);
        rows.push({ id, refid: r.refid, time: r.time, type: r.type, subtype: r.subtype, aclass: r.aclass, asset: r.asset, amount: r.amount, fee: r.fee });
      }
      if (rows.length === count) return { ...unknown, status: 'ledger-window-observed', windowCountMatched: true, snapshotComplete: false, rows };
    }
    return unknown;
  } catch { return unknown; }
}
