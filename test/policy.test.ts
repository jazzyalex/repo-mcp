import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPolicy } from '../src/repo.js';
import { loadPolicy, migrateV1, runtimePolicy, compilePolicy, policyDigest, DEFAULT_LIMITS } from '../src/policy.js';

const v1 = {
  files: [...defaultPolicy.files, 'src/new.js'],
  editable: ['src/clamp.js', 'src/new.js'],
  creatable: ['src/new.js'],
  tests: ['test/clamp.test.js'],
  runner: { kind: 'python-pytest' as const, executable: '/usr/bin/python3', dependencies: '/opt/deps' }
};

test('v1 exact-list policy migrates to v2 without widening access', () => {
  const v2 = migrateV1(v1);
  assert.equal(v2.version, 2);
  assert.deepEqual(v2.read, { include: v1.files, exclude: [] });
  assert.deepEqual(v2.write, { include: v1.editable, exclude: [] });
  assert.deepEqual(v2.create, { paths: ['src/new.js'], directories: [], extensions: [] });
  assert.deepEqual(v2.dotfiles, []);
  assert.deepEqual(v2.checks, [{ id: 'test/clamp.test.js', path: 'test/clamp.test.js' }]);
  assert.deepEqual(v2.limits, DEFAULT_LIMITS);
  assert.deepEqual(runtimePolicy(v2), v1);
});

test('loadPolicy accepts v1 and v2 and yields identical runtime policy', () => {
  const fromV1 = loadPolicy(v1);
  const fromV2 = loadPolicy(JSON.parse(JSON.stringify(migrateV1(v1))));
  assert.deepEqual(runtimePolicy(fromV1), runtimePolicy(fromV2));
  assert.equal(policyDigest(fromV1), policyDigest(fromV2));
  assert.deepEqual(runtimePolicy(loadPolicy(undefined)), defaultPolicy);
});

test('v1 without creatable or runner round-trips exactly', () => {
  const plain = { files: ['a.js'], editable: [], tests: [] };
  assert.deepEqual(runtimePolicy(loadPolicy(plain)), plain);
});

test('policy digest changes when access changes', () => {
  const wider = { ...v1, editable: [...v1.editable, 'README.md'] };
  assert.notEqual(policyDigest(loadPolicy(v1)), policyDigest(loadPolicy(wider)));
});

test('deny rules win over includes', () => {
  const v2 = migrateV1(v1);
  v2.read.exclude = ['src/new.js'];
  v2.write.exclude = ['src/clamp.js'];
  const runtime = runtimePolicy(loadPolicy(v2));
  assert.ok(!runtime.files.includes('src/new.js'));
  assert.ok(!runtime.editable.includes('src/clamp.js'));
  assert.ok(!runtime.editable.includes('src/new.js'), 'write access requires read access');
  assert.ok(!(runtime.creatable ?? []).includes('src/new.js'));
});

test('unknown versions, unknown keys and malformed policies fail closed', () => {
  assert.throws(() => loadPolicy({ ...migrateV1(v1), version: 3 }), /version/i);
  assert.throws(() => loadPolicy({ ...migrateV1(v1), surprise: true }), /policy/i);
  assert.throws(() => loadPolicy({ ...v1, surprise: true }), /policy/i);
  assert.throws(() => loadPolicy({ files: 'a.js', editable: [], tests: [] }), /policy/i);
  assert.throws(() => loadPolicy(null), /policy/i);
  assert.throws(() => loadPolicy([]), /policy/i);
});

test('paths are normalized POSIX and never reach .git internals', () => {
  for (const bad of ['../x', '/etc/passwd', 'a//b', './a', 'a/./b', 'a\\b', '.git/config', 'sub/.git/HEAD', '.git', '']) {
    const v2 = migrateV1({ files: [bad], editable: [], tests: [] });
    assert.throws(() => loadPolicy(v2), /path/i, bad);
  }
});

test('globs, creation directories and dotfiles compile; unsupported syntax and named checks are still rejected', () => {
  // Milestone 2b enforces what 2a rejected: *, ?, ** patterns, creation scopes and explicit dotfiles.
  for (const pattern of ['src/*.js', 'src/**', 'a?.js']) {
    const v2 = migrateV1({ files: [pattern], editable: [], tests: [] });
    assert.equal(compilePolicy(loadPolicy(v2)).paths.exact, false, pattern);
    assert.throws(() => runtimePolicy(loadPolicy(v2)), /pattern/i, 'a glob policy has no exact-list form');
  }
  for (const pattern of ['src/[ab].js', 'src/{a,b}.js', '!src/a.js', 'src/a\\b']) {
    const v2 = migrateV1({ files: [pattern], editable: [], tests: [] });
    assert.throws(() => compilePolicy(loadPolicy(v2)), /unsupported pattern syntax|invalid policy path/i, pattern);
  }
  const dirs = migrateV1(v1); dirs.create.directories = ['src']; dirs.create.extensions = ['.js'];
  assert.equal(compilePolicy(loadPolicy(dirs)).paths.exact, false);
  const noExt = migrateV1(v1); noExt.create.directories = ['src'];
  assert.throws(() => compilePolicy(loadPolicy(noExt)), /extensions/i);
  const dots = migrateV1(v1); dots.dotfiles = ['.github/workflows/ci.yml'];
  assert.doesNotThrow(() => compilePolicy(loadPolicy(dots)));
  const named = migrateV1(v1); named.checks = [{ id: 'unit', path: 'test/clamp.test.js' }];
  assert.throws(() => compilePolicy(loadPolicy(named)), /check/i);
  assert.throws(() => runtimePolicy(loadPolicy(named)), /check/i);
});

test('limits are separate settings with spec defaults', () => {
  assert.deepEqual(DEFAULT_LIMITS, {
    page_lines: 200, page_bytes: 32 * 1024, edit_file_bytes: 8 * 1024 * 1024,
    request_body_bytes: 256 * 1024, payload_bytes: 128 * 1024, inventory_paths: 100_000,
    retained_output_bytes: 1024 ** 3, cursor_ttl_hours: 24, job_log_retention_days: 7
  });
  const custom = migrateV1(v1);
  custom.limits = { ...DEFAULT_LIMITS, page_lines: 100 };
  assert.equal(loadPolicy(custom).limits.page_lines, 100);
  assert.throws(() => loadPolicy({ ...custom, limits: { ...DEFAULT_LIMITS, page_lines: 0 } }), /policy/i);
});
