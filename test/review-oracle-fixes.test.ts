import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, mkdtemp, rm, chmod, lstat, realpath, stat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startServer } from '../src/server.js';
import { prepareFixture } from '../src/fixture.js';
import { PathPolicy, type PathPolicySpec } from '../src/path-policy.js';
import { RepoWorkspace, sha256, type RepoPolicy } from '../src/repo.js';
import { loadPolicy, policyDigest, runtimePolicy, compilePolicy, compilePolicyFor } from '../src/policy.js';
import { TaskContext } from '../src/task.js';
import { DEFAULT_LIMITS } from '../src/limits.js';
import { makeRepo, openGlob, policyDoc, git } from './helpers.js';

// Oracle review of milestone 2b: .trial boundary, secret templates, Unicode spelling and request replay,
// bounded Git argv, AGENTS.md continuation, tool count docs and permission bits.

const policy = (over: Partial<PathPolicySpec> = {}) => PathPolicy.compile({ read: { include: ['**'] }, write: { include: ['**'] }, ...over });
const allowed = (p: PathPolicy, file: string, op: 'read' | 'write' | 'create' = 'read') => p.decide(file, op).ok;
const compileError = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return ''; };
const writable = (...include: string[]) => policyDoc({ write: { include, exclude: [] } });

async function connect(url: string) {
  const client = new Client({ name: 'oracle-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0].text;
    return r.isError ? { error: text } : { ...JSON.parse(text), __bytes: Buffer.byteLength(text) };
  };
  return { client, call };
}

// --- 1. repo-root .trial is an unconditional server-owned boundary ---------------------------------------------------

test('.trial at the repository root is denied for every operation, whatever dotfiles say', () => {
  const p = policy({ dotfiles: ['**', '.trial/**', '.trial'], create: { directories: ['src'], extensions: ['.js'] } });
  for (const file of ['.trial', '.trial/service.log', '.trial/state/x.json', '.TRIAL/service.log', '.Trial/a.js', '.trial/b.txt']) {
    for (const op of ['read', 'write', 'create'] as const) assert.equal(allowed(p, file, op), false, `${op} ${file}`);
  }
  assert.equal(p.mayDescend('.trial'), false);
  assert.equal(p.mayDescend('.TRIAL'), false);
  assert.equal(p.mayDescend('.trial/state'), false);
  assert.equal(allowed(p, '.github/ci.yml'), true, 'other dot paths follow the dotfiles gate');
  assert.equal(p.createRule('.trial/x.js').ok, false);
});

test('.trial cannot be named by literal policy paths, creation scopes or secret_exceptions', () => {
  for (const spec of [
    { read: { include: ['.trial/service.log'] }, dotfiles: ['.trial/**'] },
    { read: { include: ['**'] }, write: { include: ['.trial/x'] }, dotfiles: ['**'] },
    { read: { include: ['**'] }, create: { paths: ['.trial/new.js'] }, dotfiles: ['**'] },
    { read: { include: ['**'] }, create: { directories: ['.trial'], extensions: ['.js'] }, dotfiles: ['**'] },
    { read: { include: ['**'] }, secretExceptions: ['.trial/x.example'], dotfiles: ['**'] }
  ] as PathPolicySpec[]) assert.ok(compileError(() => PathPolicy.compile(spec)), JSON.stringify(spec));
});

test('a synthetic .trial directory is never listed, read, searched, diffed, edited or created in (glob policy, global dotfiles)', async t => {
  const m = await makeRepo(t, { '.trial/tracked.log': 'TRIAL-TRACKED\n', 'src/ok.js': 'export const ok = 1;\n' }, { '.trial/service.log': 'TRIAL-SECRET-LOG\n' });
  const doc = policyDoc({ read: { include: ['**'], exclude: [] }, write: { include: ['**'], exclude: [] }, dotfiles: ['**'], create: { paths: [], directories: ['src'], extensions: ['.js', '.log'] } });
  const repo = await openGlob(t, m.root, doc, {}, m.track);
  const listed: string[] = [];
  let page = await repo.listFiles();
  for (;;) { listed.push(...page.files.map(f => f.path)); if (!page.next_cursor) break; page = await repo.listFiles('', page.next_cursor); }
  assert.ok(listed.includes('src/ok.js'));
  assert.ok(!listed.some(p => p.toLowerCase().startsWith('.trial')), 'not in the inventory');
  for (const file of ['.trial/service.log', '.TRIAL/service.log', '.trial/tracked.log']) {
    await assert.rejects(repo.read(file), /not exposed/, file);
    await assert.rejects(repo.edit(file, 'a', 'b', '0'.repeat(64)), /not exposed|not editable/, file);
    await assert.rejects(repo.createFile(file.replace('.log', '.js'), 'x\n'), /not approved|not exposed/, file);
  }
  assert.equal((await repo.search('TRIAL-SECRET-LOG')).matches.length, 0);
  assert.equal((await repo.search('TRIAL-TRACKED')).matches.length, 0);
  await writeFile(path.join(m.root, '.trial/tracked.log'), 'TRIAL-TRACKED\nchanged\n');
  await writeFile(path.join(m.root, 'src/ok.js'), 'export const ok = 2;\n');
  let text = '', d = await repo.diff();
  for (;;) { text += d.diff; if (!d.next_cursor) break; d = await repo.diff('', d.next_cursor); }
  assert.match(text, /\+export const ok = 2;/);
  assert.ok(!text.includes('TRIAL-TRACKED') && !text.includes('.trial'), 'the diff names nothing under .trial');
  assert.ok(!(await repo.info()).status.includes('TRIAL-SECRET-LOG'));
});

// --- 2. secret-looking templates ----------------------------------------------------------------------------------

test('secret file names are still denied with a conventional example suffix; harmless templates stay allowed', () => {
  const p = policy({ dotfiles: ['**'] });
  for (const file of ['config.pem.sample', 'server.key.example', 'credentials.json.template', '.npmrc.template', 'keys/x.p12.dist', '.pypirc.tmpl', 'a/id_rsa.example', 'Server.KEY.Example', 'tls.pem.sample.dist', '.netrc.sample', 'credentials.example']) {
    assert.equal(allowed(p, file), false, file);
  }
  for (const file of ['config.sample', 'README.template', 'app.json.example', 'settings.example.js', 'keystore.example', 'src/key.example.md', 'docs/pemfile.sample']) assert.equal(allowed(p, file), true, file);
});

test('a reviewed exception lifts only the exact reviewed template and keeps the dotfile gate', () => {
  const doc = { secretExceptions: ['config.pem.sample', 'conf/.npmrc.template', 'x/credentials.json.template'] };
  const noDot = policy(doc);
  assert.equal(allowed(noDot, 'config.pem.sample'), true);
  assert.equal(allowed(noDot, 'x/credentials.json.template'), true);
  assert.equal(allowed(noDot, 'conf/.npmrc.template'), false, 'dot-leading segment still needs a dotfiles entry');
  const withDot = policy({ ...doc, dotfiles: ['conf/.npmrc.template'] });
  assert.equal(allowed(withDot, 'conf/.npmrc.template'), true);
  for (const other of ['other/config.pem.sample', 'config.pem', 'config.pem.sample.dist', 'config.key.sample', 'conf/.npmrc', 'conf/.npmrc.sample', 'y/credentials.json.template', 'CONFIG.PEM.SAMPLE.dist']) {
    assert.equal(allowed(withDot, other), false, other);
  }
  assert.equal(allowed(withDot, 'CONFIG.PEM.SAMPLE'), true, 'exceptions compare folded, like the denial');
  // Template names that hide no secret name cannot be listed as exceptions; directories and VCS never lift.
  for (const bad of [['README.template'], ['.git/x.pem.sample'], ['.ssh/id_rsa.example'], ['server.pem'], ['*.pem.sample']]) {
    assert.match(compileError(() => policy({ secretExceptions: bad, dotfiles: ['**'] })), /secret_exceptions/, JSON.stringify(bad));
  }
  assert.match(compileError(() => PathPolicy.compile({ read: { include: ['config.pem.sample'] } })), /secret_exceptions/, 'the hint points at the reviewed mechanism');
  assert.doesNotThrow(() => PathPolicy.compile({ read: { include: ['config.pem.sample'] }, secretExceptions: ['config.pem.sample'] }));
});

// --- Unicode fixtures (macOS keeps the spelling it is given and resolves either form) -------------------------------

const NFD_NAME = 'src/café.js';
const NFC_NAME = 'src/café.js';

async function unicodeRepo(t: { after(fn: () => Promise<void>): void; skip(message?: string): void }, mode: 'default' | 'off') {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-uni-')));
  const root = path.join(base, 'repo');
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  await prepareFixture(root);
  if (mode === 'off') await git(root, 'config', 'core.precomposeUnicode', 'false');
  await writeFile(path.join(root, NFD_NAME), 'export const value = 1;\n');
  const insensitive = await stat(path.join(root, NFC_NAME)).then(() => true, () => false);
  if (!insensitive) { t.skip('this volume does not resolve NFC and NFD spellings to one file'); return undefined; }
  await git(root, 'add', '-A');
  await git(root, 'commit', '-m', 'unicode');
  return { base, root };
}
const taskOptions = (base: string, doc: Record<string, unknown>, taskId = 'uni') => ({ task: { stateDir: path.join(base, 'state'), taskId, policyDigest: policyDigest(loadPolicy(doc)) } });

test('request_id replay resolves the disk spelling: NFC tool path, NFD disk name, retry, restart and crash reconciliation', async t => {
  const u = await unicodeRepo(t, 'off');
  if (!u) return;
  const doc = writable('src/**');
  const open = async () => openGlob(t, u.root, doc, taskOptions(u.base, doc));
  let repo = await open();
  assert.ok((await repo.listFiles('src/caf')).files.some(f => f.path === NFD_NAME), 'the listing keeps the disk spelling');
  const before = await repo.read(NFC_NAME);
  const first = await repo.edit(NFC_NAME, 'value = 1', 'value = 2', before.sha256, 'uni-1');
  assert.equal(first.path, NFD_NAME);
  const again = await repo.edit(NFC_NAME, 'value = 1', 'value = 2', before.sha256, 'uni-1');
  assert.equal(again.already_applied, true);
  assert.equal(again.after_sha256, first.after_sha256);
  assert.equal(await readFile(path.join(u.root, NFD_NAME), 'utf8'), 'export const value = 2;\n');
  await repo.close();
  repo = await open();
  const restarted = await repo.edit(NFC_NAME, 'value = 1', 'value = 2', before.sha256, 'uni-1');
  assert.equal(restarted.already_applied, true, 'replay after a restart');
  // Crash after the write, before the completion record: reconciled by hash, through the other spelling too.
  const task = (repo as unknown as { task: TaskContext }).task;
  const next = (await repo.read(NFC_NAME));
  const changed = next.content.replace('value = 2', 'value = 3');
  for (const [id, spelling] of [['uni-crash-nfc', NFC_NAME], ['uni-crash-nfd', NFD_NAME]] as const) {
    const now = await repo.read(spelling);
    const target = now.content.replace(/value = \d/, 'value = 9');
    await task.recordIntent(id, TaskContext.argsDigest('edit', [spelling, 'value', 'value', now.sha256]), 'edit', spelling, now.sha256, sha256(target));
    await writeFile(path.join(u.root, NFD_NAME), target);
    const reconciled = await repo.edit(spelling, 'value', 'value', now.sha256, id);
    assert.equal(reconciled.already_applied, true, id);
    assert.equal(reconciled.after_sha256, sha256(target), id);
    await writeFile(path.join(u.root, NFD_NAME), now.content);
  }
  assert.ok(changed.length > 0);
  // A changed file after completion is never replayed, and nothing is hashed for a path that is not exposed.
  await writeFile(path.join(u.root, NFD_NAME), 'export const value = 7;\n');
  await assert.rejects(repo.edit(NFC_NAME, 'value = 1', 'value = 2', before.sha256, 'uni-1'), /changed since|do not replay/);
});

test('request_id replay for a creation target that is absent still applies once', async t => {
  const m = await makeRepo(t);
  const doc = policyDoc({ write: { include: ['src/**'], exclude: [] }, create: { paths: [], directories: ['src'], extensions: ['.js'] } });
  const repo = await openGlob(t, m.root, doc, taskOptions(m.base, doc, 'create-1'), m.track);
  const made = await repo.createFile('src/new.js', 'export const x = 1;\n', 'create-req');
  assert.equal(made.already_applied, undefined);
  const again = await repo.createFile('src/new.js', 'export const x = 1;\n', 'create-req');
  assert.equal(again.already_applied, true);
});

test('Git name versus disk name: NFD disk file tracked under Git precomposition (default) and with precomposeUnicode=false', async t => {
  for (const mode of ['default', 'off'] as const) {
    const u = await unicodeRepo(t, mode);
    if (!u) return;
    const doc = policyDoc({ write: { include: ['src/**'], exclude: [] }, create: { paths: [], directories: ['src'], extensions: ['.js'] } });
    const repo = await openGlob(t, u.root, doc);
    try {
      assert.ok((await repo.listFiles('src/caf')).files.some(f => f.path === NFD_NAME), `${mode}: the listing keeps the disk spelling`);
      const read = await repo.read(NFC_NAME);
      const edited = await repo.edit(NFC_NAME, 'value = 1', 'value = 2', read.sha256);
      assert.equal(edited.path, NFD_NAME, mode);
      let text = '', d = await repo.diff();
      for (;;) { text += d.diff; if (!d.next_cursor) break; d = await repo.diff('', d.next_cursor); }
      assert.match(text, /\+export const value = 2;/, mode);
      assert.ok(!/^Index: /m.test(text), `${mode}: a tracked file is not also shown as a new file`);
      assert.equal(text, await git(u.root, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', 'HEAD'), `${mode}: the diff is Git's own`);
    } finally { await repo.close(); }
  }
});

test('Git names are matched to disk names only when both spellings are the same file', async t => {
  const u = await unicodeRepo(t, 'off');
  if (!u) return;
  // An unrelated untracked file whose NFC spelling is tracked elsewhere must not be taken for tracked.
  await writeFile(path.join(u.root, 'src/plain.js'), 'export const plain = 1;\n');
  const doc = policyDoc({ write: { include: ['src/**'], exclude: [] } });
  const repo = await openGlob(t, u.root, doc);
  try {
    const read = await repo.read('src/plain.js');
    await assert.rejects(repo.edit('src/plain.js', 'plain = 1', 'plain = 2', read.sha256), /must exist in HEAD/);
  } finally { await repo.close(); }
});

// --- 4. tracking checks run in bounded batches -------------------------------------------------------------------

async function manyTracked(t: Parameters<typeof makeRepo>[0], count = 6000) {
  const dir = `${'p'.repeat(110)}/${'q'.repeat(110)}`;
  const names = Array.from({ length: count }, (_, i) => `${dir}/f${String(i).padStart(5, '0')}.txt`);
  assert.ok(Buffer.byteLength(names[0]) >= 230 && Buffer.byteLength(names[0]) <= 256);
  const m = await makeRepo(t, Object.fromEntries(names.map(n => [n, 'x\n'])));
  const policy: RepoPolicy = { files: ['AGENTS.md', 'src/clamp.js', 'test/clamp.test.js', ...names], editable: ['src/clamp.js', ...names], tests: ['test/clamp.test.js'] };
  return { m, names, policy };
}
const pathspecs = (args: string[]) => args.slice(args.indexOf('--') + 1);

test('tracking validation hands Git bounded batches: exact policy startup and diff with 6000 long tracked paths', async t => {
  const { m, policy: exact } = await manyTracked(t);
  const calls: string[][] = [];
  const repo = m.track(await RepoWorkspace.create(m.root, exact, { gitHook: args => { calls.push(args); } }));
  const tracking = calls.filter(a => a[0] === 'ls-tree' || a[0] === 'ls-files');
  assert.ok(tracking.length >= 2 * 30, `real Git calls: ${tracking.length}`);
  for (const args of tracking) {
    const specs = pathspecs(args);
    assert.ok(specs.length <= 200, `${specs.length} paths in one call`);
    assert.ok(specs.reduce((n, p) => n + Buffer.byteLength(p) + 1, 0) <= 48 * 1024, 'bytes in one call');
  }
  for (const command of ['ls-tree', 'ls-files']) {
    assert.ok(tracking.filter(a => a[0] === command).reduce((n, a) => n + pathspecs(a).length, 0) >= 6001, `${command} covered every editable path`);
  }
  calls.length = 0;
  const page = await repo.diff();
  assert.ok(page.complete);
  for (const args of calls.filter(a => a[0] === 'ls-tree' || a[0] === 'ls-files')) assert.ok(pathspecs(args).length <= 200);
  assert.ok(calls.some(a => a[0] === 'ls-tree'), 'diff validated tracking through the same batches');
});

test('batched tracking checks share one operation budget instead of restarting it per batch', async t => {
  const { m, policy: exact } = await manyTracked(t, 3000);
  let now = 0, calls = 0;
  await assert.rejects(RepoWorkspace.create(m.root, exact, {
    operationBudgetMs: 1000, monotonicClock: () => now,
    gitHook: args => { if (args[0] === 'ls-tree' || args[0] === 'ls-files') { calls++; now += 300; } }
  }), /timed out.*operation budget/i);
  assert.ok(calls <= 5, `Git calls after the budget was spent: ${calls}`);
});

test('single-batch tracking stages share one positive budget: head, index and the final stage are all checked', async t => {
  const m = await makeRepo(t);
  const doc = writable('src/clamp.js');
  // Three Git stages (HEAD, HEAD again for the index rule, index) of one batch each; every Git call "takes" 600 ms.
  let now = 0, calls = 0;
  await assert.rejects(openGlob(t, m.root, doc, { operationBudgetMs: 1000, monotonicClock: () => now, gitHook: () => { calls++; now += 600; } }), /timed out.*1000 ms operation budget/i);
  assert.ok(calls <= 2, `Git stages started after the budget was spent: ${calls}`);
  // The same stages inside the budget are accepted.
  now = 0; calls = 0;
  const ok = await openGlob(t, m.root, doc, { operationBudgetMs: 1000, monotonicClock: () => now, gitHook: () => { calls++; now += 100; } }, m.track);
  assert.equal(calls, 3);
  assert.ok(ok);
});

test('each tracking Git call gets the time that is left, not a fresh 10 seconds', async t => {
  const m = await makeRepo(t);
  const doc = writable('src/clamp.js');
  let now = 0;
  const timeouts: (number | undefined)[] = [];
  await assert.rejects(openGlob(t, m.root, doc, { operationBudgetMs: 1000, monotonicClock: () => now, gitHook: (_args, timeout) => { timeouts.push(timeout); now += 600; } }), /timed out/i);
  assert.deepEqual(timeouts, [1000, 400]);
  // A call that began with time left is also checked after it ran: the last stage cannot slip through.
  now = 0;
  const seen: string[] = [];
  await assert.rejects(openGlob(t, m.root, doc, { operationBudgetMs: 1000, monotonicClock: () => now, gitHook: args => { seen.push(args[0]); now += 1500; } }), /timed out/i);
  assert.deepEqual(seen, ['ls-tree'], 'nothing starts after the budget ran out');
});

test('a zero budget keeps its meaning at runtime while startup validation has its own allowance', async t => {
  const m = await makeRepo(t);
  const exact: RepoPolicy = { files: ['AGENTS.md', 'src/clamp.js', 'test/clamp.test.js'], editable: ['src/clamp.js'], tests: ['test/clamp.test.js'] };
  // Startup is not made impossible by operationBudgetMs: 0 (legacy compatibility) ...
  const repo = m.track(await RepoWorkspace.create(m.root, exact, { operationBudgetMs: 0 }));
  // ... but runtime tracking checks and captures still honour it.
  const read = await repo.read('src/clamp.js');
  await assert.rejects(repo.edit('src/clamp.js', 'max - 1', 'max', read.sha256), /timed out.*operation budget/i);
  assert.equal((await repo.read('src/clamp.js')).sha256, read.sha256, 'nothing was written');
  await assert.rejects(repo.diff(), /timed out.*operation budget/i);
  // A positive budget at startup is enforced, not replaced by the allowance.
  let now = 0;
  await assert.rejects(RepoWorkspace.create(m.root, exact, { operationBudgetMs: 500, monotonicClock: () => now, gitHook: () => { now += 400; } }), /timed out.*500 ms operation budget/i);
});

// --- 8. exact policies carry the same deny decisions as PathPolicy: excludes and server-owned paths --------------------

const BASE_FILES = ['AGENTS.md', 'src/clamp.js', 'test/clamp.test.js'];
const exactDoc = (over: Record<string, unknown> = {}, extra: string[] = []) => policyDoc({
  read: { include: [...BASE_FILES, ...extra], exclude: [] }, write: { include: [], exclude: [] },
  create: { paths: [], directories: [], extensions: [] }, dotfiles: [], ...over
});
const legacyOf = (doc: Record<string, unknown>, protectedPaths: string[] = []) => runtimePolicy(loadPolicy(doc), protectedPaths);

test('exact-v2 conversion agrees with PathPolicy: case, Unicode and ancestor excludes for read, write, create and checks', () => {
  const NFC = 'café/a.js', NFD = 'café/a.js';
  for (const [include, exclude] of [['Docs/Note.md', 'docs/note.md'], [NFC, NFD], [NFD, NFC], ['docs/Note.md', 'DOCS'], ['vendor/x.js', 'vendor'], ['a/b/c.js', 'A/B']]) {
    const doc = exactDoc({ read: { include: [...BASE_FILES, include], exclude: [exclude] } });
    const paths = compilePolicy(loadPolicy(doc)).paths;
    assert.equal(paths.decide(include, 'read').ok, false, `decide ${include} vs ${exclude}`);
    assert.ok(!legacyOf(doc).files.includes(include), `read: ${include} excluded by ${exclude}`);
  }
  for (const [include, exclude] of [['src/A.js', 'SRC/a.js'], ['src/B.js', 'SRC'], [NFC, NFD]]) {
    const doc = exactDoc({ read: { include: [...BASE_FILES, include], exclude: [] }, write: { include: [include], exclude: [exclude] } });
    assert.equal(compilePolicy(loadPolicy(doc)).paths.decide(include, 'write').ok, false);
    const legacy = legacyOf(doc);
    assert.ok(legacy.files.includes(include), 'still readable');
    assert.ok(!legacy.editable.includes(include), `write: ${include} excluded by ${exclude}`);
  }
  for (const [file, exclude] of [['src/New.js', 'src/new.js'], ['src/N2.js', 'SRC'], [NFC, NFD]]) {
    for (const where of ['write', 'read'] as const) {
      const doc = exactDoc({ read: { include: [...BASE_FILES, file], exclude: where === 'read' ? [exclude] : [] }, write: { include: [file], exclude: where === 'write' ? [exclude] : [] }, create: { paths: [file], directories: [], extensions: [] } });
      assert.equal(compilePolicy(loadPolicy(doc)).paths.createRule(file).ok, false);
      assert.ok(!(legacyOf(doc).creatable ?? []).includes(file), `create: ${file} ${where}-excluded by ${exclude}`);
    }
  }
  // A configured check that the policy denies is an error, never a silently smaller suite list.
  for (const exclude of ['test/clamp.test.js', 'TEST/CLAMP.TEST.JS', 'test', 'TeSt']) {
    const doc = exactDoc({ read: { include: BASE_FILES, exclude: [exclude] } });
    assert.throws(() => legacyOf(doc), /check.*test\/clamp\.test\.js/i, exclude);
  }
});

test('exact-v2 end to end: excluded spellings and directories are denied for read, list, search, diff, edit and create', async t => {
  const m = await makeRepo(t, { 'Docs/Note.md': 'CANARY-EXCLUDED\n', 'vendor/v.js': 'CANARY-VENDOR\n', 'src/locked.js': 'export const locked = 1;\n' });
  const doc = exactDoc({
    read: { include: [...BASE_FILES, 'Docs/Note.md', 'vendor/v.js', 'src/locked.js'], exclude: ['docs/note.md', 'VENDOR'] },
    write: { include: ['src/clamp.js', 'src/locked.js', 'src/new.js'], exclude: ['SRC/LOCKED.JS'] },
    create: { paths: ['src/new.js'], directories: [], extensions: [] }
  });
  doc.read.include.push('src/new.js');
  const service = await startServer(m.root, 0, undefined, doc);
  const { client, call } = await connect(service.url);
  try {
    assert.equal(service.repo.exactPolicy, true, 'the exact fast path is kept');
    for (const file of ['Docs/Note.md', 'docs/note.md', 'vendor/v.js', 'VENDOR/v.js']) assert.match((await call('read', { path: file })).error, /not exposed/, file);
    const info = await call('repo_info');
    assert.ok(!info.files.some((f: string) => /^docs\/|^vendor\//i.test(f)));
    assert.ok(info.files.includes('src/locked.js'), 'readable but not writable');
    assert.ok(!info.editable_files.includes('src/locked.js'));
    const listed = (await call('list_files')).files as { path: string; editable: boolean }[];
    assert.ok(!listed.some(f => /^docs\/|^vendor\//i.test(f.path)));
    assert.equal(listed.find(f => f.path === 'src/locked.js')!.editable, false);
    assert.equal((await call('search', { query: 'CANARY' })).matches.length, 0);
    const locked = await call('read', { path: 'src/locked.js' });
    assert.match((await call('edit', { path: 'src/locked.js', old_text: 'locked = 1', new_text: 'locked = 2', expected_sha256: locked.sha256 })).error, /not editable/);
    await writeFile(path.join(m.root, 'Docs/Note.md'), 'CANARY-EXCLUDED\nchanged\n');
    await writeFile(path.join(m.root, 'vendor/v.js'), 'CANARY-VENDOR\nchanged\n');
    const diff = await call('git_diff');
    assert.ok(!JSON.stringify(diff).includes('CANARY'), 'the diff names nothing excluded');
    assert.ok(!JSON.stringify(diff).includes('Docs/Note.md'));
    const created = await call('create_file', { path: 'src/new.js', content: 'export const n = 1;\n' });
    assert.ok(created.after_sha256, 'a create path that no rule denies still works');
  } finally { await client.close(); await service.close(); }
});

test('exact-v2: a create path denied by write.exclude is neither listed as creatable nor creatable', async t => {
  // src/new.js exists here only so that the read.include entry validates; the point is the denied creation rule.
  const m = await makeRepo(t, { 'src/new.js': 'export const existing = 1;\n' });
  const doc = exactDoc({
    read: { include: [...BASE_FILES, 'src/new.js'], exclude: [] },
    write: { include: ['src/new.js'], exclude: ['SRC'] }, create: { paths: ['src/new.js'], directories: [], extensions: [] }
  });
  const repo = await RepoWorkspace.create(m.root, compilePolicy(loadPolicy(doc)));
  try {
    await assert.rejects(repo.createFile('src/new.js', 'export const n = 1;\n'), /not exposed|not approved/);
    assert.ok(!(await repo.info()).creatable_files.includes('src/new.js'));
  } finally { await repo.close(); }
});

test('a compiled policy whose exact lists disagree with its path policy is refused at startup', async t => {
  const m = await makeRepo(t, { 'Docs/Note.md': 'CANARY-EXCLUDED\n' });
  const paths = PathPolicy.compile({ read: { include: ['AGENTS.md', 'src/clamp.js', 'test/clamp.test.js', 'Docs/Note.md'], exclude: ['docs/note.md'] }, checks: ['test/clamp.test.js'] });
  const legacy: RepoPolicy = { files: ['AGENTS.md', 'src/clamp.js', 'test/clamp.test.js', 'Docs/Note.md'], editable: [], tests: ['test/clamp.test.js'] };
  await assert.rejects(RepoWorkspace.create(m.root, { paths, legacy }), /path policy denies|policy/i);
});

test('server-owned paths cannot be exposed by exact policies: exact-v2 and migrated v1, files, directories and state', async t => {
  const m = await makeRepo(t, { 'config/policy.json': 'PROTECTED\n', 'logs/audit.jsonl': 'AUDIT\n' });
  const policyFile = path.join(m.root, 'config/policy.json');
  const auditFile = path.join(m.root, 'logs/audit.jsonl');
  const v2 = exactDoc({}, ['config/policy.json']);
  const v1 = { files: [...BASE_FILES, 'config/policy.json'], editable: ['src/clamp.js'], tests: ['test/clamp.test.js'] };
  for (const raw of [v2, v1]) {
    await assert.rejects(startServer(m.root, 0, undefined, raw, { protectedPaths: [policyFile] }), /server-owned/i, 'protected file');
    await assert.rejects(startServer(m.root, 0, undefined, raw, { protectedPaths: [path.join(m.root, 'config')] }), /server-owned/i, 'protected directory');
    await assert.rejects(compilePolicyFor(loadPolicy(raw), { root: m.root, protectedPaths: [policyFile] }), /server-owned/i);
  }
  await assert.rejects(startServer(m.root, 0, auditFile, exactDoc({}, ['logs/audit.jsonl'])), /server-owned/i, 'the audit log');
  await assert.rejects(startServer(m.root, 0, undefined, exactDoc({}, ['logs/audit.jsonl']), { task: { stateDir: path.join(m.root, 'logs'), taskId: 'srv-protected' }, protectedPaths: [] }), /server-owned|state|outside/i, 'state directory');
  // Policies that do not list server-owned paths still start on the exact fast path.
  const ok = await startServer(m.root, 0, auditFile, exactDoc(), { protectedPaths: [policyFile] });
  const { client, call } = await connect(ok.url);
  try {
    assert.equal(ok.repo.exactPolicy, true);
    assert.match((await call('read', { path: 'config/policy.json' })).error, /not exposed/);
    assert.match((await call('read', { path: 'logs/audit.jsonl' })).error, /not exposed/);
    assert.ok(!JSON.stringify(await call('repo_info')).includes('PROTECTED'));
  } finally { await client.close(); await ok.close(); }
  // Glob policies that name a server-owned path literally are refused the same way.
  await assert.rejects(startServer(m.root, 0, undefined, policyDoc({ read: { include: ['**', 'config/policy.json'], exclude: [] }, dotfiles: [] }), { protectedPaths: [policyFile] }), /server-owned/i);
});

// --- 5. AGENTS.md continuation -----------------------------------------------------------------------------------

test('long AGENTS.md instructions are retrieved completely through read(path, cursor) and every page fits page_bytes', async t => {
  const lines = Array.from({ length: 2500 }, (_, i) => `Rule ${i}: ${'keep the module small and tested. '.repeat(2)}`);
  const agents = `${lines.join('\n')}\nTAIL-INSTRUCTION-MARKER\n`;
  const m = await makeRepo(t, { 'AGENTS.md': agents });
  const service = await startServer(m.root, 0, undefined, policyDoc());
  const { client, call } = await connect(service.url);
  try {
    const info = await call('repo_info');
    assert.ok(info.instructions_next_cursor, 'the instructions continue');
    assert.ok(!info.instructions.includes('TAIL-INSTRUCTION-MARKER'));
    const instructionsText = client.getInstructions() ?? '';
    const infoTool = (await client.listTools()).tools.find(x => x.name === 'repo_info')!;
    for (const text of [instructionsText, infoTool.description ?? '']) {
      assert.match(text, /read\b[^.]*instructions_path[^.]*instructions_next_cursor|instructions_next_cursor[^.]*read\b[^.]*instructions_path/s, 'names the read call');
    }
    assert.doesNotMatch(instructionsText, /call the same tool with that cursor[^.]*instructions_next_cursor for read/);
    assert.ok(info.__bytes <= DEFAULT_LIMITS.page_bytes);
    let text = info.instructions, cursor = info.instructions_next_cursor, pages = 0;
    while (cursor) {
      const page = await call('read', { path: 'AGENTS.md', cursor });
      assert.ok(!page.error, page.error);
      assert.ok(page.__bytes <= DEFAULT_LIMITS.page_bytes, `read page ${page.__bytes} bytes`);
      text += page.content; cursor = page.next_cursor; pages++;
      assert.ok(pages < 50);
    }
    assert.equal(text, agents);
    assert.ok(pages >= 1);
  } finally { await client.close(); await service.close(); }
});

// --- 6. tool count in operator docs -----------------------------------------------------------------------------

test('operator docs name the eight tools the server registers', async t => {
  const m = await makeRepo(t);
  const service = await startServer(m.root, 0, undefined, policyDoc());
  const { client } = await connect(service.url);
  try {
    const names = (await client.listTools()).tools.map(x => x.name).sort();
    assert.equal(names.length, 8);
    for (const doc of ['README.md', 'SETUP.md']) {
      const text = await readFile(path.join(process.cwd(), doc), 'utf8');
      assert.doesNotMatch(text, /\bseven tools\b|\bSeven tools\b/, doc);
      assert.match(text, /\b[Ee]ight tools\b/, doc);
      assert.ok(text.includes('list_files'), doc);
      for (const name of names) assert.ok(text.includes(name), `${doc} mentions ${name}`);
    }
    const publicReadme = await readFile(path.join(process.cwd(), 'docs/PUBLIC-README.md'), 'utf8');
    assert.doesNotMatch(publicReadme, /32 KiB (?:per|source|file)|linked worktrees? (?:are|is) not supported/i);
    assert.match(publicReadme, /milestone 2b|list_files/);
  } finally { await client.close(); await service.close(); }
});

// --- 7. ordinary permission bits survive an edit --------------------------------------------------------------------

test('edit preserves the original permission bits under a restrictive umask', async t => {
  for (const [mode, mask] of [[0o666, 0o022], [0o664, 0o077], [0o640, 0o022], [0o755, 0o077], [0o700, 0o022]] as const) {
    const m = await makeRepo(t);
    const repo = await openGlob(t, m.root, writable('src/**'), {}, m.track);
    const file = path.join(m.root, 'src/clamp.js');
    await chmod(file, mode);
    const read = await repo.read('src/clamp.js');
    assert.equal(read.mode, mode);
    const previous = process.umask(mask);
    try { await repo.edit('src/clamp.js', 'max - 1', 'max', read.sha256); }
    finally { process.umask(previous); }
    assert.equal((await lstat(file)).mode & 0o777, mode, `mode ${mode.toString(8)} under umask ${mask.toString(8)}`);
    assert.equal((await repo.read('src/clamp.js')).mode, mode);
    assert.deepEqual((await readdir(path.join(m.root, 'src'))).filter(n => n.startsWith('.mcp-')), [], 'no temp file left behind');
  }
});
