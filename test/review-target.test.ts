import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compilePolicyFor, DEFAULT_LIMITS, loadPolicy } from '../src/policy.js';
import { computeTargetFingerprintV1 } from '../src/review-target.js';
import { sha256 } from '../src/errors.js';
import { git, makeRepo, policyDoc } from './helpers.js';

/**
 * Stage 2.1 public API contract for the future src/review-target.ts:
 *
 * computeTargetFingerprintV1({
 *   root,
 *   pathPolicy,          // existing compiled PathPolicy; no parallel policy engine
 *   limits,              // existing policy Limits; no raised caps
 *   deniedMetadataKey,   // owner-only key for domain-separated opaque denied metadata
 *   operationBudgetMs?   // optional bounded operation-budget override
 * }) -> {
 *   fingerprint: lowercase SHA-256 hex,
 *   assurance: 'phase_only',
 *   branch: string | null,
 *   head: Git commit id
 * }
 *
 * base_ref/resolved base, scope/prefix, prompt and participant identity are deliberately
 * absent from the API. Unsafe/incomplete capture fails with code
 * TARGET_FINGERPRINT_UNAVAILABLE; no partial fingerprint or denied path detail is returned.
 */

const OWNER_KEY = Buffer.alloc(32, 0x41);
const OTHER_OWNER_KEY = Buffer.alloc(32, 0x42);
const RESULT_KEYS = ['assurance', 'branch', 'fingerprint', 'head'];

async function target(
  root: string,
  doc: Record<string, unknown> = policyDoc(),
  deniedMetadataKey: Uint8Array = OWNER_KEY,
  operationBudgetMs?: number
) {
  const policy = loadPolicy(doc);
  const compiled = await compilePolicyFor(policy, { root });
  const result = await computeTargetFingerprintV1({
    root,
    pathPolicy: compiled.paths,
    limits: policy.limits,
    deniedMetadataKey,
    operationBudgetMs
  });
  assert.deepEqual(Object.keys(result).sort(), RESULT_KEYS);
  assert.equal(result.assurance, 'phase_only');
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(result.branch === null || typeof result.branch === 'string');
  assert.match(result.head, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
  return result;
}

async function expectUnavailable(run: Promise<unknown>, forbiddenDetail?: string) {
  await assert.rejects(run, error => {
    assert.equal((error as { code?: unknown }).code, 'TARGET_FINGERPRINT_UNAVAILABLE');
    if (forbiddenDetail) assert.ok(!String((error as Error).message).includes(forbiddenDetail));
    return true;
  });
}

async function indexIdentity(root: string, file: string) {
  return {
    head: (await git(root, 'rev-parse', 'HEAD')).trim(),
    entry: await git(root, 'ls-files', '--stage', '-v', '--', file)
  };
}

test('TargetFingerprintV1 is target-only across different base, scope and prompt choices', async t => {
  const m = await makeRepo(t, { 'src/value.txt': 'one\n' });
  const head = (await git(m.root, 'rev-parse', 'HEAD')).trim();
  const parent = (await git(m.root, 'rev-parse', 'HEAD^')).trim();
  assert.notEqual(head, parent);

  const reviewerA = { base: parent, scope: 'src/', prompt: sha256('review A') };
  const reviewerB = { base: head, scope: 'test/', prompt: sha256('review B') };
  assert.notDeepEqual(reviewerA, reviewerB);

  const a = await target(m.root);
  const b = await target(m.root);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.assurance, 'phase_only', 'this is metadata assurance, not immutable content attestation');
});

test('visible worktree bytes and later staging independently change the fingerprint', async t => {
  const m = await makeRepo(t, { 'src/value.txt': 'one\n' });
  const clean = await target(m.root);

  await writeFile(path.join(m.root, 'src/value.txt'), 'two\n');
  const worktree = await target(m.root);
  assert.notEqual(worktree.fingerprint, clean.fingerprint);

  await git(m.root, 'add', '--', 'src/value.txt');
  const staged = await target(m.root);
  assert.notEqual(staged.fingerprint, worktree.fingerprint, 'index identity changes even though worktree bytes did not');
});

test('readable untracked bytes are content-bound', async t => {
  const m = await makeRepo(t, { 'src/tracked.txt': 'tracked\n' }, { 'src/new.txt': 'first\n' });
  const first = await target(m.root);
  await writeFile(path.join(m.root, 'src/new.txt'), 'second and different\n');
  const second = await target(m.root);
  assert.notEqual(second.fingerprint, first.fingerprint);
});

test('readable ignored untracked files remain content-bound', async t => {
  const m = await makeRepo(t, { '.gitignore': 'ignored.txt\n', 'src/tracked.txt': 'tracked\n' });
  await writeFile(path.join(m.root, 'ignored.txt'), 'ignored one\n');
  assert.equal((await git(m.root, 'status', '--short', '--', 'ignored.txt')).trim(), '');

  const first = await target(m.root);
  await writeFile(path.join(m.root, 'ignored.txt'), 'ignored two\n');
  const second = await target(m.root);
  assert.notEqual(second.fingerprint, first.fingerprint);
});

test('branch, HEAD and executable-mode identity change the fingerprint', async t => {
  const m = await makeRepo(t, { 'src/tool.sh': '#!/bin/sh\necho one\n' });
  await git(m.root, 'config', 'core.filemode', 'true');

  const original = await target(m.root);
  await git(m.root, 'switch', '-c', 'review-target-alt');
  const branched = await target(m.root);
  assert.equal(branched.head, original.head, 'branch changed without moving HEAD');
  assert.notEqual(branched.branch, original.branch);
  assert.notEqual(branched.fingerprint, original.fingerprint);

  await writeFile(path.join(m.root, 'src/tool.sh'), '#!/bin/sh\necho two\n');
  await git(m.root, 'add', '--', 'src/tool.sh');
  await git(m.root, 'commit', '-m', 'move target head');
  const movedHead = await target(m.root);
  assert.notEqual(movedHead.head, branched.head);
  assert.notEqual(movedHead.fingerprint, branched.fingerprint);

  const beforeMode = movedHead;
  await chmod(path.join(m.root, 'src/tool.sh'), 0o755);
  assert.match(await git(m.root, 'diff', '--summary', '--', 'src/tool.sh'), /mode change/i);
  const modeChanged = await target(m.root);
  assert.notEqual(modeChanged.fingerprint, beforeMode.fingerprint);
});

test('tracked metadata catches mode drift even when core.filemode=false hides it from Git diff', async t => {
  const file = 'src/tool.sh';
  const m = await makeRepo(t, { [file]: '#!/bin/sh\necho one\n' });
  await git(m.root, 'config', 'core.filemode', 'false');

  const before = await target(m.root);
  await chmod(path.join(m.root, file), 0o755);
  assert.equal((await git(m.root, 'diff', '--summary', '--', file)).trim(), '');
  const after = await target(m.root);
  assert.notEqual(after.fingerprint, before.fingerprint);
});

test('assume-unchanged and skip-worktree entries independently bind hidden worktree bytes and missing state', async t => {
  for (const item of [
    { name: 'assume-unchanged', flag: '--assume-unchanged' },
    { name: 'skip-worktree', flag: '--skip-worktree' }
  ]) {
    await t.test(item.name, async st => {
      const file = 'src/flagged.txt';
      const m = await makeRepo(st, { [file]: 'original\n' });
      await git(m.root, 'update-index', item.flag, '--', file);

      const baselineIndex = await indexIdentity(m.root, file);
      const baseline = await target(m.root);

      await writeFile(path.join(m.root, file), 'hidden worktree bytes\n');
      assert.equal(
        await git(m.root, 'status', '--short', '--untracked-files=all', '--', file),
        '',
        'Git status itself suppresses the flagged worktree change'
      );
      const changed = await target(m.root);
      assert.notEqual(changed.fingerprint, baseline.fingerprint);
      assert.deepEqual(await indexIdentity(m.root, file), baselineIndex, 'HEAD/index/flags stayed unchanged');

      await rm(path.join(m.root, file));
      const missing = await target(m.root);
      assert.notEqual(missing.fingerprint, baseline.fingerprint);
      assert.notEqual(missing.fingerprint, changed.fingerprint);
      assert.deepEqual(await indexIdentity(m.root, file), baselineIndex, 'missing state must not require index mutation');
    });
  }
});

test('unsafe, unreadable and over-cap flagged worktree states fail closed', async t => {
  await t.test('symlink', async st => {
    const file = 'src/flagged.txt';
    const m = await makeRepo(st, { [file]: 'original\n' });
    await git(m.root, 'update-index', '--skip-worktree', '--', file);
    const outside = path.join(m.base, 'outside.txt');
    await writeFile(outside, 'outside\n');
    await rm(path.join(m.root, file));
    await symlink(outside, path.join(m.root, file));
    await expectUnavailable(target(m.root));
  });

  await t.test('unreadable', async st => {
    const file = 'src/flagged.txt';
    const m = await makeRepo(st, { [file]: 'original\n' });
    await git(m.root, 'update-index', '--assume-unchanged', '--', file);
    await chmod(path.join(m.root, file), 0o000);
    await expectUnavailable(target(m.root));
  });

  await t.test('over-cap', async st => {
    const file = 'src/flagged.txt';
    const m = await makeRepo(st, { [file]: 'small\n' });
    await git(m.root, 'update-index', '--skip-worktree', '--', file);
    await writeFile(path.join(m.root, file), 'x'.repeat(65));
    const doc = policyDoc({ limits: { ...DEFAULT_LIMITS, edit_file_bytes: 64 } });
    await expectUnavailable(target(m.root, doc));
  });
});

test('unchanged tracked symlinks are fingerprinted without following and link replacement changes the target', async t => {
  const m = await makeRepo(t, {
    'src/target-a.txt': 'A\n',
    'src/target-b.txt': 'B\n'
  });
  const link = path.join(m.root, 'src/link.txt');
  await symlink('target-a.txt', link);
  await git(m.root, 'add', '--', 'src/link.txt');
  await git(m.root, 'commit', '-m', 'tracked symlink');

  const unchanged = await target(m.root);
  assert.match(unchanged.fingerprint, /^[a-f0-9]{64}$/);

  await rm(link);
  await symlink('target-b.txt', link);
  const changed = await target(m.root);
  assert.notEqual(changed.fingerprint, unchanged.fingerprint, 'link text replacement must invalidate the working target');

  await rm(link);
  await symlink('target-a.txt', link);
  const restored = await target(m.root);
  assert.notEqual(restored.fingerprint, changed.fingerprint);
});

test('untracked symlinks still make the working target unavailable', async t => {
  const m = await makeRepo(t, { 'src/target.txt': 'target\n' });
  await symlink('target.txt', path.join(m.root, 'src/untracked-link.txt'));
  await expectUnavailable(target(m.root));
});

test('policy-denied content is never opened or returned; denied metadata stays opaque and owner-keyed', async t => {
  const hidden = 'secret/hidden.txt';
  const m = await makeRepo(t, {
    'src/visible.txt': 'visible\n',
    [hidden]: 'SECRET-ONE\n'
  });
  const doc = policyDoc({ read: { include: ['**'], exclude: ['secret/**'] } });

  const before = await target(m.root, doc, OWNER_KEY);
  await writeFile(path.join(m.root, hidden), 'SECRET-TWO-IS-LONGER\n');
  await chmod(path.join(m.root, hidden), 0o000);

  const after = await target(m.root, doc, OWNER_KEY);
  assert.notEqual(after.fingerprint, before.fingerprint, 'detectable denied status metadata must split the target');
  const otherOwner = await target(m.root, doc, OTHER_OWNER_KEY);
  assert.notEqual(otherOwner.fingerprint, after.fingerprint, 'denied metadata token is owner-keyed');

  for (const result of [before, after, otherOwner]) {
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(hidden));
    assert.ok(!serialized.includes('SECRET-ONE'));
    assert.ok(!serialized.includes('SECRET-TWO'));
  }
});

test('unchanged ordinary tracked bytes do not require content attestation', async t => {
  const file = 'src/large-clean.txt';
  const m = await makeRepo(t, { [file]: 'x'.repeat(65) });
  const doc = policyDoc({ limits: { ...DEFAULT_LIMITS, edit_file_bytes: 64 } });

  const clean = await target(m.root, doc);
  assert.match(clean.fingerprint, /^[a-f0-9]{64}$/);

  await writeFile(path.join(m.root, file), 'y'.repeat(65));
  await expectUnavailable(target(m.root, doc));
});

test('bounded Git capture failure returns TARGET_FINGERPRINT_UNAVAILABLE, never a partial target', async t => {
  const m = await makeRepo(t, { 'src/tracked.txt': 'tracked\n' });
  const noisy = Object.fromEntries(
    Array.from({ length: 24 }, (_, i) => [
      `src/untracked-${String(i).padStart(2, '0')}-${'n'.repeat(24)}.txt`,
      `value ${i}\n`
    ])
  );
  await m.write(noisy);
  const doc = policyDoc({
    limits: { ...DEFAULT_LIMITS, retained_output_bytes: 128 }
  });
  await expectUnavailable(target(m.root, doc));
});

test('zero operation budget fails closed without a partial fingerprint', async t => {
  const m = await makeRepo(t, { 'src/value.txt': 'one\n' });
  await expectUnavailable(target(m.root, policyDoc(), OWNER_KEY, 0));
});

test('repeat and restart-style recomputation derive current state instead of trusting a saved fingerprint', async t => {
  const m = await makeRepo(t, { 'src/value.txt': 'one\n' });

  const first = await target(m.root);
  const saved = first.fingerprint;
  const recomputedWithFreshPolicy = await target(m.root, policyDoc(), OWNER_KEY);
  assert.equal(recomputedWithFreshPolicy.fingerprint, saved);

  await writeFile(path.join(m.root, 'src/value.txt'), 'two\n');
  const afterRestart = await target(m.root, policyDoc(), OWNER_KEY);
  assert.notEqual(afterRestart.fingerprint, saved, 'recomputation must not accept a persisted fingerprint as current');
});
