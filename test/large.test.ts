import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod, stat, realpath, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareFixture } from '../src/fixture.js';
import { createPatch } from 'diff';
import { RepoWorkspace, defaultPolicy, execute, sha256, type RepoPolicy } from '../src/repo.js';
import { DEFAULT_LIMITS } from '../src/limits.js';

// Milestone 2a: large files, bounded pages, resumable cursors and Git output.

const PAGE = DEFAULT_LIMITS.page_bytes;
// The whole serialized response, metadata included, must fit one page.
const bounded = (value: unknown) => assert.ok(Buffer.byteLength(JSON.stringify(value)) <= PAGE, `response ${Buffer.byteLength(JSON.stringify(value))} bytes`);
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const git = async (cwd: string, ...args: string[]) => {
  const r = await execute('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], cwd, 60_000, {}, { maxOutputBytes: 256 * 1024 * 1024 });
  assert.equal(r.exit_code, 0, r.stderr);
  return r.stdout;
};

async function fixture(t: { after(fn: () => Promise<void>): void }, extra: Record<string, string | Buffer>, policyExtra: Partial<RepoPolicy> = {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-large-')));
  const root = path.join(base, 'repo');
  await prepareFixture(root);
  for (const [file, content] of Object.entries(extra)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content); }
  if (Object.keys(extra).length) { await git(root, 'add', '--', ...Object.keys(extra)); await git(root, 'commit', '-m', 'large fixtures'); }
  const policy: RepoPolicy = {
    files: [...defaultPolicy.files, ...Object.keys(extra)], editable: ['src/clamp.js', ...Object.keys(extra)], tests: ['test/clamp.test.js'], ...policyExtra
  };
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, root, policy };
}

async function readAll(repo: RepoWorkspace, file: string) {
  let page = await repo.readRange(file);
  bounded(page);
  let text = page.content;
  let pages = 1;
  while (page.next_cursor) {
    page = await repo.readRange(file, undefined, undefined, page.next_cursor);
    bounded(page);
    assert.ok(!loneSurrogate.test(page.content), 'page never splits a surrogate pair');
    text += page.content;
    pages++;
  }
  assert.equal(page.complete, true);
  return { text, pages, sha256: page.sha256 };
}

const bigModule = (lines: number) => Array.from({ length: lines }, (_, i) => `export const value${i} = ${i}; // filler to make this module realistic`).join('\n') + '\n';

test('a 300 KB module is read in bounded pages, searched and edited without whole-file responses', async t => {
  const big = bigModule(4600);
  assert.ok(Buffer.byteLength(big) > 300 * 1024);
  const { root, policy } = await fixture(t, { 'src/big.js': big });
  const repo = await RepoWorkspace.create(root, policy);
  const all = await readAll(repo, 'src/big.js');
  assert.equal(all.text, big);
  assert.ok(all.pages > 10);
  assert.equal(all.sha256, sha256(big));
  const middle = await repo.readRange('src/big.js', 4000, 3);
  assert.equal(middle.content, 'export const value3999 = 3999; // filler to make this module realistic\nexport const value4000 = 4000; // filler to make this module realistic\nexport const value4001 = 4001; // filler to make this module realistic\n');
  assert.equal(middle.start_line, 4000);
  assert.equal(middle.end_line, 4002);
  assert.equal(middle.truncated, true);
  const found = await repo.search('value4555 ');
  assert.deepEqual(found.matches.map(m => [m.path, m.line, m.column]), [['src/big.js', 4556, 14]]);
  const edited = await repo.edit('src/big.js', 'export const value4555 = 4555;', 'export const value4555 = -1;', all.sha256);
  bounded(edited);
  const after = await readFile(path.join(root, 'src/big.js'), 'utf8');
  assert.equal(after, big.replace('export const value4555 = 4555;', 'export const value4555 = -1;'));
});

test('multi-megabyte files page completely; files above the edit limit fail explicitly', async t => {
  const three = bigModule(45_000);
  assert.ok(Buffer.byteLength(three) > 3 * 1024 * 1024);
  const huge = 'x'.repeat(DEFAULT_LIMITS.edit_file_bytes + 1);
  const { root, policy } = await fixture(t, { 'fixtures/three.txt': three, 'fixtures/huge.txt': huge });
  const repo = await RepoWorkspace.create(root, { ...policy, editable: ['src/clamp.js', 'fixtures/three.txt'] }).catch(e => e as Error);
  assert.ok(repo instanceof Error && /exceeds the 8 MiB file limit/.test(repo.message), String(repo));
  const ok = await RepoWorkspace.create(root, { ...policy, files: policy.files.filter(f => f !== 'fixtures/huge.txt'), editable: ['src/clamp.js', 'fixtures/three.txt'] });
  const all = await readAll(ok, 'fixtures/three.txt');
  assert.equal(all.text, three);
});

test('non-ASCII text and a very long line split only at code points with explicit continuation', async t => {
  const long = Array.from({ length: 40_000 }, (_, i) => ['é', '😀', '"', '\\', 'a', '\t', '中'][i % 7]).join('');
  const content = `first line\n${long}\nlast línea 😀\n`;
  const { root, policy } = await fixture(t, { 'src/unicode.txt': content });
  const repo = await RepoWorkspace.create(root, policy);
  const first = await repo.readRange('src/unicode.txt');
  assert.equal(first.content, 'first line\n', 'a line that cannot fit is not merged into a partial page');
  assert.ok(first.next_cursor);
  const all = await readAll(repo, 'src/unicode.txt');
  assert.equal(all.text, content);
  const found = await repo.search('línea');
  assert.equal(found.matches[0].line, 3);
  const inLong = await repo.search('中');
  assert.equal(inLong.matches[0].line, 2);
  assert.equal(inLong.matches[0].text_truncated, true, 'long lines are windowed explicitly, never silently cut');
  assert.ok(inLong.matches[0].text.includes('中'));
});

test('edits preserve BOM, CRLF, mode and every unchanged byte', async t => {
  const content = '﻿line one\r\nline two\r\nline three\r\n';
  const { root, policy } = await fixture(t, { 'src/crlf.txt': content });
  await chmod(path.join(root, 'src/crlf.txt'), 0o755);
  const repo = await RepoWorkspace.create(root, policy);
  const page = await repo.readRange('src/crlf.txt');
  assert.equal(page.content, content);
  assert.equal(page.sha256, sha256(Buffer.from(content)));
  await repo.edit('src/crlf.txt', 'two', '2', page.sha256);
  assert.deepEqual(await readFile(path.join(root, 'src/crlf.txt')), Buffer.from(content.replace('two', '2')));
  assert.equal((await stat(path.join(root, 'src/crlf.txt'))).mode & 0o777, 0o755);
});

test('stale read cursors are rejected after the file changes', async t => {
  const { root, policy } = await fixture(t, { 'src/big.js': bigModule(3000) });
  const repo = await RepoWorkspace.create(root, policy);
  const first = await repo.readRange('src/big.js');
  await repo.edit('src/big.js', 'value2999 = 2999', 'value2999 = 0', first.sha256);
  await assert.rejects(repo.readRange('src/big.js', undefined, undefined, first.next_cursor!), /stale cursor/i);
  await assert.rejects(repo.readRange('README.md', undefined, undefined, first.next_cursor!), /cursor/i, 'cursor bound to its path');
  await assert.rejects(repo.readRange('src/big.js', undefined, undefined, 'garbage'), /invalid cursor/i);
});

test('a diff larger than one response pages completely and rejects stale continuation', async t => {
  const big = bigModule(3000);
  const { root, policy } = await fixture(t, { 'src/big.js': big });
  const repo = await RepoWorkspace.create(root, policy);
  await writeFile(path.join(root, 'src/big.js'), big.replaceAll('filler', 'changed'));
  const expected = await git(root, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--', ...policy.files);
  assert.ok(Buffer.byteLength(expected) > 32 * 1024 * 4);
  let page = await repo.diff();
  bounded(page);
  let text = page.diff;
  const firstCursor = page.next_cursor;
  while (page.next_cursor) { page = await repo.diff('', page.next_cursor); bounded(page); text += page.diff; }
  assert.equal(page.complete, true);
  assert.equal(text, expected);
  await writeFile(path.join(root, 'src/big.js'), big);
  await assert.rejects(repo.diff('', firstCursor!), /stale cursor/i);
});

test('repo_info survives more than 32 KiB of untracked paths and pages status', async t => {
  const { root, policy } = await fixture(t, {});
  const names = Array.from({ length: 1500 }, (_, i) => `untracked-with-a-deliberately-long-file-name-${String(i).padStart(5, '0')}.txt`);
  for (const n of names) await writeFile(path.join(root, n), 'x');
  const expected = await git(root, 'status', '--short', '--branch', '--untracked-files=all');
  assert.ok(Buffer.byteLength(expected) > 64 * 1024);
  const repo = await RepoWorkspace.create(root, policy);
  const info = await repo.info();
  bounded(info);
  assert.equal(info.status_complete, false);
  let status = info.status;
  let cursor = info.status_next_cursor;
  const firstCursor = cursor;
  while (cursor) { const p = await repo.statusPage(cursor); bounded(p); status += p.status; cursor = p.status_next_cursor; }
  assert.equal(status, expected);
  // The capture is a snapshot: Git does not run again, so an unexposed new file does not alter it.
  await writeFile(path.join(root, 'one-more.txt'), 'x');
  const replay = await repo.statusPage(firstCursor!);
  assert.ok(!replay.status.includes('one-more.txt'));
  // A change to an exposed file makes the capture explicitly stale.
  await writeFile(path.join(root, 'src/clamp.js'), '// changed\n');
  await assert.rejects(repo.statusPage(firstCursor!), /stale cursor/i);
});

test('search pages across files and rejects continuation after a scanned file changes', async t => {
  const files = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`src/m${i}.js`, Array.from({ length: 40 }, (_, j) => `// needle ${i}-${j}`).join('\n') + '\n']));
  const { root, policy } = await fixture(t, files);
  const repo = await RepoWorkspace.create(root, policy);
  let page = await repo.search('needle');
  assert.equal(page.matches.length, 50);
  assert.equal(page.complete, false);
  const seen = [...page.matches];
  const second = page.next_cursor!;
  while (page.next_cursor) { page = await repo.search('needle', '', page.next_cursor); seen.push(...page.matches); }
  assert.equal(seen.length, 160);
  assert.equal(new Set(seen.map(m => `${m.path}:${m.line}`)).size, 160);
  await assert.rejects(repo.search('other', '', second), /cursor/i, 'cursor bound to its query');
  await writeFile(path.join(root, 'src/m1.js'), '// needle changed\n');
  await assert.rejects(repo.search('needle', '', second), /stale cursor/i);
});

test('search resumes within the synchronous operation budget instead of running long', async t => {
  const files = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`src/s${i}.js`, `// hit ${i}\n`]));
  const { root, policy } = await fixture(t, files);
  const repo = await RepoWorkspace.create(root, policy, { operationBudgetMs: 0 });
  let page = await repo.search('hit');
  const seen = [...page.matches];
  let pages = 1;
  while (page.next_cursor) { page = await repo.search('hit', '', page.next_cursor); seen.push(...page.matches); pages++; }
  assert.deepEqual(seen.map(m => m.path), ['src/s0.js', 'src/s1.js', 'src/s2.js']);
  assert.ok(pages >= 3, 'each page scans at least one file and then yields');
});

test('Git output beyond the storage cap is reported separately from Git failure', async () => {
  const noisy = await execute(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], os.tmpdir(), 10_000, {}, { maxOutputBytes: 1024 * 1024 });
  assert.equal(noisy.truncated, false, 'a page-sized limit no longer kills a healthy process');
  assert.equal(noisy.stdout.length, 100000);
  const capped = await execute(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], os.tmpdir(), 10_000, {}, { maxOutputBytes: 1000 });
  assert.equal(capped.truncated, true);
});

test('MCP enforces the 256 KiB request body and 128 KiB UTF-8 payload caps', async t => {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const { startServer } = await import('../src/server.js');
  const { root, policy } = await fixture(t, {});
  const service = await startServer(root, 0, undefined, { ...policy, files: [...policy.files, 'src/a.js', 'src/b.js'], editable: [...policy.editable, 'src/a.js', 'src/b.js'], creatable: ['src/a.js', 'src/b.js'] });
  const client = new Client({ name: 'limits', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url)));
    const ascii = await client.callTool({ name: 'create_file', arguments: { path: 'src/a.js', content: 'a'.repeat(120 * 1024) } });
    assert.ok(!ascii.isError, JSON.stringify(ascii).slice(0, 300));
    const emoji = await client.callTool({ name: 'create_file', arguments: { path: 'src/b.js', content: '😀'.repeat(50_000) } });
    assert.equal(emoji.isError, true, 'UTF-8 bytes, not UTF-16 units, are counted');
    assert.match(JSON.stringify(emoji), /128 KiB/);
    const source = JSON.parse(((await client.callTool({ name: 'read', arguments: { path: 'src/clamp.js' } })).content as { text: string }[])[0].text);
    const patch = await client.callTool({ name: 'edit', arguments: { path: 'src/clamp.js', old_text: 'max - 1', new_text: 'é'.repeat(70_000), expected_sha256: source.sha256 } });
    assert.equal(patch.isError, true);
    assert.match(JSON.stringify(patch), /128 KiB/);
    const tooLarge = await fetch(service.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(257 * 1024) }) });
    assert.equal(tooLarge.status, 413);
  } finally { await client.close(); await service.close(); }
});

test('repo_info pages a 500-file inventory and every response fits one page', async t => {
  const extra = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`src/generated/module-with-a-long-descriptive-name-${String(i).padStart(4, '0')}.js`, `export const v${i} = ${i};\n`]));
  const { root, policy } = await fixture(t, extra);
  const repo = await RepoWorkspace.create(root, policy);
  const info = await repo.info({ capabilities: { paging: true } });
  bounded(info);
  assert.equal(info.files_complete, false);
  const lists = ['files', 'editable_files', 'creatable_files', 'test_suites', 'configured_test_suites', 'editable_test_files'] as const;
  const seen = Object.fromEntries(lists.map(k => [k, [...info[k]]])) as Record<typeof lists[number], string[]>;
  let cursor = info.files_next_cursor;
  while (cursor) {
    const page = await repo.filesPage(cursor);
    bounded(page);
    for (const k of lists) seen[k].push(...(page[k] ?? []));
    cursor = page.files_next_cursor;
  }
  assert.deepEqual(seen.files, policy.files);
  assert.deepEqual(seen.editable_files, policy.editable);
  assert.deepEqual(seen.configured_test_suites, policy.tests);
  await assert.rejects(repo.filesPage('garbage'), /invalid cursor/i);
});

test('a mutation response that would exceed one page with its metadata omits the patch', async t => {
  const patchBytes = (n: number) => Buffer.byteLength(JSON.stringify(createPatch('src/line.txt', 'a'.repeat(n) + '\n', 'b'.repeat(n) + '\n')));
  let n = PAGE / 2;
  while (patchBytes(n) > PAGE - 50) n--;
  assert.ok(patchBytes(n) > PAGE - 60, 'patch alone fits a page but not with metadata');
  const { root, policy } = await fixture(t, { 'src/line.txt': 'a'.repeat(n) + '\n' });
  const repo = await RepoWorkspace.create(root, policy);
  const before = await repo.readRange('src/line.txt');
  const edited = await repo.edit('src/line.txt', 'a'.repeat(n), 'b'.repeat(n), before.sha256);
  bounded(edited);
  assert.equal(edited.diff, null);
});

test('Git output that is not valid UTF-8 is rejected explicitly, never replaced', async t => {
  const { root, policy } = await fixture(t, {});
  const repo = await RepoWorkspace.create(root, policy);
  await writeFile(path.join(root, 'src/clamp.js'), Buffer.from('export const bad = "\xff\xfe";\n', 'latin1'));
  await assert.rejects(repo.diff(), /not valid UTF-8/);
  const strict = await execute(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0x61, 0xff]))'], os.tmpdir(), 10_000, {}, { strictUtf8: true });
  assert.equal(strict.invalid_utf8, true);
  const lossy = await execute(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0x61, 0xff]))'], os.tmpdir());
  assert.equal(lossy.invalid_utf8, false, 'test-runner output stays lossy');
});
