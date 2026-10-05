import { constants } from 'node:fs';
import { lstat, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import type { Stats, BigIntStats } from 'node:fs';
import path from 'node:path';
import { SafeError, NotAppliedError } from './errors.js';

// Filesystem containment (docs/DESIGN-2B-PATH-POLICY.md section 8). Node has no openat, so every
// operation verifies identity after acting. These checks detect swapped path components; they do not
// make a race impossible, and any undo is best effort.

export type PathHook = (stage: string, ctx: { path: string }) => void | Promise<void>;
export type DirIdentity = { dev: number; ino: number };

const here = (root: string, rel: string) => rel ? path.join(root, rel) : root;

/** Reject symlinks in every component of root/rel. ENOENT propagates so callers can tell "missing". */
export async function assertNoSymlinks(root: string, rel: string) {
  let current = root;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new SafeError('Symlinks are not supported.');
  }
}

/**
 * Open root/rel for reading and prove the descriptor is the in-tree file: check the components, open
 * with O_NOFOLLOW, then require realpath(path) === root/rel and the descriptor's (dev, ino) to equal an
 * lstat of the same path taken after the open. The first catches an intermediate component swapped to a
 * symlink; the second catches a swap that was restored before the check.
 */
export async function openVerified(root: string, rel: string, hook?: PathHook): Promise<{ handle: FileHandle; stat: Stats }> {
  await assertNoSymlinks(root, rel);
  await hook?.('read:after-check', { path: rel });
  const target = path.join(root, rel);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    await hook?.('read:after-open', { path: rel });
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new SafeError('Expected a regular text file with one hard link.');
    const canonical = await realpath(target);
    const inside = path.relative(root, canonical);
    if (inside.startsWith('..') || path.isAbsolute(inside)) throw new SafeError('Path outside repository.');
    if (canonical !== target) throw new SafeError('Path changed while it was being opened; read it again.');
    const after = await lstat(target);
    if (after.dev !== stat.dev || after.ino !== stat.ino) throw new SafeError('Path changed while it was being opened; read it again.');
    return { handle, stat };
  } catch (error) { await handle.close().catch(() => {}); throw error; }
}

export type DiffInput = { state: 'absent' } | { state: 'refused'; reason: string } | { state: 'file'; stat: BigIntStats };

/**
 * Judge an existing Git diff input by the same rules as read and discovery before Git opens it: no symlink in any
 * component, a regular file with one hard link, on the root's device, within the size limit. A missing file or
 * parent directory is `absent` (a genuine deletion). Git opens the path itself afterwards, so callers compare the
 * returned stat with a second lstat after Git has run; that detects a swap, it does not prevent one.
 */
export async function diffInput(root: string, rel: string, maxBytes: number): Promise<DiffInput> {
  try {
    const rootStat = await lstat(root, { bigint: true });
    const parts = rel.split('/');
    let current = root;
    for (const [i, part] of parts.entries()) {
      current = path.join(current, part);
      const stat = await lstat(current, { bigint: true });
      if (stat.isSymbolicLink()) return { state: 'refused', reason: 'a path component is a symlink' };
      if (stat.dev !== rootStat.dev) return { state: 'refused', reason: 'it is on another device' };
      if (i < parts.length - 1) { if (!stat.isDirectory()) return { state: 'refused', reason: 'a path component is not a directory' }; continue; }
      if (!stat.isFile()) return { state: 'refused', reason: 'it is not a regular file' };
      if (stat.nlink > 1n) return { state: 'refused', reason: 'it has more than one hard link' };
      if (Number(stat.size) > maxBytes) return { state: 'refused', reason: 'it exceeds the file size limit' };
      return { state: 'file', stat };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'absent' };
    return { state: 'refused', reason: 'it cannot be inspected' };
  }
  return { state: 'refused', reason: 'it is not a regular file' };
}

/** Identity of a real, non-symlink directory that is exactly where it claims to be. */
export async function dirIdentity(root: string, relDir: string): Promise<DirIdentity> {
  const dir = here(root, relDir);
  const stat = await lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SafeError('Containing directory is not a plain directory.');
  if (await realpath(dir) !== dir) throw new SafeError('Containing directory resolves outside its expected location.');
  return { dev: stat.dev, ino: stat.ino };
}

/** Throw NotAppliedError (nothing published yet) if the directory is no longer the one we checked. */
export async function assertSameDir(root: string, relDir: string, expected: DirIdentity) {
  let now: DirIdentity;
  try { now = await dirIdentity(root, relDir); }
  catch (error) { throw new NotAppliedError(`Containing directory changed while the operation was running; nothing was published. (${(error as Error).message})`); }
  if (now.dev !== expected.dev || now.ino !== expected.ino) throw new NotAppliedError('Containing directory changed while the operation was running; nothing was published.');
}

/**
 * After publishing `rel`, prove it landed where intended: realpath(root/rel) is that path and its
 * identity is the file we wrote. Failure is an uncertain outcome, never success.
 */
export async function verifyPublished(root: string, rel: string, expected: { dev: number; ino: number }) {
  const target = path.join(root, rel);
  let ok = false;
  try {
    const stat = await lstat(target);
    ok = (await realpath(target)) === target && stat.dev === expected.dev && stat.ino === expected.ino;
  } catch { ok = false; }
  if (!ok) throw new SafeError(`containment_violation: ${rel} may not have been published where intended (a path component changed during the operation). Inspect the repository and the surrounding directories before retrying.`);
}

/**
 * Best-effort undo of a link we created. A pathname check followed by an unlink can itself be raced, so
 * the unlink only happens if a fresh lstat still shows our inode, and any failure is reported.
 */
export async function removeIfSame(file: string, expected: { dev: number; ino: number }) {
  try {
    const stat = await lstat(file);
    if (stat.dev !== expected.dev || stat.ino !== expected.ino) return false;
    await unlink(file);
    return true;
  } catch { return false; }
}
