#!/usr/bin/env node
// Least-privilege companion for IOST Terminal Agent Runtime Reliability.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AGENT_RUNTIME_SUPERVISOR_VERSION, DEFAULT_SUPERVISOR_CADENCE_MS,
  createSupervisorStateStore, runSupervisorCycle, supervisorHealth,
} from '../lib/agent-runtime-supervisor.js';

const args = new Set(process.argv.slice(2));
const endpoint = String(process.env.IOST_TERMINAL_URL || 'https://iostcallister.com').replace(/\/+$/, '');
const keyFile = process.env.IOST_AGENT_KEY_FILE || '/run/secrets/iost-terminal-agent-key';
const stateFile = resolve(process.env.IOST_SUPERVISOR_STATE_FILE || '/var/lib/iost-runtime-supervisor/state.json');
const contextFile = resolve(process.env.IOST_SUPERVISOR_CONTEXT_FILE || '/run/iost-runtime-supervisor/context.json');
const cadenceMs = Number(process.env.IOST_SUPERVISOR_CADENCE_MS || DEFAULT_SUPERVISOR_CADENCE_MS);
const requestTimeoutMs = Number(process.env.IOST_SUPERVISOR_REQUEST_TIMEOUT_MS || 10_000);

if (!endpoint.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(endpoint)) {
  throw new Error('supervisor endpoint must use HTTPS (loopback HTTP is allowed for tests)');
}
if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 30_000) throw new Error('invalid request timeout');

const apiKey = readFileSync(keyFile, 'utf8').trim();
if (apiKey.length < 16) throw new Error('agent key file is empty or invalid');
const store = createSupervisorStateStore(stateFile);

async function request(path, options = {}) {
  const response = await fetch(`${endpoint}${path}`, {
    ...options,
    signal: AbortSignal.timeout(requestTimeoutMs),
    headers: { Accept: 'application/json', 'X-API-Key': apiKey, ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new Error(`IOST Terminal request failed with HTTP ${response.status}`);
  return body;
}

const transport = {
  getStatus: () => request('/api/agent-runtime'),
  sendHeartbeat: (payload) => request('/api/agent-runtime/heartbeat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }),
};

function desiredContext(state) {
  if (!existsSync(contextFile)) return { state, stage: 'idle' };
  let context;
  try { context = JSON.parse(readFileSync(contextFile, 'utf8')); }
  catch (error) { throw new Error(`supervisor context is unreadable: ${error.message}`); }
  if (!context || typeof context !== 'object'
      || !['idle', 'observe', 'analyze', 'risk-check', 'execute', 'verify', 'journal'].includes(context.stage || 'idle')
      || (context.missionId != null && !/^msn_[a-z0-9]+$/.test(context.missionId))
      || (context.cursor != null && (typeof context.cursor !== 'string' || context.cursor.length > 500))) {
    throw new Error('supervisor context is invalid');
  }
  return {
    state, stage: context.stage || 'idle',
    ...(Object.hasOwn(context, 'missionId') ? { missionId: context.missionId } : {}),
    ...(Object.hasOwn(context, 'cursor') ? { cursor: context.cursor } : {}),
  };
}

async function cycle(state = 'ready') {
  const result = await runSupervisorCycle({ ...transport, store, cadenceMs, desired: desiredContext(state) });
  const health = supervisorHealth(store.load());
  process.stdout.write(`${JSON.stringify({
    ok: result.ok, supervisorVersion: AGENT_RUNTIME_SUPERVISOR_VERSION,
    outcome: result.outcome, runtimeStatus: result.runtime.status,
    health: health.status, authorityExpanded: false, liveScopeUsed: false, publicChainUsed: false,
  })}\n`);
  return result;
}

if (args.has('--check')) {
  const health = supervisorHealth(store.load());
  process.stdout.write(`${JSON.stringify(health)}\n`);
  process.exitCode = health.ok ? 0 : 1;
} else if (args.has('--once')) {
  await cycle('ready');
} else if (args.has('--drain')) {
  await cycle('draining');
} else {
  let stopping = false;
  let timer;
  let operation = Promise.resolve();
  const queuedCycle = (state) => {
    const next = operation.catch(() => {}).then(() => cycle(state));
    operation = next;
    return next;
  };
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    try {
      // A pending exact retry may reconcile first; a second cycle records the drain.
      const first = await queuedCycle('draining');
      if (first.outcome === 'reconciled') await queuedCycle('draining');
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ ok: false, event: 'drain-failed', reason: error.message })}\n`);
      process.exitCode = 1;
    }
    process.stdout.write(`${JSON.stringify({ ok: process.exitCode !== 1, event: 'stopped', signal })}\n`);
  };
  process.once('SIGTERM', () => { void stop('SIGTERM'); });
  process.once('SIGINT', () => { void stop('SIGINT'); });

  const loop = async () => {
    if (stopping) return;
    try { await queuedCycle('ready'); }
    catch (error) { process.stderr.write(`${JSON.stringify({ ok: false, event: 'heartbeat-failed', reason: error.message })}\n`); }
    if (!stopping) timer = setTimeout(loop, cadenceMs);
  };
  await loop();
}
