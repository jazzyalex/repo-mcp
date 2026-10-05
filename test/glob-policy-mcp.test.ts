import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startServer } from '../src/server.js';
import { RepoWorkspace, defaultPolicy, type RepoPolicy } from '../src/repo.js';
import { loadPolicy, compilePolicy, migrateV1 } from '../src/policy.js';
import { makeRepo, policyDoc } from './helpers.js';

// Milestone 2b: the MCP surface for glob policies, policy-file protection and v1 equivalence.

async function connect(url: string) {
  const client = new Client({ name: 'glob-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0].text;
    return r.isError ? { error: text } : JSON.parse(text);
  };
  return { client, call };
}

test('glob policy end to end over MCP: list_files, read, edit, scoped create, diff; capabilities are versioned', async t => {
  const m = await makeRepo(t, { 'src/features/.keep.txt': 'x\n', '.github/workflows/ci.yml': 'name: ci\n' }, { '.env': 'SECRET=1' });
  const doc = policyDoc({ write: { include: ['src/**', '.github/**'], exclude: [] }, dotfiles: ['.github/**'], create: { paths: [], directories: ['src/features'], extensions: ['.js'] } });
  const service = await startServer(m.root, 0, undefined, doc);
  const { client, call } = await connect(service.url);
  try {
    const tools = (await client.listTools()).tools.map(x => x.name);
    assert.ok(tools.includes('list_files'));
    const info = await call('repo_info');
    assert.equal(info.capabilities.path_policy, 'glob');
    assert.equal(info.capabilities.discovery.tools[0], 'list_files');
    assert.equal(info.capabilities.discovery.inventory_paths, 100_000);
    const listed = await call('list_files', { prefix: '.github' });
    assert.deepEqual(listed.files.map((f: { path: string }) => f.path), ['.github/workflows/ci.yml']);
    assert.equal(listed.files[0].editable, true);
    assert.match((await call('read', { path: '.env' })).error, /not exposed/);
    const read = await call('read', { path: '.github/workflows/ci.yml' });
    const edited = await call('edit', { path: '.github/workflows/ci.yml', old_text: 'ci', new_text: 'build', expected_sha256: read.sha256 });
    assert.ok(edited.after_sha256);
    const created = await call('create_file', { path: 'src/features/nested/x.js', content: 'export const x = 1;\n' });
    assert.deepEqual(created.created_directories, ['src/features/nested']);
    const diff = await call('git_diff');
    assert.match(diff.diff, /\+name: build/);
    assert.match(diff.diff, /Index: src\/features\/nested\/x\.js[\s\S]*\+export const x = 1;/);
    assert.match((await call('create_file', { path: 'src/other/x.js', content: 'x\n' })).error, /not approved for creation/);
  } finally { await client.close(); await service.close(); }
});

test('exact policies report path_policy exact and keep their responses', async t => {
  const m = await makeRepo(t);
  const service = await startServer(m.root, 0);
  const { client, call } = await connect(service.url);
  try {
    const info = await call('repo_info');
    assert.equal(info.capabilities.path_policy, 'exact');
    assert.equal(info.inventory, undefined);
    assert.equal(info.policy_summary, undefined);
    assert.deepEqual(info.files, defaultPolicy.files);
    const listed = await call('list_files');
    assert.deepEqual(listed.files.map((f: { path: string }) => f.path), [...defaultPolicy.files].sort());
  } finally { await client.close(); await service.close(); }
});

test('the policy file, audit log and state inside the repository cannot be read or edited through chat tools', async t => {
  const m = await makeRepo(t, {}, { 'config/policy.json': '{"secret":"policy"}' });
  const doc = policyDoc({ write: { include: ['**'], exclude: [] } });
  const policyFile = path.join(m.root, 'config/policy.json');
  const auditFile = path.join(m.root, 'logs/audit.jsonl');
  await mkdir(path.dirname(auditFile));
  const service = await startServer(m.root, 0, auditFile, doc, { protectedPaths: [policyFile] });
  const { client, call } = await connect(service.url);
  try {
    assert.match((await call('read', { path: 'config/policy.json' })).error, /not exposed/);
    assert.match((await call('search', { query: 'secret' })).matches?.length ? 'found' : 'none', /none/);
    assert.ok(!(await call('list_files')).files.some((f: { path: string }) => f.path.startsWith('config/') || f.path.startsWith('logs/')));
    assert.match((await call('create_file', { path: 'config/policy2.json', content: '{}' })).error, /not approved|not exposed/);
    assert.match((await call('edit', { path: 'config/policy.json', old_text: 'secret', new_text: 'x', expected_sha256: '0'.repeat(64) })).error, /not exposed|not editable/);
    assert.equal(await readFile(policyFile, 'utf8'), '{"secret":"policy"}');
  } finally { await client.close(); await service.close(); }
});

// A deterministic spread of exact policies: legacy construction and migrated-v2 construction must agree.
const subsets = (all: string[], seed: number) => all.filter((_, i) => ((seed >> i) & 1) === 1 || i === 0);
test('differential: random exact v1 policies behave identically through the legacy and the compiled path', async t => {
  const m = await makeRepo(t, { 'src/extra.js': 'export const extra = 1;\n', 'docs/guide.md': '# guide\n' });
  const all = [...defaultPolicy.files, 'src/extra.js', 'docs/guide.md'];
  let state = 12345;
  const rand = () => (state = (state * 1103515245 + 12345) & 0x7fffffff);
  for (let n = 0; n < 24; n++) {
    const files = subsets(all, rand());
    const editable = files.filter(f => f.startsWith('src/') && rand() % 2 === 0);
    const tests = files.filter(f => f.startsWith('test/'));
    const policy: RepoPolicy = { files, editable, tests, ...(rand() % 3 === 0 ? { creatable: editable.slice(0, 1) } : {}) };
    const legacy = await RepoWorkspace.create(m.root, structuredClone(policy)).then(r => m.track(r), e => e as Error);
    const compiled = await RepoWorkspace.create(m.root, compilePolicy(loadPolicy(migrateV1(structuredClone(policy))))).then(r => m.track(r), e => e as Error);
    if (legacy instanceof Error || compiled instanceof Error) {
      assert.equal(legacy instanceof Error, compiled instanceof Error, JSON.stringify(policy));
      assert.equal((legacy as Error).message, (compiled as Error).message);
      continue;
    }
    const strip = (x: Record<string, unknown>) => { const { identity, head, status_captured_at, ...rest } = x as Record<string, any>; return rest; };
    assert.deepEqual(strip(await legacy.info() as Record<string, unknown>), strip(await compiled.info() as Record<string, unknown>), JSON.stringify(policy));
    for (const f of [...all, '../x', '.env', 'nope']) {
      const a: string = await legacy.read(f).then(r => r.sha256, e => (e as Error).message);
      const b: string = await compiled.read(f).then(r => r.sha256, e => (e as Error).message);
      assert.equal(a, b, `${f} under ${JSON.stringify(policy)}`);
    }
    assert.deepEqual(await legacy.search('export'), await compiled.search('export').then(r => ({ ...r })));
    assert.deepEqual((await legacy.diff()).diff, (await compiled.diff()).diff);
    for (const f of editable) assert.equal(await legacy.edit(f, 'zzz-not-there', 'x', '0'.repeat(64)).then(() => 'ok', e => (e as Error).message), await compiled.edit(f, 'zzz-not-there', 'x', '0'.repeat(64)).then(() => 'ok', e => (e as Error).message));
    for (const f of ['README.md', 'src/clamp.js']) assert.equal(await legacy.edit(f, 'zzz', 'x', '0'.repeat(64)).then(() => 'ok', e => (e as Error).message), await compiled.edit(f, 'zzz', 'x', '0'.repeat(64)).then(() => 'ok', e => (e as Error).message));
  }
  await writeFile(path.join(m.root, 'unused'), '');
});
