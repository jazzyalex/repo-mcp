import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { prepareFixture } from '../src/fixture.js';
import { migrateV1 } from '../src/policy.js';
import { defaultPolicy } from '../src/repo.js';
import { bindRegisteredTask, rebindRegisteredTask, registerRepository, setRegisteredTaskPhase } from '../src/multirepo-state.js';
import {
  chatGptRunStatus,
  completeChatGptRun,
  failChatGptRunBeforeSubmit,
  markChatGptRunSubmitted,
  markChatGptRunUncertain,
  prepareChatGptRun,
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

const NOW = new Date('2026-10-07T20:00:00.000Z');
const OBSERVED = new Date('2026-10-07T20:00:03.000Z');

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
      ? 'GPT-6.1 Sol Pro'
      : 'GPT-6.1 Sol Extra High',
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

test('Claude cannot prepare coding work and uncertain runs cannot be resubmitted', async t => {
  const coding = await fixture(t, 'coding');
  await assert.rejects(
    prepareChatGptRun({
      stateDir: coding.stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'claude', workKind: 'code',
      surface: 'work', conversationId: 'conversation-1', prompt: 'Code.'
    }),
    /coding is a Codex-coordinated workflow/i
  );

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
    '--kind', 'review', '--surface', 'work', '--conversation-id', 'conversation-cli', '--prompt-file', file];
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
    '--conversation-id', 'conversation-cli', '--control-label', 'GPT-6.1 Sol Extra High',
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
    ['Claude coding', run => ({ ...run, coordinator: 'claude', work_kind: 'code', profile: 'code' })],
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
