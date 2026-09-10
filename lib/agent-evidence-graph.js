// Private provenance graph assembled from the existing evidence passport and
// decision traces. Relation names follow W3C PROV concepts, but this compact
// JSON is an AITT application profile rather than an RDF/PROV serialization.
// It never persists, publishes, authorizes or executes anything.
import crypto from 'node:crypto';

const VERSION = 1;
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
};
const digest = (value) => sha256(JSON.stringify(stable(value)));
const ref = (kind, value) => `evg_${kind}_${sha256(`aitt:evidence-graph:v1:${kind}:${String(value || '')}`).slice(0, 20)}`;
const clean = (value, max = 180) => String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

function graphCore(graph) {
  return {
    format: graph.format, version: graph.version, mode: graph.mode,
    generatedAt: graph.generatedAt, subjectRef: graph.subjectRef,
    provenance: graph.provenance, sourceVerification: graph.sourceVerification,
    nodes: graph.nodes, edges: graph.edges, counts: graph.counts,
    latestDecision: graph.latestDecision,
  };
}

export function buildAgentEvidenceGraph({ passport = {}, decisionTrace = {}, generatedAt = Date.now() } = {}) {
  const subjectRef = /^agt_[a-f0-9]{24}$/.test(String(passport.subjectRef || ''))
    ? passport.subjectRef : ref('subject', passport.evidenceRoot || 'unavailable');
  const subjectNode = ref('agent', subjectRef);
  const passportNode = ref('passport', passport.evidenceRoot || 'unavailable');
  const assemblyNode = ref('activity', `assembly:${passport.evidenceRoot || generatedAt}`);
  const nodes = [
    { id: subjectNode, type: 'Agent', label: 'Authenticated AITT principal', status: 'pseudonymous' },
    { id: passportNode, type: 'Entity', label: 'AITT evidence passport', status: passport.status || 'partial' },
    { id: assemblyNode, type: 'Activity', activityType: 'evidence-assembly', label: 'Evidence graph assembly', status: 'complete' },
  ];
  const edges = [
    { from: assemblyNode, to: subjectNode, relation: 'wasAssociatedWith' },
    { from: passportNode, to: assemblyNode, relation: 'wasGeneratedBy' },
  ];

  for (const item of passport.claims || []) {
    const claimNode = ref('claim', item.evidenceHash || item.id);
    nodes.push({ id: claimNode, type: 'Entity', entityType: 'evidence-claim', label: clean(item.label || item.id), status: item.status || 'unavailable', evidenceHash: item.evidenceHash || null });
    edges.push({ from: passportNode, to: claimNode, relation: 'wasDerivedFrom' });
  }

  const traces = Array.isArray(decisionTrace.traces) ? decisionTrace.traces : [];
  for (const trace of traces) {
    const decisionNode = ref('decision', trace.traceRef);
    nodes.push({
      id: decisionNode, type: 'Activity', activityType: 'agent-decision',
      label: clean(`${trace.action || 'paper'} ${trace.symbol || 'decision'}`),
      status: trace.outcome || 'unknown', occurredAt: Number(trace.occurredAt) || null,
      symbol: trace.symbol || null, side: trace.side || null, reasonCode: trace.reasonCode || null,
      evidenceCoveragePct: Number(trace.evidenceCoveragePct) || 0,
    });
    edges.push({ from: decisionNode, to: subjectNode, relation: 'wasAssociatedWith' });
    edges.push({ from: decisionNode, to: passportNode, relation: 'used' });
    let previousStage = null;
    (trace.stages || []).forEach((item, index) => {
      const stageNode = ref('stage', `${trace.traceRef}:${index}:${item.name}`);
      nodes.push({
        id: stageNode, type: 'Activity', activityType: 'decision-stage',
        stage: item.name || `stage-${index + 1}`, label: clean(item.name || `Stage ${index + 1}`),
        status: item.status || 'unavailable', summary: clean(item.summary),
      });
      edges.push({ from: stageNode, to: decisionNode, relation: 'wasPartOf' });
      if (previousStage) edges.push({ from: stageNode, to: previousStage, relation: 'wasInformedBy' });
      previousStage = stageNode;
    });
  }

  const connected = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  const sourceVerification = {
    passportIntegrity: passport.integrity?.verified === true,
    receiptChain: decisionTrace.evidence?.receiptChainVerified === true,
    approvalChain: decisionTrace.evidence?.approvalChainVerified === true,
    eventChain: decisionTrace.evidence?.eventChainVerified === true,
  };
  sourceVerification.complete = sourceVerification.passportIntegrity
    && sourceVerification.receiptChain && sourceVerification.approvalChain && sourceVerification.eventChain;
  const latest = traces[0] || null;
  const core = {
    format: 'aitt-decision-evidence-graph+json', version: VERSION, mode: 'paper-only',
    generatedAt: Number(generatedAt), subjectRef,
    provenance: {
      profile: 'W3C-PROV-inspired', namespace: 'http://www.w3.org/ns/prov#',
      entity: 'Entity', activity: 'Activity', agent: 'Agent',
      relations: ['used', 'wasAssociatedWith', 'wasDerivedFrom', 'wasGeneratedBy', 'wasInformedBy', 'wasPartOf'],
      formalProvSerialization: false,
    },
    sourceVerification, nodes, edges,
    counts: {
      agents: nodes.filter((node) => node.type === 'Agent').length,
      decisions: nodes.filter((node) => node.activityType === 'agent-decision').length,
      claims: nodes.filter((node) => node.entityType === 'evidence-claim').length,
      stages: nodes.filter((node) => node.activityType === 'decision-stage').length,
      nodes: nodes.length, edges: edges.length,
      orphans: nodes.filter((node) => !connected.has(node.id)).length,
    },
    latestDecision: latest ? {
      action: latest.action || null, symbol: latest.symbol || null, side: latest.side || null,
      outcome: latest.outcome || null, reasonCode: latest.reasonCode || null,
      evidenceCoveragePct: Number(latest.evidenceCoveragePct) || 0,
      stages: (latest.stages || []).map((item) => ({ name: item.name, status: item.status })),
    } : { action: null, symbol: null, side: null, outcome: null, reasonCode: null, evidenceCoveragePct: 0, stages: [] },
  };
  const evidenceRoot = digest(core);
  return {
    ok: true, ...core,
    status: sourceVerification.complete && core.counts.orphans === 0 ? 'verified' : 'partial',
    decision: sourceVerification.complete && core.counts.orphans === 0 ? 'provenance-complete' : 'provenance-incomplete',
    evidenceRoot,
    integrity: { algorithm: 'SHA-256', canonicalization: 'recursive-key-sort', verified: true, evidenceRoot },
    guarantees: {
      readOnly: true, privateByDefault: true, ownerIsolated: true, deterministic: true,
      portableJson: true, automaticPublication: false, publicDiscovery: false,
      identityCredential: false, investmentRecommendation: false, executionAuthority: 'none',
      missingEvidenceNeverInferred: true, executionPermissionsChanged: false, authorityExpanded: false,
      liveScopeUsed: false, publicChainUsed: false,
    },
    execution: { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false },
    liveScopeUsed: false, publicChainUsed: false,
  };
}

export function verifyAgentEvidenceGraph(graph) {
  if (!graph || graph.version !== VERSION || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return false;
  return graph.evidenceRoot === digest(graphCore(graph)) && graph.integrity?.evidenceRoot === graph.evidenceRoot;
}

export const agentEvidenceGraphConstants = Object.freeze({ version: VERSION, algorithm: 'SHA-256' });
