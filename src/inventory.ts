import { lstat, readdir, realpath, stat } from 'node:fs/promises';
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
export type Skipped = { symlinks: number; special: number; linked: number; too_large: number; unsafe_name: number; too_long: number; other_device: number; git_ignored: number; nested_repo: number };
export const emptySkipped = (): Skipped => ({ symlinks: 0, special: 0, linked: 0, too_large: 0, unsafe_name: 0, too_long: 0, other_device: 0, git_ignored: 0, nested_repo: 0 });
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
 * Untracked paths that Git ignores (repository .gitignore files, .git/info/exclude and a repository-local
 * core.excludesFile; global and system config are off in the inspection environment). They are hidden from
 * discovery: ignored files are where local secrets, state and build output usually live. Tracked files are never
 * listed here, so a force-added ignored file stays visible. A directory entry (trailing slash) means everything
 * under it is ignored and untracked.
 */
type Ignored = { files: Set<string>; dirs: Set<string>; listing: string };
const IGNORE_FAILED = () => new SafeError('Discovery: unable to list Git-ignored files; check that the checkout is a readable Git repository.');
const IGNORE_UNSTABLE = () => new SafeError('Discovery: Git ignore rules kept changing while files were listed; retry when .gitignore and Git config are stable.');
const IGNORE_ATTEMPTS = 3;
async function gitText(ctx: WalkContext, args: string[], allowMissing = false) {
  ctx.deadline.check(ctx.expired);
  const result = await runGit(ctx.root, args, { timeout: ctx.deadline.timeout() });
  ctx.deadline.check(ctx.expired);
  if (allowMissing && result.exit_code === 1 && !result.stdout) return '';
  if (result.exit_code !== 0 || result.timed_out || result.truncated) throw IGNORE_FAILED();
  return result.stdout;
}
async function gitIgnored(ctx: WalkContext): Promise<Ignored> {
  const listing = await gitText(ctx, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']);
  // Git on macOS prints precomposed (NFC) names while readdir returns the bytes on disk (often NFD), so both
  // sides are compared in NFC. Two disk names with one NFC form are then both hidden: that fails closed.
  const files = new Set<string>(), dirs = new Set<string>();
  for (const name of listing.split('\0')) if (name) (name.endsWith('/') ? dirs : files).add(nfc(name.endsWith('/') ? name.slice(0, -1) : name));
  return { files, dirs, listing };
}
/** Is this path, or any directory above it, in an ignored listing? */
function ignoredBy(ignored: Ignored, rel: string) {
  const name = nfc(rel);
  if (ignored.files.has(name) || ignored.dirs.has(name)) return true;
  for (let i = name.indexOf('/'); i !== -1; i = name.indexOf('/', i + 1)) if (ignored.dirs.has(name.slice(0, i))) return true;
  return false;
}
/**
 * Files outside the walked tree that decide what Git ignores: the index (what is untracked), HEAD, info/exclude, every
 * repository-local config file (including include.path targets, and config/config.worktree even before they exist)
 * and the file a local core.excludesFile names.
 */
async function ignoreConfigSources(ctx: WalkContext) {
  // HEAD decides which includeIf.onbranch: rules apply. In a reftable repository HEAD is a fixed stub and a branch
  // switch changes only reftable/tables.list (which reads as missing, and stays stable, in a files-backend repository).
  // tables.list also changes on every ref update, so reftable repositories re-walk after commits and fetches; that
  // costs time, never read safety.
  const paths = (await gitText(ctx, ['rev-parse', '--git-path', 'index', '--git-path', 'info/exclude', '--git-path', 'config', '--git-path', 'config.worktree', '--git-path', 'HEAD', '--git-path', 'reftable/tables.list']))
    .split('\n').filter(Boolean).map(p => path.resolve(ctx.root, p));
  if (paths.length !== 6) throw IGNORE_FAILED();
  // `-z` output alternates `file:ORIGIN` and key names, NUL-separated; keys never start with `file:`.
  for (const token of (await gitText(ctx, ['config', '--list', '--show-origin', '--name-only', '-z'], true)).split('\0')) {
    if (token.startsWith('file:')) paths.push(path.resolve(ctx.root, token.slice(5)));
  }
  // include.path / includeIf.*.path targets count even when empty or missing, so a later edit or creation is seen.
  // Git resolves a relative include against the directory of the file that names it.
  const includes = (await gitText(ctx, ['config', '--type=path', '--show-origin', '--get-regexp', '-z', '^include(if\\..*)?\\.path$'], true)).split('\0');
  for (let i = 0; i + 1 < includes.length; i += 2) {
    if (!includes[i].startsWith('file:')) continue;
    const origin = path.resolve(ctx.root, includes[i].slice(5));
    const value = includes[i + 1].slice(includes[i + 1].indexOf('\n') + 1);
    if (value) paths.push(path.resolve(path.dirname(origin), value));
  }
  // Only Git's record terminator is removed: a path may legitimately start or end with spaces.
  const excludes = (await gitText(ctx, ['config', '--path', '--get', 'core.excludesFile'], true)).replace(/\n$/, '');
  if (excludes) paths.push(path.resolve(ctx.root, excludes));
  return [...new Set(paths)];
}
/** What the ignored set depends on besides directory membership: config sources and each walked .gitignore. */
type IgnoreSource = { path: string; fp: string };
/** The source itself and, through any symlink, the file Git actually reads. */
const sourceFingerprint = async (file: string) => {
  const [link, target] = await Promise.all([lstat(file, { bigint: true }).catch(() => undefined), stat(file, { bigint: true }).catch(() => undefined)]);
  return `${link ? fingerprint(link) : 'missing'}>${target ? fingerprint(target) : 'missing'}`;
};
async function fingerprintAll(ctx: WalkContext, files: string[]) {
  const out: IgnoreSource[] = [];
  for (let i = 0; i < files.length; i += 64) {
    ctx.deadline.check(ctx.expired);
    out.push(...await Promise.all(files.slice(i, i + 64).map(async file => ({ path: file, fp: await sourceFingerprint(file) }))));
  }
  ctx.deadline.check(ctx.expired);
  return out;
}
async function sourcesUnchanged(ctx: WalkContext, sources: IgnoreSource[]) {
  const now = await fingerprintAll(ctx, sources.map(source => source.path));
  return sameSources(sources, now);
}
const sameSources = (a: IgnoreSource[], b: IgnoreSource[]) => a.length === b.length && a.every((x, i) => x.path === b[i].path && x.fp === b[i].fp);

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
  withIgnoreSources(sources: IgnoreSource[]) { return new Inventory(this.entries, this.dirs, this.skipped, this.salt, sources); }
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
   * Git config, excludes file or index moves no tree directory either, so a change to any of them triggers a
   * re-walk too.
   */
  async refresh(ctx: WalkContext): Promise<Inventory> {
    if (!await sourcesUnchanged(ctx, this.ignoreSources)) return walk(ctx);
    await ctx.hook?.('refresh:sources-checked', { path: '' });
    // Anything now on another device (a mount over a file or directory) re-walks.
    const rootDev = (await lstat(ctx.root, { bigint: true })).dev;
    for (const dir of this.dirs) {
      ctx.deadline.check(ctx.expired);
      const stat = await lstat(abs(ctx.root, dir.path), { bigint: true }).catch(() => undefined);
      if (!stat || !stat.isDirectory() || stat.dev !== rootDev || dirFingerprint(stat) !== dir.fp) return walk(ctx);
    }
    let changed = false;
    for (let i = 0; i < this.entries.length; i += 64) {
      ctx.deadline.check(ctx.expired);
      const batch = this.entries.slice(i, i + 64);
      const stats = await Promise.all(batch.map(e => lstat(abs(ctx.root, e.path), { bigint: true }).catch(() => undefined)));
      for (let j = 0; j < batch.length; j++) {
        const stat = stats[j], entry = batch[j];
        if (!stat || !stat.isFile() || stat.nlink > 1n || stat.dev !== rootDev || Number(stat.size) > ctx.maxFileBytes) return walk(ctx);
        const fp = fingerprint(stat);
        if (fp !== entry.fp) { entry.fp = fp; entry.size = Number(stat.size); entry.mode = Number(stat.mode); changed = true; }
      }
    }
    // Checked again at the end: a rule edited while entries were re-checked must not reach this answer.
    if (!await sourcesUnchanged(ctx, this.ignoreSources)) return walk(ctx);
    if (changed) this.rehash();
    return this;
  }
}

const limitError = (what: string) => new SafeError(`Discovery limit: ${what}. Add excludes or narrow read.include so fewer paths are visited.`);

/**
 * Walk the repository from its root under the policy. Never returns a partial inventory.
 *
 * The ignored-path listing and its sources must form one consistent snapshot: the walk uses a first listing, then
 * every source is fingerprinted, Git lists again, and the sources are fingerprinted again. The snapshot holds when
 * both fingerprint sets agree (so the second listing saw exactly the recorded sources) and the second listing hides
 * nothing the walk exposed. Otherwise the walk is retried, and it fails closed after a few unstable attempts.
 */
export async function walk(ctx: WalkContext): Promise<Inventory> {
  for (let attempt = 0; attempt < IGNORE_ATTEMPTS; attempt++) {
    const ignored = await gitIgnored(ctx);
    const { inventory, gitignores, admitted } = await walkOnce(ctx, ignored);
    const configSources = await ignoreConfigSources(ctx);
    await ctx.hook?.('walk:sources-listed', { path: '' });
    const files = [...configSources, ...gitignores];
    const before = await fingerprintAll(ctx, files);
    const again = await gitIgnored(ctx);
    const after = await fingerprintAll(ctx, files);
    // The second listing may differ only by ignored files appearing or vanishing (a build writing caches); it must
    // not hide anything the walk exposed. The set of config sources must also still be the same.
    const consistent = sameSources(before, after) &&
      (again.listing === ignored.listing || !inventory.entries.some(entry => ignoredBy(again, entry.path) && !admitted.has(entry.path))) &&
      (await ignoreConfigSources(ctx)).join('\0') === configSources.join('\0');
    // An admitted ignored_exact file's parents must still be the same real directories
    // outside any nested repository; otherwise this answer is not used.
    if (consistent && await admittedParentsUnchanged(ctx, inventory, admitted)) return inventory.withIgnoreSources(after);
  }
  throw IGNORE_UNSTABLE();
}

/**
 * Add the policy's `ignored_exact` paths that Git ignores. Each must be a regular,
 * unlinked file within the size limit, reached only through real directories on the root's
 * device and outside nested repositories, and readable under the policy. Its parent
 * directories are fingerprinted so a change there triggers a re-walk. Anything else is
 * left out, exactly like any other file the walk would skip.
 */
async function admittedParentsUnchanged(ctx: WalkContext, inventory: Inventory, admitted: Set<string>) {
  if (!admitted.size) return true;
  const rootDev = (await lstat(ctx.root, { bigint: true })).dev;
  const fps = new Map(inventory.dirs.map(d => [d.path, d.fp]));
  for (const rel of admitted) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      ctx.deadline.check(ctx.expired);
      const dir = parts.slice(0, i).join('/');
      const stat = await lstat(abs(ctx.root, dir), { bigint: true }).catch(() => undefined);
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== rootDev || dirFingerprint(stat) !== fps.get(dir)) return false;
      if (await lstat(path.join(abs(ctx.root, dir), '.git')).then(() => true, () => false)) return false;
    }
  }
  ctx.deadline.check(ctx.expired);
  return true;
}


async function addIgnoredExact(ctx: WalkContext, ignored: Ignored, entries: Entry[], dirs: Dir[], rootStat: BigIntStats, admitted: Set<string>, skipped: Skipped, budget: { visited: number; cap: number }) {
  const listed = new Set(entries.map(e => nfc(e.path)));
  const walked = new Set(dirs.map(d => d.path));
  const counted = new Set<string>();
  const count = (dir: string, key: keyof Skipped) => { if (!counted.has(dir)) { counted.add(dir); skipped[key]++; } };
  const cap = budget.cap;
  for (const listedRel of ctx.policy.ignoredExact) {
    ctx.deadline.check(ctx.expired);
    if (listed.has(nfc(listedRel)) || !ctx.policy.decide(listedRel, 'read').ok) continue;
    const rel = listedRel;
    const parts = rel.split('/');
    if (parts.some(p => UNSAFE_NAME.test(p) || Buffer.byteLength(p) > 255) || Buffer.byteLength(rel) > 256 || parts.length > MAX_DEPTH) continue;
    // Watch every existing real parent, even when a deeper one or the file is missing, so a
    // later create anywhere on the path re-walks.
    let ok = true;
    for (let i = 1; i < parts.length && ok; i++) {
      if (++budget.visited > cap) throw limitError(`visited more than ${cap} directory entries (4 x inventory_paths)`);
      ctx.deadline.check(ctx.expired);
      const dir = parts.slice(0, i).join('/');
      const stat = await lstat(abs(ctx.root, dir), { bigint: true }).catch(() => undefined);
      if (!stat) { ok = false; break; }
      if (stat.isSymbolicLink()) { count(dir, 'symlinks'); ok = false; break; }
      if (!stat.isDirectory()) { count(dir, 'special'); ok = false; break; }
      if (stat.dev !== rootStat.dev) { count(dir, 'other_device'); ok = false; break; }
      // Watched before the .git check, so removing a nested-repository marker re-walks.
      if (!walked.has(dir)) { dirs.push({ path: dir, fp: dirFingerprint(stat) }); walked.add(dir); }
      if (await lstat(path.join(abs(ctx.root, dir), '.git')).then(() => true, () => false)) { count(dir, 'nested_repo'); ok = false; }
    }
    // Only a path Git actually ignores needs the exception; any other is the walk's business.
    if (!ok || !ignoredBy(ignored, rel)) continue;
    if (++budget.visited > cap) throw limitError(`visited more than ${cap} directory entries (4 x inventory_paths)`);
    const stat = await lstat(abs(ctx.root, rel), { bigint: true }).catch(() => undefined);
    if (!stat) continue;
    if (stat.isSymbolicLink()) { skipped.symlinks++; continue; }
    if (!stat.isFile()) { skipped.special++; continue; }
    if (stat.nlink > 1n) { skipped.linked++; continue; }
    if (stat.dev !== rootStat.dev) { skipped.other_device++; continue; }
    if (Number(stat.size) > ctx.maxFileBytes) { skipped.too_large++; continue; }
    // The entry carries the disk spelling, found without listing any directory: the parents
    // are verified real directories, so realpath stays inside the root. Entries are ASCII
    // (policy load refuses others), so there is one normalization form; the disk spelling
    // must equal the listed path byte for byte, so a case-only alias is not admitted.
    const real = await realpath(abs(ctx.root, rel)).catch(() => undefined);
    const rootReal = await realpath(ctx.root).catch(() => ctx.root);
    const disk = real && path.relative(rootReal, real).split(path.sep).join('/');
    if (disk !== rel) { skipped.unsafe_name++; continue; }
    entries.push({ path: disk, size: Number(stat.size), mode: Number(stat.mode), fp: fingerprint(stat) });
    listed.add(nfc(disk));
    admitted.add(disk);
    if (entries.length > ctx.inventoryPaths) throw limitError(`more than ${ctx.inventoryPaths} permitted paths (inventory_paths)`);
  }
}

async function walkOnce(ctx: WalkContext, ignored: Ignored): Promise<{ inventory: Inventory; gitignores: string[]; admitted: Set<string> }> {
  const { root, policy } = ctx;
  const gitignores: string[] = [];
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
    if (names.includes('.gitignore')) gitignores.push(path.join(dir, '.gitignore'));
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
        if (ignored.dirs.has(nfc(child))) { skipped.git_ignored++; continue; }
        // A nested repository or submodule has its own index and ignore rules, which this repository's Git never
        // applies: its files are not walked at all.
        if (await lstat(path.join(dir, name, '.git')).then(() => true, () => false)) { skipped.nested_repo++; continue; }
        stack.push({ rel: child, depth: depth + 1 });
        continue;
      }
      if (!policy.decide(child, 'read').ok) continue;
      if (ignored.files.has(nfc(child)) || ignored.dirs.has(nfc(child))) { skipped.git_ignored++; continue; }
      if (stat.isSymbolicLink()) { skipped.symlinks++; continue; }
      if (!stat.isFile()) { skipped.special++; continue; }
      if (stat.nlink > 1n) { skipped.linked++; continue; }
      if (stat.dev !== rootStat.dev) { skipped.other_device++; continue; }
      if (Number(stat.size) > ctx.maxFileBytes) { skipped.too_large++; continue; }
      entries.push({ path: child, size: Number(stat.size), mode: Number(stat.mode), fp: fingerprint(stat) });
      if (entries.length > ctx.inventoryPaths) throw limitError(`more than ${ctx.inventoryPaths} permitted paths (inventory_paths)`);
    }
  }
  const admitted = new Set<string>();
  // One visit budget for the walk and the ignored_exact probes together.
  await addIgnoredExact(ctx, ignored, entries, dirs, rootStat, admitted, skipped, { visited, cap: visitedCap });
  return { inventory: Inventory.of(entries, dirs, skipped, policy.digest), gitignores, admitted };
}
