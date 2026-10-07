import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { SafeError, sha256 } from './errors.js';
import { CAPTURE_ID, type CaptureMeta } from './capture.js';
import { collectExpiredAuthorization, readMultiRepoCatalog } from './multirepo-state.js';
import { StateStore, acquireLock } from './task-state.js';
import { taskStatus, withCompletedTaskGcLease, type Completion, type Outcome } from './task.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_AUTH_RETENTION_HOURS = 24;
const DEFAULT_CAPTURE_RETENTION_HOURS = 0;
const DEFAULT_TASK_RETENTION_DAYS = 30;
const DEFAULT_SCAN_LIMIT = 10_000;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const PENDING_PATH = 'gc/pending.json';
const AUDIT_PATH = 'gc-audit.jsonl';
const OUTCOME_FILE = /^[a-f0-9]{32}\.json$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;

type Counts = {
  workspaces: number;
  grants: number;
  requests: number;
  captures: number;
  capture_files: number;
  outcomes: number;
  runtime_records: number;
  payload_bytes: number;
};
type Skip = { task_id?: string; workspace_id?: string; reason: string };
type ExpectedFile = { rel: string; dev: string; ino: string; size: number };
type PendingDeletion = {
  schema_version: 1;
  category: 'capture' | 'outcome';
  task_id: string;
  record_id: string;
  eligible_at: string;
  witness: string;
  files: ExpectedFile[];
};

export type GcOptions = {
  stateDir: string;
  apply?: boolean;
  authRetentionHours?: number;
  captureRetentionHours?: number;
  taskRetentionDays?: number;
  maxRecords?: number;
  nowMs?: number;
};

export type GcSummary = {
  schema_version: 1;
  mode: 'dry-run' | 'apply';
  as_of: string;
  state_dir: string;
  retention: { auth_hours: number; capture_hours: number; task_days: number };
  catalog_revision: number | null;
  complete: boolean;
  would_remove: Counts;
  removed: Counts;
  skipped: Skip[];
};

const emptyCounts = (): Counts => ({
  workspaces: 0, grants: 0, requests: 0, captures: 0,
  capture_files: 0, outcomes: 0, runtime_records: 0, payload_bytes: 0
});

function integer(value: number | undefined, fallback: number, min: number, max: number, name: string) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw new SafeError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return resolved;
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

async function hashFile(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function checkedFile(stateDir: string, rel: string): Promise<ExpectedFile> {
  const parts = rel.split('/');
  let current = stateDir;
  const root = await stat(stateDir);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new SafeError(`GC refuses symlinked state path ${rel}.`);
    if (info.dev !== root.dev) throw new SafeError(`GC refuses cross-device state path ${rel}.`);
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new SafeError(`GC refuses state not owned by the current user: ${rel}.`);
    if ((info.mode & 0o077) !== 0) throw new SafeError(`GC refuses state with group/world permissions: ${rel}.`);
    if (i < parts.length - 1 && !info.isDirectory()) throw new SafeError(`GC state parent is not a directory: ${rel}.`);
    if (i === parts.length - 1 && (!info.isFile() || info.nlink !== 1)) throw new SafeError(`GC refuses non-regular or hard-linked state file ${rel}.`);
    if (i === parts.length - 1) return { rel, dev: String(info.dev), ino: String(info.ino), size: info.size };
  }
  throw new SafeError('GC received an empty state path.');
}

async function appendAudit(stateDir: string, record: Record<string, unknown>) {
  const root = await stat(stateDir);
  const target = path.join(stateDir, AUDIT_PATH);
  const prior = await lstat(target).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (prior && (!prior.isFile() || prior.isSymbolicLink() || prior.nlink !== 1 ||
      (typeof process.getuid === 'function' && prior.uid !== process.getuid()) ||
      (prior.mode & 0o077) !== 0)) {
    throw new SafeError('GC audit path is unsafe.');
  }
  const handle = await open(target,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.nlink !== 1 || current.dev !== root.dev ||
        (typeof process.getuid === 'function' && current.uid !== process.getuid()) ||
        (current.mode & 0o077) !== 0 ||
        (prior && (prior.dev !== current.dev || prior.ino !== current.ino))) {
      throw new SafeError('GC audit path changed or is unsafe.');
    }
    await handle.writeFile(JSON.stringify(record) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function unlinkExpected(store: StateStore, expected: ExpectedFile) {
  const absolute = path.join(store.dir, ...expected.rel.split('/'));
  const info = await lstat(absolute).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      String(info.dev) !== expected.dev || String(info.ino) !== expected.ino || info.size !== expected.size) {
    throw new SafeError(`GC pending file changed before deletion: ${expected.rel}.`);
  }
  await store.remove(expected.rel);
}

function parsePending(value: unknown): PendingDeletion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SafeError('GC pending journal is corrupt.');
  const pending = value as PendingDeletion;
  if (pending.schema_version !== 1 || !TASK_ID.test(pending.task_id) ||
      (pending.category !== 'capture' && pending.category !== 'outcome') ||
      !validDate(pending.eligible_at) || !HEX64.test(pending.witness) || !Array.isArray(pending.files)) {
    throw new SafeError('GC pending journal is corrupt.');
  }
  const capture = pending.category === 'capture';
  if ((capture && !CAPTURE_ID.test(pending.record_id)) ||
      (!capture && !/^[a-f0-9]{32}$/.test(pending.record_id))) throw new SafeError('GC pending journal is corrupt.');
  const expected = capture
    ? [`captures/${pending.task_id}/${pending.record_id}.out`, `captures/${pending.task_id}/${pending.record_id}.json`]
    : [`tasks/${pending.task_id}/outcomes/${pending.record_id}.json`];
  if (pending.files.length !== expected.length) throw new SafeError('GC pending journal is corrupt.');
  for (let index = 0; index < expected.length; index++) {
    const file = pending.files[index];
    if (!file || file.rel !== expected[index] || !DECIMAL.test(file.dev) || !DECIMAL.test(file.ino) ||
        !Number.isSafeInteger(file.size) || file.size < 0) throw new SafeError('GC pending journal is corrupt.');
  }
  return pending;
}

async function resumePending(store: StateStore, taskId: string) {
  const raw = await store.read<unknown>(PENDING_PATH, 'gc-pending');
  if (!raw) return false;
  const pending = parsePending(raw);
  if (pending.task_id !== taskId) throw new SafeError('GC pending journal belongs to another task; inspect it before continuing.');
  for (const file of pending.files) await unlinkExpected(store, file);
  await appendAudit(store.dir, {
    at: new Date().toISOString(), action: 'delete', resumed: true,
    category: pending.category, task_id: pending.task_id,
    record_id: pending.record_id, witness: pending.witness
  });
  await store.remove(PENDING_PATH);
  return true;
}

async function deleteUnit(store: StateStore, pending: PendingDeletion) {
  if (await store.read(PENDING_PATH, 'gc-pending')) throw new SafeError('GC has an unfinished deletion journal; resume it before planning another unit.');
  await store.write(PENDING_PATH, 'gc-pending', pending);
  for (const file of pending.files) await unlinkExpected(store, file);
  await appendAudit(store.dir, {
    at: new Date().toISOString(), action: 'delete', resumed: false,
    category: pending.category, task_id: pending.task_id,
    record_id: pending.record_id, witness: pending.witness
  });
  await store.remove(PENDING_PATH);
}

function parseCapture(value: unknown, id: string, taskId: string): CaptureMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SafeError('Malformed capture metadata.');
  const meta = value as CaptureMeta;
  if (meta.id !== id || !CAPTURE_ID.test(meta.id) || meta.task_id !== taskId ||
      !Number.isSafeInteger(meta.bytes) || meta.bytes < 0 || meta.bytes > MAX_CAPTURE_BYTES ||
      !Number.isFinite(meta.created_at) || !Number.isFinite(meta.expires_at) || meta.expires_at < meta.created_at ||
      !/^[a-f0-9]{64}$/.test(meta.sha256) || !/^[a-f0-9]{64}$/.test(meta.fingerprint) ||
      !/^[a-f0-9]{64}$/.test(meta.index)) throw new SafeError('Malformed capture metadata.');
  return meta;
}

function parseOutcome(value: unknown, fileName: string): Outcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SafeError('Malformed request outcome.');
  const outcome = value as Outcome;
  const hashOrNull = (hash: unknown) => hash === null || (typeof hash === 'string' && HEX64.test(hash));
  if (!REQUEST_ID.test(outcome.request_id) || fileName !== `${sha256(outcome.request_id).slice(0, 32)}.json` ||
      !outcome.operation || !HEX64.test(outcome.args_digest) || !outcome.path ||
      !['intent', 'completed', 'failed'].includes(outcome.status) || !validDate(outcome.updated_at) ||
      !hashOrNull(outcome.before_sha256) || !hashOrNull(outcome.after_sha256) ||
      (outcome.status === 'completed' && (!outcome.result || typeof outcome.after_sha256 !== 'string')) ||
      (outcome.status === 'failed' && typeof outcome.error !== 'string')) {
    throw new SafeError('Malformed request outcome.');
  }
  return outcome;
}

async function collectTask(
  stateDir: string,
  taskId: string,
  completion: Completion,
  options: { apply: boolean; nowMs: number; captureHours: number; taskDays: number; maxRecords: number },
  counts: Counts,
  skipped: Skip[],
  store: StateStore
) {
  if (options.apply) await resumePending(store, taskId);
  let scanned = 0;
  let safe = true;
  const captureDir = `captures/${taskId}`;
  const captureNames = (await store.list(captureDir)).sort();
  scanned += captureNames.length;
  if (scanned > options.maxRecords) throw new SafeError(`GC scan limit exceeded for task ${taskId}.`);
  const captureJson = captureNames.filter(name => CAPTURE_ID.test(name.slice(0, -5)) && name.endsWith('.json'));
  for (const name of captureJson) {
    const id = name.slice(0, -5);
    let deletion: PendingDeletion | undefined;
    let payloadBytes = 0;
    try {
      const meta = parseCapture(await store.read(`${captureDir}/${name}`, 'capture'), id, taskId);
      if (meta.expires_at + options.captureHours * HOUR_MS > options.nowMs) continue;
      const metadata = await checkedFile(stateDir, `${captureDir}/${name}`);
      const payloadRel = `${captureDir}/${id}.out`;
      const payload = await checkedFile(stateDir, payloadRel);
      if (payload.size !== meta.bytes || await hashFile(path.join(stateDir, ...payloadRel.split('/'))) !== meta.sha256) {
        throw new SafeError('Capture payload does not match its metadata.');
      }
      payloadBytes = payload.size;
      deletion = {
        schema_version: 1, category: 'capture', task_id: taskId, record_id: id,
        eligible_at: new Date(meta.expires_at + options.captureHours * HOUR_MS).toISOString(),
        witness: sha256(JSON.stringify(meta)), files: [payload, metadata]
      };
    } catch {
      safe = false;
      skipped.push({ task_id: taskId, reason: `capture-unsafe:${id}` });
      continue;
    }
    if (options.apply) await deleteUnit(store, deletion);
    counts.captures++;
    counts.capture_files += 2;
    counts.payload_bytes += payloadBytes;
  }

  const completionAt = Date.parse(completion.finished_at);
  if (!Number.isFinite(completionAt)) throw new SafeError(`Task ${taskId} has an invalid completion timestamp.`);
  const outcomeDir = `tasks/${taskId}/outcomes`;
  const outcomeNames = (await store.list(outcomeDir)).sort();
  scanned += outcomeNames.length;
  if (scanned > options.maxRecords) throw new SafeError(`GC scan limit exceeded for task ${taskId}.`);
  for (const name of outcomeNames.filter(name => OUTCOME_FILE.test(name))) {
    let deletion: PendingDeletion | undefined;
    try {
      const outcome = parseOutcome(await store.read(`${outcomeDir}/${name}`, 'outcome'), name);
      if (outcome.status === 'intent' || outcome.publication) continue;
      const eligibleMs = Math.max(completionAt, Date.parse(outcome.updated_at)) + options.taskDays * DAY_MS;
      if (eligibleMs > options.nowMs) continue;
      const file = await checkedFile(stateDir, `${outcomeDir}/${name}`);
      deletion = {
        schema_version: 1, category: 'outcome', task_id: taskId, record_id: name.slice(0, -5),
        eligible_at: new Date(eligibleMs).toISOString(), witness: sha256(JSON.stringify(outcome)), files: [file]
      };
    } catch {
      safe = false;
      skipped.push({ task_id: taskId, reason: `outcome-unsafe:${name.slice(0, -5)}` });
      continue;
    }
    if (options.apply) await deleteUnit(store, deletion);
    counts.outcomes++;
  }
  return safe;
}

export async function garbageCollect(options: GcOptions): Promise<GcSummary> {
  const apply = !!options.apply;
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) throw new SafeError('GC clock is invalid.');
  const authHours = integer(options.authRetentionHours, DEFAULT_AUTH_RETENTION_HOURS, 1, 8_760, 'auth retention hours');
  const captureHours = integer(options.captureRetentionHours, DEFAULT_CAPTURE_RETENTION_HOURS, 0, 8_760, 'capture retention hours');
  const taskDays = integer(options.taskRetentionDays, DEFAULT_TASK_RETENTION_DAYS, 1, 3_650, 'task retention days');
  const maxRecords = integer(options.maxRecords, DEFAULT_SCAN_LIMIT, 1, 100_000, 'GC scan limit');
  const summary: GcSummary = {
    schema_version: 1, mode: apply ? 'apply' : 'dry-run',
    as_of: new Date(nowMs).toISOString(), state_dir: path.resolve(options.stateDir),
    retention: { auth_hours: authHours, capture_hours: captureHours, task_days: taskDays },
    catalog_revision: null, complete: true,
    would_remove: emptyCounts(), removed: emptyCounts(), skipped: []
  };

  const inspected = await StateStore.inspect(options.stateDir);
  if (!inspected) return summary;

  const run = async () => {
    const catalog = await readMultiRepoCatalog(options.stateDir);
    summary.catalog_revision = catalog.revision;
    let pendingTaskId: string | undefined;
    const pendingRaw = await inspected.read<unknown>(PENDING_PATH, 'gc-pending');
    if (pendingRaw !== undefined) {
      try {
        const pending = parsePending(pendingRaw);
        if (!catalog.tasks[pending.task_id]?.completed) throw new SafeError('GC pending task is not durably completed.');
        pendingTaskId = pending.task_id;
      } catch {
        summary.complete = false;
        summary.skipped.push({ reason: 'pending-journal-unsafe' });
        return;
      }
      if (!apply) {
        summary.complete = false;
        summary.skipped.push({ task_id: pendingTaskId, reason: 'pending-journal-requires-apply' });
        return;
      }
    }
    const auth = await collectExpiredAuthorization({
      stateDir: options.stateDir,
      cutoffMs: nowMs - authHours * HOUR_MS,
      apply
    });
    const target = apply ? summary.removed : summary.would_remove;
    target.workspaces = auth.workspaces;
    target.grants = auth.grants;
    target.requests = auth.requests;
    if (auth.skipped_workspaces.length) summary.complete = false;
    for (const workspaceId of auth.skipped_workspaces) summary.skipped.push({ workspace_id: workspaceId, reason: 'workspace-busy-or-unsafe' });
    if (apply && (auth.workspaces || auth.grants || auth.requests)) {
      await appendAudit(options.stateDir, {
        at: new Date().toISOString(), action: 'delete', category: 'authorization',
        workspaces: auth.workspaces, grants: auth.grants, requests: auth.requests
      });
    }

    const tasks = Object.values(catalog.tasks).sort((a, b) =>
      (a.task_id === pendingTaskId ? -1 : b.task_id === pendingTaskId ? 1 : a.task_id.localeCompare(b.task_id)));
    for (const task of tasks) {
      if (!task.completed) {
        if ((await inspected.list(`captures/${task.task_id}`)).length ||
            (await inspected.list(`tasks/${task.task_id}/outcomes`)).length) {
          summary.skipped.push({ task_id: task.task_id, reason: 'task-not-completed' });
        }
        continue;
      }
      let live;
      try {
        live = await taskStatus(options.stateDir, task.task_id, { readOnly: true });
        if (!live.completion) {
          summary.skipped.push({ task_id: task.task_id, reason: 'task-draining' });
          continue;
        }
        if (live.binding_epoch !== task.binding_epoch || live.phase_epoch !== task.phase_epoch || live.phase !== task.phase) {
          summary.skipped.push({ task_id: task.task_id, reason: 'task-authority-mismatch' });
          summary.complete = false;
          continue;
        }
      } catch {
        summary.skipped.push({ task_id: task.task_id, reason: 'task-state-invalid' });
        summary.complete = false;
        continue;
      }

      try {
        if (apply) {
          await withCompletedTaskGcLease(options.stateDir, task.task_id, async material => {
            const safe = await collectTask(options.stateDir, task.task_id, material.completion, {
              apply, nowMs, captureHours, taskDays, maxRecords
            }, target, summary.skipped, material.store);
            if (!safe) summary.complete = false;
          });
        } else {
          const safe = await collectTask(options.stateDir, task.task_id, live.completion, {
            apply, nowMs, captureHours, taskDays, maxRecords
          }, target, summary.skipped, inspected);
          if (!safe) summary.complete = false;
        }
      } catch {
        summary.skipped.push({ task_id: task.task_id, reason: 'task-busy-or-unsafe' });
        summary.complete = false;
      }
    }
  };

  if (!apply) {
    await run();
  } else {
    const store = await StateStore.open(options.stateDir);
    const lock = await acquireLock(store, 'gc-v1', 'garbage collection');
    try {
      await appendAudit(store.dir, { at: new Date().toISOString(), action: 'start', category: 'run', as_of: summary.as_of });
      await run();
    } finally { await lock.release(); }
  }
  summary.skipped.sort((a, b) =>
    (a.task_id ?? '').localeCompare(b.task_id ?? '') ||
    (a.workspace_id ?? '').localeCompare(b.workspace_id ?? '') ||
    a.reason.localeCompare(b.reason)
  );
  if (apply) summary.would_remove = { ...summary.removed };
  return summary;
}
