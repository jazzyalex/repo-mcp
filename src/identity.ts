import { realpath } from 'node:fs/promises';
import { SafeError } from './errors.js';
import { runGit } from './exec.js';

export type RepoIdentity = {
  root: string; git_dir: string; common_dir: string; linked_worktree: boolean;
  branch: string | null; detached: boolean; head: string;
};

/**
 * Resolve checkout identity through Git; accepts ordinary checkouts and linked worktrees.
 * `timeout` gives each Git call the time an enclosing operation has left.
 */
export async function resolveIdentity(root: string, options: { timeout?: () => number } = {}): Promise<RepoIdentity> {
  const run = async (args: string[]) => {
    const result = await runGit(root, args, { timeout: options.timeout?.() });
    if (result.timed_out) throw new SafeError('Git inspection timed out.');
    return result;
  };
  const bare = await run(['rev-parse', '--is-bare-repository']);
  if (bare.exit_code !== 0) throw new SafeError('REPO_ROOT is not inside a Git repository.');
  if (bare.stdout.trim() === 'true') throw new SafeError('Bare repositories cannot be coding targets; select a checkout or linked worktree.');
  const dirs = await run(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']);
  const lines = dirs.stdout.split('\n').filter(Boolean);
  if (dirs.exit_code !== 0 || lines.length !== 3) throw new SafeError('REPO_ROOT must be a Git working tree.');
  const [top, gitDir, commonDir] = await Promise.all(lines.map(p => realpath(p)));
  if (top !== root) throw new SafeError('Git root does not match REPO_ROOT.');
  const head = await run(['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  if (head.exit_code !== 0) throw new SafeError('Checkout HEAD has no commit; create an initial commit first.');
  const ref = await run(['symbolic-ref', '-q', 'HEAD']);
  if (ref.exit_code !== 0 && ref.exit_code !== 1) throw new SafeError('Git inspection failed.');
  const branch = ref.exit_code === 0 ? ref.stdout.trim().replace(/^refs\/heads\//, '') : null;
  return { root: top, git_dir: gitDir, common_dir: commonDir, linked_worktree: gitDir !== commonDir, branch, detached: branch === null, head: head.stdout.trim() };
}

/** Describe how the checkout moved away from its bound identity, if at all. */
export function identityDrift(expected: Pick<RepoIdentity, 'root' | 'git_dir' | 'common_dir' | 'branch' | 'head'>, current: RepoIdentity) {
  if (expected.root !== current.root || expected.git_dir !== current.git_dir || expected.common_dir !== current.common_dir) return 'Checkout identity changed; the task is bound to a different checkout.';
  if (expected.branch !== current.branch) return `Checkout branch changed (bound ${expected.branch ?? 'detached HEAD'}, now ${current.branch ?? 'detached HEAD'}). Coordinator reconciliation is required.`;
  if (expected.head !== current.head) return `Checkout HEAD changed (bound ${expected.head.slice(0, 12)}, now ${current.head.slice(0, 12)}). Coordinator reconciliation is required.`;
  return undefined;
}
