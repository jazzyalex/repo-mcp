import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareFixture } from '../src/fixture.js';
import { defaultPolicy } from '../src/repo.js';
import { migrateV1 } from '../src/policy.js';
import { sha256 } from '../src/errors.js';
import {
  bindRegisteredTask,
  issueWorkspaceGrant,
  openWorkspace,
  readMultiRepoCatalog,
  rebindRegisteredTask,
  registerRepository,
  revokeWorkspace,
  setRegisteredTaskPhase,
  setRepositoryEnabled,
  withWorkspaceAdmission
} from '../src/multirepo-state.js';
import {
  bindTask,
  setTaskPhase,
  taskStatus
} from '../src/task.js';
import {
  chatGptRunStatus,
  completeChatGptRun,
  failChatGptRunBeforeSubmit,
  markChatGptRunSubmitted,
  markChatGptRunUncertain,
  prepareChatGptRun,
  recoverChatGptRun,
  reserveChatGptRun,
  type ChatGptRunRecord,
  type TrustedChatGptCompletionReceipt,
  type TrustedChatGptRunReceipt
} from '../src/chatgpt-run.js';
import { recordTrustedBrowserObservation } from '../src/model-policy.js';
import { garbageCollect } from '../src/gc.js';
import { StateStore, acquireLock } from '../src/task-state.js';
import { git } from './helpers.js';
import {
  closeReviewParticipant,
  prepareOrJoinReview,
  reconcileReviewParticipant,
  recoverReviewParticipant,
  reviewShareStatus
} from '../src/review-share.js';
import { withTaskShareGate } from '../src/review-state.js';

/**
 * Stage 2.2-2.6 minimal public contract for future src/review-share.ts.
 *
 * Owner-only state:
 *   review-shares/<task_id>.json, kind "review-share-v1", one strict/versioned current-generation journal.
 *   Historical invalidated participant/run/request evidence stays in its original journals and is never rewritten
 *   merely to make a newer authorization epoch usable.
 *
 * prepareOrJoinReview({
 *   stateDir, repositoryId, taskId?, coordinator, profile, surface: "chat",
 *   sessionId, workspaceRequestId, prompt, baseRef?, scopePrefix?, ttlSeconds?, now?
 * }) -> { generation, participant, run, already_applied? }
 *
 * workspaceRequestId is operator-preallocated by the source skill BEFORE the final browser prompt is hashed.
 * The final prompt may contain that request id, but no dynamic handoff text may be appended after prompt_sha256.
 * Exact retries with the same final prompt/browser/workspace request return the same participant/run.
 *
 * reconcileReviewParticipant({ stateDir, taskId, participantId }) derives workspace_id exclusively from the
 * existing authoritative workspace_open request ledger keyed by participant.workspace_request_id. It accepts no
 * workspace ID/token.
 *
 * closeReviewParticipant({ stateDir, taskId, participantId, requestId }) is normal cooperative close.
 * recoverReviewParticipant({ stateDir, taskId, participantId }) may prove workspace absence only for a terminal
 * pre-submit run when the authoritative workspace_open ledger has no outcome.
 * reviewShareStatus({ stateDir, taskId }) returns sanitized owner status/counts/provenance, never bearer secrets,
 * raw prompt/output/browser/session IDs, policy source paths or unrelated private paths.
 */

const NOW = new Date('2026-10-14T02:10:00.000Z');
const OBSERVED = new Date('2026-10-14T02:10:03.000Z');
const SUBMITTED = new Date('2026-10-14T02:10:04.000Z');
const SHARE_PATH = 'review-shares/task.json';
const SHARE_KIND = 'review-share-v1';

type Coordinator = 'codex' | 'claude';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

async function fixture(
  t: { after(fn: () => Promise<void>): void },
  options: { task?: boolean; phase?: 'coding' | 'review'; extraCommit?: boolean; trackedSymlink?: boolean } = {}
) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-review-share-')));
  const root = path.join(base, 'repo');
  const stateDir = path.join(base, 'state');
  const policyPath = path.join(base, 'policy.json');
  await prepareFixture(root);
  if (options.extraCommit) {
    await writeFile(path.join(root, 'src', 'share-target.txt'), 'target v1\n');
    await git(root, 'add', '--', 'src/share-target.txt');
    await git(root, 'commit', '-m', 'share target');
  }
  if (options.trackedSymlink) {
    await writeFile(path.join(root, 'src', 'symlink-target-a.txt'), 'A\n');
    await writeFile(path.join(root, 'src', 'symlink-target-b.txt'), 'B\n');
    await symlink('symlink-target-a.txt', path.join(root, 'src', 'tracked-link.txt'));
    await git(root, 'add', '--', 'src/symlink-target-a.txt', 'src/symlink-target-b.txt', 'src/tracked-link.txt');
    await git(root, 'commit', '-m', 'tracked review symlink');
  }
  const fixturePolicy = options.trackedSymlink ? {
    ...defaultPolicy,
    files: [
      ...defaultPolicy.files,
      'src/symlink-target-a.txt',
      'src/symlink-target-b.txt',
      'src/tracked-link.txt'
    ]
  } : defaultPolicy;
  await writeFile(policyPath, JSON.stringify(migrateV1(fixturePolicy)));
  await registerRepository({ stateDir, repositoryId: 'repo', root, policyPath });
  if (options.task !== false) {
    await bindRegisteredTask({ stateDir, repositoryId: 'repo', taskId: 'task' });
    if ((options.phase ?? 'review') === 'review') {
      await setRegisteredTaskPhase({ stateDir, taskId: 'task', phase: 'review' });
    }
  }
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, root, stateDir, policyPath };
}

function finalPrompt(workspaceRequestId: string, label: string) {
  return `Review ${label}. Workspace request id: ${workspaceRequestId}\n`;
}

function prepareOptions(
  stateDir: string,
  coordinator: Coordinator,
  label: string,
  extra: Partial<{
    taskId: string;
    profile: 'review' | 'review-critical';
    baseRef: string;
    headRef: string;
    scopePrefix: string;
    ttlSeconds: number;
  }> = {}
) {
  const workspaceRequestId = `open-${label}`;
  return {
    stateDir,
    repositoryId: 'repo',
    coordinator,
    profile: 'review' as const,
    surface: 'chat' as const,
    sessionId: `session-${label}`,
    workspaceRequestId,
    prompt: finalPrompt(workspaceRequestId, label),
    baseRef: 'HEAD',
    scopePrefix: '',
    ttlSeconds: 60,
    now: NOW,
    ...extra
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, error => {
    assert.equal((error as { code?: unknown }).code, code);
    return true;
  });
}

async function browserEvidence(
  stateDir: string,
  prepared: any,
  sessionId: string
) {
  return recordTrustedBrowserObservation({
    selectionId: prepared.run.selection.selection_id,
    surface: 'chat',
    controlLabel: prepared.run.profile === 'review-critical' ? 'Pro' : 'Extra High',
    modelLabel: prepared.run.profile === 'review-critical' ? 'Sol Pro' : 'Sol',
    selectedAt: '2026-10-14T02:10:01.000Z',
    observedAt: '2026-10-14T02:10:02.000Z',
    sessionId
  }, { stateDir: path.join(stateDir, 'model-policy'), now: OBSERVED });
}

async function reservePrepared(stateDir: string, prepared: any, sessionId: string) {
  const evidence = await browserEvidence(stateDir, prepared, sessionId);
  return reserveChatGptRun({
    stateDir,
    runId: prepared.run.run_id,
    contract: prepared.run.selection,
    evidence,
    now: OBSERVED
  });
}

function submissionReceipt(run: ChatGptRunRecord, sessionId: string, event: string): TrustedChatGptRunReceipt {
  return {
    repositoryId: run.repository_id,
    taskId: run.task_id,
    promptSha256: run.prompt_sha256,
    baseCommit: run.resolved_base_commit,
    ...(run.commit_binding ? {
      headCommit: run.commit_binding.head_commit,
      candidateDigest: run.commit_binding.candidate_digest
    } : {}),
    browserEventId: event,
    observedAt: SUBMITTED.toISOString(),
    sessionId
  };
}

function completionReceipt(
  run: ChatGptRunRecord,
  sessionId: string,
  event: string,
  submitEvent: string,
  output: string
): TrustedChatGptCompletionReceipt {
  return {
    ...submissionReceipt(run, sessionId, event),
    observedAt: '2026-10-14T02:10:05.000Z',
    kind: 'completion',
    responseState: 'completed',
    submissionEventSha256: sha256(`browser-event\0${submitEvent}`),
    outputSha256: sha256(output)
  };
}

async function submitPrepared(stateDir: string, prepared: any, sessionId: string, event: string) {
  const reserved = await reservePrepared(stateDir, prepared, sessionId);
  assert.equal(reserved.submission_authorized, true);
  return markChatGptRunSubmitted({
    stateDir,
    runId: prepared.run.run_id,
    receipt: submissionReceipt(reserved, sessionId, event),
    now: SUBMITTED
  });
}

async function openForParticipant(stateDir: string, prepared: any, requestId?: string) {
  const binding = prepared.participant.commit_binding;
  return openWorkspace({
    stateDir,
    repositoryId: 'repo',
    taskId: prepared.participant.task_id,
    mode: 'review',
    requestId: requestId ?? prepared.participant.workspace_request_id,
    ttlMs: prepared.participant.workspace_ttl_ms,
    ...(binding ? {
      baseRef: binding.requested_base_ref,
      headRef: binding.requested_head_ref,
      scopePrefix: binding.scope_prefix
    } : {})
  });
}

async function addSecondCatalogTask(stateDir: string, root: string) {
  const catalog = await readMultiRepoCatalog(stateDir);
  const repository = catalog.repositories.repo;
  await bindTask(stateDir, 'task-2', root, repository.policy_digest);
  await setTaskPhase(stateDir, 'task-2', 'review');
  const live = await taskStatus(stateDir, 'task-2', { readOnly: true });
  const store = await StateStore.open(stateDir);
  const raw = await store.read<any>('control/multirepo-catalog.json', 'multirepo-catalog');
  raw.tasks['task-2'] = {
    task_id: 'task-2',
    repository_id: 'repo',
    binding_epoch: live.binding_epoch,
    phase_epoch: live.phase_epoch,
    phase: live.phase,
    allow_detached: live.allow_detached,
    completed: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await store.write('control/multirepo-catalog.json', 'multirepo-catalog', raw);
}

test('taskless prepare selects exactly one review task and never binds or changes phase', async t => {
  const { stateDir } = await fixture(t, { phase: 'review' });
  const before = await readMultiRepoCatalog(stateDir);
  const prepared = await prepareOrJoinReview(prepareOptions(stateDir, 'codex', 'one-task'));
  assert.equal(prepared.participant.task_id, 'task');
  assert.equal(prepared.generation.task_id, 'task');
  const after = await readMultiRepoCatalog(stateDir);
  assert.deepEqual(after.tasks, before.tasks);
});

test('taskless zero/multiple/coding cases fail without task theft, binding or phase mutation', async t => {
  await t.test('zero', async st => {
    const { stateDir } = await fixture(st, { task: false });
    const before = await readMultiRepoCatalog(stateDir);
    await expectCode(
      prepareOrJoinReview(prepareOptions(stateDir, 'codex', 'zero-task')),
      'REVIEW_TASK_REQUIRED'
    );
    assert.deepEqual(await readMultiRepoCatalog(stateDir), before);
  });

  await t.test('multiple', async st => {
    const { stateDir, root } = await fixture(st, { phase: 'review' });
    await addSecondCatalogTask(stateDir, root);
    const catalogFile = path.join(stateDir, 'control', 'multirepo-catalog.json');
    const before = await readFile(catalogFile, 'utf8');
    await assert.rejects(
      prepareOrJoinReview(prepareOptions(stateDir, 'codex', 'multi-task')),
      error => {
        const code = (error as { code?: unknown }).code;
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(
          code === 'REVIEW_TASK_AMBIGUOUS' ||
          /corrupt task catalog.*multiple unfinished tasks|review task.*ambiguous/i.test(message),
          message
        );
        return true;
      }
    );
    assert.equal(await readFile(catalogFile, 'utf8'), before);
  });

  await t.test('coding owner action required', async st => {
    const { stateDir } = await fixture(st, { phase: 'coding' });
    const beforeCatalog = await readMultiRepoCatalog(stateDir);
    const beforeTask = await taskStatus(stateDir, 'task', { readOnly: true });
    await expectCode(
      prepareOrJoinReview(prepareOptions(stateDir, 'codex', 'coding-phase')),
      'OWNER_ACTION_REQUIRED'
    );
    assert.deepEqual(await readMultiRepoCatalog(stateDir), beforeCatalog);
    assert.deepEqual(await taskStatus(stateDir, 'task', { readOnly: true }), beforeTask);
  });
});

test('concurrent Codex and Claude taskless joins coalesce to one generation with distinct immutable participants', async t => {
  const { stateDir } = await fixture(t, { phase: 'review', extraCommit: true });
  const codexOptions = prepareOptions(stateDir, 'codex', 'parallel-codex', {
    baseRef: 'HEAD^',
    scopePrefix: 'src/'
  });
  const claudeOptions = prepareOptions(stateDir, 'claude', 'parallel-claude', {
    baseRef: 'HEAD',
    scopePrefix: 'test/'
  });
  const [codex, claude] = await Promise.all([
    prepareOrJoinReview(codexOptions),
    prepareOrJoinReview(claudeOptions)
  ]);

  assert.equal(codex.generation.generation, claude.generation.generation);
  assert.equal(codex.generation.target_fingerprint, claude.generation.target_fingerprint);
  assert.notEqual(codex.participant.participant_id, claude.participant.participant_id);
  assert.notEqual(codex.participant.run_id, claude.participant.run_id);
  assert.notEqual(codex.participant.workspace_request_id, claude.participant.workspace_request_id);
  assert.notDeepEqual(codex.run.selection.browser_context, claude.run.selection.browser_context);
  assert.notEqual(codex.participant.resolved_base_commit, claude.participant.resolved_base_commit);
  assert.notEqual(codex.participant.scope_digest, claude.participant.scope_digest);

  for (const [prepared, options] of [[codex, codexOptions], [claude, claudeOptions]] as const) {
    assert.equal(prepared.run.share_generation, prepared.generation.generation);
    assert.equal(prepared.run.participant_id, prepared.participant.participant_id);
    assert.equal(prepared.run.workspace_request_id, prepared.participant.workspace_request_id);
    assert.equal(prepared.run.prompt_sha256, sha256(options.prompt));
    assert.equal(prepared.participant.prompt_digest, sha256(options.prompt));
    assert.equal(prepared.participant.workspace_association, 'pending');
  }
});

test('exact prepare retry reuses one participant/run and reserve can authorize only one send', async t => {
  const { stateDir } = await fixture(t, { phase: 'review' });
  const options = prepareOptions(stateDir, 'codex', 'exact-retry');
  const first = await prepareOrJoinReview(options);
  const second = await prepareOrJoinReview(options);

  assert.equal(second.already_applied, true);
  assert.equal(second.participant.participant_id, first.participant.participant_id);
  assert.equal(second.run.run_id, first.run.run_id);
  assert.equal(second.participant.workspace_request_id, first.participant.workspace_request_id);

  const evidence = await browserEvidence(stateDir, first, options.sessionId);
  const reserved = await reserveChatGptRun({
    stateDir, runId: first.run.run_id, contract: first.run.selection, evidence, now: OBSERVED
  });
  assert.equal(reserved.submission_authorized, true);
  const duplicate = await reserveChatGptRun({
    stateDir, runId: first.run.run_id, contract: first.run.selection, evidence, now: OBSERVED
  });
  assert.equal(duplicate.submission_authorized, false);
  assert.equal(duplicate.recovery_required, true);
});

test('workspace reconciliation derives the write-once workspace id only from the authoritative request ledger', async t => {
  const { stateDir } = await fixture(t, { phase: 'review' });
  const options = prepareOptions(stateDir, 'codex', 'reconcile-ledger');
  const prepared = await prepareOrJoinReview(options);

  await assert.rejects(
    reconcileReviewParticipant({
      stateDir,
      taskId: 'task',
      participantId: prepared.participant.participant_id,
      workspaceId: 'f'.repeat(32)
    } as any),
    /workspace.*not accepted|unknown argument|arbitrary workspace/i
  );

  const expected = await openForParticipant(stateDir, prepared);
  const other = await openWorkspace({
    stateDir, repositoryId: 'repo', taskId: 'task', mode: 'review',
    requestId: 'unrelated-review-open', ttlMs: 60_000
  });
  assert.notEqual(expected.selection.workspace_id, other.selection.workspace_id);

  const reconciled = await reconcileReviewParticipant({
    stateDir,
    taskId: 'task',
    participantId: prepared.participant.participant_id
  });
  assert.equal(reconciled.participant.workspace_association, 'bound');
  assert.equal(reconciled.participant.workspace_id, expected.selection.workspace_id);
  assert.notEqual(reconciled.participant.workspace_id, other.selection.workspace_id);

  const again = await reconcileReviewParticipant({
    stateDir,
    taskId: 'task',
    participantId: prepared.participant.participant_id
  });
  assert.equal(again.participant.workspace_id, expected.selection.workspace_id);
});

test('reconciliation validates authoritative workspace_open operation and args digest', async t => {
  const { stateDir } = await fixture(t, { phase: 'review' });
  const options = prepareOptions(stateDir, 'codex', 'reconcile-digest');
  const prepared = await prepareOrJoinReview(options);
  await openForParticipant(stateDir, prepared);

  const store = await StateStore.open(stateDir);
  const auth = await store.read<any>('control/multirepo-auth.json', 'multirepo-auth');
  const key = sha256(`workspace_open\0${prepared.participant.workspace_request_id}`);
  assert.equal(auth.requests[key].operation, 'workspace_open');
  auth.requests[key].args_digest = 'f'.repeat(64);
  await store.write('control/multirepo-auth.json', 'multirepo-auth', auth);

  await expectCode(
    reconcileReviewParticipant({
      stateDir, taskId: 'task', participantId: prepared.participant.participant_id
    }),
    'WORKSPACE_RECONCILIATION_MISMATCH'
  );
});

test('completion and normal close require authoritative workspace binding', async t => {
  const { stateDir } = await fixture(t, { phase: 'review' });
  const options = prepareOptions(stateDir, 'codex', 'completion-bound');
  const prepared = await prepareOrJoinReview(options);
  const submitted = await submitPrepared(stateDir, prepared, options.sessionId, 'send-completion-bound');
  const output = 'SHIP\n';

  await expectCode(
    completeChatGptRun({
      stateDir,
      runId: submitted.run_id,
      output,
      outcome: 'ship',
      receipt: completionReceipt(
        submitted, options.sessionId, 'complete-before-reconcile', 'send-completion-bound', output
      ),
      now: new Date('2026-10-14T02:10:05.000Z')
    }),
    'WORKSPACE_RECONCILIATION_REQUIRED'
  );
  await expectCode(
    closeReviewParticipant({
      stateDir, taskId: 'task', participantId: prepared.participant.participant_id,
      requestId: 'close-before-reconcile'
    }),
    'WORKSPACE_RECONCILIATION_REQUIRED'
  );

  await openForParticipant(stateDir, prepared);
  await reconcileReviewParticipant({
    stateDir, taskId: 'task', participantId: prepared.participant.participant_id
  });
  const completed = await completeChatGptRun({
    stateDir,
    runId: submitted.run_id,
    output,
    outcome: 'ship',
    receipt: completionReceipt(
      submitted, options.sessionId, 'complete-after-reconcile', 'send-completion-bound', output
    ),
    now: new Date('2026-10-14T02:10:06.000Z')
  });
  assert.equal(completed.state, 'completed');
});

test('only terminal pre-submit participants can recover authoritative workspace absence', async t => {
  await t.test('failed pre-submit becomes proven-absent and can close', async st => {
    const { stateDir } = await fixture(st, { phase: 'review' });
    const options = prepareOptions(stateDir, 'codex', 'proven-absent');
    const prepared = await prepareOrJoinReview(options);
    await failChatGptRunBeforeSubmit(prepared.run.run_id, 'NO_BROWSER_SEND', stateDir, OBSERVED);

    const recovered = await recoverReviewParticipant({
      stateDir, taskId: 'task', participantId: prepared.participant.participant_id
    });
    assert.equal(recovered.participant.workspace_association, 'proven-absent');
    const closed = await closeReviewParticipant({
      stateDir, taskId: 'task', participantId: prepared.participant.participant_id,
      requestId: 'close-proven-absent'
    });
    assert.equal(closed.participant.state, 'closed');
  });

  for (const desired of ['submitted', 'uncertain'] as const) {
    await t.test(`${desired} pending stays protected`, async st => {
      const { stateDir } = await fixture(st, { phase: 'review' });
      const options = prepareOptions(stateDir, 'codex', `pending-${desired}`);
      const prepared = await prepareOrJoinReview(options);
      const submitted = await submitPrepared(
        stateDir, prepared, options.sessionId, `send-pending-${desired}`
      );
      if (desired === 'uncertain') {
        await markChatGptRunUncertain(
          submitted.run_id, 'LOST_BROWSER_STATE', stateDir,
          new Date('2026-10-14T02:10:05.000Z')
        );
      }
      await expectCode(
        recoverReviewParticipant({
          stateDir, taskId: 'task', participantId: prepared.participant.participant_id
        }),
        'WORKSPACE_RECONCILIATION_REQUIRED'
      );
      await expectCode(
        closeReviewParticipant({
          stateDir, taskId: 'task', participantId: prepared.participant.participant_id,
          requestId: `close-pending-${desired}`
        }),
        'WORKSPACE_RECONCILIATION_REQUIRED'
      );
    });
  }
});

test('closing one participant never closes or revokes its sibling', async t => {
  const { stateDir } = await fixture(t, { phase: 'review' });
  const aOptions = prepareOptions(stateDir, 'codex', 'sibling-a');
  const bOptions = prepareOptions(stateDir, 'claude', 'sibling-b');
  const [a, b] = await Promise.all([
    prepareOrJoinReview(aOptions),
    prepareOrJoinReview(bOptions)
  ]);
  const aWorkspace = await openForParticipant(stateDir, a);
  await reconcileReviewParticipant({
    stateDir, taskId: 'task', participantId: a.participant.participant_id
  });
  await failChatGptRunBeforeSubmit(a.run.run_id, 'CANCELLED', stateDir, OBSERVED);

  const closed = await closeReviewParticipant({
    stateDir, taskId: 'task', participantId: a.participant.participant_id,
    requestId: 'close-sibling-a'
  });
  assert.equal(closed.participant.state, 'closed');

  const status = await reviewShareStatus({ stateDir, taskId: 'task' });
  const sibling = status.participants.find((item: any) => item.participant_id === b.participant.participant_id);
  assert.ok(sibling);
  assert.notEqual(sibling.state, 'closed');
  assert.notEqual(sibling.state, 'invalidated');
  assert.equal((await chatGptRunStatus(b.run.run_id, stateDir)).state, 'prepared');

  const auth = await (await StateStore.open(stateDir)).read<any>('control/multirepo-auth.json', 'multirepo-auth');
  assert.equal(auth.workspaces[aWorkspace.selection.workspace_id].status, 'closed');
});

test('siblings in one generation retain distinct completed review results', async t => {
  const { stateDir } = await fixture(t, { phase: 'review' });
  const aOptions = prepareOptions(stateDir, 'codex', 'result-a');
  const bOptions = prepareOptions(stateDir, 'claude', 'result-b');
  const [a, b] = await Promise.all([
    prepareOrJoinReview(aOptions),
    prepareOrJoinReview(bOptions)
  ]);
  assert.equal(a.generation.generation, b.generation.generation);

  for (const prepared of [a, b]) {
    await openForParticipant(stateDir, prepared);
    await reconcileReviewParticipant({
      stateDir, taskId: 'task', participantId: prepared.participant.participant_id
    });
  }

  const submittedA = await submitPrepared(stateDir, a, aOptions.sessionId, 'send-result-a');
  const submittedB = await submitPrepared(stateDir, b, bOptions.sessionId, 'send-result-b');
  const outputA = 'SHIP A\n';
  const outputB = 'NO-SHIP B\n';
  const completedA = await completeChatGptRun({
    stateDir, runId: submittedA.run_id, output: outputA, outcome: 'ship',
    receipt: completionReceipt(submittedA, aOptions.sessionId, 'complete-result-a', 'send-result-a', outputA),
    now: new Date('2026-10-14T02:10:06.000Z')
  });
  const completedB = await completeChatGptRun({
    stateDir, runId: submittedB.run_id, output: outputB, outcome: 'no-ship',
    receipt: completionReceipt(submittedB, bOptions.sessionId, 'complete-result-b', 'send-result-b', outputB),
    now: new Date('2026-10-14T02:10:06.000Z')
  });

  assert.equal((completedA as any).share_generation, (completedB as any).share_generation);
  assert.notEqual(completedA.output_sha256, completedB.output_sha256);
  assert.equal(completedA.outcome, 'ship');
  assert.equal(completedB.outcome, 'no-ship');
});

test('direct ChatGPT-run transitions remain synchronized with participant state', async t => {
  const { stateDir } = await fixture(t, { phase: 'review' });
  const options = prepareOptions(stateDir, 'codex', 'direct-run-sync');
  const prepared = await prepareOrJoinReview(options);
  const reserved = await reservePrepared(stateDir, prepared, options.sessionId);
  let status = await reviewShareStatus({ stateDir, taskId: 'task' });
  assert.equal(
    status.participants.find((item: any) => item.participant_id === prepared.participant.participant_id)?.state,
    'submission-reserved'
  );

  const submitted = await markChatGptRunSubmitted({
    stateDir,
    runId: reserved.run_id,
    receipt: submissionReceipt(reserved, options.sessionId, 'send-direct-sync'),
    now: SUBMITTED
  });
  status = await reviewShareStatus({ stateDir, taskId: 'task' });
  assert.equal(
    status.participants.find((item: any) => item.participant_id === prepared.participant.participant_id)?.state,
    'submitted'
  );

  await markChatGptRunUncertain(
    submitted.run_id, 'DIRECT_UNCERTAIN', stateDir,
    new Date('2026-10-14T02:10:05.000Z')
  );
  status = await reviewShareStatus({ stateDir, taskId: 'task' });
  assert.equal(
    status.participants.find((item: any) => item.participant_id === prepared.participant.participant_id)?.state,
    'uncertain'
  );
});

test('target, HEAD and persisted generation compatibility changes refuse mixing', async t => {
  await t.test('fingerprint/worktree', async st => {
    const { stateDir, root } = await fixture(st, { phase: 'review', extraCommit: true });
    await prepareOrJoinReview(prepareOptions(stateDir, 'codex', 'target-before'));
    await writeFile(path.join(root, 'src', 'share-target.txt'), 'target v2\n');
    await expectCode(
      prepareOrJoinReview(prepareOptions(stateDir, 'claude', 'target-after')),
      'TARGET_CHANGED'
    );
  });

  await t.test('HEAD', async st => {
    const { stateDir, root } = await fixture(st, { phase: 'review', extraCommit: true });
    await prepareOrJoinReview(prepareOptions(stateDir, 'codex', 'head-before'));
    await writeFile(path.join(root, 'src', 'share-target.txt'), 'committed head change\n');
    await git(root, 'add', '--', 'src/share-target.txt');
    await git(root, 'commit', '-m', 'move head during shared review');
    await expectCode(
      prepareOrJoinReview(prepareOptions(stateDir, 'claude', 'head-after')),
      'TARGET_CHANGED'
    );
  });

  for (const field of [
    'registration_epoch', 'binding_epoch', 'phase_epoch',
    'policy_digest', 'head', 'target_fingerprint'
  ] as const) {
    await t.test(`persisted ${field}`, async st => {
      const { stateDir } = await fixture(st, { phase: 'review' });
      const options = prepareOptions(stateDir, 'codex', `stale-${field}`);
      await prepareOrJoinReview(options);
      const store = await StateStore.open(stateDir);
      const journal = await store.read<any>(SHARE_PATH, SHARE_KIND);
      assert.ok(journal);
      const changed = structuredClone(journal);
      if (field.endsWith('_epoch')) changed[field] += 1;
      else changed[field] = field === 'head' ? 'f'.repeat(40) : 'f'.repeat(64);
      await store.write(SHARE_PATH, SHARE_KIND, changed);

      await expectCode(prepareOrJoinReview(options), 'REVIEW_SHARE_STATE_STALE');
    });
  }
});

test('generation/participant/workspace-request bindings stay immutable across reconcile and close', async t => {
  const { stateDir } = await fixture(t, { phase: 'review' });
  const options = prepareOptions(stateDir, 'codex', 'immutable-bindings');
  const prepared = await prepareOrJoinReview(options);
  const initial = {
    generation: prepared.generation.generation,
    participant: prepared.participant.participant_id,
    run: prepared.run.run_id,
    workspaceRequest: prepared.participant.workspace_request_id
  };
  await openForParticipant(stateDir, prepared);
  await reconcileReviewParticipant({
    stateDir, taskId: 'task', participantId: prepared.participant.participant_id
  });
  await failChatGptRunBeforeSubmit(prepared.run.run_id, 'CANCELLED', stateDir, OBSERVED);
  await closeReviewParticipant({
    stateDir, taskId: 'task', participantId: prepared.participant.participant_id,
    requestId: 'close-immutable'
  });

  const run = await chatGptRunStatus(prepared.run.run_id, stateDir) as any;
  assert.equal(run.share_generation, initial.generation);
  assert.equal(run.participant_id, initial.participant);
  assert.equal(run.run_id, initial.run);
  assert.equal(run.workspace_request_id, initial.workspaceRequest);

  const store = await StateStore.open(stateDir);
  const journal = await store.read<any>(SHARE_PATH, SHARE_KIND);
  const participant = journal.participants.find((item: any) => item.participant_id === initial.participant);
  assert.equal(participant.workspace_request_id, initial.workspaceRequest);
  assert.equal(participant.run_id, initial.run);
});

test('security disable and workspace revoke invalidate current shared authority without deleting evidence', async t => {
  await t.test('repository disable', async st => {
    const { stateDir } = await fixture(st, { phase: 'review' });
    const options = prepareOptions(stateDir, 'codex', 'security-disable-share');
    const prepared = await prepareOrJoinReview(options);
    const reserved = await reservePrepared(stateDir, prepared, options.sessionId);
    const store = await StateStore.open(stateDir);
    const runRel = `chatgpt-runs/${reserved.run_id}.json`;
    const claimRel = `chatgpt-run-requests/${reserved.request_key}.json`;

    await setRepositoryEnabled({ stateDir, repositoryId: 'repo', enabled: false });
    const status = await reviewShareStatus({ stateDir, taskId: 'task' });
    assert.equal(
      status.participants.find((item: any) => item.participant_id === prepared.participant.participant_id)?.state,
      'invalidated'
    );
    assert.equal((await chatGptRunStatus(reserved.run_id, stateDir)).state, 'submission-reserved');
    assert.ok(await store.read(runRel, 'chatgpt-run-v1'));
    assert.ok(await store.read(claimRel, 'chatgpt-run-request-v1'));

    await setRepositoryEnabled({ stateDir, repositoryId: 'repo', enabled: true });
    const afterEnable = await reviewShareStatus({ stateDir, taskId: 'task' });
    assert.equal(
      afterEnable.participants.find((item: any) => item.participant_id === prepared.participant.participant_id)?.state,
      'invalidated',
      'security re-enable must not revive old authority'
    );
  });

  await t.test('workspace revoke', async st => {
    const { stateDir } = await fixture(st, { phase: 'review' });
    const options = prepareOptions(stateDir, 'codex', 'security-revoke-share');
    const prepared = await prepareOrJoinReview(options);
    const opened = await openForParticipant(stateDir, prepared);
    await reconcileReviewParticipant({
      stateDir, taskId: 'task', participantId: prepared.participant.participant_id
    });
    await revokeWorkspace({ stateDir, workspaceId: opened.selection.workspace_id });
    const status = await reviewShareStatus({ stateDir, taskId: 'task' });
    assert.equal(
      status.participants.find((item: any) => item.participant_id === prepared.participant.participant_id)?.state,
      'invalidated'
    );
    assert.equal((await chatGptRunStatus(prepared.run.run_id, stateDir)).run_id, prepared.run.run_id);
  });
});

test('reserve-vs-security-invalidation has deterministic winner semantics through existing gates', async t => {
  await t.test('reservation wins after entering share->run before disable enters share->task', async st => {
    const { stateDir } = await fixture(st, { phase: 'review' });
    const options = prepareOptions(stateDir, 'codex', 'reserve-wins');
    const prepared = await prepareOrJoinReview(options);
    const evidence = await browserEvidence(stateDir, prepared, options.sessionId);
    const store = await StateStore.open(stateDir);
    const runLockRel = `locks/chatgpt-run-${prepared.run.run_id}.json`;
    const heldRun = await acquireLock(
      store, `chatgpt-run-${prepared.run.run_id}`, 'test hold shared reserve run lock'
    );
    const shareEntered = deferred();
    const originalCreate = StateStore.prototype.create;
    const observed = st.mock.method(
      StateStore.prototype,
      'create',
      async function(this: StateStore, rel: string, kind: string, data: unknown) {
        const created = await originalCreate.call(this, rel, kind, data);
        if (created && kind === 'lock' && rel !== runLockRel) shareEntered.resolve();
        return created;
      }
    );

    let heldReleased = false;
    let reserving: ReturnType<typeof reserveChatGptRun> | undefined;
    let disabling: ReturnType<typeof setRepositoryEnabled> | undefined;
    try {
      reserving = reserveChatGptRun({
        stateDir, runId: prepared.run.run_id, contract: prepared.run.selection, evidence, now: OBSERVED
      });
      const enteredShare = await Promise.race([
        shareEntered.promise.then(() => true),
        reserving.then(() => false, () => false)
      ]);
      assert.equal(enteredShare, true, 'reserve must acquire its outer share gate before waiting on the run lock');

      let disableSettled = false;
      disabling = setRepositoryEnabled({
        stateDir, repositoryId: 'repo', enabled: false
      }).finally(() => { disableSettled = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(disableSettled, false, 'disable must wait on share while reserve owns the earlier lock-order position');

      await heldRun.release();
      heldReleased = true;
      const reserved = await reserving;
      assert.equal(reserved.submission_authorized, true);

      await disabling;
      const status = await reviewShareStatus({ stateDir, taskId: 'task' });
      assert.equal(
        status.participants.find((item: any) => item.participant_id === prepared.participant.participant_id)?.state,
        'invalidated'
      );
    } finally {
      if (!heldReleased) await heldRun.release();
      await reserving?.catch(() => {});
      await disabling?.catch(() => {});
      observed.mock.restore();
    }
  });

  await t.test('invalidation wins before reserve', async st => {
    const { stateDir } = await fixture(st, { phase: 'review' });
    const options = prepareOptions(stateDir, 'codex', 'invalidate-wins');
    const prepared = await prepareOrJoinReview(options);
    const evidence = await browserEvidence(stateDir, prepared, options.sessionId);
    await setRepositoryEnabled({ stateDir, repositoryId: 'repo', enabled: false });
    await assert.rejects(
      reserveChatGptRun({
        stateDir, runId: prepared.run.run_id, contract: prepared.run.selection, evidence, now: OBSERVED
      }),
      /authorization.*current|invalidated|repository.*active/i
    );
  });
});

test('participant close waits for an admitted workspace read and then closes without timeout-as-success', async t => {
  const { stateDir } = await fixture(t, { phase: 'review' });
  const options = prepareOptions(stateDir, 'codex', 'close-read-race');
  const prepared = await prepareOrJoinReview(options);
  const opened = await openForParticipant(stateDir, prepared);
  await reconcileReviewParticipant({
    stateDir, taskId: 'task', participantId: prepared.participant.participant_id
  });
  await failChatGptRunBeforeSubmit(prepared.run.run_id, 'CANCELLED', stateDir, OBSERVED);

  const entered = deferred();
  const release = deferred();
  const admitted = withWorkspaceAdmission(stateDir, opened.workspace_token, 'read', async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;

  let closeSettled = false;
  const closing = closeReviewParticipant({
    stateDir, taskId: 'task', participantId: prepared.participant.participant_id,
    requestId: 'close-after-admitted-read'
  }).finally(() => { closeSettled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(closeSettled, false, 'close must drain the already-admitted read');

  release.resolve();
  await admitted;
  const closed = await closing;
  assert.equal(closed.participant.state, 'closed');
});

test('corrupt, missing, partial and unsafe share journals fail closed instead of creating a replacement generation', async t => {
  await t.test('missing with durable run evidence', async st => {
    const { stateDir } = await fixture(st, { phase: 'review' });
    const options = prepareOptions(stateDir, 'codex', 'journal-missing');
    const prepared = await prepareOrJoinReview(options);
    const store = await StateStore.open(stateDir);
    await store.remove(SHARE_PATH);
    assert.equal((await chatGptRunStatus(prepared.run.run_id, stateDir)).state, 'prepared');
    await expectCode(prepareOrJoinReview(options), 'REVIEW_SHARE_STATE_MISSING');
  });

  await t.test('partial', async st => {
    const { stateDir } = await fixture(st, { phase: 'review' });
    await prepareOrJoinReview(prepareOptions(stateDir, 'codex', 'journal-partial'));
    const store = await StateStore.open(stateDir);
    const journal = await store.read<any>(SHARE_PATH, SHARE_KIND);
    delete journal.target_fingerprint;
    await store.write(SHARE_PATH, SHARE_KIND, journal);
    await expectCode(reviewShareStatus({ stateDir, taskId: 'task' }), 'REVIEW_SHARE_STATE_CORRUPT');
  });

  await t.test('unknown field', async st => {
    const { stateDir } = await fixture(st, { phase: 'review' });
    await prepareOrJoinReview(prepareOptions(stateDir, 'codex', 'journal-corrupt'));
    const store = await StateStore.open(stateDir);
    const journal = await store.read<any>(SHARE_PATH, SHARE_KIND);
    await store.write(SHARE_PATH, SHARE_KIND, { ...journal, raw_prompt: 'must never be accepted' });
    await expectCode(reviewShareStatus({ stateDir, taskId: 'task' }), 'REVIEW_SHARE_STATE_CORRUPT');
  });

  await t.test('symlink', async st => {
    const { base, stateDir } = await fixture(st, { phase: 'review' });
    await prepareOrJoinReview(prepareOptions(stateDir, 'codex', 'journal-symlink'));
    const journalFile = path.join(stateDir, SHARE_PATH);
    const outside = path.join(base, 'outside-share.json');
    await writeFile(outside, '{}');
    await rm(journalFile);
    await symlink(outside, journalFile);
    await assert.rejects(
      reviewShareStatus({ stateDir, taskId: 'task' }),
      /unsafe|symlink|corrupt|state/i
    );
  });
});

test('restart-style reads recompute status and explicit recovery never invents completion', async t => {
  const { stateDir } = await fixture(t, { phase: 'review' });
  const options = prepareOptions(stateDir, 'codex', 'restart-recovery');
  const prepared = await prepareOrJoinReview(options);
  await failChatGptRunBeforeSubmit(prepared.run.run_id, 'NO_SEND', stateDir, OBSERVED);

  const before = await reviewShareStatus({ stateDir, taskId: 'task' });
  assert.equal(before.generation, prepared.generation.generation);
  const recovered = await recoverReviewParticipant({
    stateDir, taskId: 'task', participantId: prepared.participant.participant_id
  });
  assert.equal(recovered.participant.workspace_association, 'proven-absent');
  assert.equal((await chatGptRunStatus(prepared.run.run_id, stateDir)).state, 'failed-pre-submit');

  const after = await reviewShareStatus({ stateDir, taskId: 'task' });
  assert.equal(after.generation, before.generation);
  assert.equal(
    after.participants.find((item: any) => item.participant_id === prepared.participant.participant_id)?.workspace_association,
    'proven-absent'
  );
  assert.equal((await taskStatus(stateDir, 'task', { readOnly: true })).completion, null);
});

test('TTL/GC preserves submitted/uncertain participant workspace ledger and recovery evidence', async t => {
  const { stateDir } = await fixture(t, { phase: 'review' });
  const options = prepareOptions(stateDir, 'codex', 'gc-protected');
  const prepared = await prepareOrJoinReview(options);
  const opened = await openForParticipant(stateDir, prepared);
  await reconcileReviewParticipant({
    stateDir, taskId: 'task', participantId: prepared.participant.participant_id
  });
  const submitted = await submitPrepared(stateDir, prepared, options.sessionId, 'send-gc-protected');
  await markChatGptRunUncertain(
    submitted.run_id, 'GC_MUST_PRESERVE', stateDir,
    new Date('2026-10-14T02:10:05.000Z')
  );

  const store = await StateStore.open(stateDir);
  const auth = await store.read<any>('control/multirepo-auth.json', 'multirepo-auth');
  auth.workspaces[opened.selection.workspace_id].expires_at = '2020-01-01T00:00:00.000Z';
  for (const request of Object.values<any>(auth.requests)) request.at = '2020-01-01T00:00:00.000Z';
  await store.write('control/multirepo-auth.json', 'multirepo-auth', auth);
  const beforeRun = await readFile(path.join(stateDir, 'chatgpt-runs', `${submitted.run_id}.json`), 'utf8');
  const beforeClaim = await readFile(path.join(stateDir, 'chatgpt-run-requests', `${submitted.request_key}.json`), 'utf8');

  await garbageCollect({
    stateDir, apply: true, authRetentionHours: 1, captureRetentionHours: 0,
    taskRetentionDays: 1, nowMs: Date.parse('2035-01-01T00:00:00.000Z')
  });

  const afterAuth = await store.read<any>('control/multirepo-auth.json', 'multirepo-auth');
  assert.ok(afterAuth.workspaces[opened.selection.workspace_id], 'bound protected workspace evidence must remain');
  assert.ok(
    Object.values<any>(afterAuth.requests).some(request => request.workspace_id === opened.selection.workspace_id),
    'authoritative workspace_open ledger must remain'
  );
  assert.equal(await readFile(path.join(stateDir, 'chatgpt-runs', `${submitted.run_id}.json`), 'utf8'), beforeRun);
  assert.equal(await readFile(path.join(stateDir, 'chatgpt-run-requests', `${submitted.request_key}.json`), 'utf8'), beforeClaim);
  const status = await reviewShareStatus({ stateDir, taskId: 'task' });
  assert.equal(
    status.participants.find((item: any) => item.participant_id === prepared.participant.participant_id)?.state,
    'uncertain'
  );
  assert.equal((await taskStatus(stateDir, 'task', { readOnly: true })).completion, null);
});

test('review join/close never mutates the pre-existing coding workspace owner record', async t => {
  const { stateDir } = await fixture(t, { phase: 'coding' });
  const grant = await issueWorkspaceGrant({ stateDir, taskId: 'task' });
  const coding = await openWorkspace({
    stateDir, repositoryId: 'repo', taskId: 'task', mode: 'code',
    requestId: 'legacy-coding-owner', writeGrant: grant.write_grant
  });
  await revokeWorkspace({ stateDir, workspaceId: coding.selection.workspace_id });
  await setRegisteredTaskPhase({ stateDir, taskId: 'task', phase: 'review' });
  const store = await StateStore.open(stateDir);
  const authBefore = await store.read<any>('control/multirepo-auth.json', 'multirepo-auth');
  const codingBefore = structuredClone(authBefore.workspaces[coding.selection.workspace_id]);
  assert.equal(codingBefore.status, 'revoked');

  const options = prepareOptions(stateDir, 'codex', 'coding-owner-unchanged');
  const prepared = await prepareOrJoinReview(options);
  await failChatGptRunBeforeSubmit(prepared.run.run_id, 'NO_SEND', stateDir, OBSERVED);
  await recoverReviewParticipant({
    stateDir, taskId: 'task', participantId: prepared.participant.participant_id
  });
  await closeReviewParticipant({
    stateDir, taskId: 'task', participantId: prepared.participant.participant_id,
    requestId: 'close-coding-owner-unchanged'
  });

  const authAfter = await store.read<any>('control/multirepo-auth.json', 'multirepo-auth');
  assert.deepEqual(authAfter.workspaces[coding.selection.workspace_id], codingBefore);
});

test('blocker regression: forged direct shared prepare is rejected before any publication and legitimate join still succeeds', async t => {
  const { stateDir } = await fixture(t, { phase: 'review' });
  const store = await StateStore.open(stateDir);
  const before = {
    runs: await store.list('chatgpt-runs'),
    requests: await store.list('chatgpt-run-requests'),
    selections: await store.list('model-policy/requests')
  };
  const forgedPrepare = (
    participantId: string,
    runId: string,
    selectionId: string,
    workspaceRequestId: string,
    sessionId: string
  ) => prepareChatGptRun({
    stateDir,
    repositoryId: 'repo',
    taskId: 'task',
    coordinator: 'codex',
    workKind: 'review',
    profile: 'review',
    surface: 'chat',
    sessionId,
    prompt: 'Forged direct shared preparation must never publish.\n',
    baseRef: 'HEAD',
    runId,
    selectionId,
    now: NOW,
    sharedReview: { generation: 1, participantId, workspaceRequestId }
  });
  const expectGateRequired = (promise: Promise<unknown>) => assert.rejects(
    promise,
    error => {
      assert.equal((error as { code?: unknown }).code, 'REVIEW_SHARE_GATE_REQUIRED');
      return true;
    }
  );

  await expectGateRequired(forgedPrepare(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    'forged-open-request',
    'session-forged-shared'
  ));

  const delayed = deferred();
  let late!: Promise<unknown>;
  await withTaskShareGate(stateDir, 'task', async () => {
    late = delayed.promise.then(() => forgedPrepare(
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
      'forged-open-request-late',
      'session-forged-shared-late'
    ));
  });
  delayed.resolve();
  await expectGateRequired(late);

  const exceptional = deferred();
  let afterThrow!: Promise<unknown>;
  await assert.rejects(
    withTaskShareGate(stateDir, 'task', async () => {
      afterThrow = exceptional.promise.then(() => forgedPrepare(
        '77777777-7777-4777-8777-777777777777',
        '88888888-8888-4888-8888-888888888888',
        '99999999-9999-4999-8999-999999999999',
        'forged-open-request-after-throw',
        'session-forged-shared-after-throw'
      ));
      throw new Error('intentional share-gate callback failure');
    }),
    /intentional share-gate callback failure/
  );
  exceptional.resolve();
  await expectGateRequired(afterThrow);

  assert.deepEqual({
    runs: await store.list('chatgpt-runs'),
    requests: await store.list('chatgpt-run-requests'),
    selections: await store.list('model-policy/requests')
  }, before, 'forged shared preparation must publish no run/request/model-selection state');

  const legitimate = await prepareOrJoinReview(prepareOptions(stateDir, 'codex', 'after-forged-direct'));
  assert.equal(legitimate.run.state, 'prepared');
  assert.equal(legitimate.participant.run_id, legitimate.run.run_id);
});

test('blocker regression: retired invalidated participant recovers same run after newer target generation without regaining authority', async t => {
  const { stateDir, root } = await fixture(t, { phase: 'review', extraCommit: true });
  const oldOptions = prepareOptions(stateDir, 'codex', 'retired-recovery-old');
  const oldPrepared = await prepareOrJoinReview(oldOptions);
  const oldSubmitted = await submitPrepared(stateDir, oldPrepared, oldOptions.sessionId, 'send-retired-old');
  await markChatGptRunUncertain(
    oldSubmitted.run_id,
    'RETIRED_RECOVERY',
    stateDir,
    new Date('2026-10-14T02:10:05.000Z')
  );

  await setRepositoryEnabled({ stateDir, repositoryId: 'repo', enabled: false });
  await setRepositoryEnabled({ stateDir, repositoryId: 'repo', enabled: true });
  await writeFile(path.join(root, 'src', 'share-target.txt'), 'target v2 after invalidation\n');

  const newer = await prepareOrJoinReview(prepareOptions(stateDir, 'claude', 'retired-recovery-new'));
  assert.ok(newer.generation.generation > oldPrepared.generation.generation);

  const recovered = await recoverChatGptRun(
    oldPrepared.run.run_id,
    'submitted',
    {
      repositoryId: oldPrepared.run.repository_id,
      taskId: oldPrepared.run.task_id,
      promptSha256: oldPrepared.run.prompt_sha256,
      baseCommit: oldPrepared.run.resolved_base_commit,
      browserEventId: 'recover-retired-old',
      observedAt: '2026-10-14T02:10:06.000Z',
      sessionId: oldOptions.sessionId
    },
    stateDir,
    new Date('2026-10-14T02:10:07.000Z')
  );
  assert.equal(recovered.run_id, oldPrepared.run.run_id);
  assert.equal(recovered.state, 'submitted');

  const store = await StateStore.open(stateDir);
  const journal = await store.read<any>(SHARE_PATH, SHARE_KIND);
  const retired = journal.participants.find((item: any) => item.participant_id === oldPrepared.participant.participant_id);
  const current = journal.participants.find((item: any) => item.participant_id === newer.participant.participant_id);
  assert.equal(retired.state, 'invalidated');
  assert.ok(retired.generation < journal.generation);
  assert.notEqual(retired.target_fingerprint, journal.target_fingerprint);
  assert.equal(current.state, 'prepared');
  assert.equal(current.generation, journal.generation);
  assert.equal((await chatGptRunStatus(newer.run.run_id, stateDir)).state, 'prepared');

  await expectCode(
    markChatGptRunSubmitted({
      stateDir,
      runId: oldPrepared.run.run_id,
      receipt: {
        repositoryId: oldPrepared.run.repository_id,
        taskId: oldPrepared.run.task_id,
        promptSha256: oldPrepared.run.prompt_sha256,
        baseCommit: oldPrepared.run.resolved_base_commit,
        browserEventId: 'send-retired-old',
        observedAt: '2026-10-14T02:10:08.000Z',
        sessionId: oldOptions.sessionId
      },
      now: new Date('2026-10-14T02:10:09.000Z')
    }),
    'REVIEW_AUTHORITY_INVALIDATED'
  );
});

test('blocker regression: pending invalidated workspace ledger survives future GC and mismatched ledger fails closed', async t => {
  await t.test('pending authoritative workspace remains recoverable', async st => {
    const { stateDir } = await fixture(st, { phase: 'review' });
    const options = prepareOptions(stateDir, 'codex', 'pending-gc-protected');
    const prepared = await prepareOrJoinReview(options);
    const opened = await openForParticipant(stateDir, prepared);
    assert.equal(prepared.participant.workspace_association, 'pending');

    const submitted = await submitPrepared(stateDir, prepared, options.sessionId, 'send-pending-gc');
    await markChatGptRunUncertain(
      submitted.run_id,
      'PENDING_GC',
      stateDir,
      new Date('2026-10-14T02:10:05.000Z')
    );
    await setRepositoryEnabled({ stateDir, repositoryId: 'repo', enabled: false });

    const store = await StateStore.open(stateDir);
    const beforeAuth = await store.read<any>('control/multirepo-auth.json', 'multirepo-auth');
    const requestEntry = Object.entries<any>(beforeAuth.requests).find(([, value]) =>
      value.operation === 'workspace_open' && value.workspace_id === opened.selection.workspace_id
    );
    assert.ok(requestEntry, 'fixture must have authoritative workspace_open ledger evidence');

    await garbageCollect({
      stateDir,
      apply: true,
      authRetentionHours: 1,
      captureRetentionHours: 0,
      taskRetentionDays: 1,
      nowMs: Date.parse(opened.selection.expires_at) + 2 * 60 * 60_000
    });

    const afterAuth = await store.read<any>('control/multirepo-auth.json', 'multirepo-auth');
    assert.ok(afterAuth.workspaces[opened.selection.workspace_id], 'pending protected workspace must survive GC');
    assert.ok(afterAuth.requests[requestEntry![0]], 'pending authoritative workspace_open ledger must survive GC');

    const reconciled = await reconcileReviewParticipant({
      stateDir,
      taskId: 'task',
      participantId: prepared.participant.participant_id
    });
    assert.equal(reconciled.participant.workspace_association, 'bound');
    assert.equal(reconciled.participant.workspace_id, opened.selection.workspace_id);

    const recovered = await recoverChatGptRun(
      submitted.run_id,
      'submitted',
      {
        repositoryId: submitted.repository_id,
        taskId: submitted.task_id,
        promptSha256: submitted.prompt_sha256,
        baseCommit: submitted.resolved_base_commit,
        browserEventId: 'recover-pending-gc',
        observedAt: '2026-10-14T02:10:06.000Z',
        sessionId: options.sessionId
      },
      stateDir,
      new Date('2026-10-14T02:10:07.000Z')
    );
    assert.equal(recovered.state, 'submitted');
  });

  await t.test('mismatched authoritative ledger aborts GC without deleting evidence', async st => {
    const { stateDir } = await fixture(st, { phase: 'review' });
    const options = prepareOptions(stateDir, 'codex', 'pending-gc-mismatch');
    const prepared = await prepareOrJoinReview(options);
    const opened = await openForParticipant(stateDir, prepared);
    const submitted = await submitPrepared(stateDir, prepared, options.sessionId, 'send-pending-gc-mismatch');
    await markChatGptRunUncertain(
      submitted.run_id,
      'PENDING_GC_MISMATCH',
      stateDir,
      new Date('2026-10-14T02:10:05.000Z')
    );
    await setRepositoryEnabled({ stateDir, repositoryId: 'repo', enabled: false });

    const store = await StateStore.open(stateDir);
    const auth = await store.read<any>('control/multirepo-auth.json', 'multirepo-auth');
    const requestEntry = Object.entries<any>(auth.requests).find(([, value]) =>
      value.operation === 'workspace_open' && value.workspace_id === opened.selection.workspace_id
    );
    assert.ok(requestEntry);
    auth.requests[requestEntry![0]].args_digest = 'f'.repeat(64);
    await store.write('control/multirepo-auth.json', 'multirepo-auth', auth);

    await assert.rejects(
      garbageCollect({
        stateDir,
        apply: true,
        authRetentionHours: 1,
        captureRetentionHours: 0,
        taskRetentionDays: 1,
        nowMs: Date.parse(opened.selection.expires_at) + 2 * 60 * 60_000
      }),
      /workspace_open.*does not match|mismatch|corrupt/i
    );

    const after = await store.read<any>('control/multirepo-auth.json', 'multirepo-auth');
    assert.ok(after.workspaces[opened.selection.workspace_id]);
    assert.ok(after.requests[requestEntry![0]]);
  });
});

test('working shared review accepts an unchanged tracked symlink and invalidates when its link text changes', async t => {
  const { root, stateDir } = await fixture(t, { phase: 'review', trackedSymlink: true });
  const first = await prepareOrJoinReview(prepareOptions(stateDir, 'codex', 'tracked-link-first'));
  assert.equal(first.generation.target_assurance, 'phase_only');
  assert.equal(first.participant.commit_binding, undefined);

  const link = path.join(root, 'src', 'tracked-link.txt');
  await rm(link);
  await symlink('symlink-target-b.txt', link);
  await expectCode(
    prepareOrJoinReview(prepareOptions(stateDir, 'claude', 'tracked-link-changed')),
    'TARGET_CHANGED'
  );
});

test('commit-pinned shared review binds base head scope workspace and trusted receipt while ignoring dirty checkout state', async t => {
  const { root, stateDir } = await fixture(t, { phase: 'review', extraCommit: true });
  await writeFile(path.join(root, 'src', 'share-target.txt'), 'dirty working bytes\n');
  await writeFile(path.join(root, 'src', 'unrelated-untracked.txt'), 'untracked\n');

  const options = prepareOptions(stateDir, 'codex', 'commit-pinned', {
    baseRef: 'HEAD^',
    headRef: 'HEAD',
    scopePrefix: 'src/'
  });
  const prepared = await prepareOrJoinReview(options);
  const binding = prepared.participant.commit_binding;
  assert.ok(binding);
  assert.equal(prepared.generation.target_assurance, 'commit_pinned');
  assert.equal(binding.assurance, 'commit_pinned');
  assert.equal(binding.scope_prefix, 'src/');
  assert.match(binding.base_commit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
  assert.match(binding.head_commit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
  assert.match(binding.candidate_digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(prepared.run.commit_binding, binding);
  assert.equal(prepared.run.branch, null);
  assert.equal(prepared.run.head, binding.head_commit);

  const opened = await openForParticipant(stateDir, prepared);
  assert.deepEqual(opened.selection.review_binding, binding);
  const openRetry = await openForParticipant(stateDir, prepared);
  assert.equal(openRetry.already_applied, true);
  assert.equal(openRetry.selection.workspace_id, opened.selection.workspace_id);

  const reconciled = await reconcileReviewParticipant({
    stateDir, taskId: 'task', participantId: prepared.participant.participant_id
  });
  assert.equal(reconciled.participant.workspace_association, 'bound');

  await assert.rejects(
    openWorkspace({
      stateDir,
      repositoryId: 'repo',
      taskId: 'task',
      mode: 'review',
      requestId: prepared.participant.workspace_request_id,
      ttlMs: prepared.participant.workspace_ttl_ms,
      baseRef: binding.requested_base_ref,
      headRef: binding.base_commit,
      scopePrefix: binding.scope_prefix
    }),
    /request_id.*different workspace arguments/i
  );

  const reserved = await reservePrepared(stateDir, prepared, options.sessionId);
  assert.equal(reserved.submission_authorized, true);
  await assert.rejects(
    markChatGptRunSubmitted({
      stateDir,
      runId: prepared.run.run_id,
      receipt: {
        ...submissionReceipt(reserved, options.sessionId, 'commit-pinned-submit-bad'),
        candidateDigest: '0'.repeat(64)
      },
      now: SUBMITTED
    }),
    /receipt does not match/i
  );
  const submitted = await markChatGptRunSubmitted({
    stateDir,
    runId: prepared.run.run_id,
    receipt: submissionReceipt(reserved, options.sessionId, 'commit-pinned-submit-good'),
    now: SUBMITTED
  });
  assert.equal(submitted.state, 'submitted');

  const retry = await prepareOrJoinReview(options);
  assert.equal(retry.already_applied, true);
  assert.equal(retry.participant.participant_id, prepared.participant.participant_id);
  assert.deepEqual(retry.participant.commit_binding, binding);
});

test('commit-pinned prepare on a stale task binding fails before creating a participant', async t => {
  const { root, stateDir } = await fixture(t, { phase: 'review', extraCommit: true });
  await writeFile(path.join(root, 'src', 'later.txt'), 'moves HEAD past the binding\n');
  await git(root, 'add', '--', 'src/later.txt');
  await git(root, 'commit', '-m', 'move HEAD');

  const options = prepareOptions(stateDir, 'claude', 'stale-pinned', { baseRef: 'HEAD~2', headRef: 'HEAD~1' });
  await assert.rejects(prepareOrJoinReview(options), /run task rebind/i);

  const store = await StateStore.open(stateDir);
  const journal = await store.read<any>(SHARE_PATH, SHARE_KIND);
  const live = (journal?.participants ?? []).filter((p: any) => p.state !== 'closed' && p.state !== 'invalidated');
  assert.deepEqual(live, []);
  const rebound = await rebindRegisteredTask({ stateDir, taskId: 'task' });
  assert.equal(rebound.task.binding_epoch, 2);
});

test('an exact retry that fails on a stale binding retires its missing-run participant', async t => {
  const { root, stateDir } = await fixture(t, { phase: 'review', extraCommit: true });
  const head = (await git(root, 'rev-parse', 'HEAD')).trim();
  const base = (await git(root, 'rev-parse', `${head}^`)).trim();
  const options = prepareOptions(stateDir, 'claude', 'stale-exact', { baseRef: base, headRef: head });
  const prepared = await prepareOrJoinReview(options);
  const participantId = prepared.participant.participant_id;

  const store = await StateStore.open(stateDir);
  const journal = await store.read<any>(SHARE_PATH, SHARE_KIND);
  journal.participants = journal.participants.map((p: any) => p.participant_id === participantId
    ? { ...p, state: 'initializing', run_id: '00000000-0000-4000-8000-000000000004' }
    : p);
  await store.write(SHARE_PATH, SHARE_KIND, journal);
  await writeFile(path.join(root, 'src', 'later.txt'), 'moves HEAD past the binding\n');
  await git(root, 'add', '--', 'src/later.txt');
  await git(root, 'commit', '-m', 'move HEAD');

  await assert.rejects(prepareOrJoinReview(options), /run task rebind/i);
  const retired = await store.read<any>(SHARE_PATH, SHARE_KIND);
  const participant = retired.participants.find((p: any) => p.participant_id === participantId)!;
  assert.equal(participant.state, 'invalidated');
  assert.equal(participant.workspace_association, 'proven-absent');
  const rebound = await rebindRegisteredTask({ stateDir, taskId: 'task' });
  assert.equal(rebound.task.binding_epoch, 2);
});

test('an orphan initializing participant with no run is recoverable while the task binding is stale', async t => {
  const { root, stateDir } = await fixture(t, { phase: 'review', extraCommit: true });
  const options = prepareOptions(stateDir, 'claude', 'orphan', { baseRef: 'HEAD^', headRef: 'HEAD' });
  const prepared = await prepareOrJoinReview(options);
  const participantId = prepared.participant.participant_id;

  // Reproduce the pre-fix failure: a participant left initializing whose run record never got written.
  const store = await StateStore.open(stateDir);
  const journal = await store.read<any>(SHARE_PATH, SHARE_KIND);
  journal.participants = journal.participants.map((p: any) => p.participant_id === participantId
    ? { ...p, state: 'initializing', run_id: '00000000-0000-4000-8000-000000000001' }
    : p);
  await store.write(SHARE_PATH, SHARE_KIND, journal);
  await writeFile(path.join(root, 'src', 'later.txt'), 'moves HEAD past the binding\n');
  await git(root, 'add', '--', 'src/later.txt');
  await git(root, 'commit', '-m', 'move HEAD');
  await assert.rejects(rebindRegisteredTask({ stateDir, taskId: 'task' }), /protected shared-review participants/);

  const recovered = await recoverReviewParticipant({ stateDir, taskId: 'task', participantId });
  assert.equal(recovered.participant.state, 'invalidated');
  assert.equal(recovered.participant.workspace_association, 'proven-absent');
  const gc = await garbageCollect({ stateDir, apply: false });
  assert.equal(gc.complete, true);
  const rebound = await rebindRegisteredTask({ stateDir, taskId: 'task' });
  assert.equal(rebound.task.binding_epoch, 2);
});

test('an invalidated participant with no run and a pending workspace no longer breaks recovery or gc', async t => {
  const { stateDir } = await fixture(t, { phase: 'review', extraCommit: true });
  const prepared = await prepareOrJoinReview(prepareOptions(stateDir, 'claude', 'retired', { baseRef: 'HEAD^', headRef: 'HEAD' }));
  const participantId = prepared.participant.participant_id;
  const store = await StateStore.open(stateDir);
  const journal = await store.read<any>(SHARE_PATH, SHARE_KIND);
  journal.participants = journal.participants.map((p: any) => p.participant_id === participantId
    ? { ...p, state: 'invalidated', run_id: '00000000-0000-4000-8000-000000000002' }
    : p);
  await store.write(SHARE_PATH, SHARE_KIND, journal);
  await assert.rejects(garbageCollect({ stateDir, apply: false }), /does not exist or is corrupt/);

  const recovered = await recoverReviewParticipant({ stateDir, taskId: 'task', participantId });
  assert.equal(recovered.participant.workspace_association, 'proven-absent');
  const gc = await garbageCollect({ stateDir, apply: false });
  assert.equal(gc.complete, true);
});

test('a missing-run participant is not retired when its workspace_open outcome exists', async t => {
  const { stateDir } = await fixture(t, { phase: 'review', extraCommit: true });
  const prepared = await prepareOrJoinReview(prepareOptions(stateDir, 'claude', 'opened', { baseRef: 'HEAD^', headRef: 'HEAD' }));
  const participantId = prepared.participant.participant_id;
  await openForParticipant(stateDir, prepared);
  const store = await StateStore.open(stateDir);
  const journal = await store.read<any>(SHARE_PATH, SHARE_KIND);
  journal.participants = journal.participants.map((p: any) => p.participant_id === participantId
    ? { ...p, state: 'initializing', run_id: '00000000-0000-4000-8000-000000000003' }
    : p);
  await store.write(SHARE_PATH, SHARE_KIND, journal);

  const recovered = await recoverReviewParticipant({ stateDir, taskId: 'task', participantId });
  assert.equal((recovered as any).recovery_required, true);
  assert.equal(recovered.participant.state, 'initializing');
  assert.equal(recovered.participant.workspace_association, 'pending');
});

test('commit-pinned target and trusted receipt ignore replacement-ref changes', async t => {
  const { root, stateDir } = await fixture(t, { phase: 'review', extraCommit: true });
  const target = 'src/share-target.txt';
  const head = (await git(root, 'rev-parse', 'HEAD')).trim();
  const base = (await git(root, 'rev-parse', `${head}^`)).trim();

  const replacementCommit = async (content: string, label: string) => {
    await git(root, 'reset', '--hard', base);
    await writeFile(path.join(root, target), content);
    await git(root, 'add', '--', target);
    await git(root, 'commit', '-m', label);
    const commit = (await git(root, 'rev-parse', 'HEAD')).trim();
    await git(root, 'reset', '--hard', head);
    return commit;
  };
  const replacementOne = await replacementCommit('replacement target one\n', 'replacement target one');
  const replacementTwo = await replacementCommit('replacement target two\n', 'replacement target two');

  await git(root, 'replace', head, replacementOne);
  assert.equal(await git(root, 'show', `${head}:${target}`), 'replacement target one\n');

  const options = prepareOptions(stateDir, 'codex', 'commit-replace-stable', {
    baseRef: base,
    headRef: head,
    scopePrefix: 'src/'
  });
  const prepared = await prepareOrJoinReview(options);
  const binding = prepared.participant.commit_binding;
  assert.ok(binding);
  const receipt = submissionReceipt(prepared.run, options.sessionId, 'commit-replace-stable-submit');

  await git(root, 'replace', '-f', head, replacementTwo);
  assert.equal(await git(root, 'show', `${head}:${target}`), 'replacement target two\n');

  const retry = await prepareOrJoinReview(options);
  assert.equal(retry.already_applied, true);
  assert.deepEqual(retry.participant.commit_binding, binding);
  assert.deepEqual(retry.run.commit_binding, binding);

  const reserved = await reservePrepared(stateDir, prepared, options.sessionId);
  assert.equal(reserved.submission_authorized, true);
  const submitted = await markChatGptRunSubmitted({
    stateDir,
    runId: prepared.run.run_id,
    receipt,
    now: SUBMITTED
  });
  assert.equal(submitted.state, 'submitted');
});

test('commit-pinned reconciliation rejects a workspace opened with a different bound scope', async t => {
  const { stateDir } = await fixture(t, { phase: 'review', extraCommit: true });
  const options = prepareOptions(stateDir, 'codex', 'commit-reconcile-mismatch', {
    baseRef: 'HEAD^',
    headRef: 'HEAD',
    scopePrefix: 'src/'
  });
  const prepared = await prepareOrJoinReview(options);
  const binding = prepared.participant.commit_binding;
  assert.ok(binding);

  await openWorkspace({
    stateDir,
    repositoryId: 'repo',
    taskId: 'task',
    mode: 'review',
    requestId: prepared.participant.workspace_request_id,
    ttlMs: prepared.participant.workspace_ttl_ms,
    baseRef: binding.requested_base_ref,
    headRef: binding.requested_head_ref,
    scopePrefix: 'test/'
  });
  await expectCode(
    reconcileReviewParticipant({
      stateDir, taskId: 'task', participantId: prepared.participant.participant_id
    }),
    'WORKSPACE_RECONCILIATION_MISMATCH'
  );
});

test('sanitized review status exposes counts/provenance but no bearer secrets or raw browser/prompt data', async t => {
  const { stateDir } = await fixture(t, { phase: 'review' });
  const options = prepareOptions(stateDir, 'codex', 'sanitized-status');
  const prepared = await prepareOrJoinReview(options);
  const opened = await openForParticipant(stateDir, prepared);
  await reconcileReviewParticipant({
    stateDir, taskId: 'task', participantId: prepared.participant.participant_id
  });
  const status = await reviewShareStatus({ stateDir, taskId: 'task' });

  assert.equal(typeof status.coding_owner?.status, 'string');
  assert.equal(typeof status.coding_owner?.provenance, 'string');
  const participantCountKeys = ['active', 'prepared', 'reserved', 'submitted', 'uncertain', 'stale'] as const;
  for (const key of participantCountKeys) {
    assert.equal(typeof status.participant_counts?.[key], 'number');
  }
  assert.ok(Array.isArray(status.conflict_hints));

  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes(opened.workspace_token));
  assert.ok(!serialized.includes(options.sessionId));
  assert.ok(!serialized.includes(options.prompt));
  assert.ok(!serialized.includes(options.workspaceRequestId), 'status exposes counts, not raw workspace request IDs');
});

test('a pending commit-pinned review participant does not block authorization GC', async t => {
  const { stateDir } = await fixture(t, { phase: 'review', extraCommit: true });
  const options = prepareOptions(stateDir, 'codex', 'pinned-gc', { baseRef: 'HEAD^', headRef: 'HEAD', scopePrefix: 'src/' });
  const prepared = await prepareOrJoinReview(options);
  assert.ok(prepared.participant.commit_binding);
  const opened = await openForParticipant(stateDir, prepared);
  assert.equal(prepared.participant.workspace_association, 'pending');
  const result = await garbageCollect({
    stateDir, apply: true, authRetentionHours: 1, captureRetentionHours: 0, taskRetentionDays: 1,
    nowMs: Date.parse(opened.selection.expires_at) + 2 * 60 * 60_000
  });
  assert.equal(result.mode, 'apply');
  const auth = await (await StateStore.open(stateDir)).read<any>('control/multirepo-auth.json', 'multirepo-auth');
  assert.ok(auth.workspaces[opened.selection.workspace_id], 'the pending pinned workspace is protected, not a GC failure');
  const reconciled = await reconcileReviewParticipant({ stateDir, taskId: 'task', participantId: prepared.participant.participant_id });
  assert.equal(reconciled.participant.workspace_association, 'bound');
});
