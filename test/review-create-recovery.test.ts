import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, lstat, link, symlink, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { RepoWorkspace, sha256 } from '../src/repo.js';
import { loadPolicy, policyDigest } from '../src/policy.js';
import { TaskContext, type Publication } from '../src/task.js';
import { makeRepo, openGlob, policyDoc, git } from './helpers.js';

// create_file crash recovery (milestone 2b final review). A create publishes by hard-linking a temporary file to its
// target, then unlinks the temporary. A crash between the two leaves the target with two links, which discovery and
// reads refuse, so a retry could not tell "published" from "absent". Publication evidence is recorded before the link.

const CONTENT = 'export const created = 1;\n';
const FILE = 'src/new.js';
const BASE = ['AGENTS.md', 'src/clamp.js', 'test/clamp.test.js'];
const docs = {
  glob: policyDoc({ write: { include: ['src/**'], exclude: [] }, create: { paths: [], directories: ['src'], extensions: ['.js'] } }),
  exact: policyDoc({ read: { include: [...BASE, FILE], exclude: [] }, write: { include: ['src/clamp.js', FILE], exclude: [] }, create: { paths: [FILE], directories: [], extensions: [] } })
};
type Mode = keyof typeof docs;
type Fixture = Awaited<ReturnType<typeof fixture>>;
const taskOptions = (m: Fixture, doc: Record<string, unknown>, taskId: string) => ({ task: { stateDir: path.join(m.base, 'state'), taskId, policyDigest: policyDigest(loadPolicy(doc)), recoverStaleLock: true } });
const open = (m: Fixture, mode: Mode, taskId = 'rec') => openGlob(m.t, m.root, docs[mode], taskOptions(m, docs[mode], taskId), m.track);
const tempsIn = async (root: string, dir = 'src') => (await readdir(path.join(root, dir))).filter(n => /^\.mcp-.*\.tmp$/.test(n));
const links = async (file: string) => (await lstat(file)).nlink;
const TSX = path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
const CHILD = path.join(process.cwd(), 'test/support/crash-create-child.ts');

async function fixture(t: Parameters<typeof makeRepo>[0]) {
  const m = await makeRepo(t);
  return { ...m, t };
}

/** Run one create in a child process that SIGKILLs itself at `crashAt`. */
async function crash(m: Fixture, mode: Mode, crashAt: string, requestId = 'req-crash', taskId = 'rec') {
  const payload = JSON.stringify({ root: m.root, stateDir: path.join(m.base, 'state'), taskId, doc: docs[mode], crashAt, path: FILE, content: CONTENT, requestId });
  const outcome = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [TSX, CHILD, payload], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal: signal ?? (code ? stderr.slice(0, 400) : null) }));
  });
  // The tsx launcher relays the child's SIGKILL as exit status 137.
  assert.ok(outcome.signal === 'SIGKILL' || outcome.code === 137, `the child was killed at ${crashAt}, not finished (${JSON.stringify(outcome)})`);
}

// --- real crashes ---------------------------------------------------------------------------------------------

for (const mode of ['glob', 'exact'] as const) {
  test(`${mode}: a crash after the link and before the temporary is removed is recovered and the retry is already_applied`, async t => {
    const m = await fixture(t);
    await crash(m, mode, 'create:after-link');
    assert.equal(await links(path.join(m.root, FILE)), 2, 'the crash left the target with two links');
    assert.equal((await tempsIn(m.root)).length, 1);
    const repo = await open(m, mode);   // exact mode must start although the target is hard linked
    const again = await repo.createFile(FILE, CONTENT, 'req-crash');
    assert.equal(again.already_applied, true);
    assert.equal(again.after_sha256, sha256(CONTENT));
    assert.equal(await links(path.join(m.root, FILE)), 1, 'only the recorded temporary link was removed');
    assert.deepEqual(await tempsIn(m.root), []);
    assert.equal((await repo.read(FILE)).content, CONTENT);
    assert.ok((await repo.listFiles('src/')).files.some(f => f.path === FILE));
    assert.equal((await repo.createFile(FILE, CONTENT, 'req-crash')).already_applied, true, 'and again');
    let diff = '', page = await repo.diff();
    for (;;) { diff += page.diff; if (!page.next_cursor) break; page = await repo.diff('', page.next_cursor); }
    assert.match(diff, /\+export const created = 1;/);
  });

  test(`${mode}: a crash after the temporary was recorded and before the link is cleaned up and the retry applies once`, async t => {
    const m = await fixture(t);
    await crash(m, mode, 'create:before-link');
    await assert.rejects(lstat(path.join(m.root, FILE)), /ENOENT/);
    assert.equal((await tempsIn(m.root)).length, 1);
    const repo = await open(m, mode);
    const made = await repo.createFile(FILE, CONTENT, 'req-crash');
    assert.equal(made.already_applied, undefined, 'nothing was published, so the retry really creates the file');
    assert.deepEqual(await tempsIn(m.root), [], 'the recorded temporary was removed');
    assert.equal(await links(path.join(m.root, FILE)), 1);
    assert.equal((await repo.read(FILE)).content, CONTENT);
    assert.equal((await repo.createFile(FILE, CONTENT, 'req-crash')).already_applied, true);
  });

  test(`${mode}: a crash before the temporary was recorded leaves an unexposed orphan and the retry still applies once`, async t => {
    const m = await fixture(t);
    await crash(m, mode, 'create:after-temp');
    assert.equal((await tempsIn(m.root)).length, 1);
    const repo = await open(m, mode);
    const made = await repo.createFile(FILE, CONTENT, 'req-crash');
    assert.equal(made.already_applied, undefined);
    assert.equal((await repo.read(FILE)).content, CONTENT);
    // The unrecorded orphan is never exposed and never removed by name (documented limitation).
    const orphan = (await tempsIn(m.root))[0];
    assert.ok(orphan, 'cleanup of unrecorded temporaries is left to the operator');
    await assert.rejects(repo.read(`src/${orphan}`), /not exposed/);
    assert.ok(!(await repo.listFiles()).files.some(f => f.path.includes('.mcp-')));
  });
}

// --- crafted persisted states ---------------------------------------------------------------------------------

/** The state a crash after the link leaves: intent, publication evidence, a temporary and a hard-linked target. */
async function craft(m: Fixture, repo: RepoWorkspace, requestId: string, options: { linkTarget?: boolean; record?: boolean; tempName?: string } = {}) {
  const task = (repo as unknown as { task: TaskContext }).task;
  const tempName = options.tempName ?? `.mcp-${randomUUID()}.tmp`;
  const temp = path.join(m.root, 'src', tempName);
  await writeFile(temp, CONTENT);
  if (options.linkTarget !== false) await link(temp, path.join(m.root, FILE));
  const stat = await lstat(temp, { bigint: true });
  await task.recordIntent(requestId, TaskContext.argsDigest('create_file', [FILE, CONTENT]), 'create_file', FILE, null, sha256(CONTENT));
  const publication: Publication = { target: FILE, temp: `src/${tempName}`, dev: String(stat.dev), ino: String(stat.ino) };
  if (options.record !== false) await task.recordPublication(requestId, publication);
  return { task, temp, tempName, publication };
}

test('recovery needs the recorded identity: a replaced temporary is never removed and the retry reports an uncertain outcome', async t => {
  const m = await fixture(t);
  const repo = await open(m, 'glob');
  const { temp } = await craft(m, repo, 'req-replaced');
  await rm(temp);
  await writeFile(temp, 'someone else\n');                       // same name, different file
  for (let i = 0; i < 2; i++) await assert.rejects(repo.createFile(FILE, CONTENT, 'req-replaced'), /uncertain|do not replay/i);
  assert.equal(await readFile(temp, 'utf8'), 'someone else\n', 'the replaced file was not removed');
  assert.equal(await readFile(path.join(m.root, FILE), 'utf8'), CONTENT, 'the target is untouched and nothing was written twice');
});

test('recovery refuses extra hard links, forged evidence and symlinked temporaries without removing anything', async t => {
  const m = await fixture(t);
  const repo = await open(m, 'glob');
  const outside = path.join(m.base, 'outside.txt');
  await writeFile(outside, 'OUTSIDE\n');
  // 1. A third link that the server did not create.
  const a = await craft(m, repo, 'req-extra');
  await link(path.join(m.root, FILE), path.join(m.root, 'src/extra-link.js'));
  await assert.rejects(repo.createFile(FILE, CONTENT, 'req-extra'), /uncertain|do not replay/i);
  assert.equal(await links(a.temp), 3);
  await rm(path.join(m.root, 'src/extra-link.js')); await rm(a.temp); await rm(path.join(m.root, FILE));
  // 2. Evidence that names the wrong place: another directory, an ordinary file, a symlink.
  const clamp = await readFile(path.join(m.root, 'src/clamp.js'), 'utf8');
  const forged: Publication[] = [
    { target: FILE, temp: 'src/clamp.js', dev: '1', ino: '1' },
    { target: FILE, temp: `test/.mcp-${randomUUID()}.tmp`, dev: '1', ino: '1' },
    { target: FILE, temp: '../escape.tmp', dev: '1', ino: '1' }
  ];
  for (const [i, publication] of forged.entries()) {
    const id = `req-forged-${i}`;
    const task = (repo as unknown as { task: TaskContext }).task;
    await task.recordIntent(id, TaskContext.argsDigest('create_file', [FILE, CONTENT]), 'create_file', FILE, null, sha256(CONTENT));
    await task.recordPublication(id, publication);
    await assert.rejects(repo.createFile(FILE, CONTENT, id), /uncertain|malformed|do not replay/i, JSON.stringify(publication));
  }
  assert.equal(await readFile(path.join(m.root, 'src/clamp.js'), 'utf8'), clamp);
  // 3. A symlink where the recorded temporary was.
  const tempName = `.mcp-${randomUUID()}.tmp`;
  await symlink(outside, path.join(m.root, 'src', tempName));
  const task = (repo as unknown as { task: TaskContext }).task;
  await task.recordIntent('req-symlink', TaskContext.argsDigest('create_file', [FILE, CONTENT]), 'create_file', FILE, null, sha256(CONTENT));
  await task.recordPublication('req-symlink', { target: FILE, temp: `src/${tempName}`, dev: '1', ino: '1' });
  await assert.rejects(repo.createFile(FILE, CONTENT, 'req-symlink'), /uncertain|symlink|do not replay/i);
  assert.ok((await lstat(path.join(m.root, 'src', tempName))).isSymbolicLink(), 'the symlink was not touched');
  assert.equal(await readFile(outside, 'utf8'), 'OUTSIDE\n');
});

test('an existing target that reads refuse is never treated as absent: the retry is uncertain, not a replay or a recorded failure', async t => {
  const m = await fixture(t);
  const repo = await open(m, 'glob');
  const outside = path.join(m.base, 'outside.txt');
  await writeFile(outside, 'OUTSIDE\n');
  const task = (repo as unknown as { task: TaskContext }).task;
  for (const [id, make] of [['req-hard', () => link(outside, path.join(m.root, FILE))], ['req-sym', () => symlink(outside, path.join(m.root, FILE))]] as const) {
    await rm(path.join(m.root, FILE), { force: true });
    await make();
    await task.recordIntent(id, TaskContext.argsDigest('create_file', [FILE, CONTENT]), 'create_file', FILE, null, sha256(CONTENT));
    for (let i = 0; i < 2; i++) {
      const error = await repo.createFile(FILE, CONTENT, id).then(() => undefined, e => e as Error);
      assert.ok(error, id);
      assert.doesNotMatch(error!.message, /previously failed|Path already exists/, `${id}: not a replay and not a recorded failure`);
      assert.match(error!.message, /cannot be verified|uncertain|do not replay/i, id);
    }
    assert.equal(await readFile(outside, 'utf8'), 'OUTSIDE\n');
  }
});

test('an old outcome without publication evidence is never cleaned up: a hard-linked target stays and the retry is uncertain', async t => {
  const m = await fixture(t);
  const repo = await open(m, 'glob');
  const { temp } = await craft(m, repo, 'req-old', { record: false });
  await assert.rejects(repo.createFile(FILE, CONTENT, 'req-old'), /cannot be verified|uncertain|do not replay/i);
  assert.equal(await links(temp), 2, 'nothing was removed without evidence');
});

test('unrelated .mcp temporaries survive startup recovery and retries', async t => {
  const m = await fixture(t);
  const repo = await open(m, 'glob');
  const stranger = path.join(m.root, 'src', `.mcp-${randomUUID()}.tmp`);
  await writeFile(stranger, 'not ours\n');
  const { temp } = await craft(m, repo, 'req-own');
  await repo.close();
  const again = await open(m, 'glob');
  assert.equal((await again.createFile(FILE, CONTENT, 'req-own')).already_applied, true);
  assert.equal(await readFile(stranger, 'utf8'), 'not ours\n');
  await assert.rejects(lstat(temp), /ENOENT/, 'only the recorded temporary was removed');
});

test('exact startup with unrecoverable evidence fails closed on the hard link and removes nothing', async t => {
  const m = await fixture(t);
  const repo = await open(m, 'exact');
  const { temp } = await craft(m, repo, 'req-exact-bad');
  const extra = path.join(m.root, 'src/extra-link.js');
  await link(path.join(m.root, FILE), extra);                 // a link the server did not record
  await repo.close();
  await assert.rejects(open(m, 'exact'), /hard link/i);
  assert.equal(await links(temp), 3, 'nothing was removed');
  assert.equal(await readFile(path.join(m.root, FILE), 'utf8'), CONTENT);
  // A replaced temporary, with the target left at one link, starts normally and the retry reports it as uncertain.
  await rm(extra); await rm(temp);
  await writeFile(temp, 'someone else\n');
  const again = await open(m, 'exact');
  await assert.rejects(again.createFile(FILE, CONTENT, 'req-exact-bad'), /uncertain|do not replay/i);
  assert.equal(await readFile(temp, 'utf8'), 'someone else\n');
});

test('completed outcomes keep their meaning: replay is already_applied, a later change is never replayed', async t => {
  const m = await fixture(t);
  const repo = await open(m, 'glob');
  const made = await repo.createFile(FILE, CONTENT, 'req-done');
  assert.equal(made.already_applied, undefined);
  assert.equal((await repo.createFile(FILE, CONTENT, 'req-done')).already_applied, true);
  await writeFile(path.join(m.root, FILE), 'changed later\n');
  await assert.rejects(repo.createFile(FILE, CONTENT, 'req-done'), /changed since|do not replay/i);
  assert.equal(await readFile(path.join(m.root, FILE), 'utf8'), 'changed later\n');
  await mkdir(path.join(m.root, 'src/sub'), { recursive: true });
  assert.ok(await git(m.root, 'status', '--short'));
});
