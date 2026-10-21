import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { prepareFixture } from '../src/fixture.js';
import { defaultPolicy, execute } from '../src/repo.js';
import { migrateV1 } from '../src/policy.js';
import { startMultiRepoServer } from '../src/multirepo-server.js';
import { MCP_REPORT_MAX_BYTES, readMcpReportForRequest } from '../src/mcp-report.js';
import { bindRegisteredTask, registerRepository, setRegisteredTaskPhase } from '../src/multirepo-state.js';

type ToolReply = { error: boolean; data: any };

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[]).find(item => item.type === 'text')?.text ?? '';
    if (result.isError) return { error: true, data: text };
    return { error: false, data: JSON.parse(text) };
  } catch (error) {
    return { error: true, data: error instanceof Error ? error.message : String(error) };
  }
}

async function withService(run: (ctx: {
  client: Client; stateDir: string; inspect: { token: string; requestId: string }; review: { token: string; requestId: string };
}) => Promise<void>) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-report-')));
  const stateDir = path.join(base, 'state');
  const root = path.join(base, 'repo');
  await prepareFixture(root);
  const policyPath = path.join(base, 'policy.json');
  await writeFile(policyPath, JSON.stringify(migrateV1(defaultPolicy)));
  const runGit = async (...args: string[]) => {
    const result = await execute('/usr/bin/git', [
      '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=T', '-c', 'user.email=t@example.invalid',
      '-c', 'commit.gpgsign=false', ...args
    ], root, 60_000);
    assert.equal(result.exit_code, 0, result.stderr);
  };
  await writeFile(path.join(root, 'NOTES.md'), 'review target\n');
  await runGit('add', '--', 'NOTES.md');
  await runGit('commit', '-m', 'review target');
  await registerRepository({ stateDir, repositoryId: 'repo', root: await realpath(root), policyPath: await realpath(policyPath) });
  await bindRegisteredTask({ stateDir, repositoryId: 'repo', taskId: 'inspect-task' });
  const service = await startMultiRepoServer(stateDir, 0);
  const client = new Client({ name: 'mcp-report-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url)));
    const inspect = await call(client, 'workspace_open', { repository_id: 'repo', task_id: 'inspect-task', mode: 'inspect', request_id: 'open-inspect-report' });
    assert.equal(inspect.error, false, String(inspect.data));
    await call(client, 'workspace_close', { workspace_token: inspect.data.workspace_token, request_id: 'close-inspect-first' });
    await setRegisteredTaskPhase({ stateDir, taskId: 'inspect-task', phase: 'review' });
    const review = await call(client, 'workspace_open', {
      repository_id: 'repo', task_id: 'inspect-task', mode: 'review', request_id: 'open-review-report',
      base_ref: 'HEAD^', head_ref: 'HEAD', scope_prefix: ''
    });
    assert.equal(review.error, false, String(review.data));
    // Re-open an inspect workspace beside the review one (inspect stays allowed in the review phase).
    const inspect2 = await call(client, 'workspace_open', { repository_id: 'repo', task_id: 'inspect-task', mode: 'inspect', request_id: 'open-inspect-report-2' });
    assert.equal(inspect2.error, false, String(inspect2.data));
    await run({
      client, stateDir,
      inspect: { token: inspect2.data.workspace_token, requestId: 'open-inspect-report-2' },
      review: { token: review.data.workspace_token, requestId: 'open-review-report' }
    });
  } finally {
    await client.close();
    await service.close();
    await rm(base, { recursive: true, force: true });
  }
}

const finish = (client: Client, token: string, outcome: string, md: string, requestId = 'finish-1') =>
  call(client, 'finish', { workspace_token: token, outcome, summary_markdown: md, request_id: requestId });

test('finish stores an inspect report that the coordinator reads by workspace_open request id', async () => {
  await withService(async ({ client, stateDir, inspect }) => {
    const md = '# Report\n\nAll good. é中\n';
    const ack = await finish(client, inspect.token, 'completed', md);
    assert.equal(ack.error, false, String(ack.data));
    assert.equal(ack.data.already_applied, false);
    assert.equal(ack.data.outcome, 'completed');
    assert.ok(ack.data.ack_id);
    const report = await readMcpReportForRequest(stateDir, inspect.requestId);
    assert.ok(report);
    assert.equal(report.summary_markdown, md);
    assert.equal(report.outcome, 'completed');
    assert.equal(report.provenance, 'MCP report');
    assert.equal(report.ack_id, ack.data.ack_id);
  });
});

test('finish is idempotent for identical content and rejects different content or outcome', async () => {
  await withService(async ({ client, stateDir, inspect }) => {
    const first = await finish(client, inspect.token, 'completed', 'same report');
    assert.equal(first.error, false, String(first.data));
    const again = await finish(client, inspect.token, 'completed', 'same report', 'finish-2');
    assert.equal(again.error, false, String(again.data));
    assert.equal(again.data.ack_id, first.data.ack_id);
    assert.equal(again.data.already_applied, true);
    const changed = await finish(client, inspect.token, 'completed', 'other report', 'finish-3');
    assert.equal(changed.error, true);
    assert.match(String(changed.data), /immutable|different report/i);
    const outcome = await finish(client, inspect.token, 'ship', 'same report', 'finish-4');
    assert.equal(outcome.error, true);
    assert.equal((await readMcpReportForRequest(stateDir, inspect.requestId))?.summary_markdown, 'same report');
  });
});

test('finish enforces outcome by workspace mode', async () => {
  await withService(async ({ client, stateDir, inspect, review }) => {
    const bad1 = await finish(client, inspect.token, 'ship', 'x');
    assert.equal(bad1.error, true);
    const bad2 = await finish(client, review.token, 'completed', 'x', 'finish-r1');
    assert.equal(bad2.error, true);
    assert.equal(await readMcpReportForRequest(stateDir, review.requestId), undefined);
    const ok = await finish(client, review.token, 'ship', 'Looks shippable.', 'finish-r2');
    assert.equal(ok.error, false, String(ok.data));
    const report = await readMcpReportForRequest(stateDir, review.requestId);
    assert.equal(report?.outcome, 'ship');
    assert.equal(report?.mode, 'review');
    // no-ship after ship is a different outcome and is rejected
    const flip = await finish(client, review.token, 'no-ship', 'Looks shippable.', 'finish-r3');
    assert.equal(flip.error, true);
  });
});

test('oversize reports are rejected and nothing is stored', async () => {
  await withService(async ({ client, stateDir, inspect }) => {
    const big = 'a'.repeat(MCP_REPORT_MAX_BYTES + 1);
    const result = await finish(client, inspect.token, 'completed', big);
    assert.equal(result.error, true);
    // multi-byte content that is under the character limit but over the byte limit
    const wide = '中'.repeat(Math.ceil(MCP_REPORT_MAX_BYTES / 3) + 1);
    assert.ok(Buffer.byteLength(wide) > MCP_REPORT_MAX_BYTES);
    const wideResult = await finish(client, inspect.token, 'completed', wide, 'finish-wide');
    assert.equal(wideResult.error, true);
    assert.equal(await readMcpReportForRequest(stateDir, inspect.requestId), undefined);
    const exact = await finish(client, inspect.token, 'completed', 'b'.repeat(MCP_REPORT_MAX_BYTES), 'finish-exact');
    assert.equal(exact.error, false, String(exact.data));
    assert.equal((await readMcpReportForRequest(stateDir, inspect.requestId))?.summary_markdown.length, MCP_REPORT_MAX_BYTES);
  });
});

test('finish after workspace_close is rejected', async () => {
  await withService(async ({ client, stateDir, inspect }) => {
    const closed = await call(client, 'workspace_close', { workspace_token: inspect.token, request_id: inspect.requestId });
    assert.equal(closed.error, false, String(closed.data));
    const result = await finish(client, inspect.token, 'completed', 'late');
    assert.equal(result.error, true);
    assert.equal(await readMcpReportForRequest(stateDir, inspect.requestId), undefined);
  });
});

test('a report delivered before workspace_close stays readable afterwards', async () => {
  await withService(async ({ client, stateDir, inspect }) => {
    assert.equal((await finish(client, inspect.token, 'completed', 'kept')).error, false);
    await call(client, 'workspace_close', { workspace_token: inspect.token, request_id: inspect.requestId });
    assert.equal((await readMcpReportForRequest(stateDir, inspect.requestId))?.summary_markdown, 'kept');
  });
});

test('readMcpReportForRequest returns undefined for unknown request ids', async () => {
  await withService(async ({ stateDir, inspect }) => {
    assert.equal(await readMcpReportForRequest(stateDir, 'no-such-request'), undefined);
    assert.equal(await readMcpReportForRequest(stateDir, inspect.requestId), undefined);
  });
  const empty = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-report-empty-')));
  try {
    assert.equal(await readMcpReportForRequest(path.join(empty, 'state'), 'anything'), undefined);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});
