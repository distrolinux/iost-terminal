import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const scratch = mkdtempSync(join(tmpdir(), 'iost-agent-runtime-'));
process.env.IOST_DATA_DIR = scratch;

try {
  const runtime = await import('../lib/agent-runtime.js');
  const ownerId = 'runtime-owner';
  const keyId = 'runtime-key';
  const missionId = 'msn_runtime1';
  const startedAt = 1_800_000_000_000;
  const initial = runtime.recordAgentHeartbeat({
    ownerId, keyId, agentName: 'Hermes Paper Agent', sessionId: 'session-alpha-0001',
    sequence: 1, state: 'ready', stage: 'observe', missionId, cursor: 'market snapshot retained',
  }, startedAt);
  assert.equal(initial.status, 'ready');
  assert.equal(initial.enrolled, true);
  assert.equal(initial.heartbeat.intervalMs, 30_000);
  assert.equal(initial.execution.authorityExpanded, false);
  assert.equal(initial.liveScopeUsed, false);
  assert.equal(initial.publicChainUsed, false);
  assert.match(initial.checkpoint.checkpointId, /^cp_[a-f0-9-]{36}$/);
  assert.equal(initial.checkpoint.missionId, missionId);

  const replay = runtime.recordAgentHeartbeat({
    ownerId, keyId, agentName: 'Hermes Paper Agent', sessionId: 'session-alpha-0001',
    sequence: 1, state: 'ready', stage: 'observe', missionId, cursor: 'market snapshot retained',
  }, startedAt + 1_000);
  assert.equal(replay.heartbeat.replayed, true);
  assert.equal(replay.checkpoint.checkpointId, initial.checkpoint.checkpointId, 'idempotent replay must return the same checkpoint');
  assert.throws(() => runtime.recordAgentHeartbeat({
    ownerId, keyId, agentName: 'Hermes Paper Agent', sessionId: 'session-alpha-0001',
    sequence: 1, state: 'ready', stage: 'analyze', missionId,
  }, startedAt + 2_000), /sequence collision/);

  const second = runtime.recordAgentHeartbeat({
    ownerId, keyId, agentName: 'Hermes Paper Agent', sessionId: 'session-alpha-0001',
    sequence: 2, state: 'ready', stage: 'risk-check', missionId, cursor: 'preflight pending',
  }, startedAt + 20_000);
  assert.notEqual(second.checkpoint.checkpointId, initial.checkpoint.checkpointId);
  assert.equal(runtime.missionRuntimeGate({ ownerId, keyId, missionId }, startedAt + 30_000).ok, true);
  assert.equal(runtime.missionRuntimeGate({ ownerId, keyId, missionId: 'msn_other' }, startedAt + 30_000).reason, 'agent-runtime-mission-mismatch');
  assert.equal(runtime.agentRuntimeStatus(ownerId, keyId, startedAt + 70_000).status, 'degraded');
  assert.equal(runtime.missionRuntimeGate({ ownerId, keyId, missionId }, startedAt + 70_000).reason, 'agent-runtime-degraded');
  assert.equal(runtime.agentRuntimeStatus(ownerId, keyId, startedAt + 120_001).status, 'offline');

  assert.throws(() => runtime.recordAgentHeartbeat({
    ownerId, keyId, agentName: 'Hermes Paper Agent', sessionId: 'session-beta-0002',
    sequence: 1, state: 'ready', stage: 'verify', missionId, resumeFromCheckpointId: initial.checkpoint.checkpointId,
  }, startedAt + 120_001), /exact recovery checkpoint required/);
  assert.throws(() => runtime.recordAgentHeartbeat({
    ownerId, keyId, agentName: 'Hermes Paper Agent', sessionId: 'session-beta-0002',
    sequence: 1, state: 'ready', stage: 'verify', missionId: 'msn_other', resumeFromCheckpointId: second.checkpoint.checkpointId,
  }, startedAt + 120_001), /recovery mission must match checkpoint/);
  const recovered = runtime.recordAgentHeartbeat({
    ownerId, keyId, agentName: 'Hermes Paper Agent', sessionId: 'session-beta-0002',
    sequence: 1, state: 'ready', stage: 'verify', missionId, resumeFromCheckpointId: second.checkpoint.checkpointId,
  }, startedAt + 120_001);
  assert.equal(recovered.status, 'ready');
  assert.equal(recovered.session.recoveryCount, 1);
  assert.equal(recovered.recovery.lastOutcome, 'exact-checkpoint-resumed');
  assert.equal(runtime.missionRuntimeGate({ ownerId, keyId, missionId }, startedAt + 120_002).ok, true);

  assert.throws(() => runtime.recordAgentHeartbeat({
    ownerId, keyId, agentName: 'Conflicting Agent', sessionId: 'session-gamma-003',
    sequence: 1, state: 'ready', stage: 'idle', missionId,
    resumeFromCheckpointId: recovered.checkpoint.checkpointId,
  }, startedAt + 121_000), /active runtime session conflict/);

  const aggregate = runtime.ownerRuntimeStatus(ownerId, startedAt + 121_000);
  assert.equal(aggregate.counts.total, 1);
  assert.equal(aggregate.counts.ready, 1);
  assert.equal(aggregate.runtimes[0].runtimeRef, initial.runtimeRef);
  assert.equal(JSON.stringify(aggregate).includes(keyId), false, 'public runtime status must not expose key ids');
  assert.equal(JSON.stringify(aggregate).includes('session-beta-0002'), false, 'public runtime status must not expose session ids');
  assert.equal(runtime.ownerRuntimeStatus('other-owner', startedAt + 121_000).counts.total, 0);
  assert.equal(runtime.missionRuntimeGate({ ownerId: 'legacy-owner', keyId: 'legacy-key', missionId }, startedAt).monitored, false);

  assert.equal(statSync(runtime.runtimeStorePathForTest).mode & 0o777, 0o600);
  const stored = readFileSync(runtime.runtimeStorePathForTest, 'utf8');
  assert(stored.includes(keyId), 'private store retains the identity binding');

  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const protocol = readFileSync(new URL('../lib/mcp-protocol.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');
  assert.match(server, /app\.get\('\/api\/agent-runtime',\s*requireUser/);
  assert.match(server, /app\.post\('\/api\/agent-runtime\/heartbeat',\s*requireUser/);
  assert.match(server, /missionRuntimeGate\(/, 'mission execution must consult enrolled runtime readiness');
  assert.match(server, /\.\.\.\(req\.body \|\| \{\}\),\s*ownerId: req\.userAgent\.userId/, 'authenticated identity must override REST body fields');
  assert.match(protocol, /agent_runtime_status/);
  assert.match(protocol, /agent_runtime_heartbeat/);
  assert.match(app, /Agent Runtime Reliability/);
  assert.match(app, /newMissionExposureAllowed/);
  assert.match(css, /\.runtime-reliability/);

  const corruptDir = join(scratch, 'corrupt-state');
  mkdirSync(corruptDir);
  writeFileSync(join(corruptDir, 'agent-runtimes.json'), '{broken', { mode: 0o600 });
  const corruptImport = spawnSync(process.execPath, ['--input-type=module', '--eval', "await import('./lib/agent-runtime.js')"], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, IOST_DATA_DIR: corruptDir },
    encoding: 'utf8',
  });
  assert.notEqual(corruptImport.status, 0, 'corrupt runtime safety state must fail closed at load');
  assert.match(corruptImport.stderr, /agent runtime state is unreadable/);

  console.log('agent runtime reliability checks passed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
