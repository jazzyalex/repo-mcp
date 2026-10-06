import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SafeError, sha256 } from './errors.js';
import { resolveIdentity, identityDrift, type RepoIdentity } from './identity.js';
import { StateStore, StateError, acquireLock, lockOwnerAlive, validateLockRecord, withShortLock, type Lock } from './task-state.js';

// Task binding, operator-controlled phase and request outcomes. Binding and
// phase are re-read from disk on every check so coordinator changes apply to a
// running server.

export type Phase = 'coding' | 'review';
type PhaseRecord = { phase: Phase; epoch?: number };
export type TaskOptions = { stateDir: string; taskId: string; policyDigest: string; allowDetached?: boolean; recoverStaleLock?: boolean };
type Binding = { task_id: string; root: string; git_dir: string; common_dir: string; branch: string | null; head: string; allow_detached: boolean; policy_digest: string; bound_at: string; binding_epoch?: number };
export type Completion = { finished_at: string; result: 'committed' | 'abandoned'; commit_sha?: string };
type Stage1Protocol = {
  protocol: 'v1-stage1';
  root: string;
  git_dir: string;
  common_dir: string;
  created_at: string;
  // Pre-fix Stage 1 markers may contain these historical mutable mirrors. They are
  // intentionally ignored after adoption; mutable task identity lives only in binding.json.
  branch?: string | null;
  head?: string;
  allow_detached?: boolean;
  policy_digest?: string;
};
/**
 * Durable evidence of one create_file publication, written after the temporary file is complete and before it is
 * hard-linked to its target: the target, the server-made temporary (a path in the target's directory) and that
 * temporary's physical identity (device and inode as decimal strings). Optional: outcomes written before this field
 * existed simply have none, and recovery never acts without it.
 */
export type Publication = { target: string; temp: string; dev: string; ino: string };
export type Outcome = {
  request_id: string; operation: string; args_digest: string; path: string;
  status: 'intent' | 'completed' | 'failed';
  before_sha256: string | null; after_sha256: string | null;
  result?: Record<string, unknown>; error?: string; updated_at: string;
  publication?: Publication;
};
export type MutationResult = { path: string; before_sha256: string | null; after_sha256: string; diff?: string | null };

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PHASES: Phase[] = ['coding', 'review'];

function taskPaths(taskId: string) {
  if (!TASK_ID.test(taskId)) throw new SafeError('Invalid task ID: use 1-64 letters, digits, ".", "_" or "-".');
  return { binding: `tasks/${taskId}/binding.json`, phase: `tasks/${taskId}/phase.json`, completion: `tasks/${taskId}/completion.json`, protocol: `tasks/${taskId}/protocol.json`, outcome: (id: string) => `tasks/${taskId}/outcomes/${sha256(id).slice(0, 32)}.json` };
}
// Mutations and coordinator phase/binding changes serialize on this per-task gate,
// so a freeze or rebind is acknowledged only after in-flight mutations drain.
const gateKey = (taskId: string) => `task-${taskId}-gate`;
const MUTATION_GATE_WAIT_MS = 5_000;
const COORDINATOR_GATE_WAIT_MS = 60_000;
const checkoutLockKey = (identity: Pick<RepoIdentity, 'root' | 'git_dir'>) => `checkout-${sha256(`${identity.root}\0${identity.git_dir}`).slice(0, 32)}`;

function protocolMatchesAdoption(protocol: Stage1Protocol | undefined, binding: Pick<Binding, 'root' | 'git_dir' | 'common_dir'>): protocol is Stage1Protocol {
  return !!protocol && protocol.protocol === 'v1-stage1' &&
    protocol.root === binding.root && protocol.git_dir === binding.git_dir && protocol.common_dir === binding.common_dir &&
    typeof protocol.created_at === 'string' && Number.isFinite(Date.parse(protocol.created_at));
}

async function ensureStage1Binding(store: StateStore, paths: ReturnType<typeof taskPaths>, taskId: string, identity: RepoIdentity, policyDigest: string, allowDetached: boolean) {
  const desired: Binding = {
    task_id: taskId, root: identity.root, git_dir: identity.git_dir, common_dir: identity.common_dir,
    branch: identity.branch, head: identity.head, allow_detached: allowDetached, policy_digest: policyDigest,
    bound_at: new Date().toISOString(), binding_epoch: 1
  };
  const protocolDesired: Stage1Protocol = {
    protocol: 'v1-stage1', root: identity.root, git_dir: identity.git_dir, common_dir: identity.common_dir,
    created_at: new Date().toISOString()
  };
  let existing = await store.read<Binding>(paths.binding, 'binding');
  let protocol = await store.read<Stage1Protocol>(paths.protocol, 'task-protocol');
  const sameDesired = (binding: Binding) => binding.root === desired.root && binding.git_dir === desired.git_dir && binding.common_dir === desired.common_dir &&
    binding.branch === desired.branch && binding.head === desired.head && binding.allow_detached === desired.allow_detached && binding.policy_digest === desired.policy_digest;

  if (existing) {
    if (!protocolMatchesAdoption(protocol, existing)) throw new SafeError(`Task ${taskId} has a pre-hardening or mismatched binding and cannot be reopened writable without a matching Stage 1 protocol marker.`);
    const drift = identityDrift(existing, identity);
    if (drift) throw new SafeError(drift);
    if (existing.policy_digest !== policyDigest) throw new SafeError(`Task ${taskId} policy changed since binding. Coordinator reconciliation is required.`);
    if (existing.allow_detached !== allowDetached) throw new SafeError(`Task ${taskId} detached-head approval changed since binding. Coordinator reconciliation is required.`);
  } else {
    if (protocol) {
      if (!protocolMatchesAdoption(protocol, desired)) throw new SafeError(`Task ${taskId} has a mismatched Stage 1 bind marker. Inspect operator state before retrying.`);
    } else {
      if (!(await store.create(paths.protocol, 'task-protocol', protocolDesired))) throw new SafeError(`Task ${taskId} bind marker changed concurrently; retry after inspection.`);
      protocol = protocolDesired;
    }
    if (!(await store.create(paths.binding, 'binding', desired))) {
      existing = await store.read<Binding>(paths.binding, 'binding');
      if (!existing || !protocolMatchesAdoption(protocol, existing) || !sameDesired(existing)) throw new SafeError(`Task ${taskId} binding changed concurrently; retry after inspection.`);
    } else existing = desired;
  }

  let phase = await store.read<PhaseRecord>(paths.phase, 'phase');
  if (!phase) {
    await store.create(paths.phase, 'phase', { phase: 'coding', epoch: 1 } satisfies PhaseRecord);
    phase = await store.read<PhaseRecord>(paths.phase, 'phase');
  }
  if (!phase || !PHASES.includes(phase.phase) || (phase.epoch !== undefined && (!Number.isSafeInteger(phase.epoch) || phase.epoch < 1))) throw new StateError(`Task ${taskId} phase record is missing or invalid.`);
  return existing!;
}

export class TaskContext {
  private closePromise?: Promise<void>;
  private constructor(private readonly store: StateStore, readonly taskId: string, private readonly lock: Lock, private readonly policyDigest: string) {}

  static argsDigest(operation: string, args: unknown[]) { return sha256(JSON.stringify([operation, ...args])); }

  static async open(options: TaskOptions, identity: RepoIdentity) {
    const paths = taskPaths(options.taskId);
    const store = await StateStore.open(options.stateDir, { forbiddenRoots: [identity.root, identity.common_dir] });
    if (identity.detached && !options.allowDetached) throw new SafeError('Checkout is on a detached HEAD. Bind it only with explicit detached-HEAD approval.');
    if (options.recoverStaleLock) await recoverStaleGate(store, options.taskId);
    let checkoutLock: Lock | undefined;
    await withShortLock(store, gateKey(options.taskId), async () => {
      if (await store.read(paths.completion, 'completion')) throw new SafeError(`Task ${options.taskId} is completed and cannot be reopened. Use a new task ID.`);
      const existing = await store.read<Binding>(paths.binding, 'binding');
      const protocol = await store.read<Stage1Protocol>(paths.protocol, 'task-protocol');
      if (existing && !protocolMatchesAdoption(protocol, existing)) {
        throw new SafeError(`Task ${options.taskId} has a pre-hardening or mismatched binding and cannot be reopened writable without a matching Stage 1 protocol marker.`);
      }
      checkoutLock = await acquireLock(store, checkoutLockKey(identity), `task ${options.taskId}`, {
        recoverStale: options.recoverStaleLock,
        expectedExistingPurpose: options.recoverStaleLock ? `task ${options.taskId}` : undefined
      });
      try {
        const binding = await ensureStage1Binding(store, paths, options.taskId, identity, options.policyDigest, !!options.allowDetached);
        const drift = identityDrift(binding, identity);
        if (drift) throw new SafeError(drift);
        if (identity.detached && !binding.allow_detached) throw new SafeError('Task binding does not approve detached HEAD.');
        if (await store.read(paths.completion, 'completion')) throw new SafeError(`Task ${options.taskId} completed while ownership was being acquired; writable startup is refused.`);
      } catch (error) {
        await checkoutLock.release();
        checkoutLock = undefined;
        throw error;
      }
    }, { waitMs: COORDINATOR_GATE_WAIT_MS, purpose: `task ${options.taskId} open` });
    if (!checkoutLock) throw new StateError(`Task ${options.taskId} checkout ownership was not acquired.`);
    return new TaskContext(store, options.taskId, checkoutLock, options.policyDigest);
  }

  /** Operator state directory (already verified to lie outside served repositories). */
  get stateDir() { return this.store.dir; }

  private async binding() {
    const binding = await this.store.read<Binding>(taskPaths(this.taskId).binding, 'binding');
    if (!binding) throw new StateError(`Task ${this.taskId} binding is missing.`);
    return binding;
  }

  private async phaseRecord(): Promise<Required<PhaseRecord>> {
    const record = await this.store.read<PhaseRecord>(taskPaths(this.taskId).phase, 'phase');
    if (!record || !PHASES.includes(record.phase) || (record.epoch !== undefined && (!Number.isSafeInteger(record.epoch) || record.epoch < 1))) throw new StateError(`Task ${this.taskId} phase record is missing or invalid.`);
    return { phase: record.phase, epoch: record.epoch ?? 1 };
  }

  async phase(): Promise<Phase> { return (await this.phaseRecord()).phase; }

  async summary() {
    const binding = await this.binding();
    const phase = await this.phaseRecord();
    return { task_id: this.taskId, phase: phase.phase, phase_epoch: phase.epoch, binding_epoch: binding.binding_epoch ?? 1, bound_branch: binding.branch, bound_head: binding.head, policy_digest: binding.policy_digest };
  }

  /** The binding's policy must still be the one this server loaded and enforces. */
  async verifyPolicy() {
    if ((await this.binding()).policy_digest !== this.policyDigest) throw new SafeError(`Task ${this.taskId} policy changed since this server loaded it. Restart the server with the validated policy.`);
  }

  /** Run a mutation while holding the task gate; phase and binding cannot change meanwhile. */
  withMutationGate<T>(fn: () => Promise<T>) {
    return withShortLock(this.store, gateKey(this.taskId), fn, { waitMs: MUTATION_GATE_WAIT_MS, purpose: 'mutation' });
  }

  /** Verify ownership, identity, policy and phase before a mutation or check. */
  async verify(current: RepoIdentity, kind: 'mutation' | 'check') {
    if (!(await this.lock.owned())) throw new SafeError('Checkout writer lock is no longer held by this server. Restart after coordinator reconciliation.');
    await this.verifyPolicy();
    const drift = identityDrift(await this.binding(), current);
    if (drift) throw new SafeError(drift);
    if (kind === 'mutation' && (await this.phase()) !== 'coding') throw new SafeError('Task is in the read-only review phase; MCP mutations are disabled.');
  }

  /**
   * Resolve a retried request. Returns a recorded result, undefined when it is
   * safe to (re)apply, or throws for reuse, recorded failure, conflict or uncertainty.
   */
  async prior(requestId: string, digest: string, currentHash: () => Promise<string | null>, recover?: (outcome: Outcome) => Promise<void>): Promise<(Record<string, unknown> & { already_applied: true }) | undefined> {
    if (!REQUEST_ID.test(requestId)) throw new SafeError('Invalid request_id: use 1-128 letters, digits, ".", "_", ":" or "-".');
    const rel = taskPaths(this.taskId).outcome(requestId);
    const outcome = await this.store.read<Outcome>(rel, 'outcome');
    if (!outcome) return undefined;
    if (outcome.request_id !== requestId || outcome.args_digest !== digest) throw new SafeError('request_id was already used with different arguments. Use a new request_id.');
    if (outcome.status === 'failed') throw new SafeError(`Request ${requestId} previously failed: ${outcome.error} Use a new request_id after fixing the cause.`);
    // An interrupted publication is settled first (its recorded temporary link removed), so the file can be read.
    if (outcome.publication && recover) await recover(outcome);
    const current = await currentHash();
    if (current === outcome.after_sha256) {
      if (outcome.status === 'intent') {
        outcome.status = 'completed';
        outcome.result = { path: outcome.path, before_sha256: outcome.before_sha256, after_sha256: outcome.after_sha256, reconciled: true };
        outcome.updated_at = new Date().toISOString();
        await this.store.write(rel, 'outcome', outcome);
      }
      return { ...outcome.result, already_applied: true };
    }
    if (outcome.status === 'completed') throw new SafeError(`Request ${requestId} was applied earlier, but ${outcome.path} has changed since. Read the file again; do not replay.`);
    if (current === outcome.before_sha256) return undefined; // intent recorded, write never happened
    throw new SafeError(`Outcome of request ${requestId} is uncertain: ${outcome.path} matches neither its recorded before nor after hash. Inspect the file; do not replay.`);
  }

  async recordIntent(requestId: string, digest: string, operation: string, path: string, before: string | null, after: string) {
    await this.store.write(taskPaths(this.taskId).outcome(requestId), 'outcome', {
      request_id: requestId, operation, args_digest: digest, path, status: 'intent', before_sha256: before, after_sha256: after, updated_at: new Date().toISOString()
    } satisfies Outcome);
  }

  /** Add publication evidence to an intent record; it must be durable before the link is made. */
  async recordPublication(requestId: string, publication: Publication) {
    const rel = taskPaths(this.taskId).outcome(requestId);
    const outcome = await this.store.read<Outcome>(rel, 'outcome');
    if (!outcome || outcome.status !== 'intent') throw new StateError(`Missing intent record for request ${requestId}.`);
    await this.store.write(rel, 'outcome', { ...outcome, publication, updated_at: new Date().toISOString() } satisfies Outcome);
  }

  /** Outcomes of this task that carry publication evidence and did not fail (completed ones may keep a leftover link). */
  async pendingPublications(): Promise<Outcome[]> {
    const dir = `tasks/${this.taskId}/outcomes`;
    const found: Outcome[] = [];
    for (const name of await this.store.list(dir)) {
      if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
      const outcome = await this.store.read<Outcome>(`${dir}/${name}`, 'outcome');
      if (outcome?.publication && outcome.status !== 'failed') found.push(outcome);
    }
    return found;
  }

  /** Does this task have any recorded outcome? A cheap look that creates nothing and takes no lock. */
  static async hasOutcomes(options: TaskOptions) {
    try {
      if (!TASK_ID.test(options.taskId)) return false;
      return (await readdir(path.join(options.stateDir, 'tasks', options.taskId, 'outcomes'))).some(n => n.endsWith('.json'));
    } catch { return false; }
  }

  async recordCompleted(requestId: string, result: MutationResult) {
    const rel = taskPaths(this.taskId).outcome(requestId);
    const outcome = await this.store.read<Outcome>(rel, 'outcome');
    if (!outcome || outcome.status !== 'intent') throw new StateError(`Missing intent record for request ${requestId}.`);
    await this.store.write(rel, 'outcome', { ...outcome, status: 'completed', result: { ...result }, updated_at: new Date().toISOString() } satisfies Outcome);
  }

  async recordFailed(requestId: string, digest: string, operation: string, path: string, error: string) {
    await this.store.write(taskPaths(this.taskId).outcome(requestId), 'outcome', {
      request_id: requestId, operation, args_digest: digest, path, status: 'failed', before_sha256: null, after_sha256: null, error, updated_at: new Date().toISOString()
    } satisfies Outcome);
  }

  close() {
    if (this.closePromise) return this.closePromise;
    const run = this.lock.release();
    this.closePromise = run;
    void run.catch(() => { if (this.closePromise === run) this.closePromise = undefined; });
    return run;
  }
}

// Coordinator operations (not exposed through MCP).

/** Persist or recover an exact Stage 1 task binding without acquiring the long-lived checkout writer lock. */
export async function bindTask(
  stateDir: string,
  taskId: string,
  root: string,
  policyDigest: string,
  options: { allowDetached?: boolean; gateWaitMs?: number } = {}
) {
  const paths = taskPaths(taskId);
  const identity = await resolveIdentity(root);
  const store = await StateStore.open(stateDir, { forbiddenRoots: [identity.root, identity.common_dir] });
  if (identity.detached && !options.allowDetached) throw new SafeError('Checkout is on a detached HEAD. Bind it only with explicit detached-HEAD approval.');
  return withShortLock(store, gateKey(taskId), async () => {
    if (await store.read<Completion>(paths.completion, 'completion')) throw new SafeError(`Task ${taskId} is completed and cannot be reused. Use a new task ID.`);
    return ensureStage1Binding(store, paths, taskId, identity, policyDigest, !!options.allowDetached);
  }, { waitMs: options.gateWaitMs ?? COORDINATOR_GATE_WAIT_MS, purpose: `task ${taskId} bind` });
}

export async function isStage1BoundTask(stateDir: string, taskId: string) {
  const paths = taskPaths(taskId);
  const store = await StateStore.open(stateDir);
  const protocol = await store.read<Stage1Protocol>(paths.protocol, 'task-protocol');
  return protocol?.protocol === 'v1-stage1';
}

async function coordinatorStore(stateDir: string, taskId: string, options: { allowCompleted?: boolean; readOnly?: boolean } = {}) {
  const paths = taskPaths(taskId);
  const store = options.readOnly ? await StateStore.inspect(stateDir) : await StateStore.open(stateDir);
  if (!store) throw new SafeError(`Task ${taskId} is not bound.`);
  const binding = await store.read<Binding>(paths.binding, 'binding');
  if (!binding) throw new SafeError(`Task ${taskId} is not bound.`);
  const completion = await store.read<Completion>(paths.completion, 'completion');
  if (completion && !options.allowCompleted) throw new SafeError(`Task ${taskId} is completed and cannot be changed. Use a new task ID.`);
  return { store, paths, binding, completion };
}

async function recoverStaleGate(store: StateStore, taskId: string) {
  // Only a gate left by an exited process is removed; a live holder is left alone.
  try { await (await acquireLock(store, gateKey(taskId), 'recovery', { recoverStale: true })).release(); }
  catch (error) { if (!(error instanceof StateError) || !/live process/.test(error.message)) throw error; }
}

const coordinatorGate = <T>(store: StateStore, taskId: string, fn: () => Promise<T>) =>
  withShortLock(store, gateKey(taskId), fn, { waitMs: COORDINATOR_GATE_WAIT_MS, purpose: 'coordinator' });

/** Serialize an operator authorization/catalog transition with task mutations and checks. */
export async function withTaskCoordinatorGate<T>(stateDir: string, taskId: string, fn: () => Promise<T>) {
  const { store } = await coordinatorStore(stateDir, taskId);
  return coordinatorGate(store, taskId, fn);
}

export async function recoverTaskStaleLocks(stateDir: string, taskId: string) {
  const { store, binding } = await coordinatorStore(stateDir, taskId);
  const identity = await resolveIdentity(binding.root);
  const drift = identityDrift(binding, identity);
  if (drift) throw new SafeError('Stale-lock recovery refused because the active task binding is no longer current: ' + drift);
  const recovered = await acquireLock(store, checkoutLockKey(binding), `explicit recovery for task ${taskId}`, { recoverStale: true, expectedExistingPurpose: `task ${taskId}` });
  await recovered.release();
  await recoverStaleGate(store, taskId);
}

/** Returns only after in-flight mutations have drained and the new phase is durable. */
export async function setTaskPhase(stateDir: string, taskId: string, phase: Phase) {
  if (!PHASES.includes(phase)) throw new SafeError('Invalid task phase: expected coding or review.');
  const { store, paths } = await coordinatorStore(stateDir, taskId);
  await coordinatorGate(store, taskId, async () => {
    if (await store.read(paths.completion, 'completion')) throw new SafeError(`Task ${taskId} is completed and cannot change phase.`);
    const current = await store.read<PhaseRecord>(paths.phase, 'phase');
    if (!current || !PHASES.includes(current.phase)) throw new StateError(`Task ${taskId} phase record is missing or invalid.`);
    const epoch = current.epoch ?? 1;
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new StateError(`Task ${taskId} phase record is missing or invalid.`);
    if (current.phase === phase) return;
    await store.write(paths.phase, 'phase', { phase, epoch: epoch + 1 } satisfies PhaseRecord);
  });
}

/** Accept the checkout's current branch/HEAD (and optionally a new policy) after reconciliation. */
export async function rebindTask(stateDir: string, taskId: string, root: string, options: { policyDigest?: string; allowDetached?: boolean } = {}) {
  const { store, paths } = await coordinatorStore(stateDir, taskId);
  return coordinatorGate(store, taskId, async () => {
    if (await store.read(paths.completion, 'completion')) throw new SafeError(`Task ${taskId} is completed and cannot be rebound.`);
    const binding = (await store.read<Binding>(paths.binding, 'binding'))!;
    const protocol = await store.read<Stage1Protocol>(paths.protocol, 'task-protocol');
    if (!protocolMatchesAdoption(protocol, binding)) throw new SafeError(`Task ${taskId} lacks a matching Stage 1 protocol marker and cannot be rebound implicitly.`);
    const identity = await resolveIdentity(root);
    if (identity.root !== binding.root || identity.git_dir !== binding.git_dir || identity.common_dir !== binding.common_dir) throw new SafeError(`Task ${taskId} is bound to a different checkout (${binding.root}).`);
    const allowDetached = options.allowDetached ?? binding.allow_detached;
    if (identity.detached && !allowDetached) throw new SafeError('Checkout is on a detached HEAD. Rebind it only with explicit detached-HEAD approval.');
    const updated: Binding = {
      ...binding,
      branch: identity.branch,
      head: identity.head,
      allow_detached: allowDetached,
      policy_digest: options.policyDigest ?? binding.policy_digest,
      bound_at: new Date().toISOString(),
      binding_epoch: (binding.binding_epoch ?? 1) + 1
    };
    await store.write(paths.binding, 'binding', updated);
    return updated;
  });
}

export async function completeTask(stateDir: string, taskId: string, outcome: { result: 'committed' | 'abandoned'; commit_sha?: string }) {
  if (outcome.result === 'committed' && (!outcome.commit_sha || !/^[a-f0-9]{40,64}$/i.test(outcome.commit_sha))) throw new SafeError('Committed completion requires a verified commit SHA.');
  if (outcome.result === 'abandoned' && outcome.commit_sha) throw new SafeError('Abandoned completion cannot include a commit SHA.');
  const { store, paths } = await coordinatorStore(stateDir, taskId, { allowCompleted: true });
  const record: Completion = { finished_at: new Date().toISOString(), result: outcome.result, ...(outcome.commit_sha ? { commit_sha: outcome.commit_sha } : {}) };
  return coordinatorGate(store, taskId, async () => {
    const existing = await store.read<Completion>(paths.completion, 'completion');
    if (existing) {
      if (existing.result !== record.result || (existing.commit_sha ?? null) !== (record.commit_sha ?? null)) throw new SafeError(`Task ${taskId} is already completed with a different outcome.`);
      return existing;
    }
    const writer = await taskWriterLockStatus(stateDir, taskId);
    if (writer.state !== 'absent') {
      const owner = writer.state === 'live' ? `live in process ${writer.pid}` : `stale from exited process ${writer.pid}`;
      throw new SafeError(`Task ${taskId} checkout writer lock is ${owner}; completion was not published. Recover/clear the task's writer lock explicitly before completion.`);
    }
    if (!(await store.create(paths.completion, 'completion', record))) throw new StateError(`Task ${taskId} completion changed concurrently; retry after inspection.`);
    return record;
  });
}

export async function taskWriterLockStatus(stateDir: string, taskId: string, options: { readOnly?: boolean } = {}) {
  const { store, binding } = await coordinatorStore(stateDir, taskId, { allowCompleted: true, readOnly: options.readOnly });
  const key = checkoutLockKey(binding);
  const raw = await store.read<unknown>(`locks/${key}.json`, 'lock');
  if (!raw) return { state: 'absent' as const, key };
  const record = validateLockRecord(raw, key);
  const live = record.hostname === os.hostname() && lockOwnerAlive(record.pid);
  return { state: live ? 'live' as const : 'stale' as const, key, pid: record.pid, hostname: record.hostname, purpose: record.purpose, acquired_at: record.acquired_at };
}

export async function taskStatus(stateDir: string, taskId: string, options: { readOnly?: boolean } = {}) {
  const { store, paths, binding, completion } = await coordinatorStore(stateDir, taskId, { allowCompleted: true, readOnly: options.readOnly });
  const phase = await store.read<PhaseRecord>(paths.phase, 'phase');
  if (!phase || !PHASES.includes(phase.phase) || (phase.epoch !== undefined && (!Number.isSafeInteger(phase.epoch) || phase.epoch < 1))) throw new StateError(`Task ${taskId} phase record is missing or invalid.`);
  return { ...binding, binding_epoch: binding.binding_epoch ?? 1, phase: phase.phase, phase_epoch: phase.epoch ?? 1, completion: completion ?? null };
}
