import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { SafeError } from './errors.js';
import type { RepoIdentity } from './identity.js';

// Retained Git output. Git runs once; its stdout is streamed into `<id>.partial`, then published
// as `<id>.out` plus a metadata record `<id>.json`. Only a capture with both files is valid, so a
// crash mid-stream leaves orphans that the next sweep removes. Pages are read by byte offset.

export const CAPTURE_VERSION = 1;
export const CAPTURE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type CaptureIdentity = Pick<RepoIdentity, 'root' | 'git_dir' | 'common_dir' | 'branch' | 'head'>;
export type CaptureMeta = {
  id: string; kind: string; args: string; task_id: string | null; identity: CaptureIdentity; fingerprint: string;
  /** Digest of the Git index state the output depends on; a record without it never matches. */
  index: string;
  bytes: number; sha256: string; created_at: number; expires_at: number;
};
export type CaptureOptions = { limitBytes: number; maxCaptureBytes: number; ttlMs: number; clock?: () => number };
export type PendingCapture = {
  id: string; path: string;
  /** Publish the finished output. The caller guarantees the file is complete and valid. */
  commit(meta: Pick<CaptureMeta, 'kind' | 'args' | 'task_id' | 'identity' | 'fingerprint' | 'index'>): Promise<CaptureMeta>;
  /** Remove the partial output; safe to call after commit or twice. */
  abort(): Promise<void>;
};

const GONE = 'Retained Git output expired, was evicted or is unknown (for example after a restart without task state). Start again without a cursor.';

async function hashFile(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Per-process capture directories (untracked mode) are named with their owner's PID. */
export const TEMP_PREFIX = 'repo-mcp-captures-';

/** Remove per-process capture directories left behind by processes that no longer exist. */
export async function removeOrphanedTempDirs(tmp: string) {
  for (const entry of await readdir(tmp, { withFileTypes: true }).catch(() => [])) {
    const match = entry.isDirectory() ? new RegExp(`^${TEMP_PREFIX}(\\d+)-`).exec(entry.name) : null;
    if (!match) continue;
    try { process.kill(Number(match[1]), 0); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
    await rm(path.join(tmp, entry.name), { recursive: true, force: true }).catch(() => {});
  }
}

export class CaptureStore {
  private reserved = 0;
  private active = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();
  readonly maxCaptureBytes: number;
  private constructor(readonly dir: string, private readonly options: CaptureOptions) {
    this.maxCaptureBytes = options.maxCaptureBytes;
  }
  private now() { return (this.options.clock ?? Date.now)(); }

  static async open(dir: string, options: CaptureOptions) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if ((await lstat(dir)).isSymbolicLink()) throw new SafeError('Capture directory must not be a symlink.');
    await chmod(dir, 0o700);
    const store = new CaptureStore(dir, options);
    await store.exclusive(() => store.sweep());
    return store;
  }

  /** Serialize operations that change the set of retained captures. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }
  private file(id: string, ext: 'partial' | 'out' | 'json') {
    if (!CAPTURE_ID.test(id)) throw new SafeError('Invalid capture ID.');
    return path.join(this.dir, `${id}.${ext}`);
  }
  private async readMeta(id: string): Promise<CaptureMeta | undefined> {
    let text: string;
    try { text = await readFile(this.file(id, 'json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    try {
      const record = JSON.parse(text) as { version?: unknown; kind?: unknown; data?: CaptureMeta };
      if (record.version !== CAPTURE_VERSION || record.kind !== 'capture' || !record.data || record.data.id !== id
        || !Number.isSafeInteger(record.data.bytes) || !Number.isFinite(record.data.expires_at)) return undefined;
      return record.data;
    } catch { return undefined; }
  }
  private async remove(id: string) {
    for (const ext of ['partial', 'out', 'json'] as const) await unlink(this.file(id, ext)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }

  /** Remove expired captures and the leftovers of interrupted ones. Call under the lock. */
  private async sweep() {
    const ids = new Set<string>();
    for (const name of await readdir(this.dir)) {
      const match = /^([0-9a-f-]{36})\.(partial|out|json)$/.exec(name);
      if (match && CAPTURE_ID.test(match[1])) ids.add(match[1]);
      else if (name.startsWith('.tmp-')) await unlink(path.join(this.dir, name)).catch(() => {});
    }
    for (const id of ids) {
      if (this.active.has(id)) continue;
      const meta = await this.readMeta(id);
      let keep = !!meta && this.now() < meta.expires_at;
      if (keep) keep = (await stat(this.file(id, 'out')).catch(() => undefined))?.size === meta!.bytes;
      if (!keep) await this.remove(id);
    }
  }
  private async retained() {
    const result: CaptureMeta[] = [];
    for (const name of await readdir(this.dir)) {
      const match = /^([0-9a-f-]{36})\.json$/.exec(name);
      const meta = match && CAPTURE_ID.test(match[1]) ? await this.readMeta(match[1]) : undefined;
      if (meta) result.push(meta);
    }
    return result.sort((a, b) => a.created_at - b.created_at);
  }

  /** Reserve room for one capture, evicting expired and then the oldest captures if needed. */
  begin(): Promise<PendingCapture> {
    return this.exclusive(async () => {
      await this.sweep();
      const kept = await this.retained();
      let used = kept.reduce((n, m) => n + m.bytes, 0) + this.reserved;
      while (used + this.maxCaptureBytes > this.options.limitBytes && kept.length) {
        const oldest = kept.shift()!;
        await this.remove(oldest.id);
        used -= oldest.bytes;
      }
      if (used + this.maxCaptureBytes > this.options.limitBytes) throw new SafeError('Git output storage is busy with other captures; retry after they finish.');
      this.reserved += this.maxCaptureBytes;
      const id = randomUUID();
      this.active.add(id);
      let finished = false;
      const settle = () => { if (!finished) { finished = true; this.reserved -= this.maxCaptureBytes; this.active.delete(id); } };
      return {
        id, path: this.file(id, 'partial'),
        commit: async fields => {
          try {
            const partial = this.file(id, 'partial');
            const bytes = (await stat(partial)).size;
            if (bytes > this.maxCaptureBytes) throw new SafeError('Git output exceeded the capture limit.');
            const handle = await open(partial, 'r');
            try { await handle.sync(); } finally { await handle.close(); }
            const sha256 = await hashFile(partial);
            const created = this.now();
            const meta: CaptureMeta = { id, ...fields, bytes, sha256, created_at: created, expires_at: created + this.options.ttlMs };
            await rename(partial, this.file(id, 'out'));
            const temp = path.join(this.dir, `.tmp-${randomUUID()}`);
            await writeFile(temp, JSON.stringify({ version: CAPTURE_VERSION, kind: 'capture', data: meta }) + '\n', { mode: 0o600, flag: 'wx' });
            await rename(temp, this.file(id, 'json'));
            return meta;
          } catch (error) { await this.remove(id).catch(() => {}); throw error; }
          finally { settle(); }
        },
        abort: async () => { try { await this.remove(id); } finally { settle(); } }
      };
    });
  }

  /** The record for a live capture; expired, evicted, unknown or damaged captures are errors. */
  async get(id: string): Promise<CaptureMeta> {
    if (!CAPTURE_ID.test(id)) throw new SafeError('Invalid cursor: unknown capture. Start again without a cursor.');
    const meta = await this.readMeta(id);
    if (!meta) throw new SafeError(GONE);
    if (this.now() >= meta.expires_at) { await this.discard(id); throw new SafeError(GONE); }
    const size = (await stat(this.file(id, 'out')).catch(() => undefined))?.size;
    if (size !== meta.bytes) { await this.discard(id); throw new SafeError('Retained Git output is damaged. Start again without a cursor.'); }
    return meta;
  }
  /** Read up to `length` bytes at `offset`. */
  async read(meta: CaptureMeta, offset: number, length: number) {
    const handle = await open(this.file(meta.id, 'out'), 'r').catch(() => { throw new SafeError(GONE); });
    try {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, meta.bytes - offset)));
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, offset + filled);
        if (!bytesRead) throw new SafeError('Retained Git output is damaged. Start again without a cursor.');
        filled += bytesRead;
      }
      return buffer;
    } finally { await handle.close(); }
  }
  discard(id: string) { return this.exclusive(() => this.remove(id)); }
  /** Retained captures, oldest first (diagnostics and tests). */
  list() { return this.exclusive(() => this.retained()); }
  /** Delete the whole directory; only for stores that live and die with one server process. */
  destroy() { return this.exclusive(() => rm(this.dir, { recursive: true, force: true })); }
}
