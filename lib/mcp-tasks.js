// Private durable store for MCP 2026-07-28 Tasks extension handles.
// Task records are owner-bound and never enumerable through MCP.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_PER_OWNER = 25;

function readStore(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && parsed.tasks && typeof parsed.tasks === 'object' ? parsed : { tasks: {} };
  } catch { return { tasks: {} }; }
}

function publicTask(task) {
  if (!task) return null;
  const out = {
    taskId: task.taskId,
    status: task.status,
    statusMessage: task.statusMessage,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttlMs,
    pollIntervalMs: task.pollIntervalMs,
  };
  if (task.status === 'completed') out.result = task.result;
  if (task.status === 'failed') out.error = task.error;
  if (task.status === 'input_required') out.inputRequests = task.inputRequests;
  return out;
}

export function createMcpTaskStore({ dataDir = process.env.IOST_DATA_DIR || join(process.cwd(), 'data'), ttlMs = DEFAULT_TTL_MS, maxPerOwner = DEFAULT_MAX_PER_OWNER } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'mcp-tasks.json');
  const normalizedTtl = Math.max(60_000, Math.min(Number(ttlMs) || DEFAULT_TTL_MS, 7 * DEFAULT_TTL_MS));
  const normalizedMax = Math.max(1, Math.min(Number(maxPerOwner) || DEFAULT_MAX_PER_OWNER, 100));

  const save = (store) => {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  };

  const loadClean = () => {
    const store = readStore(file);
    const now = Date.now();
    let changed = false;
    for (const [id, task] of Object.entries(store.tasks)) {
      if (!task?.ownerId || !task?.createdAt || now - Date.parse(task.createdAt) > (task.ttlMs || normalizedTtl)) {
        delete store.tasks[id]; changed = true;
      }
    }
    if (changed) save(store);
    return store;
  };

  const owned = (store, ownerId, taskId) => {
    const task = store.tasks[String(taskId || '')];
    return task && task.ownerId === ownerId ? task : null;
  };

  const update = (ownerId, taskId, mutate) => {
    const store = loadClean();
    const task = owned(store, ownerId, taskId);
    if (!task) return null;
    const changed = mutate(task);
    if (!changed) return null;
    task.lastUpdatedAt = new Date().toISOString();
    save(store);
    return publicTask(task);
  };

  return Object.freeze({
    create({ ownerId, toolName, requestHash }) {
      if (!ownerId || !toolName || !/^[a-f0-9]{64}$/.test(String(requestHash || ''))) throw new Error('valid task owner, tool and request hash required');
      const store = loadClean();
      const sameOwner = Object.values(store.tasks).filter((task) => task.ownerId === ownerId)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      while (sameOwner.length >= normalizedMax) {
        const removable = sameOwner.find((task) => ['completed', 'failed', 'cancelled'].includes(task.status));
        if (!removable) throw new Error('too many active MCP tasks');
        delete store.tasks[removable.taskId];
        sameOwner.splice(sameOwner.indexOf(removable), 1);
      }
      const now = new Date().toISOString();
      const task = {
        taskId: randomUUID(), ownerId, toolName, requestHash: String(requestHash),
        status: 'working', statusMessage: 'Evaluation queued', createdAt: now, lastUpdatedAt: now,
        ttlMs: normalizedTtl, pollIntervalMs: 1000,
      };
      store.tasks[task.taskId] = task;
      save(store); // Strong consistency: tasks/get can resolve before create returns.
      return publicTask(task);
    },
    get(ownerId, taskId) {
      const task = owned(loadClean(), ownerId, taskId);
      return publicTask(task);
    },
    complete(ownerId, taskId, result) {
      return update(ownerId, taskId, (task) => {
        if (task.status !== 'working' && task.status !== 'input_required') return false;
        task.status = 'completed'; task.statusMessage = 'Evaluation completed'; task.result = result;
        delete task.inputRequests; return true;
      });
    },
    fail(ownerId, taskId, error) {
      return update(ownerId, taskId, (task) => {
        if (task.status !== 'working' && task.status !== 'input_required') return false;
        task.status = 'failed'; task.statusMessage = 'Evaluation failed';
        task.error = { code: Number(error?.code) || -32603, message: String(error?.message || 'Evaluation failed').slice(0, 500) };
        delete task.inputRequests; return true;
      });
    },
    cancel(ownerId, taskId) {
      return update(ownerId, taskId, (task) => {
        if (task.status !== 'working' && task.status !== 'input_required') return false;
        task.status = 'cancelled'; task.statusMessage = 'Cancelled by owner'; delete task.inputRequests; return true;
      });
    },
    updateInput(ownerId, taskId, inputResponses) {
      return update(ownerId, taskId, (task) => {
        if (task.status !== 'input_required' || !inputResponses || typeof inputResponses !== 'object') return false;
        task.inputResponses = { ...(task.inputResponses || {}), ...inputResponses };
        return true;
      });
    },
    pathsForTest: Object.freeze({ file, exists: () => existsSync(file) }),
  });
}

