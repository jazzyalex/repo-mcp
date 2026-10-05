import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareFixture } from '../src/fixture.js';
import { RepoWorkspace, execute, type RepoOptions } from '../src/repo.js';
import { loadPolicy, compilePolicyFor } from '../src/policy.js';

export const git = async (cwd: string, ...args: string[]) => {
  const r = await execute('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], cwd, 60_000, {}, { maxOutputBytes: 256 * 1024 * 1024 });
  assert.equal(r.exit_code, 0, r.stderr);
  return r.stdout;
};

type Content = string | Buffer;
/** A fixture checkout plus extra files; `tracked` files are committed, `untracked` are only written. */
export async function makeRepo(t: { after(fn: () => Promise<void>): void }, tracked: Record<string, Content> = {}, untracked: Record<string, Content> = {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-2b-')));
  const root = path.join(base, 'repo');
  await prepareFixture(root);
  const write = async (files: Record<string, Content>) => { for (const [file, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content); } };
  await write(tracked);
  if (Object.keys(tracked).length) { await git(root, 'add', '-A'); await git(root, 'commit', '-m', 'extra fixtures'); }
  await write(untracked);
  const open: RepoWorkspace[] = [];
  t.after(async () => { for (const r of open) await r.close(); await rm(base, { recursive: true, force: true }); });
  return { base, root, write, track: (repo: RepoWorkspace) => { open.push(repo); return repo; } };
}

/** A v2 policy document; overrides replace whole top-level keys. */
export const policyDoc = (over: Record<string, unknown> = {}) => ({
  version: 2,
  read: { include: ['**'], exclude: [] },
  write: { include: [], exclude: [] },
  create: { paths: [], directories: [], extensions: [] },
  dotfiles: [],
  checks: [{ id: 'test/clamp.test.js', path: 'test/clamp.test.js' }],
  ...over
});

export async function openGlob(t: { after(fn: () => Promise<void>): void }, root: string, doc: Record<string, unknown> = policyDoc(), options: RepoOptions & { protectedPaths?: string[] } = {}, track?: (r: RepoWorkspace) => RepoWorkspace) {
  const { protectedPaths, ...repoOptions } = options;
  const repo = await RepoWorkspace.create(root, await compilePolicyFor(loadPolicy(doc), { root, protectedPaths }), repoOptions);
  return track ? track(repo) : repo;
}
