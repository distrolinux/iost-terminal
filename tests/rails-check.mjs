// rails.js verification — hard live-order gates (pure logic, no network).
import { checkLiveOrder, liveRailConfig } from '../lib/rails.js';

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

console.log('rails cfg:', JSON.stringify(liveRailConfig));

// valid order passes (0.0007 BTC @ 65000 = $45.50 < $50 cap)
const good = checkLiveOrder({ symbol: 'BTC', side: 'long', size: 0.0007, entry: 65000, openPositions: [], cashUsd: 100, todayPnlUsd: 0 });
ok('valid order passes', good.ok, good.error || '');

// notional cap: 0.01 BTC @ 65000 = $650 > $50
const big = checkLiveOrder({ symbol: 'BTC', size: 0.01, entry: 65000, openPositions: [], cashUsd: 100 });
ok('notional cap enforced', !big.ok && big.rail === 'maxOrderUsd', big.error);

// position cap
const posCap = checkLiveOrder({ symbol: 'BTC', size: 0.0001, entry: 65000, openPositions: [{}, {}, {}], cashUsd: 100 });
ok('position cap enforced', !posCap.ok && posCap.rail === 'maxPositions');

// cash buffer
const poor = checkLiveOrder({ symbol: 'BTC', size: 0.0001, entry: 65000, openPositions: [], cashUsd: 5 });
ok('cash buffer enforced', !poor.ok && poor.rail === 'minCashUsd');

// daily loss halt
const bleeding = checkLiveOrder({ symbol: 'BTC', size: 0.0001, entry: 65000, openPositions: [], cashUsd: 100, todayPnlUsd: -30 });
ok('daily loss halt enforced', !bleeding.ok && bleeding.rail === 'maxDailyLoss');

// shape validation
ok('rejects no size', !checkLiveOrder({ symbol: 'BTC', openPositions: [], cashUsd: 100 }).ok);

console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);
