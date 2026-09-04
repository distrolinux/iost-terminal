// Deterministic trust boundary for market evidence and external text.
// This module performs no I/O and cannot place, reserve or authorize a trade.
import crypto from 'node:crypto';

export const DATA_TRUST_VERSION = 1;
export const TRUSTED_NEWS_SOURCES = Object.freeze({
  CoinDesk: 'www.coindesk.com',
  Cointelegraph: 'cointelegraph.com',
  Decrypt: 'decrypt.co',
});
export const TRUSTED_EXECUTION_VENUES = Object.freeze(['FMP', 'Gate', 'KuCoin', 'OKX', 'Yahoo']);

const sha256 = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const clean = (value, max = 240) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const round = (value, places = 2) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const power = 10 ** places;
  return Math.round((number + Number.EPSILON) * power) / power;
};

// Deliberately narrow, explainable signals. Detection quarantines content; it
// never treats the content as an instruction and never tries to "follow" it.
const INSTRUCTION_SIGNALS = Object.freeze([
  ['instruction-override', /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|system|developer|instructions?)\b/i],
  ['role-spoofing', /(?:^|\s)(system|assistant|developer)\s*:\s*/i],
  ['secret-request', /\b(api[-_ ]?key|password|private key|seed phrase|system prompt|credential)\b/i],
  ['tool-command', /\b(call|invoke|execute|run)\b.{0,32}\b(tool|command|shell|terminal|function)\b/i],
  ['financial-command', /\b(send|transfer|withdraw|swap|buy|sell|open|close)\b.{0,32}\b(funds?|tokens?|position|trade|wallet)\b/i],
  ['encoded-payload', /\b(base64|decode this|data:text\/html|javascript:)\b/i],
]);

function publicUrlHost(raw) {
  try {
    const url = new URL(String(raw || ''));
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch { return null; }
}

export function inspectExternalText({ text = '', source = '', url = '', observedAt = null, now = Date.now() } = {}) {
  const normalized = clean(text, 2_000);
  const expectedHost = TRUSTED_NEWS_SOURCES[source] || null;
  const actualHost = publicUrlHost(url);
  const sourceAuthorized = !!expectedHost && actualHost === expectedHost;
  const detectedSignals = INSTRUCTION_SIGNALS.filter(([, pattern]) => pattern.test(normalized)).map(([code]) => code);
  const timestamp = Number.isSafeInteger(Number(observedAt)) ? Number(observedAt) : null;
  const futureDated = timestamp != null && timestamp > now + 5 * 60_000;
  const reasons = [
    ...(!sourceAuthorized ? ['untrusted-source'] : []),
    ...(!normalized ? ['empty-content'] : []),
    ...(futureDated ? ['future-dated'] : []),
    ...detectedSignals,
  ];
  const quarantined = reasons.length > 0;
  return {
    trustVersion: DATA_TRUST_VERSION,
    classification: quarantined ? 'untrusted-external-content' : 'trusted-data-only',
    trusted: !quarantined,
    quarantined,
    sourceAuthorized,
    instructionLike: detectedSignals.length > 0,
    reasonCodes: reasons,
    provenance: {
      source: clean(source, 80) || 'unknown',
      host: actualHost,
      observedAt: timestamp,
      contentHash: sha256(`${source}\n${actualHost || ''}\n${timestamp || ''}\n${normalized}`),
    },
    handling: 'treat-as-data-never-instructions',
  };
}

export function buildExecutionDataTrust({ ticker = null, now = Date.now() } = {}) {
  const integrity = ticker?.quoteIntegrity || {};
  const venues = Array.isArray(integrity.venues) ? integrity.venues : [];
  const evidence = venues.map((venue) => {
    const source = clean(venue?.source, 80);
    const observedAt = Number.isSafeInteger(Number(venue?.observedAt)) ? Number(venue.observedAt) : null;
    const ageMs = observedAt == null ? null : Math.max(0, Math.trunc(now - observedAt));
    const sourceAuthorized = TRUSTED_EXECUTION_VENUES.includes(source);
    const schemaValid = Number(venue?.bid) > 0 && Number(venue?.ask) >= Number(venue?.bid) && observedAt != null;
    return {
      source,
      sourceAuthorized,
      schemaValid,
      observedAt,
      ageMs,
      evidenceHash: sha256(`${source}\n${venue?.bid}\n${venue?.ask}\n${observedAt}`),
    };
  });
  const trusted = evidence.filter((item) => item.sourceAuthorized && item.schemaValid);
  const minimumSources = integrity.required === true ? 2 : 1;
  const checks = [
    { code: 'structured-evidence-only', pass: true },
    { code: 'quote-policy-declared', pass: typeof integrity.required === 'boolean' },
    { code: 'quote-quorum', pass: integrity.quorumMet === true },
    { code: 'trusted-source-quorum', pass: trusted.length >= minimumSources },
    { code: 'selected-source-authorized', pass: TRUSTED_EXECUTION_VENUES.includes(clean(ticker?.source, 80)) },
    { code: 'fresh-evidence', pass: ticker?.fresh === true },
  ];
  const failure = checks.find((check) => !check.pass);
  return {
    version: DATA_TRUST_VERSION,
    mode: 'paper-only',
    decision: failure ? 'deny' : 'allow',
    reasonCode: failure?.code || 'data-trust-passed',
    checkedAt: Math.trunc(now),
    policy: {
      externalContentAuthority: 'data-only',
      minimumTrustedExecutionSources: minimumSources,
      sourceAllowlist: [...TRUSTED_EXECUTION_VENUES],
      instructionContentCanAuthorizeExecution: false,
      failClosed: true,
    },
    evidence: {
      count: evidence.length,
      trustedCount: trusted.length,
      provenanceCoveragePercent: evidence.length ? round(evidence.filter((item) => item.evidenceHash).length / evidence.length * 100) : 0,
      sources: evidence,
    },
    checks,
    guarantees: {
      deterministic: true,
      provenanceHashed: true,
      untrustedContentSegregated: true,
      modelOutputIsNotAuthority: true,
      authorityExpanded: false,
    },
    liveScopeUsed: false,
    publicChainUsed: false,
  };
}

export function buildAgentDataTrustStatus({ news = null, ticker = null, now = Date.now() } = {}) {
  const items = Array.isArray(news?.items) ? news.items : [];
  const assessments = items.slice(0, 120).map((item) => item?.dataTrust || inspectExternalText({
    text: item?.title, source: item?.source, url: item?.url, observedAt: item?.ts, now,
  }));
  const quarantined = assessments.filter((item) => item.quarantined);
  const injection = assessments.filter((item) => item.instructionLike);
  const execution = ticker ? buildExecutionDataTrust({ ticker, now }) : null;
  return {
    ok: true,
    mode: 'paper-only',
    version: DATA_TRUST_VERSION,
    status: injection.length ? 'quarantining' : 'healthy',
    externalContent: {
      total: assessments.length,
      trusted: assessments.filter((item) => item.trusted).length,
      quarantined: quarantined.length,
      instructionLike: injection.length,
      provenanceCoveragePercent: assessments.length
        ? round(assessments.filter((item) => item.provenance?.contentHash).length / assessments.length * 100) : 100,
      reasonCounts: Object.fromEntries([...new Set(quarantined.flatMap((item) => item.reasonCodes))]
        .sort().map((code) => [code, quarantined.filter((item) => item.reasonCodes.includes(code)).length])),
    },
    execution,
    policy: {
      externalContentAuthority: 'data-only',
      suspiciousContentHandling: 'quarantine-and-exclude',
      promptOrModelOutputCanAuthorizeExecution: false,
      executionRequiresStructuredServerEvidence: true,
      failClosed: true,
    },
    standards: ['OWASP-LLM01-2025', 'OWASP-LLM05-2025', 'OWASP-LLM06-2025', 'NIST-AI-600-1', 'MCP-tool-result-validation'],
    guarantees: {
      readOnly: true,
      deterministic: true,
      provenanceHashed: true,
      untrustedContentSegregated: true,
      authorityExpanded: false,
    },
    executionPermissionsChanged: false,
    liveScopeUsed: false,
    publicChainUsed: false,
  };
}
