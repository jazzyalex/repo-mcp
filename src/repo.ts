import { lstat, open, realpath, rename, link, unlink, mkdtemp, mkdir, writeFile, appendFile, rm, readdir, rmdir, stat as statFile } from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPatch } from 'diff';
import { pythonCommand, type PythonRunner } from './python-runner.js';
import { SafeError, NotAppliedError, NotTextError, sha256 } from './errors.js';
import { execute, runGit, runGitToFile } from './exec.js';
import { CaptureStore, TEMP_PREFIX, removeOrphanedTempDirs, type CaptureMeta } from './capture.js';
import { DEFAULT_LIMITS, OPERATION_BUDGET_MS, GIT_CAPTURE_BYTES, GIT_BUFFERED_BYTES, type Limits } from './limits.js';
import { pageText, countNewlines, jsonBytes, encodeCursor, decodeCursor, staleCursor, formatBytes } from './paging.js';
import { Deadline } from './deadline.js';
import { resolveIdentity, identityDrift, type RepoIdentity } from './identity.js';
import { TaskContext, type TaskOptions, type MutationResult, type Publication, type Outcome } from './task.js';
import { PathPolicy } from './path-policy.js';
import { Inventory, walk, fingerprint, emptySkipped, type Entry, type WalkContext } from './inventory.js';
import { fold, nfc, pathProblem } from './glob.js';
import { openVerified, assertNoSymlinks, dirIdentity, assertSameDir, verifyPublished, removeIfSame, diffInput, type PathHook, type DiffInput } from './safe-fs.js';
import { batchPaths } from './git-batches.js';
import type { CompiledPolicy } from './policy.js';

export { SafeError, sha256, execute };
export const files = ['AGENTS.md', 'README.md', 'package.json', 'src/clamp.js', 'test/clamp.test.js'];

export type RepoPolicy = { files: string[]; editable: string[]; tests: string[]; creatable?: string[]; runner?: PythonRunner };
export const defaultPolicy: RepoPolicy = { files, editable: ['src/clamp.js'], tests: ['test/clamp.test.js'] };
/** Test seams: `monotonicClock` drives operation deadlines, `captureHook` observes capture stages. */
export type OperationPreflight = () => Promise<void>;
export type RepoOptions = {
  task?: TaskOptions; limits?: Partial<Limits>; operationBudgetMs?: number; clock?: () => number;
  monotonicClock?: () => number; captureHook?: (stage: 'before-git' | 'after-git', attempt: number, run?: number) => void | Promise<void>;
  /** Test seam: runs at named stages between a path check and the operation it guards. */
  pathHook?: PathHook;
  /** Test seam: sees the arguments and timeout (ms, when given) of every buffered Git call the repo makes (`git()`). */
  gitHook?: (args: string[], timeout?: number) => void;
  /** Test seam: pauses the first/only close before task ownership is released. */
  closeHook?: () => void | Promise<void>;
};
/** repo_info carries at most this much of AGENTS.md; the rest is read with its continuation cursor. */
const INSTRUCTIONS_BYTES = 8 * 1024;
const SEARCH_PAGE_MATCHES = 50;
const MATCH_WINDOW = 300;
/** A capture whose inputs changed during generation is discarded and retried this many times in total. */
const CAPTURE_ATTEMPTS = 3;
/** Glob-mode `run_tests` snapshots copy the readable inventory; larger sets wait for milestone 3 execution scopes. */
const SNAPSHOT_MAX_FILES = 5_000;
const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_CREATE_DIRS = 8;
const NOT_EXPOSED = 'Path is not exposed by this repository policy.';
type Applied<T> = T & { already_applied?: true; outcome_warning?: string };
const OUTCOME_WARNING = 'Change applied, but its outcome record failed. Retrying with this request_id reconciles by file hash.';
const LIST_KEYS = ['files', 'editable_files', 'creatable_files', 'test_suites', 'configured_test_suites', 'editable_test_files'] as const;
type PathLists = Record<typeof LIST_KEYS[number], string[]>;
/** Stand-in for a cursor inside a size estimate: as long as the encoded cursor can get. */
const cursorReserve = (kind: string, fields: Record<string, unknown>) => '0'.repeat(encodeCursor({ k: kind, ...fields }).length);
const SHA_PLACEHOLDER = '0'.repeat(64);
const MAX_INT = Number.MAX_SAFE_INTEGER;
const isIndex = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const CURSOR_SKEW_MS = 5 * 60_000;
/** The only name pattern a server-made temporary has: `.mcp-<uuid>.tmp`. */
const TEMP_NAME = /^\.mcp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
/** Startup tracking validation gets this long when `operationBudgetMs` is 0 (legacy compatibility; see `startupDeadline`). */
const STARTUP_VALIDATION_MS = 10_000;
/** Index entry flags that change status and diff: assume-unchanged (CE_VALID), intent-to-add, skip-worktree. */
const INDEX_FLAGS = 0x8000 | 0x20000000 | 0x40000000;
/** The fixed stat block that `ls-files --debug` prints after each entry; group 1 is the entry's flags in hex. */
const DEBUG_STAT = /^ {2}ctime: [^\n]*\n {2}mtime: [^\n]*\n {2}dev: [^\n]*\n {2}uid: [^\n]*\n {2}size: [^\n]*\tflags: ([0-9a-f]+)\n/;
const DEBUG_STAT_MAX = 512;
/** Entry listing with stat lines is about 250 bytes per path; this covers several hundred thousand paths. */
const INDEX_READ_BYTES = 128 * 1024 * 1024;

type CaptureContext = {
  max: number; attempt: number; deadline: Deadline; out: string;
  left(): number; expired(): SafeError;
  /** Run Git, streaming stdout into the capture (appending when asked). */
  run(args: string[], append?: boolean): Promise<void>;
  /** Run Git for a NUL-separated name listing; undecodable names cannot match any policy path. */
  names(args: string[]): Promise<string[]>;
  append(text: string): Promise<void>;
};

function validateMembership(policy: RepoPolicy) {
  if (policy.editable.some(f => !policy.files.includes(f)) || policy.tests.some(f => !policy.files.includes(f)) || (policy.creatable ?? []).some(f => !policy.files.includes(f) || !policy.editable.includes(f))) throw new SafeError('Invalid policy membership.');
}
/**
 * The exact lists of a compiled v2 policy: membership and path syntax only. Dot-leading segments, built-in denials and
 * server-owned paths are the PathPolicy's business (`requireConsistent`), so an approved literal dotfile is allowed.
 */
function validateCompiledLists(policy: RepoPolicy) {
  validateMembership(policy);
  for (const file of policy.files) if (pathProblem(file)) throw new SafeError('Invalid policy path.');
}
/** v1 checks that need no I/O; messages are part of the existing contract. Direct v1 policies ban every dot-leading segment. */
function validateLegacy(policy: RepoPolicy) {
  validateMembership(policy);
  for (const file of policy.files) {
    if (!file || path.isAbsolute(file) || file.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) throw new SafeError('Invalid policy path.');
  }
}
/** The exact lists must be what the path policy itself allows; a hand-built or stale pair is refused, never trusted. */
function requireConsistent(compiled: CompiledPolicy) {
  const legacy = compiled.legacy!;
  const lists: [string[], 'read' | 'write' | 'create'][] = [[legacy.files, 'read'], [legacy.tests, 'read'], [legacy.editable, 'write'], [legacy.creatable ?? [], 'create']];
  for (const [paths, op] of lists) for (const file of paths) {
    const decision = compiled.paths.decide(file, op);
    if (!decision.ok) throw new SafeError(`Policy lists "${file}" for ${op}, but its path policy denies it (${decision.reason}). Compile the policy with compilePolicyFor.`);
  }
}
function compileLegacy(policy: RepoPolicy): CompiledPolicy {
  validateLegacy(policy);
  const paths = PathPolicy.compile({ read: { include: policy.files }, write: { include: policy.editable }, create: { paths: policy.creatable ?? [] }, checks: policy.tests });
  return { paths, legacy: policy, ...(policy.runner ? { runner: policy.runner } : {}) };
}

export class RepoWorkspace {
  private busy = false;
  private testHashes = new Map<string, string>();
  private task?: TaskContext;
  private closePromise?: Promise<void>;
  /** Retained Git output; assigned in create(). */
  captures!: CaptureStore;
  private ownsCaptureDir = false;
  readonly limits: Limits;
  private readonly operationBudgetMs: number;
  private readonly monotonicClock?: () => number;
  private readonly captureHook?: RepoOptions['captureHook'];
  private readonly pathHook?: PathHook;
  private readonly gitHook?: RepoOptions['gitHook'];
  private readonly closeHook?: RepoOptions['closeHook'];
  private readonly clock: () => number;
  private readonly paths: PathPolicy;
  /** The v1 exact-list form; present exactly when the policy is made of exact paths (exact mode). */
  private readonly legacy?: RepoPolicy;
  private readonly runner?: PythonRunner;
  private readonly repoBinding: string;
  private inv?: Inventory;
  private refreshing: Promise<unknown> = Promise.resolve();
  private constructor(readonly root: string, compiled: CompiledPolicy, private readonly identity: RepoIdentity, options: RepoOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.operationBudgetMs = options.operationBudgetMs ?? OPERATION_BUDGET_MS;
    this.monotonicClock = options.monotonicClock;
    this.captureHook = options.captureHook;
    this.pathHook = options.pathHook;
    this.gitHook = options.gitHook;
    this.closeHook = options.closeHook;
    this.clock = options.clock ?? Date.now;
    this.paths = compiled.paths;
    this.legacy = compiled.legacy;
    this.runner = compiled.runner;
    this.repoBinding = sha256([identity.root, identity.git_dir, identity.common_dir].join('\0'));
  }
  static async create(root: string, policy: RepoPolicy | CompiledPolicy = defaultPolicy, options: RepoOptions = {}) {
    if (!path.isAbsolute(root)) throw new SafeError('REPO_ROOT must be absolute.');
    const canonical = await realpath(root);
    if (!(await lstat(canonical)).isDirectory()) throw new SafeError('REPO_ROOT must be a directory.');
    let compiled: CompiledPolicy;
    if ('paths' in policy) {
      compiled = policy;
      if (compiled.legacy) { compiled = { ...compiled, legacy: structuredClone(compiled.legacy) }; validateCompiledLists(compiled.legacy!); requireConsistent(compiled); }
    } else compiled = compileLegacy(structuredClone(policy));
    const repo = new RepoWorkspace(canonical, compiled, await resolveIdentity(canonical), options);
    // Task binding normally comes last so a validation failure never leaves a lock behind. A task that has recorded
    // outcomes may have an interrupted create_file publication whose hard-linked target would fail validation, so it
    // takes the lock first, settles those publications from their recorded evidence, and releases on any failure.
    let task: TaskContext | undefined;
    try {
      if (options.task && await TaskContext.hasOutcomes(options.task)) {
        task = await TaskContext.open(options.task, repo.identity);
        for (const outcome of await task.pendingPublications()) await repo.recoverPublication(outcome).catch(error => { if (!(error instanceof SafeError)) throw error; });
      }
      if (repo.legacy) await repo.validateExact(repo.legacy); else await repo.validateGlob();
    } catch (error) { await task?.close(); throw error; }
    // A refused recovery is left for the retry of that request, which reports it; exact validation fails closed on the link.
    if (options.task) repo.task = task ?? await TaskContext.open(options.task, repo.identity);
    try {
      // Task captures live in operator state, so cursors survive a restart; otherwise they die with this process.
      repo.ownsCaptureDir = !repo.task;
      if (!repo.task) await removeOrphanedTempDirs(os.tmpdir());
      const dir = repo.task ? path.join(repo.task.stateDir, 'captures', repo.task.taskId) : await mkdtemp(path.join(os.tmpdir(), `${TEMP_PREFIX}${process.pid}-`));
      repo.captures = await CaptureStore.open(dir, {
        limitBytes: repo.limits.retained_output_bytes, maxCaptureBytes: Math.max(1, Math.min(GIT_CAPTURE_BYTES, Math.floor(repo.limits.retained_output_bytes / 2))),
        ttlMs: repo.limits.cursor_ttl_hours * 3_600_000, clock: options.clock
      });
    } catch (error) { await repo.task?.close(); throw error; }
    return repo;
  }
  /** Exact mode: every listed file is validated now, exactly as in v1. */
  private async validateExact(policy: RepoPolicy) {
    for (const file of policy.files) if (await this.exists(file)) await this.readResolved(file);
    for (const file of policy.tests.filter(f => !policy.editable.includes(f))) this.testHashes.set(file, (await this.readResolved(file)).sha256);
    await this.requireEditableTracked(policy.editable, this.startupDeadline());
  }
  /** Glob mode cannot read every file at startup; it validates structure and the protected checks. */
  private async validateGlob() {
    const { tests, writes } = this.paths.literalPaths;
    for (const file of tests) {
      if (!this.paths.decide(file, 'read').ok) throw new SafeError(`Check path "${file}" is not readable under this policy.`);
      if (this.paths.decide(file, 'write').ok) continue;
      try { this.testHashes.set(file, (await this.readResolved(file)).sha256); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await this.requireEditableTracked(writes.filter(f => !/[*?]/.test(f) && this.paths.decide(f, 'write').ok), this.startupDeadline());
  }
  close() {
    if (this.closePromise) return this.closePromise;
    const run = (async () => {
      await this.closeHook?.();
      await this.task?.close();
      if (this.ownsCaptureDir) await this.captures.destroy();
    })();
    this.closePromise = run;
    void run.catch(() => { if (this.closePromise === run) this.closePromise = undefined; });
    return run;
  }
  /** True when the policy is made of exact paths (v1 behaviour); false for discovered (glob) policies. */
  get exactPolicy() { return !!this.legacy; }

  // --- Paths, inventory and cursors ------------------------------------------------------------
  private async exists(file: string) {
    try { await this.checked(file); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && this.isCreatable(file)) return false;
      throw error;
    }
  }
  private isCreatable(file: string) { return this.paths.createRule(file).ok; }
  private newDeadline() { return new Deadline(this.operationBudgetMs, this.monotonicClock); }
  private walkContext(deadline: Deadline): WalkContext {
    return {
      root: this.root, policy: this.paths, inventoryPaths: this.limits.inventory_paths, maxFileBytes: this.limits.edit_file_bytes, deadline,
      expired: () => new SafeError(`Discovery timed out (${this.operationBudgetMs} ms operation budget); narrow read.include or add excludes.`), hook: this.pathHook
    };
  }
  /** Glob mode: bring the cached inventory up to date for this call. Exact mode has nothing to refresh. */
  private touch(deadline: Deadline = this.newDeadline()): Promise<Inventory | undefined> {
    if (this.legacy) return Promise.resolve(undefined);
    const run = this.refreshing.then(async () => {
      const ctx = this.walkContext(deadline);
      this.inv = this.inv ? await this.inv.refresh(ctx) : await walk(ctx);
      return this.inv;
    });
    this.refreshing = run.catch(() => {});
    return run;
  }
  /** A fresh inventory in either mode (exact mode lists its literal files that exist). */
  private async current(deadline?: Deadline): Promise<Inventory> {
    if (!this.legacy) return (await this.touch(deadline))!;
    const entries: Entry[] = [];
    for (const file of this.legacy.files) {
      // A listed file that was deleted after startup is simply absent: its deletion must stay visible in diffs.
      const present = await this.exists(file).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; });
      if (!present) continue;
      const stat = await lstat(path.join(this.root, file), { bigint: true });
      entries.push({ path: file, size: Number(stat.size), mode: Number(stat.mode), fp: fingerprint(stat) });
    }
    return Inventory.of(entries, [], emptySkipped(), this.paths.digest);
  }
  /** The disk spelling of an exposed path, or an error that is identical for denied, missing and unlisted paths. */
  private exposed(file: string): string {
    if (this.legacy) { if (!this.legacy.files.includes(file) || !this.paths.decide(file, 'read').ok) throw new SafeError(NOT_EXPOSED); return file; }
    const entry = this.inv?.resolve(file);
    if (!entry) throw new SafeError(NOT_EXPOSED);
    return entry.path;
  }
  private inventoryBlock(inv: Inventory) { return { paths: inv.paths, directories: inv.dirs.length, skipped: inv.skipped, digest: inv.digest }; }
  private makeCursor(kind: string, fields: Record<string, unknown>) {
    return encodeCursor({ k: kind, r: this.repoBinding, p: this.paths.digest, t: this.clock(), ...fields });
  }
  private cursorShell(kind: string, fields: Record<string, number>) {
    return cursorReserve(kind, { r: SHA_PLACEHOLDER, p: SHA_PLACEHOLDER, i: SHA_PLACEHOLDER, a: SHA_PLACEHOLDER, t: MAX_INT, ...fields });
  }
  /** Validate a restart-safe cursor: shape, repository, policy, arguments, creation time and expiry. */
  private readCursor(kind: string, cursor: string, expect: Record<string, string>) {
    const c = decodeCursor<Record<string, unknown>>(cursor, kind);
    const bad = () => new SafeError(`Invalid cursor for ${kind}. Start again without a cursor.`);
    if (typeof c.r !== 'string' || typeof c.p !== 'string' || typeof c.i !== 'string' || typeof c.a !== 'string' || typeof c.t !== 'number' || !Number.isFinite(c.t)) throw bad();
    if (c.r !== this.repoBinding || c.p !== this.paths.digest) throw new SafeError('Invalid cursor for this repository or policy. Start again without a cursor.');
    const now = this.clock();
    if (c.t > now + CURSOR_SKEW_MS) throw new SafeError(`Invalid cursor for ${kind}: it is dated in the future. Start again without a cursor.`);
    if (now - c.t > this.limits.cursor_ttl_hours * 3_600_000) throw new SafeError(`Cursor for ${kind} expired. Start again without a cursor.`);
    for (const [key, value] of Object.entries(expect)) if (c[key] !== value) throw new SafeError(`Invalid cursor for these ${kind} arguments. Start again without a cursor.`);
    return c;
  }
  private async checked(file: string) {
    this.exposed(file);
    await assertNoSymlinks(this.root, file);
    const canonical = await realpath(path.join(this.root, file));
    const rel = path.relative(this.root, canonical);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new SafeError('Path outside repository.');
    return canonical;
  }
  /**
   * Names Git prints for literal pathspecs, asked in bounded batches (a single argv with thousands of long paths
   * fails with E2BIG). Every batch draws on one operation deadline. Each path is also asked in its NFC and NFD
   * spellings, because Git may store a different Unicode form than the disk spelling (see `listed`).
   * The deadline is strict, in a capture and outside it: it is checked before and after every Git call, across
   * separate stages too (HEAD, then index), and each call gets only the time left. Startup with a zero budget is
   * the one compatibility case; see `startupDeadline`.
   */
  private async gitNames(base: string[], paths: string[], deadline: Deadline, expired?: () => SafeError) {
    const timedOut = expired ?? (() => new SafeError(`Git tracking check timed out (${deadline.budgetMs} ms operation budget); narrow the policy or retry.`));
    const spellings = [...new Set(paths.flatMap(p => [p, nfc(p), p.normalize('NFD')]))];
    const names = new Set<string>();
    for (const batch of batchPaths(spellings)) {
      deadline.check(timedOut);
      for (const name of (await this.git([...base, '--', ...batch], deadline.timeout())).stdout.split('\0')) if (name) names.add(name);
      deadline.check(timedOut);
    }
    return names;
  }
  /**
   * Budget for tracking validation while the repo is being created. A positive `operationBudgetMs` applies as is.
   * A zero budget (a test setting that makes runtime operations time out at once) would make startup impossible, so
   * startup validation then gets its own allowance; runtime edit, diff, capture and search keep the zero budget.
   */
  private startupDeadline() { return new Deadline(this.operationBudgetMs > 0 ? this.operationBudgetMs : STARTUP_VALIDATION_MS, this.monotonicClock); }
  /**
   * Is the disk path `file` one of Git's `names`? An exact match always counts. A differently normalised spelling
   * counts only when it names the very same file on this volume (same device and inode), so two genuinely distinct
   * NFC and NFD entries on a normalisation-sensitive volume are never merged.
   */
  private async listed(file: string, names: Set<string>) {
    if (names.has(file)) return true;
    for (const other of new Set([nfc(file), file.normalize('NFD')])) {
      if (other === file || !names.has(other)) continue;
      const [a, b] = await Promise.all([file, other].map(f => lstat(path.join(this.root, f), { bigint: true }).catch(() => undefined)));
      if (a && b && a.dev === b.dev && a.ino === b.ino) return true;
    }
    return false;
  }
  private async requireEditableTracked(paths: string[], deadline: Deadline = this.newDeadline()) {
    if (!paths.length) return;
    const head = await this.gitNames(['ls-tree', '-r', '--name-only', '-z', 'HEAD'], paths, deadline);
    const needed: string[] = [];
    for (const file of paths) if (!this.isCreatable(file) || await this.listed(file, head)) needed.push(file);
    await this.requireTracked(needed, deadline);
  }
  private async requireTracked(paths: string[], deadline: Deadline = this.newDeadline()) {
    if (!paths.length) return;
    const tracked = await this.gitNames(['ls-tree', '-r', '--name-only', '-z', 'HEAD'], paths, deadline);
    const indexed = await this.gitNames(['ls-files', '--cached', '-z'], paths, deadline);
    for (const file of paths) {
      if (!await this.listed(file, tracked) || !await this.listed(file, indexed)) throw new SafeError('Editable files must exist in HEAD and remain tracked in the index so edits appear in git_diff.');
    }
  }

  // --- Read, list, search ------------------------------------------------------------------------
  /** Read an exposed file by its disk spelling; no exposure gate, but full containment verification. */
  private async readResolved(rel: string) {
    if (pathProblem(rel)) throw new SafeError(NOT_EXPOSED);
    const limit = this.limits.edit_file_bytes;
    const { handle, stat } = await openVerified(this.root, rel, this.pathHook);
    try {
      if (stat.size > limit) throw new SafeError(`File exceeds the ${formatBytes(limit)} file limit.`);
      // One spare byte detects growth after stat.
      const buffer = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < buffer.length) { const read = await handle.read(buffer, size, buffer.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
      if (size > stat.size) throw new SafeError('File changed while it was being read; read it again.');
      const bytes = buffer.subarray(0, size);
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new NotTextError('File is not valid UTF-8 text.'); }
      if (content.includes('\0')) throw new NotTextError('Binary file unsupported.');
      return { path: rel, sha256: sha256(bytes), content, mode: stat.mode & 0o777, bytes: size, fp: fingerprint(await handle.stat({ bigint: true })) };
    } finally { await handle.close(); }
  }
  /** `refresh: false` is for callers that have just refreshed the inventory themselves (edit). */
  async read(file: string, options: { refresh?: boolean } = {}) {
    if (options.refresh !== false) await this.touch();
    const { fp: _fp, ...result } = await this.readResolved(this.exposed(file));
    return result;
  }
  /** Validate bounds and locate the starting offset; shared by read and repo_info instructions. */
  private async readWindow(file: string, start: number, limit: number, cursor?: string) {
    if (!Number.isInteger(start) || start < 1 || !Number.isInteger(limit) || limit < 1 || limit > this.limits.page_lines) throw new SafeError(`Invalid line bounds (1-${this.limits.page_lines} lines per page).`);
    const rel = this.exposed(file);
    const { content: text, bytes, fp: _fp, ...result } = await this.readResolved(rel);
    let offset: number;
    if (cursor) {
      const c = decodeCursor<{ p: string; h: string; o: number }>(cursor, 'read');
      if (c.p !== rel || !Number.isInteger(c.o) || c.o < 0 || c.o > text.length) throw new SafeError('Invalid cursor for this path. Start again without a cursor.');
      if (c.h !== result.sha256) throw staleCursor(rel);
      offset = c.o;
    } else {
      offset = 0;
      for (let line = 1; line < start && offset < text.length; line++) { const nl = text.indexOf('\n', offset); offset = nl === -1 ? text.length : nl + 1; }
    }
    return { text, bytes, result, offset, cursor: (next: number) => encodeCursor({ k: 'read', p: rel, h: result.sha256, o: next }) };
  }
  async readRange(file: string, start = 1, limit = this.limits.page_lines, cursor?: string) {
    await this.guard();
    if (!Number.isInteger(start) || start < 1 || !Number.isInteger(limit) || limit < 1 || limit > this.limits.page_lines) throw new SafeError(`Invalid line bounds (1-${this.limits.page_lines} lines per page).`);
    await this.touch();
    const { text, bytes, result, offset, cursor: nextCursor } = await this.readWindow(file, start, limit, cursor);
    const startLine = 1 + countNewlines(text, 0, offset);
    const totalLines = countNewlines(text) + 1;
    // The page shares its response with this metadata, so the content gets what is left.
    const shell = { ...result, content: '', start_line: startLine, end_line: totalLines, total_lines: totalLines, total_bytes: bytes, next_cursor: cursorReserve('read', { p: result.path, h: result.sha256, o: text.length }), complete: false, truncated: true };
    const page = pageText(text, offset, this.room(shell), limit);
    const endLine = startLine + countNewlines(page.content) - (page.content.endsWith('\n') ? 1 : 0);
    return {
      ...result, content: page.content, start_line: startLine, end_line: endLine,
      total_lines: totalLines, total_bytes: bytes,
      next_cursor: page.next === null ? null : nextCursor(page.next),
      complete: page.next === null, truncated: offset > 0 || page.next !== null
    };
  }
  /** Bytes of page_bytes left for variable content after the fixed shape of a response. */
  private room(shell: unknown) {
    const left = this.limits.page_bytes - jsonBytes(shell);
    if (left < 0) throw new SafeError(`page_bytes (${this.limits.page_bytes}) is too small for this response's metadata.`);
    return left;
  }
  /** Discovered paths in byte order, one page at a time, with the inventory's identity. */
  async listFiles(prefix = '', cursor?: string) {
    await this.guard();
    if (prefix.length > 256) throw new SafeError('Prefix is limited to 256 characters.');
    const inv = await this.current();
    const entries = inv.under(prefix);
    const argsKey = sha256(JSON.stringify(['list', prefix]));
    let offset = 0;
    if (cursor) {
      const c = this.readCursor('list', cursor, { a: argsKey });
      if (c.i !== inv.digest) throw staleCursor('the file inventory');
      if (!isIndex(c.o) || c.o > entries.length) throw new SafeError('Invalid cursor for list. Start again without a cursor.');
      offset = c.o;
    }
    const block = this.inventoryBlock(inv);
    // The whole response must fit page_bytes: a page that continues carries a cursor, the last page does not.
    const more = jsonBytes({ files: [], next_cursor: this.cursorShell('list', { o: MAX_INT }), complete: false, inventory: block });
    const done = jsonBytes({ files: [], next_cursor: null, complete: true, inventory: block });
    const budget = this.limits.page_bytes;
    const tooSmall = (needs: number) => new SafeError(`page_bytes (${budget}) is too small for a list_files response (it needs at least ${needs} bytes with metadata and one entry); raise page_bytes.`);
    let used = 0, i = offset;
    const files: { path: string; bytes: number; editable: boolean }[] = [];
    for (; i < entries.length; i++) {
      const item = { path: entries[i].path, bytes: entries[i].size, editable: this.legacy ? this.legacy.editable.includes(entries[i].path) : this.paths.decide(entries[i].path, 'write').ok };
      const cost = jsonBytes(item) + (files.length ? 1 : 0);
      const total = (i === entries.length - 1 ? done : more) + used + cost;
      if (total > budget) { if (!files.length) throw tooSmall(total); break; }
      files.push(item); used += cost;
    }
    if (!files.length && done > budget) throw tooSmall(done);
    const next = i < entries.length;
    return { files, next_cursor: next ? this.makeCursor('list', { i: inv.digest, a: argsKey, o: i }) : null, complete: !next, inventory: block };
  }
  async search(query: string, prefix = '', cursor?: string) {
    await this.guard();
    if (!query || query.length > 200) throw new SafeError('Search needs 1-200 characters.');
    const inv = await this.current();
    // Exact policies search in their listed order; discovered ones in byte order.
    const list = this.legacy ? this.legacy.files.filter(f => f.startsWith(prefix) && inv.index.has(f)).map(f => inv.index.get(f)!) : inv.under(prefix);
    const argsKey = sha256(JSON.stringify(['search', query, prefix]));
    let fi = 0, li = 0;
    if (cursor) {
      const c = this.readCursor('search', cursor, { a: argsKey });
      if (c.i !== inv.digest) throw staleCursor('the file inventory');
      if (!isIndex(c.fi) || !isIndex(c.li) || c.fi > list.length) throw new SafeError('Invalid cursor for search. Start again without a cursor.');
      ({ fi, li } = c as unknown as { fi: number; li: number });
    }
    const started = Date.now();
    const matches: { path: string; line: number; column: number; text: string; text_truncated: boolean }[] = [];
    let skipped = 0, resumed = li > 0;
    const next = (fiNext: number, liNext: number) => this.makeCursor('search', { i: inv.digest, a: argsKey, fi: fiNext, li: liNext });
    const result = (extra: { next_cursor: string | null; complete: boolean; truncated: boolean }) => ({ matches, ...extra, ...(skipped ? { skipped_files: skipped } : {}) });
    const shell = { matches: [], next_cursor: this.cursorShell('search', { fi: MAX_INT, li: MAX_INT }), complete: false, truncated: true, skipped_files: 1_000_000 };
    this.room(shell);   // metadata alone must fit page_bytes
    let used = jsonBytes(shell);
    for (; fi < list.length; fi++, li = 0) {
      const entry = list[fi];
      let data;
      try { data = await this.readResolved(entry.path); }
      catch (error) {
        // Discovered policies can contain binary files; exact policies validated every file at startup.
        if (error instanceof NotTextError && !this.legacy) { skipped++; continue; }
        throw error;
      }
      if (data.fp !== entry.fp) throw staleCursor(entry.path);
      const lines = data.content.split('\n');
      if (resumed) { if (li > lines.length) throw new SafeError('Invalid cursor for search. Start again without a cursor.'); resumed = false; }
      for (; li < lines.length; li++) {
        const index = lines[li].indexOf(query);
        if (index === -1) continue;
        const match = { path: entry.path, line: li + 1, column: [...lines[li].slice(0, index)].length + 1, ...matchWindow(lines[li], index) };
        const cost = jsonBytes(match) + 1;
        if (matches.length === SEARCH_PAGE_MATCHES || used + cost > this.limits.page_bytes) {
          // No page can start at this match: a cursor to the same place would never make progress.
          if (!matches.length) throw new SafeError(`page_bytes (${this.limits.page_bytes}) is too small for one search match (the response needs at least ${used + cost} bytes); raise page_bytes.`);
          return result({ next_cursor: next(fi, li), complete: false, truncated: true });
        }
        matches.push(match); used += cost;
      }
      // Yield between files once the synchronous budget is spent.
      if (fi + 1 < list.length && Date.now() - started >= this.operationBudgetMs) {
        return result({ next_cursor: next(fi + 1, 0), complete: false, truncated: true });
      }
    }
    return result({ next_cursor: null, complete: true, truncated: false });
  }

  // --- Mutations ---------------------------------------------------------------------------------
  async exclusive<T>(kind: 'mutation' | 'check', fn: () => Promise<T>, preflight?: OperationPreflight) {
    if (this.busy) throw new SafeError('A mutation or test is running; retry after it finishes.');
    this.busy = true;
    const run = async () => {
      // Root, branch, HEAD and policy are verified before every mutation and check.
      const current = await resolveIdentity(this.root);
      if (this.task) await this.task.verify(current, kind);
      else { const drift = identityDrift(this.identity, current); if (drift) throw new SafeError(drift); }
      // Broker authorization must be checked inside this same task-gated critical section.
      await preflight?.();
      return fn();
    };
    try { return this.task ? await this.task.withMutationGate(run) : await run(); }
    finally { this.busy = false; }
  }
  /** Read-only tools stop as soon as the bound policy no longer matches the loaded one. */
  private async guard() { await this.task?.verifyPolicy(); }
  /** The disk spelling of a tool path for reconciliation; a path that is not in the inventory (a new file) stays as given. */
  private diskName(file: string) {
    return this.legacy ? file : this.inv?.resolve(file)?.path ?? file;
  }
  /**
   * Hash of the file a request names, as it is on disk now, or null when nothing exists there. The tool spelling is
   * resolved exactly as read and edit resolve it, so an NFC request for an NFD disk name finds its file. Null means
   * "truly absent" and nothing else: a path that exists but that reads refuse (hard link, symlink, special file,
   * oversized, ambiguous alias) is an error, because reading it as absent would let a retry replay a change that may
   * already be published. Files the policy does not expose are not looked at.
   */
  private async currentHash(file: string) {
    if (pathProblem(file) || !this.paths.decide(file, 'read').ok) return null;
    try {
      await this.touch();
      const rel = this.legacy ? (this.legacy.files.includes(file) ? file : undefined) : this.inv?.resolve(file)?.path;
      if (rel) return (await this.readResolved(rel)).sha256;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const probe = await diffInput(this.root, file, this.limits.edit_file_bytes);
    if (probe.state === 'absent') return null;
    throw new SafeError(`${file} exists but cannot be verified (${probe.state === 'refused' ? probe.reason : 'it cannot be matched to one exposed file'}); the outcome of this request is uncertain. Inspect the file; do not replay.`);
  }

  /**
   * Settle an interrupted create_file publication from its recorded evidence (never from names alone). The server
   * hard-links a complete temporary file to the target and then unlinks the temporary; a crash in between leaves two
   * links, which reads refuse. Only the temporary the record names, still the very inode recorded, in the target's
   * own directory, whose content still has the recorded hash, with exactly the links this sequence makes, is
   * removed. Anything else (a replaced temporary, an extra link, a symlink, a different file at the target, forged
   * evidence) throws an uncertain-outcome error and nothing is removed or written.
   */
  private async recoverPublication(outcome: Outcome) {
    const pub = outcome.publication;
    if (!pub) return;
    const uncertain = (why: string) => new SafeError(`Outcome of the interrupted create of ${pub.target} is uncertain: ${why}. Inspect the repository (${pub.temp}); nothing was removed or replayed.`);
    const dir = path.posix.dirname(pub.target);
    if (typeof pub.target !== 'string' || typeof pub.temp !== 'string' || typeof pub.dev !== 'string' || typeof pub.ino !== 'string'
      || pathProblem(pub.target) || pathProblem(pub.temp) || path.posix.dirname(pub.temp) !== dir || !TEMP_NAME.test(path.posix.basename(pub.temp))) {
      throw uncertain('its recorded publication evidence is malformed');
    }
    if (!this.paths.decide(pub.target, 'read').ok) return;
    const look = async (rel: string) => {
      try { await assertNoSymlinks(this.root, rel); return await lstat(path.join(this.root, rel), { bigint: true }); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
        throw uncertain(error instanceof SafeError ? 'a path involved is a symlink or unsafe' : 'a path involved cannot be inspected');
      }
    };
    const ours = (stat: BigIntStats | undefined) => !!stat && stat.isFile() && String(stat.dev) === pub.dev && String(stat.ino) === pub.ino;
    const [temp, target] = [await look(pub.temp), await look(pub.target)];
    if (!temp) {
      if (target && ours(target) && target.nlink > 1n) throw uncertain('the target has another hard link that this server did not make');
      return;   // nothing is left over: published and cleaned, or never published
    }
    if (!ours(temp)) throw uncertain('the recorded temporary file was replaced');
    if (target && !ours(target)) throw uncertain('another file now exists at the target');
    const links = target ? 2n : 1n;
    if (temp.nlink !== links || (target && target.nlink !== links)) throw uncertain('an unrecorded hard link to the file exists');
    if (outcome.after_sha256 && await this.hashTemp(pub.temp, temp) !== outcome.after_sha256) throw uncertain('the temporary file no longer has the recorded content');
    const now = await look(pub.temp);
    if (!ours(now)) throw uncertain('the recorded temporary file changed while it was checked');
    await unlink(path.join(this.root, pub.temp));
  }
  /** SHA-256 of the server's own temporary, read through a descriptor that must be the recorded inode. */
  private async hashTemp(rel: string, expected: { dev: bigint; ino: bigint }) {
    const handle = await open(path.join(this.root, rel), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino || Number(stat.size) > this.limits.edit_file_bytes) throw new SafeError('The temporary file is not the recorded file.');
      const bytes = Buffer.alloc(Number(stat.size));
      let read = 0;
      while (read < bytes.length) { const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read); if (!bytesRead) break; read += bytesRead; }
      return read === bytes.length ? sha256(bytes) : '';
    } finally { await handle.close(); }
  }
  /**
   * Apply a mutation at most once per request ID. `intent` must be called with the
   * before/after hashes immediately before the file is written.
   */
  private async once<T extends MutationResult>(requestId: string | undefined, operation: string, args: unknown[], file: string,
    run: (intent: (before: string | null, after: string) => Promise<void>, publication: (evidence: Omit<Publication, 'target'>) => Promise<void>) => Promise<T>): Promise<Applied<T>> {
    if (requestId === undefined) return run(async () => {}, async () => {});
    const task = this.task;
    if (!task) throw new SafeError('request_id requires configured task state.');
    const digest = TaskContext.argsDigest(operation, args);
    const prior = await task.prior(requestId, digest, () => this.currentHash(file), outcome => this.recoverPublication(outcome));
    if (prior) return prior as unknown as Applied<T>;
    let intended = false;
    let result: T;
    try {
      result = await run(
        async (before, after) => { await task.recordIntent(requestId, digest, operation, this.diskName(file), before, after); intended = true; },
        async evidence => { await task.recordPublication(requestId, { target: this.diskName(file), ...evidence }); }
      );
    } catch (error) {
      // Before intent nothing was written, so a validation failure is final for this ID.
      // After intent only an explicit NotAppliedError proves the change was not published.
      if ((!intended && error instanceof SafeError) || error instanceof NotAppliedError) await task.recordFailed(requestId, digest, operation, file, error.message);
      throw error;
    }
    try { await task.recordCompleted(requestId, result); }
    catch { return { ...result, outcome_warning: OUTCOME_WARNING }; }
    return result;
  }
  private editable(file: string) {
    if (this.legacy) { if (!this.legacy.editable.includes(file)) throw new SafeError('Path is not editable by this repository policy.'); return file; }
    const rel = this.exposed(file);
    if (!this.paths.decide(rel, 'write').ok) throw new SafeError('Path is not editable by this repository policy.');
    return rel;
  }
  async edit(file: string, oldText: string, newText: string, expectedHash: string, requestId?: string, preflight?: OperationPreflight) {
    return this.exclusive('mutation', () => this.once(requestId, 'edit', [file, oldText, newText, expectedHash], file, async intent => {
      await this.touch();
      const rel = this.editable(file);
      if (Buffer.byteLength(oldText) + Buffer.byteLength(newText) > this.limits.payload_bytes) throw new SafeError(`Edit payload exceeds the ${formatBytes(this.limits.payload_bytes)} limit; split the change into smaller edits.`);
      await this.requireEditableTracked([rel]);
      const before = await this.read(rel, { refresh: false });
      if (before.sha256 !== expectedHash) throw new SafeError('Stale file hash. Read the file again before editing.');
      if (!oldText.length || before.content.split(oldText).length !== 2) throw new SafeError('old_text must match exactly once.');
      const after = before.content.replace(oldText, () => newText);
      if (Buffer.byteLength(after) > this.limits.edit_file_bytes || after.includes('\0')) throw new SafeError(`Replacement must remain a text file within the ${formatBytes(this.limits.edit_file_bytes)} file limit.`);
      const target = await this.checked(rel);
      const parentRel = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
      const parent = await dirIdentity(this.root, parentRel);
      await intent(before.sha256, sha256(after));
      const temp = path.join(path.dirname(target), `.mcp-${randomUUID()}.tmp`);
      const handle = await open(temp, 'wx', before.mode);
      try {
        // open() applies the process umask; the descriptor chmod restores the original ordinary permission bits.
        await handle.chmod(before.mode);
        await handle.writeFile(after, 'utf8');
        await handle.sync();
        await handle.close();
        const written = await lstat(temp);
        if ((await this.read(rel, { refresh: false })).sha256 !== expectedHash) throw new NotAppliedError('File changed during edit.');
        await this.pathHook?.('edit:before-rename', { path: rel });
        await assertSameDir(this.root, parentRel, parent);
        await rename(temp, target);
        await verifyPublished(this.root, rel, { dev: written.dev, ino: written.ino });
      } finally { await handle.close().catch(() => {}); await unlink(temp).catch(() => {}); }
      return { path: rel, before_sha256: before.sha256, after_sha256: sha256(after), ...this.boundedPatch(rel, before.content, after) };
    }), preflight);
  }
  /** Fail on a sibling that differs from `name` only by case or Unicode form; tells whether `name` exists exactly. */
  private async siblingCheck(parentRel: string, name: string) {
    const names = await readdir(parentRel ? path.join(this.root, parentRel) : this.root);
    const key = fold(name);
    if (names.some(n => n !== name && fold(n) === key)) throw new SafeError('A file or directory with a conflicting name already exists here (names that differ only by case or Unicode form count as the same).');
    return names.includes(name);
  }
  async createFile(file: string, content: string, requestId?: string, preflight?: OperationPreflight) {
    return this.exclusive('mutation', () => this.once(requestId, 'create_file', [file, content], file, async (intent, publication) => {
      await this.touch();
      const rule = this.paths.createRule(file);
      if (!rule.ok) throw new SafeError(rule.message);
      const size = Buffer.byteLength(content);
      if (!content.length || size > this.limits.payload_bytes || content.includes('\0')) throw new SafeError(`New file must contain between 1 byte and ${formatBytes(this.limits.payload_bytes)} (${this.limits.payload_bytes} bytes) of UTF-8 text.`);
      // The server must be able to read back what it creates.
      if (size > this.limits.edit_file_bytes) throw new SafeError(`New file exceeds the ${formatBytes(this.limits.edit_file_bytes)} file limit, so it could not be read back.`);
      const parts = file.split('/'), base = parts.at(-1)!;
      const dirParts = parts.slice(0, -1);
      // Everything down to the scope root (or the whole parent chain for an exact path) must already exist as plain directories.
      const mustExist = rule.dir ? rule.dir.split('/').length : dirParts.length;
      let parentRel = '';
      for (let i = 0; i < mustExist; i++) {
        const next = parentRel ? `${parentRel}/${dirParts[i]}` : dirParts[i];
        const stat = await lstat(path.join(this.root, next)).catch(() => undefined);
        if (!stat) throw new SafeError(rule.dir ? `Creation scope directory ${next} does not exist; the server never creates a scope root.` : 'Creation needs existing non-symlink directories.');
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SafeError('Creation needs existing non-symlink directories.');
        parentRel = next;
      }
      // Below the scope root: existing directories are reused only under their exact spelling; the rest are new.
      const fresh: string[] = [];
      for (const part of dirParts.slice(mustExist)) {
        if (!fresh.length && await this.siblingCheck(parentRel, part)) {
          const next = `${parentRel}/${part}`;
          const stat = await lstat(path.join(this.root, next));
          if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SafeError('Creation needs existing non-symlink directories.');
          parentRel = next;
        } else fresh.push(part);
      }
      if (!fresh.length) await this.siblingCheck(parentRel, base);
      let parent = await dirIdentity(this.root, parentRel);
      await intent(null, sha256(content));
      const created: string[] = [];
      let published = false;
      const undo = async () => { for (const dir of [...created].reverse()) await rmdir(path.join(this.root, dir)).catch(() => {}); };
      try {
        for (const part of fresh) {
          const dirRel = parentRel ? `${parentRel}/${part}` : part;
          await this.pathHook?.('mkdir:before', { path: dirRel });
          await assertSameDir(this.root, parentRel, parent);
          await mkdir(path.join(this.root, dirRel), { mode: 0o755 });
          created.push(dirRel);
          try { parent = await dirIdentity(this.root, dirRel); }
          catch (error) { throw new SafeError(`containment_violation: directory ${dirRel} may not have been created where intended (${(error as Error).message}).`); }
          parentRel = dirRel;
        }
        const target = path.join(this.root, file);
        const temp = path.join(this.root, parentRel, `.mcp-${randomUUID()}.tmp`);
        const handle = await open(temp, 'wx', 0o600);
        try {
          await handle.writeFile(content, 'utf8');
          await handle.sync();
          await handle.close();
          const written = await lstat(temp);
          await this.pathHook?.('create:after-temp', { path: file });
          // Evidence first: after a crash between the link and the unlink, this record is what proves which
          // temporary link is ours (and so safe to remove) instead of a refused hard link of unknown origin.
          const identity = await lstat(temp, { bigint: true });
          await publication({ temp: parentRel ? `${parentRel}/${path.basename(temp)}` : path.basename(temp), dev: String(identity.dev), ino: String(identity.ino) });
          await this.pathHook?.('create:before-link', { path: file });
          await assertSameDir(this.root, parentRel, parent);
          // link publishes complete contents atomically and fails if any target exists.
          try { await link(temp, target); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new NotAppliedError('Path already exists. Read it before editing; creation never overwrites.');
            throw error;
          }
          published = true;
          await this.pathHook?.('create:after-link', { path: file });
          try { await verifyPublished(this.root, file, { dev: written.dev, ino: written.ino }); }
          catch (error) {
            // Best effort only: a pathname check followed by unlink can itself be raced.
            if (await removeIfSame(target, { dev: written.dev, ino: written.ino })) { published = false; throw new NotAppliedError('A path component changed while the file was published; the new link was removed and nothing was applied.'); }
            throw error;
          }
        } finally { await handle.close().catch(() => {}); await unlink(temp).catch(() => {}); }
      } catch (error) {
        if (!published && !(error instanceof SafeError && /containment_violation/.test(error.message))) await undo();
        throw error;
      }
      const reserve = created.length ? { created_directories: Array(MAX_CREATE_DIRS).fill('x'.repeat(259)) } : {};
      return { path: file, before_sha256: null, after_sha256: sha256(content), ...this.boundedPatch(file, '', content, reserve), ...(created.length ? { created_directories: created } : {}) };
    }), preflight);
  }
  async git(args: string[], timeout?: number) {
    this.gitHook?.(args, timeout);
    const result = await runGit(this.root, args, { strictUtf8: true, timeout });
    if (result.truncated) throw new SafeError(`Git output exceeded the ${formatBytes(GIT_CAPTURE_BYTES)} storage limit; narrow the prefix.`);
    if (result.timed_out) throw new SafeError('Git inspection timed out.');
    if (result.exit_code !== 0) throw new SafeError('Git inspection failed.');
    if (result.invalid_utf8) throw new SafeError('Git output is not valid UTF-8 and is never returned with replacement characters; inspect the change locally.');
    return result;
  }
  /** Mutation responses stay within one page, metadata included; larger patches are read through git_diff. */
  private boundedPatch(file: string, before: string, after: string, reserve: Record<string, unknown> = {}) {
    const diff = createPatch(file, before, after);
    // Reserve for the fields a retry or a failed outcome record can add.
    const shell = { path: file, before_sha256: SHA_PLACEHOLDER, after_sha256: SHA_PLACEHOLDER, diff: '', already_applied: true, outcome_warning: OUTCOME_WARNING, ...reserve };
    return jsonBytes(diff) - 2 <= this.room(shell) ? { diff } : { diff: null, diff_omitted: 'Patch exceeds one response page; inspect it with git_diff.' };
  }

  // --- Retained Git output -------------------------------------------------------------------
  // Status and diff run Git once into a capture; pages are read from it by byte offset. A cursor
  // names the capture and its content hash. The capture records the task, the checkout identity and
  // the inventory's scope digest (entries and directories under the capture's prefix); a page is
  // refused as stale when any of them changed, and when the capture expired or was evicted. Both are
  // checked again after Git has run, before the capture is published, so a change during generation
  // never yields a first page. Changes outside the exposed files (for example new untracked files
  // elsewhere) are not detected: status is a labelled snapshot (`captured_at`). The digest is change
  // metadata, not content identity; review and commit boundaries must verify content hashes.
  private get taskId() { return this.task?.taskId ?? null; }
  private async capture(kind: 'status' | 'diff', argsKey: string, prefix: string, write: (ctx: CaptureContext) => Promise<void | (() => Promise<boolean>)>): Promise<CaptureMeta> {
    const repo = this;
    const max = this.captures.maxCaptureBytes;
    // One deadline for the whole capture: every stage, Git run and retry draws on the same budget.
    const deadline = new Deadline(this.operationBudgetMs, this.monotonicClock);
    const expired = () => new SafeError(`Git ${kind} capture timed out (${this.operationBudgetMs} ms operation budget); narrow the prefix or retry.`);
    const left = () => deadline.timeout();
    for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt++) {
      deadline.check(expired);
      const identity = await resolveIdentity(this.root, { timeout: left });
      const scope = (await this.current(deadline)).scopeDigest(prefix);
      const index = await this.indexSignature(kind, prefix, left);
      deadline.check(expired);
      const pending = await this.captures.begin();
      let runs = 0;
      const guarded = async () => { await repo.captureHook?.('before-git', attempt, runs++); deadline.check(expired); };
      try {
        const verify = await write({
          max, left, expired, attempt, deadline, out: pending.path,
          async run(args, append = false) {
            await guarded();
            const soFar = append ? (await statFile(pending.path)).size : 0;
            const result = await runGitToFile(repo.root, args, pending.path, { maxBytes: max - soFar, timeout: left(), append });
            if (result.timed_out) throw expired();
            if (result.truncated) throw new SafeError(`Git output exceeded the ${formatBytes(max)} capture limit (retained_output_bytes ${formatBytes(repo.limits.retained_output_bytes)}); narrow the prefix.`);
            if (result.exit_code !== 0) throw new SafeError('Git inspection failed.');
            if (result.invalid_utf8) throw new SafeError('Git output is not valid UTF-8 and is never returned with replacement characters; inspect the change locally.');
          },
          async names(args) {
            await guarded();
            const result = await runGit(repo.root, args, { timeout: left() });
            if (result.timed_out) throw expired();
            if (result.truncated) throw new SafeError('Git listed too many changed paths; narrow the prefix.');
            if (result.exit_code !== 0) throw new SafeError('Git inspection failed.');
            return result.stdout.split('\0').filter(Boolean);
          },
          async append(text) {
            if ((await statFile(pending.path)).size + Buffer.byteLength(text) > max) throw new SafeError(`Git output exceeded the ${formatBytes(max)} capture limit; narrow the prefix.`);
            await appendFile(pending.path, text, 'utf8');
          }
        });
        await this.captureHook?.('after-git', attempt);
        deadline.check(expired);
        // Publish only if nothing moved while Git ran; otherwise discard and capture again.
        const moved = identityDrift(identity, await resolveIdentity(this.root, { timeout: left })) || scope !== (await this.current(deadline)).scopeDigest(prefix)
          || index !== await this.indexSignature(kind, prefix, left) || (verify && !(await verify()));
        if (moved) { await pending.abort(); continue; }
        deadline.check(expired);
        return await pending.commit({ kind, args: argsKey, task_id: this.taskId, identity, fingerprint: scope, index });
      } catch (error) { await pending.abort(); throw error; }
    }
    throw new SafeError(`The checkout or exposed files changed while this ${kind} was being captured (${CAPTURE_ATTEMPTS} attempts). Retry when no other writer is active.`);
  }
  /**
   * Digest of the index entries a capture depends on: mode, object and stage of each path (`ls-files -s`) plus the
   * entry flags that change status and diff: intent-to-add, skip-worktree and assume-unchanged. `ls-files --debug`
   * prints the flags; its stat lines (times, inode, size) are dropped, so a refresh that only rewrites stat data, or
   * rewrites the index file in another version, changes nothing. (`-s -v` alone cannot see intent-to-add: its entry
   * has the empty blob, mode and stage of an ordinary staged empty file.) Status shows every path; a diff depends
   * only on the permitted paths under its prefix. Git picks the right index for a linked worktree, and the digest is
   * stored with the capture, so it survives a restart. Output that does not parse fails closed.
   */
  private async indexSignature(kind: 'status' | 'diff', prefix: string, timeout?: () => number) {
    const result = await runGit(this.root, ['ls-files', '--stage', '--debug', '-z'], { timeout: timeout?.(), maxBytes: INDEX_READ_BYTES });
    if (result.timed_out) throw new SafeError('Git inspection timed out.');
    if (result.truncated) throw new SafeError(`The Git index is too large to bind a capture to (more than ${formatBytes(INDEX_READ_BYTES)} of entry listing).`);
    if (result.exit_code !== 0) throw new SafeError('Git inspection failed.');
    // Each entry: "<mode> <object> <stage>\t<path>\0" then five fixed lines ending in "\tflags: <hex>\n".
    const out = result.stdout;
    const relevant: string[] = [];
    for (let pos = 0; pos < out.length;) {
      const end = out.indexOf('\0', pos);
      const stat = end === -1 ? null : DEBUG_STAT.exec(out.slice(end + 1, end + 1 + DEBUG_STAT_MAX));
      if (end === -1 || !stat) throw new SafeError('Git index listing was not understood; inspection failed.');
      const entry = out.slice(pos, end), name = entry.slice(entry.indexOf('\t') + 1);
      pos = end + 1 + stat[0].length;
      if (kind === 'diff' && (pathProblem(name) || !name.startsWith(prefix) || !this.paths.decide(name, 'read').ok)) continue;
      relevant.push(`${entry}\t${(parseInt(stat[1], 16) & INDEX_FLAGS) >>> 0}`);
    }
    return sha256(relevant.join('\0'));
  }
  private captureCursor(kind: string, meta: CaptureMeta, offset: number) {
    return encodeCursor({ k: kind, c: meta.id, s: meta.sha256.slice(0, 16), o: offset });
  }
  private captureCursorReserve(kind: string) {
    return cursorReserve(kind, { c: '0'.repeat(36), s: '0'.repeat(16), o: Number.MAX_SAFE_INTEGER });
  }
  /** Validate a continuation against its capture, the task, the arguments and the current checkout. */
  private async openCapture(cursor: string, kind: string, argsKey: string, prefix: string) {
    const c = decodeCursor<{ c: string; s: string; o: number }>(cursor, kind);
    if (typeof c.c !== 'string' || typeof c.s !== 'string' || !Number.isInteger(c.o) || c.o < 0) throw new SafeError(`Invalid cursor for ${kind}. Start again without a cursor.`);
    const meta = await this.captures.get(c.c);
    if (meta.sha256.slice(0, 16) !== c.s || meta.kind !== kind || meta.args !== argsKey || meta.task_id !== this.taskId) throw new SafeError(`Invalid cursor for these ${kind} arguments. Start again without a cursor.`);
    if (c.o > meta.bytes) throw new SafeError(`Invalid cursor for ${kind}. Start again without a cursor.`);
    if (identityDrift(meta.identity, await resolveIdentity(this.root))) throw staleCursor('the checkout (branch, HEAD or location)');
    if (meta.fingerprint !== (await this.current()).scopeDigest(prefix)) throw staleCursor(`the exposed files behind this ${kind}`);
    if (meta.index !== await this.indexSignature(kind as 'status' | 'diff', prefix)) throw staleCursor(`the Git index behind this ${kind}`);
    return { meta, offset: c.o };
  }
  /** One page of a capture starting at a byte offset; `next` is null once the end is reached. */
  private async pageCapture(meta: CaptureMeta, offset: number, budget: number) {
    // Escaped size is never below raw size, so budget + 4 bytes always covers a page and a split code point.
    let window: Uint8Array = await this.captures.read(meta, offset, budget + 4);
    if (offset + window.length < meta.bytes) window = completeUtf8(window);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(window); }
    catch { throw new SafeError('Retained Git output is damaged. Start again without a cursor.'); }
    const page = pageText(text, 0, budget);
    const next = offset + Buffer.byteLength(page.content);
    return { content: page.content, next: next < meta.bytes ? next : null };
  }
  private statusCapture() {
    return this.capture('status', 'status', '', async ctx => ctx.run(['status', '--short', '--branch', '--untracked-files=all']));
  }
  /** Continue the Git status started by info(); Git is not run again. */
  async statusPage(cursor: string) {
    await this.guard();
    const { meta, offset } = await this.openCapture(cursor, 'status', 'status', '');
    const shell = { status: '', status_next_cursor: this.captureCursorReserve('status'), status_complete: false, status_captured_at: new Date(meta.created_at).toISOString() };
    const page = await this.pageCapture(meta, offset, this.room(shell));
    return { status: page.content, status_next_cursor: page.next === null ? null : this.captureCursor('status', meta, page.next), status_complete: page.next === null, status_captured_at: shell.status_captured_at };
  }
  /** Every exposed-path list repo_info reports. */
  private pathLists(inv: Inventory): PathLists {
    if (this.legacy) {
      const legacy = this.legacy;
      const files = legacy.files.filter(f => inv.index.has(f));
      return {
        files, editable_files: legacy.editable, creatable_files: legacy.creatable ?? [],
        test_suites: legacy.tests.filter(f => files.includes(f)), configured_test_suites: legacy.tests,
        editable_test_files: legacy.tests.filter(f => legacy.editable.includes(f))
      };
    }
    const tests = this.paths.literalPaths.tests;
    const all = inv.entries.map(e => e.path);
    return {
      files: all, editable_files: all.filter(f => this.paths.decide(f, 'write').ok),
      creatable_files: this.paths.creatablePaths, test_suites: tests.filter(f => inv.index.has(f)), configured_test_suites: tests,
      editable_test_files: tests.filter(f => this.paths.decide(f, 'write').ok)
    };
  }
  /**
   * The lists are paged as one sequence, in a fixed order. Each page carries a slice of every list,
   * so concatenating the slices per list rebuilds it. `force` guarantees progress on continuation pages.
   */
  private listsPage(lists: PathLists, offset: number, budget: number, force: boolean) {
    const entries = LIST_KEYS.flatMap(key => lists[key].map(value => [key, value] as const));
    const page = Object.fromEntries(LIST_KEYS.map(key => [key, [] as string[]])) as PathLists;
    let used = 0, i = offset;
    for (; i < entries.length; i++) {
      const cost = jsonBytes(entries[i][1]) + 1;
      if (used + cost > budget && (i > offset || !force)) break;
      page[entries[i][0]].push(entries[i][1]); used += cost;
    }
    return { lists: page, used, next: i < entries.length ? i : null };
  }
  /** Continue the exposed-path lists started by info(). */
  async filesPage(cursor: string) {
    await this.guard();
    const inv = await this.current();
    const lists = this.pathLists(inv);
    const c = this.readCursor('files', cursor, { a: 'files' });
    if (c.i !== inv.digest) throw staleCursor('the file inventory');
    const total = LIST_KEYS.reduce((n, key) => n + lists[key].length, 0);
    if (!isIndex(c.o) || c.o > total) throw new SafeError('Invalid cursor for files. Start again without a cursor.');
    const empty = Object.fromEntries(LIST_KEYS.map(key => [key, []]));
    const shell = { ...empty, files_next_cursor: this.cursorShell('files', { o: MAX_INT }), files_complete: false };
    const page = this.listsPage(lists, c.o, this.room(shell), true);
    return { ...page.lists, files_next_cursor: page.next === null ? null : this.makeCursor('files', { i: inv.digest, a: 'files', o: page.next }), files_complete: page.next === null };
  }
  /** `extra` is added to the response by the caller; it is counted against the page. */
  async info(extra: Record<string, unknown> = {}) {
    await this.guard();
    const identity = await resolveIdentity(this.root);
    const inv = await this.current();
    const lists = this.pathLists(inv);
    const task = this.task ? await this.task.summary() : null;
    const capture = await this.statusCapture();
    // Select only an exposed root instruction file, using its actual disk spelling.
    // This is discovery, not a case-insensitive permission alias.
    const instructionFiles = inv.entries.filter(entry => entry.path.toLowerCase() === 'agents.md');
    if (instructionFiles.length > 1) throw new SafeError('Multiple exposed root instruction files; expose only one spelling of AGENTS.md.');
    const instructionsPath = instructionFiles[0]?.path ?? null;
    const window = instructionsPath ? await this.readWindow(instructionsPath, 1, this.limits.page_lines) : { text: '', offset: 0, cursor: () => '' };
    const empty = Object.fromEntries(LIST_KEYS.map(key => [key, []]));
    const glob = this.legacy ? {} : { inventory: this.inventoryBlock(inv), policy_summary: this.paths.summary() };
    const fixed = { repository: path.basename(this.root), scope: 'Explicitly allowlisted pilot', runner: this.runner?.kind ?? 'node', identity, task, head: identity.head, ...glob, ...extra, instructions_path: instructionsPath };
    const shell = {
      ...fixed, ...empty, status: '', status_next_cursor: this.captureCursorReserve('status'), status_complete: false, status_captured_at: new Date(capture.created_at).toISOString(),
      files_next_cursor: this.cursorShell('files', { o: MAX_INT }), files_complete: false,
      instructions: '', instructions_next_cursor: cursorReserve('read', { p: instructionsPath ?? '', h: SHA_PLACEHOLDER, o: window.text.length })
    };
    // Everything shares one page with the metadata: instructions first (capped), then the path lists
    // (at most half of what remains), then the first status page takes the rest.
    let room = this.room(shell);
    const instructions = pageText(window.text, window.offset, Math.min(INSTRUCTIONS_BYTES, Math.floor(room / 4)), this.limits.page_lines);
    room -= jsonBytes(instructions.content) - 2;
    const paths = this.listsPage(lists, 0, Math.floor(room / 2), false);
    room -= paths.used;
    const page = await this.pageCapture(capture, 0, room);
    // A status that fits one page is never continued, so it is not retained.
    if (page.next === null) await this.captures.discard(capture.id);
    return {
      ...fixed, ...paths.lists,
      files_next_cursor: paths.next === null ? null : this.makeCursor('files', { i: inv.digest, a: 'files', o: paths.next }), files_complete: paths.next === null,
      status: page.content, status_next_cursor: page.next === null ? null : this.captureCursor('status', capture, page.next), status_complete: page.next === null, status_captured_at: shell.status_captured_at,
      instructions: instructions.content, instructions_next_cursor: instructions.next === null ? null : window.cursor(instructions.next)
    };
  }

  // --- Diff ----------------------------------------------------------------------------------
  /** Permitted paths that Git reports as different from HEAD (working tree or index), deletions included. */
  private async changedPaths(ctx: CaptureContext, prefix: string) {
    // Porcelain diff refreshes the index and compares content, so these lists hold real differences only.
    const base = ['--no-ext-diff', '--no-textconv', '--no-renames', '-z', '--name-only'];
    const worktree = await ctx.names(['diff', ...base, 'HEAD']);
    const staged = await ctx.names(['diff', '--cached', ...base, 'HEAD']);
    const permitted = (name: string) => !pathProblem(name) && name.startsWith(prefix) && this.paths.decide(name, 'read').ok;
    const inWorktree = new Set(worktree.filter(permitted));
    const all = new Set([...inWorktree, ...staged.filter(permitted)]);
    const sorted = (set: Iterable<string>) => [...set].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    // Git opens existing working files itself, so each one must first pass the read/inventory rules; absent files are genuine deletions.
    const inputs = new Map<string, DiffInput>();
    for (const name of all) { ctx.deadline.check(ctx.expired); inputs.set(name, await diffInput(this.root, name, this.limits.edit_file_bytes)); }
    const refused = sorted([...all].filter(name => inputs.get(name)!.state === 'refused'));
    const eligible = new Set([...all].filter(name => inputs.get(name)!.state !== 'refused'));
    const fp = (input: DiffInput) => input.state === 'file' ? fingerprint(input.stat) : input.state;
    // Run after Git: a path that is no longer exactly as judged may have been read in a different state.
    const unchanged = async () => {
      for (const name of eligible) {
        const now = await diffInput(this.root, name, this.limits.edit_file_bytes);
        if (now.state === 'refused' || fp(now) !== fp(inputs.get(name)!)) return false;
      }
      return true;
    };
    return {
      changed: sorted(eligible), stagedOnly: sorted([...eligible].filter(name => !inWorktree.has(name))),
      refused: refused.map(name => ({ name, reason: (inputs.get(name) as { reason: string }).reason })), unchanged
    };
  }
  async diff(prefix = '', cursor?: string) {
    await this.guard();
    if (prefix.length > 256) throw new SafeError('Prefix is limited to 256 characters.');
    const argsKey = sha256(JSON.stringify(['diff', prefix]));
    let meta: CaptureMeta, offset = 0;
    if (cursor) ({ meta, offset } = await this.openCapture(cursor, 'diff', argsKey, prefix));
    else {
      if (this.legacy) {
        const selected = this.legacy.files.filter(f => f.startsWith(prefix));
        if (!selected.length) throw new SafeError('No exposed paths match prefix.');
        await this.requireEditableTracked(this.legacy.editable.filter(f => selected.includes(f)));
      }
      meta = await this.capture('diff', argsKey, prefix, async ctx => {
        const { changed, stagedOnly, refused, unchanged } = await this.changedPaths(ctx, prefix);
        // Patches in bounded batches of literal paths; renames are reported as a deletion plus an addition.
        await writeFile(ctx.out, '', { flag: 'wx', mode: 0o600 });
        for (const batch of batchPaths(changed)) await ctx.run(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', 'HEAD', '--', ...batch], true);
        // A permitted path whose only difference is in the index has no working-tree patch; say so instead of omitting it.
        if (stagedOnly.length) await ctx.append(stagedOnly.map(name => `# no working-tree patch for ${name} (index differs from HEAD)\n`).join(''));
        // A changed path whose working file fails the read rules (link, symlink, unsafe component, limits) is never given to Git.
        if (refused.length) await ctx.append(refused.map(r => `# no patch for ${r.name} (${r.reason}; git_diff reads only files that read and list_files would expose)\n`).join(''));
        // Approved new files are not in HEAD or the index yet; they are shown as additions.
        const inv = await this.current(ctx.deadline);
        const candidates = inv.under(prefix).map(e => e.path).filter(f => this.isCreatable(f));
        for (const batch of batchPaths(candidates)) {
          await this.captureHook?.('before-git', ctx.attempt);
          ctx.deadline.check(ctx.expired);
          const indexed = await this.gitNames(['ls-files', '--cached', '-z'], batch, ctx.deadline, ctx.expired);
          let extra = '';
          for (const file of batch) if (!await this.listed(file, indexed)) extra += createPatch(file, '', (await this.readResolved(file)).content);
          if (extra) await ctx.append(extra);
        }
        return unchanged;
      });
      if (!this.legacy && meta.bytes === 0 && !(await this.current()).under(prefix).length) { await this.captures.discard(meta.id); throw new SafeError('No exposed paths match prefix.'); }
    }
    const captured_at = new Date(meta.created_at).toISOString();
    const shell = { diff: '', offset: meta.bytes, total_bytes: meta.bytes, next_cursor: this.captureCursorReserve('diff'), complete: false, truncated: true, captured_at };
    const page = await this.pageCapture(meta, offset, this.room(shell));
    return { diff: page.content, offset, total_bytes: meta.bytes, next_cursor: page.next === null ? null : this.captureCursor('diff', meta, page.next), complete: page.next === null, truncated: page.next !== null, captured_at };
  }

  // --- Tests -----------------------------------------------------------------------------------
  async test(suite?: string, preflight?: OperationPreflight) {
    return this.exclusive('check', async () => {
      const tests = this.legacy ? this.legacy.tests : this.paths.literalPaths.tests;
      if (!tests.length) throw new SafeError('No test suites are configured for this read-only scope.');
      if (suite && !tests.includes(suite)) throw new SafeError('Unknown test suite.');
      const inv = await this.current();
      const available = this.legacy ? this.legacy.files.filter(f => inv.index.has(f)) : inv.entries.map(e => e.path);
      if (!this.legacy) {
        const bytes = inv.entries.reduce((n, e) => n + e.size, 0);
        if (available.length > SNAPSHOT_MAX_FILES || bytes > SNAPSHOT_MAX_BYTES) throw new SafeError(`The readable inventory (${available.length} files, ${formatBytes(bytes)}) is too large to snapshot for tests (limit ${SNAPSHOT_MAX_FILES} files and ${formatBytes(SNAPSHOT_MAX_BYTES)}); narrow read.include until execution scopes exist.`);
      }
      if (suite && !available.includes(suite)) throw new SafeError('Test suite has not been created yet.');
      const selected = suite ? [suite] : tests.filter(f => available.includes(f));
      if (!selected.length) throw new SafeError('No configured test suites exist yet.');
      const snapshot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-tests-')));
      try {
        for (const file of available) {
          const data = await this.readResolved(file);
          const expected = this.testHashes.get(file);
          if (expected && data.sha256 !== expected) throw new SafeError('Test file changed since startup. Restart only after inspecting it.');
          const target = path.join(snapshot, file);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, data.content, { flag: 'wx', mode: 0o600 });
        }
        const command = this.runner
          ? await pythonCommand(snapshot, selected, this.runner)
          : {executable: process.execPath, args: ['--permission', `--allow-fs-read=${snapshot}`, '--test-isolation=none', '--test', ...selected], env: {}, label: 'node --permission --allow-fs-read=<approved-file-snapshot> --test-isolation=none --test ' + selected.join(' ')};
        const result = await execute(command.executable, command.args, snapshot, 10_000, command.env);
        const writable = (file: string) => this.legacy ? this.legacy.editable.includes(file) : this.paths.decide(file, 'write').ok;
        return { test_files: selected.map(file => ({ path: file, editable: writable(file) })), command: command.label, ...result };
      } finally { await rm(snapshot, { recursive: true, force: true }); }
    }, preflight);
  }
}

/** A bounded window around a match; long lines are marked, never silently cut. */
function matchWindow(line: string, index: number) {
  if (line.length <= MATCH_WINDOW) return { text: line, text_truncated: false };
  let start = Math.max(0, index - 100), end = Math.min(line.length, start + MATCH_WINDOW);
  // Do not split surrogate pairs at either edge.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(line[start])) start--;
  if (end < line.length && /[\uDC00-\uDFFF]/.test(line[end])) end++;
  return { text: line.slice(start, end), text_truncated: true };
}

/** Drop an incomplete UTF-8 sequence at the end of a window cut from the middle of a file. */
function completeUtf8(bytes: Uint8Array) {
  for (let i = bytes.length - 1; i >= Math.max(0, bytes.length - 4); i--) {
    const b = bytes[i];
    if ((b & 0xc0) === 0x80) continue;
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return bytes.length - i < need ? bytes.subarray(0, i) : bytes;
  }
  return bytes;
}
