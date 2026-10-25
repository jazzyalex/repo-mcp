import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { startMultiRepoServer } from '../src/multirepo-server.js';
import { clientAuthPaths, readClientToken } from '../src/client-auth.js';
import { createBridge, parseBridgeArgs, prefixedName } from '../src/stdio-bridge.js';

async function broker(t: { after(fn: () => Promise<void>): void }) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-client-auth-')));
  const stateDir = path.join(base, 'state');
  const service = await startMultiRepoServer(stateDir, 0);
  t.after(async () => { await service.close(); await rm(base, { recursive: true, force: true }); });
  return { stateDir, service };
}

const post = (url: string, headers: Record<string, string> = {}) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
});

test('the broker refuses MCP requests without the client token', async t => {
  const { stateDir, service } = await broker(t);
  assert.equal((await post(service.url)).status, 401);
  assert.equal((await post(service.url, { Authorization: 'Bearer ' + '0'.repeat(64) })).status, 401);
  assert.equal((await post(service.url, { Authorization: service.clientToken })).status, 401, 'the Bearer scheme is required');
  assert.notEqual((await post(service.url, { Authorization: `Bearer ${service.clientToken}` })).status, 401);
  // The token and its header file are owner-only and stable across starts.
  const paths = clientAuthPaths(stateDir);
  for (const file of [paths.token, paths.header]) assert.equal((await stat(file)).mode & 0o077, 0);
  assert.equal(await readClientToken(stateDir), service.clientToken);
});

test('the stdio bridge forwards with the token and prefixes generic tool names', async t => {
  const { service } = await broker(t);
  const { server, client: upstream } = await createBridge({ url: service.url, token: service.clientToken });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'bridge-test', version: '1' });
  await client.connect(b);
  t.after(async () => { await client.close(); await upstream.close(); });
  const names = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ['repo_read', 'repo_edit', 'repo_search', 'repo_info', 'service_info', 'workspace_open', 'repository_list']) assert.ok(names.includes(name), name);
  for (const name of ['read', 'edit', 'search']) assert.ok(!names.includes(name), name);
  const info = await client.callTool({ name: 'service_info', arguments: {} });
  assert.notEqual(info.isError, true);
  assert.equal((await client.callTool({ name: 'read', arguments: {} })).isError, true, 'an unprefixed generic name is unknown');
  assert.equal(prefixedName('finish'), 'repo_finish');
  assert.equal(prefixedName('repo_info'), 'repo_info');
});

test('the stdio bridge fails with a wrong token and accepts only loopback URLs', async t => {
  const { service } = await broker(t);
  await assert.rejects(createBridge({ url: service.url, token: 'f'.repeat(64) }));
  assert.throws(() => parseBridgeArgs(['--url', 'https://example.com/mcp']), /loopback/);
  assert.equal(parseBridgeArgs(['--original-names']).originalNames, true);
});
