import { SafeError } from './errors.js';
import { runGit } from './exec.js';

type GitResult = Awaited<ReturnType<typeof runGit>>;

/** Resolve a conservative Git revision expression to one immutable commit ID. */
export async function resolveGitCommit(
  root: string,
  baseRef = 'HEAD',
  runner: (args: string[]) => Promise<GitResult> = args => runGit(root, args, { strictUtf8: true })
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/^~-]{0,127}$/.test(baseRef) || baseRef.includes('..')) {
    throw new SafeError('Invalid base_ref. Use a commit, branch, tag, or relative commit such as HEAD^.');
  }
  const result = await runner(['rev-parse', '--verify', `${baseRef}^{commit}`]).catch(error => {
    if (error instanceof SafeError && error.message === 'Git inspection failed.') {
      throw new SafeError(`Unknown or non-commit base_ref: ${baseRef}.`);
    }
    throw error;
  });
  if (result.timed_out) throw new SafeError('Git inspection timed out.');
  if (result.truncated || result.invalid_utf8 || result.exit_code !== 0) {
    throw new SafeError(`Unknown or non-commit base_ref: ${baseRef}.`);
  }
  const commit = result.stdout.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
    throw new SafeError('Git returned an invalid commit ID for base_ref.');
  }
  return { requested: baseRef, commit };
}
