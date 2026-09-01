import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildAgentSafetySlo, ensureSloObservationEpoch } from '../lib/agent-safety-slo.js';

const now = 1_800_000_000_000;
const observationStartedAt = now - 3 * 60 * 60_000;
const build = (input) => buildAgentSafetySlo({ ...input, observationStartedAt });
const runtime = { runtimes: [{ runtimeRef: 'rt_aaaaaaaaaaaaaaaaaaaaaaaa', status: 'ready', session: { startedAt: now - 2 * 60 * 60_000 }, execution: { newMissionExposureAllowed: true } }] };
const empty = build({ runtime, incidents: { incidents: [] }, now });
assert.equal(empty.status, 'healthy');
assert.equal(empty.sli.availabilityPercent, 100);
assert.equal(empty.errorBudget.remainingPercent, 100);
assert.equal(empty.evidence.sufficient, true);
assert.equal(empty.guarantees.readOnly, true);

const incident = {
  incidentRef: 'inc_00000000-0000-0000-0000-000000000001', runtimeRef: runtime.runtimes[0].runtimeRef,
  category: 'runtime-offline', severity: 'critical', status: 'recovery-detected',
  openedAt: now - 20 * 60_000, recoveredAt: now - 5 * 60_000, resolvedAt: null,
  lastSeenAt: now - 5 * 60_000, quarantineApplied: true, ownerReviewRequired: true,
  timeline: [{ ts: now - 20 * 60_000, type: 'runtime.quarantined', detail: null }],
};
const breached = build({ runtime, incidents: { incidents: [incident] }, now });
assert.equal(breached.status, 'budget-exhausted');
assert.equal(breached.errorBudget.exhausted, true);
assert(breached.burnRates.some((item) => item.firing));
assert.equal(breached.playbooks[0].playbook, 'offline-runtime-recovery');
assert.equal(breached.playbooks[0].automaticActionApplied, false);
assert.equal(breached.decision.executionPermissionsChanged, false);
assert.equal(breached.liveScopeUsed, false);
assert.equal(breached.publicChainUsed, false);

const warming = build({ runtime: { runtimes: [{ ...runtime.runtimes[0], session: { startedAt: now - 10_000 } }] }, incidents: { incidents: [] }, now });
assert.equal(warming.status, 'warming-up');
const newlyObserved = buildAgentSafetySlo({ runtime, incidents: { incidents: [] }, now, observationStartedAt: now - 10_000 });
assert.equal(newlyObserved.status, 'warming-up', 'history before SLO observation began must not count as evidence');
const draining = build({ runtime: { runtimes: [{ ...runtime.runtimes[0], status: 'draining', heartbeat: { lastAt: now - 30 * 60_000 } }] }, incidents: { incidents: [] }, now });
assert.equal(draining.errorBudget.exhausted, true, 'current fail-closed state must count even before incident persistence');
assert.equal(build({ runtime: { runtimes: [] }, incidents: { incidents: [] }, now }).status, 'not-enrolled');

const scratch = mkdtempSync(join(tmpdir(), 'iost-agent-slo-'));
try {
  assert.equal(ensureSloObservationEpoch(scratch, now), now);
  const epochFile = join(scratch, 'agent-slo-observation.json');
  assert.equal(statSync(epochFile).mode & 0o777, 0o600);
  assert.equal(ensureSloObservationEpoch(scratch, now + 60_000), now, 'observation epoch must survive restart');
  writeFileSync(epochFile, '{broken', { mode: 0o600 });
  assert.throws(() => ensureSloObservationEpoch(scratch, now + 60_000), /unreadable/, 'corrupt evidence must fail closed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const protocol = readFileSync(new URL('../lib/mcp-protocol.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');
assert.match(server, /agentSafetySlo\.buildAgentSafetySlo/);
assert.match(server, /\/api\/agent-safety-slo/);
assert.match(protocol, /agent_safety_slo_status/);
assert.match(app, /Agent Safety Playbook &amp; SLO Center/);
assert.match(css, /\.safety-slo/);

console.log('agent safety SLO and playbook checks passed');
