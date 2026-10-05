import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { loadPolicy, policyDigest } from './policy.js';
import { resolveIdentity } from './identity.js';
import { startServer } from './server.js';
import { StateStore, defaultStateDir } from './task-state.js';
import { readActiveService, rootDigest } from './service-control.js';
import { taskStatus } from './task.js';

const stateDir = process.env.REPO_MCP_STATE_DIR || defaultStateDir();
const store = await StateStore.open(stateDir);
const active = await readActiveService(store);
if (!active) throw new Error('No active Repo MCP service binding is configured.');

const root = await realpath(active.root);
if (root !== active.root || rootDigest(root) !== active.root_digest) throw new Error('Active service root no longer matches its configured canonical identity.');
const policyPath = await realpath(active.policy_path);
if (policyPath !== active.policy_path) throw new Error('Active service policy path is no longer canonical.');
const policy = loadPolicy(JSON.parse(await readFile(policyPath, 'utf8')));
if (policyDigest(policy) !== active.policy_digest) throw new Error('Active service policy digest changed; rebind before starting.');
const identity = await resolveIdentity(root);
const status = await taskStatus(stateDir, active.task_id);
if (status.completion) throw new Error(`Task ${active.task_id} is completed and cannot be reopened.`);
if (identity.root !== status.root || identity.git_dir !== status.git_dir || identity.common_dir !== status.common_dir ||
    identity.branch !== status.branch || identity.head !== status.head || status.policy_digest !== active.policy_digest) {
  throw new Error('Active service task binding no longer matches the live checkout. Reconcile/rebind before starting.');
}
if (identity.detached && !active.allow_detached) throw new Error('Active service binding does not permit detached HEAD.');
const stateCanonical = await realpath(stateDir);
const relState = path.relative(root, stateCanonical);
const relRoot = path.relative(stateCanonical, root);
if (relState === '' || (!relState.startsWith('..') && !path.isAbsolute(relState)) || relRoot === '' || (!relRoot.startsWith('..') && !path.isAbsolute(relRoot))) {
  throw new Error('Active service state directory must remain outside the served repository.');
}

const service = await startServer(root, active.port, active.audit_path, policy, {
  task: {
    taskId: active.task_id,
    stateDir,
    allowDetached: active.allow_detached
  },
  serviceGeneration: active.generation,
  protectedPaths: [active.policy_path, stateDir]
});
console.log(`Repo MCP service generation ${active.generation} listening at ${service.url} for task ${active.task_id}.`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => {
  await service.close();
  process.exit(0);
});
