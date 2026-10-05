import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PathPolicy, type PathPolicySpec } from '../src/path-policy.js';
import { loadPolicy, compilePolicy, runtimePolicy, migrateV1 } from '../src/policy.js';
import { defaultPolicy } from '../src/repo.js';
import { policyDoc } from './helpers.js';

// Milestone 2b: deny precedence, dotfile gate, built-in denials, descent and creation rules.

const policy = (over: Partial<PathPolicySpec> = {}) => PathPolicy.compile({ read: { include: ['**'] }, write: { include: ['**'] }, ...over });
const allowed = (p: PathPolicy, file: string, op: 'read' | 'write' | 'create' = 'read') => p.decide(file, op).ok;

test('built-in denials beat includes, dotfiles and wildcards', () => {
  const p = policy({ dotfiles: ['.git/**', '.ssh/**', '.aws/**', '.env', '.env.*', '**/.*'] });
  for (const file of ['.git/config', '.GIT/config', '.git', 'sub/.git/HEAD', '.hg/store', '.svn/entries',
    '.env', '.env.local', '.env.example', 'app/.env', 'keys/server.pem', 'KEYS/Server.PEM', 'a/b.key', 'x.p12', 'x.pfx', 'x.jks', 'x.keystore',
    'id_rsa', 'home/id_rsa.pub', 'id_ed25519', 'id_ecdsa', 'id_dsa', '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.htpasswd',
    'credentials', 'credentials.json', 'cfg/credentials.json', '.ssh/config', '.aws/credentials', '.gnupg/pubring.kbx', '.kube/config', '.docker/config.json',
    '.mcp-abc.tmp', 'src/.mcp-1234.tmp']) {
    for (const op of ['read', 'write', 'create'] as const) assert.equal(allowed(p, file, op), false, `${op} ${file}`);
  }
  for (const file of ['src/a.js', 'docs/environment.md', 'src/keystore.js', 'credentials-helper.js']) assert.equal(allowed(p, file), true, file);
});

test('decomposed and case-variant spellings of denied names are denied', () => {
  const p = policy({ read: { include: ['**'], exclude: ['café/**', 'Secrets'] } });
  assert.equal(allowed(p, 'café/x.js'), false);
  assert.equal(allowed(p, 'CAFÉ/x.js'), false);
  assert.equal(allowed(p, 'secrets/a.txt'), false, 'excludes are prefix-closed and case-folded');
  assert.equal(allowed(p, 'cafe/x.js'), true, 'a different name is untouched');
  const caseSensitive = policy({ read: { include: ['src/A.js'] }, write: { include: [] } });
  assert.equal(allowed(caseSensitive, 'src/A.js'), true);
  assert.equal(allowed(caseSensitive, 'src/a.js'), false, 'allow comparisons never gain access by case');
});

test('dotfile gate: a dot segment needs a matching dotfiles entry', () => {
  const none = policy();
  assert.equal(allowed(none, '.github/workflows/ci.yml'), false);
  assert.equal(allowed(none, '.gitignore'), false);
  const some = policy({ dotfiles: ['.github/**', '.gitignore'] });
  assert.equal(allowed(some, '.github/workflows/ci.yml'), true);
  assert.equal(allowed(some, '.github/workflows/ci.yml', 'write'), true);
  assert.equal(allowed(some, '.gitignore'), true);
  assert.equal(allowed(some, 'src/.hidden/x'), false, 'the entry must match the whole path');
  assert.equal(allowed(some, '.eslintrc'), false);
  assert.equal(allowed(some, '.github/.secret/x'), true, 'inside an allowed pattern, dot segments are covered by it');
});

test('operator excludes win over includes; write needs read; excludes are prefix-closed', () => {
  const p = policy({ read: { include: ['**'], exclude: ['vendor', 'src/*.gen.js'] }, write: { include: ['**'], exclude: ['src/locked.js'] } });
  assert.equal(allowed(p, 'vendor/lib/a.js'), false);
  assert.equal(allowed(p, 'src/a.gen.js'), false);
  assert.equal(allowed(p, 'src/locked.js', 'read'), true);
  assert.equal(allowed(p, 'src/locked.js', 'write'), false);
  assert.equal(allowed(policy({ read: { include: ['src/**'], exclude: [] }, write: { include: ['**'] } }), 'README.md', 'write'), false, 'writable but not readable');
  assert.equal(allowed(policy({ read: { include: ['**'], exclude: ['src/x.js'] }, write: { include: ['**'] } }), 'src/x.js', 'write'), false, 'read.exclude also denies writes');
});

test('policy protects its own file and the server paths it is told about', () => {
  const p = policy({ protectedPaths: ['config/policy.json', 'logs'] });
  assert.equal(allowed(p, 'config/policy.json'), false);
  assert.equal(allowed(p, 'config/policy.json', 'write'), false);
  assert.equal(allowed(p, 'logs/audit.jsonl'), false, 'protected directories cover their contents');
  assert.equal(allowed(p, 'config/other.json'), true);
});

test('secret_exceptions lift only conventional example files, by exact path', () => {
  const p = policy({ dotfiles: ['.env.example', '.env.local', 'config/.env.sample'], secretExceptions: ['.env.example', 'config/.env.sample'] });
  assert.equal(allowed(p, '.env.example'), true);
  assert.equal(allowed(p, 'config/.env.sample'), true);
  assert.equal(allowed(p, '.env.local'), false, 'real secret names stay denied');
  assert.equal(allowed(p, '.env'), false);
  for (const bad of [['.env.*'], ['.env'], ['src/a.example'], ['.git/config.example'], ['.ssh/id_rsa.example'], ['.mcp-1.tmp']]) {
    assert.throws(() => policy({ dotfiles: ['.env.*'], secretExceptions: bad }), /secret_exceptions/, JSON.stringify(bad));
  }
});

test('literal policy paths that hit a built-in denial fail with a migration error', () => {
  for (const file of ['credentials.json', 'example.pem', 'config/id_rsa', '.env', 'secrets/server.key']) {
    const err = (() => { try { PathPolicy.compile({ read: { include: [file] } }); } catch (e) { return e as Error; } })();
    assert.ok(err, file);
    assert.match(err!.message, /built-in/);
    assert.ok(err!.message.includes(file), file);
    assert.match(err!.message, /Remove it/);
  }
  assert.match((() => { try { PathPolicy.compile({ read: { include: ['.env.example'] }, dotfiles: ['.env.example'] }); } catch (e) { return (e as Error).message; } return ''; })(), /secret_exceptions/);
  assert.doesNotThrow(() => PathPolicy.compile({ read: { include: ['.env.example'] }, dotfiles: ['.env.example'], secretExceptions: ['.env.example'] }));
  assert.doesNotThrow(() => PathPolicy.compile({ read: { include: ['**'] } }), 'patterns never fail for possibly matching a denied path');
});

test('literal paths with syntax problems or an uncovered dot segment fail at startup', () => {
  assert.throws(() => PathPolicy.compile({ read: { include: ['bad\u0007name.txt'] } }), /bad.*name|invalid/i);
  assert.throws(() => PathPolicy.compile({ read: { include: ['.github/workflows/ci.yml'] } }), /dotfiles/);
  assert.doesNotThrow(() => PathPolicy.compile({ read: { include: ['.github/workflows/ci.yml'] }, dotfiles: ['.github/**'] }));
});

test('mayDescend prunes only where no permitted descendant is possible', () => {
  const gh = policy({ dotfiles: ['.github/**'] });
  for (const dir of ['src', '.github', '.github/workflows']) assert.equal(gh.mayDescend(dir), true, dir);
  for (const dir of ['.git', '.git/objects', '.secret', '.ssh', 'sub/.git']) assert.equal(gh.mayDescend(dir), false, dir);
  assert.equal(policy({ dotfiles: ['.ssh/**'] }).mayDescend('.ssh'), false, 'built-in directories stay pruned');
  const nested = policy({ read: { include: ['.github/workflows/ci.yml', 'src/a/b.js'] }, dotfiles: ['.github/workflows/*.yml'] });
  for (const dir of ['.github', '.github/workflows', 'src', 'src/a']) assert.equal(nested.mayDescend(dir), true, dir);
  for (const dir of ['test', '.github/other', 'src/b']) assert.equal(nested.mayDescend(dir), false, dir);
  const ex = policy({ read: { include: ['**'], exclude: ['vendor/**', 'node_modules', 'build/*/x'] } });
  assert.equal(ex.mayDescend('vendor'), false);
  assert.equal(ex.mayDescend('node_modules'), false);
  assert.equal(ex.mayDescend('build'), true, 'build/*/x does not cover the whole directory');
  assert.equal(ex.mayDescend('src'), true);
});

test('scoped creation rules: exact paths, directories, extensions, depth', () => {
  const p = policy({ create: { paths: ['src/new.js'], directories: ['src/features', 'docs'], extensions: ['.js', '.MD'] } });
  assert.deepEqual(p.createRule('src/new.js'), { ok: true, dir: null });
  assert.deepEqual(p.createRule('src/features/a.js'), { ok: true, dir: 'src/features' });
  assert.deepEqual(p.createRule('src/features/a/b/c.js'), { ok: true, dir: 'src/features' });
  assert.deepEqual(p.createRule('docs/guide.md'), { ok: true, dir: 'docs' }, 'extensions compare case-folded');
  const wrongExt = p.createRule('src/features/a.py');
  assert.equal(wrongExt.ok, false); assert.match((wrongExt as { message: string }).message, /extension/);
  const deep = p.createRule(`src/features/${'d/'.repeat(8)}x.js`);
  assert.equal(deep.ok, false); assert.match((deep as { message: string }).message, /depth/);
  assert.equal(p.createRule(`src/features/${'d/'.repeat(7)}x.js`).ok, true, 'depth 8 is allowed');
  for (const outside of ['src/other/a.js', 'README.md', 'src/features']) { const r = p.createRule(outside); assert.equal(r.ok, false, outside); assert.match((r as { message: string }).message, /not approved for creation/); }
  assert.equal(p.createRule('src/features/.env').ok, false);
  assert.equal(p.createRule('src/features/.git/x.js').ok, false);
  const noWrite = PathPolicy.compile({ read: { include: ['**'] }, write: { include: [] }, create: { directories: ['src'], extensions: ['.js'] } });
  assert.equal(noWrite.createRule('src/a.js').ok, false, 'creation needs write access');
});

test('creation scope validation at compile time', () => {
  assert.throws(() => policy({ create: { directories: ['src'], extensions: [] } }), /extensions/);
  assert.throws(() => policy({ create: { directories: ['src/*'], extensions: ['.js'] } }), /directories/);
  assert.throws(() => policy({ create: { directories: ['.git/hooks'], extensions: ['.js'] } }), /\.git|denied|invalid/i);
  assert.throws(() => policy({ create: { paths: ['.env'] } }), /built-in/);
});

test('exact mode is detected, and a digest identifies the policy', () => {
  assert.equal(PathPolicy.compile({ read: { include: ['a.js', 'b/c.js'] }, write: { include: ['a.js'] }, create: { paths: ['a.js'] } }).exact, true);
  assert.equal(PathPolicy.compile({ read: { include: ['src/*.js'] } }).exact, false);
  assert.equal(PathPolicy.compile({ read: { include: ['a.js'] }, create: { directories: ['d'], extensions: ['.js'] } }).exact, false);
  const a = PathPolicy.compile({ read: { include: ['a.js'] } });
  assert.equal(a.digest, PathPolicy.compile({ read: { include: ['a.js'] } }).digest);
  assert.notEqual(a.digest, PathPolicy.compile({ read: { include: ['b.js'] } }).digest);
});

test('v1 exact policies compile to the same exact runtime policy as before', () => {
  const v1 = { files: [...defaultPolicy.files, 'src/new.js'], editable: ['src/clamp.js', 'src/new.js'], creatable: ['src/new.js'], tests: ['test/clamp.test.js'] };
  const compiled = compilePolicy(loadPolicy(v1));
  assert.equal(compiled.paths.exact, true);
  assert.deepEqual(runtimePolicy(loadPolicy(v1)), v1);
  assert.equal(allowedPath(compiled.paths, 'src/clamp.js', 'write'), true);
  assert.equal(allowedPath(compiled.paths, 'README.md', 'write'), false);
  assert.equal(allowedPath(compiled.paths, 'src/new.js', 'create'), true);
  assert.equal(allowedPath(compiled.paths, 'src/other.js', 'read'), false);
  assert.throws(() => runtimePolicy(loadPolicy(policyDoc())), /pattern/i, 'a glob policy has no exact runtime form');
  assert.deepEqual(migrateV1(v1).dotfiles, []);
});
const allowedPath = (p: PathPolicy, file: string, op: 'read' | 'write' | 'create') => p.decide(file, op).ok;

test('v1 policies naming built-in-denied paths are rejected at startup, not filtered', () => {
  for (const file of ['credentials.json', 'example.pem', '.env']) {
    assert.throws(() => compilePolicy(loadPolicy({ files: [...defaultPolicy.files, file], editable: [], tests: [] })), /built-in|dot/i, file);
  }
});

test('policy documents: secret_exceptions is optional and does not change existing digests', async () => {
  const { policyDigest } = await import('../src/policy.js');
  // Golden digests recorded before 2b: task bindings store them, so they must not move.
  assert.equal(policyDigest(loadPolicy(undefined)), '1dcf168464ec2ef4c1dcc8c9f8b3bb3d0b4f037621f6cd96ef935723457282cf');
  assert.equal(policyDigest(loadPolicy({ files: ['a.js', 'b.js'], editable: ['a.js'], tests: [], creatable: ['b.js'] })), '4f14f5408f566cfe6b83d521743efb695937eaaa4575f77251d0edcf38015960');
  const base = policyDoc();
  assert.equal(policyDigest(loadPolicy({ ...base, secret_exceptions: [] })), policyDigest(loadPolicy(base)));
  const withException = loadPolicy({ ...base, dotfiles: ['.env.example'], secret_exceptions: ['.env.example'] });
  assert.notEqual(policyDigest(withException), policyDigest(loadPolicy(base)));
  assert.doesNotThrow(() => compilePolicy(withException));
});
