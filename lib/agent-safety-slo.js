// Evidence-bound SLOs and deterministic recovery playbooks for paper agents.
//
// This module is intentionally pure and read-only. Runtime readiness and
// Incident Center supply the evidence; Incident Center remains the only
// quarantine/release authority.

import { DEGRADED_AFTER_MS } from './agent-runtime.js';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const AGENT_SAFETY_SLO_VERSION = 1;
export const SLO_TARGET = 0.99;
export const SLO_WINDOW_MS = 30 * 24 * 60 * 60_000;
export const MIN_EVIDENCE_MS = 60 * 60_000;

const BURN_WINDOWS = [
  { name: 'fast', longWindowMs: 60 * 60_000, shortWindowMs: 5 * 60_000, threshold: 14.4, notification: 'urgent-owner-review' },
  { name: 'slow', longWindowMs: 6 * 60 * 60_000, shortWindowMs: 30 * 60_000, threshold: 6, notification: 'owner-review' },
  { name: 'ticket', longWindowMs: 3 * 24 * 60 * 60_000, shortWindowMs: 6 * 60 * 60_000, threshold: 1, notification: 'planned-review' },
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 4) => Number(Number(value || 0).toFixed(digits));

export function ensureSloObservationEpoch(dataDir, now = Date.now()) {
  const file = join(dataDir, 'agent-slo-observation.json');
  const secure = () => {
    chmodSync(file, 0o600);
    if ((statSync(file).mode & 0o777) !== 0o600) throw new Error('agent SLO observation epoch permissions are not private');
  };
  if (existsSync(file)) {
    let parsed;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { throw new Error(`agent SLO observation epoch is unreadable: ${error.message}`); }
    if (parsed?.version !== AGENT_SAFETY_SLO_VERSION || !Number.isFinite(parsed.startedAt) || parsed.startedAt <= 0 || parsed.startedAt > now) {
      throw new Error('agent SLO observation epoch is invalid or from the future');
    }
    secure();
    return parsed.startedAt;
  }
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: AGENT_SAFETY_SLO_VERSION, startedAt: now }, null, 2), { mode: 0o600 });
  renameSync(tmp, file); secure();
  return now;
}

function mergeIntervals(intervals) {
  const sorted = intervals.filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (!last || start > last[1]) merged.push([start, end]);
    else last[1] = Math.max(last[1], end);
  }
  return merged;
}

function overlapMs(intervals, start, end) {
  return mergeIntervals(intervals.map(([from, to]) => [Math.max(from, start), Math.min(to, end)]))
    .reduce((sum, [from, to]) => sum + Math.max(0, to - from), 0);
}

function incidentInterval(incident, now) {
  if (incident.category === 'runtime-degraded') return [incident.openedAt, incident.resolvedAt || now];
  // Mission readiness stays unavailable after heartbeat recovery while the
  // incident quarantine is still awaiting owner review and resolution.
  if (incident.category === 'runtime-offline') return [incident.openedAt, incident.resolvedAt || now];
  if (incident.category === 'runtime-recovery-failure' && incident.quarantineApplied) {
    const applied = incident.timeline?.find((item) => item.type === 'runtime.quarantined')?.ts;
    return [applied || incident.lastSeenAt || incident.openedAt, incident.resolvedAt || now];
  }
  return null;
}

function playbookFor(incident) {
  const shared = {
    category: incident.category, severity: incident.severity, status: incident.status,
    ownerActionRequired: incident.ownerReviewRequired, automaticActionApplied: false,
    authorityExpanded: false,
  };
  if (incident.category === 'runtime-degraded') return { ...shared, playbook: 'late-heartbeat', actions: [
    'Verify agent process and network health.', 'Inspect the last durable checkpoint.',
    'Avoid restarting while heartbeats are merely delayed; Incident Center auto-resolves healthy recovery.',
  ] };
  if (incident.category === 'runtime-offline') return { ...shared, playbook: 'offline-runtime-recovery', actions: [
    'Confirm Position Guardian remains healthy for existing positions.', 'Restart only the affected agent runtime.',
    'Resume from the exact durable checkpoint.', 'After recovery is detected, acknowledge and resolve as owner.',
  ] };
  return { ...shared, playbook: 'rejected-recovery-containment', actions: [
    'Stop repeated recovery attempts.', 'Verify the active session and exact checkpoint out of band.',
    'Rotate the scoped agent key if compromise is suspected.', 'Recover once, then complete owner review.',
  ] };
}

function measurementFor(runtime, incidents, now, observationStartedAt) {
  const end = now;
  const start = Math.max(now - SLO_WINDOW_MS, observationStartedAt, Number(runtime.session?.startedAt || now));
  const intervals = incidents.filter((incident) => incident.runtimeRef === runtime.runtimeRef)
    .map((incident) => incidentInterval(incident, now)).filter(Boolean);
  // Current runtime state is a fail-closed fallback if an incident sweep has
  // not yet persisted the corresponding interval.
  if (runtime.status === 'degraded') intervals.push([Number(runtime.heartbeat?.lastAt || start) + DEGRADED_AFTER_MS, now]);
  if (runtime.status === 'offline') intervals.push([Number(runtime.heartbeat?.lastAt || start) + DEGRADED_AFTER_MS, now]);
  if (runtime.status === 'draining') intervals.push([Number(runtime.heartbeat?.lastAt || start), now]);
  if (runtime.quarantine?.active) intervals.push([Number(runtime.quarantine.appliedAt || start), now]);
  return { start, end, totalMs: Math.max(0, end - start), intervals: mergeIntervals(intervals) };
}

function burnRate(measurements, windowMs, now) {
  let totalMs = 0; let badMs = 0;
  for (const measurement of measurements) {
    const start = Math.max(measurement.start, now - windowMs);
    const observed = Math.max(0, now - start);
    totalMs += observed;
    badMs += overlapMs(measurement.intervals, start, now);
  }
  const errorRate = totalMs ? badMs / totalMs : 0;
  return { windowMs, observedMs: totalMs, badMs, errorRate: round(errorRate, 8), burnRate: round(errorRate / (1 - SLO_TARGET), 4) };
}

export function buildAgentSafetySlo({ runtime, incidents, now = Date.now(), observationStartedAt = now }) {
  const runtimes = runtime?.runtimes || [];
  const incidentList = incidents?.incidents || [];
  const measurements = runtimes.map((item) => measurementFor(item, incidentList, now, observationStartedAt));
  const observedMs = measurements.reduce((sum, item) => sum + item.totalMs, 0);
  const unavailableMs = measurements.reduce((sum, item) => sum + overlapMs(item.intervals, item.start, item.end), 0);
  const goodMs = Math.max(0, observedMs - unavailableMs);
  const availability = observedMs ? goodMs / observedMs : null;
  const allowedBadMs = observedMs * (1 - SLO_TARGET);
  const remainingMs = Math.max(0, allowedBadMs - unavailableMs);
  const burns = BURN_WINDOWS.map((rule) => {
    const long = burnRate(measurements, rule.longWindowMs, now);
    const short = burnRate(measurements, rule.shortWindowMs, now);
    return { ...rule, long, short, firing: long.burnRate >= rule.threshold && short.burnRate >= rule.threshold };
  });
  const activeIncidents = incidentList.filter((incident) => incident.status !== 'resolved');
  const evidenceSufficient = observedMs >= MIN_EVIDENCE_MS;
  const exhausted = observedMs > 0 && unavailableMs > allowedBadMs;
  const firing = burns.find((item) => item.firing) || null;
  const status = !runtimes.length ? 'not-enrolled'
    : !evidenceSufficient ? 'warming-up'
      : exhausted ? 'budget-exhausted'
        : firing ? 'budget-at-risk'
          : activeIncidents.length ? 'incident-active' : 'healthy';
  const reasonCode = status === 'not-enrolled' ? 'no-enrolled-runtime'
    : status === 'warming-up' ? 'insufficient-observation-window'
      : status === 'budget-exhausted' ? 'readiness-error-budget-exhausted'
        : status === 'budget-at-risk' ? `${firing.name}-burn-rate`
          : status === 'incident-active' ? 'active-runtime-incident' : 'slo-within-budget';

  return {
    ok: true, mode: 'paper-only', version: AGENT_SAFETY_SLO_VERSION, status, reasonCode,
    objective: {
      name: 'agent-mission-readiness', target: SLO_TARGET, targetPercent: SLO_TARGET * 100,
      windowMs: SLO_WINDOW_MS, indicator: 'runtime ready and free of incident quarantine',
    },
    evidence: {
      runtimeCount: runtimes.length, observedAgentMs: observedMs,
      observationStartedAt,
      minimumRequiredMs: MIN_EVIDENCE_MS, sufficient: evidenceSufficient,
      coveragePercent: runtimes.length ? round(clamp(observedMs / (SLO_WINDOW_MS * runtimes.length), 0, 1) * 100, 3) : 0,
    },
    sli: {
      availability: availability === null ? null : round(availability, 8),
      availabilityPercent: availability === null ? null : round(availability * 100, 4),
      goodMs, unavailableMs,
    },
    errorBudget: {
      allowedBadMs: round(allowedBadMs, 0), consumedMs: unavailableMs, remainingMs: round(remainingMs, 0),
      remainingPercent: allowedBadMs ? round(clamp(remainingMs / allowedBadMs, 0, 1) * 100, 2) : null,
      exhausted,
    },
    burnRates: burns,
    incidents: { active: activeIncidents.length, critical: activeIncidents.filter((item) => item.severity === 'critical').length },
    playbooks: activeIncidents.map(playbookFor),
    decision: {
      status, reasonCode, ownerActionRequired: exhausted || !!firing || activeIncidents.some((item) => item.ownerReviewRequired),
      enforcement: 'incident-center-only', executionPermissionsChanged: false,
    },
    guarantees: {
      readOnly: true, deterministic: true, honestEvidenceCoverage: true,
      automaticIncidentResolution: false, quarantineAuthority: 'agent-incident-center',
      existingPositionProtection: 'position-guardian', authorityExpanded: false,
    },
    liveScopeUsed: false, publicChainUsed: false,
  };
}
