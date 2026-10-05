import { RepoWorkspace } from '../../src/repo.js';
import { loadPolicy, policyDigest, compilePolicyFor } from '../../src/policy.js';

// Test child process: runs one task-mode create_file and kills itself (SIGKILL) at a named path-hook stage, so the
// parent test sees the on-disk and task-state results of a real crash. Not a test file: the runner globs test/*.test.ts.

type Args = { root: string; stateDir: string; taskId: string; doc: Record<string, unknown>; crashAt: string; path: string; content: string; requestId: string };
const args = JSON.parse(process.argv[2]) as Args;
const loaded = loadPolicy(args.doc);
const repo = await RepoWorkspace.create(args.root, await compilePolicyFor(loaded, { root: args.root }), {
  task: { stateDir: args.stateDir, taskId: args.taskId, policyDigest: policyDigest(loaded), recoverStaleLock: true },
  pathHook: stage => { if (stage === args.crashAt) process.kill(process.pid, 'SIGKILL'); }
});
await repo.createFile(args.path, args.content, args.requestId);
await repo.close();
process.exit(0);
