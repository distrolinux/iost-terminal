// Durable, deduplicated incident lifecycle for agent runtime health.
//
// Incidents can restrict new mission exposure through runtime quarantine, but
// can never grant authority. Existing position protection remains delegated to
// Position Guardian. Owner acknowledgement records review; owner resolution is
// permitted only after the runtime has recovered to ready.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as agentRuntime from './agent-runtime.js';

const DATA_DIR = process.env.IOST_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA_DIR, 'agent-incidents.json');
export const AGENT_INCIDENT_VERSION = 1;
export const RECOVERY_FAILURE_WINDOW_MS = 10 * 60_000;
export const RECOVERY_FAILURE_QUARANTINE_THRESHOLD = 3;
const MAX_INCIDENTS = 500;
const MAX_TIMELINE = 100;
const ACTIVE = new Set(['open', 'recovery-detected']);
const CATEGORIES = new Set(['runtime-degraded', 'runtime-offline', 'runtime-recovery-failure']);
const SEVERITIES = new Set(['warning', 'critical']);
const STATUSES = new Set(['open', 'recovery-detected', 'resolved']);

const clean = (value, max) => String(value || '').trim().slice(0, max);
const incidentRef = () => `inc_${crypto.randomUUID()}`;
const nullableFinite = (value) => value === null || Number.isFinite(value);

function validTimeline(timeline) {
  return Array.isArray(timeline) && timeline.length <= MAX_TIMELINE && timeline.every((entry) => entry
    && typeof entry === 'object' && /^[a-f0-9-]{36}$/.test(entry.eventId || '')
    && Number.isFinite(entry.ts) && typeof entry.type === 'string' && entry.type.length > 0 && entry.type.length <= 80
    && (entry.detail === null || (typeof entry.detail === 'string' && entry.detail.length <= 160)));
}

function validIncident(incident) {
  return incident && typeof incident === 'object'
    && /^inc_[a-f0-9-]{36}$/.test(incident.incidentRef || '')
    && typeof incident.ownerId === 'string' && incident.ownerId.length > 0
    && typeof incident.keyId === 'string' && incident.keyId.length > 0
    && /^rt_[a-f0-9]{24}$/.test(incident.runtimeRef || '')
    && CATEGORIES.has(incident.category) && SEVERITIES.has(incident.severity)
    && STATUSES.has(incident.status) && Number.isFinite(incident.openedAt)
    && Number.isFinite(incident.lastSeenAt) && Number.isSafeInteger(incident.occurrenceCount)
    && nullableFinite(incident.recoveredAt) && nullableFinite(incident.acknowledgedAt)
    && nullableFinite(incident.resolvedAt) && typeof incident.quarantineApplied === 'boolean'
    && typeof incident.reasonCode === 'string' && incident.reasonCode.length <= 80
    && typeof incident.summary === 'string' && incident.summary.length <= 240
    && incident.occurrenceCount >= 1 && validTimeline(incident.timeline);
}

function loadStore() {
  if (!existsSync(FILE)) return { version: AGENT_INCIDENT_VERSION, incidents: [] };
  let parsed;
  try { parsed = JSON.parse(readFileSync(FILE, 'utf8')); }
  catch (error) { throw new Error(`agent incident state is unreadable: ${error.message}`); }
  const refs = Array.isArray(parsed?.incidents) ? parsed.incidents.map((incident) => incident?.incidentRef) : [];
  if (parsed?.version !== AGENT_INCIDENT_VERSION || !Array.isArray(parsed.incidents)
      || parsed.incidents.some((incident) => !validIncident(incident))
      || new Set(refs).size !== refs.length) {
    throw new Error('agent incident state is invalid or uses an unsupported version');
  }
  return parsed;
}

let store = loadStore();

function save() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, FILE);
  chmodSync(FILE, 0o600);
}

function event(incident, type, now, detail = null) {
  incident.timeline.push({ eventId: crypto.randomUUID(), ts: now, type, detail: clean(detail, 160) || null });
  if (incident.timeline.length > MAX_TIMELINE) incident.timeline.splice(0, incident.timeline.length - MAX_TIMELINE);
}

function activeIncident(ownerId, keyId, category) {
  return store.incidents.find((incident) => incident.ownerId === ownerId && incident.keyId === keyId
    && incident.category === category && ACTIVE.has(incident.status)) || null;
}

function createIncident(input, now) {
  const incident = {
    incidentRef: incidentRef(), ownerId: input.ownerId, keyId: input.keyId,
    runtimeRef: input.runtimeRef, agentName: clean(input.name, 80) || 'Agent',
    category: input.category, severity: input.severity, status: 'open',
    reasonCode: input.reasonCode, summary: input.summary,
    openedAt: now, lastSeenAt: now, recoveredAt: null, acknowledgedAt: null,
    resolvedAt: null, occurrenceCount: 1, quarantineApplied: false, timeline: [],
  };
  event(incident, 'incident.opened', now, input.reasonCode);
  store.incidents.push(incident);
  if (store.incidents.length > MAX_INCIDENTS) {
    const resolvedIndex = store.incidents.findIndex((item) => item.status === 'resolved');
    store.incidents.splice(resolvedIndex >= 0 ? resolvedIndex : 0, 1);
  }
  return incident;
}

function quarantine(incident, now) {
  if (incident.quarantineApplied) return;
  agentRuntime.applyRuntimeQuarantine(incident.ownerId, incident.keyId, {
    incidentRef: incident.incidentRef, reasonCode: incident.reasonCode,
  }, now);
  incident.quarantineApplied = true;
  event(incident, 'runtime.quarantined', now, incident.reasonCode);
}

function publicIncident(incident) {
  return {
    incidentRef: incident.incidentRef, runtimeRef: incident.runtimeRef, agentName: incident.agentName,
    category: incident.category, severity: incident.severity, status: incident.status,
    reasonCode: incident.reasonCode, summary: incident.summary,
    openedAt: incident.openedAt, lastSeenAt: incident.lastSeenAt,
    recoveredAt: incident.recoveredAt, acknowledgedAt: incident.acknowledgedAt,
    resolvedAt: incident.resolvedAt, occurrenceCount: incident.occurrenceCount,
    quarantineApplied: incident.quarantineApplied,
    ownerReviewRequired: incident.quarantineApplied && incident.status !== 'resolved',
    recoveryReady: incident.status === 'recovery-detected',
    timeline: incident.timeline.map(({ ts, type, detail }) => ({ ts, type, detail })),
  };
}

function recoveryFailureDetail(reason) {
  const value = String(reason || '').toLowerCase();
  if (value.includes('checkpoint')) return 'exact-checkpoint-required';
  if (value.includes('session')) return 'active-session-conflict';
  if (value.includes('sequence')) return 'invalid-sequence';
  return 'invalid-runtime-heartbeat';
}

export function reconcileRuntimeIncidents(runtimeInputs = agentRuntime.runtimeIncidentInputs(), now = Date.now()) {
  let changed = false;
  for (const runtime of runtimeInputs) {
    const degraded = activeIncident(runtime.ownerId, runtime.keyId, 'runtime-degraded');
    if (runtime.status === 'degraded') {
      if (!degraded) {
        createIncident({ ...runtime, category: 'runtime-degraded', severity: 'warning',
          reasonCode: 'heartbeat-degraded', summary: 'Agent heartbeat is late; new mission exposure is blocked by runtime readiness.' }, now);
        changed = true;
      } else degraded.lastSeenAt = now;
    } else if (degraded) {
      degraded.status = 'resolved'; degraded.resolvedAt = now;
      event(degraded, 'incident.auto-resolved', now, `runtime-${runtime.status}`); changed = true;
    }

    let offline = activeIncident(runtime.ownerId, runtime.keyId, 'runtime-offline');
    if (runtime.status === 'offline') {
      if (!offline) {
        offline = createIncident({ ...runtime, category: 'runtime-offline', severity: 'critical',
          reasonCode: 'heartbeat-offline', summary: 'Agent heartbeat lease expired; runtime quarantined pending recovery and owner review.' }, now);
        changed = true;
      } else {
        offline.lastSeenAt = now;
        if (offline.status === 'recovery-detected') {
          offline.status = 'open'; offline.recoveredAt = null; offline.occurrenceCount += 1;
          event(offline, 'runtime.recovery-relapsed', now, 'offline'); changed = true;
        }
      }
      if (!offline.quarantineApplied) { quarantine(offline, now); changed = true; }
    } else if (offline && runtime.status === 'ready' && offline.status !== 'recovery-detected') {
      offline.status = 'recovery-detected'; offline.recoveredAt = now; offline.lastSeenAt = now;
      event(offline, 'runtime.recovery-detected', now, 'ready'); changed = true;
    }

    const recoveryFailure = activeIncident(runtime.ownerId, runtime.keyId, 'runtime-recovery-failure');
    if (recoveryFailure?.quarantineApplied && runtime.status === 'ready' && recoveryFailure.status !== 'recovery-detected') {
      recoveryFailure.status = 'recovery-detected'; recoveryFailure.recoveredAt = now;
      event(recoveryFailure, 'runtime.recovery-detected', now, 'ready'); changed = true;
    } else if (recoveryFailure && !recoveryFailure.quarantineApplied
        && now - recoveryFailure.lastSeenAt > RECOVERY_FAILURE_WINDOW_MS) {
      recoveryFailure.status = 'resolved'; recoveryFailure.resolvedAt = now;
      event(recoveryFailure, 'incident.auto-resolved', now, 'failure-window-elapsed'); changed = true;
    }
  }
  if (changed) save();
  return changed;
}

export function recordRuntimeFailure({ ownerId, keyId, runtimeRef, name, reasonCode }, now = Date.now()) {
  if (!ownerId || !keyId || !runtimeRef) return null;
  let incident = activeIncident(ownerId, keyId, 'runtime-recovery-failure');
  if (!incident || now - incident.lastSeenAt > RECOVERY_FAILURE_WINDOW_MS) {
    incident = createIncident({ ownerId, keyId, runtimeRef, name,
      category: 'runtime-recovery-failure', severity: 'warning',
      reasonCode: 'runtime-recovery-rejected', summary: 'Repeated runtime session or checkpoint recovery attempts require review.' }, now);
  } else {
    if (incident.status === 'recovery-detected') {
      incident.status = 'open'; incident.recoveredAt = null;
      event(incident, 'runtime.recovery-relapsed', now, recoveryFailureDetail(reasonCode));
    }
    incident.occurrenceCount += 1;
    incident.lastSeenAt = now;
    event(incident, 'runtime.recovery-rejected', now, recoveryFailureDetail(reasonCode));
  }
  if (incident.occurrenceCount >= RECOVERY_FAILURE_QUARANTINE_THRESHOLD) {
    incident.severity = 'critical';
    if (!incident.quarantineApplied) quarantine(incident, now);
  }
  save();
  return publicIncident(incident);
}

function incidentStatusFor(ownerId, keyId = null, now = Date.now(), { reconcile = true } = {}) {
  if (reconcile) reconcileRuntimeIncidents(agentRuntime.runtimeIncidentInputs(now), now);
  const incidents = store.incidents.filter((incident) => incident.ownerId === ownerId && (!keyId || incident.keyId === keyId));
  const current = incidents.filter((incident) => incident.status !== 'resolved');
  return {
    ok: true, mode: 'paper-only', version: AGENT_INCIDENT_VERSION,
    policy: {
      degradedAfterMs: agentRuntime.DEGRADED_AFTER_MS, offlineAfterMs: agentRuntime.OFFLINE_AFTER_MS,
      recoveryFailureWindowMs: RECOVERY_FAILURE_WINDOW_MS,
      recoveryFailureQuarantineThreshold: RECOVERY_FAILURE_QUARANTINE_THRESHOLD,
      notificationChannel: 'owner-control-center',
    },
    counts: {
      total: incidents.length, open: current.length,
      critical: current.filter((incident) => incident.severity === 'critical').length,
      recoveryReady: current.filter((incident) => incident.status === 'recovery-detected').length,
      quarantined: current.filter((incident) => incident.quarantineApplied).length,
    },
    incidents: incidents.slice().sort((a, b) => b.lastSeenAt - a.lastSeenAt).map(publicIncident),
    guarantees: {
      deduplicated: true, symptomBased: true, ownerReleaseRequired: true,
      existingPositionProtection: 'position-guardian', authorityExpanded: false,
    },
    liveScopeUsed: false, publicChainUsed: false,
  };
}

export function ownerIncidentStatus(ownerId, now = Date.now()) { return incidentStatusFor(ownerId, null, now); }
export function agentIncidentStatus(ownerId, keyId, now = Date.now()) { return incidentStatusFor(ownerId, keyId, now); }
// Execution preflight is contractually read-only. It may inspect the latest
// durable incident state, while current runtime health is checked separately.
export function peekAgentIncidentStatus(ownerId, keyId, now = Date.now()) {
  return incidentStatusFor(ownerId, keyId, now, { reconcile: false });
}

// Private routing index. Identity values never leave the server; this lets the
// background alert sweep cover owners even when their dashboard is closed.
export function incidentOwnerIdsForRouting() {
  return [...new Set(store.incidents.map((incident) => incident.ownerId))];
}

// Private alert-router evidence retains the key binding needed for agent-level
// isolation. API and MCP incident views intentionally omit this field.
export function incidentAlertInputsForRouting(ownerId) {
  return store.incidents.filter((incident) => incident.ownerId === ownerId)
    .map((incident) => ({ ...publicIncident(incident), keyId: incident.keyId }));
}

export function acknowledgeIncident(ownerId, ref, now = Date.now()) {
  const incident = store.incidents.find((item) => item.ownerId === ownerId && item.incidentRef === ref) || null;
  if (!incident) throw new Error('incident not found');
  if (incident.status === 'resolved') return publicIncident(incident);
  if (!incident.acknowledgedAt) {
    incident.acknowledgedAt = now;
    event(incident, 'owner.acknowledged', now);
    save();
  }
  return publicIncident(incident);
}

export function resolveIncident(ownerId, ref, now = Date.now()) {
  const incident = store.incidents.find((item) => item.ownerId === ownerId && item.incidentRef === ref) || null;
  if (!incident) throw new Error('incident not found');
  if (incident.status === 'resolved') return publicIncident(incident);
  if (!incident.acknowledgedAt) throw new Error('incident must be acknowledged before resolution');
  if (incident.quarantineApplied) {
    agentRuntime.releaseRuntimeQuarantine(ownerId, incident.keyId, incident.incidentRef, now);
  }
  incident.status = 'resolved'; incident.resolvedAt = now;
  event(incident, 'owner.resolved', now); save();
  return publicIncident(incident);
}

export function secureAgentIncidentPermissions() { if (existsSync(FILE)) chmodSync(FILE, 0o600); }
export const incidentStorePathForTest = FILE;
