import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { SafeError } from './errors.js';
import { resolveIdentity } from './identity.js';
import { compilePolicyFor, loadPolicy, policyDigest } from './policy.js';
import { StateStore, acquireLock, defaultStateDir } from './task-state.js';
import { bindTask, completeTask, isStage1BoundTask, recoverTaskStaleLocks, taskStatus, taskWriterLockStatus } from './task.js';
import {
  installOrReloadStable,
  migrateLegacyServer,
  readActiveService,
  rootDigest,
  serviceStatus,
  stopStableService,
  writeActiveService,
  type ActiveServiceDesired,
  type ActiveServiceRecord
} from './service-control.js';
import { RELEASE_VERSION } from './version.js';

function within(child: string, parent: string) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function coordinatorOverallState(input: {
  completion: boolean;
  local_mcp: string;
  identity_matches: boolean;
  policy_matches?: boolean;
  task_error?: boolean;
  tunnel: string;
  chatgpt_route: string;
}) {
  if (input.completion) return 'completed';
  if (['wrong_generation', 'wrong_task', 'wrong_root', 'wrong_version'].includes(input.local_mcp)) return 'stale';
  if (input.task_error || input.local_mcp === 'blocked' || input.policy_matches === false) return 'blocked';
  if (!input.identity_matches || input.local_mcp === 'stale') return 'stale';
  if (input.local_mcp === 'unhealthy') return 'unverified';
  if (input.local_mcp === 'ready') {
    return input.tunnel === 'ready' && input.chatgpt_route === 'verified' ? 'ready' : 'degraded';
  }
  return 'degraded';
}

export function reconcileCoordinatorLocalIdentity(localMcp: string, identityMatches: boolean) {
  return identityMatches ? localMcp : 'stale';
}

export function reconcileCoordinatorLocalPolicy(localMcp: string, activeDigest: string, boundDigest: string | undefined) {
  const policyMatches = boundDigest !== undefined && activeDigest === boundDigest;
  return {
    local_mcp: policyMatches ? localMcp : 'blocked',
    policy_matches: policyMatches,
    active_policy_digest: activeDigest,
    bound_policy_digest: boundDigest
  };
}

export function formatCoordinatorStatusText(status: {
  state: string;
  active_task_id: string | null;
  local_mcp: string;
  launchd: string;
  tunnel: string;
  chatgpt_route: string;
}) {
  const direct = new Set(['ready', 'degraded', 'stale', 'blocked', 'unverified']);
  const label = direct.has(status.state) ? status.state.toUpperCase() : 'UNVERIFIED';
  const qualifier = direct.has(status.state) ? '' : ` state=${status.state}`;
  return [
    `${label}${qualifier}`,
    `task: ${status.active_task_id ?? 'none'}`,
    `local_mcp: ${status.local_mcp}`,
    `launchd: ${status.launchd}`,
    `tunnel: ${status.tunnel}`,
    `chatgpt_route: ${status.chatgpt_route}`
  ].join('\n');
}

async function withCoordinatorLock<T>(stateDir: string, purpose: string, fn: (store: StateStore) => Promise<T>, options: { forbiddenRoots?: string[]; recoverStale?: boolean } = {}) {
  const store = await StateStore.open(stateDir, { forbiddenRoots: options.forbiddenRoots });
  const lock = await acquireLock(store, 'coordinator-v1', purpose, { recoverStale: !!options.recoverStale });
  try { return await fn(store); }
  finally { await lock.release(); }
}

export type BindOptions = {
  stateDir?: string;
  taskId: string;
  repo: string;
  policyPath: string;
  port?: number;
  allowDetached?: boolean;
};

export async function prepareValidatedTaskPolicy(options: { policyPath: string; root: string; stateDir: string; taskId: string }) {
  const root = await realpath(options.root);
  const canonical = await realpath(options.policyPath);
  if (within(canonical, root)) throw new SafeError('Policy must remain outside the served repository for the coordinator workflow.');
  const loaded = loadPolicy(JSON.parse(await readFile(canonical, 'utf8')));
  const prospectiveState = await StateStore.canonicalPath(options.stateDir);
  const auditPath = path.join(prospectiveState, 'audit-' + options.taskId + '.jsonl');
  await compilePolicyFor(loaded, { root, protectedPaths: [canonical, prospectiveState, auditPath] });
  return { root, path: canonical, digest: policyDigest(loaded), loaded, state_dir: prospectiveState, audit_path: auditPath };
}

export async function coordinatorBind(options: BindOptions) {
  const stateDir = options.stateDir ?? defaultStateDir();
  const prepared = await prepareValidatedTaskPolicy({ policyPath: options.policyPath, root: options.repo, stateDir, taskId: options.taskId });
  const root = prepared.root;
  const policy = prepared;
  return withCoordinatorLock(stateDir, 'bind task ' + options.taskId, async store => {
    const current = await readActiveService(store);
    if (current && current.task_id !== options.taskId) {
      let completion: unknown;
      try { completion = (await taskStatus(stateDir, current.task_id)).completion; }
      catch { completion = undefined; }
      if (!completion) throw new SafeError('Task ' + current.task_id + ' is still the active service binding. Finish it before binding a different task.');
    }
    if (!current || current.task_id !== options.taskId) {
      try {
        await taskStatus(stateDir, options.taskId);
        if (!await isStage1BoundTask(stateDir, options.taskId)) {
          throw new SafeError('Task ' + options.taskId + ' already has a pre-hardening binding. Stage 1 will not adopt it implicitly; use a new task ID or the explicit legacy-adoption flow when Stage 2 ownership/baseline support is available.');
        }
      } catch (error) {
        if (!(error instanceof SafeError) || !/not bound/.test(error.message)) throw error;
      }
    }
    const binding = await bindTask(stateDir, options.taskId, root, policy.digest, { allowDetached: options.allowDetached });
    const desired: ActiveServiceDesired = {
      task_id: options.taskId,
      root: binding.root,
      root_digest: rootDigest(binding.root),
      policy_path: policy.path,
      policy_digest: policy.digest,
      state_dir: store.dir,
      audit_path: path.join(store.dir, 'audit-' + options.taskId + '.jsonl'),
      port: options.port ?? 8787,
      allow_detached: binding.allow_detached,
      expected_server_version: RELEASE_VERSION
    };
    const active = await writeActiveService(store, desired);
    return { binding, active };
  }, { forbiddenRoots: [root] });
}

export async function coordinatorStart(options: { stateDir?: string; recoverStale?: boolean } = {}) {
  const stateDir = options.stateDir ?? defaultStateDir();
  return withCoordinatorLock(stateDir, 'start active service', async store => {
    const active = await readActiveService(store);
    if (!active) throw new SafeError('No active service binding. Run coord bind first.');
    const task = await taskStatus(stateDir, active.task_id);
    if (task.completion) throw new SafeError('Task ' + active.task_id + ' is completed and cannot be started. Bind a new task ID.');
    if (task.policy_digest !== active.policy_digest) throw new SafeError('Active service policy digest does not match the rebound task policy. Run coord bind with the validated policy to publish a new service generation before start.');
    if (options.recoverStale) await recoverTaskStaleLocks(stateDir, active.task_id);
    const started = await installOrReloadStable(active);
    const writer = await taskWriterLockStatus(stateDir, active.task_id);
    if (writer.state !== 'live' || writer.purpose !== `task ${active.task_id}` || writer.pid !== started.process?.process_pid) {
      await stopStableService(active);
      throw new SafeError('Started server did not prove a live same-task checkout writer lock tied to the serving process; the service was stopped.');
    }
    return started;
  });
}

export async function coordinatorStatus(options: { stateDir?: string; serviceOptions?: Parameters<typeof serviceStatus>[1] } = {}) {
  const stateDir = options.stateDir ?? defaultStateDir();
  const store = await StateStore.inspect(stateDir);
  if (!store) return {
    state: 'unbound',
    server_version: RELEASE_VERSION,
    active_task_id: null,
    local_mcp: 'stopped',
    launchd: 'unverified',
    chatgpt_route: 'probe_required',
    tunnel: 'unverified_stage4'
  };
  const active = await readActiveService(store);
  if (!active) return {
    state: 'unbound',
    server_version: RELEASE_VERSION,
    active_task_id: null,
    local_mcp: 'stopped',
    launchd: 'unverified',
    chatgpt_route: 'probe_required',
    tunnel: 'unverified_stage4'
  };
  let task: Awaited<ReturnType<typeof taskStatus>> | undefined;
  let currentIdentity: Awaited<ReturnType<typeof resolveIdentity>> | undefined;
  let taskError: string | undefined;
  try {
    task = await taskStatus(stateDir, active.task_id, { readOnly: true });
    currentIdentity = await resolveIdentity(active.root);
  } catch (error) { taskError = error instanceof Error ? error.message : 'Task state could not be inspected.'; }
  let writerLock;
  let writerError: string | undefined;
  try { writerLock = await taskWriterLockStatus(stateDir, active.task_id, { readOnly: true }); }
  catch (error) {
    writerLock = { state: 'unknown' as const, key: 'unknown' };
    writerError = error instanceof Error ? error.message : 'Writer lock state could not be validated.';
  }
  let local;
  let localInspectionError = false;
  try { local = await serviceStatus(active, { ...options.serviceOptions, writerLock }); }
  catch (error) {
    localInspectionError = true;
    local = { launchd: 'unverified', local_mcp: 'blocked' as const, error: error instanceof Error ? error.message : 'Service state unavailable.' };
  }
  if (writerError) local = { ...local, local_mcp: 'blocked' as const, error: writerError };
  const identityInspected = !taskError && !!task && !!currentIdentity;
  const identityMatches = !!task && !!currentIdentity &&
    task.root === currentIdentity.root && task.git_dir === currentIdentity.git_dir && task.common_dir === currentIdentity.common_dir &&
    task.branch === currentIdentity.branch && task.head === currentIdentity.head;
  const identityReadiness = !identityInspected || !!writerError || localInspectionError
    ? 'blocked'
    : reconcileCoordinatorLocalIdentity(local.local_mcp, identityMatches);
  const policyReadiness = reconcileCoordinatorLocalPolicy(identityReadiness, active.policy_digest, task?.policy_digest);
  const tunnel = 'unverified_stage4';
  const chatgptRoute = 'probe_required';
  const state = coordinatorOverallState({
    completion: !!task?.completion,
    local_mcp: policyReadiness.local_mcp,
    identity_matches: identityMatches,
    policy_matches: policyReadiness.policy_matches,
    task_error: !!taskError,
    tunnel,
    chatgpt_route: chatgptRoute
  });
  return {
    state,
    server_version: RELEASE_VERSION,
    active_task_id: active.task_id,
    completion: task?.completion ?? null,
    configured_root: active.root,
    configured_root_digest: active.root_digest,
    current_identity: currentIdentity ?? null,
    bound_branch: task?.branch ?? null,
    bound_head: task?.head ?? null,
    phase: task?.phase ?? null,
    policy_path: active.policy_path,
    policy_digest: active.policy_digest,
    active_policy_digest: policyReadiness.active_policy_digest,
    bound_policy_digest: policyReadiness.bound_policy_digest ?? null,
    policy_matches: policyReadiness.policy_matches,
    desired_generation: active.generation,
    expected_server_version: active.expected_server_version,
    launchd: local.launchd,
    local_mcp: policyReadiness.local_mcp,
    process: 'process' in local ? local.process ?? null : null,
    writer_lock: writerLock,
    tunnel,
    chatgpt_route: chatgptRoute,
    candidate_state: 'unavailable_stage2',
    candidate_digest: null,
    ...(taskError ? { task_error: taskError } : {}),
    ...('error' in local ? { service_error: local.error } : {})
  };
}

export async function coordinatorFinish(options: { stateDir?: string; result: 'committed' | 'abandoned'; commitSha?: string }) {
  if (options.result === 'committed') throw new SafeError('Stage 1 does not support finish --commit; verified commit handoff is unavailable until the Stage 3 machine gate exists. Use --abandon only.');
  const stateDir = options.stateDir ?? defaultStateDir();
  return withCoordinatorLock(stateDir, 'finish active task', async store => {
    const active = await readActiveService(store);
    if (!active) throw new SafeError('No active service binding to finish.');
    const task = await taskStatus(stateDir, active.task_id);
    await stopStableService(active);
    const lock = await taskWriterLockStatus(stateDir, active.task_id);
    if (lock.state !== 'absent') {
      const owner = lock.state === 'live' ? `live in process ${lock.pid}` : `stale from exited process ${lock.pid}`;
      throw new SafeError(`Server checkout writer lock is ${owner}; completion was not published. Recover/clear the active task's writer lock explicitly before retrying finish.`);
    }
    if (task.completion) return task.completion;
    return completeTask(stateDir, active.task_id, {
      result: options.result,
      ...(options.commitSha ? { commit_sha: options.commitSha } : {})
    });
  });
}

export async function coordinatorMigrateLegacy(options: { stateDir?: string; useActiveTask?: boolean } = {}) {
  const stateDir = options.stateDir ?? defaultStateDir();
  return withCoordinatorLock(stateDir, 'migrate legacy server', async store => {
    const active = options.useActiveTask ? await readActiveService(store) : undefined;
    if (options.useActiveTask && !active) throw new SafeError('No safe active task is bound. Bind a new task ID first, then retry migration with --use-active-task.');
    if (active) {
      const task = await taskStatus(stateDir, active.task_id);
      if (task.completion) throw new SafeError('The active task is completed. Bind a new task ID before migrating.');
      const lock = await taskWriterLockStatus(stateDir, active.task_id);
      if (lock.state !== 'absent') throw new SafeError('Legacy migration requires the active task checkout writer lock to be absent; recover/inspect stale state explicitly before retrying.');
    }
    return migrateLegacyServer({ stateDir: store.dir, ...(active ? { active } : {}) });
  });
}

export async function refusePreHardeningAdoption(taskId: string) {
  throw new SafeError(
    'Pre-hardening task ' + taskId + ' cannot be made writable in Stage 1 without the authoritative claims/coherent baseline contract scheduled for Stage 2. ' +
    'Do not synthesize ownership: bind a new task ID now, or leave the old task retired until Stage 2 adoption support is implemented.'
  );
}

export type { ActiveServiceRecord };
