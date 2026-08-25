// Regression checks for the news sentiment score midpoint.
import { scoreAssetSentiment } from '../lib/news.js';

let failures = 0;
const ok = (cond, label) => {
  if (!cond) { failures++; console.error(`FAIL: ${label}`); }
  else console.log(`ok: ${label}`);
};

const neutral = scoreAssetSentiment({ avgScore: 50, bullish: 0, bearish: 0, neutral: 3, total: 3 });
ok(neutral.score === 50, `neutral midpoint stays 50 (got ${neutral.score})`);
ok(neutral.label === 'neutral', `neutral midpoint stays neutral (got ${neutral.label})`);

const bullish = scoreAssetSentiment({ avgScore: 60, bullish: 2, bearish: 0, neutral: 0, total: 2 });
ok(bullish.score >= 60 && bullish.label === 'bullish', `bullish coverage remains bullish (${bullish.score})`);

const bearish = scoreAssetSentiment({ avgScore: 40, bullish: 0, bearish: 2, neutral: 0, total: 2 });
ok(bearish.score <= 40 && bearish.label === 'bearish', `bearish coverage remains bearish (${bearish.score})`);

const missing = scoreAssetSentiment(null);
ok(missing.score === 50 && missing.label === 'neutral' && missing.count === 0, 'missing coverage fails neutral');

console.log(failures === 0 ? '\nPASS news sentiment regression checks' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
