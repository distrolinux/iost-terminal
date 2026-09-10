import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'iost-agent-events-'));
process.env.IOST_DATA_DIR = scratch;
process.env.IOST_AGENT_EVENT_RETENTION = '3';

try {
  const stream = await import(`../lib/agent-event-stream.js?test=${Date.now()}`);
  const received = [];
  const unsubscribe = stream.subscribeAgentEvents('owner-a', (event) => received.push(event.sequence));
  for (let i = 1; i <= 5; i += 1) {
    stream.recordAgentEvent('owner-a', {
      type: 'mcp.tool.completed', category: i === 5 ? 'execution' : 'mission', actor: 'agent',
      outcome: i === 5 ? 'rejected' : 'accepted', severity: i === 5 ? 'warning' : 'info',
      summary: `Step ${i} completed.`, sourceRef: 'secret-mission-id',
      metadata: { tool: 'paper_mission_checkpoint', stage: 'observe', statusCode: i === 5 ? 409 : 200,
        apiKey: 'must-not-survive', walletId: 'must-not-survive' },
    }, 1_800_000_000_000 + i);
  }
  unsubscribe();
  assert.deepEqual(received, [1, 2, 3, 4, 5], 'subscribers receive each monotonic event once');

  const status = stream.agentEventStreamStatus('owner-a', { afterSequence: 1, limit: 20 });
  assert.equal(status.status, 'healthy');
  assert.equal(status.cursor.earliestSequence, 3);
  assert.equal(status.cursor.latestSequence, 5);
  assert.equal(status.replay.gapDetected, true);
  assert.equal(status.replay.reasonCode, 'cursor-before-retention');
  assert.deepEqual(status.events.map((event) => event.sequence), [3, 4, 5]);
  assert.equal(status.chain.verified, true);
  assert.equal(status.retention.retainedCount, 3);
  assert.equal(status.guarantees.ownerIsolated, true);
  assert.equal(status.guarantees.credentialsExcluded, true);
  assert.equal(status.execution.tradeCreated, false);
  assert.equal(status.liveScopeUsed, false);
  assert.equal(status.publicChainUsed, false);

  const resumed = stream.replayAgentEvents('owner-a', { afterSequence: 3, limit: 1 });
  assert.deepEqual(resumed.events.map((event) => event.sequence), [4]);
  assert.equal(resumed.replay.hasMore, true);
  const ahead = stream.replayAgentEvents('owner-a', { afterSequence: 99, limit: 10 });
  assert.equal(ahead.replay.gapDetected, true);
  assert.equal(ahead.replay.reasonCode, 'cursor-ahead-of-stream');
  assert.equal(ahead.cursor.resumedFrom, 5);
  assert.equal(stream.agentEventStreamStatus('owner-b').events.length, 0, 'owners must remain isolated');
  assert.throws(() => stream.replayAgentEvents('owner-a', { afterSequence: -1 }), /non-negative integer/);
  assert.equal(statSync(stream.agentEventStorePathForTest).mode & 0o777, 0o600);
  const raw = readFileSync(stream.agentEventStorePathForTest, 'utf8');
  assert.equal(raw.includes('owner-a'), false);
  assert.equal(raw.includes('secret-mission-id'), false);
  assert.equal(raw.includes('must-not-survive'), false);

  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const protocol = readFileSync(new URL('../lib/mcp-protocol.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');
  assert.match(server, /app\.get\('\/api\/agent-events\/stream',\s*requireUser/);
  assert.match(server, /Last-Event-ID/);
  assert.match(server, /X-Accel-Buffering/);
  assert.match(server, /agentEvents\.subscribeAgentEvents/);
  assert.match(protocol, /agent_event_stream_status/);
  assert.match(app, /Real-time Agent Event Stream/);
  assert.match(app, /new EventSource\(`\/api\/agent-events\/stream\?afterSequence=/);
  assert.match(css, /\.agent-event-timeline/);
  assert.match(server, /const DISCOVERY_VERSION = '1.55.0'/);
  console.log('agent event stream checks passed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
