import { randomUUID } from 'node:crypto';
import { SafeError, sha256 } from './errors.js';
import { resolveCommitReviewBinding, resolveGitCommit, type CommitReviewBinding } from './git-ref.js';
import { recoverTaskCoordinatorStaleLock, taskStatus } from './task.js';
import {
  closeReviewWorkspaceUnderGate,
  readMultiRepoCatalog,
  readWorkspaceOpenOutcome,
  WORKSPACE_TTL_MS
} from './multirepo-state.js';
import {
  chatGptRunStatus,
  prepareChatGptRun,
  recoverChatGptOrphanRequestForRun,
  type ChatGptCoordinator,
  type ChatGptRunRecord
} from './chatgpt-run.js';
import { trustedBrowserContextBinding, type ModelProfile } from './model-policy.js';
import {
  REVIEW_SHARE_SCHEMA_VERSION,
  ReviewShareError,
  assertAndSyncSharedRunUnderGate,
  codingOwnerSummary,
  computeCommitReviewTarget,
  computeCurrentReviewTarget,
  currentParticipants,
  findParticipant,
  participantProtected,
  protectedParticipants,
  publicReviewTaskSummary,
  readReviewShareJournal,
  recoverTaskShareStaleLock,
  sanitizedReviewStatus,
  sharedRunEvidenceExists,
  withRepositoryReviewSelectionGate,
  withTaskShareGate,
  writeReviewShareJournalUnderGate,
  type ReviewParticipant,
  type ReviewShareJournal
} from './review-state.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL = /[\u0000-\u001f\u007f]/u;

type PrepareReviewOptions = {
  stateDir: string;
  repositoryId: string;
  taskId?: string;
  coordinator: ChatGptCoordinator;
  profile: 'review' | 'review-critical';
  surface: 'chat';
  sessionId: string;
  workspaceRequestId: string;
  prompt: string;
  baseRef?: string;
  headRef?: string;
  scopePrefix?: string;
  ttlSeconds?: number;
  now?: Date;
};

function fail(code: string, message: string): never { throw new ReviewShareError(code, message); }
function nowIso(now?: Date) {
  const date = now ?? new Date();
  if (!Number.isFinite(date.getTime())) throw new SafeError('Invalid review preparation time.');
  return date.toISOString();
}
function assertPrepareOptions(options: PrepareReviewOptions) {
  if (!ID.test(options.repositoryId)) throw new SafeError('Invalid repository ID.');
  if (options.taskId !== undefined && !ID.test(options.taskId)) throw new SafeError('Invalid task ID.');
  if (options.coordinator !== 'codex' && options.coordinator !== 'claude') throw new SafeError('Coordinator must be codex or claude.');
  if (options.profile !== 'review' && options.profile !== 'review-critical') throw new SafeError('Shared review profile must be review or review-critical.');
  if (options.surface !== 'chat') throw new SafeError('Shared review requires Chat surface.');
  if (!options.sessionId || options.sessionId.length > 512 || CONTROL.test(options.sessionId)) throw new SafeError('Shared review requires a bounded control-free session ID.');
  if (!REQUEST_ID.test(options.workspaceRequestId)) throw new SafeError('Invalid workspace request ID.');
  if (!options.prompt.trim() || Buffer.byteLength(options.prompt, 'utf8') > 256 * 1024) throw new SafeError('Shared review prompt must be nonempty and at most 256 KiB.');
  if ((options.scopePrefix ?? '').length > 256 || CONTROL.test(options.scopePrefix ?? '')) throw new SafeError('Review scope prefix is invalid.');
  if (options.headRef !== undefined && options.baseRef === undefined) {
    throw new SafeError('Commit-pinned shared review requires explicit base_ref with head_ref.');
  }
  const ttl = options.ttlSeconds ?? 60;
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 3600) throw new SafeError('Review TTL must be between 60 and 3600 seconds.');
}

async function resolveTask(options: PrepareReviewOptions) {
  if (options.taskId) return options.taskId;
  return withRepositoryReviewSelectionGate(options.stateDir, options.repositoryId, async () => {
    const catalog = await readMultiRepoCatalog(options.stateDir);
    const repository = catalog.repositories[options.repositoryId];
    if (!repository || !repository.enabled) fail('REVIEW_REPOSITORY_UNAVAILABLE', 'Repository is not enabled.');
    const active = Object.values(catalog.tasks).filter(task =>
      task.repository_id === options.repositoryId && !task.completed
    );
    if (active.length === 0) fail('REVIEW_TASK_REQUIRED', 'No unfinished task exists for this repository; owner preparation is required.');
    if (active.length !== 1) fail('REVIEW_TASK_AMBIGUOUS', 'Multiple unfinished tasks exist; specify --task explicitly.');
    return active[0].task_id;
  });
}

function generationView(journal: ReviewShareJournal) {
  return {
    schema_version: journal.schema_version,
    repository_id: journal.repository_id,
    task_id: journal.task_id,
    generation: journal.generation,
    registration_epoch: journal.registration_epoch,
    binding_epoch: journal.binding_epoch,
    phase_epoch: journal.phase_epoch,
    policy_digest: journal.policy_digest,
    branch: journal.branch,
    head: journal.head,
    target_fingerprint: journal.target_fingerprint,
    target_assurance: journal.target_assurance
  };
}

function participantView(participant: ReviewParticipant, taskId: string) {
  return { ...participant, task_id: taskId };
}

type ObservedReviewTarget =
  | Awaited<ReturnType<typeof computeCurrentReviewTarget>>
  | Awaited<ReturnType<typeof computeCommitReviewTarget>>;

function currentAuthorizationMatches(
  journal: ReviewShareJournal,
  current: ObservedReviewTarget
) {
  return journal.registration_epoch === current.repository.registration_epoch &&
    journal.binding_epoch === current.task.binding_epoch &&
    journal.phase_epoch === current.task.phase_epoch &&
    journal.policy_digest === current.repository.policy_digest;
}

async function currentJournalForPrepare(
  options: PrepareReviewOptions,
  taskId: string,
  current: ObservedReviewTarget,
  at: string
) {
  let journal = await readReviewShareJournal(options.stateDir, taskId);
  if (!journal) {
    if (await sharedRunEvidenceExists(options.stateDir, taskId)) {
      fail('REVIEW_SHARE_STATE_MISSING', 'Shared run evidence exists but the review share journal is missing.');
    }
    return {
      schema_version: REVIEW_SHARE_SCHEMA_VERSION,
      repository_id: options.repositoryId,
      task_id: taskId,
      generation: 1,
      registration_epoch: current.repository.registration_epoch,
      binding_epoch: current.task.binding_epoch,
      phase_epoch: current.task.phase_epoch,
      policy_digest: current.repository.policy_digest,
      branch: current.target.branch,
      head: current.target.head,
      target_fingerprint: current.target.fingerprint,
      target_assurance: current.target.assurance,
      coding_owner: await codingOwnerSummary(options.stateDir, current.repository, current.task),
      participants: [],
      created_at: at,
      updated_at: at
    } satisfies ReviewShareJournal;
  }
  if (journal.repository_id !== options.repositoryId || journal.task_id !== taskId) {
    fail('REVIEW_SHARE_STATE_CORRUPT', 'Review share journal repository/task binding is corrupt.');
  }

  const protectedNow = protectedParticipants(journal).length > 0;
  const currentGenerationParticipants = currentParticipants(journal);
  const journalTargetFingerprint = journal.target_fingerprint;
  const participantFingerprintMismatch = currentGenerationParticipants.some(
    participant => participant.target_fingerprint !== journalTargetFingerprint
  );
  if (!currentAuthorizationMatches(journal, current) || participantFingerprintMismatch) {
    if (protectedNow) fail('REVIEW_SHARE_STATE_STALE', 'Review share authorization metadata no longer matches the current task.');
    journal = {
      ...journal,
      generation: journal.generation + 1,
      registration_epoch: current.repository.registration_epoch,
      binding_epoch: current.task.binding_epoch,
      phase_epoch: current.task.phase_epoch,
      policy_digest: current.repository.policy_digest,
      branch: current.target.branch,
      head: current.target.head,
      target_fingerprint: current.target.fingerprint,
      target_assurance: current.target.assurance,
      coding_owner: await codingOwnerSummary(options.stateDir, current.repository, current.task),
      updated_at: at
    };
    await writeReviewShareJournalUnderGate(options.stateDir, journal);
    return journal;
  }

  const targetChanged =
    journal.branch !== current.target.branch ||
    journal.head !== current.target.head ||
    journal.target_fingerprint !== current.target.fingerprint ||
    journal.target_assurance !== current.target.assurance;
  if (targetChanged) {
    if (protectedNow) {
      if (journal.target_fingerprint !== current.target.fingerprint) {
        fail('TARGET_CHANGED', 'The live review target changed while reviewers are protected.');
      }
      fail('REVIEW_SHARE_STATE_STALE', 'Stored review target identity is stale or corrupt.');
    }
    journal = {
      ...journal,
      generation: journal.generation + 1,
      branch: current.target.branch,
      head: current.target.head,
      target_fingerprint: current.target.fingerprint,
      target_assurance: current.target.assurance,
      coding_owner: await codingOwnerSummary(options.stateDir, current.repository, current.task),
      updated_at: at
    };
    await writeReviewShareJournalUnderGate(options.stateDir, journal);
  }
  return journal;
}

async function validateReviewTask(options: PrepareReviewOptions, taskId: string) {
  const catalog = await readMultiRepoCatalog(options.stateDir);
  const repository = catalog.repositories[options.repositoryId];
  const task = catalog.tasks[taskId];
  if (!repository || !repository.enabled || !task || task.repository_id !== options.repositoryId || task.completed) {
    fail('REVIEW_TASK_REQUIRED', 'Selected task is not an unfinished task for this repository.');
  }
  const live = await taskStatus(options.stateDir, taskId, { readOnly: true });
  if (live.binding_epoch !== task.binding_epoch || live.phase_epoch !== task.phase_epoch ||
      live.policy_digest !== repository.policy_digest || live.completion) {
    fail('REVIEW_SHARE_STATE_STALE', 'Task live authority does not match the registered review task.');
  }
  if (live.phase !== 'review' || task.phase !== 'review') fail('OWNER_ACTION_REQUIRED', 'Owner must place the task in review phase before shared review preparation.');
  return { repository, task, live };
}

async function prepareExistingInitializing(
  options: PrepareReviewOptions,
  journal: ReviewShareJournal,
  participant: ReviewParticipant,
  taskId: string
) {
  try {
    const run = await chatGptRunStatus(participant.run_id, options.stateDir);
    await assertAndSyncSharedRunUnderGate(options.stateDir, run, { allowInvalidated: true });
    const synced = await readReviewShareJournal(options.stateDir, taskId, { required: true });
    return {
      generation: generationView(synced!),
      participant: participantView(findParticipant(synced!, participant.participant_id), taskId),
      run,
      already_applied: true as const
    };
  } catch (error) {
    if (participant.state !== 'initializing') throw error;
  }
  const run = await prepareChatGptRun({
    stateDir: options.stateDir,
    repositoryId: options.repositoryId,
    taskId,
    coordinator: options.coordinator,
    workKind: 'review',
    profile: options.profile as ModelProfile,
    surface: 'chat',
    sessionId: options.sessionId,
    prompt: options.prompt,
    baseRef: participant.commit_binding?.requested_base_ref ?? options.baseRef,
    headRef: participant.commit_binding?.requested_head_ref,
    scopePrefix: participant.commit_binding?.scope_prefix ?? options.scopePrefix,
    runId: participant.run_id,
    selectionId: participant.selection_id,
    now: options.now,
    sharedReview: {
      generation: journal.generation,
      participantId: participant.participant_id,
      workspaceRequestId: participant.workspace_request_id
    }
  });
  const updatedAt = nowIso(options.now);
  const participants = journal.participants.map(item =>
    item.participant_id === participant.participant_id ? { ...item, state: 'prepared' as const, updated_at: updatedAt } : item
  );
  const next = await writeReviewShareJournalUnderGate(options.stateDir, { ...journal, participants, updated_at: updatedAt });
  return {
    generation: generationView(next),
    participant: participantView(findParticipant(next, participant.participant_id), taskId),
    run,
    already_applied: true as const
  };
}

export async function prepareOrJoinReview(options: PrepareReviewOptions) {
  assertPrepareOptions(options);
  const taskId = await resolveTask(options);
  let commitBinding: CommitReviewBinding | undefined;
  let observed: ObservedReviewTarget;
  let base: { requested: string; commit: string };
  if (options.headRef !== undefined) {
    const catalog = await readMultiRepoCatalog(options.stateDir);
    const repository = catalog.repositories[options.repositoryId];
    if (!repository || !repository.enabled) fail('REVIEW_REPOSITORY_UNAVAILABLE', 'Repository is not enabled.');
    commitBinding = await resolveCommitReviewBinding({
      root: repository.root,
      policyDigest: repository.policy_digest,
      baseRef: options.baseRef!,
      headRef: options.headRef,
      scopePrefix: options.scopePrefix
    });
    observed = await computeCommitReviewTarget(
      options.stateDir, options.repositoryId, taskId, commitBinding.head_commit
    );
    base = { requested: commitBinding.requested_base_ref, commit: commitBinding.base_commit };
  } else {
    observed = await computeCurrentReviewTarget(options.stateDir, options.repositoryId, taskId);
    base = await resolveGitCommit(observed.repository.root, options.baseRef);
  }
  return withTaskShareGate(options.stateDir, taskId, async () => {
    const validated = await validateReviewTask(options, taskId);
    if (observed.task.binding_epoch !== validated.task.binding_epoch ||
        observed.task.phase_epoch !== validated.task.phase_epoch ||
        observed.repository.registration_epoch !== validated.repository.registration_epoch ||
        observed.repository.policy_digest !== validated.repository.policy_digest ||
        observed.repository.root !== validated.live.root ||
        observed.repository.git_dir !== validated.live.git_dir ||
        observed.repository.common_dir !== validated.live.common_dir) {
      fail('REVIEW_SHARE_STATE_STALE', 'Task authority changed during shared review preparation.');
    }
    const priorJournal = await readReviewShareJournal(options.stateDir, taskId);
    const liveTargetMoved = !commitBinding &&
      (observed.target.head !== validated.live.head || observed.target.branch !== validated.live.branch);
    if (liveTargetMoved && (!priorJournal || protectedParticipants(priorJournal).length === 0)) {
      fail('REVIEW_SHARE_STATE_STALE', 'Task binding is stale relative to the live checkout.');
    }

    const at = nowIso(options.now);
    let journal = await currentJournalForPrepare(options, taskId, observed, at);
    const browserContext = trustedBrowserContextBinding({ sessionId: options.sessionId });
    const promptDigest = sha256(options.prompt);
    const scopeDigest = sha256(commitBinding?.scope_prefix ?? options.scopePrefix ?? '');
    const browserDigest = sha256(JSON.stringify(browserContext));
    const exactKey = commitBinding
      ? sha256(JSON.stringify([
          'review-participant-commit-v1', journal.generation, options.coordinator, options.profile,
          promptDigest, commitBinding, browserDigest, options.workspaceRequestId
        ]))
      : sha256(JSON.stringify([
          'review-participant-v1', journal.generation, options.coordinator, options.profile,
          promptDigest, base.requested, base.commit, scopeDigest, browserDigest, options.workspaceRequestId
        ]));
    const exact = currentParticipants(journal).find(participant =>
      participant.exact_request_key === exactKey && participantProtected(participant)
    );
    if (exact) return prepareExistingInitializing(options, journal, exact, taskId);

    if (journal.participants.length >= 512) fail('REVIEW_SHARE_STATE_CORRUPT', 'Review participant retention limit reached.');
    const participantId = randomUUID();
    const runId = randomUUID();
    const selectionId = randomUUID();
    const participantTtlMs = Math.max(60_000, (options.ttlSeconds ?? 60) * 1000);
    const participant: ReviewParticipant = {
      generation: journal.generation,
      participant_id: participantId,
      coordinator: options.coordinator,
      profile: options.profile,
      run_id: runId,
      selection_id: selectionId,
      requested_base_ref: base.requested,
      resolved_base_commit: base.commit,
      ...(commitBinding ? { commit_binding: commitBinding } : {}),
      scope_digest: scopeDigest,
      prompt_digest: promptDigest,
      browser_context_digest: browserDigest,
      exact_request_key: exactKey,
      target_fingerprint: journal.target_fingerprint,
      workspace_request_id: options.workspaceRequestId,
      workspace_ttl_ms: WORKSPACE_TTL_MS,
      workspace_association: 'pending',
      state: 'initializing',
      created_at: at,
      updated_at: at,
      expires_at: new Date(Date.parse(at) + participantTtlMs).toISOString()
    };
    journal = await writeReviewShareJournalUnderGate(options.stateDir, {
      ...journal,
      participants: [...journal.participants, participant],
      updated_at: at
    });

    const run = await prepareChatGptRun({
      stateDir: options.stateDir,
      repositoryId: options.repositoryId,
      taskId,
      coordinator: options.coordinator,
      workKind: 'review',
      profile: options.profile,
      surface: 'chat',
      sessionId: options.sessionId,
      prompt: options.prompt,
      baseRef: commitBinding?.requested_base_ref ?? options.baseRef,
      headRef: commitBinding?.requested_head_ref,
      scopePrefix: commitBinding?.scope_prefix ?? options.scopePrefix,
      runId,
      selectionId,
      now: options.now,
      sharedReview: {
        generation: journal.generation,
        participantId,
        workspaceRequestId: options.workspaceRequestId
      }
    });
    const preparedAt = nowIso(options.now);
    const participants = journal.participants.map(item =>
      item.participant_id === participantId ? { ...item, state: 'prepared' as const, updated_at: preparedAt } : item
    );
    const next = await writeReviewShareJournalUnderGate(options.stateDir, { ...journal, participants, updated_at: preparedAt });
    return {
      generation: generationView(next),
      participant: participantView(findParticipant(next, participantId), taskId),
      run,
      already_applied: false as const
    };
  }, 'prepare shared review ' + taskId);
}

function strictOperationOptions(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new SafeError('Unknown argument for shared review operation.');
}

export async function reconcileReviewParticipant(options: {
  stateDir: string;
  taskId: string;
  participantId: string;
}) {
  strictOperationOptions(options as Record<string, unknown>, ['stateDir', 'taskId', 'participantId']);
  return withTaskShareGate(options.stateDir, options.taskId, async () => {
    const journal = await readReviewShareJournal(options.stateDir, options.taskId, { required: true });
    const participant = findParticipant(journal!, options.participantId);
    if (participant.workspace_association === 'bound') {
      return { generation: generationView(journal!), participant: participantView(participant, options.taskId), already_applied: true as const };
    }
    let outcome;
    try {
      outcome = await readWorkspaceOpenOutcome({
        stateDir: options.stateDir,
        requestId: participant.workspace_request_id,
        repositoryId: journal!.repository_id,
        taskId: journal!.task_id,
        mode: 'review',
        ttlMs: participant.workspace_ttl_ms,
        reviewBinding: participant.commit_binding
      });
    } catch {
      fail('WORKSPACE_RECONCILIATION_MISMATCH', 'Authoritative workspace_open evidence does not match this participant.');
    }
    if (!outcome) fail('WORKSPACE_RECONCILIATION_REQUIRED', 'Authoritative workspace_open outcome is not available yet.');
    if (outcome.selection.registration_epoch !== journal!.registration_epoch ||
        outcome.selection.binding_epoch !== journal!.binding_epoch ||
        outcome.selection.phase_epoch !== journal!.phase_epoch ||
        outcome.selection.policy_digest !== journal!.policy_digest ||
        outcome.selection.repository_id !== journal!.repository_id ||
        outcome.selection.task_id !== journal!.task_id || outcome.selection.mode !== 'review' ||
        JSON.stringify(outcome.selection.review_binding ?? null) !== JSON.stringify(participant.commit_binding ?? null)) {
      fail('WORKSPACE_RECONCILIATION_MISMATCH', 'Workspace selection authority does not match the shared review generation.');
    }
    const at = new Date().toISOString();
    const participants = journal!.participants.map(item =>
      item.participant_id === participant.participant_id
        ? { ...item, workspace_association: 'bound' as const, workspace_id: outcome.selection.workspace_id, updated_at: at }
        : item
    );
    const next = await writeReviewShareJournalUnderGate(options.stateDir, { ...journal!, participants, updated_at: at });
    return { generation: generationView(next), participant: participantView(findParticipant(next, participant.participant_id), options.taskId) };
  }, 'reconcile review participant ' + options.participantId);
}

export async function recoverReviewParticipant(options: {
  stateDir: string;
  taskId: string;
  participantId: string;
}) {
  strictOperationOptions(options as Record<string, unknown>, ['stateDir', 'taskId', 'participantId']);
  await recoverTaskShareStaleLock(options.stateDir, options.taskId);
  await recoverTaskCoordinatorStaleLock(options.stateDir, options.taskId);
  return withTaskShareGate(options.stateDir, options.taskId, async () => {
    let journal = await readReviewShareJournal(options.stateDir, options.taskId, { required: true });
    let participant = findParticipant(journal!, options.participantId);

    if (participant.state === 'initializing') {
      let run: ChatGptRunRecord | undefined;
      try { run = await chatGptRunStatus(participant.run_id, options.stateDir); }
      catch {
        await recoverChatGptOrphanRequestForRun(participant.run_id, options.stateDir);
        return {
          generation: generationView(journal!),
          participant: participantView(participant, options.taskId),
          recovery_required: true as const
        };
      }
      await assertAndSyncSharedRunUnderGate(options.stateDir, run, { allowInvalidated: true });
      journal = await readReviewShareJournal(options.stateDir, options.taskId, { required: true });
      participant = findParticipant(journal!, options.participantId);
    }

    if (participant.workspace_association !== 'pending') {
      return { generation: generationView(journal!), participant: participantView(participant, options.taskId), already_applied: true as const };
    }
    const run = await chatGptRunStatus(participant.run_id, options.stateDir);
    if (run.state !== 'failed-pre-submit') {
      fail('WORKSPACE_RECONCILIATION_REQUIRED', 'Only a terminal pre-submit participant can prove workspace absence.');
    }
    let outcome;
    try {
      outcome = await readWorkspaceOpenOutcome({
        stateDir: options.stateDir,
        requestId: participant.workspace_request_id,
        repositoryId: journal!.repository_id,
        taskId: journal!.task_id,
        mode: 'review',
        ttlMs: participant.workspace_ttl_ms,
        reviewBinding: participant.commit_binding
      });
    } catch {
      fail('WORKSPACE_RECONCILIATION_MISMATCH', 'Authoritative workspace evidence is corrupt or mismatched.');
    }
    if (outcome && (
      outcome.selection.registration_epoch !== journal!.registration_epoch ||
      outcome.selection.binding_epoch !== journal!.binding_epoch ||
      outcome.selection.phase_epoch !== journal!.phase_epoch ||
      outcome.selection.policy_digest !== journal!.policy_digest ||
      outcome.selection.repository_id !== journal!.repository_id ||
      outcome.selection.task_id !== journal!.task_id ||
      outcome.selection.mode !== 'review' ||
      JSON.stringify(outcome.selection.review_binding ?? null) !== JSON.stringify(participant.commit_binding ?? null)
    )) {
      fail('WORKSPACE_RECONCILIATION_MISMATCH', 'Recovered workspace selection does not match the shared review generation.');
    }
    const at = new Date().toISOString();
    const participants = journal!.participants.map(item => {
      if (item.participant_id !== participant.participant_id) return item;
      return outcome
        ? { ...item, workspace_association: 'bound' as const, workspace_id: outcome.selection.workspace_id, updated_at: at }
        : { ...item, workspace_association: 'proven-absent' as const, updated_at: at };
    });
    const next = await writeReviewShareJournalUnderGate(options.stateDir, { ...journal!, participants, updated_at: at });
    return { generation: generationView(next), participant: participantView(findParticipant(next, participant.participant_id), options.taskId) };
  }, 'recover review participant ' + options.participantId);
}

export async function closeReviewParticipant(options: {
  stateDir: string;
  taskId: string;
  participantId: string;
  requestId: string;
}) {
  strictOperationOptions(options as Record<string, unknown>, ['stateDir', 'taskId', 'participantId', 'requestId']);
  if (!REQUEST_ID.test(options.requestId)) throw new SafeError('Invalid close request ID.');
  return withTaskShareGate(options.stateDir, options.taskId, async () => {
    let journal = await readReviewShareJournal(options.stateDir, options.taskId, { required: true });
    let participant = findParticipant(journal!, options.participantId);
    if (participant.state === 'closed') return { generation: generationView(journal!), participant: participantView(participant, options.taskId), already_applied: true as const };
    if (participant.workspace_association === 'pending') {
      fail('WORKSPACE_RECONCILIATION_REQUIRED', 'Review close requires a bound workspace or proven pre-submit absence.');
    }
    const run = await chatGptRunStatus(participant.run_id, options.stateDir);
    if (run.state !== 'completed' && run.state !== 'failed-pre-submit') {
      fail('REVIEW_PROTECTED', 'Review participant cannot close while its run remains unresolved.');
    }
    if (participant.workspace_association === 'bound') {
      await closeReviewWorkspaceUnderGate({
        stateDir: options.stateDir,
        workspaceId: participant.workspace_id!,
        requestId: options.requestId
      });
    }
    const at = new Date().toISOString();
    const participants = journal!.participants.map(item =>
      item.participant_id === participant.participant_id ? { ...item, state: 'closed' as const, updated_at: at } : item
    );
    journal = await writeReviewShareJournalUnderGate(options.stateDir, { ...journal!, participants, updated_at: at });
    participant = findParticipant(journal, participant.participant_id);
    return { generation: generationView(journal), participant: participantView(participant, options.taskId), already_applied: false as const };
  }, 'close review participant ' + options.participantId);
}

export async function reviewShareStatus(options: { stateDir: string; taskId: string }) {
  strictOperationOptions(options as Record<string, unknown>, ['stateDir', 'taskId']);
  return withTaskShareGate(options.stateDir, options.taskId, async () => {
    const journal = await readReviewShareJournal(options.stateDir, options.taskId, { required: true });
    const catalog = await readMultiRepoCatalog(options.stateDir);
    const task = catalog.tasks[options.taskId];
    const repository = task ? catalog.repositories[task.repository_id] : undefined;
    if (!task || !repository) fail('REVIEW_SHARE_STATE_STALE', 'Review task authorization is no longer present.');
    return sanitizedReviewStatus(journal!, await publicReviewTaskSummary(options.stateDir, repository, task));
  }, 'review share status ' + options.taskId);
}
