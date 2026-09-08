// Monitor-only, privacy-preserving website security telemetry. This module
// retains bounded aggregate observations in memory; it never stores IPs,
// credentials, request bodies or authorization material and cannot block,
// trade or expand agent authority.

const WINDOW_MS = 15 * 60_000;
const RETENTION_MS = 24 * 60 * 60_000;
const MAX_OBSERVATIONS = 5_000;
const startedAt = Date.now();
const observations = [];

function classify({ path = '/', statusCode = 200, invalidBearer = false, credentialPresented = false, authFlow = false } = {}) {
  if (/\/(?:\.env|wp-admin|wp-login|phpmyadmin|\.git|cgi-bin)(?:\/|$)/i.test(path)) return 'probe';
  if (statusCode === 429) return 'rate-limited';
  if (statusCode >= 500) return 'server-error';
  if (invalidBearer || ((credentialPresented || authFlow) && (statusCode === 401 || statusCode === 403))) return 'auth-rejected';
  return null;
}

export function buildSecuritySentinel({ events = [], observationStartedAt = startedAt, now = Date.now() } = {}) {
  const recent = events.filter((event) => Number(event?.at) >= now - WINDOW_MS && Number(event?.at) <= now);
  const count = (kind) => recent.filter((event) => event.kind === kind).length;
  const counts = {
    authRejected: count('auth-rejected'),
    probes: count('probe'),
    rateLimited: count('rate-limited'),
    serverErrors: count('server-error'),
  };
  const findings = [
    counts.authRejected >= 20 && { code: 'authentication-rejection-spike', severity: 'high', count: counts.authRejected },
    counts.probes >= 10 && { code: 'automated-path-probing', severity: 'high', count: counts.probes },
    counts.rateLimited >= 20 && { code: 'resource-consumption-pressure', severity: 'medium', count: counts.rateLimited },
    counts.serverErrors >= 10 && { code: 'server-error-spike', severity: 'high', count: counts.serverErrors },
  ].filter(Boolean);
  const observedDurationMs = Math.max(0, now - Number(observationStartedAt || now));
  const evidenceSufficient = observedDurationMs >= WINDOW_MS;
  const status = findings.some((item) => item.severity === 'high') ? 'attention'
    : evidenceSufficient ? 'healthy' : 'warming-up';
  return {
    ok: true,
    mode: 'monitor-only',
    version: 1,
    status,
    reasonCode: findings[0]?.code || (evidenceSufficient ? 'security-observation-clear' : 'insufficient-observation-window'),
    windowMs: WINDOW_MS,
    observedDurationMs,
    evidenceSufficient,
    counts,
    findings,
    policy: {
      authenticationRejectionThreshold: 20,
      pathProbeThreshold: 10,
      rateLimitThreshold: 20,
      serverErrorThreshold: 10,
      retentionMs: RETENTION_MS,
      maximumObservations: MAX_OBSERVATIONS,
    },
    guarantees: {
      monitorOnly: true,
      storesIpAddresses: false,
      storesCredentials: false,
      storesRequestBodies: false,
      boundedRetention: true,
      failClosedLiveReadiness: true,
      enforcementAuthority: 'infrastructure-and-owner-controls',
    },
    executionPermissionsChanged: false,
    authorityExpanded: false,
    liveScopeUsed: false,
    publicChainUsed: false,
  };
}

export function observeSecurityResponse(input = {}, now = Date.now()) {
  const kind = classify(input);
  if (!kind) return;
  observations.push({ at: now, kind });
  const oldest = now - RETENTION_MS;
  while (observations.length && (observations[0].at < oldest || observations.length > MAX_OBSERVATIONS)) observations.shift();
}

export function securitySentinelStatus(now = Date.now()) {
  return buildSecuritySentinel({ events: observations, observationStartedAt: startedAt, now });
}
