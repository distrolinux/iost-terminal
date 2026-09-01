import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const scratch = mkdtempSync(join(tmpdir(), 'iost-agent-incidents-'));
process.env.IOST_DATA_DIR = scratch;

try {
  const runtime = await import('../lib/agent-runtime.js');
  const incidents = await import('../lib/agent-incidents.js');
  const ownerId = 'incident-owner';
  const keyId = 'incident-key';
  const missionId = 'msn_incident1';
  const startedAt = 1_800_100_000_000;

  const initial = runtime.recordAgentHeartbeat({
    ownerId, keyId, agentName: 'Incident Test Agent', sessionId: 'incident-session-alpha',
    sequence: 1, state: 'ready', stage: 'observe', missionId,
  }, startedAt);

  incidents.reconcileRuntimeIncidents(runtime.runtimeIncidentInputs(startedAt + 70_000), startedAt + 70_000);
  let status = incidents.ownerIncidentStatus(ownerId, startedAt + 70_000);
  assert.equal(status.counts.open, 1);
  assert.equal(status.incidents[0].category, 'runtime-degraded');
  assert.equal(status.incidents[0].severity, 'warning');
  assert.equal(status.incidents[0].quarantineApplied, false);

  const second = runtime.recordAgentHeartbeat({
    ownerId, keyId, agentName: 'Incident Test Agent', sessionId: 'incident-session-alpha',
    sequence: 2, state: 'ready', stage: 'risk-check', missionId,
  }, startedAt + 70_001);
  incidents.reconcileRuntimeIncidents(runtime.runtimeIncidentInputs(startedAt + 70_001), startedAt + 70_001);
  status = incidents.ownerIncidentStatus(ownerId, startedAt + 70_001);
  assert.equal(status.counts.open, 0, 'degraded symptom should auto-resolve after a healthy heartbeat');

  incidents.reconcileRuntimeIncidents(runtime.runtimeIncidentInputs(startedAt + 170_100), startedAt + 170_100);
  status = incidents.ownerIncidentStatus(ownerId, startedAt + 170_100);
  const offline = status.incidents.find((incident) => incident.category === 'runtime-offline');
  assert(offline);
  assert.equal(offline.severity, 'critical');
  assert.equal(offline.quarantineApplied, true);
  assert.equal(status.counts.quarantined, 1);
  assert.equal(runtime.missionRuntimeGate({ ownerId, keyId, missionId }, startedAt + 170_100).reason, 'agent-runtime-quarantined');

  runtime.recordAgentHeartbeat({
    ownerId, keyId, agentName: 'Incident Test Agent', sessionId: 'incident-session-beta',
    sequence: 1, state: 'ready', stage: 'verify', missionId,
    resumeFromCheckpointId: second.checkpoint.checkpointId,
  }, startedAt + 170_101);
  incidents.reconcileRuntimeIncidents(runtime.runtimeIncidentInputs(startedAt + 170_101), startedAt + 170_101);
  status = incidents.ownerIncidentStatus(ownerId, startedAt + 170_101);
  const recovered = status.incidents.find((incident) => incident.incidentRef === offline.incidentRef);
  assert.equal(recovered.status, 'recovery-detected');
  assert.equal(recovered.recoveryReady, true);
  assert.throws(() => incidents.resolveIncident(ownerId, offline.incidentRef, startedAt + 170_102), /acknowledged/);
  incidents.acknowledgeIncident(ownerId, offline.incidentRef, startedAt + 170_102);
  incidents.resolveIncident(ownerId, offline.incidentRef, startedAt + 170_103);
  assert.equal(runtime.agentRuntimeStatus(ownerId, keyId, startedAt + 170_103).quarantine.active, false);
  assert.equal(runtime.missionRuntimeGate({ ownerId, keyId, missionId }, startedAt + 170_103).ok, true);

  for (let attempt = 0; attempt < 3; attempt++) {
    incidents.recordRuntimeFailure({
      ownerId, keyId, runtimeRef: initial.runtimeRef, name: 'Incident Test Agent',
      reasonCode: 'exact recovery checkpoint required',
    }, startedAt + 180_000 + attempt);
  }
  status = incidents.ownerIncidentStatus(ownerId, startedAt + 180_003);
  const failures = status.incidents.find((incident) => incident.category === 'runtime-recovery-failure' && incident.status !== 'resolved');
  assert.equal(failures.occurrenceCount, 3);
  assert.equal(failures.severity, 'critical');
  assert.equal(failures.quarantineApplied, true);
  assert.equal(failures.recoveryReady, true);
  assert.equal(runtime.agentRuntimeStatus(ownerId, keyId, startedAt + 180_003).execution.newMissionExposureAllowed, false);
  incidents.acknowledgeIncident(ownerId, failures.incidentRef, startedAt + 180_004);
  incidents.resolveIncident(ownerId, failures.incidentRef, startedAt + 180_005);
  assert.equal(runtime.agentRuntimeStatus(ownerId, keyId, startedAt + 180_005).quarantine.active, false);

  const publicJson = JSON.stringify(incidents.ownerIncidentStatus(ownerId, startedAt + 180_006));
  assert.equal(publicJson.includes(ownerId), false);
  assert.equal(publicJson.includes(keyId), false);
  assert.equal(publicJson.includes('incident-session'), false);
  assert.equal(incidents.ownerIncidentStatus('other-owner', startedAt + 180_006).incidents.length, 0);
  assert.equal(statSync(incidents.incidentStorePathForTest).mode & 0o777, 0o600);
  assert.equal(statSync(runtime.runtimeStorePathForTest).mode & 0o777, 0o600);
  assert(readFileSync(incidents.incidentStorePathForTest, 'utf8').includes(keyId), 'private store retains identity binding');

  const corruptDir = join(scratch, 'corrupt-incidents');
  mkdirSync(corruptDir);
  writeFileSync(join(corruptDir, 'agent-incidents.json'), '{broken', { mode: 0o600 });
  const corruptImport = spawnSync(process.execPath, ['--input-type=module', '--eval', "await import('./lib/agent-incidents.js')"], {
    cwd: new URL('../', import.meta.url), env: { ...process.env, IOST_DATA_DIR: corruptDir }, encoding: 'utf8',
  });
  assert.notEqual(corruptImport.status, 0);
  assert.match(corruptImport.stderr, /agent incident state is unreadable/);

  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const protocol = readFileSync(new URL('../lib/mcp-protocol.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');
  assert.match(server, /agentIncidents\.reconcileRuntimeIncidents/);
  assert.match(server, /app\.get\('\/api\/agent-incidents',\s*requireUser/);
  assert.match(server, /agent\.incident\.\$\{action\}/);
  assert.match(protocol, /agent_incident_status/);
  assert.match(app, /Agent Incident &amp; Recovery Center/);
  assert.match(app, /data-incident-action="acknowledge"/);
  assert.match(app, /data-incident-action="resolve"/);
  assert.match(css, /\.incident-recovery/);

  console.log('agent incident and recovery checks passed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
