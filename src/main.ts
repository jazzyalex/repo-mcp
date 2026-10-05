import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { defaultStateDir } from './task-state.js';
const root = process.env.REPO_ROOT;
if (!root) throw new Error('Set REPO_ROOT to the repository checkout to serve.');
const port = Number(process.env.PORT ?? '8787');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be between 1024 and 65535.');
const policy = process.env.REPO_MCP_POLICY ? JSON.parse(await readFile(process.env.REPO_MCP_POLICY, 'utf8')) : undefined;
// Without REPO_MCP_TASK_ID the server runs untracked: no durable binding, lock or request outcomes.
const taskId = process.env.REPO_MCP_TASK_ID;
const task = taskId ? {
  taskId,
  stateDir: process.env.REPO_MCP_STATE_DIR || defaultStateDir(),
  allowDetached: process.env.REPO_MCP_ALLOW_DETACHED === '1',
  recoverStaleLock: process.env.REPO_MCP_RECOVER_STALE_LOCK === '1'
} : undefined;
const protectedPaths = process.env.REPO_MCP_POLICY ? [path.resolve(process.env.REPO_MCP_POLICY)] : [];
const service = await startServer(root, port, path.resolve(process.env.REPO_MCP_AUDIT ?? '.trial/audit.jsonl'), policy, { task, protectedPaths });
console.log(`Repo MCP listening at ${service.url} (loopback only${task ? `, task ${task.taskId}` : ', untracked'}).`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => { await service.close(); process.exit(0); });
