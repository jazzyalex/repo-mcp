import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { prepareFixture } from '../src/fixture.js';
import { defaultPolicy } from '../src/repo.js';
import { migrateV1 } from '../src/policy.js';
import { setTaskPhase } from '../src/task.js';
import { startServer } from '../src/server.js';

test('MCP server binds a task, reports identity and replays request IDs safely', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-server-task-')));
  const root = path.join(base, 'repo');
  const stateDir = path.join(base, 'state');
  await prepareFixture(root);
  const policy = migrateV1(defaultPolicy); // v2 document accepted directly
  const service = await startServer(root, 0, path.join(base, 'audit.jsonl'), policy, { task: { stateDir, taskId: 'srv-1' } });
  const client = new Client({ name: 'task-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url)));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return { error: r.isError === true, data: r.isError ? (r.content as { text: string }[])[0].text : JSON.parse((r.content as { text: string }[])[0].text) };
    };
    const info = (await call('repo_info')).data;
    assert.equal(info.identity.root, root);
    assert.equal(info.task.task_id, 'srv-1');
    assert.equal(info.task.phase, 'coding');
    assert.equal(info.capabilities.policy_version, 2);
    assert.equal(info.capabilities.request_ids, true);
    const tools = await client.listTools();
    for (const name of ['read', 'search', 'git_diff', 'list_files']) assert.ok('cursor' in (tools.tools.find(t => t.name === name)!.inputSchema.properties ?? {}), name);
    assert.deepEqual(tools.tools.map(t => t.name).sort(), ['repo_info', 'list_files', 'search', 'read', 'edit', 'create_file', 'run_tests', 'git_diff'].sort());
    for (const name of ['edit', 'create_file']) assert.ok('request_id' in (tools.tools.find(t => t.name === name)!.inputSchema.properties ?? {}), name);

    await assert.rejects(startServer(root, 0, undefined, policy, { task: { stateDir, taskId: 'srv-2' } }), /already owned/);

    const source = (await call('read', { path: 'src/clamp.js' })).data;
    const args = { path: 'src/clamp.js', old_text: 'max - 1', new_text: 'max', expected_sha256: source.sha256, request_id: 'chatgpt-req-1' };
    const first = await call('edit', args);
    assert.equal(first.error, false, String(first.data));
    const retry = await call('edit', args);
    assert.equal(retry.error, false, String(retry.data));
    assert.equal(retry.data.already_applied, true);
    assert.equal(retry.data.after_sha256, first.data.after_sha256);
    assert.equal((await readFile(path.join(root, 'src/clamp.js'), 'utf8')).split('Math.max(value, min), max)').length, 2);

    await setTaskPhase(stateDir, 'srv-1', 'review');
    const frozen = await call('edit', { ...args, old_text: 'RangeError', new_text: 'TypeError', expected_sha256: first.data.after_sha256, request_id: 'chatgpt-req-2' });
    assert.equal(frozen.error, true);
    assert.match(frozen.data, /review phase/);
    assert.equal((await call('repo_info')).data.task.phase, 'review');
  } finally { await client.close(); await service.close(); }
  // close() releases the checkout lock for the next server.
  const next = await startServer(root, 0, undefined, migrateV1(defaultPolicy), { task: { stateDir, taskId: 'srv-1' } });
  await next.close();
  await assert.rejects(startServer(root, 0, undefined, { version: 3 }), /policy version/);
  await rm(base, { recursive: true, force: true });
});

test('default (untracked) mode neither advertises nor accepts request IDs', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-server-default-')));
  const root = path.join(base, 'repo');
  await prepareFixture(root);
  const service = await startServer(root, 0);
  const client = new Client({ name: 'default-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url)));
    const info = JSON.parse(((await client.callTool({ name: 'repo_info', arguments: {} })).content as { text: string }[])[0].text);
    assert.equal(info.capabilities.request_ids, false);
    assert.equal(info.capabilities.task_state, false);
    assert.equal(info.task, null);
    const tools = await client.listTools();
    for (const name of ['read', 'search', 'git_diff', 'list_files']) assert.ok('cursor' in (tools.tools.find(t => t.name === name)!.inputSchema.properties ?? {}), name);
    assert.deepEqual(tools.tools.map(t => t.name).sort(), ['repo_info', 'list_files', 'search', 'read', 'edit', 'create_file', 'run_tests', 'git_diff'].sort());
    for (const name of ['edit', 'create_file']) assert.ok(!('request_id' in (tools.tools.find(t => t.name === name)!.inputSchema.properties ?? {})), name);
    assert.doesNotMatch(client.getInstructions() ?? '', /request_id/);
    const source = JSON.parse(((await client.callTool({ name: 'read', arguments: { path: 'src/clamp.js' } })).content as { text: string }[])[0].text);
    const stray = await client.callTool({ name: 'edit', arguments: { path: 'src/clamp.js', old_text: 'max - 1', new_text: 'max', expected_sha256: source.sha256, request_id: 'r1' } }).catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
    assert.equal(stray.isError, true, 'an unsupported request_id is rejected, never silently dropped');
    const edit = await client.callTool({ name: 'edit', arguments: { path: 'src/clamp.js', old_text: 'max - 1', new_text: 'max', expected_sha256: source.sha256 } });
    assert.ok(!edit.isError, JSON.stringify(edit));
  } finally { await client.close(); await service.close(); await rm(base, { recursive: true, force: true }); }
});
