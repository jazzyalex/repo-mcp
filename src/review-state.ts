import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import os from 'node:os';
import { SafeError, sha256 } from './errors.js';
import { StateStore, acquireLock, lockOwnerAlive, validateLockRecord, withShortLock } from './task-state.js';
import { readMultiRepoCatalog, readWorkspaceOpenOutcome, type RepositoryRegistration, type TaskRegistration } from './multirepo-state.js';
import { loadPolicy, compilePolicyFor } from './policy.js';
import { commitReviewCandidateDigest, commitReviewTargetFingerprint, isConservativeGitRevision, type CommitReviewBinding } from './git-ref.js';
import { computeTargetFingerprintV1 } from './review-target.js';

export const REVIEW_SHARE_KIND = 'review-share-v1';
export const REVIEW_SHARE_SCHEMA_VERSION = 1 as const;
const FINGERPRINT_KEY_KIND = 'review-fingerprint-key-v1';
const FINGERPRINT_KEY_PATH = 'control/review-fingerprint-key.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX32 = /^[a-f0-9]{32}$/;
const HEX40_64 = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const HEX64 = /^[a-f0-9]{64}$/;
const MAX_PARTICIPANTS = 512;
const MAX_RUN_RECORDS = 4096;
type ShareGateLease = { state_dir: string; task_id: string; live: boolean; token: object };
const shareGateContext = new AsyncLocalStorage<ShareGateLease>();
const liveShareGateTokens = new WeakSet<object>();

export type ReviewParticipantState =
  | 'initializing' | 'prepared' | 'submission-reserved' | 'submitted'
  | 'completed' | 'failed-pre-submit' | 'uncertain'
  | 'close-requested' | 'closed' | 'invalidated';

export type ReviewWorkspaceAssociation = 'pending' | 'bound' | 'proven-absent';

export type ReviewParticipant = {
  generation: number;
  participant_id: string;
  coordinator: 'codex' | 'claude';
  profile: 'review' | 'review-critical';
  run_id: string;
  selection_id: string;
  requested_base_ref: string;
  resolved_base_commit: string;
  commit_binding?: CommitReviewBinding;
  scope_digest: string;
  prompt_digest: string;
  browser_context_digest: string;
  exact_request_key: string;
  target_fingerprint: string;
  workspace_request_id: string;
  workspace_ttl_ms: number;
  workspace_association: ReviewWorkspaceAssociation;
  workspace_id?: string;
  state: ReviewParticipantState;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

export type ReviewCodingOwner = {
  status: 'unknown' | 'active' | 'inactive';
  coordinator: 'codex' | 'claude' | null;
  provenance: 'legacy-unknown' | 'recorded';
  recorded_at: string;
};

export type ReviewShareJournal = {
  schema_version: typeof REVIEW_SHARE_SCHEMA_VERSION;
  repository_id: string;
  task_id: string;
  generation: number;
  registration_epoch: number;
  binding_epoch: number;
  phase_epoch: number;
  policy_digest: string;
  branch: string | null;
  head: string;
  target_fingerprint: string;
  target_assurance: 'phase_only' | 'commit_pinned';
  coding_owner: ReviewCodingOwner;
  participants: ReviewParticipant[];
  created_at: string;
  updated_at: string;
};

export class ReviewShareError extends SafeError {
  constructor(readonly code: string, message: string) { super(message); }
}

export const reviewSharePath = (taskId: string) => 'review-shares/' + taskId + '.json';
const shareLockKey = (taskId: string) => 'review-share-' + taskId;
const selectionLockKey = (repositoryId: string) => 'review-selection-' + repositoryId;

function fail(code: string, message: string): never { throw new ReviewShareError(code, message); }
function validDate(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function integer(value: unknown, min = 1): value is number { return Number.isSafeInteger(value) && (value as number) >= min; }
function strictKeys(value: Record<string, unknown>, allowed: readonly string[], what: string) {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('REVIEW_SHARE_STATE_CORRUPT', 'Corrupt ' + what + '.');
}
function object(value: unknown, what: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('REVIEW_SHARE_STATE_CORRUPT', 'Corrupt ' + what + '.');
  return value as Record<string, unknown>;
}
function assertTaskId(taskId: string) {
  if (!ID.test(taskId)) throw new SafeError('Invalid task ID.');
}
function assertRepositoryId(repositoryId: string) {
  if (!ID.test(repositoryId)) throw new SafeError('Invalid repository ID.');
}

function parseCodingOwner(raw: unknown): ReviewCodingOwner {
  const value = object(raw, 'review coding owner');
  strictKeys(value, ['status', 'coordinator', 'provenance', 'recorded_at'], 'review coding owner');
  if (!['unknown', 'active', 'inactive'].includes(String(value.status)) ||
      (value.coordinator !== null && value.coordinator !== 'codex' && value.coordinator !== 'claude') ||
      (value.provenance !== 'legacy-unknown' && value.provenance !== 'recorded') ||
      !validDate(value.recorded_at)) fail('REVIEW_SHARE_STATE_CORRUPT', 'Corrupt review coding owner.');
  return value as ReviewCodingOwner;
}

function parseParticipantBinding(raw: unknown, policyDigest: string): CommitReviewBinding {
  const value = object(raw, 'review participant commit binding');
  strictKeys(value, [
    'format_version', 'assurance', 'requested_base_ref', 'base_commit',
    'requested_head_ref', 'head_commit', 'scope_prefix', 'candidate_digest'
  ], 'review participant commit binding');
  if (
    value.format_version !== 1 || value.assurance !== 'commit_pinned' ||
    typeof value.requested_base_ref !== 'string' || !isConservativeGitRevision(value.requested_base_ref) ||
    typeof value.requested_head_ref !== 'string' || !isConservativeGitRevision(value.requested_head_ref) ||
    typeof value.base_commit !== 'string' || !HEX40_64.test(value.base_commit) ||
    typeof value.head_commit !== 'string' || !HEX40_64.test(value.head_commit) ||
    typeof value.scope_prefix !== 'string' || value.scope_prefix.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value.scope_prefix) ||
    typeof value.candidate_digest !== 'string' || !HEX64.test(value.candidate_digest) ||
    value.candidate_digest !== commitReviewCandidateDigest(
      policyDigest, value.base_commit as string, value.head_commit as string, value.scope_prefix as string
    )
  ) fail('REVIEW_SHARE_STATE_CORRUPT', 'Corrupt review participant commit binding.');
  return value as unknown as CommitReviewBinding;
}

function parseParticipant(raw: unknown, policyDigest?: string): ReviewParticipant {
  const value = object(raw, 'review participant');
  strictKeys(value, [
    'generation', 'participant_id', 'coordinator', 'profile', 'run_id', 'selection_id',
    'requested_base_ref', 'resolved_base_commit', 'commit_binding', 'scope_digest', 'prompt_digest',
    'browser_context_digest', 'exact_request_key', 'target_fingerprint',
    'workspace_request_id', 'workspace_ttl_ms',
    'workspace_association', 'workspace_id', 'state', 'created_at', 'updated_at', 'expires_at'
  ], 'review participant');
  const commitBinding = value.commit_binding === undefined
    ? undefined
    : policyDigest ? parseParticipantBinding(value.commit_binding, policyDigest)
      : fail('REVIEW_SHARE_STATE_CORRUPT', 'Commit-bound participant is missing its journal policy context.');
  if (!integer(value.generation) || typeof value.participant_id !== 'string' || !UUID.test(value.participant_id) ||
      (value.coordinator !== 'codex' && value.coordinator !== 'claude') ||
      (value.profile !== 'review' && value.profile !== 'review-critical') ||
      typeof value.run_id !== 'string' || !UUID.test(value.run_id) ||
      typeof value.selection_id !== 'string' || !UUID.test(value.selection_id) ||
      typeof value.requested_base_ref !== 'string' || !value.requested_base_ref ||
      typeof value.resolved_base_commit !== 'string' || !HEX40_64.test(value.resolved_base_commit) ||
      typeof value.scope_digest !== 'string' || !HEX64.test(value.scope_digest) ||
      typeof value.prompt_digest !== 'string' || !HEX64.test(value.prompt_digest) ||
      typeof value.browser_context_digest !== 'string' || !HEX64.test(value.browser_context_digest) ||
      typeof value.exact_request_key !== 'string' || !HEX64.test(value.exact_request_key) ||
      typeof value.target_fingerprint !== 'string' || !HEX64.test(value.target_fingerprint) ||
      typeof value.workspace_request_id !== 'string' || !REQUEST_ID.test(value.workspace_request_id) ||
      !Number.isSafeInteger(value.workspace_ttl_ms) || (value.workspace_ttl_ms as number) < 60_000 ||
      (value.workspace_ttl_ms as number) > 24 * 60 * 60_000 ||
      !['pending', 'bound', 'proven-absent'].includes(String(value.workspace_association)) ||
      (value.workspace_id !== undefined && (typeof value.workspace_id !== 'string' || !HEX32.test(value.workspace_id))) ||
      !['initializing', 'prepared', 'submission-reserved', 'submitted', 'completed', 'failed-pre-submit',
        'uncertain', 'close-requested', 'closed', 'invalidated'].includes(String(value.state)) ||
      !validDate(value.created_at) || !validDate(value.updated_at) || !validDate(value.expires_at) ||
      Date.parse(value.updated_at as string) < Date.parse(value.created_at as string) ||
      ((value.workspace_association === 'bound') !== (value.workspace_id !== undefined)) ||
      (value.workspace_association !== 'bound' && value.workspace_id !== undefined) ||
      (commitBinding !== undefined && (
        value.requested_base_ref !== commitBinding.requested_base_ref ||
        value.resolved_base_commit !== commitBinding.base_commit ||
        value.scope_digest !== sha256(commitBinding.scope_prefix) ||
        value.target_fingerprint !== commitReviewTargetFingerprint(policyDigest!, commitBinding.head_commit)
      ))) {
    fail('REVIEW_SHARE_STATE_CORRUPT', 'Corrupt review participant.');
  }
  return {
    ...(value as unknown as ReviewParticipant),
    ...(commitBinding ? { commit_binding: commitBinding } : {})
  };
}

export function parseReviewShareJournal(raw: unknown, taskId?: string): ReviewShareJournal {
  const value = object(raw, 'review share journal');
  strictKeys(value, [
    'schema_version', 'repository_id', 'task_id', 'generation', 'registration_epoch',
    'binding_epoch', 'phase_epoch', 'policy_digest', 'branch', 'head', 'target_fingerprint',
    'target_assurance', 'coding_owner', 'participants', 'created_at', 'updated_at'
  ], 'review share journal');
  if (value.schema_version !== REVIEW_SHARE_SCHEMA_VERSION ||
      typeof value.repository_id !== 'string' || !ID.test(value.repository_id) ||
      typeof value.task_id !== 'string' || !ID.test(value.task_id) ||
      (taskId !== undefined && value.task_id !== taskId) ||
      !integer(value.generation) || !integer(value.registration_epoch) ||
      !integer(value.binding_epoch) || !integer(value.phase_epoch) ||
      typeof value.policy_digest !== 'string' || !HEX64.test(value.policy_digest) ||
      (value.branch !== null && typeof value.branch !== 'string') ||
      typeof value.head !== 'string' || !HEX40_64.test(value.head) ||
      typeof value.target_fingerprint !== 'string' || !HEX64.test(value.target_fingerprint) ||
      (value.target_assurance !== 'phase_only' && value.target_assurance !== 'commit_pinned') ||
      !Array.isArray(value.participants) || value.participants.length > MAX_PARTICIPANTS ||
      !validDate(value.created_at) || !validDate(value.updated_at) ||
      Date.parse(value.updated_at as string) < Date.parse(value.created_at as string)) {
    fail('REVIEW_SHARE_STATE_CORRUPT', 'Corrupt review share journal.');
  }
  const participants = value.participants.map(participant => parseParticipant(participant, value.policy_digest as string));
  const seenParticipants = new Set<string>();
  const seenRuns = new Set<string>();
  for (const participant of participants) {
    if (participant.generation > (value.generation as number) ||
        (participant.generation === value.generation &&
          ((value.target_assurance === 'commit_pinned') !== (participant.commit_binding !== undefined))) ||
        seenParticipants.has(participant.participant_id) || seenRuns.has(participant.run_id)) {
      fail('REVIEW_SHARE_STATE_CORRUPT', 'Corrupt review participant history.');
    }
    seenParticipants.add(participant.participant_id);
    seenRuns.add(participant.run_id);
  }
  return {
    ...(value as Omit<ReviewShareJournal, 'coding_owner' | 'participants'>),
    coding_owner: parseCodingOwner(value.coding_owner),
    participants
  };
}

export async function withTaskShareGate<T>(
  stateDir: string,
  taskId: string,
  fn: () => Promise<T>,
  purpose?: string
) {
  assertTaskId(taskId);
  const store = await StateStore.open(stateDir);
  return withShortLock(
    store,
    shareLockKey(taskId),
    async () => {
      const lease: ShareGateLease = { state_dir: store.dir, task_id: taskId, live: true, token: {} };
      liveShareGateTokens.add(lease.token);
      return shareGateContext.run(lease, async () => {
        try {
          return await fn();
        } finally {
          lease.live = false;
          liveShareGateTokens.delete(lease.token);
        }
      });
    },
    { purpose: purpose ?? ('review share ' + taskId) }
  );
}

export async function assertTaskShareGateHeld(stateDir: string, taskId: string) {
  assertTaskId(taskId);
  const held = shareGateContext.getStore();
  const canonical = await StateStore.canonicalPath(stateDir);
  if (!held || !held.live || !liveShareGateTokens.has(held.token) ||
      held.task_id !== taskId || held.state_dir !== canonical) {
    fail('REVIEW_SHARE_GATE_REQUIRED', 'Shared review preparation requires the matching task share gate.');
  }
}

export async function assertSharedPreparationAuthorizedUnderGate(options: {
  stateDir: string;
  repositoryId: string;
  taskId: string;
  generation: number;
  participantId: string;
  runId: string;
  selectionId: string;
  workspaceRequestId: string;
  coordinator: 'codex' | 'claude';
  profile: string;
  promptDigest: string;
  browserContextDigest: string;
  requestedBaseRef: string;
  resolvedBaseCommit: string;
  commitBinding?: CommitReviewBinding;
}) {
  await assertTaskShareGateHeld(options.stateDir, options.taskId);
  const journal = await readReviewShareJournal(options.stateDir, options.taskId, { required: true });
  if (!journal || journal.repository_id !== options.repositoryId || journal.generation !== options.generation) {
    fail('REVIEW_SHARE_STATE_STALE', 'Shared preparation does not match the durable review generation.');
  }
  const participant = findParticipant(journal, options.participantId);
  if (participant.state !== 'initializing' ||
      participant.generation !== options.generation ||
      participant.run_id !== options.runId ||
      participant.selection_id !== options.selectionId ||
      participant.workspace_request_id !== options.workspaceRequestId ||
      participant.coordinator !== options.coordinator ||
      participant.profile !== options.profile ||
      participant.prompt_digest !== options.promptDigest ||
      participant.browser_context_digest !== options.browserContextDigest ||
      participant.requested_base_ref !== options.requestedBaseRef ||
      participant.resolved_base_commit !== options.resolvedBaseCommit ||
      JSON.stringify(participant.commit_binding ?? null) !== JSON.stringify(options.commitBinding ?? null) ||
      participant.target_fingerprint !== journal.target_fingerprint) {
    fail('REVIEW_SHARE_STATE_STALE', 'Shared preparation does not match the durable initializing participant.');
  }
}

export async function withRepositoryReviewSelectionGate<T>(
  stateDir: string,
  repositoryId: string,
  fn: () => Promise<T>
) {
  assertRepositoryId(repositoryId);
  const store = await StateStore.open(stateDir);
  return withShortLock(store, selectionLockKey(repositoryId), fn, { purpose: 'review selection ' + repositoryId });
}

function knownSharePurpose(taskId: string, purpose: string) {
  const exact = new Set([
    'review share ' + taskId,
    'prepare shared review ' + taskId,
    'review share status ' + taskId,
    'task lifecycle ' + taskId,
    'phase task ' + taskId,
    'rebind task ' + taskId,
    'finish task ' + taskId,
    'open inspect workspace ' + taskId,
    'open code workspace ' + taskId,
    'open review workspace ' + taskId,
    'explicit review share recovery ' + taskId
  ]);
  if (exact.has(purpose)) return true;
  if (/^(?:reconcile|recover|close) review participant [0-9a-f-]{36}$/i.test(purpose)) return true;
  if (/^(?:reserve|transition) shared ChatGPT run [0-9a-f-]{36}$/i.test(purpose)) return true;
  if (/^recover shared ChatGPT (?:request [a-f0-9]{64}|run lock [0-9a-f-]{36})$/i.test(purpose)) return true;
  if (/^revoke review workspace [a-f0-9]{32}$/.test(purpose)) return true;
  if (/^(?:enable|disable) repository [A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(purpose)) return true;
  return /^set repository [A-Za-z0-9][A-Za-z0-9._-]{0,63} surface policy (?:default|chat-only)$/.test(purpose);
}

export async function recoverTaskShareStaleLock(stateDir: string, taskId: string) {
  assertTaskId(taskId);
  const store = await StateStore.open(stateDir);
  const key = shareLockKey(taskId);
  const raw = await store.read<unknown>(`locks/${key}.json`, 'lock');
  if (raw === undefined) return { recovered: false as const, task_id: taskId };
  const existing = validateLockRecord(raw, key);
  if (existing.hostname !== os.hostname()) throw new SafeError('Review share lock belongs to another host; recovery is refused.');
  if (lockOwnerAlive(existing.pid)) throw new SafeError('Review share lock is owned by a live process; recovery is refused.');
  if (!knownSharePurpose(taskId, existing.purpose)) {
    throw new SafeError(`Review share lock has unexpected purpose "${existing.purpose}"; inspect it before recovery.`);
  }
  const recovered = await acquireLock(store, key, 'explicit review share recovery ' + taskId, {
    recoverStale: true,
    expectedExistingPurpose: existing.purpose,
    expectedExistingToken: existing.token
  });
  await recovered.release();
  return {
    recovered: true as const,
    task_id: taskId,
    previous_pid: existing.pid,
    previous_purpose: existing.purpose
  };
}

export async function readReviewShareJournal(
  stateDir: string,
  taskId: string,
  options: { required?: boolean } = {}
) {
  assertTaskId(taskId);
  const store = await StateStore.inspect(stateDir);
  const raw = await store?.read<unknown>(reviewSharePath(taskId), REVIEW_SHARE_KIND);
  if (raw === undefined) {
    if (options.required) fail('REVIEW_SHARE_STATE_MISSING', 'Review share state is missing; recovery inspection is required.');
    return undefined;
  }
  return parseReviewShareJournal(raw, taskId);
}

export async function writeReviewShareJournalUnderGate(stateDir: string, journal: ReviewShareJournal) {
  const checked = parseReviewShareJournal(journal, journal.task_id);
  const store = await StateStore.open(stateDir);
  await store.write(reviewSharePath(journal.task_id), REVIEW_SHARE_KIND, checked);
  return checked;
}

type FingerprintKey = { schema_version: 1; key: string; created_at: string };
function parseFingerprintKey(raw: unknown): FingerprintKey {
  const value = object(raw, 'review fingerprint key');
  strictKeys(value, ['schema_version', 'key', 'created_at'], 'review fingerprint key');
  if (value.schema_version !== 1 || typeof value.key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.key) ||
      !validDate(value.created_at)) fail('REVIEW_SHARE_STATE_CORRUPT', 'Corrupt review fingerprint key.');
  return value as FingerprintKey;
}
async function ownerFingerprintKey(stateDir: string) {
  const store = await StateStore.open(stateDir);
  const existing = await store.read<unknown>(FINGERPRINT_KEY_PATH, FINGERPRINT_KEY_KIND);
  if (existing !== undefined) return Buffer.from(parseFingerprintKey(existing).key, 'base64url');
  const record: FingerprintKey = {
    schema_version: 1,
    key: randomBytes(32).toString('base64url'),
    created_at: new Date().toISOString()
  };
  if (await store.create(FINGERPRINT_KEY_PATH, FINGERPRINT_KEY_KIND, record)) return Buffer.from(record.key, 'base64url');
  const raced = await store.read<unknown>(FINGERPRINT_KEY_PATH, FINGERPRINT_KEY_KIND);
  if (raced === undefined) fail('REVIEW_SHARE_STATE_CORRUPT', 'Review fingerprint key creation raced without durable state.');
  return Buffer.from(parseFingerprintKey(raced).key, 'base64url');
}

export async function computeCurrentReviewTarget(
  stateDir: string,
  repositoryId: string,
  taskId: string
): Promise<{
  repository: RepositoryRegistration;
  task: TaskRegistration;
  target: Awaited<ReturnType<typeof computeTargetFingerprintV1>> & { assurance: 'phase_only' };
}> {
  const catalog = await readMultiRepoCatalog(stateDir);
  const repository = catalog.repositories[repositoryId];
  const task = catalog.tasks[taskId];
  if (!repository || !repository.enabled) fail('REVIEW_REPOSITORY_UNAVAILABLE', 'Repository ' + repositoryId + ' is not enabled.');
  if (!task || task.repository_id !== repositoryId || task.completed) {
    fail('REVIEW_TASK_REQUIRED', 'Task ' + taskId + ' is not an unfinished task for repository ' + repositoryId + '.');
  }
  const store = await StateStore.inspect(stateDir);
  if (!store) fail('REVIEW_SHARE_STATE_MISSING', 'Operator state is missing.');
  const rawPolicy = await store.read<unknown>(repository.policy_ref, 'repository-policy');
  if (rawPolicy === undefined) fail('REVIEW_SHARE_STATE_CORRUPT', 'Registered review policy is missing.');
  const policy = loadPolicy(rawPolicy);
  const compiled = await compilePolicyFor(policy, { root: repository.root, protectedPaths: [stateDir] });
  const target = await computeTargetFingerprintV1({
    root: repository.root,
    pathPolicy: compiled.paths,
    limits: policy.limits,
    deniedMetadataKey: await ownerFingerprintKey(stateDir)
  });
  return { repository, task, target: { ...target, assurance: 'phase_only' as const } };
}

export async function computeCommitReviewTarget(
  stateDir: string,
  repositoryId: string,
  taskId: string,
  headCommit: string
): Promise<{
  repository: RepositoryRegistration;
  task: TaskRegistration;
  target: { branch: null; head: string; fingerprint: string; assurance: 'commit_pinned' };
}> {
  if (!HEX40_64.test(headCommit)) throw new SafeError('Invalid commit-pinned review head commit.');
  const catalog = await readMultiRepoCatalog(stateDir);
  const repository = catalog.repositories[repositoryId];
  const task = catalog.tasks[taskId];
  if (!repository || !repository.enabled) fail('REVIEW_REPOSITORY_UNAVAILABLE', 'Repository ' + repositoryId + ' is not enabled.');
  if (!task || task.repository_id !== repositoryId || task.completed) {
    fail('REVIEW_TASK_REQUIRED', 'Task ' + taskId + ' is not an unfinished task for repository ' + repositoryId + '.');
  }
  return {
    repository,
    task,
    target: {
      branch: null,
      head: headCommit,
      fingerprint: commitReviewTargetFingerprint(repository.policy_digest, headCommit),
      assurance: 'commit_pinned'
    }
  };
}

export function participantProtected(participant: ReviewParticipant) {
  return participant.state !== 'closed' && participant.state !== 'invalidated';
}
export function currentParticipants(journal: ReviewShareJournal) {
  return journal.participants.filter(p => p.generation === journal.generation);
}
export function protectedParticipants(journal: ReviewShareJournal) {
  return currentParticipants(journal).filter(participantProtected);
}
export function findParticipant(journal: ReviewShareJournal, participantId: string) {
  const participant = journal.participants.find(p => p.participant_id === participantId);
  if (!participant) fail('REVIEW_PARTICIPANT_UNKNOWN', 'Review participant is unknown.');
  return participant;
}

export async function sharedRunEvidenceExists(stateDir: string, taskId: string) {
  const store = await StateStore.inspect(stateDir);
  if (!store) return false;
  const names = (await store.list('chatgpt-runs')).filter(name => name.endsWith('.json'));
  if (names.length > MAX_RUN_RECORDS) fail('REVIEW_SHARE_STATE_CORRUPT', 'Too many ChatGPT run records for bounded review-state inspection.');
  for (const name of names) {
    const raw = await store.read<any>('chatgpt-runs/' + name, 'chatgpt-run-v1');
    if (raw?.task_id === taskId && raw?.share_generation !== undefined) return true;
  }
  return false;
}

export async function invalidateReviewShareUnderGate(
  stateDir: string,
  taskId: string,
  reason: string,
  workspaceId?: string
) {
  const journal = await readReviewShareJournal(stateDir, taskId);
  if (!journal) return { changed: false };
  const at = new Date().toISOString();
  let changed = false;
  const participants = journal.participants.map(participant => {
    const current = participant.generation === journal.generation;
    const workspaceMatch = workspaceId === undefined || participant.workspace_id === workspaceId;
    if (current && workspaceMatch && participantProtected(participant)) {
      changed = true;
      return { ...participant, state: 'invalidated' as const, updated_at: at };
    }
    return participant;
  });
  if (!changed) return { changed: false };
  await writeReviewShareJournalUnderGate(stateDir, { ...journal, participants, updated_at: at });
  return { changed: true, reason };
}

type MinimalRun = {
  task_id?: unknown;
  state?: unknown;
  registration_epoch?: unknown;
  binding_epoch?: unknown;
  phase_epoch?: unknown;
  policy_digest?: unknown;
  share_generation?: unknown;
};
const PROTECTED_LEGACY_STATES = new Set(['submission-reserved', 'submitted', 'uncertain']);

async function currentLegacyProtectedRuns(
  stateDir: string,
  task: TaskRegistration,
  repository: RepositoryRegistration
) {
  const store = await StateStore.inspect(stateDir);
  if (!store) return 0;
  const names = (await store.list('chatgpt-runs')).filter(name => name.endsWith('.json'));
  if (names.length > MAX_RUN_RECORDS) fail('REVIEW_SHARE_STATE_CORRUPT', 'Too many ChatGPT run records for bounded lifecycle inspection.');
  let count = 0;
  for (const name of names) {
    const raw = await store.read<MinimalRun>('chatgpt-runs/' + name, 'chatgpt-run-v1');
    if (!raw || typeof raw !== 'object') fail('REVIEW_SHARE_STATE_CORRUPT', 'Corrupt ChatGPT run evidence.');
    if (raw.task_id !== task.task_id || raw.share_generation !== undefined || !PROTECTED_LEGACY_STATES.has(String(raw.state))) continue;
    if (raw.registration_epoch === repository.registration_epoch &&
        raw.binding_epoch === task.binding_epoch &&
        raw.phase_epoch === task.phase_epoch &&
        raw.policy_digest === repository.policy_digest &&
        repository.enabled) count++;
  }
  return count;
}

type MinimalWorkspace = {
  workspace_id?: unknown;
  repository_id?: unknown;
  task_id?: unknown;
  mode?: unknown;
  registration_epoch?: unknown;
  binding_epoch?: unknown;
  phase_epoch?: unknown;
  policy_digest?: unknown;
  status?: unknown;
  issued_at?: unknown;
  expires_at?: unknown;
};
async function authWorkspaces(stateDir: string): Promise<MinimalWorkspace[]> {
  const store = await StateStore.inspect(stateDir);
  if (!store) return [];
  const raw = await store.read<any>('control/multirepo-auth.json', 'multirepo-auth');
  if (raw === undefined) return [];
  if (!raw || raw.schema_version !== 1 || !raw.workspaces || typeof raw.workspaces !== 'object' || Array.isArray(raw.workspaces)) {
    fail('REVIEW_SHARE_STATE_CORRUPT', 'Corrupt workspace authorization evidence.');
  }
  return Object.values(raw.workspaces);
}
function workspaceCurrent(workspace: MinimalWorkspace, task: TaskRegistration, repository: RepositoryRegistration) {
  return workspace.repository_id === repository.repository_id &&
    workspace.task_id === task.task_id &&
    workspace.registration_epoch === repository.registration_epoch &&
    workspace.binding_epoch === task.binding_epoch &&
    workspace.phase_epoch === task.phase_epoch &&
    workspace.policy_digest === repository.policy_digest;
}
// An expired selection holds no authority (authorization rejects it), even if its client never closed it.
function workspaceLive(workspace: MinimalWorkspace) {
  return workspace.status === 'open' && typeof workspace.expires_at === 'string' && Date.now() < Date.parse(workspace.expires_at);
}

export async function assertReviewLifecycleAllowedUnderGate(stateDir: string, taskId: string) {
  const catalog = await readMultiRepoCatalog(stateDir);
  const task = catalog.tasks[taskId];
  if (!task) return;
  const repository = catalog.repositories[task.repository_id];
  if (!repository) fail('REVIEW_PROTECTED', 'Task repository authorization is missing.');

  const journal = await readReviewShareJournal(stateDir, taskId);
  if (journal) {
    const currentAuthorized = journal.registration_epoch === repository.registration_epoch &&
      journal.binding_epoch === task.binding_epoch &&
      journal.phase_epoch === task.phase_epoch &&
      journal.policy_digest === repository.policy_digest &&
      repository.enabled;
    if (currentAuthorized && protectedParticipants(journal).length) {
      fail('REVIEW_PROTECTED', 'Task has protected shared-review participants.');
    }
  }
  if (await currentLegacyProtectedRuns(stateDir, task, repository)) {
    fail('REVIEW_PROTECTED', 'Task has an unresolved currently authorized legacy review run.');
  }
  const openCurrent = (await authWorkspaces(stateDir)).filter(workspace =>
    workspaceCurrent(workspace, task, repository) && workspaceLive(workspace)
  );
  if (openCurrent.length) {
    const ids = openCurrent.map(workspace => String(workspace.workspace_id)).join(', ');
    fail('REVIEW_PROTECTED', `Task has a protected active review/coding workspace (${ids}). After its ChatGPT run is complete, close it with: coord workspace revoke --workspace ID`);
  }
}

async function protectedReviewWorkspaceIdsUnderHeldGates(stateDir: string) {
  const catalog = await readMultiRepoCatalog(stateDir);
  const protectedIds = new Set<string>();
  const { chatGptRunStatus } = await import('./chatgpt-run.js');
  for (const task of Object.values(catalog.tasks)) {
    const journal = await readReviewShareJournal(stateDir, task.task_id);
    if (!journal) continue;
    for (const participant of journal.participants) {
      if (participant.state === 'closed') continue;
      if (participant.workspace_association === 'bound' && participant.workspace_id) {
        protectedIds.add(participant.workspace_id);
        continue;
      }
      if (participant.workspace_association !== 'pending') continue;

      const run = await chatGptRunStatus(participant.run_id, stateDir);
      await assertAndSyncSharedRunUnderGate(stateDir, run, { allowInvalidated: true });
      const outcome = await readWorkspaceOpenOutcome({
        stateDir,
        requestId: participant.workspace_request_id,
        repositoryId: journal.repository_id,
        taskId: journal.task_id,
        mode: 'review',
        ttlMs: participant.workspace_ttl_ms,
        // A commit-pinned open recorded its binding in the request digest.
        reviewBinding: participant.commit_binding
      });
      if (!outcome) continue;
      const selection = outcome.selection;
      if (selection.workspace_id !== outcome.request.workspace_id ||
          selection.repository_id !== run.repository_id ||
          selection.task_id !== run.task_id ||
          selection.mode !== 'review' ||
          selection.registration_epoch !== run.registration_epoch ||
          selection.binding_epoch !== run.binding_epoch ||
          selection.phase_epoch !== run.phase_epoch ||
          selection.policy_digest !== run.policy_digest) {
        fail('REVIEW_SHARE_STATE_CORRUPT', 'Authoritative pending workspace evidence does not match its shared run.');
      }
      protectedIds.add(selection.workspace_id);
    }
  }
  return protectedIds;
}

export async function withProtectedReviewWorkspaceIds<T>(
  stateDir: string,
  fn: (workspaceIds: Set<string>) => Promise<T>
) {
  const initial = await readMultiRepoCatalog(stateDir);
  const taskIds = Object.keys(initial.tasks).sort();
  const hold = async (index: number): Promise<T> => {
    if (index < taskIds.length) {
      return withTaskShareGate(stateDir, taskIds[index], () => hold(index + 1));
    }
    const current = await readMultiRepoCatalog(stateDir);
    const currentTaskIds = Object.keys(current.tasks).sort();
    if (JSON.stringify(currentTaskIds) !== JSON.stringify(taskIds)) {
      fail('REVIEW_SHARE_STATE_STALE', 'Task catalog changed during review authorization garbage collection.');
    }
    return fn(await protectedReviewWorkspaceIdsUnderHeldGates(stateDir));
  };
  return hold(0);
}

export async function protectedReviewWorkspaceIds(stateDir: string) {
  return withProtectedReviewWorkspaceIds(stateDir, async workspaceIds => workspaceIds);
}

export async function codingOwnerSummary(
  stateDir: string,
  repository: RepositoryRegistration,
  task: TaskRegistration
): Promise<ReviewCodingOwner> {
  const workspaces = await authWorkspaces(stateDir);
  const currentCode = workspaces.find(workspace =>
    workspaceCurrent(workspace, task, repository) && workspace.mode === 'code' && workspaceLive(workspace)
  );
  const anyCode = workspaces.find(workspace =>
    workspace.repository_id === repository.repository_id && workspace.task_id === task.task_id && workspace.mode === 'code'
  );
  const recordedAt = String((currentCode ?? anyCode)?.issued_at ?? task.created_at);
  return {
    status: currentCode ? 'active' : anyCode ? 'inactive' : 'unknown',
    coordinator: null,
    provenance: 'legacy-unknown',
    recorded_at: Number.isFinite(Date.parse(recordedAt)) ? recordedAt : task.created_at
  };
}

export async function publicReviewTaskSummary(
  stateDir: string,
  repository: RepositoryRegistration,
  task: TaskRegistration
) {
  const journal = await readReviewShareJournal(stateDir, task.task_id);
  const participants = journal ? currentParticipants(journal) : [];
  const now = Date.now();
  const counts = { active: 0, prepared: 0, reserved: 0, submitted: 0, uncertain: 0, stale: 0 };
  for (const participant of participants) {
    if (participantProtected(participant)) counts.active++;
    if (participant.state === 'prepared' || participant.state === 'initializing') counts.prepared++;
    if (participant.state === 'submission-reserved') counts.reserved++;
    if (participant.state === 'submitted') counts.submitted++;
    if (participant.state === 'uncertain') counts.uncertain++;
    if (participantProtected(participant) && Date.parse(participant.expires_at) <= now) counts.stale++;
  }
  const legacyProtected = await currentLegacyProtectedRuns(stateDir, task, repository);
  const conflicts: string[] = [];
  if (task.phase !== 'review' && counts.active) conflicts.push('incompatible phase');
  if (counts.active) conflicts.push('active reviewers');
  if (counts.submitted || counts.uncertain || legacyProtected) conflicts.push('unresolved submitted run');
  if (task.phase === 'coding') conflicts.push('owner action');
  if (journal && (journal.registration_epoch !== repository.registration_epoch ||
      journal.binding_epoch !== task.binding_epoch || journal.phase_epoch !== task.phase_epoch ||
      journal.policy_digest !== repository.policy_digest)) conflicts.push('stale identity');
  const updatedAt = journal?.updated_at ?? task.updated_at;
  return {
    updated_at: updatedAt,
    age_seconds: Math.max(0, Math.floor((now - Date.parse(updatedAt)) / 1000)),
    coding_owner: await codingOwnerSummary(stateDir, repository, task),
    participant_counts: counts,
    conflict_hints: [...new Set(conflicts)]
  };
}

export function sanitizedReviewStatus(journal: ReviewShareJournal, summary: Awaited<ReturnType<typeof publicReviewTaskSummary>>) {
  return {
    repository_id: journal.repository_id,
    task_id: journal.task_id,
    generation: journal.generation,
    target_assurance: journal.target_assurance,
    coding_owner: summary.coding_owner,
    participant_counts: summary.participant_counts,
    conflict_hints: summary.conflict_hints,
    updated_at: summary.updated_at,
    age_seconds: summary.age_seconds,
    participants: currentParticipants(journal).map(participant => ({
      participant_id: participant.participant_id,
      coordinator: participant.coordinator,
      run_id: participant.run_id,
      state: participant.state,
      workspace_association: participant.workspace_association,
      created_at: participant.created_at,
      updated_at: participant.updated_at
    }))
  };
}

export function runStateToParticipantState(state: string): ReviewParticipantState | undefined {
  if (state === 'prepared' || state === 'submission-reserved' || state === 'submitted' ||
      state === 'completed' || state === 'failed-pre-submit' || state === 'uncertain') return state;
  if (state === 'verification-pending') return 'prepared';
  return undefined;
}

export async function assertAndSyncSharedRunUnderGate(
  stateDir: string,
  run: {
    task_id: string;
    run_id: string;
    coordinator: 'codex' | 'claude';
    profile: string;
    requested_base_ref: string;
    resolved_base_commit: string;
    commit_binding?: CommitReviewBinding;
    prompt_sha256: string;
    selection: { selection_id: string; browser_context: unknown };
    share_generation?: number;
    participant_id?: string;
    workspace_request_id?: string;
    registration_epoch: number;
    binding_epoch: number;
    phase_epoch: number;
    policy_digest: string;
    state: string;
  },
  options: {
    requireBound?: boolean;
    allowInvalidated?: boolean;
    observedTarget?: { fingerprint: string; head: string; branch: string | null };
  } = {}
) {
  if (run.share_generation === undefined && run.participant_id === undefined && run.workspace_request_id === undefined) return undefined;
  if (!integer(run.share_generation) || typeof run.participant_id !== 'string' || !UUID.test(run.participant_id) ||
      typeof run.workspace_request_id !== 'string' || !REQUEST_ID.test(run.workspace_request_id)) {
    fail('REVIEW_SHARE_STATE_CORRUPT', 'Shared ChatGPT run binding is corrupt.');
  }
  const journal = await readReviewShareJournal(stateDir, run.task_id, { required: true });
  const participant = findParticipant(journal!, run.participant_id);
  const currentGeneration = participant.generation === journal!.generation;
  if (participant.generation !== run.share_generation || participant.run_id !== run.run_id ||
      participant.workspace_request_id !== run.workspace_request_id ||
      participant.coordinator !== run.coordinator || participant.profile !== run.profile ||
      participant.selection_id !== run.selection.selection_id ||
      participant.requested_base_ref !== run.requested_base_ref ||
      participant.resolved_base_commit !== run.resolved_base_commit ||
      JSON.stringify(participant.commit_binding ?? null) !== JSON.stringify(run.commit_binding ?? null) ||
      participant.prompt_digest !== run.prompt_sha256 ||
      participant.browser_context_digest !== sha256(JSON.stringify(run.selection.browser_context)) ||
      (currentGeneration && participant.target_fingerprint !== journal!.target_fingerprint)) {
    fail('REVIEW_SHARE_STATE_STALE', 'Shared run does not match the durable generation binding.');
  }
  if (participant.state === 'invalidated' && !options.allowInvalidated) {
    fail('REVIEW_AUTHORITY_INVALIDATED', 'Shared review authority was invalidated; recovery only.');
  }
  if (options.requireBound && participant.workspace_association !== 'bound') {
    fail('WORKSPACE_RECONCILIATION_REQUIRED', 'Review completion/close requires authoritative workspace reconciliation.');
  }
  const catalog = await readMultiRepoCatalog(stateDir);
  const task = catalog.tasks[run.task_id];
  const repository = task ? catalog.repositories[task.repository_id] : undefined;
  if (!task || !repository || task.completed || !repository.enabled ||
      repository.registration_epoch !== run.registration_epoch ||
      task.binding_epoch !== run.binding_epoch || task.phase_epoch !== run.phase_epoch ||
      repository.policy_digest !== run.policy_digest) {
    if (!options.allowInvalidated) fail('REVIEW_AUTHORITY_INVALIDATED', 'Shared review authority is no longer current.');
  }
  if (options.observedTarget && currentGeneration) {
    if (options.observedTarget.fingerprint !== journal!.target_fingerprint ||
        options.observedTarget.head !== journal!.head ||
        options.observedTarget.branch !== journal!.branch) {
      fail('TARGET_CHANGED', 'The live review target changed; do not mix reviewer generations.');
    }
  }
  const mapped = runStateToParticipantState(run.state);
  if (mapped && participant.state !== 'invalidated' && participant.state !== 'closed' && participant.state !== mapped) {
    const at = new Date().toISOString();
    const participants = journal!.participants.map(item =>
      item.participant_id === participant.participant_id ? { ...item, state: mapped, updated_at: at } : item
    );
    await writeReviewShareJournalUnderGate(stateDir, { ...journal!, participants, updated_at: at });
    return participants.find(item => item.participant_id === participant.participant_id);
  }
  return participant;
}
