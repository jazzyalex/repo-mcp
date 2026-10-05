import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { prepareFixture } from '../src/fixture.js';
import { RepoWorkspace, defaultPolicy, execute } from '../src/repo.js';
import { startServer } from '../src/server.js';

const policy = () => ({
  files: [...defaultPolicy.files, 'src/new.js', 'test/new.test.js'],
  editable: ['src/new.js', 'test/new.test.js', 'test/clamp.test.js'],
  creatable: ['src/new.js', 'test/new.test.js'],
  tests: ['test/clamp.test.js', 'test/new.test.js']
});

for (const modern of [true, false]) test(`creation and editable test MCP workflow (${modern ? 'modern' : 'legacy'})`, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-create-'));
  const root = path.join(base, 'repo');
  await prepareFixture(root);
  const audit = path.join(base, 'audit.jsonl');
  const service = await startServer(root, 0, audit, policy());
  const c = new Client({name: 'creation-test', version: '1'}, {versionNegotiation:{mode: modern ? {pin: '2026-07-28'} : 'legacy'}});
  try {
    await c.connect(new StreamableHTTPClientTransport(new URL(service.url)));
    const call = async (name: string, args = {}) => {
      const r = await c.callTool({name, arguments: args});
      assert.ok(!r.isError, JSON.stringify(r));
      return JSON.parse((r.content as {text: string}[])[0].text);
    };
    const initial = await call('repo_info');
    assert.ok(!initial.files.includes('src/new.js'));
    assert.deepEqual(initial.test_suites, ['test/clamp.test.js']);
    const source = 'export const twice = n => n * 2;\n';
    await call('create_file', {path:'src/new.js', content: source});
    const content = "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {twice} from '../src/new.js';\ntest('twice', () => assert.equal(twice(3), 7));\n";
    const created = await call('create_file', {path:'test/new.test.js', content});
    assert.equal((await call('run_tests', {suite:'test/new.test.js'})).exit_code, 1);
    await call('edit', {path:'test/new.test.js', old_text:'twice(3), 7', new_text:'twice(3), 6', expected_sha256: created.after_sha256});
    const passed = await call('run_tests', {suite:'test/new.test.js'});
    assert.equal(passed.exit_code, 0, passed.stdout + passed.stderr);
    assert.deepEqual(passed.test_files, [{path:'test/new.test.js', editable:true}]);
    const existing = await call('read', {path:'test/clamp.test.js'});
    await call('edit', {path:existing.path, old_text: existing.content, new_text:'// explicit test edit\n'+existing.content, expected_sha256:existing.sha256});
    assert.equal((await call('run_tests', {suite:existing.path})).exit_code, 1); // original clamp bug still present
    assert.ok((await call('repo_info')).test_suites.includes('test/new.test.js'));
    assert.equal((await call('search', {query:'export const twice'})).matches[0].path, 'src/new.js');
    const diff = await call('git_diff');
    assert.match(diff.diff, /export const twice/);
    assert.match(diff.diff, /explicit test edit/);
    assert.match(diff.diff, /twice\(3\), 6/);
    const restarted = await RepoWorkspace.create(root, policy());
    assert.match((await restarted.diff()).diff, /export const twice/);
    assert.equal((await restarted.test('test/new.test.js')).exit_code, 0);
    assert.equal((await execute('/usr/bin/git', ['diff','--cached','--name-only'], root)).stdout, '');
    await execute('/usr/bin/git', ['add', '--', 'src/new.js'], root);
    assert.equal((await restarted.diff()).diff.split('+export const twice').length, 2); // no duplicate staged patch
    const records = (await readFile(audit,'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.filter(r=>r.tool==='create_file' && r.result?.phase==='completed').length, 2);
  } finally { await c.close(); await service.close(); await rm(base,{recursive:true,force:true}); }
});

test('creation rejects overwrite, invalid paths, unsafe files and oversized content', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-create-boundary-'));
  const root = path.join(base, 'repo');
  try {
    await prepareFixture(root);
    const repo = await RepoWorkspace.create(root, policy());
    for (const name of ['../outside.js', '/tmp/outside.js', '.env', 'src/other.js']) await assert.rejects(repo.createFile(name,'x'), /not approved/);
    await assert.rejects(repo.createFile('src/new.js', 'x'.repeat(128 * 1024 + 1)), /bytes/);
    await assert.rejects(repo.createFile('src/new.js', '\0'), /bytes/);
    await assert.rejects(repo.test('test/new.test.js'), /not been created/);
    await writeFile(path.join(root,'src/new.js'),'original');
    await assert.rejects(repo.createFile('src/new.js','overwrite'), /already exists/);
    assert.equal(await readFile(path.join(root,'src/new.js'),'utf8'),'original');
    await unlink(path.join(root,'src/new.js'));
    await symlink(path.join(base,'missing'), path.join(root,'src/new.js'));
    await assert.rejects(repo.createFile('src/new.js','overwrite'), /already exists/);
    await assert.rejects(repo.read('src/new.js'), /Symlinks/);
    await unlink(path.join(root,'src/new.js'));
    const changedPolicy = policy();
    changedPolicy.files.push('linked/new.js'); changedPolicy.editable.push('linked/new.js'); changedPolicy.creatable.push('linked/new.js');
    const other = await RepoWorkspace.create(root, changedPolicy);
    await symlink(base, path.join(root,'linked'));
    await assert.rejects(other.createFile('linked/new.js','x'), /non-symlink/);
    await assert.rejects(RepoWorkspace.create(root, {...policy(), creatable:['../escape']}), /membership/);
  } finally { await rm(base,{recursive:true,force:true}); }
});

test('creation audit failure aborts before publication', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-create-audit-'));
  const root = path.join(base,'repo'); await prepareFixture(root);
  const service = await startServer(root,0,path.join(base,'missing','audit'),policy());
  const c = new Client({name:'creation-audit',version:'1'});
  try {
    await c.connect(new StreamableHTTPClientTransport(new URL(service.url)));
    const result = await c.callTool({name:'create_file',arguments:{path:'src/new.js',content:'x'}});
    assert.equal(result.isError,true);
    await assert.rejects(readFile(path.join(root,'src/new.js')), {code:'ENOENT'});
  } finally { await c.close(); await service.close(); await rm(base,{recursive:true,force:true}); }
});

test('creation enforces the payload and file limits independently', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-create-limits-'));
  const root = path.join(base, 'repo');
  await prepareFixture(root);
  try {
    const p = { files: [...defaultPolicy.files, 'src/new.js'], editable: ['src/clamp.js', 'src/new.js'], creatable: ['src/new.js'], tests: ['test/clamp.test.js'] };
    // Payload allows 2 KiB but the readable-file limit is 1 KiB: the file could never be read back.
    const fileLimit = await RepoWorkspace.create(root, p, { limits: { payload_bytes: 2048, edit_file_bytes: 1024 } });
    await assert.rejects(fileLimit.createFile('src/new.js', 'x'.repeat(1500)), /1 KiB file limit/);
    await assert.rejects(readFile(path.join(root, 'src/new.js')), /ENOENT/);
    // The reverse: the file limit is generous but the payload limit is 1 KiB.
    const payloadLimit = await RepoWorkspace.create(root, p, { limits: { payload_bytes: 1024, edit_file_bytes: 4096 } });
    await assert.rejects(payloadLimit.createFile('src/new.js', 'x'.repeat(1500)), /1 KiB/);
    // At the limit it is created and immediately readable.
    await payloadLimit.createFile('src/new.js', 'x'.repeat(1024));
    assert.equal((await payloadLimit.readRange('src/new.js')).total_bytes, 1024);
  } finally { await rm(base, { recursive: true, force: true }); }
});
