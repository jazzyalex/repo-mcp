import { z } from 'zod';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { SafeError, PolicyError, sha256 } from './errors.js';
import { defaultPolicy, type RepoPolicy } from './repo.js';
import { PathPolicy } from './path-policy.js';
import type { PythonRunner } from './python-runner.js';
import { DEFAULT_LIMITS } from './limits.js';

// Operator-owned policy. v2 defines the full scope model from WORKFLOW-SPEC.md. Matching, dotfiles and
// creation directories are enforced by PathPolicy (milestone 2b). Policies made only of exact paths
// keep their v1 runtime form (runtimePolicy); anything else compiles through compilePolicy.

export { PolicyError };

export { DEFAULT_LIMITS };

const PATTERN = /[*?[\]{}!]/;

export function policyPathProblem(p: string) {
  if (!p || p.length > 256) return 'must contain 1-256 characters';
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return 'must be a relative POSIX path';
  const parts = p.split('/');
  if (parts.some(s => !s || s === '.' || s === '..')) return 'must not contain empty, "." or ".." segments';
  if (parts.includes('.git')) return 'must not reach .git internals';
  return undefined;
}

const relPath = z.string().superRefine((p, ctx) => {
  const problem = policyPathProblem(p);
  if (problem) ctx.addIssue({ code: 'custom', message: `Invalid policy path "${p}": ${problem}` });
});
const scope = z.strictObject({ include: z.array(relPath), exclude: z.array(relPath).default([]) });
const positive = z.number().int().positive();
const runner = z.strictObject({ kind: z.literal('python-pytest'), executable: z.string().min(1), dependencies: z.string().min(1) });

const v1Schema = z.strictObject({
  files: z.array(z.string()), editable: z.array(z.string()), tests: z.array(z.string()),
  creatable: z.array(z.string()).optional(), runner: runner.optional()
});

const v2Schema = z.strictObject({
  version: z.literal(2),
  read: scope,
  write: scope,
  create: z.strictObject({
    paths: z.array(relPath).default([]),
    directories: z.array(relPath).default([]),
    extensions: z.array(z.string().regex(/^\.[A-Za-z0-9]{1,16}$/)).default([])
  }).default({ paths: [], directories: [], extensions: [] }),
  dotfiles: z.array(relPath).default([]),
  secret_exceptions: z.array(relPath).optional(),
  checks: z.array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/), path: relPath })).default([]),
  runner: runner.optional(),
  limits: z.strictObject(Object.fromEntries(Object.keys(DEFAULT_LIMITS).map(k => [k, positive])) as Record<keyof typeof DEFAULT_LIMITS, typeof positive>).default(DEFAULT_LIMITS),
});

export type PolicyV1 = RepoPolicy;
export type PolicyV2 = z.infer<typeof v2Schema>;

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new PolicyError(`Invalid policy: ${result.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  return result.data;
}

export function migrateV1(v1: PolicyV1): PolicyV2 {
  return {
    version: 2,
    read: { include: [...v1.files], exclude: [] },
    write: { include: [...v1.editable], exclude: [] },
    create: { paths: [...(v1.creatable ?? [])], directories: [], extensions: [] },
    dotfiles: [],
    checks: v1.tests.map(t => ({ id: t, path: t })),
    ...(v1.runner ? { runner: { ...v1.runner } } : {}),
    limits: { ...DEFAULT_LIMITS }
  };
}

export function loadPolicy(raw: unknown): PolicyV2 {
  if (raw === undefined) return migrateV1(defaultPolicy);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PolicyError('Invalid policy: expected a JSON object.');
  let policy: PolicyV2;
  if ('version' in raw) {
    if ((raw as { version: unknown }).version !== 2) throw new PolicyError('Unsupported policy version. Expected version 2 or a v1 exact-list policy.');
    policy = parse(v2Schema, raw);
  } else policy = parse(v2Schema, migrateV1(parse(v1Schema, raw) as PolicyV1));
  // An empty exception list is the same policy as none, so existing task policy digests do not move.
  if (policy.secret_exceptions && !policy.secret_exceptions.length) delete policy.secret_exceptions;
  return policy;
}

// Canonical JSON so equivalent policies bind to the same task digest.
const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
    : JSON.stringify(value);

export const policyDigest = (policy: PolicyV2) => sha256(canonical(policy));

function checkNames(policy: PolicyV2) {
  if (policy.checks.some(c => c.id !== c.path)) throw new PolicyError('Named check IDs are not supported yet; each check id must equal its test path.');
}

function specOf(policy: PolicyV2, protectedPaths: string[] = []) {
  return {
    read: policy.read, write: policy.write, create: policy.create, dotfiles: policy.dotfiles,
    checks: policy.checks.map(c => c.path), secretExceptions: policy.secret_exceptions ?? [], protectedPaths
  };
}

/**
 * The v1 exact-list form of a policy, derived from the compiled PathPolicy's own decisions so that excludes (folded,
 * Unicode-normalised, prefix-closed) and server-owned paths apply exactly as they do for glob policies. A listed path
 * that a rule denies is dropped; one that merely lacks an include stays so the v1 membership check still reports it.
 * A configured check that is denied is an error: a suite list must never shrink silently. Only exact policies have this form.
 */
export function runtimePolicy(policy: PolicyV2, protectedPaths: string[] = []): RepoPolicy {
  checkNames(policy);
  const compiled = PathPolicy.compile(specOf(policy, protectedPaths));
  if (!compiled.exact || [...policy.write.include, ...policy.write.exclude, ...policy.read.exclude, ...policy.create.paths, ...policy.checks.map(c => c.path)].some(p => /[*?]/.test(p))) {
    throw new PolicyError('This policy uses patterns or creation directories, so it has no exact-list form; compile it with compilePolicy.');
  }
  return exactLists(policy, compiled);
}

function exactLists(policy: PolicyV2, paths: PathPolicy): RepoPolicy {
  const survives = (p: string, op: 'read' | 'write' | 'create') => { const d = paths.decide(p, op); return d.ok || d.reason.startsWith('not matched by'); };
  const tests = policy.checks.map(c => c.path);
  for (const p of tests) {
    const d = paths.decide(p, 'read');
    if (!d.ok && !d.reason.startsWith('not matched by')) throw new PolicyError(`Check path "${p}" is not readable under this policy (${d.reason}); remove the check or the rule that denies it.`);
  }
  const result: RepoPolicy = {
    files: policy.read.include.filter(p => survives(p, 'read')),
    editable: policy.write.include.filter(p => survives(p, 'write')),
    tests
  };
  if (policy.create.paths.length) result.creatable = policy.create.paths.filter(p => survives(p, 'create'));
  if (policy.runner) result.runner = { ...policy.runner };
  return result;
}

export type CompiledPolicy = { paths: PathPolicy; runner?: PythonRunner; legacy?: RepoPolicy };

/**
 * Compile a policy for the server. `protectedPaths` are absolute server-owned files or directories
 * (policy file, audit log, state); those inside the repository root are denied with everything beneath.
 */
export async function compilePolicyFor(policy: PolicyV2, options: { root?: string; protectedPaths?: string[] } = {}): Promise<CompiledPolicy> {
  const relative: string[] = [];
  if (options.root) {
    const root = await realpath(options.root);
    for (const absolute of options.protectedPaths ?? []) {
      // The target may not exist yet (an audit log), so resolve its nearest existing ancestor.
      let existing = path.resolve(absolute); const rest: string[] = [];
      for (;;) { try { existing = await realpath(existing); break; } catch { rest.unshift(path.basename(existing)); const up = path.dirname(existing); if (up === existing) break; existing = up; } }
      const rel = path.relative(root, path.join(existing, ...rest));
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) relative.push(rel.split(path.sep).join('/'));
    }
  }
  return compileWith(policy, relative);
}

function compileWith(policy: PolicyV2, protectedPaths: string[]): CompiledPolicy {
  checkNames(policy);
  const paths = PathPolicy.compile(specOf(policy, protectedPaths));
  const compiled: CompiledPolicy = { paths, ...(policy.runner ? { runner: { ...policy.runner } } : {}) };
  // The exact lists come from the same compiled policy, server-owned paths included.
  if (paths.exact && ![...policy.write.include, ...policy.write.exclude, ...policy.read.exclude, ...policy.create.paths].some(p => /[*?]/.test(p))) compiled.legacy = exactLists(policy, paths);
  return compiled;
}

/** Synchronous form for policies with no server-owned paths inside the repository. */
export const compilePolicy = (policy: PolicyV2): CompiledPolicy => compileWith(policy, []);
