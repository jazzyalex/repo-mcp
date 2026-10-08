import { lstat, mkdir, open, readFile, readdir, realpath, rename, link, unlink, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { SafeError } from './errors.js';

// Operator-owned durable state outside served repositories. Every record is
// {version, kind, data}; unknown versions, wrong kinds and corrupt JSON fail closed.

export const STATE_VERSION = 1;
export class StateError extends SafeError {}

export function defaultStateDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'repo-mcp', 'state');
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'repo-mcp');
}

async function canonicalProspective(target: string) {
  // Resolve symlinks in the existing ancestor without creating anything yet.
  let existing = path.resolve(target);
  const rest: string[] = [];
  while (true) {
    try { return path.join(await realpath(existing), ...rest); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(existing) === existing) throw error;
      rest.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
}

const within = (child: string, parent: string) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

export class StateStore {
  private constructor(readonly dir: string) {}

  static canonicalPath(dir: string) { return canonicalProspective(dir); }

  static async open(dir: string, options: { forbiddenRoots?: string[] } = {}) {
    const canonical = await canonicalProspective(dir);
    for (const root of options.forbiddenRoots ?? []) {
      const forbidden = await realpath(root);
      if (within(canonical, forbidden) || within(forbidden, canonical)) throw new StateError('Task state directory must be outside served repositories.');
    }
    await mkdir(canonical, { recursive: true, mode: 0o700 });
    if ((await lstat(canonical)).isSymbolicLink()) throw new StateError('Task state directory must not be a symlink.');
    await chmod(canonical, 0o700);
    return new StateStore(canonical);
  }

  /** Read-only state access for status/inspection. Never creates or chmods the state directory. */
  static async inspect(dir: string, options: { forbiddenRoots?: string[] } = {}) {
    const requested = path.resolve(dir);
    let info;
    try { info = await lstat(requested); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (info.isSymbolicLink()) throw new StateError('Operator state directory must not be a symlink.');
    if (!info.isDirectory()) throw new StateError('Operator state path is not a directory.');
    const mode = info.mode & 0o777;
    if (mode !== 0o700) throw new StateError(`Operator state directory permissions are ${mode.toString(8)}; expected 0700. Status will not repair them.`);
    const canonical = await realpath(requested);
    for (const root of options.forbiddenRoots ?? []) {
      const forbidden = await realpath(root);
      if (within(canonical, forbidden) || within(forbidden, canonical)) throw new StateError('Task state directory must be outside served repositories.');
    }
    return new StateStore(canonical);
  }

  private resolve(rel: string) {
    const parts = rel.split('/');
    if (path.isAbsolute(rel) || parts.some(p => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(p))) throw new StateError('Invalid state path.');
    return path.join(this.dir, ...parts);
  }

  private async syncDir(dir: string) {
    const handle = await open(dir, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }

  private async stage(target: string, kind: string, data: unknown) {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = path.join(path.dirname(target), `.tmp-${randomUUID()}`);
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ version: STATE_VERSION, kind, data }) + '\n', 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    return temp;
  }

  async write(rel: string, kind: string, data: unknown) {
    const target = this.resolve(rel);
    const temp = await this.stage(target, kind, data);
    try { await rename(temp, target); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
    await this.syncDir(path.dirname(target));
  }

  /** Publish a new record; returns false without touching an existing one. */
  async create(rel: string, kind: string, data: unknown) {
    const target = this.resolve(rel);
    const temp = await this.stage(target, kind, data);
    try { await link(temp, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    } finally { await unlink(temp).catch(() => {}); }
    await this.syncDir(path.dirname(target));
    return true;
  }

  async read<T = unknown>(rel: string, kind: string): Promise<T | undefined> {
    const target = this.resolve(rel);
    let text: string;
    try { text = await readFile(target, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // readFile follows symlinks, so ENOENT may mean a missing referent.
      // Only an absent pathname is safe to treat as an absent state record.
      try { await lstat(target); }
      catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw inspectionError;
      }
      throw new StateError(`Unsafe task state pathname ${rel}; inspect it before continuing.`);
    }
    let record: { version?: unknown; kind?: unknown; data?: unknown };
    try { record = JSON.parse(text); } catch { throw new StateError(`Corrupt task state record ${rel}; inspect it before continuing.`); }
    if (!record || typeof record !== 'object') throw new StateError(`Corrupt task state record ${rel}; inspect it before continuing.`);
    if (record.version !== STATE_VERSION) throw new StateError(`Unsupported task state version in ${rel}.`);
    if (record.kind !== kind) throw new StateError(`Unexpected task state kind in ${rel}.`);
    if (!Object.hasOwn(record, 'data')) throw new StateError(`Corrupt task state record ${rel}; inspect it before continuing.`);
    return record.data as T;
  }

  /** Names of the entries in a state directory; none if it does not exist yet. */
  async list(rel: string) {
    try { return await readdir(this.resolve(rel)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }

  async remove(rel: string) {
    const target = this.resolve(rel);
    try { await unlink(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await this.syncDir(path.dirname(target)).catch(() => {});
  }
}

export type LockRecord = { pid: number; hostname: string; token: string; purpose: string; acquired_at: string };

export function validateLockRecord(value: unknown, key: string): LockRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StateError(`Corrupt lock record for ${key}; inspect it before recovery.`);
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0 ||
      typeof record.hostname !== 'string' || !record.hostname.trim() ||
      typeof record.token !== 'string' || !record.token.trim() ||
      typeof record.purpose !== 'string' || !record.purpose.trim() ||
      typeof record.acquired_at !== 'string' || !record.acquired_at.trim() ||
      !Number.isFinite(Date.parse(record.acquired_at))) {
    throw new StateError(`Corrupt lock record for ${key}; inspect it before recovery.`);
  }
  return record as LockRecord;
}

export function lockOwnerAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new StateError('Lock owner PID is invalid; manual inspection is required.');
  try { process.kill(pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    throw new StateError(`Unable to verify lock owner process ${pid}; manual inspection is required.`);
  }
}

export type Lock = { key: string; token: string; owned(): Promise<boolean>; release(): Promise<void> };

/**
 * Cooperative cross-process lock. It cannot stop editors or arbitrary shells.
 * A lock left by a dead process is reported as stale and only removed when the
 * operator asks for explicit recovery.
 */
export async function acquireLock(store: StateStore, key: string, purpose: string, options: {
  recoverStale?: boolean;
  expectedExistingPurpose?: string;
  expectedExistingToken?: string;
} = {}): Promise<Lock> {
  const rel = `locks/${key}.json`;
  const record: LockRecord = { pid: process.pid, hostname: os.hostname(), token: randomUUID(), purpose, acquired_at: new Date().toISOString() };
  let releasePromise: Promise<void> | undefined;
  const lock: Lock = {
    key, token: record.token,
    owned: async () => {
      const current = await store.read<unknown>(rel, 'lock');
      if (!current) return false;
      return validateLockRecord(current, key).token === record.token;
    },
    release: () => {
      if (releasePromise) return releasePromise;
      const run = (async () => {
        if (await lock.owned()) await store.remove(rel);
      })();
      releasePromise = run;
      void run.catch(() => { if (releasePromise === run) releasePromise = undefined; });
      return run;
    }
  };
  let existing: LockRecord;
  while (true) {
    if (await store.create(rel, 'lock', record)) return lock;
    const existingRaw = await store.read<unknown>(rel, 'lock');
    // The holder may release after our exclusive create loses but before this
    // read. That is ordinary contention, not corrupt state; retry the claim.
    if (existingRaw === undefined) continue;
    existing = validateLockRecord(existingRaw, key);
    break;
  }
  if (existing.hostname !== record.hostname) throw new StateError(`Lock ${key} is owned by a process on ${existing.hostname}; it cannot be verified from this host.`);
  if (lockOwnerAlive(existing.pid)) throw new StateError(`Lock ${key} is already owned by live process ${existing.pid} (${existing.purpose}).`);
  if (options.expectedExistingPurpose !== undefined && existing.purpose !== options.expectedExistingPurpose) throw new StateError(`Lock ${key} belongs to ${existing.purpose}, not ${options.expectedExistingPurpose}; refusing stale recovery.`);
  if (options.expectedExistingToken !== undefined && existing.token !== options.expectedExistingToken) throw new StateError(`Lock ${key} changed before stale recovery; refusing to remove a replacement lock.`);
  if (!options.recoverStale) throw new StateError(`Stale lock ${key} from exited process ${existing.pid} (${existing.purpose}, ${existing.acquired_at}). Inspect task state, then recover the lock explicitly.`);
  // Recovery is serialized by an exclusive marker. Normal acquisition only ever
  // creates, and the stale owner is dead, so under the marker the record cannot
  // change between our token check and removal.
  const marker = `locks/${key}.recovery.json`;
  if (!(await store.create(marker, 'lock-recovery', record))) {
    const holderRaw = await store.read<unknown>(marker, 'lock-recovery');
    const holder = holderRaw ? validateLockRecord(holderRaw, `${key} recovery marker`) : undefined;
    if (holder && holder.hostname === record.hostname && !lockOwnerAlive(holder.pid)) throw new StateError(`Stale recovery marker for lock ${key} from exited process ${holder.pid}. Inspect ${marker} in the state directory and remove it manually.`);
    throw new StateError(`Lock ${key} recovery is already in progress by process ${holder?.pid ?? 'unknown'}.`);
  }
  try {
    const currentRaw = await store.read<unknown>(rel, 'lock');
    const current = currentRaw ? validateLockRecord(currentRaw, key) : undefined;
    if (current && current.token !== existing.token) throw new StateError(`Lock ${key} changed during recovery; retry.`);
    if (current) await store.remove(rel);
    if (await store.create(rel, 'lock', record)) return lock;
    throw new StateError(`Lock ${key} was claimed by another process during recovery.`);
  } finally { await store.remove(marker); }
}

/** Short-lived lock for coordinator Git operations across linked worktrees. */
export async function withShortLock<T>(store: StateStore, key: string, fn: () => Promise<T>, options: { waitMs?: number; purpose?: string } = {}): Promise<T> {
  const deadline = Date.now() + (options.waitMs ?? 5000);
  let lock: Lock | undefined;
  while (!lock) {
    try { lock = await acquireLock(store, key, options.purpose ?? 'git-operation'); }
    catch (error) {
      if (!(error instanceof StateError) || !/live process/.test(error.message)) throw error;
      if (Date.now() >= deadline) throw new StateError(`Coordination lock ${key} is busy; retry after the other operation finishes.`);
      await new Promise(r => setTimeout(r, 25));
    }
  }
  try { return await fn(); } finally { await lock.release(); }
}
