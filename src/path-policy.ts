import { PolicyError, sha256 } from './errors.js';
import { compileGlob, fold, nfc, pathProblem, type Glob } from './glob.js';

// Path policy (docs/DESIGN-2B-PATH-POLICY.md sections 2-6). One object answers: may this path be read,
// written or created, may discovery descend into this directory, and which creation scope applies.

export type Op = 'read' | 'write' | 'create';
type Rules = { include: string[]; exclude?: string[] };
export type PathPolicySpec = {
  read: Rules; write?: Rules;
  create?: { paths?: string[]; directories?: string[]; extensions?: string[] };
  dotfiles?: string[]; checks?: string[]; secretExceptions?: string[];
  /** Root-relative server-owned paths (policy file, audit log, ...): denied with everything beneath them. */
  protectedPaths?: string[];
};
export type Decision = { ok: true } | { ok: false; reason: string };
export type CreateRule = { ok: true; dir: string | null } | { ok: false; message: string };

export const MAX_CREATE_DEPTH = 8;
const NOT_APPROVED = 'Path is not approved for creation.';

const VCS = new Set(['.git', '.hg', '.svn']);
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker']);
const SECRET_FILE = [/^\.env$/, /^\.env\./, /\.(pem|key|p12|pfx|jks|keystore)$/, /^id_(rsa|dsa|ecdsa|ed25519)/, /^\.npmrc$/, /^\.pypirc$/, /^\.netrc$/, /^\.git-credentials$/, /^\.htpasswd$/, /^credentials(\.json)?$/];
const TEMP_FILE = /^\.mcp-.*\.tmp$/;
const EXAMPLE_SUFFIX = /\.(example|sample|template|tmpl|dist)$/;

/** The repository-root directory the operator keeps server state and logs in. Never exposed, never liftable. */
const SERVER_DIR = '.trial';

type Rule = 'VCS metadata' | 'secret directory' | 'server temporary file' | 'secret file name' | 'server-owned .trial directory';

/** `config.pem.sample` hides the secret name `config.pem`: strip every trailing conventional example suffix. */
function withoutExampleSuffix(base: string) {
  let name = base;
  for (;;) {
    const next = name.replace(EXAMPLE_SUFFIX, '');
    if (next === name || !next) return name;
    name = next;
  }
}

/** Unconditional denials, evaluated on folded names so case and Unicode variants are covered. */
function builtinRules(path: string): Rule[] {
  const segments = fold(path).split('/');
  const found: Rule[] = [];
  if (segments.some(s => VCS.has(s))) found.push('VCS metadata');
  if (segments.some(s => SECRET_DIRS.has(s))) found.push('secret directory');
  const base = segments.at(-1)!;
  if (TEMP_FILE.test(base)) found.push('server temporary file');
  const bare = withoutExampleSuffix(base);
  if (SECRET_FILE.some(re => re.test(base) || re.test(bare))) found.push('secret file name');
  if (segments[0] === SERVER_DIR) found.push('server-owned .trial directory');
  return found;
}

const prefixes = (path: string) => { const parts = path.split('/'); return parts.map((_, i) => parts.slice(0, i + 1).join('/')); };
const hasWildcard = (p: string) => /[*?]/.test(p);

export class PathPolicy {
  readonly digest: string;
  readonly exact: boolean;
  private readonly readLiterals: Set<string>;
  private readonly readPatterns: Glob[];
  private readonly writeLiterals: Set<string>;
  private readonly writePatterns: Glob[];
  private constructor(
    private readonly spec: Required<Omit<PathPolicySpec, 'protectedPaths'>> & { read: Required<Rules>; write: Required<Rules>; create: Required<NonNullable<PathPolicySpec['create']>> },
    private readonly protectedFolded: string[],
    private readonly readInclude: Glob[], private readonly readExclude: Glob[],
    private readonly writeInclude: Glob[], private readonly writeExclude: Glob[],
    private readonly dotfiles: Glob[], private readonly exceptions: Set<string>,
    private readonly createPaths: Set<string>, private readonly createDirs: string[], private readonly extensions: Set<string>
  ) {
    this.exact = readInclude.every(g => g.isLiteral) && createDirs.length === 0;
    // Exact policies list thousands of literal paths; a set lookup keeps each decision O(1) instead of O(paths).
    this.readLiterals = new Set(readInclude.filter(g => g.isLiteral).map(g => nfc(g.source)));
    this.readPatterns = readInclude.filter(g => !g.isLiteral);
    this.writeLiterals = new Set(writeInclude.filter(g => g.isLiteral).map(g => nfc(g.source)));
    this.writePatterns = writeInclude.filter(g => !g.isLiteral);
    this.digest = sha256(JSON.stringify([spec, protectedFolded]));
  }

  static compile(input: PathPolicySpec): PathPolicy {
    const spec = {
      read: { include: [...input.read.include], exclude: [...(input.read.exclude ?? [])] },
      write: { include: [...(input.write?.include ?? [])], exclude: [...(input.write?.exclude ?? [])] },
      create: { paths: [...(input.create?.paths ?? [])], directories: [...(input.create?.directories ?? [])], extensions: [...(input.create?.extensions ?? [])] },
      dotfiles: [...(input.dotfiles ?? [])], checks: [...(input.checks ?? [])], secretExceptions: [...(input.secretExceptions ?? [])]
    };
    const dotfiles = spec.dotfiles.map(p => compileGlob(p));
    const exceptions = new Set<string>();
    for (const entry of spec.secretExceptions) {
      const problem = pathProblem(entry);
      if (problem || hasWildcard(entry)) throw new PolicyError(`secret_exceptions entry "${entry}" must be an exact path${problem ? ` (${problem})` : ''}, not a pattern.`);
      if (!EXAMPLE_SUFFIX.test(fold(entry.split('/').at(-1)!))) throw new PolicyError(`secret_exceptions entry "${entry}" is not a conventional example file (its name must end in .example, .sample, .template, .tmpl or .dist).`);
      const rules = builtinRules(entry);
      if (rules.length !== 1 || rules[0] !== 'secret file name') throw new PolicyError(`secret_exceptions entry "${entry}" lifts no secret file-name denial${rules.length ? ` (it is denied as ${rules.filter(r => r !== 'secret file name').join(', ') || 'a different rule'}, which cannot be lifted)` : ''}.`);
      exceptions.add(fold(entry));
    }
    const policy = new PathPolicy(
      spec as never, (input.protectedPaths ?? []).map(fold),
      spec.read.include.map(p => compileGlob(p)), spec.read.exclude.map(p => compileGlob(p, { fold: true })),
      spec.write.include.map(p => compileGlob(p)), spec.write.exclude.map(p => compileGlob(p, { fold: true })),
      dotfiles, exceptions, new Set(spec.create.paths.map(nfc)), spec.create.directories.map(nfc), new Set(spec.create.extensions.map(fold))
    );
    policy.validate();
    return policy;
  }

  /** Startup checks. Literal paths that can never be exposed are errors: nothing is silently filtered. */
  private validate() {
    const literals = (list: string[], what: string) => {
      for (const p of list) {
        if (hasWildcard(p)) continue;
        const problem = pathProblem(p);
        if (problem) throw new PolicyError(`Policy path "${p}" in ${what} is invalid: ${problem}.`);
        const rules = builtinRules(p).filter(rule => !(rule === 'secret file name' && this.exceptions.has(fold(p))));
        if (rules.length) {
          const hint = rules.includes('secret file name') && EXAMPLE_SUFFIX.test(fold(p.split('/').at(-1)!)) ? ' If it is a conventional example file, list it in secret_exceptions.' : '';
          throw new PolicyError(`Policy path "${p}" in ${what} is denied by built-in rule "${rules[0]}". Remove it from the policy.${hint}`);
        }
        if (this.protectedPath(fold(p))) throw new PolicyError(`Policy path "${p}" in ${what} is a server-owned path (policy file, audit log or state) and can never be exposed. Remove it from the policy.`);
        if (p.split('/').some(s => s.startsWith('.')) && !this.dotfiles.some(g => g.matches(p))) throw new PolicyError(`Policy path "${p}" in ${what} has a dot-leading segment that no dotfiles entry covers. Remove it or add a dotfiles entry.`);
      }
    };
    literals(this.spec.read.include, 'read.include');
    literals(this.spec.write.include, 'write.include');
    literals(this.spec.create.paths, 'create.paths');
    literals(this.spec.checks, 'checks');
    if (this.spec.create.directories.length && !this.spec.create.extensions.length) throw new PolicyError('create.directories needs create.extensions: list the file extensions that may be created there.');
    for (const dir of this.spec.create.directories) {
      if (hasWildcard(dir)) throw new PolicyError(`create.directories entry "${dir}" must be an exact directory path, not a pattern.`);
      const problem = pathProblem(dir);
      if (problem) throw new PolicyError(`create.directories entry "${dir}" is invalid: ${problem}.`);
      const rules = builtinRules(dir);
      if (rules.length) throw new PolicyError(`create.directories entry "${dir}" is denied by built-in rule "${rules[0]}" (.git internals and secrets are never creatable).`);
      if (this.protectedPath(fold(dir))) throw new PolicyError(`create.directories entry "${dir}" is a server-owned path and can never be a creation scope.`);
      if (dir.split('/').some(s => s.startsWith('.')) && !this.dotfiles.some(g => g.couldMatchBeneath(dir))) throw new PolicyError(`create.directories entry "${dir}" has a dot-leading segment that no dotfiles entry covers.`);
    }
  }

  /** Literal exact-mode lists (v1 shape); only meaningful when `exact`. */
  get literalPaths() {
    return { files: this.spec.read.include, writes: this.spec.write.include, creatable: this.spec.create.paths, tests: this.spec.checks };
  }
  get createDirectories() { return [...this.createDirs]; }
  get creatablePaths() { return [...this.spec.create.paths]; }
  summary() {
    return {
      read: this.spec.read, write: this.spec.write, create: this.spec.create, dotfiles: this.spec.dotfiles,
      ...(this.spec.secretExceptions.length ? { secret_exceptions: this.spec.secretExceptions } : {})
    };
  }

  private protectedPath(folded: string) { return this.protectedFolded.some(p => prefixes(folded).includes(p)); }
  private excluded(rules: Glob[], path: string) {
    const parts = prefixes(path);
    return rules.some(g => parts.some(prefix => g.matches(prefix)));
  }

  decide(path: string, op: Op): Decision {
    const problem = pathProblem(path);
    if (problem) return { ok: false, reason: `invalid path: ${problem}` };
    const folded = fold(path);
    const rules = builtinRules(path).filter(rule => !(rule === 'secret file name' && this.exceptions.has(folded)));
    if (rules.length) return { ok: false, reason: `built-in denial: ${rules[0]}` };
    if (this.protectedPath(folded)) return { ok: false, reason: 'server-owned path' };
    if (this.excluded(this.readExclude, path)) return { ok: false, reason: 'excluded by read.exclude' };
    if (op !== 'read' && this.excluded(this.writeExclude, path)) return { ok: false, reason: 'excluded by write.exclude' };
    if (path.split('/').some(s => s.startsWith('.')) && !this.dotfiles.some(g => g.matches(path))) return { ok: false, reason: 'dot path not listed in dotfiles' };
    const normal = nfc(path);
    if (!this.readLiterals.has(normal) && !this.readPatterns.some(g => g.matches(path))) return { ok: false, reason: 'not matched by read.include' };
    if (op !== 'read' && !this.writeLiterals.has(normal) && !this.writePatterns.some(g => g.matches(path))) return { ok: false, reason: 'not matched by write.include' };
    return { ok: true };
  }

  /**
   * May discovery enter `dir`? True only if no unconditional denial applies and some permitted
   * descendant is still possible. Necessary conditions only: every file is still checked by decide().
   */
  mayDescend(dir: string): boolean {
    if (pathProblem(dir)) return false;
    const folded = fold(dir);
    const segments = folded.split('/');
    if (segments.some(s => VCS.has(s) || SECRET_DIRS.has(s)) || segments[0] === SERVER_DIR) return false;
    if (this.protectedPath(folded)) return false;
    const parts = prefixes(dir);
    if (this.readExclude.some(g => parts.some(prefix => g.matches(prefix)) || g.coversDirectory(dir))) return false;
    if (dir.split('/').some(s => s.startsWith('.')) && !this.dotfiles.some(g => g.couldMatchBeneath(dir))) return false;
    return this.readInclude.some(g => g.couldMatchBeneath(dir));
  }

  /** Which creation scope, if any, lets `path` be created. Generic denial text reveals nothing about denied paths. */
  createRule(path: string): CreateRule {
    if (!this.decide(path, 'create').ok) return { ok: false, message: NOT_APPROVED };
    const normal = nfc(path);
    if (this.createPaths.has(normal)) return { ok: true, dir: null };
    const dir = [...this.createDirs].sort((a, b) => b.length - a.length).find(d => normal.startsWith(`${d}/`));
    if (!dir) return { ok: false, message: NOT_APPROVED };
    const rest = normal.slice(dir.length + 1).split('/');
    const base = rest.at(-1)!;
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || !this.extensions.has(fold(base.slice(dot)))) return { ok: false, message: `Creation scope ${dir}: extension not allowed (allowed: ${this.spec.create.extensions.join(', ')}).` };
    if (rest.length > MAX_CREATE_DEPTH) return { ok: false, message: `Creation scope ${dir}: depth exceeded (at most ${MAX_CREATE_DEPTH} path segments below the scope).` };
    return { ok: true, dir };
  }
}
