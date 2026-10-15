import { SafeError, sha256 } from './errors.js';
import { runGit } from './exec.js';

type GitResult = Awaited<ReturnType<typeof runGit>>;
type GitRunner = (args: string[]) => Promise<GitResult>;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/^~-]{0,127}$/;
const HEX64 = /^[a-f0-9]{64}$/;

export function isConservativeGitRevision(ref: string) {
  return REVISION.test(ref) && !ref.includes('..');
}

async function resolveConservativeCommit(
  root: string,
  ref: string,
  label: 'base_ref' | 'head_ref' | 'ref',
  runner: GitRunner = args => runGit(root, args, { strictUtf8: true })
) {
  if (!isConservativeGitRevision(ref)) {
    throw new SafeError(`Invalid ${label}. Use a commit, branch, tag, or relative commit such as HEAD^.`);
  }
  const result = await runner(['rev-parse', '--verify', `${ref}^{commit}`]).catch(error => {
    if (error instanceof SafeError && error.message === 'Git inspection failed.') {
      throw new SafeError(`Unknown or non-commit ${label}: ${ref}.`);
    }
    throw error;
  });
  if (result.timed_out) throw new SafeError('Git inspection timed out.');
  if (result.truncated || result.invalid_utf8 || result.exit_code !== 0) {
    throw new SafeError(`Unknown or non-commit ${label}: ${ref}.`);
  }
  const commit = result.stdout.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
    throw new SafeError(`Git returned an invalid commit ID for ${label}.`);
  }
  return { requested: ref, commit };
}

/** Resolve a conservative Git base expression to one immutable commit ID. */
export function resolveGitCommit(root: string, baseRef = 'HEAD', runner?: GitRunner) {
  return resolveConservativeCommit(root, baseRef, 'base_ref', runner);
}

/** Resolve a conservative Git head expression to one immutable commit ID. */
export function resolveGitHeadCommit(root: string, headRef = 'HEAD', runner?: GitRunner) {
  return resolveConservativeCommit(root, headRef, 'head_ref', runner);
}

/** Resolve a conservative committed-blob read ref to one immutable commit ID. */
export function resolveGitReadCommit(root: string, ref = 'HEAD', runner?: GitRunner) {
  return resolveConservativeCommit(root, ref, 'ref', runner);
}

export const COMMIT_REVIEW_FORMAT_VERSION = 1 as const;

export type CommitReviewBinding = {
  format_version: typeof COMMIT_REVIEW_FORMAT_VERSION;
  assurance: 'commit_pinned';
  requested_base_ref: string;
  base_commit: string;
  requested_head_ref: string;
  head_commit: string;
  scope_prefix: string;
  candidate_digest: string;
};

export function commitReviewCandidateDigest(
  policyDigest: string,
  baseCommit: string,
  headCommit: string,
  scopePrefix: string
) {
  if (!HEX64.test(policyDigest)) throw new SafeError('Invalid policy digest for commit review binding.');
  return sha256(JSON.stringify([
    'repo-mcp-commit-review-candidate',
    COMMIT_REVIEW_FORMAT_VERSION,
    policyDigest,
    baseCommit,
    headCommit,
    scopePrefix
  ]));
}

export function commitReviewTargetFingerprint(policyDigest: string, headCommit: string) {
  if (!HEX64.test(policyDigest)) throw new SafeError('Invalid policy digest for commit review target.');
  return sha256(JSON.stringify([
    'repo-mcp-commit-review-target',
    COMMIT_REVIEW_FORMAT_VERSION,
    policyDigest,
    headCommit
  ]));
}

export async function resolveCommitReviewBinding(options: {
  root: string;
  policyDigest: string;
  baseRef: string;
  headRef: string;
  scopePrefix?: string;
  runner?: GitRunner;
}): Promise<CommitReviewBinding> {
  const scopePrefix = options.scopePrefix ?? '';
  if (scopePrefix.length > 256 || /[\u0000-\u001f\u007f]/u.test(scopePrefix)) {
    throw new SafeError('Review scope prefix is invalid.');
  }
  const base = await resolveConservativeCommit(options.root, options.baseRef, 'base_ref', options.runner);
  const head = await resolveConservativeCommit(options.root, options.headRef, 'head_ref', options.runner);
  return {
    format_version: COMMIT_REVIEW_FORMAT_VERSION,
    assurance: 'commit_pinned',
    requested_base_ref: base.requested,
    base_commit: base.commit,
    requested_head_ref: head.requested,
    head_commit: head.commit,
    scope_prefix: scopePrefix,
    candidate_digest: commitReviewCandidateDigest(options.policyDigest, base.commit, head.commit, scopePrefix)
  };
}
