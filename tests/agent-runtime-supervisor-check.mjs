import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'iost-runtime-supervisor-'));
process.env.IOST_DATA_DIR = join(scratch, 'server');

try {
  const runtime = await import('../lib/agent-runtime.js');
  const supervisor = await import('../lib/agent-runtime-supervisor.js');
  const stateFile = join(scratch, 'client', 'state.json');
  const store = supervisor.createSupervisorStateStore(stateFile);
  const identity = { ownerId: 'supervisor-owner', keyId: 'supervisor-key', agentName: 'Hermes Paper Agent' };
  let now = 1_800_000_000_000;
  let sessionNumber = 0;
  const createSessionId = () => `supervisor-session-${++sessionNumber}-0000`;
  const getStatus = () => runtime.agentRuntimeStatus(identity.ownerId, identity.keyId, now);
  const sendHeartbeat = (payload) => runtime.recordAgentHeartbeat({ ...identity, ...payload }, now);

  const initialRetryStore = supervisor.createSupervisorStateStore(join(scratch, 'initial-retry', 'state.json'));
  const initialRetryIdentity = { ownerId: 'initial-retry-owner', keyId: 'initial-retry-key', agentName: 'Retry Agent' };
  const initialRetryStatus = () => runtime.agentRuntimeStatus(initialRetryIdentity.ownerId, initialRetryIdentity.keyId, now);
  await assert.rejects(() => supervisor.runSupervisorCycle({
    getStatus: initialRetryStatus, store: initialRetryStore, now, createSessionId,
    sendHeartbeat: () => { throw new Error('connection failed before commit'); },
  }), /before commit/);
  const initialRetried = await supervisor.runSupervisorCycle({
    getStatus: initialRetryStatus, store: initialRetryStore, now: now + 1, createSessionId,
    sendHeartbeat: (payload) => runtime.recordAgentHeartbeat({ ...initialRetryIdentity, ...payload }, now + 1),
  });
  assert.equal(initialRetried.runtime.status, 'ready');
  assert.equal(initialRetried.runtime.heartbeat.sequence, 1);

  const first = await supervisor.runSupervisorCycle({ getStatus, sendHeartbeat, store, now, createSessionId });
  assert.equal(first.runtime.status, 'ready');
  assert.equal(first.runtime.supervisor.managed, true);
  assert.equal(first.runtime.supervisor.version, 1);
  assert.equal(first.runtime.supervisor.cadenceMs, 20_000);
  assert.equal(first.runtime.execution.authorityExpanded, false);
  assert.equal(first.liveScopeUsed, false);
  assert.equal(first.publicChainUsed, false);
  assert.equal(statSync(stateFile).mode & 0o777, 0o600);

  now += 20_000;
  const second = await supervisor.runSupervisorCycle({ getStatus, sendHeartbeat, store, now, createSessionId });
  assert.equal(second.runtime.heartbeat.sequence, 2);
  assert.equal(supervisor.supervisorHealth(store.load(), now).status, 'ready');

  now += 20_000;
  const missionBound = await supervisor.runSupervisorCycle({
    getStatus, sendHeartbeat, store, now, createSessionId,
    desired: { state: 'ready', stage: 'analyze', missionId: 'msn_supervisor1', cursor: 'bounded-context' },
  });
  assert.equal(missionBound.runtime.checkpoint.missionId, 'msn_supervisor1');
  now += 20_000;
  const missionCleared = await supervisor.runSupervisorCycle({
    getStatus, sendHeartbeat, store, now, createSessionId,
    desired: { state: 'ready', stage: 'idle', missionId: null, cursor: null },
  });
  assert.equal(missionCleared.runtime.checkpoint.missionId, null, 'explicit null context must clear mission binding');

  // Simulate a lost HTTP acknowledgement after the server durably accepted it.
  now += 20_000;
  await assert.rejects(() => supervisor.runSupervisorCycle({
    getStatus, store, now, createSessionId,
    sendHeartbeat: (payload) => { runtime.recordAgentHeartbeat({ ...identity, ...payload }, now); throw new Error('connection reset after commit'); },
  }), /connection reset/);
  assert.equal(store.load().pending.payload.sequence, 5, 'write-ahead payload must survive an uncertain response');
  const reconciled = await supervisor.runSupervisorCycle({ getStatus, sendHeartbeat, store, now: now + 1, createSessionId });
  assert.equal(reconciled.outcome, 'reconciled');
  assert.equal(reconciled.heartbeatSent, false, 'accepted pending heartbeat must not be duplicated');
  assert.equal(store.load().pending, null);

  now += 20_000;
  const drained = await supervisor.runSupervisorCycle({ getStatus, sendHeartbeat, store, now, createSessionId, desired: { state: 'draining', stage: 'journal' } });
  assert.equal(drained.runtime.status, 'draining');

  // Losing local state is recoverable only from a draining/offline runtime and
  // must use the exact server checkpoint with a fresh sequence-one session.
  unlinkSync(stateFile);
  now += 1_000;
  const recovered = await supervisor.runSupervisorCycle({ getStatus, sendHeartbeat, store, now, createSessionId });
  assert.equal(recovered.runtime.status, 'ready');
  assert.equal(recovered.runtime.heartbeat.sequence, 1);
  assert.equal(recovered.runtime.session.recoveryCount, 1);
  assert.equal(recovered.runtime.recovery.lastOutcome, 'exact-checkpoint-resumed');

  unlinkSync(stateFile);
  await assert.rejects(() => supervisor.runSupervisorCycle({ getStatus, sendHeartbeat, store, now: now + 1, createSessionId }), /offline or draining/, 'missing local state must not take over a ready runtime');

  const script = readFileSync(new URL('../scripts/agent-runtime-supervisor.mjs', import.meta.url), 'utf8');
  const compose = readFileSync(new URL('../ops/agent-runtime-supervisor.compose.yml', import.meta.url), 'utf8');
  const docs = readFileSync(new URL('../docs/AGENT_RUNTIME_SUPERVISOR.md', import.meta.url), 'utf8');
  assert.match(script, /IOST_AGENT_KEY_FILE/);
  assert.match(script, /IOST_SUPERVISOR_CONTEXT_FILE/);
  assert.match(script, /SIGTERM/);
  assert.match(script, /cycle\('draining'\)/);
  assert.doesNotMatch(script, /trade|wallet-send|public-chain tool/i);
  assert.match(compose, /user: "10000:10000"/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop: \["ALL"\]/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /iost-terminal-agent-key:ro/);
  assert.match(compose, /--check/);
  assert.match(docs, /Writes the complete next heartbeat before sending/i);

  console.log('agent runtime supervisor checks passed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
