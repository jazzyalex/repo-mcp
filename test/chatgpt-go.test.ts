import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareFixture } from '../src/fixture.js';
import { migrateV1 } from '../src/policy.js';
import { defaultPolicy } from '../src/repo.js';
import { bindRegisteredTask, openWorkspace, registerRepository, rebindRegisteredTask, setRegisteredTaskPhase } from '../src/multirepo-state.js';
import { git } from './helpers.js';
import { StateStore } from '../src/task-state.js';
import { chatGptRunOutput, chatGptRunStatus } from '../src/chatgpt-run.js';
import { GoError, goStatus, releaseGoAdmission, reviewVerdict, runGo, type ChatGptPage, type GoPhase, type TurnState } from '../src/chatgpt-go.js';

const PROMPT = 'Architecture review of the plan. Use Repo MCP only. Make no edits.\n\nEnd with VERDICT.';
const ANSWER = 'Proceed with changes.\n\nVERDICT: proceed with changes';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-chatgpt-go-')));
  const root = path.join(base, 'repo');
  const stateDir = path.join(base, 'state');
  await prepareFixture(root);
  const policyPath = path.join(base, 'policy.json');
  await writeFile(policyPath, JSON.stringify(migrateV1(defaultPolicy)));
  await registerRepository({ stateDir, repositoryId: 'repo', root, policyPath });
  await bindRegisteredTask({ stateDir, repositoryId: 'repo', taskId: 'task' });
  await writeFile(path.join(base, 'prompt.txt'), PROMPT);
  t.after(() => rm(base, { recursive: true, force: true }));
  return { stateDir };
}

/** In-memory ChatGPT page. `sent` flips on the Send click; the answer appears after `busyPolls` polls. */
class FakePage implements ChatGptPage {
  clicks = 0;
  archived = 0;
  sent = false;
  polls = 0;
  constructor(public opts: {
    sentAlready?: boolean; showMessage?: boolean; busyPolls?: number; effortLabel?: string;
    failArchive?: boolean; failEffort?: GoError; tabGone?: boolean; dropClick?: boolean; now?: () => Date;
    answer?: string; onSend?: () => Promise<void>;
  } = {}) { this.sent = !!opts.sentAlready; }
  async open() { return { targetId: 'target-1' }; }
  async reattach() { return !this.opts.tabGone; }
  async attachRepoMcp() {}
  async pastePrompt(_text: string) {}
  async selectEffort(label: string) {
    if (this.opts.failEffort) throw this.opts.failEffort;
    const selectedAt = this.opts.now?.() ?? new Date();
    if (!this.opts.now) await new Promise(r => setTimeout(r, 5));
    return { selectedAt, observedLabel: this.opts.effortLabel ?? label };
  }
  async clickSend() { this.clicks++; if (!this.opts.dropClick) this.sent = true; await this.opts.onSend?.(); }
  async conversationUrl() { return this.sent ? 'https://chatgpt.com/c/abc-123' : undefined; }
  async hasExpectedUserMessage() { return this.sent && this.opts.showMessage !== false; }
  async turnState(): Promise<TurnState> {
    this.polls++;
    return this.polls <= (this.opts.busyPolls ?? 1) ? { state: 'busy', chars: 10 } : { state: 'done', chars: (this.opts.answer ?? ANSWER).length };
  }
  async readAnswer() { return this.opts.answer ?? ANSWER; }
  async archive() { if (this.opts.failArchive) throw new GoError('UI_MISSING:archive'); this.archived++; }
  async closeTab() {}
  async close() {}
}

const sleep = async () => {};
const base = (stateDir: string, requestId = 'req-1') => ({
  stateDir, requestId, accountDir: path.join(stateDir, '..', 'account'), repositoryId: 'repo', taskId: 'task',
  coordinator: 'claude' as const, kind: 'architecture', prompt: PROMPT, promptFile: path.join(stateDir, '..', 'prompt.txt')
});
const crashAt = (phase: GoPhase) => (p: GoPhase) => { if (p === phase) throw new Error(`crash at ${phase}`); };

test('go happy path sends once, completes, archives and releases the account', async t => {
  const { stateDir } = await fixture(t);
  const page = new FakePage({ busyPolls: 2 });
  const r = await runGo(base(stateDir), { page, sleep });
  assert.equal(r.phase, 'cleaned');
  assert.equal(r.run_state, 'completed');
  assert.equal(r.cleanup, 'archived');
  assert.equal(page.clicks, 1);
  assert.equal(await chatGptRunOutput(r.run_id!, stateDir), ANSWER);
  assert.equal(await readFile(r.output_file!, 'utf8'), ANSWER);
  // Account is free again: a second request is admitted.
  const r2 = await runGo(base(stateDir, 'req-2'), { page: new FakePage(), sleep });
  assert.equal(r2.phase, 'cleaned');
});

test('rerunning a finished request returns the stored result without browser actions', async t => {
  const { stateDir } = await fixture(t);
  const first = await runGo(base(stateDir), { page: new FakePage(), sleep });
  const page = new FakePage();
  const again = await runGo(base(stateDir), { page, sleep });
  assert.deepEqual(again, first);
  assert.equal(page.clicks, 0);
  assert.equal(page.polls, 0);
});

test('crash after prepare resumes to failed-pre-submit with no send', async t => {
  const { stateDir } = await fixture(t);
  await assert.rejects(runGo(base(stateDir), { page: new FakePage(), sleep, afterPhase: crashAt('prepared') }), /crash at prepared/);
  const page = new FakePage();
  const r = await runGo({ stateDir, requestId: 'req-1', accountDir: base(stateDir).accountDir }, { page, sleep });
  assert.equal(r.phase, 'failed');
  assert.equal(r.run_state, 'failed-pre-submit');
  assert.equal(r.failure_code, 'DRIVER_INTERRUPTED');
  assert.equal(page.clicks, 0);
});

test('crash after reserve but before send intent is resolved as not submitted', async t => {
  const { stateDir } = await fixture(t);
  const first = new FakePage();
  await assert.rejects(runGo(base(stateDir), { page: first, sleep, afterPhase: crashAt('reserved') }), /crash at reserved/);
  assert.equal(first.clicks, 0);
  const page = new FakePage();
  const r = await runGo(base(stateDir), { page, sleep });
  assert.equal(r.phase, 'failed');
  assert.equal(r.run_state, 'failed-pre-submit');
  assert.equal(r.failure_code, 'CONFIRMED_NOT_SUBMITTED');
  assert.equal(page.clicks, 0);
});

test('crash after send intent with the message visible resumes without a second click', async t => {
  const { stateDir } = await fixture(t);
  const first = new FakePage();
  await assert.rejects(runGo(base(stateDir), { page: first, sleep, afterPhase: crashAt('send-intent') }), /crash at send-intent/);
  assert.equal(first.clicks, 0, 'the crash hook runs right after the intent write, before the click');
  // The browser actually received the send (e.g. the click raced the crash).
  const page = new FakePage({ sentAlready: true });
  const r = await runGo(base(stateDir), { page, sleep });
  assert.equal(r.phase, 'cleaned');
  assert.equal(r.run_state, 'completed');
  assert.equal(page.clicks, 0);
});

test('unconfirmed send is held as uncertain, keeps the account, and never resends', async t => {
  const { stateDir } = await fixture(t);
  let clock = Date.now();
  const now = () => new Date(clock);
  const tick = async (ms: number) => { clock += ms; };
  const first = new FakePage({ showMessage: false, now });
  const r = await runGo(base(stateDir), { page: first, sleep: tick, now });
  assert.equal(r.phase, 'uncertain');
  assert.equal(r.run_state, 'uncertain');
  assert.equal(r.failure_code, 'SEND_UNCONFIRMED');
  assert.equal(first.clicks, 1);
  await assert.rejects(runGo(base(stateDir, 'req-2'), { page: new FakePage(), sleep, now }), (e: unknown) => e instanceof GoError && e.code === 'ACCOUNT_BUSY');
  const again = new FakePage({ showMessage: false, sentAlready: true });
  const r2 = await runGo(base(stateDir), { page: again, sleep: tick, now });
  assert.equal(r2.phase, 'uncertain');
  assert.equal(again.clicks, 0);
  // Once the message is visible, resume recovers the same run and completes.
  const r3 = await runGo(base(stateDir), { page: new FakePage({ sentAlready: true }), sleep: tick, now });
  assert.equal(r3.phase, 'cleaned');
  assert.equal(r3.run_id, r.run_id);
});

test('operator release frees the account for an uncertain request only with a reason', async t => {
  const { stateDir } = await fixture(t);
  let clock = Date.now();
  const now = () => new Date(clock);
  const r = await runGo(base(stateDir), { page: new FakePage({ showMessage: false, now }), sleep: async ms => { clock += ms; }, now });
  assert.equal(r.phase, 'uncertain');
  const acct = base(stateDir).accountDir;
  await assert.rejects(releaseGoAdmission(stateDir, 'req-1', ' ', acct), /reason/);
  await releaseGoAdmission(stateDir, 'req-1', 'checked the chat by hand; nothing was sent', acct);
  const r2 = await runGo(base(stateDir, 'req-2'), { page: new FakePage(), sleep });
  assert.equal(r2.phase, 'cleaned');
});

test('rate limit counts sends in the last hour', async t => {
  const { stateDir } = await fixture(t);
  await runGo({ ...base(stateDir, 'a'), maxPerHour: 1 }, { page: new FakePage(), sleep });
  await assert.rejects(runGo({ ...base(stateDir, 'b'), maxPerHour: 1 }, { page: new FakePage(), sleep }),
    (e: unknown) => e instanceof GoError && e.code === 'RATE_LIMITED');
});

test('same request ID with a different prompt is a conflict', async t => {
  const { stateDir } = await fixture(t);
  await runGo(base(stateDir), { page: new FakePage(), sleep });
  await assert.rejects(runGo({ ...base(stateDir), prompt: PROMPT + ' changed' }, { page: new FakePage(), sleep }),
    (e: unknown) => e instanceof GoError && e.code === 'REQUEST_CONFLICT');
});

test('archive failure still completes with a cleanup warning', async t => {
  const { stateDir } = await fixture(t);
  const r = await runGo(base(stateDir), { page: new FakePage({ failArchive: true }), sleep });
  assert.equal(r.phase, 'cleaned');
  assert.equal(r.run_state, 'completed');
  assert.equal(r.cleanup, 'warning:UI_MISSING_ARCHIVE');
});

test('wrong effort label fails before submit and frees the account', async t => {
  const { stateDir } = await fixture(t);
  const page = new FakePage({ effortLabel: 'Extra High' });
  const r = await runGo(base(stateDir), { page, sleep });
  assert.equal(r.phase, 'failed');
  assert.equal(r.run_state, 'failed-pre-submit');
  assert.equal(page.clicks, 0);
  const s = await goStatus(stateDir, 'req-1');
  assert.equal(s.phase, 'failed');
  assert.equal((await runGo(base(stateDir, 'req-2'), { page: new FakePage(), sleep })).phase, 'cleaned');
});

test('ambiguous UI before prepare fails without creating a run', async t => {
  const { stateDir } = await fixture(t);
  const page = new FakePage();
  page.attachRepoMcp = async () => { throw new GoError('UI_AMBIGUOUS:repo-mcp-item'); };
  const r = await runGo(base(stateDir), { page, sleep });
  assert.equal(r.phase, 'failed');
  assert.equal(r.run_id, null);
  assert.equal(r.failure_code, 'UI_AMBIGUOUS_REPO_MCP_ITEM');
});

test('kind code is unsupported', async t => {
  const { stateDir } = await fixture(t);
  await assert.rejects(runGo({ ...base(stateDir), kind: 'code' }, { page: new FakePage(), sleep }),
    (e: unknown) => e instanceof GoError && e.code === 'KIND_UNSUPPORTED');
  assert.equal((await chatGptRunStatus('00000000-0000-4000-8000-000000000000', stateDir).catch(() => undefined)), undefined);
});

test('resume with only the request ID reloads the saved prompt file', async t => {
  const { stateDir } = await fixture(t);
  await assert.rejects(runGo(base(stateDir), { page: new FakePage(), sleep, afterPhase: crashAt('submitted') }), /crash at submitted/);
  const r = await runGo({ stateDir, requestId: 'req-1', accountDir: base(stateDir).accountDir }, { page: new FakePage({ sentAlready: true }), sleep });
  assert.equal(r.phase, 'cleaned');
  assert.equal(r.run_state, 'completed');
});

test('crash after journal completion restores the output file on resume', async t => {
  const { stateDir } = await fixture(t);
  await assert.rejects(runGo(base(stateDir), { page: new FakePage(), sleep, afterPhase: crashAt('completed') }), /crash at completed/);
  const r = await runGo(base(stateDir), { page: new FakePage({ sentAlready: true }), sleep });
  assert.equal(r.phase, 'cleaned');
  assert.equal(await readFile(r.output_file!, 'utf8'), ANSWER);
});

test('the sent text carries a per-request marker on its first line', async t => {
  const { stateDir } = await fixture(t);
  const page = new FakePage();
  let pasted = '';
  page.pastePrompt = async (text: string) => { pasted = text; };
  await runGo(base(stateDir), { page, sleep });
  assert.match(pasted, /^Run [a-f0-9]{16}\n\n/);
  assert.ok(pasted.endsWith(PROMPT));
});

test('a stale account lock from a dead process does not block the next run', async t => {
  const { stateDir } = await fixture(t);
  const acct = await StateStore.open(base(stateDir).accountDir);
  await acct.write('locks/chatgpt-go-account.json', 'lock', { pid: 999999, hostname: os.hostname(), token: 'dead', purpose: 'chatgpt-go account admission', acquired_at: new Date().toISOString() });
  assert.equal((await runGo(base(stateDir), { page: new FakePage(), sleep })).phase, 'cleaned');
});

test('admission is shared across state directories through one account store', async t => {
  const { stateDir } = await fixture(t);
  const other = await fixture(t);
  let clock = Date.now();
  const now = () => new Date(clock);
  const held = await runGo(base(stateDir), { page: new FakePage({ showMessage: false, now }), sleep: async ms => { clock += ms; }, now });
  assert.equal(held.phase, 'uncertain');
  await assert.rejects(runGo({ ...base(other.stateDir), accountDir: base(stateDir).accountDir }, { page: new FakePage(), sleep }),
    (e: unknown) => e instanceof GoError && e.code === 'ACCOUNT_BUSY');
});

test('a request refused for a busy account stays resumable once the account is free', async t => {
  const { stateDir } = await fixture(t);
  let clock = Date.now();
  const now = () => new Date(clock);
  const held = await runGo(base(stateDir), { page: new FakePage({ showMessage: false, now }), sleep: async ms => { clock += ms; }, now });
  assert.equal(held.phase, 'uncertain');
  await assert.rejects(runGo(base(stateDir, 'req-2'), { page: new FakePage(), sleep }),
    (e: unknown) => e instanceof GoError && e.code === 'ACCOUNT_BUSY');
  await releaseGoAdmission(stateDir, 'req-1', 'inspected by hand', base(stateDir).accountDir);
  // req-2's manifest exists without admission; the same command now proceeds.
  const r2 = await runGo(base(stateDir, 'req-2'), { page: new FakePage(), sleep });
  assert.equal(r2.phase, 'cleaned');
});

test('a finished request rewrites a missing or altered output file from the journal', async t => {
  const { stateDir } = await fixture(t);
  const r = await runGo(base(stateDir), { page: new FakePage(), sleep });
  await rm(r.output_file!);
  const again = await runGo(base(stateDir), { page: new FakePage(), sleep });
  assert.equal(await readFile(again.output_file!, 'utf8'), ANSWER);
  await writeFile(again.output_file!, 'tampered');
  await runGo(base(stateDir), { page: new FakePage(), sleep });
  assert.equal(await readFile(again.output_file!, 'utf8'), ANSWER);
});

test('reusing a request ID with a different profile is a conflict', async t => {
  const { stateDir } = await fixture(t);
  await runGo(base(stateDir), { page: new FakePage(), sleep });
  await assert.rejects(runGo({ ...base(stateDir), profile: 'architecture-xhigh' }, { page: new FakePage(), sleep }),
    (e: unknown) => e instanceof GoError && e.code === 'REQUEST_CONFLICT');
});

test('a confirmed send clears an earlier failure code', async t => {
  const { stateDir } = await fixture(t);
  let clock = Date.now();
  const now = () => new Date(clock);
  const tick = async (ms: number) => { clock += ms; };
  await runGo(base(stateDir), { page: new FakePage({ showMessage: false, now }), sleep: tick, now });
  const r = await runGo(base(stateDir), { page: new FakePage({ sentAlready: true, now }), sleep: tick, now });
  assert.equal(r.phase, 'cleaned');
  assert.equal(r.failure_code, null);
});

test('a finished request releases the account even when output repair fails', async t => {
  const { stateDir } = await fixture(t);
  const r = await runGo(base(stateDir), { page: new FakePage(), sleep });
  // Simulate a damaged journal output and a missing output file.
  await rm(path.join(stateDir, 'chatgpt-run-outputs', `${r.run_id}.json`));
  await rm(r.output_file!);
  await assert.rejects(runGo(base(stateDir), { page: new FakePage(), sleep }));
  assert.equal((await runGo(base(stateDir, 'req-2'), { page: new FakePage(), sleep })).phase, 'cleaned');
});

// --- review kind -------------------------------------------------------------------------

const WS_ID = 'open-go-review-1';
const REVIEW_PROMPT = `Independent review of the change. Workspace request id: ${WS_ID}\n\nEnd with VERDICT: SHIP or VERDICT: NO-SHIP.`;

/** Registered repository with a review-phase task and two commits to review. */
async function reviewFixture(t: { after(fn: () => Promise<void>): void }) {
  const f = await fixture(t);
  const root = path.join(f.stateDir, '..', 'repo');
  await writeFile(path.join(root, 'src', 'go-target.txt'), 'target v1\n');
  await git(root, 'add', '--', 'src/go-target.txt');
  await git(root, 'commit', '-m', 'go target');
  await rebindRegisteredTask({ stateDir: f.stateDir, taskId: 'task' });
  await setRegisteredTaskPhase({ stateDir: f.stateDir, taskId: 'task', phase: 'review' });
  const baseRef = (await git(root, 'rev-parse', 'HEAD^')).trim();
  const headRef = (await git(root, 'rev-parse', 'HEAD')).trim();
  return { ...f, baseRef, headRef };
}

const reviewBase = (r: { stateDir: string; baseRef: string; headRef: string }, requestId = 'rev-1') => ({
  ...base(r.stateDir, requestId), kind: 'review', prompt: REVIEW_PROMPT,
  workspaceRequestId: WS_ID, baseRef: r.baseRef, headRef: r.headRef
});

/** Simulates ChatGPT calling workspace_open with the request ID named in the prompt, at send time. */
const openOnSend = (r: { stateDir: string; baseRef: string; headRef: string }) => async () => {
  await openWorkspace({ stateDir: r.stateDir, repositoryId: 'repo', taskId: 'task', mode: 'review',
    requestId: WS_ID, baseRef: r.baseRef, headRef: r.headRef });
};

const invalid = (e: unknown) => e instanceof GoError && e.code === 'INVALID_REQUEST';

test('review happy path: SHIP verdict, cleaned, participant closed after workspace reconcile', async t => {
  const r = await reviewFixture(t);
  const page = new FakePage({ answer: 'Looks fine.\n\nVERDICT: SHIP', onSend: openOnSend(r) });
  const res = await runGo(reviewBase(r), { page, sleep });
  assert.equal(res.phase, 'cleaned');
  assert.equal(res.run_state, 'completed');
  assert.equal(res.outcome, 'ship');
  assert.equal(res.participant, 'closed');
  assert.equal(res.failure_code, null);
  assert.equal(page.clicks, 1);
  assert.equal((await goStatus(r.stateDir, 'rev-1')).participant, 'closed');
  // Rerun is stable and does not click again.
  const again = new FakePage();
  assert.deepEqual(await runGo(reviewBase(r), { page: again, sleep }), res);
  assert.equal(again.clicks, 0);
});

test('review answer without a verdict line fails closed to no-ship', async t => {
  const r = await reviewFixture(t);
  const res = await runGo(reviewBase(r), { page: new FakePage({ answer: 'I think this is fine to SHIP.', onSend: openOnSend(r) }), sleep });
  assert.equal(res.phase, 'cleaned');
  assert.equal(res.outcome, 'no-ship');
  assert.equal(res.participant, 'closed');
});

test('reviewVerdict parses the last verdict line and fails closed', () => {
  assert.equal(reviewVerdict('text\n**VERDICT:** NO-SHIP'), 'no-ship');
  assert.equal(reviewVerdict('VERDICT - SHIP'), 'ship');
  assert.equal(reviewVerdict('VERDICT: NO-SHIP\nmore\nVERDICT: SHIP'), 'ship');
  assert.equal(reviewVerdict('VERDICT: SHIP\nafter fixes\nVERDICT: NO-SHIP'), 'no-ship');
  assert.equal(reviewVerdict('no verdict here'), 'no-ship');
  assert.equal(reviewVerdict('We should SHIP this change.'), 'no-ship');
});

test('invalid review inputs are rejected before any run', async t => {
  const r = await reviewFixture(t);
  const run = (over: Record<string, unknown>) => runGo({ ...reviewBase(r, `bad-${Math.random().toString(36).slice(2, 8)}`), ...over }, { page: new FakePage(), sleep });
  await assert.rejects(run({ workspaceRequestId: undefined }), invalid);
  await assert.rejects(run({ baseRef: 'HEAD^' }), invalid);
  await assert.rejects(run({ baseRef: 'A'.repeat(40) }), invalid);
  await assert.rejects(run({ headRef: r.headRef.slice(0, 39) }), invalid);
  await assert.rejects(run({ prompt: 'Review it. No workspace id here.' }), invalid);
  await assert.rejects(run({ profile: 'architecture' }), invalid);
  await assert.rejects(runGo({ ...base(r.stateDir, 'arch-opts'), workspaceRequestId: WS_ID, baseRef: r.baseRef, headRef: r.headRef },
    { page: new FakePage(), sleep }), invalid);
});

test('review with a wrong effort label fails before submit and releases the participant', async t => {
  const r = await reviewFixture(t);
  const page = new FakePage({ effortLabel: 'High' });
  const res = await runGo(reviewBase(r), { page, sleep });
  assert.equal(res.phase, 'failed');
  assert.equal(res.run_state, 'failed-pre-submit');
  assert.equal(res.participant, 'closed');
  assert.equal(page.clicks, 0);
});

test('a review whose workspace was never opened is held, then completes on resume once it is', async t => {
  const r = await reviewFixture(t);
  const page = new FakePage({ answer: 'VERDICT: NO-SHIP' });
  const held = await runGo(reviewBase(r), { page, sleep: async () => {} });
  assert.equal(held.phase, 'uncertain');
  assert.equal(held.failure_code, 'WORKSPACE_RECONCILIATION_REQUIRED');
  await openOnSend(r)();
  const done = await runGo(reviewBase(r), { page, sleep: async () => {} });
  assert.equal(done.phase, 'cleaned');
  assert.equal(done.outcome, 'no-ship');
  assert.equal(done.participant, 'closed');
  assert.equal(page.clicks, 1);
});
