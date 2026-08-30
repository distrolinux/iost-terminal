// Paper-only mission control. A mission is a time-bounded execution envelope
// layered on top of an existing owner wallet + active wallet-bound Pact.
// Store: data/missions.json (atomic, owner-only).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWallet } from './wallets.js';
import { getPact } from './pacts.js';

const DATA_DIR = process.env.IOST_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA_DIR, 'missions.json');
const MAX_EVENTS = 300;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const RESERVATION_TTL_MS = 10 * 60 * 1000;
const APPROVAL_MODES = new Set(['per-order', 'exceptions', 'within-pact']);
const STAGES = new Set(['observe', 'analyze', 'risk-check', 'execute', 'verify', 'journal', 'system']);

function loadStore() {
  try {
    if (existsSync(FILE)) {
      const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.missions)) return parsed;
    }
  } catch { /* corrupted mission state fails closed to an empty store */ }
  return { missions: [] };
}

let store = loadStore();

function save() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, FILE);
  chmodSync(FILE, 0o600);
}

const missionId = () => `msn_${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
const cleanText = (value, max) => String(value || '').trim().slice(0, max);
const positiveInt = (value, name, { max = Number.MAX_SAFE_INTEGER } = {}) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > max) throw new Error(`${name} must be a positive integer`);
  return number;
};

function addEvent(mission, stage, type, detail, extra = {}) {
  mission.events.push({ eventId: crypto.randomUUID(), ts: Date.now(), stage, type, detail: cleanText(detail, 500), ...extra });
  if (mission.events.length > MAX_EVENTS) mission.events.splice(0, mission.events.length - MAX_EVENTS);
}

function authorizedPair(ownerId, walletId, pactId) {
  const wallet = getWallet(walletId);
  if (!wallet) throw new Error('wallet not found');
  if (wallet.ownerId !== ownerId) throw new Error('wallet does not belong to owner');
  if (wallet.kind !== 'agent' || wallet.status !== 'active') throw new Error('active agent wallet required');
  if (!wallet.capabilities?.includes('trade.paper')) throw new Error('trade.paper wallet capability required');
  if (wallet.capabilities?.includes('trade.live')) throw new Error('mission wallet must be paper-only');
  const pact = getPact(pactId);
  if (!pact) throw new Error('Pact not found');
  if (pact.ownerId !== ownerId) throw new Error('Pact does not belong to owner');
  if (pact.agentWalletId !== wallet.walletId) throw new Error('Pact is not bound to selected wallet');
  if (pact.status !== 'active') throw new Error('active Pact required');
  return { wallet, pact };
}

function expireIfNeeded(mission) {
  if (['running', 'paused'].includes(mission.status) && Date.now() >= mission.expiresAt) {
    mission.status = 'expired';
    mission.stoppedAt = Date.now();
    mission.reservations = [];
    addEvent(mission, 'system', 'expired', 'Mission expired automatically.');
    save();
  }
  return mission;
}

function ownedMission(id, ownerId) {
  const mission = store.missions.find((item) => item.missionId === id && item.ownerId === ownerId) || null;
  return mission ? expireIfNeeded(mission) : null;
}

export function createMission({
  ownerId, walletId, pactId, name, objective = '', strategy = '', symbols,
  maxOrderMinor = 1, maxTrades = 1, maxLossMinor = 1,
  approvalMode = 'per-order', expiresAt,
}) {
  if (!ownerId) throw new Error('ownerId required');
  const { wallet, pact } = authorizedPair(ownerId, walletId, pactId);
  const cleanName = cleanText(name, 120);
  if (!cleanName) throw new Error('mission name required');
  const normalizedSymbols = [...new Set((Array.isArray(symbols) ? symbols : [])
    .map((symbol) => cleanText(symbol, 24).toUpperCase()).filter(Boolean))];
  if (!normalizedSymbols.length || normalizedSymbols.length > 20) throw new Error('one to twenty symbols required');
  if (!normalizedSymbols.every((symbol) => /^[A-Z0-9._/-]+$/.test(symbol))) throw new Error('invalid mission symbol');
  if (!APPROVAL_MODES.has(approvalMode)) throw new Error('unsupported approval mode');
  const deadline = Number(expiresAt);
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) throw new Error('future mission expiry required');
  if (deadline > Date.now() + MAX_DURATION_MS) throw new Error('mission duration cannot exceed seven days');
  if (pact.expiresAt && deadline > pact.expiresAt) throw new Error('mission cannot outlive its Pact');
  const missionOrderCap = positiveInt(maxOrderMinor, 'maxOrderMinor');
  const walletOrderCap = Number(wallet.limits?.USD?.maxPerTxMinor || 0);
  const pactOrderCap = Number(pact.policies?.limits?.maxPerTxMinor || 0);
  if (walletOrderCap > 0 && missionOrderCap > walletOrderCap) throw new Error('mission order maximum exceeds wallet limit');
  if (pactOrderCap > 0 && missionOrderCap > pactOrderCap) throw new Error('mission order maximum exceeds Pact limit');
  const now = Date.now();
  const mission = {
    missionId: missionId(), ownerId, walletId, pactId,
    name: cleanName,
    objective: cleanText(objective, 500),
    strategy: cleanText(strategy, 500),
    symbols: normalizedSymbols,
    maxOrderMinor: missionOrderCap,
    maxTrades: positiveInt(maxTrades, 'maxTrades', { max: 100 }),
    maxLossMinor: positiveInt(maxLossMinor, 'maxLossMinor'),
    approvalMode,
    executionBoundary: 'PAPER_ONLY',
    liveTrading: false,
    status: 'paused',
    createdAt: now,
    startedAt: null,
    stoppedAt: null,
    expiresAt: deadline,
    tradesOpened: 0,
    realizedPnlMinor: 0,
    positions: [],
    reservations: [],
    events: [],
  };
  addEvent(mission, 'system', 'created', 'Mission created in paused paper-only mode.');
  store.missions.push(mission);
  save();
  return structuredClone(mission);
}

export function listMissions(ownerId) {
  return store.missions.filter((mission) => mission.ownerId === ownerId)
    .map(expireIfNeeded).sort((a, b) => b.createdAt - a.createdAt).map((mission) => structuredClone(mission));
}

export function getMission(id, ownerId) {
  const mission = ownedMission(id, ownerId);
  return mission ? structuredClone(mission) : null;
}

// Agent-facing mission evidence intentionally excludes owner, wallet, Pact,
// position and reservation identifiers. The authority booleans are derived
// from current wallet/Pact state rather than trusting the stored mission copy.
export function missionEvidence(mission) {
  if (!mission) return null;
  const wallet = getWallet(mission.walletId);
  const pact = getPact(mission.pactId);
  const sameOwner = wallet?.ownerId === mission.ownerId && pact?.ownerId === mission.ownerId;
  const exactWalletPactBinding = !!(
    sameOwner
    && wallet?.walletId === mission.walletId
    && pact?.pactId === mission.pactId
    && pact?.agentWalletId === wallet.walletId
  );
  const walletActive = wallet?.kind === 'agent' && wallet?.status === 'active';
  const pactActive = pact?.status === 'active';
  const tradePaper = wallet?.capabilities?.includes('trade.paper') === true;
  const tradeLive = wallet?.capabilities?.includes('trade.live') === true;
  const paperOnly = mission.executionBoundary === 'PAPER_ONLY' && mission.liveTrading === false && tradePaper && !tradeLive;
  const latest = mission.events?.at(-1);
  const latestCheckpoint = latest ? {
    ts: latest.ts,
    stage: latest.stage,
    type: latest.type,
    detail: latest.detail,
    ...(latest.latencyMs == null ? {} : { latencyMs: latest.latencyMs }),
  } : null;
  return {
    missionId: mission.missionId,
    name: mission.name,
    objective: mission.objective,
    strategy: mission.strategy,
    symbols: [...(mission.symbols || [])],
    status: mission.status,
    approvalMode: mission.approvalMode,
    executionBoundary: 'PAPER_ONLY',
    liveTrading: false,
    limits: {
      currency: 'USD',
      maximumOrderMinor: mission.maxOrderMinor,
      maximumOrderUsd: (mission.maxOrderMinor / 100).toFixed(2),
      realizedLossHaltMinor: mission.maxLossMinor,
      realizedLossHaltUsd: (mission.maxLossMinor / 100).toFixed(2),
      maximumTrades: mission.maxTrades,
    },
    usage: {
      tradesOpened: mission.tradesOpened,
      realizedPnlMinor: mission.realizedPnlMinor,
      realizedPnlUsd: (mission.realizedPnlMinor / 100).toFixed(2),
    },
    authority: {
      exactWalletPactBinding,
      walletActive,
      pactActive,
      tradePaper,
      tradeLive,
      paperOnly,
      canOpenPaperTrade: mission.status === 'running' && exactWalletPactBinding && walletActive && pactActive && paperOnly,
      verifiedAt: Date.now(),
    },
    createdAt: mission.createdAt,
    startedAt: mission.startedAt,
    stoppedAt: mission.stoppedAt,
    expiresAt: mission.expiresAt,
    trace: { eventCount: mission.events?.length || 0, latestCheckpoint },
  };
}

export function listMissionEvidence(ownerId) {
  return listMissions(ownerId).map(missionEvidence);
}

export function startMission(id, ownerId) {
  const mission = ownedMission(id, ownerId);
  if (!mission) throw new Error('mission not found');
  if (!['paused'].includes(mission.status)) throw new Error(`cannot start mission in status ${mission.status}`);
  authorizedPair(ownerId, mission.walletId, mission.pactId);
  mission.status = 'running';
  mission.startedAt ||= Date.now();
  addEvent(mission, 'system', 'started', 'Mission started by operator.');
  save();
  return structuredClone(mission);
}

export function pauseMission(id, ownerId, detail = 'Mission paused by operator.') {
  const mission = ownedMission(id, ownerId);
  if (!mission) throw new Error('mission not found');
  if (mission.status !== 'running') throw new Error(`cannot pause mission in status ${mission.status}`);
  mission.status = 'paused';
  addEvent(mission, 'system', 'paused', detail);
  save();
  return structuredClone(mission);
}

export function stopMission(id, ownerId, detail = 'Mission stopped by operator.') {
  const mission = ownedMission(id, ownerId);
  if (!mission) throw new Error('mission not found');
  if (!['running', 'paused'].includes(mission.status)) throw new Error(`cannot stop mission in status ${mission.status}`);
  mission.status = 'stopped';
  mission.stoppedAt = Date.now();
  addEvent(mission, 'system', 'stopped', detail);
  save();
  return structuredClone(mission);
}

export function checkMissionTrade({ missionId: id, ownerId, walletId, pactId, symbol, notionalMinor }) {
  const mission = ownedMission(id, ownerId);
  if (!mission) return { ok: false, reason: 'mission-not-found', message: 'Mission not found.' };
  if (mission.status !== 'running') return { ok: false, reason: `mission-${mission.status}`, message: `Mission is ${mission.status}.` };
  try { authorizedPair(ownerId, mission.walletId, mission.pactId); }
  catch (error) { return { ok: false, reason: 'mission-authorization-invalid', message: error.message }; }
  if (mission.walletId !== walletId || mission.pactId !== pactId) return { ok: false, reason: 'mission-authority-mismatch', message: 'Order authority does not match the mission.' };
  if (!mission.symbols.includes(String(symbol || '').toUpperCase())) return { ok: false, reason: 'symbol-not-allowed', message: 'Symbol is outside the mission watchlist.' };
  const amount = Number(notionalMinor);
  if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, reason: 'mission-invalid-notional', message: 'Mission order notional must be positive.' };
  if (amount > mission.maxOrderMinor) return { ok: false, reason: 'mission-order-cap', message: 'Order exceeds the mission maximum.' };
  if (mission.approvalMode !== 'within-pact') return { ok: false, reason: 'mission-approval-required', message: 'This mission requires a human approval workflow before each paper order.' };
  const reservationCount = mission.reservations?.length || 0;
  mission.reservations = (mission.reservations || []).filter((reservation) => Date.now() - reservation.createdAt < RESERVATION_TTL_MS);
  if (mission.reservations.length !== reservationCount) save();
  if (mission.tradesOpened + mission.reservations.length >= mission.maxTrades) return { ok: false, reason: 'mission-trade-cap', message: 'Mission trade count is exhausted.' };
  if (mission.realizedPnlMinor <= -mission.maxLossMinor) return { ok: false, reason: 'mission-loss-halt', message: 'Mission loss limit is reached.' };
  return { ok: true, mission: structuredClone(mission) };
}

export function reserveMissionTrade(input) {
  const gate = checkMissionTrade(input);
  if (!gate.ok) return gate;
  const mission = ownedMission(input.missionId, input.ownerId);
  const reservationId = `mr_${crypto.randomUUID()}`;
  mission.reservations ||= [];
  mission.reservations.push({
    reservationId, symbol: cleanText(input.symbol, 24).toUpperCase(),
    notionalMinor: positiveInt(input.notionalMinor, 'notionalMinor'), createdAt: Date.now(),
  });
  save();
  return { ok: true, reservationId, missionId: mission.missionId };
}

export function releaseMissionTrade(id, ownerId, reservationId) {
  const mission = ownedMission(id, ownerId);
  if (!mission) return { ok: false, reason: 'mission-not-found' };
  mission.reservations ||= [];
  const before = mission.reservations.length;
  mission.reservations = mission.reservations.filter((reservation) => reservation.reservationId !== reservationId);
  if (mission.reservations.length === before) return { ok: false, reason: 'mission-reservation-not-found' };
  save();
  return { ok: true };
}

export function commitMissionTrade(id, ownerId, reservationId, { positionId, symbol }) {
  const mission = store.missions.find((item) => item.missionId === id && item.ownerId === ownerId) || null;
  if (!mission || !['running', 'expired'].includes(mission.status)) throw new Error('running mission required');
  mission.reservations ||= [];
  const index = mission.reservations.findIndex((reservation) => reservation.reservationId === reservationId);
  if (index === -1) throw new Error('mission reservation not found');
  const [reservation] = mission.reservations.splice(index, 1);
  return attachTrade(mission, { positionId, symbol, notionalMinor: reservation.notionalMinor });
}

export function recordMissionTrade(id, ownerId, { positionId, symbol, notionalMinor }) {
  const mission = ownedMission(id, ownerId);
  if (!mission || mission.status !== 'running') throw new Error('running mission required');
  return attachTrade(mission, { positionId, symbol, notionalMinor });
}

function attachTrade(mission, { positionId, symbol, notionalMinor }) {
  if (!positionId) throw new Error('positionId required');
  if (mission.positions.some((position) => position.positionId === positionId)) return structuredClone(mission);
  mission.tradesOpened += 1;
  mission.positions.push({ positionId: cleanText(positionId, 128), symbol: cleanText(symbol, 24).toUpperCase(), notionalMinor: positiveInt(notionalMinor, 'notionalMinor'), status: 'open', openedAt: Date.now() });
  addEvent(mission, 'execute', 'paper-trade-opened', `Paper position opened for ${symbol}.`, { positionId: cleanText(positionId, 128), notionalMinor });
  save();
  return structuredClone(mission);
}

export function recordMissionClose(positionId, ownerId, pnlMinor) {
  const mission = store.missions.find((item) => item.ownerId === ownerId && item.positions.some((position) => position.positionId === positionId));
  if (!mission) return null;
  const position = mission.positions.find((item) => item.positionId === positionId);
  if (position.status === 'closed') return structuredClone(mission);
  position.status = 'closed';
  position.closedAt = Date.now();
  position.pnlMinor = Math.trunc(Number(pnlMinor) || 0);
  mission.realizedPnlMinor += position.pnlMinor;
  addEvent(mission, 'journal', 'paper-trade-closed', `Paper position closed with ${(position.pnlMinor / 100).toFixed(2)} USD P&L.`, { positionId, pnlMinor: position.pnlMinor });
  if (mission.status === 'running' && mission.realizedPnlMinor <= -mission.maxLossMinor) {
    mission.status = 'paused';
    addEvent(mission, 'system', 'loss-halt', 'Mission paused automatically at its realized-loss limit.');
  }
  save();
  return structuredClone(mission);
}

export function recordMissionCheckpoint(id, ownerId, { stage, detail, latencyMs = null }) {
  const mission = ownedMission(id, ownerId);
  if (!mission || mission.status !== 'running') throw new Error('running mission required');
  if (!STAGES.has(stage)) throw new Error('unsupported mission stage');
  const latency = latencyMs == null ? null : Math.max(0, Math.min(300_000, Math.trunc(Number(latencyMs) || 0)));
  addEvent(mission, stage, 'checkpoint', detail, latency == null ? {} : { latencyMs: latency });
  save();
  return structuredClone(mission);
}

export function secureMissionPermissions() {
  if (!existsSync(FILE)) return;
  chmodSync(FILE, 0o600);
}
