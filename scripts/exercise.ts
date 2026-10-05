import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { prepareFixture } from '../src/fixture.js';
import { startServer } from '../src/server.js';

export async function exercise(modern: boolean) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-smoke-'));
  const root = path.join(base, 'repo');
  await prepareFixture(root);
  const service = await startServer(root, 0);
  const client = new Client({ name: 'repo-mcp-local-smoke', version: '0.1.0' }, { versionNegotiation: { mode: modern ? { pin: '2026-07-28' } : 'legacy' } });
  const calls: { tool: string; ok: boolean; result?: unknown }[] = [];
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url)));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t => t.name).sort(), ['create_file', 'edit', 'git_diff', 'list_files', 'read', 'repo_info', 'run_tests', 'search']);
    assert.equal(tools.tools.find(t => t.name === 'edit')?.annotations?.readOnlyHint, false);
    assert.equal(tools.tools.find(t => t.name === 'read')?.annotations?.readOnlyHint, true);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      const content = result.content as { type: string; text?: string }[];
      const data = JSON.parse(content.find(c => c.type === 'text')!.text!);
      calls.push({ tool: name, ok: true, result: data });
      return data;
    };
    await call('repo_info');
    const beforeTests = await call('run_tests');
    assert.equal(beforeTests.exit_code, 1);
    assert.match(beforeTests.stdout, /fail 3/);
    const source = await call('read', { path: 'src/clamp.js' });
    await call('read', { path: 'test/clamp.test.js' });
    await call('edit', { path: 'src/clamp.js', old_text: 'max - 1', new_text: 'max', expected_sha256: source.sha256 });
    const afterTests = await call('run_tests');
    assert.equal(afterTests.exit_code, 0);
    assert.match(afterTests.stdout, /pass 6/);
    const diff = await call('git_diff');
    assert.match(diff.diff, /max - 1/);
    assert.doesNotMatch(diff.diff, /diff --git a\/test/);
    const escape = await client.callTool({ name: 'read', arguments: { path: '../outside.txt' } });
    assert.equal(escape.isError, true);
    const stale = await client.callTool({ name: 'edit', arguments: { path: 'src/clamp.js', old_text: 'max', new_text: 'min', expected_sha256: source.sha256 } });
    assert.equal(stale.isError, true);
    return { client: 'Local SDK smoke client, NOT ChatGPT', era: client.getProtocolEra(), tools: tools.tools.map(t => t.name), tests_before: { passed: 3, failed: 3 }, tests_after: { passed: 6, failed: 0 }, path_escape_rejected: true, stale_edit_rejected: true, calls };
  } finally { await client.close(); await service.close(); await rm(base, { recursive: true, force: true }); }
}
