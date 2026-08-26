import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'iost-arena-'));
process.env.IOST_DATA_DIR = scratch;
const arena = await import('../lib/arena.js');

let failed = 0;
function ok(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failed++;
}

const pnls = [1200, -500, 800, -1400, 600, 300];
for (let i = 0; i < pnls.length; i++) {
  const trade = { id: `trade-${i}`, symbol: 'IOST', side: 'long', entry: 1, size: 10000, notional: 10000, openedAt: 1000 + i * 100 };
  const open = arena.recordOpen({
    agentId: 'agent:test', name: 'Test Agent', kind: 'ai', accountId: 'paper:test', trade,
    priceProvider: 'fixture-market', reason: `reason ${i}`,
    trail: [{ step: 'signal', input: 'fixture', output: i % 2 ? 'wait' : 'enter', confidence: 0.75 }], now: 1000 + i * 100,
  });
  const pnl = pnls[i];
  arena.recordClose({
    openEvidence: open, exitPrice: 1 + pnl / 10000,
    journal: { id: trade.id, status: 'closed', pnl, pnlPct: pnl / 100, result: pnl > 0 ? 'win' : 'loss', closedAt: 1050 + i * 100 },
    priceProvider: 'fixture-market', now: 1050 + i * 100,
  });
}

const board = arena.leaderboard();
const agent = board.agents[0];
ok('arena is explicitly paper-only', board.ok && board.mode === 'paper-only');
ok('only server-market audited closes become verified performance', agent.verifiedTrades === 6);
ok('minimum sample marks the agent ranked', agent.status === 'ranked' && agent.rank === 1);
ok('drawdown and risk are derived from the realized equity curve', agent.maxDrawdownPct > 0 && agent.scores.risk < 100);
ok('transparent reasoning coverage is measured', agent.reasoningCoveragePct === 100);
ok('score components and formulas are returned', Number.isFinite(agent.scores.performance) && /45% performance/.test(board.formula.trust));
ok('audit chain validates with a stable head hash', board.audit.ok && /^[a-f0-9]{64}$/.test(board.audit.headHash));

const detail = arena.agentDetail('agent:test');
ok('agent detail exposes immutable inputs, reasoning and audit hashes', detail.events.length === 12
  && detail.events.every((e) => /^[a-f0-9]{64}$/.test(e.hash))
  && detail.events.some((e) => e.payload.rationale?.trail?.length));
ok('a client cannot close a trade without verified Arena open evidence',
  arena.getOpenEvidence({ agentId: 'agent:test', accountId: 'paper:test', tradeId: 'missing' }) === null);

const auditFile = join(scratch, 'arena-audit.jsonl');
chmodSync(auditFile, 0o600);
const lines = readFileSync(auditFile, 'utf8').trim().split('\n');
const tampered = JSON.parse(lines[2]);
tampered.payload.pnl = 999999;
lines[2] = JSON.stringify(tampered);
writeFileSync(auditFile, `${lines.join('\n')}\n`, { mode: 0o600 });
const rejected = arena.leaderboard();
ok('tampered performance fails closed instead of being ranked', rejected.ok === false && rejected.agents.length === 0);

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const arenaRoutes = server.slice(server.indexOf("app.get('/api/arena'"), server.indexOf('// ================= off-chain points'));
ok('Arena execution routes force paper broker and server market fills',
  /getBroker\('paper'\)/.test(arenaRoutes) && /getTicker/.test(arenaRoutes) && !/getBroker\('kraken'\)|placeLive|sendTransaction/.test(arenaRoutes));
ok('Arena close ignores a client exit price', !/req\.body\?\.exitPrice/.test(arenaRoutes));
ok('agent Arena opens retain wallet and Pact authorization', /agentSpendGate/.test(arenaRoutes) && /pactId/.test(arenaRoutes));

rmSync(scratch, { recursive: true, force: true });
if (failed) process.exit(1);
console.log('Agent Trust Arena checks passed');
