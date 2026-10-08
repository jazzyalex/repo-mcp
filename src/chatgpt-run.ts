import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { lstat } from 'node:fs/promises';
import { SafeError, sha256 } from './errors.js';
import { resolveGitCommit } from './git-ref.js';
import { resolveIdentity } from './identity.js';
import {
  MODEL_POLICY_SCHEMA_VERSION,
  resolveModelProfile,
  trustedBrowserContextBinding,
  verifyModelSelection,
  type ChatSurface,
  type ModelProfile,
  type ModelSelectionContract,
  type SanitizedModelSelectionEvidence
} from './model-policy.js';
import { readMultiRepoCatalog } from './multirepo-state.js';
import { StateStore, acquireLock, defaultStateDir, validateLockRecord, lockOwnerAlive, withShortLock, type LockRecord } from './task-state.js';
import { taskStatus } from './task.js';

export const CHATGPT_RUN_SCHEMA_VERSION = 1 as const;
export type ChatGptCoordinator = 'codex' | 'claude';
export type ChatGptWorkKind = 'review' | 'architecture' | 'code';
export type ChatGptRunState = 'prepared' | 'verification-pending' | 'submission-reserved' |
  'submitted' | 'completed' | 'failed-pre-submit' | 'uncertain';

export type ChatGptRunRecord = {
  schema_version: typeof CHATGPT_RUN_SCHEMA_VERSION;
  run_id: string;
  coordinator: ChatGptCoordinator;
  execution_surface: 'ChatGPT web';
  work_kind: ChatGptWorkKind;
  profile: ModelProfile;
  state: ChatGptRunState;
  repository_id: string;
  task_id: string;
  registration_epoch: number;
  binding_epoch: number;
  phase_epoch: number;
  policy_digest: string;
  root_sha256: string;
  branch: string | null;
  head: string;
  requested_base_ref: string;
  resolved_base_commit: string;
  prompt_sha256: string;
  request_key: string;
  selection: ModelSelectionContract;
  created_at: string;
  updated_at: string;
  submitted_at?: string;
  completed_at?: string;
  output_sha256?: string;
  outcome?: 'ship' | 'no-ship' | 'completed';
  failure_code?: string;
  uncertain_from?: 'submission-reserved' | 'submitted';
  model_verified_at?: string;
  submission_event_sha256?: string;
  submission_observed_at?: string;
  completion_event_sha256?: string;
  completion_submission_event_sha256?: string;
  completion_observed_at?: string;
  recovery_event_sha256?: string;
  recovery_observed_at?: string;
};

export type TrustedChatGptRunReceipt = {
  repositoryId: string;
  taskId: string;
  promptSha256: string;
  baseCommit: string;
  browserEventId: string;
  observedAt: string;
  conversationId?: string;
  sessionId?: string;
};

/** The trusted adapter emits this only after observing a finished response. */
export type TrustedChatGptCompletionReceipt = TrustedChatGptRunReceipt & {
  kind: 'completion';
  responseState: 'completed';
  submissionEventSha256: string;
  outputSha256: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEX = /^[a-f0-9]{64}$/;
const KIND = 'chatgpt-run-v1';
const REQUEST_KIND = 'chatgpt-run-request-v1';
const RECEIPT_MAX_AGE_MS = 60_000;
const STATES = new Set<ChatGptRunState>(['prepared', 'verification-pending', 'submission-reserved', 'submitted', 'completed', 'failed-pre-submit', 'uncertain']);
const PROFILES = new Set<ModelProfile>(['code', 'code-hard', 'review', 'review-critical', 'brainstorm', 'plan', 'architecture']);
const PROFILE_SELECTION = {
  code: ['High', 'Sol', 'High'],
  'code-hard': ['XHigh', 'Sol', 'Extra High'],
  review: ['XHigh', 'Sol', 'Extra High'],
  'review-critical': ['Pro', 'Sol Pro', 'Pro'],
  brainstorm: ['Pro', 'Sol Pro', 'Pro'],
  plan: ['Pro', 'Sol Pro', 'Pro'],
  architecture: ['Pro', 'Sol Pro', 'Pro']
} as const;
const RECORD_KEYS = new Set([
  'schema_version', 'run_id', 'coordinator', 'execution_surface', 'work_kind', 'profile', 'state',
  'repository_id', 'task_id', 'registration_epoch', 'binding_epoch', 'phase_epoch', 'policy_digest',
  'root_sha256', 'branch', 'head', 'requested_base_ref', 'resolved_base_commit', 'prompt_sha256', 'request_key',
  'selection', 'created_at', 'updated_at', 'submitted_at', 'completed_at', 'output_sha256', 'outcome',
  'failure_code', 'uncertain_from', 'model_verified_at',
  'submission_event_sha256', 'submission_observed_at', 'completion_event_sha256', 'completion_observed_at',
  'completion_submission_event_sha256',
  'recovery_event_sha256', 'recovery_observed_at'
]);
const SELECTION_KEYS = new Set([
  'schema_version', 'selection_id', 'profile', 'surface', 'picker_target', 'expected_model_label',
  'expected_target_label', 'required_selection_method', 'required_evidence_source', 'requested_at',
  'expires_at', 'browser_context'
]);
export const CHATGPT_RUN_MAX_PROMPT_BYTES = 256 * 1024;
export const CHATGPT_RUN_MAX_OUTPUT_BYTES = 1024 * 1024;
const recordPath = (runId: string) => `chatgpt-runs/${runId}.json`;
const requestPath = (requestKey: string) => `chatgpt-run-requests/${requestKey}.json`;
const lockKey = (runId: string) => `chatgpt-run-${runId}`;

function assertId(value: string, name: string) {
  if (!ID.test(value)) throw new SafeError(`Invalid ${name}.`);
}
function assertRunId(value: string) {
  if (!UUID.test(value)) throw new SafeError('Invalid ChatGPT run ID.');
}
function assertPrompt(prompt: string) {
  if (!prompt.trim()) throw new SafeError('ChatGPT run prompt must not be empty.');
  if (Buffer.byteLength(prompt, 'utf8') > CHATGPT_RUN_MAX_PROMPT_BYTES) throw new SafeError('ChatGPT run prompt exceeds 256 KiB.');
}
function profileFor(kind: ChatGptWorkKind, profile?: ModelProfile): ModelProfile {
  const chosen = profile ?? (kind === 'architecture' ? 'architecture' : kind === 'code' ? 'code' : 'review');
  const allowed = kind === 'architecture'
    ? new Set<ModelProfile>(['architecture'])
    : kind === 'code'
      ? new Set<ModelProfile>(['code', 'code-hard'])
      : new Set<ModelProfile>(['review', 'review-critical']);
  if (!allowed.has(chosen)) throw new SafeError(`Model profile ${chosen} is not valid for ChatGPT ${kind} work.`);
  return chosen;
}
function nowIso(now?: Date) {
  const date = now ?? new Date();
  if (!Number.isFinite(date.getTime())) throw new SafeError('Invalid ChatGPT run time.');
  return date.toISOString();
}
function sanitizeFailure(code: string) {
  if (!/^[A-Z][A-Z0-9_-]{0,63}$/.test(code)) throw new SafeError('Failure code must be an uppercase identifier.');
  return code;
}

function browserEventHash(value: string) {
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) throw new SafeError('Browser event ID must be a nonempty control-free string of at most 512 characters.');
  return sha256(`browser-event\0${value}`);
}

function validateTrustedReceipt(record: ChatGptRunRecord, receipt: TrustedChatGptRunReceipt, now = new Date(), notBefore = record.created_at) {
  const observed = Date.parse(receipt.observedAt);
  const current = now.getTime();
  if (!Number.isFinite(observed) || observed > current || current - observed > RECEIPT_MAX_AGE_MS ||
      observed < Date.parse(notBefore)) {
    throw new SafeError('Trusted browser receipt has an invalid or stale observation time.');
  }
  if (receipt.repositoryId !== record.repository_id || receipt.taskId !== record.task_id ||
      receipt.promptSha256 !== record.prompt_sha256 || receipt.baseCommit !== record.resolved_base_commit) {
    throw new SafeError('Trusted browser receipt does not match this ChatGPT run.');
  }
  const context = trustedBrowserContextBinding({ conversationId: receipt.conversationId, sessionId: receipt.sessionId });
  if (JSON.stringify(context) !== JSON.stringify(record.selection.browser_context)) {
    throw new SafeError('Trusted browser receipt came from a different browser context.');
  }
  return { event: browserEventHash(receipt.browserEventId), observedAt: new Date(observed).toISOString() };
}

function validateRun(raw: unknown, runId: string): ChatGptRunRecord {
  assertRunId(runId);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SafeError(`ChatGPT run ${runId} does not exist or is corrupt.`);
  const record = raw as ChatGptRunRecord;
  const validDate = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
  const validEpoch = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 1;
  const selection = record.selection;
  const expectedSelection = selection && PROFILES.has(selection.profile) ? PROFILE_SELECTION[selection.profile] : undefined;
  const expectedRequestKey = selection && typeof selection === 'object'
    ? sha256(JSON.stringify([
      record.repository_id, record.task_id, record.registration_epoch, record.binding_epoch, record.phase_epoch,
      record.policy_digest, record.head, record.resolved_base_commit, record.prompt_sha256, selection.browser_context,
      record.coordinator, record.work_kind, record.profile
    ]))
    : '';
  if (Object.keys(record).some(key => !RECORD_KEYS.has(key)) ||
      record.schema_version !== CHATGPT_RUN_SCHEMA_VERSION || record.run_id !== runId ||
      (record.coordinator !== 'codex' && record.coordinator !== 'claude') || record.execution_surface !== 'ChatGPT web' ||
      !['review', 'architecture', 'code'].includes(record.work_kind) || !PROFILES.has(record.profile) || !STATES.has(record.state) ||
      !ID.test(record.repository_id) || !ID.test(record.task_id) || !validEpoch(record.registration_epoch) ||
      !validEpoch(record.binding_epoch) || !validEpoch(record.phase_epoch) || !HEX.test(record.policy_digest) ||
      !HEX.test(record.root_sha256) || (record.branch !== null && typeof record.branch !== 'string') ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.head) || typeof record.requested_base_ref !== 'string' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.resolved_base_commit) || !HEX.test(record.prompt_sha256) ||
      !HEX.test(record.request_key) || record.request_key !== expectedRequestKey ||
      !selection || typeof selection !== 'object' || Object.keys(selection).some(key => !SELECTION_KEYS.has(key)) ||
      selection.schema_version !== MODEL_POLICY_SCHEMA_VERSION || selection.profile !== record.profile || !UUID.test(selection.selection_id) ||
      (selection.surface !== 'chat' && selection.surface !== 'work') || !expectedSelection ||
      selection.picker_target !== expectedSelection[0] || selection.expected_model_label !== expectedSelection[1] ||
      selection.expected_target_label !== expectedSelection[2] || selection.required_selection_method !== 'model-picker' ||
      selection.required_evidence_source !== 'trusted-browser-adapter-live-control' ||
      !validDate(selection.requested_at) || !validDate(selection.expires_at) ||
      !selection.browser_context || typeof selection.browser_context !== 'object' ||
      Object.keys(selection.browser_context).length < 1 ||
      Object.keys(selection.browser_context).some(key => key !== 'conversation_id_sha256' && key !== 'session_id_sha256') ||
      Object.values(selection.browser_context).some(value => typeof value !== 'string' || !HEX.test(value)) ||
      !validDate(record.created_at) || !validDate(record.updated_at) ||
      Date.parse(record.updated_at) < Date.parse(record.created_at) ||
      (record.submitted_at !== undefined && !validDate(record.submitted_at)) ||
      (record.completed_at !== undefined && !validDate(record.completed_at)) ||
      (record.output_sha256 !== undefined && !HEX.test(record.output_sha256)) ||
      (record.outcome !== undefined && !['ship', 'no-ship', 'completed'].includes(record.outcome)) ||
      (record.failure_code !== undefined && !/^[A-Z][A-Z0-9_-]{0,63}$/.test(record.failure_code)) ||
      (record.model_verified_at !== undefined && !validDate(record.model_verified_at)) ||
      (record.submission_event_sha256 !== undefined && !HEX.test(record.submission_event_sha256)) ||
      (record.submission_observed_at !== undefined && !validDate(record.submission_observed_at)) ||
      (record.completion_event_sha256 !== undefined && !HEX.test(record.completion_event_sha256)) ||
      (record.completion_submission_event_sha256 !== undefined && !HEX.test(record.completion_submission_event_sha256)) ||
      (record.completion_observed_at !== undefined && !validDate(record.completion_observed_at)) ||
      (record.recovery_event_sha256 !== undefined && !HEX.test(record.recovery_event_sha256)) ||
      (record.recovery_observed_at !== undefined && !validDate(record.recovery_observed_at)) ||
      ((record.submission_event_sha256 === undefined) !== (record.submission_observed_at === undefined)) ||
      ((record.completion_event_sha256 === undefined) !== (record.completion_observed_at === undefined)) ||
      ((record.recovery_event_sha256 === undefined) !== (record.recovery_observed_at === undefined)) ||
      (record.uncertain_from !== undefined && record.uncertain_from !== 'submission-reserved' && record.uncertain_from !== 'submitted') ||
      (record.coordinator === 'claude' && record.work_kind === 'code') ||
      (record.work_kind === 'architecture' && record.profile !== 'architecture') ||
      (record.work_kind === 'review' && record.profile !== 'review' && record.profile !== 'review-critical') ||
      (record.work_kind === 'code' && record.profile !== 'code' && record.profile !== 'code-hard') ||
      (['submission-reserved', 'submitted', 'completed', 'uncertain'].includes(record.state) && record.model_verified_at === undefined) ||
      (record.state === 'prepared' && (record.model_verified_at !== undefined || record.submitted_at !== undefined ||
        record.submission_event_sha256 !== undefined || record.completion_event_sha256 !== undefined)) ||
      (record.state === 'verification-pending' && (record.model_verified_at !== undefined || record.submitted_at !== undefined)) ||
      (record.state === 'submission-reserved' && (record.submitted_at !== undefined || record.submission_event_sha256 !== undefined)) ||
      (record.state === 'uncertain' && (record.uncertain_from === undefined || record.failure_code === undefined ||
        (record.uncertain_from === 'submission-reserved' && (record.submitted_at !== undefined ||
          record.submission_event_sha256 !== undefined || record.submission_observed_at !== undefined)) ||
        (record.uncertain_from === 'submitted' && (record.submitted_at === undefined || record.submission_event_sha256 === undefined)))) ||
      (record.state === 'submitted' && (record.submitted_at === undefined || record.submission_event_sha256 === undefined ||
        record.submission_observed_at === undefined || record.completion_event_sha256 !== undefined)) ||
      (record.state === 'completed' && (record.submitted_at === undefined || record.completed_at === undefined ||
        record.output_sha256 === undefined || record.outcome === undefined || record.submission_event_sha256 === undefined ||
        record.submission_observed_at === undefined || record.completion_event_sha256 === undefined ||
        record.completion_observed_at === undefined ||
        record.completion_submission_event_sha256 !== record.submission_event_sha256 ||
        record.completion_event_sha256 === record.submission_event_sha256)) ||
      (record.state !== 'completed' && (record.completed_at !== undefined || record.output_sha256 !== undefined ||
        record.outcome !== undefined || record.completion_event_sha256 !== undefined || record.completion_submission_event_sha256 !== undefined)) ||
      (record.state !== 'uncertain' && record.uncertain_from !== undefined) ||
      (record.state === 'failed-pre-submit' && (record.failure_code === undefined || record.submitted_at !== undefined ||
        record.submission_event_sha256 !== undefined))) {
    throw new SafeError(`ChatGPT run ${runId} does not exist or is corrupt.`);
  }
  return record;
}

async function readRun(store: StateStore | undefined, runId: string) {
  assertRunId(runId);
  return validateRun(await store?.read<unknown>(recordPath(runId), KIND), runId);
}

async function writeRun(store: StateStore, record: ChatGptRunRecord) {
  validateRun(record, record.run_id);
  await store.write(recordPath(record.run_id), KIND, record);
}

async function runRecordAbsent(store: StateStore, runId: string) {
  assertRunId(runId);
  try { await lstat(`${store.dir}/${recordPath(runId)}`); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

type RequestClaim = {
  run_id: string;
  request_key: string;
  created_at: string;
  // Absent only in legacy claims; an orphan without ownership proof is not reclaimable.
  initializer?: LockRecord;
};
const requestLockKey = (requestKey: string) => `chatgpt-request-${requestKey}`;
const initializePurpose = (key: string) => `initialize ChatGPT request ${key}`;
const releasePurpose = (key: string) => `release ChatGPT request ${key}`;
const recoverPurpose = (key: string) => `recover ChatGPT request ${key}`;
const isTerminal = (record: ChatGptRunRecord) => record.state === 'completed' || record.state === 'failed-pre-submit';

function validateRequestClaim(raw: unknown, requestKey: string): RequestClaim {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SafeError('Corrupt ChatGPT request claim.');
  const claim = raw as RequestClaim;
  if (Object.keys(claim).some(key => !['run_id', 'request_key', 'created_at', 'initializer'].includes(key)) ||
      !UUID.test(claim.run_id) || claim.request_key !== requestKey ||
      typeof claim.created_at !== 'string' || !Number.isFinite(Date.parse(claim.created_at))) {
    throw new SafeError('Corrupt ChatGPT request claim.');
  }
  if (claim.initializer !== undefined) {
    const owner = validateLockRecord(claim.initializer, requestLockKey(requestKey));
    if (Object.keys(owner).some(key => !['pid', 'hostname', 'token', 'purpose', 'acquired_at'].includes(key)) ||
        owner.purpose !== initializePurpose(requestKey)) throw new SafeError('Corrupt ChatGPT request initializer.');
  }
  return claim;
}

async function acquireRecoveryLock(store: StateStore, key: string, purpose: string, allowed: Set<string>) {
  const raw = await store.read<unknown>(`locks/${key}.json`, 'lock');
  if (raw === undefined) return acquireLock(store, key, purpose);
  const existing = validateLockRecord(raw, key);
  if (!allowed.has(existing.purpose)) throw new SafeError(`Lock ${key} has unexpected purpose ${existing.purpose}; refusing recovery.`);
  return acquireLock(store, key, purpose, {
    recoverStale: true, expectedExistingPurpose: existing.purpose, expectedExistingToken: existing.token
  });
}

/** Explicit recovery never creates a run or authorizes a browser submission. */
export async function recoverChatGptRequestClaim(requestKey: string, stateDir = defaultStateDir()) {
  if (!HEX.test(requestKey)) throw new SafeError('Invalid ChatGPT request key.');
  const store = await StateStore.open(stateDir);
  const lock = await acquireRecoveryLock(store, requestLockKey(requestKey), recoverPurpose(requestKey),
    new Set([initializePurpose(requestKey), releasePurpose(requestKey), recoverPurpose(requestKey)]));
  try {
    const raw = await store.read<unknown>(requestPath(requestKey), REQUEST_KIND);
    if (raw === undefined) return { recovered: false as const, request_key: requestKey };
    const claim = validateRequestClaim(raw, requestKey);
    const runRaw = await store.read<unknown>(recordPath(claim.run_id), KIND);
    if (runRaw !== undefined) {
      const run = validateRun(runRaw, claim.run_id);
      if (run.request_key !== requestKey) throw new SafeError('ChatGPT request claim does not match its run.');
      if (!isTerminal(run)) throw new SafeError(`An unresolved ChatGPT run exists (${run.run_id}); recover that run, not its claim.`);
    } else {
      // Confirm the pathname is still absent before treating this as an orphan.
      if (!(await runRecordAbsent(store, claim.run_id))) throw new SafeError('Corrupt ChatGPT run record; refusing claim recovery.');
      if (!claim.initializer) throw new SafeError('Orphan ChatGPT request has no initializer proof; manual inspection is required.');
      if (claim.initializer.hostname !== os.hostname()) throw new SafeError('ChatGPT request initializer is on a foreign host; refusing recovery.');
      if (lockOwnerAlive(claim.initializer.pid)) throw new SafeError('ChatGPT request has a live initializer; refusing recovery.');
    }
    // Prepare, terminal cleanup, and recovery all hold the same request lock.
    await store.remove(requestPath(requestKey));
    return { recovered: true as const, request_key: requestKey, run_id: claim.run_id };
  } finally { await lock.release(); }
}

async function assertCandidateCurrent(record: ChatGptRunRecord, stateDir: string) {
  const catalog = await readMultiRepoCatalog(stateDir);
  const repository = catalog.repositories[record.repository_id];
  const task = catalog.tasks[record.task_id];
  if (!repository || !task || task.repository_id !== record.repository_id || !repository.enabled || task.completed) {
    throw new SafeError('ChatGPT run repository/task authorization is no longer current.');
  }
  const live = await taskStatus(stateDir, record.task_id, { readOnly: true });
  const identity = await resolveIdentity(repository.root);
  const base = await resolveGitCommit(repository.root, record.requested_base_ref);
  if (repository.registration_epoch !== record.registration_epoch || task.binding_epoch !== record.binding_epoch ||
      task.phase_epoch !== record.phase_epoch || repository.policy_digest !== record.policy_digest ||
      live.binding_epoch !== record.binding_epoch || live.phase_epoch !== record.phase_epoch || live.completion ||
      live.root !== identity.root || live.git_dir !== identity.git_dir || live.common_dir !== identity.common_dir ||
      live.policy_digest !== record.policy_digest || live.head !== identity.head || live.branch !== identity.branch ||
      identity.head !== record.head || identity.branch !== record.branch || sha256(identity.root) !== record.root_sha256 ||
      base.commit !== record.resolved_base_commit) {
    throw new SafeError('ChatGPT run candidate changed; prepare a new run before submission.');
  }
  if (record.work_kind === 'review' && live.phase !== 'review') throw new SafeError('ChatGPT review requires the task review phase.');
  if (record.work_kind === 'code' && live.phase !== 'coding') throw new SafeError('ChatGPT coding requires the task coding phase.');
}

export async function prepareChatGptRun(options: {
  stateDir?: string; repositoryId: string; taskId: string; coordinator: ChatGptCoordinator;
  workKind: ChatGptWorkKind; profile?: ModelProfile; surface: ChatSurface;
  conversationId?: string; sessionId?: string; prompt: string; baseRef?: string;
  runId?: string; selectionId?: string; now?: Date;
}) {
  const stateDir = options.stateDir ?? defaultStateDir();
  assertId(options.repositoryId, 'repository ID');
  assertId(options.taskId, 'task ID');
  if (options.coordinator !== 'codex' && options.coordinator !== 'claude') throw new SafeError('Coordinator must be codex or claude.');
  if (!['review', 'architecture', 'code'].includes(options.workKind)) throw new SafeError('Invalid ChatGPT work kind.');
  if (options.coordinator === 'claude' && options.workKind === 'code') {
    throw new SafeError('Claude coordinates Repo MCP review and architecture only; coding is a Codex-coordinated workflow.');
  }
  assertPrompt(options.prompt);
  const catalog = await readMultiRepoCatalog(stateDir);
  const repository = catalog.repositories[options.repositoryId];
  const task = catalog.tasks[options.taskId];
  if (!repository || !repository.enabled) throw new SafeError(`Repository ${options.repositoryId} is not registered and enabled.`);
  if (!task || task.repository_id !== options.repositoryId || task.completed) {
    throw new SafeError(`Task ${options.taskId} is not an unfinished task for repository ${options.repositoryId}.`);
  }
  const live = await taskStatus(stateDir, options.taskId, { readOnly: true });
  const identity = await resolveIdentity(repository.root);
  if (identity.root !== live.root || identity.git_dir !== live.git_dir || identity.common_dir !== live.common_dir ||
      identity.branch !== live.branch || identity.head !== live.head || live.policy_digest !== repository.policy_digest ||
      live.binding_epoch !== task.binding_epoch || live.phase_epoch !== task.phase_epoch || live.phase !== task.phase || live.completion) {
    throw new SafeError('Repository task binding is stale; reconcile it before preparing a ChatGPT run.');
  }
  if (options.workKind === 'review' && live.phase !== 'review') throw new SafeError('ChatGPT review requires the task review phase.');
  if (options.workKind === 'code' && live.phase !== 'coding') throw new SafeError('ChatGPT coding requires the task coding phase.');
  const base = await resolveGitCommit(identity.root, options.baseRef);
  const profile = profileFor(options.workKind, options.profile);
  const runId = options.runId ?? randomUUID();
  assertRunId(runId);
  const store = await StateStore.open(stateDir, { forbiddenRoots: [identity.root, identity.common_dir] });
  if (await store.read<unknown>(recordPath(runId), KIND)) throw new SafeError(`ChatGPT run ${runId} already exists.`);
  const at = nowIso(options.now);
  const browserContext = trustedBrowserContextBinding({ conversationId: options.conversationId, sessionId: options.sessionId });
  const requestKey = sha256(JSON.stringify([
    options.repositoryId, options.taskId, repository.registration_epoch, task.binding_epoch, task.phase_epoch,
    repository.policy_digest, identity.head, base.commit, sha256(options.prompt), browserContext,
    options.coordinator, options.workKind, profile
  ]));
  return withShortLock(store, requestLockKey(requestKey), async () => {
    const requestClaim: RequestClaim = {
      run_id: runId, request_key: requestKey, created_at: at,
      initializer: { pid: process.pid, hostname: os.hostname(), token: randomUUID(),
        purpose: initializePurpose(requestKey), acquired_at: at }
    };
    if (!(await store.create(requestPath(requestKey), REQUEST_KIND, requestClaim))) {
      const existing = validateRequestClaim(await store.read(requestPath(requestKey), REQUEST_KIND), requestKey);
      throw new SafeError(`An unresolved ChatGPT run already exists for this exact request (${existing.run_id}; request key ${requestKey}). Recover or finish that run, or explicitly recover its claim; do not submit a replacement.`);
    }
    try {
      const selection = await resolveModelProfile(profile, options.surface, {
        now: options.now, selectionId: options.selectionId,
        conversationId: options.conversationId, sessionId: options.sessionId,
        stateDir: `${stateDir}/model-policy`
      });
      const record: ChatGptRunRecord = {
        schema_version: CHATGPT_RUN_SCHEMA_VERSION, run_id: runId, coordinator: options.coordinator,
        execution_surface: 'ChatGPT web', work_kind: options.workKind, profile, state: 'prepared',
        repository_id: options.repositoryId, task_id: options.taskId,
        registration_epoch: repository.registration_epoch, binding_epoch: task.binding_epoch,
        phase_epoch: task.phase_epoch, policy_digest: repository.policy_digest,
        root_sha256: sha256(identity.root), branch: identity.branch, head: identity.head,
        requested_base_ref: base.requested, resolved_base_commit: base.commit,
        prompt_sha256: sha256(options.prompt), request_key: requestKey, selection, created_at: at, updated_at: at
      };
      validateRun(record, runId);
      if (!(await store.create(recordPath(runId), KIND, record))) throw new SafeError(`ChatGPT run ${runId} already exists.`);
      return record;
    } catch (error) {
      // A failed durable publication may already have created the run. Keep its claim.
      if (await runRecordAbsent(store, runId)) await store.remove(requestPath(requestKey));
      throw error;
    }
  }, { purpose: initializePurpose(requestKey) });
}

export async function chatGptRunStatus(runId: string, stateDir = defaultStateDir()) {
  return readRun(await StateStore.inspect(stateDir), runId);
}

export async function reserveChatGptRun(options: {
  stateDir?: string; runId: string; contract: unknown; evidence: SanitizedModelSelectionEvidence; now?: Date;
}) {
  const stateDir = options.stateDir ?? defaultStateDir();
  assertRunId(options.runId);
  const store = await StateStore.open(stateDir);
  return withShortLock(store, lockKey(options.runId), async () => {
    let record = await readRun(store, options.runId);
    if (record.state === 'submission-reserved') {
      await assertCandidateCurrent(record, stateDir);
      return { ...record, submission_authorized: false as const, recovery_required: true as const };
    }
    if (record.state !== 'prepared') throw new SafeError(`ChatGPT run cannot be reserved from state ${record.state}.`);
    await assertCandidateCurrent(record, stateDir);
    record = { ...record, state: 'verification-pending', updated_at: nowIso(options.now) };
    await writeRun(store, record);
    let verified: Awaited<ReturnType<typeof verifyModelSelection>>;
    try {
      verified = await verifyModelSelection(options.contract, options.evidence, {
        now: options.now, stateDir: `${stateDir}/model-policy`
      });
      if (verified.selection.selection_id !== record.selection.selection_id || verified.selection.profile !== record.profile ||
          JSON.stringify(verified.selection.browser_context) !== JSON.stringify(record.selection.browser_context)) {
        throw new SafeError('Verified model selection does not belong to this ChatGPT run.');
      }
    } catch (error) {
      record = { ...record, state: 'failed-pre-submit', failure_code: 'MODEL_SELECTION_NOT_VERIFIED', updated_at: nowIso(options.now) };
      await writeRun(store, record);
      await releaseRequestClaim(store, record);
      throw error;
    }
    record = { ...record, state: 'submission-reserved', model_verified_at: verified.verified_at, updated_at: nowIso(options.now) };
    await writeRun(store, record);
    return { ...record, submission_authorized: true as const, recovery_required: false as const };
  }, { purpose: `reserve ChatGPT run ${options.runId}` });
}

async function releaseRequestClaim(store: StateStore, record: ChatGptRunRecord) {
  validateRun(record, record.run_id);
  if (!isTerminal(record)) throw new SafeError('Only a validated terminal ChatGPT run may release its claim.');
  await withShortLock(store, requestLockKey(record.request_key), async () => {
    const raw = await store.read<unknown>(requestPath(record.request_key), REQUEST_KIND);
    if (raw === undefined) return;
    const current = validateRequestClaim(raw, record.request_key);
    if (current.run_id === record.run_id) await store.remove(requestPath(record.request_key));
  }, { purpose: releasePurpose(record.request_key) });
}

async function transitionRun(stateDir: string, runId: string, from: ChatGptRunState[], update: (record: ChatGptRunRecord) => ChatGptRunRecord | Promise<ChatGptRunRecord>) {
  assertRunId(runId);
  const store = await StateStore.open(stateDir);
  return withShortLock(store, lockKey(runId), async () => {
    const record = await readRun(store, runId);
    if (!from.includes(record.state)) throw new SafeError(`ChatGPT run cannot transition from state ${record.state}.`);
    const next = await update(record);
    validateRun(next, runId);
    await writeRun(store, next);
    if (next.state === 'completed' || next.state === 'failed-pre-submit') await releaseRequestClaim(store, next);
    return next;
  }, { purpose: `transition ChatGPT run ${runId}` });
}

export async function markChatGptRunSubmitted(options: {
  runId: string; receipt: TrustedChatGptRunReceipt; stateDir?: string; now?: Date;
}) {
  const stateDir = options.stateDir ?? defaultStateDir();
  return transitionRun(stateDir, options.runId, ['submission-reserved', 'submitted'], async record => {
    if (record.state === 'submitted') {
      const trusted = validateTrustedReceipt(record, options.receipt, options.now, record.model_verified_at);
      if (record.submission_event_sha256 !== trusted.event) throw new SafeError('Submitted ChatGPT run is bound to a different browser event.');
      return record;
    }
    await assertCandidateCurrent(record, stateDir);
    const trusted = validateTrustedReceipt(record, options.receipt, options.now, record.model_verified_at);
    const at = nowIso(options.now);
    return { ...record, state: 'submitted', submitted_at: at, submission_event_sha256: trusted.event,
      submission_observed_at: trusted.observedAt, updated_at: at };
  });
}

export async function completeChatGptRun(options: {
  stateDir?: string; runId: string; output: string; outcome: 'ship' | 'no-ship' | 'completed';
  receipt: TrustedChatGptCompletionReceipt; now?: Date;
}) {
  if (!options.output.trim()) throw new SafeError('ChatGPT completion output must not be empty.');
  if (Buffer.byteLength(options.output, 'utf8') > CHATGPT_RUN_MAX_OUTPUT_BYTES) throw new SafeError('ChatGPT completion output exceeds 1 MiB.');
  const stateDir = options.stateDir ?? defaultStateDir();
  const digest = sha256(options.output);
  return transitionRun(stateDir, options.runId, ['submitted', 'completed'], async record => {
    const trusted = validateTrustedReceipt(record, options.receipt, options.now, record.submitted_at);
    if (options.receipt.kind !== 'completion' || options.receipt.responseState !== 'completed') {
      throw new SafeError('Completion requires a completion-specific receipt for a completed response.');
    }
    if (options.receipt.submissionEventSha256 !== record.submission_event_sha256) {
      throw new SafeError('Completion receipt does not match the submitted browser event.');
    }
    if (options.receipt.outputSha256 !== digest) throw new SafeError('Completion receipt output digest does not match the observed output.');
    if (trusted.event === record.submission_event_sha256) throw new SafeError('Completion cannot reuse the submission event.');
    if (record.state === 'completed') {
      if (record.output_sha256 === digest && record.outcome === options.outcome && record.completion_event_sha256 === trusted.event) return record;
      throw new SafeError('ChatGPT run already completed with a different output or outcome.');
    }
    await assertCandidateCurrent(record, stateDir);
    const at = nowIso(options.now);
    return { ...record, state: 'completed', output_sha256: digest, outcome: options.outcome,
      completion_event_sha256: trusted.event, completion_submission_event_sha256: options.receipt.submissionEventSha256,
      completion_observed_at: trusted.observedAt, completed_at: at, updated_at: at };
  });
}

export async function markChatGptRunUncertain(runId: string, failureCode: string, stateDir = defaultStateDir(), now?: Date) {
  return transitionRun(stateDir, runId, ['submission-reserved', 'submitted'], record => ({
    ...record, state: 'uncertain', uncertain_from: record.state as 'submission-reserved' | 'submitted',
    failure_code: sanitizeFailure(failureCode), updated_at: nowIso(now)
  }));
}

/** Resolve browser uncertainty only after reattaching to and inspecting the same conversation. */
export async function recoverChatGptRun(
  runId: string,
  resolution: 'submitted' | 'not-submitted',
  receipt: TrustedChatGptRunReceipt,
  stateDir = defaultStateDir(),
  now?: Date
) {
  return transitionRun(stateDir, runId, ['uncertain'], async record => {
    const trusted = validateTrustedReceipt(record, receipt, now, record.updated_at);
    if (resolution === 'not-submitted') {
      if (record.uncertain_from !== 'submission-reserved') {
        throw new SafeError('A run previously known as submitted cannot be resolved as not submitted.');
      }
      return { ...record, state: 'failed-pre-submit', failure_code: 'CONFIRMED_NOT_SUBMITTED', uncertain_from: undefined,
        recovery_event_sha256: trusted.event, recovery_observed_at: trusted.observedAt, updated_at: nowIso(now) };
    }
    await assertCandidateCurrent(record, stateDir);
    const at = nowIso(now);
    return { ...record, state: 'submitted', submitted_at: record.submitted_at ?? at, failure_code: undefined,
      uncertain_from: undefined,
      submission_event_sha256: record.submission_event_sha256 ?? trusted.event,
      submission_observed_at: record.submission_observed_at ?? trusted.observedAt,
      recovery_event_sha256: trusted.event, recovery_observed_at: trusted.observedAt, updated_at: at };
  });
}

export async function failChatGptRunBeforeSubmit(runId: string, failureCode: string, stateDir = defaultStateDir(), now?: Date) {
  const code = sanitizeFailure(failureCode);
  return transitionRun(stateDir, runId, ['prepared', 'verification-pending', 'failed-pre-submit'], record => {
    if (record.state === 'failed-pre-submit') {
      if (record.failure_code !== code) throw new SafeError('ChatGPT run already failed with a different failure code.');
      return record;
    }
    return { ...record, state: 'failed-pre-submit', failure_code: code, updated_at: nowIso(now) };
  });
}

export async function recoverChatGptRunLock(runId: string, stateDir = defaultStateDir()) {
  assertRunId(runId);
  const store = await StateStore.open(stateDir);
  const key = lockKey(runId);
  const raw = await store.read<unknown>(`locks/${key}.json`, 'lock');
  if (raw === undefined) return { recovered: false as const, run_id: runId };
  const existing = validateLockRecord(raw, key);
  const allowed = new Set([`reserve ChatGPT run ${runId}`, `transition ChatGPT run ${runId}`, `recover ChatGPT run ${runId}`]);
  if (!allowed.has(existing.purpose)) throw new SafeError(`Lock ${key} has unexpected purpose ${existing.purpose}; refusing recovery.`);
  const lock = await acquireLock(store, key, `recover ChatGPT run ${runId}`, {
    recoverStale: true,
    expectedExistingPurpose: existing.purpose,
    expectedExistingToken: existing.token
  });
  await lock.release();
  return { recovered: true as const, run_id: runId, prior_pid: existing.pid, prior_purpose: existing.purpose };
}
