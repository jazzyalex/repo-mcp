import { lstat, readdir } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import { SafeError, sha256 } from './errors.js';
import { runGit } from './exec.js';
import { nfc } from './glob.js';
import type { PathPolicy } from './path-policy.js';
import type { PathHook } from './safe-fs.js';
import type { Deadline } from './deadline.js';

// Discovery (docs/DESIGN-2B-PATH-POLICY.md section 7). An inventory is the sorted list of permitted
// regular files plus the directories that were walked. Fingerprints are change metadata, not content
// identity: review and commit boundaries must still verify content hashes.

export type Entry = { path: string; size: number; mode: number; fp: string };
type Dir = { path: string; fp: string };
export type Skipped = { symlinks: number; special: number; linked: number; too_large: number; unsafe_name: number; too_long: number; other_device: number; git_ignored: number };
export const emptySkipped = (): Skipped => ({ symlinks: 0, special: 0, linked: 0, too_large: 0, unsafe_name: 0, too_long: 0, other_device: 0, git_ignored: 0 });
const MAX_DEPTH = 32;
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f\\�]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export type WalkContext = {
  root: string; policy: PathPolicy; inventoryPaths: number; maxFileBytes: number;
  deadline: Deadline; expired: () => SafeError; hook?: PathHook;
};

export const fingerprint = (stat: BigIntStats) => `${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`;
const dirFingerprint = (stat: BigIntStats) => `${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`;
const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const abs = (root: string, rel: string) => rel ? path.join(root, rel) : root;

/**
 * Untracked paths that Git ignores (repository .gitignore files and .git/info/exclude; global excludes are off in
 * the inspection environment). They are hidden from discovery: ignored files are where local secrets, state and
 * build output usually live. Tracked files are never listed here, so a force-added ignored file stays visible.
 * A directory entry (trailing slash) means everything under it is ignored and untracked.
 */
type Ignored = { files: Set<string>; dirs: Set<string>; sources: string[] };
const IGNORE_FAILED = () => new SafeError('Discovery: unable to list Git-ignored files; check that the checkout is a readable Git repository.');
async function gitIgnored(ctx: WalkContext): Promise<Ignored> {
  const git = async (args: string[]) => {
    ctx.deadline.check(ctx.expired);
    const result = await runGit(ctx.root, args, { timeout: ctx.deadline.timeout() });
    ctx.deadline.check(ctx.expired);
    if (result.exit_code !== 0 || result.timed_out || result.truncated) throw IGNORE_FAILED();
    return result.stdout;
  };
  // The index decides what is untracked; info/exclude adds rules. Both live in the Git directory, not the tree.
  const sources = (await git(['rev-parse', '--git-path', 'index', '--git-path', 'info/exclude'])).split('\n').filter(Boolean).map(p => path.resolve(ctx.root, p));
  if (sources.length !== 2) throw IGNORE_FAILED();
  const files = new Set<string>(), dirs = new Set<string>();
  for (const name of (await git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])).split('\0')) {
    if (name) (name.endsWith('/') ? dirs : files).add(name.endsWith('/') ? name.slice(0, -1) : name);
  }
  return { files, dirs, sources };
}
/** What the ignored set depends on besides directory membership: the index, info/exclude and each walked .gitignore. */
type IgnoreSource = { path: string; fp: string };
/**
 * A source changed at or after `racyAfter` (taken before Git listed ignored paths) may be newer than that listing;
 * it gets a fingerprint that never matches, so the next refresh walks again (the same idea as Git's racy index).
 */
const sourceFingerprint = async (file: string, racyAfter?: bigint) => {
  const stat = await lstat(file, { bigint: true }).catch(() => undefined);
  if (!stat) return 'missing';
  return racyAfter !== undefined && (stat.mtimeNs >= racyAfter || stat.ctimeNs >= racyAfter) ? 'racy' : fingerprint(stat);
};

export class Inventory {
  readonly index = new Map<string, Entry>();
  private nfcIndex = new Map<string, Entry[]>();
  digest = '';
  private constructor(readonly entries: Entry[], readonly dirs: Dir[], readonly skipped: Skipped, private readonly salt: string, private readonly ignoreSources: IgnoreSource[] = []) {
    for (const entry of entries) { this.index.set(entry.path, entry); const key = nfc(entry.path); this.nfcIndex.set(key, [...(this.nfcIndex.get(key) ?? []), entry]); }
    this.rehash();
  }
  static of(entries: Entry[], dirs: Dir[], skipped: Skipped, salt: string, ignoreSources?: IgnoreSource[]) {
    return new Inventory([...entries].sort((a, b) => byteOrder(a.path, b.path)), dirs, skipped, salt, ignoreSources);
  }
  private rehash() {
    this.digest = sha256([this.salt, ...this.entries.map(e => `${e.path}\0${e.fp}`), '--', ...this.dirs.map(d => `${d.path}\0${d.fp}`)].join('\n'));
  }
  get paths() { return this.entries.length; }

  /** The entry a tool path means: the exact spelling, else the one entry with the same NFC form. */
  resolve(file: string): Entry | undefined {
    const exact = this.index.get(file);
    if (exact) return exact;
    const same = this.nfcIndex.get(nfc(file));
    return same?.length === 1 ? same[0] : undefined;
  }
  under(prefix: string) { return prefix ? this.entries.filter(e => e.path.startsWith(prefix)) : this.entries; }

  /** Digest of what a prefix-scoped capture depends on: its entries and the directories that can contain them. */
  scopeDigest(prefix: string) {
    const relevant = (dir: string) => dir === '' ? !prefix.includes('/') : `${dir}/`.startsWith(prefix) || prefix.startsWith(`${dir}/`);
    return sha256([this.salt, prefix, ...this.under(prefix).map(e => `${e.path}\0${e.fp}`), '--', ...this.dirs.filter(d => relevant(d.path)).map(d => `${d.path}\0${d.fp}`)].join('\n'));
  }

  /**
   * Bring the inventory up to date for a new call. Membership changes show in directory metadata (one
   * lstat per directory) and trigger a re-walk. In-place edits do not touch the directory, so every entry
   * is also re-lstatted and updated; anything that no longer qualifies triggers a re-walk. An edited .gitignore,
   * info/exclude or index moves no tree directory either, so a change to any of them triggers a re-walk too.
   */
  async refresh(ctx: WalkContext): Promise<Inventory> {
    for (const source of this.ignoreSources) {
      ctx.deadline.check(ctx.expired);
      if (await sourceFingerprint(source.path) !== source.fp) return walk(ctx);
    }
    for (const dir of this.dirs) {
      ctx.deadline.check(ctx.expired);
      const stat = await lstat(abs(ctx.root, dir.path), { bigint: true }).catch(() => undefined);
      if (!stat || !stat.isDirectory() || dirFingerprint(stat) !== dir.fp) return walk(ctx);
    }
    let changed = false;
    for (let i = 0; i < this.entries.length; i += 64) {
      ctx.deadline.check(ctx.expired);
      const batch = this.entries.slice(i, i + 64);
      const stats = await Promise.all(batch.map(e => lstat(abs(ctx.root, e.path), { bigint: true }).catch(() => undefined)));
      for (let j = 0; j < batch.length; j++) {
        const stat = stats[j], entry = batch[j];
        if (!stat || !stat.isFile() || stat.nlink > 1n || Number(stat.size) > ctx.maxFileBytes) return walk(ctx);
        const fp = fingerprint(stat);
        if (fp !== entry.fp) { entry.fp = fp; entry.size = Number(stat.size); entry.mode = Number(stat.mode); changed = true; }
      }
    }
    if (changed) this.rehash();
    return this;
  }
}

const limitError = (what: string) => new SafeError(`Discovery limit: ${what}. Add excludes or narrow read.include so fewer paths are visited.`);

/** Walk the repository from its root under the policy. Never returns a partial inventory. */
export async function walk(ctx: WalkContext): Promise<Inventory> {
  const { root, policy } = ctx;
  // One second of slack covers coarse filesystem timestamps.
  const racyAfter = BigInt(Date.now() - 1000) * 1_000_000n;
  const ignored = await gitIgnored(ctx);
  const sources: IgnoreSource[] = [];
  for (const file of ignored.sources) sources.push({ path: file, fp: await sourceFingerprint(file, racyAfter) });
  const entries: Entry[] = [], dirs: Dir[] = [], skipped = emptySkipped();
  const visitedCap = 4 * ctx.inventoryPaths;
  let visited = 0;
  const rootStat = await lstat(root, { bigint: true });
  const stack: { rel: string; depth: number }[] = [{ rel: '', depth: 0 }];
  while (stack.length) {
    const { rel, depth } = stack.pop()!;
    ctx.deadline.check(ctx.expired);
    await ctx.hook?.('walk:enter', { path: rel });
    const dir = abs(root, rel);
    // List, then prove the directory is unchanged and not a symlink; retry once, then fail explicitly.
    let names: string[] | undefined, before: BigIntStats | undefined;
    for (let attempt = 0; attempt < 2 && !names; attempt++) {
      before = await lstat(dir, { bigint: true });
      if (before.isSymbolicLink() || !before.isDirectory()) { skipped.symlinks++; break; }
      const listing = await readdir(dir);
      await ctx.hook?.('walk:after-list', { path: rel });
      const after = await lstat(dir, { bigint: true });
      if (!after.isSymbolicLink() && after.isDirectory() && after.dev === before.dev && after.ino === before.ino && dirFingerprint(after) === dirFingerprint(before)) { names = listing; before = after; }
      else if (attempt === 1) throw new SafeError(`Discovery: ${rel || '.'} changed during discovery; retry when no other process is rewriting the tree.`);
    }
    if (!names || !before) continue;
    dirs.push({ path: rel, fp: dirFingerprint(before) });
    names.sort(byteOrder);
    if (names.includes('.gitignore')) sources.push({ path: path.join(dir, '.gitignore'), fp: await sourceFingerprint(path.join(dir, '.gitignore'), racyAfter) });
    for (const name of names) {
      if (++visited > visitedCap) throw limitError(`visited more than ${visitedCap} directory entries (4 x inventory_paths)`);
      if (visited % 256 === 0) ctx.deadline.check(ctx.expired);
      const child = rel ? `${rel}/${name}` : name;
      if (UNSAFE_NAME.test(name)) { skipped.unsafe_name++; continue; }
      if (Buffer.byteLength(name) > 255 || Buffer.byteLength(child) > 256) { skipped.too_long++; continue; }
      const stat = await lstat(path.join(dir, name), { bigint: true }).catch(() => undefined);
      if (!stat) continue;
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (depth + 1 > MAX_DEPTH) { skipped.too_long++; continue; }
        if (stat.dev !== rootStat.dev) { skipped.other_device++; continue; }
        if (!policy.mayDescend(child)) continue;
        if (ignored.dirs.has(child)) { skipped.git_ignored++; continue; }
        stack.push({ rel: child, depth: depth + 1 });
        continue;
      }
      if (!policy.decide(child, 'read').ok) continue;
      if (ignored.files.has(child) || ignored.dirs.has(child)) { skipped.git_ignored++; continue; }
      if (stat.isSymbolicLink()) { skipped.symlinks++; continue; }
      if (!stat.isFile()) { skipped.special++; continue; }
      if (stat.nlink > 1n) { skipped.linked++; continue; }
      if (Number(stat.size) > ctx.maxFileBytes) { skipped.too_large++; continue; }
      entries.push({ path: child, size: Number(stat.size), mode: Number(stat.mode), fp: fingerprint(stat) });
      if (entries.length > ctx.inventoryPaths) throw limitError(`more than ${ctx.inventoryPaths} permitted paths (inventory_paths)`);
    }
  }
  return Inventory.of(entries, dirs, skipped, policy.digest, sources);
}
