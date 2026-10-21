import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { prepareFixture } from '../src/fixture.js';
import { migrateV1 } from '../src/policy.js';
import { defaultPolicy } from '../src/repo.js';
import {
  authorizeWorkspace,
  bindRegisteredTask,
  issueWorkspaceGrant,
  openWorkspace,
  readMultiRepoCatalog,
  rebindRegisteredTask,
  registerRepository,
  setRegisteredTaskPhase,
  setRepositorySurfacePolicy
} from '../src/multirepo-state.js';
import {
  chatGptRunOutput,
  chatGptRunStatus,
  completeChatGptRun,
  failChatGptRunBeforeSubmit,
  markChatGptRunSubmitted,
  markChatGptRunUncertain,
  prepareChatGptRun as prepareChatGptRunImpl,
  recoverChatGptRunLock,
  recoverChatGptRequestClaim,
  recoverChatGptRun,
  reserveChatGptRun,
  type TrustedChatGptCompletionReceipt,
  type TrustedChatGptRunReceipt
} from '../src/chatgpt-run.js';
import { recordTrustedBrowserObservation } from '../src/model-policy.js';
import { git } from './helpers.js';
import { PROJECT_BASE } from '../src/version.js';
import { sha256 } from '../src/errors.js';
import { StateStore } from '../src/task-state.js';
import { recoverTaskStaleLocks } from '../src/task.js';
import { prepareOrJoinReview, reconcileReviewParticipant } from '../src/review-share.js';

const NOW = new Date('2026-10-07T20:00:00.000Z');
const OBSERVED = new Date('2026-10-07T20:00:03.000Z');

// Stage 1 contract inventory: existing tests that intentionally exercise Work remain
// explicit Work coverage. Supply the now-required test-only override reason without changing
// their original assertions.
type PrepareChatGptRunOptions = Parameters<typeof prepareChatGptRunImpl>[0] & {
  surfaceOverrideReason?: string;
};
function prepareChatGptRun(options: PrepareChatGptRunOptions) {
  const explicit = options.surface === 'work' && options.surfaceOverrideReason === undefined
    ? { ...options, surfaceOverrideReason: 'existing explicit Work regression coverage' }
    : options;
  return prepareChatGptRunImpl(explicit as Parameters<typeof prepareChatGptRunImpl>[0]);
}

function runNpm(script: 'coord' | 'chatgpt-run', args: string[], stateDir?: string) {
  return spawnSync('npm', ['run', '--silent', script, '--', ...args], {
    cwd: PROJECT_BASE,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...(stateDir ? { REPO_MCP_STATE_DIR: stateDir } : {}) }
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

async function chatGptArtifactInventory(stateDir: string) {
  const store = await StateStore.open(stateDir);
  return {
    runs: (await store.list('chatgpt-runs')).sort(),
    requests: (await store.list('chatgpt-run-requests')).sort(),
    authorizations: (await store.list('chatgpt-run-authorizations')).sort(),
    selections: (await store.list('model-policy/requests')).sort(),
    observations: (await store.list('model-policy/observations')).sort(),
    consumed: (await store.list('model-policy/consumed')).sort()
  };
}

async function fixture(t: { after(fn: () => Promise<void>): void }, phase: 'coding' | 'review' = 'review') {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-chatgpt-run-')));
  const root = path.join(base, 'repo');
  const stateDir = path.join(base, 'state');
  await prepareFixture(root);
  const policyPath = path.join(base, 'policy.json');
  await writeFile(policyPath, JSON.stringify(migrateV1(defaultPolicy)));
  await registerRepository({ stateDir, repositoryId: 'repo', root, policyPath });
  await bindRegisteredTask({ stateDir, repositoryId: 'repo', taskId: 'task' });
  if (phase === 'review') await setRegisteredTaskPhase({ stateDir, taskId: 'task', phase: 'review' });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, root, stateDir };
}

async function observedSelection(stateDir: string, selection: Awaited<ReturnType<typeof prepareChatGptRun>>['selection']) {
  return recordTrustedBrowserObservation({
    selectionId: selection.selection_id,
    surface: 'work',
    controlLabel: selection.profile === 'review-critical' || selection.profile === 'architecture'
      ? 'Pro'
      : 'Extra High',
    selectedAt: '2026-10-07T20:00:01.000Z',
    observedAt: '2026-10-07T20:00:02.000Z',
    conversationId: 'conversation-1'
  }, { stateDir: path.join(stateDir, 'model-policy'), now: OBSERVED });
}

function receipt(run: Awaited<ReturnType<typeof prepareChatGptRun>>, event: string, observedAt = OBSERVED.toISOString()): TrustedChatGptRunReceipt {
  return {
    repositoryId: run.repository_id, taskId: run.task_id, promptSha256: run.prompt_sha256,
    baseCommit: run.resolved_base_commit, browserEventId: event, observedAt, conversationId: 'conversation-1'
  };
}

function completionReceipt(run: Awaited<ReturnType<typeof prepareChatGptRun>>, event: string, submittedEvent: string, output: string): TrustedChatGptCompletionReceipt {
  return { ...receipt(run, event), kind: 'completion', responseState: 'completed',
    submissionEventSha256: sha256(`browser-event\0${submittedEvent}`), outputSha256: sha256(output) };
}

test('ChatGPT run binds candidate and stores hashes instead of prompt or raw browser identity', async t => {
  const { root, stateDir } = await fixture(t);
  await writeFile(path.join(root, 'second.txt'), 'second\n');
  await git(root, 'add', 'second.txt');
  await git(root, 'commit', '-m', 'second');
  // The task binding must name the candidate that will be sent for review.
  await rebindRegisteredTask({ stateDir, taskId: 'task' });
  const prompt = 'Review the frozen candidate using Repo MCP.';
  const run = await prepareChatGptRun({
    stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'claude', workKind: 'review',
    surface: 'work', conversationId: 'conversation-1', prompt, baseRef: 'HEAD^', now: NOW,
    runId: '11111111-1111-4111-8111-111111111111', selectionId: '22222222-2222-4222-8222-222222222222'
  });
  assert.equal(run.execution_surface, 'ChatGPT web');
  assert.equal(run.coordinator, 'claude');
  assert.equal(run.profile, 'review');
  assert.equal(run.requested_base_ref, 'HEAD^');
  assert.match(run.resolved_base_commit, /^[a-f0-9]{40}$/);
  const serialized = await readFile(path.join(stateDir, 'chatgpt-runs', `${run.run_id}.json`), 'utf8');
  assert.equal(serialized.includes(prompt), false);
  assert.equal(serialized.includes('conversation-1'), false);
});

test('verified model selection reserves once and completion stores only output hash', async t => {
  const { stateDir } = await fixture(t);
  const run = await prepareChatGptRun({
    stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex', workKind: 'review',
    surface: 'work', conversationId: 'conversation-1', prompt: 'Review.', now: NOW
  });
  const evidence = await observedSelection(stateDir, run.selection);
  const reserved = await reserveChatGptRun({ stateDir, runId: run.run_id, contract: run.selection, evidence, now: OBSERVED });
  assert.equal(reserved.state, 'submission-reserved');
  assert.equal(reserved.submission_authorized, true);
  const replay = await reserveChatGptRun({ stateDir, runId: run.run_id, contract: run.selection, evidence, now: OBSERVED });
  assert.equal(replay.submission_authorized, false);
  const submittedReceipt = receipt(run, 'submission-1');
  assert.equal((await markChatGptRunSubmitted({ runId: run.run_id, stateDir, receipt: submittedReceipt, now: OBSERVED })).state, 'submitted');
  assert.equal((await markChatGptRunSubmitted({ runId: run.run_id, stateDir, receipt: submittedReceipt, now: OBSERVED })).state, 'submitted');
  const output = 'SHIP: no findings.';
  await assert.rejects(chatGptRunOutput(run.run_id, stateDir), /only a completed run has a saved output/);
  const completedReceipt = completionReceipt(run, 'completion-1', 'submission-1', output);
  const completed = await completeChatGptRun({ stateDir, runId: run.run_id, output, outcome: 'ship', receipt: completedReceipt, now: OBSERVED });
  assert.equal(completed.state, 'completed');
  assert.equal((await completeChatGptRun({ stateDir, runId: run.run_id, output, outcome: 'ship', receipt: completedReceipt, now: OBSERVED })).state, 'completed');
  await assert.rejects(
    completeChatGptRun({ stateDir, runId: run.run_id, output: 'different', outcome: 'ship', receipt: completedReceipt, now: OBSERVED }),
    /output digest|different output or outcome/i
  );
  assert.match(completed.output_sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(completed).includes(output), false);
  assert.equal(await chatGptRunOutput(run.run_id, stateDir), output);
  const savedPath = path.join(stateDir, 'chatgpt-run-outputs', `${run.run_id}.json`);
  assert.equal((await stat(savedPath)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(savedPath, 'utf8'));
  saved.data.output = 'tampered';
  await writeFile(savedPath, JSON.stringify(saved));
  await assert.rejects(chatGptRunOutput(run.run_id, stateDir), /does not match the run record/);
  await rm(savedPath);
  await assert.rejects(chatGptRunOutput(run.run_id, stateDir), /No saved output/);
  // Repeating the same completion restores a missing saved output.
  await completeChatGptRun({ stateDir, runId: run.run_id, output, outcome: 'ship', receipt: completedReceipt, now: OBSERVED });
  assert.equal(await chatGptRunOutput(run.run_id, stateDir), output);
});

test('capability-only Pro architecture profile completes one durable Chat run', async t => {
  const { stateDir } = await fixture(t, 'coding');
  const run = await prepareChatGptRun({
    stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex', workKind: 'architecture',
    profile: 'architecture-current-pro', surface: 'chat', conversationId: 'conversation-1',
    prompt: 'Read-only architecture review.', now: NOW
  });
  assert.equal(run.selection.expected_model_label, null);
  assert.equal(run.selection.expected_target_label, 'Pro');
  const evidence = await recordTrustedBrowserObservation({
    selectionId: run.selection.selection_id, surface: 'chat', modelLabel: 'GPT-9 Nova', controlLabel: 'Pro',
    selectedAt: '2026-10-07T20:00:01.000Z', observedAt: '2026-10-07T20:00:02.000Z',
    conversationId: 'conversation-1'
  }, { stateDir: path.join(stateDir, 'model-policy'), now: OBSERVED });
  const reserved = await reserveChatGptRun({ stateDir, runId: run.run_id, contract: run.selection, evidence, now: OBSERVED });
  assert.equal(reserved.submission_authorized, true);
  assert.equal((await markChatGptRunSubmitted({
    stateDir, runId: run.run_id, receipt: receipt(run, 'current-pro-submit'), now: OBSERVED
  })).state, 'submitted');
  const output = 'Architecture review complete.';
  const completed = await completeChatGptRun({
    stateDir, runId: run.run_id, output, outcome: 'completed',
    receipt: completionReceipt(run, 'current-pro-complete', 'current-pro-submit', output), now: OBSERVED
  });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.profile, 'architecture-current-pro');
});

test('pre-capability Sol-bound durable runs remain readable and reservable', async t => {
  const { stateDir } = await fixture(t);
  const run = await prepareChatGptRun({
    stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex', workKind: 'review',
    profile: 'review', surface: 'chat', conversationId: 'conversation-1',
    prompt: 'Review with a historical contract.', now: NOW
  });
  const legacySelection = { ...run.selection, expected_model_label: 'Sol' as const };
  const legacyRun = { ...run, selection: legacySelection };
  const runStore = await StateStore.open(stateDir);
  await runStore.write(`chatgpt-runs/${run.run_id}.json`, 'chatgpt-run-v1', legacyRun);
  const policyStore = await StateStore.open(path.join(stateDir, 'model-policy'));
  await policyStore.write(
    `requests/${run.selection.selection_id}.json`, 'model-policy-request-v2', legacySelection
  );

  assert.equal((await chatGptRunStatus(run.run_id, stateDir)).selection.expected_model_label, 'Sol');
  const evidence = await recordTrustedBrowserObservation({
    selectionId: run.selection.selection_id, surface: 'chat', modelLabel: 'GPT-6',
    controlLabel: 'Extra High', selectedAt: '2026-10-07T20:00:01.000Z',
    observedAt: '2026-10-07T20:00:02.000Z', conversationId: 'conversation-1'
  }, { stateDir: path.join(stateDir, 'model-policy'), now: OBSERVED });
  const reserved = await reserveChatGptRun({
    stateDir, runId: run.run_id, contract: legacySelection, evidence, now: OBSERVED
  });
  assert.equal(reserved.submission_authorized, true);
});

test('candidate drift blocks reservation before browser submission', async t => {
  const { root, stateDir } = await fixture(t);
  const run = await prepareChatGptRun({
    stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex', workKind: 'review',
    surface: 'work', conversationId: 'conversation-1', prompt: 'Review.', now: NOW
  });
  const evidence = await observedSelection(stateDir, run.selection);
  await writeFile(path.join(root, 'drift.txt'), 'drift\n');
  await git(root, 'add', 'drift.txt');
  await git(root, 'commit', '-m', 'drift');
  await assert.rejects(
    reserveChatGptRun({ stateDir, runId: run.run_id, contract: run.selection, evidence, now: OBSERVED }),
    /candidate changed/i
  );
  assert.equal((await chatGptRunStatus(run.run_id, stateDir)).state, 'prepared');
});

test('Claude can prepare coding work and uncertain runs cannot be resubmitted', async t => {
  const coding = await fixture(t, 'coding');
  const claudeCode = await prepareChatGptRun({
    stateDir: coding.stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'claude', workKind: 'code',
    surface: 'chat', conversationId: 'conversation-1', prompt: 'Code.', now: NOW
  });
  assert.equal(claudeCode.execution_surface, 'ChatGPT web');
  assert.equal(claudeCode.coordinator, 'claude');
  assert.equal(claudeCode.work_kind, 'code');
  assert.equal((await chatGptRunStatus(claudeCode.run_id, coding.stateDir)).state, 'prepared', 'a stored Claude coding run is valid');

  const review = await fixture(t, 'review');
  const run = await prepareChatGptRun({
    stateDir: review.stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex', workKind: 'review',
    surface: 'work', conversationId: 'conversation-1', prompt: 'Review.', now: NOW
  });
  const evidence = await observedSelection(review.stateDir, run.selection);
  await reserveChatGptRun({ stateDir: review.stateDir, runId: run.run_id, contract: run.selection, evidence, now: OBSERVED });
  assert.equal((await markChatGptRunUncertain(run.run_id, 'BROWSER_DISCONNECTED', review.stateDir, OBSERVED)).state, 'uncertain');
  await assert.rejects(
    reserveChatGptRun({ stateDir: review.stateDir, runId: run.run_id, contract: run.selection, evidence, now: OBSERVED }),
    /cannot be reserved from state uncertain/i
  );
  assert.equal((await recoverChatGptRun(run.run_id, 'submitted', receipt(run, 'recovery-1'), review.stateDir, OBSERVED)).state, 'submitted');
});

test('public ChatGPT run CLI prepares from a regular prompt and refuses a symlink prompt', async t => {
  const { base, stateDir } = await fixture(t);
  const prompt = path.join(base, 'prompt.txt');
  const linked = path.join(base, 'linked-prompt.txt');
  await writeFile(prompt, 'Review through Repo MCP.\n');
  await symlink(prompt, linked);
  const args = (file: string) => ['run', '--silent', 'chatgpt-run', '--', 'prepare',
    '--state-dir', stateDir, '--repository', 'repo', '--task', 'task', '--coordinator', 'claude',
    '--kind', 'review', '--surface', 'work', '--surface-override-reason', 'existing explicit Work CLI regression',
    '--conversation-id', 'conversation-cli', '--prompt-file', file];
  const ok = spawnSync('npm', args(prompt), { cwd: PROJECT_BASE, encoding: 'utf8', timeout: 30_000 });
  assert.equal(ok.status, 0, ok.stderr);
  const prepared = JSON.parse(ok.stdout);
  assert.equal(prepared.execution_surface, 'ChatGPT web');
  const contractFile = path.join(base, 'prepared.json');
  const evidenceFile = path.join(base, 'evidence.json');
  await writeFile(contractFile, ok.stdout);
  const selectedAt = prepared.selection.requested_at;
  const observedAt = new Date().toISOString();
  const observed = spawnSync('npm', ['run', '--silent', 'chatgpt-run', '--', 'observe',
    '--state-dir', stateDir, '--selection-id', prepared.selection.selection_id, '--surface', 'work',
    '--conversation-id', 'conversation-cli', '--control-label', 'Extra High',
    '--selected-at', selectedAt, '--observed-at', observedAt],
  { cwd: PROJECT_BASE, encoding: 'utf8', timeout: 30_000 });
  assert.equal(observed.status, 0, observed.stderr);
  await writeFile(evidenceFile, observed.stdout);
  const reserved = spawnSync('npm', ['run', '--silent', 'chatgpt-run', '--', 'reserve',
    '--state-dir', stateDir, '--run', prepared.run_id, '--contract-file', contractFile,
    '--evidence-file', evidenceFile], { cwd: PROJECT_BASE, encoding: 'utf8', timeout: 30_000 });
  assert.equal(reserved.status, 0, reserved.stderr);
  assert.equal(JSON.parse(reserved.stdout).state, 'submission-reserved');
  const receiptArgs = (event: string) => [
    '--state-dir', stateDir, '--run', prepared.run_id, '--repository', 'repo', '--task', 'task',
    '--prompt-sha256', prepared.prompt_sha256, '--base-commit', prepared.resolved_base_commit,
    '--conversation-id', 'conversation-cli', '--browser-event-id', event, '--observed-at', new Date().toISOString()
  ];
  const submitted = spawnSync('npm', ['run', '--silent', 'chatgpt-run', '--', 'submitted', ...receiptArgs('submit-cli')],
    { cwd: PROJECT_BASE, encoding: 'utf8', timeout: 30_000 });
  assert.equal(submitted.status, 0, submitted.stderr);
  assert.equal(JSON.parse(submitted.stdout).state, 'submitted');
  const output = path.join(base, 'output.txt');
  await writeFile(output, 'SHIP\n');
  const completed = spawnSync('npm', ['run', '--silent', 'chatgpt-run', '--', 'complete', ...receiptArgs('complete-cli'),
    '--output-file', output, '--outcome', 'ship', '--submission-event-sha256',
    sha256('browser-event\0submit-cli'), '--output-sha256', sha256('SHIP\n'), '--response-state', 'completed'], { cwd: PROJECT_BASE, encoding: 'utf8', timeout: 30_000 });
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).state, 'completed');
  const printed = spawnSync('npm', ['run', '--silent', 'chatgpt-run', '--', 'output', '--state-dir', stateDir, '--run', prepared.run_id],
    { cwd: PROJECT_BASE, encoding: 'utf8', timeout: 30_000 });
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout, 'SHIP\n');
  const refused = spawnSync('npm', args(linked), { cwd: PROJECT_BASE, encoding: 'utf8', timeout: 30_000 });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /symlink|symbolic link|ELOOP/i);
  const fifo = path.join(base, 'prompt.fifo');
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const fifoRefused = spawnSync('npm', args(fifo), { cwd: PROJECT_BASE, encoding: 'utf8', timeout: 5_000 });
  assert.equal(fifoRefused.status, 1);
  assert.match(fifoRefused.stderr, /regular non-symlink file/i);
  const invalid = path.join(base, 'invalid.txt');
  await writeFile(invalid, Buffer.from([0xff, 0xfe]));
  const invalidRefused = spawnSync('npm', args(invalid), { cwd: PROJECT_BASE, encoding: 'utf8', timeout: 5_000 });
  assert.equal(invalidRefused.status, 1);
  assert.match(invalidRefused.stderr, /valid UTF-8/i);
});

test('public ChatGPT run CLI carries commit-bound receipts through submit complete and recovery', async t => {
  const { base, root, stateDir } = await fixture(t);
  await writeFile(path.join(root, 'src/clamp.js'), 'export function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }\n// pinned CLI head\n');
  await git(root, 'add', '--', 'src/clamp.js');
  await git(root, 'commit', '-m', 'commit-bound CLI receipt fixture');
  await rebindRegisteredTask({ stateDir, taskId: 'task' });

  const preparePinned = async (label: string) => {
    const sessionId = `session-${label}`;
    const prepared = await prepareOrJoinReview({
      stateDir,
      repositoryId: 'repo',
      coordinator: 'codex',
      profile: 'review',
      surface: 'chat',
      sessionId,
      workspaceRequestId: `open-${label}`,
      prompt: `Review commit-bound CLI receipt ${label}.\n`,
      baseRef: 'HEAD^',
      headRef: 'HEAD',
      scopePrefix: 'src/',
      ttlSeconds: 300,
      now: new Date()
    });
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
      scopePrefix: binding.scope_prefix
    });
    await reconcileReviewParticipant({
      stateDir,
      taskId: 'task',
      participantId: prepared.participant.participant_id
    });

    const contractFile = path.join(base, `${label}-prepared.json`);
    const evidenceFile = path.join(base, `${label}-evidence.json`);
    await writeFile(contractFile, JSON.stringify(prepared.run));
    const observed = runNpm('chatgpt-run', [
      'observe',
      '--state-dir', stateDir,
      '--selection-id', prepared.run.selection.selection_id,
      '--surface', 'chat',
      '--session-id', sessionId,
      '--control-label', 'Extra High',
      '--model-label', 'Sol',
      '--selected-at', prepared.run.selection.requested_at,
      '--observed-at', new Date().toISOString()
    ], stateDir);
    assert.equal(observed.status, 0, observed.stderr);
    await writeFile(evidenceFile, observed.stdout);
    const reserved = runNpm('chatgpt-run', [
      'reserve',
      '--state-dir', stateDir,
      '--run', prepared.run.run_id,
      '--contract-file', contractFile,
      '--evidence-file', evidenceFile
    ], stateDir);
    assert.equal(reserved.status, 0, reserved.stderr);
    assert.equal(JSON.parse(reserved.stdout).state, 'submission-reserved');
    return { prepared, binding, sessionId };
  };

  const receiptArgs = (
    prepared: Awaited<ReturnType<typeof prepareOrJoinReview>>,
    sessionId: string,
    event: string,
    binding: { head_commit: string; candidate_digest: string },
    mode: 'valid' | 'missing' | 'mismatch' = 'valid'
  ) => {
    const args = [
      '--state-dir', stateDir,
      '--run', prepared.run.run_id,
      '--repository', 'repo',
      '--task', 'task',
      '--prompt-sha256', prepared.run.prompt_sha256,
      '--base-commit', prepared.run.resolved_base_commit,
      '--session-id', sessionId,
      '--browser-event-id', event,
      '--observed-at', new Date().toISOString()
    ];
    if (mode !== 'missing') {
      args.push(
        '--head-commit', binding.head_commit,
        '--candidate-digest', mode === 'mismatch' ? '0'.repeat(64) : binding.candidate_digest
      );
    }
    return args;
  };

  const completedRun = await preparePinned('cli-bound-complete');
  const strict = runNpm('chatgpt-run', [
    'status',
    '--state-dir', stateDir,
    '--run', completedRun.prepared.run.run_id,
    '--head-commit', completedRun.binding.head_commit,
    '--candidate-digest', completedRun.binding.candidate_digest
  ], stateDir);
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /--head-commit is not valid for chatgpt-run status/i);

  const missingSubmit = runNpm('chatgpt-run', [
    'submitted',
    ...receiptArgs(
      completedRun.prepared, completedRun.sessionId, 'cli-bound-submit-missing',
      completedRun.binding, 'missing'
    )
  ], stateDir);
  assert.equal(missingSubmit.status, 1);
  assert.match(missingSubmit.stderr, /receipt does not match/i);

  const submitEvent = 'cli-bound-submit';
  const submitted = runNpm('chatgpt-run', [
    'submitted',
    ...receiptArgs(completedRun.prepared, completedRun.sessionId, submitEvent, completedRun.binding)
  ], stateDir);
  assert.equal(submitted.status, 0, submitted.stderr);
  assert.equal(JSON.parse(submitted.stdout).state, 'submitted');

  const output = 'SHIP: commit-bound CLI receipt accepted.\n';
  const outputFile = path.join(base, 'cli-bound-output.txt');
  await writeFile(outputFile, output);
  const completionTail = [
    '--output-file', outputFile,
    '--outcome', 'ship',
    '--submission-event-sha256', sha256(`browser-event\0${submitEvent}`),
    '--output-sha256', sha256(output),
    '--response-state', 'completed'
  ];
  const mismatchedComplete = runNpm('chatgpt-run', [
    'complete',
    ...receiptArgs(
      completedRun.prepared, completedRun.sessionId, 'cli-bound-complete-bad',
      completedRun.binding, 'mismatch'
    ),
    ...completionTail
  ], stateDir);
  assert.equal(mismatchedComplete.status, 1);
  assert.match(mismatchedComplete.stderr, /receipt does not match/i);

  const completed = runNpm('chatgpt-run', [
    'complete',
    ...receiptArgs(
      completedRun.prepared, completedRun.sessionId, 'cli-bound-complete',
      completedRun.binding
    ),
    ...completionTail
  ], stateDir);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).state, 'completed');

  const recoveredRun = await preparePinned('cli-bound-recover');
  const recoveredSubmit = runNpm('chatgpt-run', [
    'submitted',
    ...receiptArgs(
      recoveredRun.prepared, recoveredRun.sessionId, 'cli-bound-recover-submit',
      recoveredRun.binding
    )
  ], stateDir);
  assert.equal(recoveredSubmit.status, 0, recoveredSubmit.stderr);
  assert.equal(JSON.parse(recoveredSubmit.stdout).state, 'submitted');

  const uncertain = runNpm('chatgpt-run', [
    'uncertain',
    '--state-dir', stateDir,
    '--run', recoveredRun.prepared.run.run_id,
    '--failure-code', 'BROWSER_DISCONNECTED'
  ], stateDir);
  assert.equal(uncertain.status, 0, uncertain.stderr);
  assert.equal(JSON.parse(uncertain.stdout).state, 'uncertain');

  const missingRecover = runNpm('chatgpt-run', [
    'recover',
    '--resolution', 'submitted',
    ...receiptArgs(
      recoveredRun.prepared, recoveredRun.sessionId, 'cli-bound-recover-missing',
      recoveredRun.binding, 'missing'
    )
  ], stateDir);
  assert.equal(missingRecover.status, 1);
  assert.match(missingRecover.stderr, /receipt does not match/i);

  const recovered = runNpm('chatgpt-run', [
    'recover',
    '--resolution', 'submitted',
    ...receiptArgs(
      recoveredRun.prepared, recoveredRun.sessionId, 'cli-bound-recover',
      recoveredRun.binding
    )
  ], stateDir);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).state, 'submitted');
});

test('Stage 1 new ChatGPT preparations default code, code-hard, review and architecture to Chat', async t => {
  const cases = [
    { name: 'code', kind: 'code', profile: undefined, phase: 'coding' as const, expectedTarget: 'High' },
    { name: 'code-hard', kind: 'code', profile: 'code-hard', phase: 'coding' as const, expectedTarget: 'Extra High' },
    { name: 'review', kind: 'review', profile: undefined, phase: 'review' as const, expectedTarget: 'Extra High' },
    { name: 'architecture', kind: 'architecture', profile: undefined, phase: 'coding' as const, expectedTarget: 'Pro' }
  ];

  for (const item of cases) {
    await t.test(item.name, async st => {
      const { base, stateDir } = await fixture(st, item.phase);
      const prompt = path.join(base, `${item.name}-prompt.txt`);
      await writeFile(prompt, `${item.name} through Chat.\n`);
      const args = [
        'prepare', '--state-dir', stateDir, '--repository', 'repo', '--task', 'task',
        '--coordinator', 'codex', '--kind', item.kind,
        '--session-id', `session-${item.name}`, '--prompt-file', prompt
      ];
      if (item.profile) args.push('--profile', item.profile);
      const result = runNpm('chatgpt-run', args, stateDir);
      assert.equal(result.status, 0, result.stderr);
      const prepared = JSON.parse(result.stdout);
      assert.equal(prepared.selection.surface, 'chat');
      assert.equal(prepared.selection.expected_target_label, item.expectedTarget);
    });
  }
});

test('Stage 1 repository surface-policy is epoch-bound, idempotent, and invalidates older authority', async t => {
  const { stateDir } = await fixture(t, 'coding');
  const before = await readMultiRepoCatalog(stateDir);
  const beforeRepository = before.repositories.repo as typeof before.repositories.repo & { surface_policy?: string };
  assert.equal(beforeRepository.surface_policy ?? 'default', 'default');

  const oldGrant = await issueWorkspaceGrant({ stateDir, taskId: 'task' });
  const oldInspect = await openWorkspace({
    stateDir, repositoryId: 'repo', taskId: 'task', mode: 'inspect', requestId: 'surface-policy-old-inspect'
  });

  const changed = runNpm('coord', [
    'repository', 'surface-policy', '--state-dir', stateDir,
    '--repository', 'repo', '--mode', 'chat-only'
  ], stateDir);
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(JSON.parse(changed.stdout).unchanged, false);

  const after = await readMultiRepoCatalog(stateDir);
  const afterRepository = after.repositories.repo as typeof after.repositories.repo & { surface_policy?: string };
  assert.equal(afterRepository.surface_policy, 'chat-only');
  assert.equal(afterRepository.registration_epoch, beforeRepository.registration_epoch + 1);

  await assert.rejects(
    authorizeWorkspace(stateDir, oldInspect.workspace_token, 'read'),
    /stale|authorization changed|registration/i
  );
  await assert.rejects(
    openWorkspace({
      stateDir, repositoryId: 'repo', taskId: 'task', mode: 'code',
      requestId: 'surface-policy-stale-grant', writeGrant: oldGrant.write_grant
    }),
    /grant|stale|authorization/i
  );

  const same = runNpm('coord', [
    'repository', 'surface-policy', '--state-dir', stateDir,
    '--repository', 'repo', '--mode', 'chat-only'
  ], stateDir);
  assert.equal(same.status, 0, same.stderr);
  assert.equal(JSON.parse(same.stdout).unchanged, true);
  const unchanged = await readMultiRepoCatalog(stateDir);
  const unchangedRepository = unchanged.repositories.repo as typeof unchanged.repositories.repo & { surface_policy?: string };
  assert.equal(unchangedRepository.surface_policy, 'chat-only');
  assert.equal(unchangedRepository.registration_epoch, afterRepository.registration_epoch);
});

test('Stage 1 legacy repository registrations normalize missing surface policy to default', async t => {
  const { stateDir } = await fixture(t, 'coding');
  const store = await StateStore.open(stateDir);
  const raw = await store.read<any>('control/multirepo-catalog.json', 'multirepo-catalog');
  assert.ok(raw?.repositories?.repo);
  delete raw.repositories.repo.surface_policy;
  await store.write('control/multirepo-catalog.json', 'multirepo-catalog', raw);

  const normalized = await readMultiRepoCatalog(stateDir);
  const repository = normalized.repositories.repo as typeof normalized.repositories.repo & { surface_policy?: string };
  assert.equal(repository.surface_policy, 'default');
});

test('Stage 1 default repositories reject Work without an override reason before run state exists', async t => {
  const { base, stateDir } = await fixture(t, 'review');
  const prompt = path.join(base, 'work-without-reason.txt');
  await writeFile(prompt, 'Review on Work without a reason.\n');
  const before = await chatGptArtifactInventory(stateDir);

  const result = runNpm('chatgpt-run', [
    'prepare', '--state-dir', stateDir, '--repository', 'repo', '--task', 'task',
    '--coordinator', 'codex', '--kind', 'review', '--surface', 'work',
    '--session-id', 'session-work-no-reason', '--prompt-file', prompt
  ], stateDir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /surface.*override.*reason|override reason/i);
  assert.deepEqual(await chatGptArtifactInventory(stateDir), before);
});

test('Stage 1 Work override reason and surface-policy enum fail closed on invalid input', async t => {
  const { base, stateDir } = await fixture(t, 'review');
  const prompt = path.join(base, 'invalid-work-reason.txt');
  await writeFile(prompt, 'Invalid Work override.\n');
  const before = await chatGptArtifactInventory(stateDir);

  for (const reason of ['bad\nreason', 'x'.repeat(513)]) {
    const result = runNpm('chatgpt-run', [
      'prepare', '--state-dir', stateDir, '--repository', 'repo', '--task', 'task',
      '--coordinator', 'codex', '--kind', 'review', '--surface', 'work',
      '--surface-override-reason', reason,
      '--session-id', 'session-invalid-work-reason', '--prompt-file', prompt
    ], stateDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /override reason|control-free|512/i);
    assert.deepEqual(await chatGptArtifactInventory(stateDir), before);
  }

  const badMode = runNpm('coord', [
    'repository', 'surface-policy', '--state-dir', stateDir,
    '--repository', 'repo', '--mode', 'work'
  ], stateDir);
  assert.equal(badMode.status, 1);
  assert.match(badMode.stderr, /default\|chat-only|surface-policy/i);
  const repository = (await readMultiRepoCatalog(stateDir)).repositories.repo as { surface_policy?: string };
  assert.equal(repository.surface_policy ?? 'default', 'default');
});

test('Stage 1 default repositories accept an explicit bounded Work override reason', async t => {
  const { base, stateDir } = await fixture(t, 'review');
  const prompt = path.join(base, 'work-with-reason.txt');
  await writeFile(prompt, 'Review on Work with a reason.\n');

  const reason = 'explicit compatibility regression';
  const result = runNpm('chatgpt-run', [
    'prepare', '--state-dir', stateDir, '--repository', 'repo', '--task', 'task',
    '--coordinator', 'codex', '--kind', 'review', '--surface', 'work',
    '--surface-override-reason', reason,
    '--session-id', 'session-work-reason', '--prompt-file', prompt
  ], stateDir);
  assert.equal(result.status, 0, result.stderr);
  const prepared = JSON.parse(result.stdout);
  assert.equal(prepared.selection.surface, 'work');
  assert.equal(result.stdout.includes(reason), false, 'override reason must not be public run output');
  const store = await StateStore.open(stateDir);
  const authorization = await store.read<any>(
    `chatgpt-run-authorizations/${prepared.run_id}.json`,
    'chatgpt-run-surface-override-v1'
  );
  assert.equal(authorization?.override_reason, reason);
  assert.equal(JSON.stringify(await chatGptRunStatus(prepared.run_id, stateDir)).includes(reason), false);
});

test('Stage 1 chat-only rejects Work before selection, request, or run publication', async t => {
  const { base, stateDir } = await fixture(t, 'review');
  const policy = runNpm('coord', [
    'repository', 'surface-policy', '--state-dir', stateDir,
    '--repository', 'repo', '--mode', 'chat-only'
  ], stateDir);
  assert.equal(policy.status, 0, policy.stderr);

  const prompt = path.join(base, 'chat-only-work.txt');
  await writeFile(prompt, 'Try forbidden Work.\n');
  const before = await chatGptArtifactInventory(stateDir);
  const result = runNpm('chatgpt-run', [
    'prepare', '--state-dir', stateDir, '--repository', 'repo', '--task', 'task',
    '--coordinator', 'codex', '--kind', 'review', '--surface', 'work',
    '--surface-override-reason', 'must not override owner policy',
    '--session-id', 'session-chat-only-work', '--prompt-file', prompt
  ], stateDir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /OWNER_SURFACE_POLICY|chat-only/i);
  assert.deepEqual(await chatGptArtifactInventory(stateDir), before);
});

test('Stage 1 Work prepare rechecks a racing default-to-chat-only policy before publication', async t => {
  const { stateDir } = await fixture(t, 'review');
  const before = await chatGptArtifactInventory(stateDir);
  const snapshotCaptured = deferred();
  const releaseSnapshot = deferred();
  const originalRead = StateStore.prototype.read;
  let heldFirstCatalogRead = false;
  let capturedSurfacePolicy: unknown;

  StateStore.prototype.read = (async function<T = unknown>(this: StateStore, rel: string, kind: string) {
    const value = await originalRead.call(this, rel, kind) as T | undefined;
    if (!heldFirstCatalogRead && rel === 'control/multirepo-catalog.json' && kind === 'multirepo-catalog') {
      heldFirstCatalogRead = true;
      capturedSurfacePolicy = (value as any)?.repositories?.repo?.surface_policy;
      snapshotCaptured.resolve(undefined);
      await releaseSnapshot.promise;
    }
    return value;
  }) as typeof StateStore.prototype.read;

  let preparePromise: ReturnType<typeof prepareChatGptRunImpl> | undefined;
  let outcome: { run?: Awaited<ReturnType<typeof prepareChatGptRunImpl>>; error?: unknown } | undefined;
  try {
    preparePromise = prepareChatGptRunImpl({
      stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex', workKind: 'review',
      surface: 'work', surfaceOverrideReason: 'deterministic policy-race regression',
      conversationId: 'surface-policy-race', prompt: 'Race Work authorization.', now: NOW,
      runId: '33333333-3333-4333-8333-333333333333',
      selectionId: '44444444-4444-4444-8444-444444444444'
    });
    await snapshotCaptured.promise;
    assert.equal(capturedSurfacePolicy, 'default');

    const changed = await setRepositorySurfacePolicy({
      stateDir, repositoryId: 'repo', mode: 'chat-only'
    });
    assert.equal(changed.unchanged, false);
    assert.equal(changed.repository.surface_policy, 'chat-only');

    releaseSnapshot.resolve(undefined);
    outcome = await preparePromise.then(
      run => ({ run }),
      error => ({ error })
    );
  } finally {
    releaseSnapshot.resolve(undefined);
    StateStore.prototype.read = originalRead;
    if (preparePromise && !outcome) await preparePromise.catch(() => {});
  }

  const observedError = outcome?.error;
  assert.ok(observedError, 'racing Work preparation must fail after chat-only wins');
  assert.match(String((observedError as Error).message), /OWNER_SURFACE_POLICY|chat-only/i);
  assert.deepEqual(
    await chatGptArtifactInventory(stateDir),
    before,
    'no Work selection, request, run, or owner authorization may publish from the stale snapshot'
  );
});

test('Stage 1 surface-policy changes do not rewrite historical explicit Work runs', async t => {
  const { stateDir } = await fixture(t, 'review');
  const legacy = await prepareChatGptRun({
    stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex', workKind: 'review',
    surface: 'work', surfaceOverrideReason: 'historical explicit Work regression',
    conversationId: 'legacy-work-conversation', prompt: 'Historical Work review.', now: NOW
  });
  const runPath = path.join(stateDir, 'chatgpt-runs', `${legacy.run_id}.json`);
  const before = await readFile(runPath, 'utf8');
  // Simulate a pre-Stage-1 Work run: historical records have no surface-override sidecar,
  // and readability must not depend on silently manufacturing one.
  const store = await StateStore.open(stateDir);
  await store.remove(`chatgpt-run-authorizations/${legacy.run_id}.json`);
  assert.equal((await chatGptRunStatus(legacy.run_id, stateDir)).selection.surface, 'work');

  const policy = runNpm('coord', [
    'repository', 'surface-policy', '--state-dir', stateDir,
    '--repository', 'repo', '--mode', 'chat-only'
  ], stateDir);
  assert.equal(policy.status, 0, policy.stderr);

  assert.equal(await readFile(runPath, 'utf8'), before);
  const after = await chatGptRunStatus(legacy.run_id, stateDir);
  assert.equal(after.selection.surface, 'work');
});

test('Stage 1 CLI --help is complete, exits zero, and does not initialize absent state', async t => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-stage1-help-')));
  t.after(() => rm(base, { recursive: true, force: true }));

  const cases = [
    {
      script: 'chatgpt-run' as const,
      markers: [
        'prepare', 'status', 'observe', 'reserve', 'submitted', 'complete', 'uncertain',
        'recover', 'recover-lock', 'recover-request', 'fail-pre-submit',
        '--surface', '--surface-override-reason'
      ]
    },
    {
      script: 'coord' as const,
      markers: [
        'service', 'repository', 'surface-policy', 'task', 'workspace', 'migration', 'gc',
        '--mode', 'default', 'chat-only'
      ]
    }
  ];

  for (const item of cases) {
    await t.test(item.script, async () => {
      const stateDir = path.join(base, `${item.script}-absent-state`);
      const result = runNpm(item.script, ['--help'], stateDir);
      assert.equal(result.status, 0, result.stderr);
      for (const marker of item.markers) {
        assert.ok(result.stdout.includes(marker), `${item.script} help is missing ${marker}\n${result.stdout}`);
      }
      await assert.rejects(lstat(stateDir), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
    });
  }
});

test('Stage 1 chatgpt-run rejects recognized global options on the wrong command without state change', async t => {
  const { stateDir } = await fixture(t, 'review');
  const run = await prepareChatGptRun({
    stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex', workKind: 'review',
    surface: 'chat', conversationId: 'wrong-command-option', prompt: 'Prepare valid status target.', now: NOW
  });
  const before = await chatGptArtifactInventory(stateDir);

  const result = runNpm('chatgpt-run', [
    'status', '--state-dir', stateDir, '--run', run.run_id, '--surface', 'work'
  ], stateDir);
  assert.notEqual(result.status, 0, 'recognized --surface must not be silently ignored by status');
  assert.match(result.stderr, /--surface.*not valid|status.*surface|wrong command/i);
  assert.deepEqual(await chatGptArtifactInventory(stateDir), before);
});

test('corrupt run records fail closed and cannot expose injected fields through status', async t => {
  const { stateDir } = await fixture(t);
  const run = await prepareChatGptRun({
    stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'claude', workKind: 'review',
    surface: 'work', conversationId: 'conversation-1', prompt: 'Review.', now: NOW
  });
  const store = await StateStore.open(stateDir);
  await store.write(`chatgpt-runs/${run.run_id}.json`, 'chatgpt-run-v1', { ...run, raw_prompt: 'secret' });
  await assert.rejects(chatGptRunStatus(run.run_id, stateDir), /does not exist or is corrupt/i);
});

test('concurrent reservation authorizes exactly one browser submission', async t => {
  const { stateDir } = await fixture(t);
  const run = await prepareChatGptRun({
    stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex', workKind: 'review',
    surface: 'work', conversationId: 'conversation-1', prompt: 'Review once.', now: NOW
  });
  const evidence = await observedSelection(stateDir, run.selection);
  const results = await Promise.all(Array.from({ length: 8 }, () => reserveChatGptRun({
    stateDir, runId: run.run_id, contract: run.selection, evidence, now: OBSERVED
  })));
  assert.equal(results.filter(result => result.submission_authorized).length, 1);
  assert.equal(results.filter(result => result.recovery_required).length, 7);
});

test('duplicate prepare is blocked while unresolved and released after completion', async t => {
  const { stateDir } = await fixture(t);
  const options = {
    stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex' as const, workKind: 'review' as const,
    surface: 'work' as const, conversationId: 'conversation-1', prompt: 'Exact review.', now: NOW
  };
  const run = await prepareChatGptRun(options);
  await assert.rejects(prepareChatGptRun(options), new RegExp(run.run_id));
  const evidence = await observedSelection(stateDir, run.selection);
  await reserveChatGptRun({ stateDir, runId: run.run_id, contract: run.selection, evidence, now: OBSERVED });
  await markChatGptRunSubmitted({ runId: run.run_id, stateDir, receipt: receipt(run, 'submit'), now: OBSERVED });
  await completeChatGptRun({ stateDir, runId: run.run_id, output: 'SHIP', outcome: 'ship', receipt: completionReceipt(run, 'complete', 'submit', 'SHIP'), now: OBSERVED });
  const replacement = await prepareChatGptRun(options);
  assert.notEqual(replacement.run_id, run.run_id);
});

test('movable base drift blocks reservation even when HEAD is unchanged', async t => {
  const { root, stateDir } = await fixture(t);
  await writeFile(path.join(root, 'second.txt'), 'second\n');
  await git(root, 'add', 'second.txt');
  await git(root, 'commit', '-m', 'second');
  await rebindRegisteredTask({ stateDir, taskId: 'task' });
  await git(root, 'branch', 'review-base', 'HEAD^');
  const run = await prepareChatGptRun({
    stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex', workKind: 'review',
    surface: 'work', conversationId: 'conversation-1', prompt: 'Review moving base.', baseRef: 'review-base', now: NOW
  });
  const evidence = await observedSelection(stateDir, run.selection);
  await git(root, 'branch', '-f', 'review-base', 'HEAD');
  await assert.rejects(
    reserveChatGptRun({ stateDir, runId: run.run_id, contract: run.selection, evidence, now: OBSERVED }),
    /candidate changed/i
  );
});

test('submission and completion require fresh matching browser receipts', async t => {
  const { stateDir } = await fixture(t);
  const run = await prepareChatGptRun({
    stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex', workKind: 'review',
    surface: 'work', conversationId: 'conversation-1', prompt: 'Receipt review.', now: NOW
  });
  const evidence = await observedSelection(stateDir, run.selection);
  await reserveChatGptRun({ stateDir, runId: run.run_id, contract: run.selection, evidence, now: OBSERVED });
  await assert.rejects(markChatGptRunSubmitted({
    runId: run.run_id, stateDir, receipt: { ...receipt(run, 'submit'), conversationId: 'other' }, now: OBSERVED
  }), /different browser context/i);
  await assert.rejects(markChatGptRunSubmitted({
    runId: run.run_id, stateDir, receipt: { ...receipt(run, 'submit'), promptSha256: '0'.repeat(64) }, now: OBSERVED
  }), /does not match/i);
  await assert.rejects(markChatGptRunSubmitted({
    runId: run.run_id, stateDir,
    receipt: receipt(run, 'submit', '2026-10-07T19:58:00.000Z'), now: OBSERVED
  }), /invalid or stale/i);
  await markChatGptRunSubmitted({ runId: run.run_id, stateDir, receipt: receipt(run, 'submit'), now: OBSERVED });
  await assert.rejects(completeChatGptRun({
    stateDir, runId: run.run_id, output: '', outcome: 'ship', receipt: completionReceipt(run, 'complete', 'submit', ''), now: OBSERVED
  }), /must not be empty/i);
  await assert.rejects(completeChatGptRun({
    stateDir, runId: run.run_id, output: 'SHIP', outcome: 'ship',
    receipt: { ...completionReceipt(run, 'complete', 'submit', 'SHIP'), baseCommit: '0'.repeat(40) }, now: OBSERVED
  }), /does not match/i);
});

test('corrupt state combinations fail closed', async t => {
  const corruptions: Array<[string, (run: Awaited<ReturnType<typeof prepareChatGptRun>>) => object]> = [
    ['reserved without verification', run => ({ ...run, state: 'submission-reserved' })],
    ['reserved with submitted timestamp', run => ({ ...run, state: 'submission-reserved', model_verified_at: OBSERVED.toISOString(), submitted_at: OBSERVED.toISOString() })],
    ['unknown coordinator', run => ({ ...run, coordinator: 'other' })],
    ['incompatible profile', run => ({ ...run, profile: 'architecture' })]
  ];
  for (const [name, mutate] of corruptions) {
    await t.test(name, async st => {
      const { stateDir } = await fixture(st);
      const run = await prepareChatGptRun({
        stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex', workKind: 'review',
        surface: 'work', conversationId: 'conversation-1', prompt: name, now: NOW
      });
      const store = await StateStore.open(stateDir);
      await store.write(`chatgpt-runs/${run.run_id}.json`, 'chatgpt-run-v1', mutate(run));
      await assert.rejects(chatGptRunStatus(run.run_id, stateDir), /does not exist or is corrupt/i);
    });
  }
});

test('explicit run-lock recovery removes only a stale expected lock', async t => {
  const { stateDir } = await fixture(t);
  const run = await prepareChatGptRun({
    stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex', workKind: 'review',
    surface: 'work', conversationId: 'conversation-1', prompt: 'Lock.', now: NOW
  });
  const store = await StateStore.open(stateDir);
  const key = `chatgpt-run-${run.run_id}`;
  const lock = (pid: number, purpose: string) => ({ pid, hostname: os.hostname(), token: 'stale-token', purpose, acquired_at: NOW.toISOString() });
  await store.write(`locks/${key}.json`, 'lock', lock(999_999_999, `transition ChatGPT run ${run.run_id}`));
  assert.equal((await recoverChatGptRunLock(run.run_id, stateDir)).recovered, true);
  assert.equal(await store.read(`locks/${key}.json`, 'lock'), undefined);
  await store.write(`locks/${key}.json`, 'lock', lock(process.pid, `transition ChatGPT run ${run.run_id}`));
  await assert.rejects(recoverChatGptRunLock(run.run_id, stateDir), /live process/i);
  await store.write(`locks/${key}.json`, 'lock', lock(999_999_999, 'foreign operation'));
  await assert.rejects(recoverChatGptRunLock(run.run_id, stateDir), /unexpected purpose/i);
});

test('completion requires a completed-response receipt bound to submission and observed output', async t => {
  const { stateDir } = await fixture(t);
  const run = await prepareChatGptRun({
    stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex', workKind: 'review',
    surface: 'work', conversationId: 'conversation-1', prompt: 'Completion proof.', now: NOW
  });
  await reserveChatGptRun({ stateDir, runId: run.run_id, contract: run.selection,
    evidence: await observedSelection(stateDir, run.selection), now: OBSERVED });
  await markChatGptRunSubmitted({ stateDir, runId: run.run_id, receipt: receipt(run, 'submit'), now: OBSERVED });
  const good = completionReceipt(run, 'complete', 'submit', 'SHIP');
  const bad = [
    receipt(run, 'submit'),
    { ...good, browserEventId: 'submit' },
    { ...good, responseState: 'streaming' },
    { ...good, submissionEventSha256: '0'.repeat(64) },
    { ...good, outputSha256: sha256('other output') }
  ];
  for (const candidate of bad) {
    await assert.rejects(completeChatGptRun({ stateDir, runId: run.run_id, output: 'SHIP', outcome: 'ship',
      receipt: candidate as TrustedChatGptCompletionReceipt, now: OBSERVED }), /completion|completed response|submission event|output digest/i);
    assert.equal((await chatGptRunStatus(run.run_id, stateDir)).state, 'submitted');
  }
  const done = await completeChatGptRun({ stateDir, runId: run.run_id, output: 'SHIP', outcome: 'ship', receipt: good, now: OBSERVED });
  assert.equal(done.completion_submission_event_sha256, done.submission_event_sha256);
  assert.notEqual(done.completion_event_sha256, done.submission_event_sha256);
});

test('reserved uncertainty with submission evidence blocks status and recovery without releasing claim', async t => {
  const { stateDir } = await fixture(t);
  const options = { stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex' as const, workKind: 'review' as const,
    surface: 'work' as const, conversationId: 'conversation-1', prompt: 'Contradictory uncertainty.', now: NOW };
  const run = await prepareChatGptRun(options);
  await reserveChatGptRun({ stateDir, runId: run.run_id, contract: run.selection,
    evidence: await observedSelection(stateDir, run.selection), now: OBSERVED });
  const uncertain = await markChatGptRunUncertain(run.run_id, 'DISCONNECTED', stateDir, OBSERVED);
  const store = await StateStore.open(stateDir);
  await store.write(`chatgpt-runs/${run.run_id}.json`, 'chatgpt-run-v1', {
    ...uncertain, submission_event_sha256: sha256('event'), submission_observed_at: OBSERVED.toISOString()
  });
  await assert.rejects(chatGptRunStatus(run.run_id, stateDir), /corrupt/i);
  await assert.rejects(recoverChatGptRun(run.run_id, 'not-submitted', receipt(run, 'recovery'), stateDir, OBSERVED), /corrupt/i);
  assert.ok(await store.read(`chatgpt-run-requests/${run.request_key}.json`, 'chatgpt-run-request-v1'));
  await assert.rejects(prepareChatGptRun(options), /unresolved/i);
});

test('invalid transition results are rejected before publication and claim release', async t => {
  const { stateDir } = await fixture(t);
  const run = await prepareChatGptRun({ stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex', workKind: 'review',
    surface: 'work', conversationId: 'conversation-1', prompt: 'Validate transition.', now: NOW });
  await reserveChatGptRun({ stateDir, runId: run.run_id, contract: run.selection,
    evidence: await observedSelection(stateDir, run.selection), now: OBSERVED });
  await markChatGptRunSubmitted({ stateDir, runId: run.run_id, receipt: receipt(run, 'submit'), now: OBSERVED });
  await assert.rejects(completeChatGptRun({ stateDir, runId: run.run_id, output: 'SHIP',
    outcome: 'invalid' as 'ship', receipt: completionReceipt(run, 'complete', 'submit', 'SHIP'), now: OBSERVED }), /corrupt|outcome/i);
  assert.equal((await chatGptRunStatus(run.run_id, stateDir)).state, 'submitted');
  const store = await StateStore.open(stateDir);
  assert.ok(await store.read(`chatgpt-run-requests/${run.request_key}.json`, 'chatgpt-run-request-v1'));
});

test('explicit request recovery requires a dead same-host initializer and preserves unresolved runs', async t => {
  const { stateDir } = await fixture(t);
  const options = { stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex' as const, workKind: 'review' as const,
    surface: 'work' as const, conversationId: 'conversation-1', prompt: 'Orphan initializer.', now: NOW };
  const run = await prepareChatGptRun(options);
  const store = await StateStore.open(stateDir);
  const claimPath = `chatgpt-run-requests/${run.request_key}.json`;
  const claim = await store.read<{ initializer: { pid: number; hostname: string; token: string; purpose: string; acquired_at: string } }>(claimPath, 'chatgpt-run-request-v1');
  assert.ok(claim);
  await assert.rejects(recoverChatGptRequestClaim(run.request_key, stateDir), /unresolved/i);
  await store.remove(`chatgpt-runs/${run.run_id}.json`);
  await assert.rejects(recoverChatGptRequestClaim(run.request_key, stateDir), /live initializer/i);
  await store.write(claimPath, 'chatgpt-run-request-v1', { ...claim, initializer: { ...claim.initializer, pid: 999_999_999, hostname: 'foreign-host' } });
  await assert.rejects(recoverChatGptRequestClaim(run.request_key, stateDir), /host/i);
  await store.write(claimPath, 'chatgpt-run-request-v1', { ...claim, initializer: { ...claim.initializer, pid: 'bad' } });
  await assert.rejects(recoverChatGptRequestClaim(run.request_key, stateDir), /corrupt/i);
  await store.write(claimPath, 'chatgpt-run-request-v1', { ...claim, initializer: { ...claim.initializer, pid: 999_999_999 } });
  // Simulate initializer death after claiming the request and before writing its run.
  const key = `chatgpt-request-${run.request_key}`;
  await store.write(`locks/${key}.json`, 'lock', { ...claim.initializer, pid: 999_999_999 });
  assert.equal((await recoverChatGptRequestClaim(run.request_key, stateDir)).recovered, true);
  assert.equal((await recoverChatGptRequestClaim(run.request_key, stateDir)).recovered, false);
  const replacements = await Promise.allSettled([prepareChatGptRun(options), prepareChatGptRun(options)]);
  assert.equal(replacements.filter(result => result.status === 'fulfilled').length, 1);
});

test('terminal request cleanup is recoverable after a crash and cannot delete a replacement claim', async t => {
  const { stateDir } = await fixture(t);
  const options = { stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex' as const, workKind: 'review' as const,
    surface: 'work' as const, conversationId: 'conversation-1', prompt: 'Terminal cleanup.', now: NOW };
  const run = await prepareChatGptRun(options);
  const store = await StateStore.open(stateDir);
  const claimPath = `chatgpt-run-requests/${run.request_key}.json`;
  const claim = await store.read(claimPath, 'chatgpt-run-request-v1');
  await failChatGptRunBeforeSubmit(run.run_id, 'CANCELLED', stateDir, OBSERVED);
  await store.write(claimPath, 'chatgpt-run-request-v1', claim);
  const key = `chatgpt-request-${run.request_key}`;
  await store.write(`locks/${key}.json`, 'lock', { pid: 999_999_999, hostname: os.hostname(), token: 'dead-cleanup',
    purpose: `release ChatGPT request ${run.request_key}`, acquired_at: NOW.toISOString() });
  assert.equal((await recoverChatGptRequestClaim(run.request_key, stateDir)).recovered, true);
  assert.equal((await recoverChatGptRequestClaim(run.request_key, stateDir)).recovered, false);
  const replacement = await prepareChatGptRun(options);
  // An idempotent old terminal transition must leave the new unresolved claim intact.
  await failChatGptRunBeforeSubmit(run.run_id, 'CANCELLED', stateDir, OBSERVED);
  assert.equal((await store.read<{ run_id: string }>(claimPath, 'chatgpt-run-request-v1'))?.run_id, replacement.run_id);
});

test('recover-lock is repeatable after a recovery process crashes and rejects unsafe locks', async t => {
  const { stateDir } = await fixture(t);
  const run = await prepareChatGptRun({ stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex', workKind: 'review',
    surface: 'work', conversationId: 'conversation-1', prompt: 'Recovery recovery.', now: NOW });
  const store = await StateStore.open(stateDir);
  const key = `chatgpt-run-${run.run_id}`;
  const rel = `locks/${key}.json`;
  const stale = { pid: 999_999_999, hostname: os.hostname(), token: 'recovery-token',
    purpose: `recover ChatGPT run ${run.run_id}`, acquired_at: NOW.toISOString() };
  await store.write(rel, 'lock', stale);
  assert.equal((await recoverChatGptRunLock(run.run_id, stateDir)).recovered, true);
  assert.equal((await recoverChatGptRunLock(run.run_id, stateDir)).recovered, false);
  for (const [bad, reason] of [
    [{ ...stale, pid: process.pid }, /live process/i],
    [{ ...stale, hostname: 'foreign-host' }, /host/i],
    [{ ...stale, pid: 'corrupt' }, /corrupt/i],
    [{ ...stale, purpose: 'unrelated' }, /unexpected purpose/i]
  ] as const) {
    await store.write(rel, 'lock', bad);
    await assert.rejects(recoverChatGptRunLock(run.run_id, stateDir), reason);
    assert.deepEqual(await store.read(rel, 'lock'), bad);
  }
  await store.write(rel, 'lock', stale);
  const originalRead = StateStore.prototype.read;
  let reads = 0;
  const mocked = t.mock.method(StateStore.prototype, 'read', async function<T>(this: StateStore, path: string, kind: string): Promise<T | undefined> {
    if (path === rel && ++reads === 2) await this.write(rel, 'lock', { ...stale, token: 'replacement-token' });
    return originalRead.call(this, path, kind) as Promise<T | undefined>;
  });
  await assert.rejects(recoverChatGptRunLock(run.run_id, stateDir), /replacement lock|changed before stale recovery/i);
  mocked.mock.restore();
  assert.equal((await store.read<{ token: string }>(rel, 'lock'))?.token, 'replacement-token');
});

test('real process death during initialization and terminal cleanup permits only explicit claim recovery', async t => {
  for (const mode of ['initializer', 'terminal'] as const) {
    await t.test(mode, async st => {
      const { stateDir } = await fixture(st);
      const child = spawnSync(process.execPath, ['--import', 'tsx',
        path.join(PROJECT_BASE, 'test/support/chatgpt-run-crash-child.ts'), mode, stateDir], {
        cwd: PROJECT_BASE, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, NODE_OPTIONS: '' }
      });
      assert.equal(child.error, undefined);
      assert.equal(child.status, mode === 'initializer' ? 91 : 92, child.stderr);
      const store = await StateStore.open(stateDir);
      const names = await store.list('chatgpt-run-requests');
      assert.equal(names.length, 1);
      const claim = await store.read<{ run_id: string; request_key: string }>(
        `chatgpt-run-requests/${names[0]}`, 'chatgpt-run-request-v1');
      assert.ok(claim);
      const options = { stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex' as const,
        workKind: 'review' as const, surface: 'work' as const, conversationId: 'conversation-1',
        prompt: 'Crash request.', now: NOW };
      await assert.rejects(prepareChatGptRun(options), /stale lock/i);
      assert.equal((await recoverChatGptRequestClaim(claim.request_key, stateDir)).recovered, true);
      if (mode === 'initializer') {
        // process.exit(91) occurs while prepare holds the task coordinator gate;
        // recovery stays explicit and test-scoped rather than becoming production auto-recovery.
        await recoverTaskStaleLocks(stateDir, 'task');
      }
      if (mode === 'terminal') {
        assert.equal((await recoverChatGptRunLock(claim.run_id, stateDir)).recovered, true);
        assert.equal((await chatGptRunStatus(claim.run_id, stateDir)).state, 'failed-pre-submit');
      }
      assert.equal((await recoverChatGptRequestClaim(claim.request_key, stateDir)).recovered, false);
      const replacement = await prepareChatGptRun(options);
      assert.notEqual(replacement.run_id, claim.run_id);
      await assert.rejects(prepareChatGptRun(options), /unresolved/i);
    });
  }
});

test('malformed run and request lock envelopes fail closed without deleting unresolved state', async t => {
  for (const lockKind of ['run', 'request'] as const) {
    for (const operation of ['recover', 'acquire'] as const) {
      await t.test(`${lockKind} lock ${operation}`, async st => {
        const { stateDir } = await fixture(st);
        const options = {
          stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex' as const,
          workKind: 'review' as const, surface: 'work' as const, conversationId: 'conversation-1',
          prompt: 'Malformed lock envelope.', now: NOW
        };
        const run = await prepareChatGptRun(options);
        const lockPath = `locks/chatgpt-${lockKind === 'run' ? 'run-' + run.run_id : 'request-' + run.request_key}.json`;
        const runPath = `chatgpt-runs/${run.run_id}.json`;
        const claimPath = `chatgpt-run-requests/${run.request_key}.json`;
        const malformed = JSON.stringify({ version: 1, kind: 'lock' });
        await writeFile(path.join(stateDir, lockPath), malformed);
        const runBefore = await readFile(path.join(stateDir, runPath), 'utf8');
        const claimBefore = await readFile(path.join(stateDir, claimPath), 'utf8');
        const originalCreate = StateStore.prototype.create;
        let attempts = 0;
        // Bound the unfixed retry loop by attempts, rather than a timing race.
        const mocked = st.mock.method(StateStore.prototype, 'create', async function(this: StateStore, rel: string, kind: string, data: unknown) {
          if (rel === lockPath && ++attempts > 1) throw new Error('Unexpected retry of malformed lock envelope.');
          return originalCreate.call(this, rel, kind, data);
        });
        try {
          const action = operation === 'recover'
            ? lockKind === 'run'
              ? recoverChatGptRunLock(run.run_id, stateDir)
              : recoverChatGptRequestClaim(run.request_key, stateDir)
            : lockKind === 'run'
              ? failChatGptRunBeforeSubmit(run.run_id, 'CANCELLED', stateDir, OBSERVED)
              : prepareChatGptRun(options);
          await assert.rejects(action, /corrupt task state record locks\//i);
          assert.equal(attempts, operation === 'acquire' ? 1 : 0);
        } finally {
          mocked.mock.restore();
          assert.equal(await readFile(path.join(stateDir, lockPath), 'utf8'), malformed);
          assert.equal(await readFile(path.join(stateDir, runPath), 'utf8'), runBefore);
          assert.equal(await readFile(path.join(stateDir, claimPath), 'utf8'), claimBefore);
        }
      });
    }
  }
});

test('dangling run and request lock symlinks fail closed without deleting unresolved state', async t => {
  for (const lockKind of ['run', 'request'] as const) {
    for (const operation of ['recover', 'acquire'] as const) {
      await t.test(`${lockKind} lock ${operation}`, async st => {
        const { stateDir } = await fixture(st);
        const options = {
          stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex' as const,
          workKind: 'review' as const, surface: 'work' as const, conversationId: 'conversation-1',
          prompt: 'Dangling lock symlink.', now: NOW
        };
        const run = await prepareChatGptRun(options);
        const lockPath = `locks/chatgpt-${lockKind === 'run' ? 'run-' + run.run_id : 'request-' + run.request_key}.json`;
        const runPath = path.join(stateDir, 'chatgpt-runs', `${run.run_id}.json`);
        const claimPath = path.join(stateDir, 'chatgpt-run-requests', `${run.request_key}.json`);
        const missingTarget = path.join(stateDir, 'missing-lock-target.json');
        const lockFile = path.join(stateDir, lockPath);
        await symlink(missingTarget, lockFile);
        const linkBefore = await lstat(lockFile);
        const runBefore = await readFile(runPath, 'utf8');
        const claimBefore = await readFile(claimPath, 'utf8');
        const originalCreate = StateStore.prototype.create;
        let attempts = 0;
        // The old ENOENT/EEXIST loop must fail deterministically on its second attempt.
        const mocked = st.mock.method(StateStore.prototype, 'create', async function(this: StateStore, rel: string, kind: string, data: unknown) {
          if (rel === lockPath && ++attempts > 1) throw new Error('Unexpected retry of dangling lock symlink.');
          return originalCreate.call(this, rel, kind, data);
        });
        try {
          const action = operation === 'recover'
            ? lockKind === 'run'
              ? recoverChatGptRunLock(run.run_id, stateDir)
              : recoverChatGptRequestClaim(run.request_key, stateDir)
            : lockKind === 'run'
              ? failChatGptRunBeforeSubmit(run.run_id, 'CANCELLED', stateDir, OBSERVED)
              : prepareChatGptRun(options);
          await assert.rejects(action, /unsafe task state pathname locks\//i);
          assert.equal(attempts, operation === 'acquire' ? 1 : 0);
        } finally {
          mocked.mock.restore();
          const linkAfter = await lstat(lockFile);
          assert.equal(linkAfter.isSymbolicLink(), true);
          assert.equal(linkAfter.dev, linkBefore.dev);
          assert.equal(linkAfter.ino, linkBefore.ino);
          assert.equal(await readlink(lockFile), missingTarget);
          await assert.rejects(lstat(missingTarget), { code: 'ENOENT' });
          assert.equal(await readFile(runPath, 'utf8'), runBefore);
          assert.equal(await readFile(claimPath, 'utf8'), claimBefore);
        }
      });
    }
  }
});

test('a malformed run envelope is not an orphan and must retain the exact-request claim', async t => {
  const { stateDir } = await fixture(t);
  const run = await prepareChatGptRun({ stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex', workKind: 'review',
    surface: 'work', conversationId: 'conversation-1', prompt: 'Missing data is corruption.', now: NOW });
  const store = await StateStore.open(stateDir);
  const claimPath = `chatgpt-run-requests/${run.request_key}.json`;
  const claim = await store.read<{ initializer: { pid: number } }>(claimPath, 'chatgpt-run-request-v1');
  assert.ok(claim);
  await store.write(claimPath, 'chatgpt-run-request-v1', { ...claim, initializer: { ...claim.initializer, pid: 999_999_999 } });
  await writeFile(path.join(stateDir, 'chatgpt-runs', `${run.run_id}.json`),
    JSON.stringify({ version: 1, kind: 'chatgpt-run-v1' }));
  await assert.rejects(recoverChatGptRequestClaim(run.request_key, stateDir), /corrupt.*run/i);
  assert.ok(await store.read(claimPath, 'chatgpt-run-request-v1'));
});
