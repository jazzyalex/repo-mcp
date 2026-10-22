import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { prepareFixture } from '../src/fixture.js';
import { defaultPolicy } from '../src/repo.js';
import { migrateV1 } from '../src/policy.js';
import { sha256 } from '../src/errors.js';
import { startMultiRepoServer } from '../src/multirepo-server.js';
import { EXEC_OUTPUT_CAP_BYTES, EXEC_PAGE_BYTES } from '../src/exec-tool.js';
import { bindRegisteredTask, issueWorkspaceGrant, registerRepository, revokeWorkspace, setRegisteredTaskPhase } from '../src/multirepo-state.js';
import { StateStore } from '../src/task-state.js';

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

type Ctx = {
  client: Client; stateDir: string; base: string; root: string; token: string; workspaceId: string;
  service: Awaited<ReturnType<typeof startMultiRepoServer>>;
  openCode: (taskId: string, requestId: string, exec: boolean) => Promise<{ token: string; workspaceId: string }>;
};

async function withService(run: (ctx: Ctx) => Promise<void>, options: { exec?: boolean; closeService?: boolean } = {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-exec-')));
  const stateDir = path.join(base, 'state');
  const root = path.join(base, 'repo');
  await prepareFixture(root);
  const policyPath = path.join(base, 'policy.json');
  await writeFile(policyPath, JSON.stringify(migrateV1(defaultPolicy)));
  await registerRepository({ stateDir, repositoryId: 'repo', root: await realpath(root), policyPath: await realpath(policyPath) });
  await bindRegisteredTask({ stateDir, repositoryId: 'repo', taskId: 'task' });
  const service = await startMultiRepoServer(stateDir, 0);
  const client = new Client({ name: 'exec-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  let serviceClosed = false;
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url)));
    const openCode = async (taskId: string, requestId: string, exec: boolean) => {
      const grant = await issueWorkspaceGrant({ stateDir, taskId, ...(exec ? { exec: true } : {}) });
      assert.equal(grant.exec, exec);
      const repositoryId = taskId === 'task' ? 'repo' : 'repo2';
      const opened = await call(client, 'workspace_open', {
        repository_id: repositoryId, task_id: taskId, mode: 'code', request_id: requestId, write_grant: grant.write_grant
      });
      assert.equal(opened.error, false, String(opened.data));
      return { token: opened.data.workspace_token as string, workspaceId: opened.data.selection.workspace_id as string };
    };
    const opened = await openCode('task', 'open-code', options.exec ?? true);
    await run({
      client, stateDir, base, root: await realpath(root), token: opened.token, workspaceId: opened.workspaceId, openCode,
      service: { ...service, close: async () => { serviceClosed = true; await service.close(); } }
    });
  } finally {
    await client.close().catch(() => {});
    if (!serviceClosed) await service.close();
    await rm(base, { recursive: true, force: true });
  }
}

const exec = (client: Client, token: string, requestId: string, cmd: string, extra: Record<string, unknown> = {}) =>
  call(client, 'exec', { workspace_token: token, request_id: requestId, cmd, ...extra });
const poll = (client: Client, token: string, sessionId: string, extra: Record<string, unknown> = {}) =>
  call(client, 'exec_poll', { workspace_token: token, session_id: sessionId, ...extra });

async function readAll(client: Client, token: string, first: any) {
  let text = first.output as string;
  let cursor = first.cursor as string;
  let last = first;
  let pages = 1;
  while (last.has_more) {
    const next = await poll(client, token, first.session_id, { cursor, wait_ms: 5_000 });
    assert.equal(next.error, false, String(next.data));
    assert.ok(Buffer.byteLength(next.data.output, 'utf8') <= EXEC_PAGE_BYTES);
    text += next.data.output;
    cursor = next.data.cursor;
    last = next.data;
    pages++;
  }
  return { text, last, pages };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function storedSession(stateDir: string, sessionId: string) {
  const store = await StateStore.open(stateDir);
  return store.read<any>(`exec-sessions/task/${sessionId}.json`, 'exec-session-v1');
}

test('exec runs a command in the repo root with the exec environment and redacts tokens', async () => {
  await withService(async ({ client, token, root, stateDir }) => {
    const info = await call(client, 'repo_info', { workspace_token: token });
    assert.equal(info.error, false, String(info.data));
    assert.ok(info.data.capabilities.workspace_capabilities.includes('exec'));
    const fake = `ws1.k1.${'a'.repeat(32)}.${'B'.repeat(43)}`;
    const result = await exec(client, token, 'echo-1', `echo hello; pwd; echo "$TERM $CI $NO_COLOR $PAGER"; echo ${fake}; echo err >&2`);
    assert.equal(result.error, false, String(result.data));
    assert.equal(result.data.state, 'exited');
    assert.equal(result.data.exit_code, 0);
    assert.equal(result.data.has_more, false);
    const lines = result.data.output.split('\n');
    assert.equal(lines[0], 'hello');
    assert.equal(lines[1], root);
    assert.equal(lines[2], 'dumb 1 1 cat');
    assert.equal(lines[3], '[redacted-token]');
    assert.equal(lines[4], 'err');
    assert.match(result.data.session_id, /^[a-f0-9]{32}$/);
    assert.equal(result.data.scope.task_id, 'task');
    const record = await storedSession(stateDir, result.data.session_id);
    assert.equal(record.state, 'exited');
    const logFile = path.join(stateDir, 'exec-logs', 'task', `${result.data.session_id}.log`);
    assert.equal((await stat(logFile)).mode & 0o777, 0o600);
    const audit = await readFile(path.join(stateDir, 'multirepo-audit.jsonl'), 'utf8');
    assert.match(audit, /"phase":"started"/);
    assert.match(audit, /"phase":"completed"/);
    assert.doesNotMatch(audit, new RegExp(token.replace(/[.]/g, '\\.')));
  });
});

test('exec reports a nonzero exit code and replaces invalid UTF-8', async () => {
  await withService(async ({ client, token }) => {
    const result = await exec(client, token, 'fail-1', "printf 'bad \\377 byte\\n'; exit 3");
    assert.equal(result.error, false, String(result.data));
    assert.equal(result.data.state, 'exited');
    assert.equal(result.data.exit_code, 3);
    assert.equal(result.data.output, 'bad � byte\n');
  });
});

test('exec_poll returns long output across pages without loss', async () => {
  await withService(async ({ client, token }) => {
    const first = await exec(client, token, 'seq-1', 'seq 1 30000');
    assert.equal(first.error, false, String(first.data));
    const { text, last, pages } = await readAll(client, token, first.data);
    assert.ok(pages >= 3, `expected several pages, got ${pages}`);
    const expected = Array.from({ length: 30000 }, (_, i) => String(i + 1)).join('\n') + '\n';
    assert.equal(text, expected);
    assert.equal(last.state, 'exited');
    assert.equal(last.exit_code, 0);
    const bad = await poll(client, token, first.data.session_id, { cursor: String(Buffer.byteLength(expected) + 1) });
    assert.equal(bad.error, true);
  });
});

test('exec_cancel stops a sleeping command group and is idempotent', async () => {
  await withService(async ({ client, token, base }) => {
    const pidFile = path.join(base, 'cancel.pid');
    const started = await exec(client, token, 'sleep-1', `sleep 30 & echo $! > ${pidFile}; wait`, { yield_ms: 500 });
    assert.equal(started.error, false, String(started.data));
    assert.equal(started.data.state, 'running');
    const sleeper = Number((await readFile(pidFile, 'utf8')).trim());
    assert.ok(alive(sleeper));
    const t0 = Date.now();
    const cancelled = await call(client, 'exec_cancel', { workspace_token: token, session_id: started.data.session_id, request_id: 'cancel-1' });
    assert.equal(cancelled.error, false, String(cancelled.data));
    assert.equal(cancelled.data.state, 'cancelled');
    assert.equal(cancelled.data.reason, 'cancelled_by_request');
    assert.ok(Date.now() - t0 < 8_000);
    assert.equal(alive(sleeper), false, 'the background child in the process group must be gone');
    const again = await call(client, 'exec_cancel', { workspace_token: token, session_id: started.data.session_id, request_id: 'cancel-2' });
    assert.equal(again.error, false, String(again.data));
    assert.equal(again.data.state, 'cancelled');
    assert.equal(again.data.cancel_applied, false);
  });
});

test('exec enforces the wall-clock limit', async () => {
  await withService(async ({ client, token }) => {
    const result = await exec(client, token, 'timeout-1', 'echo before; sleep 30', { timeout_s: 1, yield_ms: 15_000 });
    assert.equal(result.error, false, String(result.data));
    assert.equal(result.data.state, 'timed_out');
    assert.equal(result.data.output, 'before\n');
  });
});

test('exec caps stored output, kills the command and marks it truncated', async () => {
  await withService(async ({ client, token, stateDir }) => {
    const result = await exec(client, token, 'cap-1', "head -c 6000000 /dev/zero | tr '\\0' a; echo never", { yield_ms: 20_000 });
    assert.equal(result.error, false, String(result.data));
    assert.equal(result.data.state, 'failed');
    assert.match(result.data.reason, /output_limit/);
    assert.equal(result.data.truncated, true);
    assert.equal(result.data.output_bytes, EXEC_OUTPUT_CAP_BYTES);
    const logFile = path.join(stateDir, 'exec-logs', 'task', `${result.data.session_id}.log`);
    assert.equal((await stat(logFile)).size, EXEC_OUTPUT_CAP_BYTES);
  });
});

test('exec replays the same request_id without running again and rejects a different cmd', async () => {
  await withService(async ({ client, token, base }) => {
    const counter = path.join(base, 'count.txt');
    const cmd = `echo run >> ${counter}; echo done`;
    const first = await exec(client, token, 'replay-1', cmd);
    assert.equal(first.error, false, String(first.data));
    assert.equal(first.data.state, 'exited');
    const second = await exec(client, token, 'replay-1', cmd);
    assert.equal(second.error, false, String(second.data));
    assert.equal(second.data.session_id, first.data.session_id);
    assert.equal(second.data.output, 'done\n');
    assert.equal(await readFile(counter, 'utf8'), 'run\n');
    const different = await exec(client, token, 'replay-1', 'echo other');
    assert.equal(different.error, true);
    assert.match(String(different.data), /different cmd/);
  });
});

test('a second exec while one runs is rejected and names the running session', async () => {
  await withService(async ({ client, token }) => {
    const running = await exec(client, token, 'busy-1', 'sleep 30', { yield_ms: 0 });
    assert.equal(running.error, false, String(running.data));
    assert.equal(running.data.state, 'running');
    const second = await exec(client, token, 'busy-2', 'echo hi');
    assert.equal(second.error, true);
    assert.ok(String(second.data).includes(running.data.session_id));
    const cancelled = await call(client, 'exec_cancel', { workspace_token: token, session_id: running.data.session_id, request_id: 'busy-cancel' });
    assert.equal(cancelled.data.state, 'cancelled');
    const third = await exec(client, token, 'busy-3', 'echo hi');
    assert.equal(third.error, false, String(third.data));
    assert.equal(third.data.output, 'hi\n');
  });
});

test('a code workspace without an exec grant has no exec capability', async () => {
  await withService(async ({ client, token }) => {
    const info = await call(client, 'repo_info', { workspace_token: token });
    assert.equal(info.error, false, String(info.data));
    assert.equal(info.data.capabilities.workspace_capabilities.includes('exec'), false);
    const result = await exec(client, token, 'noexec-1', 'echo hi');
    assert.equal(result.error, true);
    assert.match(String(result.data), /without exec enabled/);
  }, { exec: false });
});

test('inspect and review workspaces never get exec', async () => {
  await withService(async ({ client, token, stateDir }) => {
    const inspect = await call(client, 'workspace_open', { repository_id: 'repo', task_id: 'task', mode: 'inspect', request_id: 'open-inspect' });
    assert.equal(inspect.error, false, String(inspect.data));
    assert.deepEqual(inspect.data.selection.capabilities, ['read']);
    const inspectExec = await exec(client, inspect.data.workspace_token, 'inspect-exec', 'echo hi');
    assert.equal(inspectExec.error, true);
    assert.match(String(inspectExec.data), /does not grant exec/);
    await call(client, 'workspace_close', { workspace_token: inspect.data.workspace_token, request_id: 'close-inspect' });
    await call(client, 'workspace_close', { workspace_token: token, request_id: 'close-code' });
    await setRegisteredTaskPhase({ stateDir, taskId: 'task', phase: 'review' });
    const review = await call(client, 'workspace_open', { repository_id: 'repo', task_id: 'task', mode: 'review', request_id: 'open-review' });
    assert.equal(review.error, false, String(review.data));
    assert.deepEqual(review.data.selection.capabilities, ['read']);
    const reviewExec = await exec(client, review.data.workspace_token, 'review-exec', 'echo hi');
    assert.equal(reviewExec.error, true);
  });
});

test('workspace_close cancels a running command', async () => {
  await withService(async ({ client, token, stateDir, base }) => {
    const pidFile = path.join(base, 'close.pid');
    const running = await exec(client, token, 'close-1', `echo $$ > ${pidFile}; sleep 30`, { yield_ms: 500 });
    assert.equal(running.data.state, 'running');
    const shell = Number((await readFile(pidFile, 'utf8')).trim());
    const closed = await call(client, 'workspace_close', { workspace_token: token, request_id: 'close-ws' });
    assert.equal(closed.error, false, String(closed.data));
    assert.equal(alive(shell), false);
    const record = await storedSession(stateDir, running.data.session_id);
    assert.equal(record.state, 'cancelled');
    assert.equal(record.reason, 'workspace_closed');
    const late = await poll(client, token, running.data.session_id);
    assert.equal(late.error, true);
  });
});

test('operator revoke cancels a running command within a few seconds', async () => {
  await withService(async ({ client, token, stateDir, workspaceId }) => {
    const running = await exec(client, token, 'revoke-1', 'sleep 30', { yield_ms: 300 });
    assert.equal(running.data.state, 'running');
    await revokeWorkspace({ stateDir, workspaceId });
    const deadline = Date.now() + 10_000;
    let record = await storedSession(stateDir, running.data.session_id);
    while (record.state === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200));
      record = await storedSession(stateDir, running.data.session_id);
    }
    assert.equal(record.state, 'cancelled');
    assert.equal(record.reason, 'workspace_no_longer_valid');
  });
});

test('broker shutdown cancels a running command', async () => {
  await withService(async ({ client, token, stateDir, service }) => {
    const running = await exec(client, token, 'shutdown-1', 'sleep 30', { yield_ms: 300 });
    assert.equal(running.data.state, 'running');
    await client.close();
    await service.close();
    const record = await storedSession(stateDir, running.data.session_id);
    assert.equal(record.state, 'cancelled');
    assert.equal(record.reason, 'broker_shutdown');
  });
});

test('a session left running by a dead broker is reported uncertain and never re-run', async () => {
  await withService(async ({ client, token, stateDir, workspaceId, base }) => {
    const counter = path.join(base, 'uncertain.txt');
    const cmd = `echo ran >> ${counter}`;
    const sessionId = sha256(`exec-session\0${workspaceId}\0uncertain-1`).slice(0, 32);
    const store = await StateStore.open(stateDir);
    await store.write(`exec-sessions/task/${sessionId}.json`, 'exec-session-v1', {
      session_id: sessionId, workspace_id: workspaceId, repository_id: 'repo', task_id: 'task', request_id: 'uncertain-1',
      request_digest: sha256(`${workspaceId}\0${cmd}`), cmd, cmd_sha256: sha256(cmd), cmd_length: cmd.length, timeout_s: 600,
      state: 'running', reason: null, exit_code: null, signal: null, output_bytes: 0, truncated: false,
      broker_instance: 'f'.repeat(32), broker_pid: 999999, created_at: new Date().toISOString(), started_at: null, ended_at: null, duration_ms: null
    });
    const replay = await exec(client, token, 'uncertain-1', cmd);
    assert.equal(replay.error, false, String(replay.data));
    assert.equal(replay.data.session_id, sessionId);
    assert.equal(replay.data.state, 'uncertain');
    await assert.rejects(readFile(counter, 'utf8'));
    // An uncertain session does not block a new command.
    const fresh = await exec(client, token, 'uncertain-2', 'echo ok');
    assert.equal(fresh.data.state, 'exited');
  });
});

test('another workspace cannot poll or cancel a session', async () => {
  await withService(async ({ client, token, stateDir, base, openCode }) => {
    const root2 = path.join(base, 'repo2');
    await prepareFixture(root2);
    const policy2 = path.join(base, 'policy2.json');
    await writeFile(policy2, JSON.stringify(migrateV1(defaultPolicy)));
    await registerRepository({ stateDir, repositoryId: 'repo2', root: await realpath(root2), policyPath: await realpath(policy2) });
    await bindRegisteredTask({ stateDir, repositoryId: 'repo2', taskId: 'task2' });
    const other = await openCode('task2', 'open-code-2', true);
    const mine = await exec(client, token, 'own-1', 'echo mine');
    assert.equal(mine.error, false, String(mine.data));
    const stolen = await poll(client, other.token, mine.data.session_id);
    assert.equal(stolen.error, true);
    assert.match(String(stolen.data), /Unknown exec session/);
    const cancel = await call(client, 'exec_cancel', { workspace_token: other.token, session_id: mine.data.session_id, request_id: 'steal-cancel' });
    assert.equal(cancel.error, true);
    const own = await poll(client, token, mine.data.session_id);
    assert.equal(own.data.output, 'mine\n');
  });
});

test('retention keeps at most 20 sessions per task', async () => {
  await withService(async ({ client, token, stateDir }) => {
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) {
      const result = await exec(client, token, `keep-${i}`, `echo ${i}`);
      assert.equal(result.error, false, String(result.data));
      ids.push(result.data.session_id);
    }
    const store = await StateStore.open(stateDir);
    const names = await store.list('exec-sessions/task');
    assert.equal(names.length, 20);
    const logs = await store.list('exec-logs/task');
    assert.equal(logs.length, 20);
    assert.equal(names.includes(`${ids[0]}.json`), false);
    assert.equal(names.includes(`${ids[22]}.json`), true);
    const gone = await poll(client, token, ids[0]);
    assert.equal(gone.error, true);
  });
});
