// Durable, owner-isolated delivery for agent safety alerts.
//
// The router is notification-only. It consumes Incident Center and Safety SLO
// evidence, writes a private outbox, and optionally delivers signed CloudEvents
// to one host-configured HTTPS endpoint. It cannot acknowledge incidents,
// release quarantine, change execution permissions, or invoke trading code.

import crypto from 'node:crypto';
import { promises as dns } from 'node:dns';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.IOST_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA_DIR, 'owner-alert-router.json');
export const OWNER_ALERT_ROUTER_VERSION = 1;
export const MAX_DELIVERY_ATTEMPTS = 6;
export const DELIVERY_TIMEOUT_MS = 5_000;
const MAX_ALERTS = 500;
const MAX_RECEIPTS = 1_000;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 600_000];
const ALERT_STATUSES = new Set(['active', 'recovery-ready', 'resolved']);
const SEVERITIES = new Set(['info', 'warning', 'critical']);
const DELIVERY_STATUSES = new Set(['disabled', 'pending', 'retrying', 'delivered', 'dead-letter']);

const clean = (value, max) => String(value || '').trim().slice(0, max);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const webhookConfigured = () => Boolean(process.env.IOST_OWNER_ALERT_WEBHOOK_URL && process.env.IOST_OWNER_ALERT_WEBHOOK_SECRET_FILE);

function validAlert(alert) {
  return alert && typeof alert === 'object' && /^alr_[a-f0-9-]{36}$/.test(alert.alertRef || '')
    && /^[a-f0-9-]{36}$/.test(alert.eventId || '') && typeof alert.ownerId === 'string' && alert.ownerId.length > 0
    && (alert.keyId === null || (typeof alert.keyId === 'string' && alert.keyId.length > 0))
    && typeof alert.dedupKey === 'string' && alert.dedupKey.length > 0 && alert.dedupKey.length <= 240
    && ['incident', 'slo'].includes(alert.sourceKind) && typeof alert.sourceRef === 'string'
    && SEVERITIES.has(alert.severity) && ALERT_STATUSES.has(alert.status)
    && typeof alert.reasonCode === 'string' && alert.reasonCode.length <= 80
    && typeof alert.title === 'string' && alert.title.length <= 160
    && typeof alert.summary === 'string' && alert.summary.length <= 320
    && Number.isFinite(alert.createdAt) && Number.isFinite(alert.lastObservedAt)
    && Number.isSafeInteger(alert.occurrenceCount) && alert.occurrenceCount >= 1
    && alert.delivery && alert.delivery.controlCenter?.status === 'delivered'
    && DELIVERY_STATUSES.has(alert.delivery.webhook?.status)
    && Number.isSafeInteger(alert.delivery.webhook.attempts)
    && (alert.delivery.webhook.nextAttemptAt === null || Number.isFinite(alert.delivery.webhook.nextAttemptAt));
}

function receiptHash(receipt) {
  const canonical = JSON.stringify({
    receiptRef: receipt.receiptRef, alertRef: receipt.alertRef, ownerId: receipt.ownerId,
    channel: receipt.channel, outcome: receipt.outcome, statusCode: receipt.statusCode,
    attempt: receipt.attempt, at: receipt.at, previousHash: receipt.previousHash,
  });
  return sha256(canonical);
}

function validReceipts(receipts) {
  if (!Array.isArray(receipts) || receipts.length > MAX_RECEIPTS) return false;
  let previousHash = null;
  for (const receipt of receipts) {
    if (!receipt || !/^alr_rcpt_[a-f0-9-]{36}$/.test(receipt.receiptRef || '')
      || !/^alr_[a-f0-9-]{36}$/.test(receipt.alertRef || '') || typeof receipt.ownerId !== 'string'
      || !['owner-control-center', 'signed-webhook'].includes(receipt.channel)
      || !['delivered', 'retrying', 'dead-letter'].includes(receipt.outcome)
      || (receipt.statusCode !== null && !Number.isInteger(receipt.statusCode))
      || !Number.isSafeInteger(receipt.attempt) || !Number.isFinite(receipt.at)
      || receipt.previousHash !== previousHash || receipt.hash !== receiptHash(receipt)) return false;
    previousHash = receipt.hash;
  }
  return true;
}

function loadStore() {
  if (!existsSync(FILE)) return { value: { version: OWNER_ALERT_ROUTER_VERSION, alerts: [], receipts: [], sloSignals: {} }, migrated: false };
  let parsed;
  try { parsed = JSON.parse(readFileSync(FILE, 'utf8')); }
  catch (error) { throw new Error(`owner alert state is unreadable: ${error.message}`); }
  // v1 originally persisted Incident Center's `open` status verbatim even
  // though the router's durable schema uses `active`. Normalize that exact
  // legacy shape before validation. Alert status is not part of receipt hashes.
  let migrated = false;
  if (parsed?.version === OWNER_ALERT_ROUTER_VERSION && Array.isArray(parsed.alerts)) {
    for (const alert of parsed.alerts) {
      if (alert?.sourceKind === 'incident' && alert.status === 'open') {
        alert.status = 'active'; migrated = true;
      }
    }
  }
  const dedup = Array.isArray(parsed?.alerts) ? parsed.alerts.map((alert) => `${alert.ownerId}:${alert.dedupKey}`) : [];
  if (parsed?.version !== OWNER_ALERT_ROUTER_VERSION || !Array.isArray(parsed.alerts)
    || parsed.alerts.length > MAX_ALERTS || parsed.alerts.some((alert) => !validAlert(alert))
    || new Set(dedup).size !== dedup.length || !validReceipts(parsed.receipts)
    || !parsed.sloSignals || typeof parsed.sloSignals !== 'object' || Array.isArray(parsed.sloSignals)) {
    throw new Error('owner alert state is invalid or uses an unsupported version');
  }
  return { value: parsed, migrated };
}

const loadedStore = loadStore();
let store = loadedStore.value;

function save() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, FILE); chmodSync(FILE, 0o600);
}

if (loadedStore.migrated) save();

function appendReceipt(alert, { channel, outcome, statusCode = null, attempt = 1 }, now) {
  const previousHash = store.receipts.at(-1)?.hash || null;
  const receipt = {
    receiptRef: `alr_rcpt_${crypto.randomUUID()}`, alertRef: alert.alertRef, ownerId: alert.ownerId,
    channel, outcome, statusCode, attempt, at: now, previousHash,
  };
  receipt.hash = receiptHash(receipt);
  store.receipts.push(receipt);
  if (store.receipts.length > MAX_RECEIPTS) {
    // A hash chain cannot be truncated without changing its first link. Retain
    // the bounded suffix and explicitly re-anchor it as a new local chain.
    store.receipts = store.receipts.slice(-MAX_RECEIPTS);
    let prior = null;
    for (const item of store.receipts) { item.previousHash = prior; item.hash = receiptHash(item); prior = item.hash; }
  }
  return receipt;
}

function createAlert(input, now) {
  const alert = {
    alertRef: `alr_${crypto.randomUUID()}`, eventId: crypto.randomUUID(),
    ownerId: input.ownerId, keyId: input.keyId || null, dedupKey: input.dedupKey,
    sourceKind: input.sourceKind, sourceRef: clean(input.sourceRef, 80),
    severity: input.severity, status: input.status, reasonCode: clean(input.reasonCode, 80),
    title: clean(input.title, 160), summary: clean(input.summary, 320),
    createdAt: now, lastObservedAt: now, occurrenceCount: 1,
    delivery: {
      controlCenter: { status: 'delivered', deliveredAt: now },
      webhook: { status: webhookConfigured() ? 'pending' : 'disabled', attempts: 0, nextAttemptAt: webhookConfigured() ? now : null, lastAttemptAt: null, lastStatusCode: null, lastError: null },
    },
  };
  store.alerts.push(alert);
  appendReceipt(alert, { channel: 'owner-control-center', outcome: 'delivered' }, now);
  if (store.alerts.length > MAX_ALERTS) store.alerts.splice(0, store.alerts.length - MAX_ALERTS);
  return alert;
}

function incidentSignal(ownerId, incident) {
  const status = incident.status === 'open' ? 'active'
    : incident.status === 'recovery-detected' ? 'recovery-ready' : incident.status;
  return {
    ownerId, keyId: incident.keyId || null,
    dedupKey: `incident:${incident.incidentRef}:${incident.status}:${incident.severity}`,
    sourceKind: 'incident', sourceRef: incident.incidentRef,
    severity: status === 'resolved' || status === 'recovery-ready' ? 'info' : incident.severity,
    status, reasonCode: incident.reasonCode,
    title: status === 'recovery-ready' ? `${incident.agentName} recovery is ready for review`
      : status === 'resolved' ? `${incident.agentName} incident resolved`
        : `${incident.agentName} runtime ${incident.severity === 'critical' ? 'incident' : 'warning'}`,
    summary: incident.summary,
  };
}

function sloSignal(ownerId, slo) {
  const actionable = ['budget-at-risk', 'budget-exhausted'].includes(slo?.status);
  const previous = store.sloSignals[ownerId] || { actionable: false, episode: 0, signature: null };
  const signature = actionable ? `${slo.status}:${slo.reasonCode}` : null;
  if (!actionable) {
    if (previous.actionable) store.sloSignals[ownerId] = { actionable: false, episode: previous.episode, signature: null };
    return null;
  }
  if (previous.actionable && previous.signature === signature) return null;
  const episode = previous.episode + 1;
  store.sloSignals[ownerId] = { actionable: true, episode, signature };
  const fast = slo.burnRates?.some((rate) => rate.name === 'fast' && rate.firing);
  return {
    ownerId, keyId: null, dedupKey: `slo:${episode}:${signature}`,
    sourceKind: 'slo', sourceRef: `slo-episode-${episode}`,
    severity: slo.status === 'budget-exhausted' || fast ? 'critical' : 'warning',
    status: 'active', reasonCode: slo.reasonCode,
    title: slo.status === 'budget-exhausted' ? 'Agent readiness error budget exhausted' : 'Agent readiness burn rate is elevated',
    summary: 'Owner review is required. Alert delivery cannot change runtime quarantine or execution permissions.',
  };
}

export function reconcileOwnerAlerts({ ownerId, incidents, safetySlo, keyId = null }, now = Date.now()) {
  if (!ownerId) throw new Error('ownerId required');
  let changed = false;
  for (const incident of incidents?.incidents || []) {
    if (keyId && incident.keyId && incident.keyId !== keyId) continue;
    const signal = { ...incidentSignal(ownerId, incident), keyId: keyId || incident.keyId || null };
    const existing = store.alerts.find((alert) => alert.ownerId === ownerId && alert.dedupKey === signal.dedupKey);
    if (existing) {
      const occurrences = Math.max(existing.occurrenceCount, incident.occurrenceCount || 1);
      if (occurrences !== existing.occurrenceCount) {
        existing.lastObservedAt = now; existing.occurrenceCount = occurrences; changed = true;
      }
    } else {
      // On first deployment, do not page the owner for resolved history that
      // predates the router. A resolved transition is emitted only when this
      // router already observed an earlier state for the same incident.
      const knownIncident = store.alerts.some((alert) => alert.ownerId === ownerId
        && alert.sourceKind === 'incident' && alert.sourceRef === incident.incidentRef);
      if (incident.status !== 'resolved' || knownIncident) { createAlert(signal, now); changed = true; }
    }
  }
  if (!keyId) {
    const previousSignal = JSON.stringify(store.sloSignals[ownerId] || null);
    const signal = sloSignal(ownerId, safetySlo);
    if (JSON.stringify(store.sloSignals[ownerId] || null) !== previousSignal) changed = true;
    if (signal && !store.alerts.some((alert) => alert.ownerId === ownerId && alert.dedupKey === signal.dedupKey)) {
      createAlert(signal, now); changed = true;
    }
  }
  if (changed) save();
  return changed;
}

function publicAlert(alert) {
  return {
    alertRef: alert.alertRef, eventId: alert.eventId, source: alert.sourceKind,
    severity: alert.severity, status: alert.status, reasonCode: alert.reasonCode,
    title: alert.title, summary: alert.summary, createdAt: alert.createdAt,
    lastObservedAt: alert.lastObservedAt, occurrenceCount: alert.occurrenceCount,
    delivery: {
      controlCenter: alert.delivery.controlCenter.status,
      webhook: alert.delivery.webhook.status,
      attempts: alert.delivery.webhook.attempts,
      lastAttemptAt: alert.delivery.webhook.lastAttemptAt,
      lastStatusCode: alert.delivery.webhook.lastStatusCode,
      nextAttemptAt: alert.delivery.webhook.nextAttemptAt,
    },
  };
}

export function ownerAlertStatus(ownerId, keyId = null) {
  const alerts = store.alerts.filter((alert) => alert.ownerId === ownerId && (!keyId || alert.keyId === keyId));
  const visibleAlertRefs = new Set(alerts.map((alert) => alert.alertRef));
  const receipts = store.receipts.filter((receipt) => receipt.ownerId === ownerId && visibleAlertRefs.has(receipt.alertRef));
  return {
    ok: true, mode: 'paper-only', version: OWNER_ALERT_ROUTER_VERSION,
    counts: {
      total: alerts.length, critical: alerts.filter((alert) => alert.severity === 'critical').length,
      pending: alerts.filter((alert) => ['pending', 'retrying'].includes(alert.delivery.webhook.status)).length,
      delivered: alerts.filter((alert) => alert.delivery.webhook.status === 'delivered').length,
      deadLetter: alerts.filter((alert) => alert.delivery.webhook.status === 'dead-letter').length,
    },
    channels: {
      ownerControlCenter: { enabled: true, delivery: 'durable-immediate' },
      signedWebhook: { enabled: webhookConfigured(), signature: 'rfc9421-hmac-sha256', envelope: 'cloudevents-1.0' },
    },
    policy: { maximumAttempts: MAX_DELIVERY_ATTEMPTS, timeoutMs: DELIVERY_TIMEOUT_MS, retry: 'bounded-exponential-backoff-with-jitter' },
    alerts: alerts.slice().sort((a, b) => b.createdAt - a.createdAt).map(publicAlert),
    receiptChain: { verified: validReceipts(store.receipts), count: receipts.length, latestHashPresent: Boolean(receipts.at(-1)?.hash) },
    guarantees: {
      ownerIsolated: true, deduplicated: true, privateNoStore: true, notificationOnly: true,
      executionPermissionsChanged: false, authorityExpanded: false,
    },
    liveScopeUsed: false, publicChainUsed: false,
  };
}

function validateWebhookUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2_048) throw new Error('owner alert webhook URL is invalid');
  let url;
  try { url = new URL(raw); } catch { throw new Error('owner alert webhook URL is invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443') throw new Error('owner alert webhook must use credential-free HTTPS on port 443');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.local') || net.isIP(url.hostname)) throw new Error('owner alert webhook host is not permitted');
  return url;
}

function privateAddress(address) {
  if (address.includes(':')) {
    const value = address.toLowerCase();
    // Only IPv6 global-unicast (2000::/3) is eligible. Explicitly exclude the
    // documentation prefix as well as all mapped, loopback, unique-local,
    // link-local, multicast and unspecified forms outside that range.
    return !/^[23]/.test(value) || value.startsWith('2001:db8:');
  }
  const parts = address.split('.').map(Number);
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) || parts[0] >= 224;
}

function readWebhookSecret() {
  const file = process.env.IOST_OWNER_ALERT_WEBHOOK_SECRET_FILE;
  if (!file) throw new Error('owner alert webhook secret file is not configured');
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) throw new Error('owner alert webhook secret permissions must deny group and other access');
  const secret = readFileSync(file);
  if (secret.length < 32 || secret.length > 4096) throw new Error('owner alert webhook secret must contain 32 to 4096 bytes');
  return secret;
}

function cloudEvent(alert) {
  return {
    specversion: '1.0', id: alert.eventId,
    source: 'https://iostcallister.com/agent-alert-router', type: `com.iostcallister.agent.${alert.sourceKind}.v1`,
    subject: alert.alertRef, time: new Date(alert.createdAt).toISOString(), datacontenttype: 'application/json',
    data: {
      alertRef: alert.alertRef, severity: alert.severity, status: alert.status,
      reasonCode: alert.reasonCode, title: alert.title, summary: alert.summary,
      mode: 'paper-only', authorityExpanded: false, liveScopeUsed: false, publicChainUsed: false,
    },
  };
}

export function buildSignedWebhookRequest(alert, endpoint, secret, now = Date.now()) {
  const url = validateWebhookUrl(endpoint);
  const body = JSON.stringify(cloudEvent(alert));
  const digest = `sha-256=:${crypto.createHash('sha256').update(body).digest('base64')}:`;
  const created = Math.floor(now / 1000); const expires = created + 300;
  const components = '("@method" "@target-uri" "content-digest" "content-type" "x-iost-alert-id")';
  const params = `${components};created=${created};expires=${expires};keyid="iost-owner-alert-v1";alg="hmac-sha256"`;
  const signatureBase = `"@method": POST\n"@target-uri": ${url.href}\n"content-digest": ${digest}\n"content-type": application/cloudevents+json\n"x-iost-alert-id": ${alert.eventId}\n"@signature-params": ${params}`;
  const signature = crypto.createHmac('sha256', secret).update(signatureBase).digest('base64');
  return { url, body, headers: {
    'Content-Type': 'application/cloudevents+json', 'Content-Digest': digest,
    'X-IOST-Alert-ID': alert.eventId, 'Idempotency-Key': alert.eventId,
    'Signature-Input': `iost=${params}`, Signature: `iost=:${signature}:`,
  } };
}

async function sendWebhook(alert) {
  const request = buildSignedWebhookRequest(alert, process.env.IOST_OWNER_ALERT_WEBHOOK_URL, readWebhookSecret());
  const records = await dns.lookup(request.url.hostname, { all: true, verbatim: true });
  if (!records.length || records.some((record) => privateAddress(record.address))) throw new Error('owner alert webhook resolved to a non-public address');
  const address = records[0].address;
  return await new Promise((resolve, reject) => {
    const req = https.request({
      protocol: 'https:', hostname: address, port: 443, method: 'POST', path: `${request.url.pathname}${request.url.search}`,
      servername: request.url.hostname, headers: { ...request.headers, Host: request.url.hostname, 'Content-Length': Buffer.byteLength(request.body) },
      timeout: DELIVERY_TIMEOUT_MS,
    }, (res) => { res.resume(); res.on('end', () => resolve({ statusCode: res.statusCode || 0, retryAfter: res.headers['retry-after'] })); });
    req.on('timeout', () => req.destroy(new Error('owner alert webhook timed out')));
    req.on('error', reject); req.end(request.body);
  });
}

function retryDelay(alert, attempt, retryAfter) {
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 15 * 60_000);
  const base = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
  const unit = parseInt(sha256(`${alert.eventId}:${attempt}`).slice(0, 8), 16) / 0xffffffff;
  return Math.round(base * (0.8 + unit * 0.4));
}

export async function dispatchPendingAlerts(now = Date.now(), deliver = sendWebhook) {
  if (!webhookConfigured()) return { attempted: 0, delivered: 0, retrying: 0, deadLetter: 0 };
  const result = { attempted: 0, delivered: 0, retrying: 0, deadLetter: 0 };
  const due = store.alerts.filter((alert) => ['pending', 'retrying'].includes(alert.delivery.webhook.status)
    && Number(alert.delivery.webhook.nextAttemptAt || 0) <= now);
  for (const alert of due) {
    result.attempted += 1; const attempt = alert.delivery.webhook.attempts + 1;
    try {
      const response = await deliver(alert);
      const statusCode = Number(response?.statusCode || 0);
      alert.delivery.webhook = { ...alert.delivery.webhook, attempts: attempt, lastAttemptAt: now, lastStatusCode: statusCode, lastError: null };
      if (statusCode >= 200 && statusCode < 300) {
        alert.delivery.webhook.status = 'delivered'; alert.delivery.webhook.nextAttemptAt = null;
        appendReceipt(alert, { channel: 'signed-webhook', outcome: 'delivered', statusCode, attempt }, now); result.delivered += 1;
      } else if ([408, 425, 429].includes(statusCode) || statusCode >= 500) {
        if (attempt >= MAX_DELIVERY_ATTEMPTS) {
          alert.delivery.webhook.status = 'dead-letter'; alert.delivery.webhook.nextAttemptAt = null;
          appendReceipt(alert, { channel: 'signed-webhook', outcome: 'dead-letter', statusCode, attempt }, now); result.deadLetter += 1;
        } else {
          alert.delivery.webhook.status = 'retrying'; alert.delivery.webhook.nextAttemptAt = now + retryDelay(alert, attempt, response.retryAfter);
          appendReceipt(alert, { channel: 'signed-webhook', outcome: 'retrying', statusCode, attempt }, now); result.retrying += 1;
        }
      } else {
        alert.delivery.webhook.status = 'dead-letter'; alert.delivery.webhook.nextAttemptAt = null;
        appendReceipt(alert, { channel: 'signed-webhook', outcome: 'dead-letter', statusCode, attempt }, now); result.deadLetter += 1;
      }
    } catch (error) {
      alert.delivery.webhook = { ...alert.delivery.webhook, attempts: attempt, lastAttemptAt: now, lastStatusCode: null, lastError: clean(error.message, 120) };
      if (attempt >= MAX_DELIVERY_ATTEMPTS) {
        alert.delivery.webhook.status = 'dead-letter'; alert.delivery.webhook.nextAttemptAt = null;
        appendReceipt(alert, { channel: 'signed-webhook', outcome: 'dead-letter', attempt }, now); result.deadLetter += 1;
      } else {
        alert.delivery.webhook.status = 'retrying'; alert.delivery.webhook.nextAttemptAt = now + retryDelay(alert, attempt);
        appendReceipt(alert, { channel: 'signed-webhook', outcome: 'retrying', attempt }, now); result.retrying += 1;
      }
    }
    save();
  }
  return result;
}

export function secureOwnerAlertPermissions() { if (existsSync(FILE)) chmodSync(FILE, 0o600); }
export const ownerAlertStorePathForTest = FILE;
