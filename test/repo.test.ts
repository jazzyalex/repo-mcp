import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, symlink, writeFile, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { request } from 'node:http';
import { exercise } from '../scripts/exercise.js';
import { prepareFixture } from '../src/fixture.js';
import { execute, RepoWorkspace, defaultPolicy } from '../src/repo.js';
import { auditedEdit } from '../src/audit.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startServer } from '../src/server.js';

test('modern MCP discovery, read/edit/test/diff round trip', async () => { await exercise(true); });
test('legacy MCP initialization, read/edit/test/diff round trip', async () => { await exercise(false); });
test('path, write and HTTP boundaries', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-boundary-'));
  const root = path.join(base, 'repo');
  await prepareFixture(root);
  const service = await startServer(root, 0);
  try {
    const repo = service.repo;
    for (const file of ['../outside', '/etc/passwd', '.git/config', '.env', 'src/../package.json']) await assert.rejects(repo.read(file));
    await assert.rejects(repo.edit('test/clamp.test.js', 'clamp', 'fake', '0'.repeat(64)));
    const source = await repo.read('src/clamp.js');
    await assert.rejects(repo.edit('src/clamp.js', 'max', 'min', source.sha256), /exactly once/);
    assert.equal((await repo.read('src/clamp.js')).sha256, source.sha256);
    await writeFile(path.join(base, 'outside'), 'private');
    await unlink(path.join(root, 'src/clamp.js'));
    await symlink(path.join(base, 'outside'), path.join(root, 'src/clamp.js'));
    await assert.rejects(repo.read('src/clamp.js'), /Symlinks/);
    // Node fetch normalizes Host; use the HTTP client to send the actual hostile header.
    const deniedHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(service.url, { headers: { Host: 'evil.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end();
    });
    assert.equal(deniedHost, 403);
    const deniedOrigin = await fetch(service.url, { headers: { Origin: 'https://evil.example' } });
    assert.equal(deniedOrigin.status, 403);
    const tooLarge = await fetch(service.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(300_000) }) }); // above the 256 KiB request cap
    assert.equal(tooLarge.status, 413);
  } finally { await service.close(); await rm(base, { recursive: true, force: true }); }
});
test('command timeout and output limits', async () => {
  const timed = await execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], os.tmpdir(), 100);
  assert.equal(timed.timed_out, true);
  const noisy = await execute(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], os.tmpdir());
  assert.equal(noisy.truncated, true);
  assert.ok(Buffer.byteLength(noisy.stdout) + Buffer.byteLength(noisy.stderr) <= 32 * 1024);
});
test('Node runner denies outside file reads and subprocesses', async () => {
  const outside = await execute(process.execPath, ['--permission', '-e', 'require("node:fs").readFileSync("/etc/passwd")'], os.tmpdir());
  assert.equal(outside.exit_code, 1);
  assert.match(outside.stderr, /ERR_ACCESS_DENIED/);
  const child = await execute(process.execPath, ['--permission', '-e', 'require("node:child_process").spawnSync("/bin/echo", ["unexpected"])'], os.tmpdir());
  assert.equal(child.exit_code, 1);
  assert.match(child.stderr, /ERR_ACCESS_DENIED/);
});

test('configured scope supports multi-file edits, bounded search/read, suite selection and protected tests', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-policy-'));
  const root = path.join(base, 'repo');
  await prepareFixture(root);
  await writeFile(path.join(root, 'src/extra.js'), Array.from({length: 60}, (_, i) => `// marker ${i}`).join('\n'));
  const policy = {files: ['AGENTS.md', 'README.md', 'package.json', 'src/clamp.js', 'src/extra.js', 'test/clamp.test.js'], editable: ['src/clamp.js', 'src/extra.js'], tests: ['test/clamp.test.js']};
  assert.equal((await execute('/usr/bin/git', ['add', '--', 'src/extra.js'], root)).exit_code, 0);
  assert.equal((await execute('/usr/bin/git', ['-c', 'user.name=Trial', '-c', 'user.email=trial@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Track extra source'], root)).exit_code, 0);
  const repo = await RepoWorkspace.create(root, policy);
  try {
    const range = await repo.readRange('src/extra.js', 10, 3);
    assert.equal(range.content, '// marker 9\n// marker 10\n// marker 11\n'); // pages keep line endings so they concatenate exactly
    assert.equal(range.truncated, true);
    assert.equal((await repo.search('marker')).matches.length, 50);
    assert.equal((await repo.search('marker')).truncated, true);
    assert.deepEqual((await repo.search('marker', 'test/')).matches, []);
    await repo.edit('src/extra.js', '// marker 9\n', '// changed 9\n', range.sha256);
    await assert.rejects(repo.edit('src/extra.js', 'marker', 'changed', range.sha256), /Stale/);
    await assert.rejects(repo.edit('README.md', 'Disposable', 'Changed', (await repo.read('README.md')).sha256), /not editable/);
    await assert.rejects(repo.test('src/extra.js'), /Unknown test/);
    assert.equal((await repo.test('test/clamp.test.js')).exit_code, 1);
    await writeFile(path.join(root, 'test/clamp.test.js'), '');
    await assert.rejects(repo.test(), /Test file changed/);
  } finally { await rm(base, {recursive: true, force: true}); }
});

test('test snapshot excludes non-allowlisted files and denies original repository access', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-isolation-'));
  const root = path.join(base, 'repo');
  try {
    await prepareFixture(root);
    await writeFile(path.join(root, '.env'), 'SYNTHETIC_PRIVATE_MARKER');
    const repo = await RepoWorkspace.create(root);
    const original = await repo.read('src/clamp.js');
    const probe = `import {readFileSync, readdirSync} from 'node:fs';
import assert from 'node:assert/strict';
assert.throws(() => readFileSync(new URL('../.env', import.meta.url)), {code: 'ENOENT'});
assert.throws(() => readFileSync(new URL('../.git/config', import.meta.url)), {code: 'ENOENT'});
assert.throws(() => readFileSync(${JSON.stringify(path.join(root, '.env'))}), {code: 'ERR_ACCESS_DENIED'});
assert.throws(() => readFileSync(${JSON.stringify(path.join(root, 'src/clamp.js'))}), {code: 'ERR_ACCESS_DENIED'});
assert.deepEqual(readdirSync(process.cwd()).sort(), ['AGENTS.md','README.md','package.json','src','test']);
console.log('ISOLATION_VERIFIED');
`;
    await repo.edit(original.path, original.content, probe + original.content.replace('max - 1', 'max'), original.sha256);
    const result = await repo.test();
    assert.equal(result.exit_code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /ISOLATION_VERIFIED/);
    assert.match(result.stdout, /pass 6/);
    assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_PRIVATE_MARKER/);
  } finally { await rm(base, {recursive: true, force: true}); }
});

test('untracked or staged-only editable files are rejected instead of omitted from diff', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-tracked-'));
  const root = path.join(base, 'repo');
  try {
    await prepareFixture(root);
    await writeFile(path.join(root, 'src/extra.js'), 'export const value = 1;\n');
    const policy = {files: ['AGENTS.md','README.md','package.json','src/clamp.js','test/clamp.test.js','src/extra.js'], editable: ['src/extra.js'], tests: ['test/clamp.test.js']};
    await assert.rejects(RepoWorkspace.create(root, policy), /must exist in HEAD/);
    await execute('/usr/bin/git', ['add', '--', 'src/extra.js'], root);
    await assert.rejects(RepoWorkspace.create(root, policy), /must exist in HEAD/);
    const repo = await RepoWorkspace.create(root);
    const source = await repo.read('src/clamp.js');
    assert.equal((await execute('/usr/bin/git', ['rm', '--cached', '--', source.path], root)).exit_code, 0);
    await assert.rejects(repo.edit(source.path, 'max - 1', 'max', source.sha256), /remain tracked/);
    await assert.rejects(repo.diff(), /remain tracked/);
    assert.equal((await repo.read(source.path)).sha256, source.sha256);
  } finally { await rm(base, {recursive: true, force: true}); }
});

test('unavailable audit log rejects MCP edits before changing source', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-audit-'));
  const root = path.join(base, 'repo');
  await prepareFixture(root);
  const service = await startServer(root, 0, path.join(base, 'missing-parent', 'audit.jsonl'));
  const client = new Client({name:'audit-test',version:'1'}, {versionNegotiation:{mode:{pin:'2026-07-28'}}});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url)));
    const source = await service.repo.read('src/clamp.js');
    const result = await client.callTool({name:'edit',arguments:{path:source.path,old_text:'max - 1',new_text:'max',expected_sha256:source.sha256}});
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /Edit was not attempted/);
    assert.equal(await readFile(path.join(root, source.path), 'utf8'), source.content);
  } finally { await client.close(); await service.close(); await rm(base, {recursive: true, force: true}); }
});

test('completion audit failure preserves committed edit result and warns against retry', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-audit-post-'));
  const root = path.join(base, 'repo');
  try {
    await prepareFixture(root);
    const repo = await RepoWorkspace.create(root);
    const source = await repo.read('src/clamp.js');
    const phases: string[] = [];
    const result = await auditedEdit(() => repo.edit(source.path, 'max - 1', 'max', source.sha256), async phase => {
      phases.push(phase);
      if (phase === 'completed') throw new Error('simulated disk failure');
    });
    assert.deepEqual(phases, ['started', 'completed']);
    assert.match(result.audit_warning!, /Edit committed successfully/);
    assert.match(result.audit_warning!, /Do not retry/);
    assert.equal((await repo.read(source.path)).sha256, result.after_sha256);
    assert.match(result.diff!, /max - 1/);
  } finally { await rm(base, {recursive: true, force: true}); }
});

 test('read-only policy refuses implicit test discovery', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-readonly-'));
  const root = path.join(base, 'repo');
  await prepareFixture(root);
  try {
    const repo = await RepoWorkspace.create(root, { files: ['AGENTS.md', 'src/clamp.js', 'test/clamp.test.js'], editable: [], tests: [] });
    await assert.rejects(repo.test(), /No test suites are configured/);
    await assert.rejects(repo.test('test/clamp.test.js'), /No test suites are configured/);
    const source = await repo.read('src/clamp.js');
    await assert.rejects(repo.edit(source.path, 'clamp', 'other', source.sha256), /not editable/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

// Instruction discovery must respect the policy's exact disk spelling.
test('repo_info reads lowercase exact-policy instructions and continues that path', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-instructions-'));
  const root = path.join(base, 'repo');
  await prepareFixture(root);
  await rename(path.join(root, 'AGENTS.md'), path.join(root, 'agents.md'));
  const content = 'local instructions\n'.repeat(2000);
  await writeFile(path.join(root, 'agents.md'), content);
  const policy = { ...defaultPolicy, files: defaultPolicy.files.map(f => f === 'AGENTS.md' ? 'agents.md' : f) };
  const repo = await RepoWorkspace.create(root, policy);
  try {
    const info = await repo.info();
    assert.equal(info.instructions_path, 'agents.md');
    assert.ok(info.instructions_next_cursor);
    let assembled = info.instructions;
    let cursor: string | null = info.instructions_next_cursor;
    while (cursor) {
      const page = await repo.readRange(info.instructions_path!, 1, 200, cursor);
      assembled += page.content;
      cursor = page.next_cursor;
    }
    assert.equal(assembled, content);
    await assert.rejects(repo.read('AGENTS.md'));
  } finally { await repo.close(); await rm(base, { recursive: true, force: true }); }
});
