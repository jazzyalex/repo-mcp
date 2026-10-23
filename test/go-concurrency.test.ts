import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareFixture } from '../src/fixture.js';
import { migrateV1 } from '../src/policy.js';
import { defaultPolicy } from '../src/repo.js';
import { bindRegisteredTask, finishRegisteredTask, registerRepository } from '../src/multirepo-state.js';
import { StateStore } from '../src/task-state.js';
import { GoError, activeGoRequestsForTask, releaseGoAdmission, runGo, type ChatGptPage, type TurnState } from '../src/chatgpt-go.js';
import {
  AccountError, accountConfig, accountStatus, acquireSetupLease, admitSlot, clearLatch, commitSend, confirmSend, releaseSlot, setAccountConfig, setLatch
} from '../src/go-account.js';

const PROMPT = 'Architecture pass. Use Repo MCP only. Make no edits.\n\nEnd with VERDICT.';
const ANSWER = 'Fine.\n\nVERDICT: fine';

async function fixture(t: { after(fn: () => Promise<void>): void }, config: Record<string, unknown> = {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-go-conc-')));
  const root = path.join(base, 'repo');
  const stateDir = path.join(base, 'state');
  const accountDir = path.join(base, 'account');
  await prepareFixture(root);
  const policyPath = path.join(base, 'policy.json');
  await writeFile(policyPath, JSON.stringify(migrateV1(defaultPolicy)));
  await registerRepository({ stateDir, repositoryId: 'repo', root, policyPath });
  await bindRegisteredTask({ stateDir, repositoryId: 'repo', taskId: 'task' });
  await mkdir(accountDir, { recursive: true });
  await writeFile(path.join(accountDir, 'config.json'), JSON.stringify({ min_gap_seconds: 0, ...config }));
  t.after(() => rm(base, { recursive: true, force: true }));
  return { stateDir, accountDir };
}

type Log = { opens: Map<string, number>; waits: Map<string, number>; clicked: Set<string> };

/** Fake page that logs when setup starts (open) and when its answer wait starts (first poll). */
class Page implements ChatGptPage {
  sent = false; clicks = 0; polls = 0;
  constructor(private id: string, private log: Log, private opts: {
    doneWhen?: () => boolean; showMessage?: boolean; sentAlready?: boolean; signal?: string | null; signalAfterSend?: boolean; onSelect?: () => Promise<void>; now?: () => Date;
  } = {}) { this.sent = !!opts.sentAlready; }
  async open() { this.log.opens.set(this.id, performance.now()); await tick(); return { targetId: `t-${this.id}` }; }
  async reattach() { return true; }
  async attachRepoMcp() { await tick(); }
  async pastePrompt() { await tick(); }
  async selectEffort(label: string) { await this.opts.onSelect?.(); return { selectedAt: this.opts.now?.() ?? new Date(), observedLabel: label }; }
  async clickSend() { this.clicks++; this.sent = true; this.log.clicked.add(this.id); }
  async conversationUrl() { return this.sent ? `https://chatgpt.com/c/${this.id}` : undefined; }
  async hasExpectedUserMessage() { return this.sent && this.opts.showMessage !== false; }
  async turnState(): Promise<TurnState> {
    if (!this.log.waits.has(this.id)) this.log.waits.set(this.id, performance.now());
    this.polls++;
    return (this.opts.doneWhen ?? (() => true))() ? { state: 'done', chars: ANSWER.length } : { state: 'busy', chars: 1 };
  }
  async readAnswer() { return ANSWER; }
  async archive() {}
  async closeTab() {}
  async close() {}
  async accountSignal() { return this.opts.signalAfterSend && !this.sent ? null : this.opts.signal ?? null; }
}

const tick = () => new Promise(r => setTimeout(r, 2));
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, Math.min(ms, 3)));
const newLog = (): Log => ({ opens: new Map(), waits: new Map(), clicked: new Set() });
const req = (f: { stateDir: string; accountDir: string }, requestId: string) => ({
  stateDir: f.stateDir, accountDir: f.accountDir, requestId, repositoryId: 'repo', taskId: 'task',
  coordinator: 'claude' as const, kind: 'architecture', prompt: `${PROMPT}\n${requestId}`
});
const code = (e: unknown, c: string) => (e instanceof GoError || e instanceof AccountError) && e.code === c;

test('two architecture runs on one task run in parallel; setup steps never overlap', async t => {
  const f = await fixture(t);
  const log = newLog();
  // Each answer finishes only after both runs were sent: a serialized driver would deadlock.
  const both = () => log.clicked.size === 2;
  const [a, b] = await Promise.all([
    runGo(req(f, 'a'), { page: new Page('a', log, { doneWhen: both }), sleep }),
    runGo(req(f, 'b'), { page: new Page('b', log, { doneWhen: both }), sleep })
  ]);
  assert.equal(a.phase, 'cleaned');
  assert.equal(b.phase, 'cleaned');
  const [first, second] = ['a', 'b'].sort((x, y) => log.opens.get(x)! - log.opens.get(y)!);
  assert.ok(log.opens.get(second)! >= log.waits.get(first)!, 'the second setup starts only after the first released the lease');
  assert.equal((await accountStatus(f.accountDir)).slots_in_use, 0);
});

test('a third request waits for a free slot and is admitted in FIFO order', async t => {
  const f = await fixture(t, { max_concurrent: 2 });
  const log = newLog();
  let release = false;
  const waits: number[] = [];
  const held = () => release;
  const runs = [
    runGo(req(f, 'a'), { page: new Page('a', log, { doneWhen: held }), sleep }),
    runGo(req(f, 'b'), { page: new Page('b', log, { doneWhen: held }), sleep })
  ];
  while (log.clicked.size < 2) await tick();
  const third = runGo({ ...req(f, 'c'), onWait: p => waits.push(p) }, { page: new Page('c', log), sleep });
  while (!waits.length) await tick();
  assert.equal(waits[0], 1);
  assert.ok(!log.opens.has('c'), 'a queued request opens no tab');
  release = true;
  await Promise.all(runs);
  assert.equal((await third).phase, 'cleaned');
});

test('--no-wait fails with ACCOUNT_BUSY when every slot is used', async t => {
  const f = await fixture(t, { max_concurrent: 1 });
  const log = newLog();
  let release = false;
  const run = runGo(req(f, 'a'), { page: new Page('a', log, { doneWhen: () => release }), sleep });
  while (!log.clicked.size) await tick();
  await assert.rejects(runGo({ ...req(f, 'b'), noWait: true }, { page: new Page('b', log), sleep }), e => code(e, 'ACCOUNT_BUSY'));
  release = true;
  assert.equal((await run).phase, 'cleaned');
});

test('the latch stops fresh work; recovery of a sent run still completes', async t => {
  const f = await fixture(t);
  const log = newLog();
  const h = held('a', log);
  const sent = await runGo(req(f, 'a'), h);
  assert.equal(sent.phase, 'uncertain');
  const store = await StateStore.open(f.accountDir);
  await assert.rejects(setLatch(store, f.accountDir, { code: 'OWNER_STOP', by: 'owner', reason: ' ' }, new Date()), /reason/);
  await setLatch(store, f.accountDir, { code: 'OWNER_STOP', by: 'owner', reason: 'pause' }, new Date());
  await assert.rejects(runGo(req(f, 'b'), { page: new Page('b', log), sleep }), e => code(e, 'ACCOUNT_LATCHED'));
  const resumed = await runGo(req(f, 'a'), { page: new Page('a', log, { sentAlready: true, now: h.now }), sleep: h.sleep, now: h.now });
  assert.equal(resumed.phase, 'cleaned');
  await assert.rejects(clearLatch(store, '', new Date()), /reason/);
  await clearLatch(store, 'resumed', new Date());
  assert.equal((await runGo(req(f, 'b'), { page: new Page('b', log), sleep })).phase, 'cleaned');
});

test('a latch set after reserve but before the commit stops the send with no click', async t => {
  const f = await fixture(t);
  const store = await StateStore.open(f.accountDir);
  const page = new Page('a', newLog(), {
    onSelect: async () => { await setLatch(store, f.accountDir, { code: 'OWNER_STOP', by: 'owner', reason: 'stop now' }, new Date()); }
  });
  const r = await runGo(req(f, 'a'), { page, sleep });
  assert.equal(r.phase, 'failed');
  assert.equal(r.failure_code, 'ACCOUNT_LATCHED');
  assert.equal(r.run_state, 'failed-pre-submit');
  assert.equal(page.clicks, 0);
  assert.equal((await accountStatus(f.accountDir)).slots_in_use, 0);
});

test('a browser challenge during the wait latches the account; the run still completes', async t => {
  const f = await fixture(t);
  const r = await runGo(req(f, 'a'), { page: new Page('a', newLog(), { signal: 'BROWSER_CHALLENGE', signalAfterSend: true }), sleep });
  assert.equal(r.phase, 'cleaned');
  assert.equal((await accountStatus(f.accountDir)).latch?.code, 'BROWSER_CHALLENGE');
  await assert.rejects(runGo(req(f, 'b'), { page: new Page('b', newLog()), sleep }), e => code(e, 'ACCOUNT_LATCHED'));
});

test('with latch_enabled false a challenge sets no latch', async t => {
  const f = await fixture(t, { latch_enabled: false });
  await runGo(req(f, 'a'), { page: new Page('a', newLog(), { signal: 'BROWSER_CHALLENGE' }), sleep });
  assert.equal((await accountStatus(f.accountDir)).latch, null);
});

test('recovery re-adopts a released slot even when every slot is in use', async t => {
  const f = await fixture(t, { max_concurrent: 1 });
  const log = newLog();
  const h = held('a', log);
  assert.equal((await runGo(req(f, 'a'), h)).phase, 'uncertain');
  await releaseGoAdmission(f.stateDir, 'a', 'checked by hand', f.accountDir);
  assert.equal((await runGo(req(f, 'b'), held('b', log))).phase, 'uncertain');
  const resumed = await runGo(req(f, 'a'), { page: new Page('a', log, { sentAlready: true, now: h.now }), sleep: h.sleep, now: h.now });
  assert.equal(resumed.phase, 'cleaned');
  const status = await accountStatus(f.accountDir);
  assert.deepEqual(status.slots.map(s => s.request_id), ['b']);
  assert.equal(status.audit.at(-1)?.reason, 'checked by hand');
});

test('the send gap delays the next setup until the gap after the confirmed send', async t => {
  const f = await fixture(t, { min_gap_seconds: 30 });
  let clock = Date.parse('2026-10-22T10:00:00Z');
  const now = () => new Date(clock);
  const advance = async (ms: number) => { clock += ms; await tick(); };
  const log = newLog();
  const opened: number[] = [];
  const page = (id: string) => { const p = new Page(id, log, { now }); const open = p.open.bind(p); p.open = async () => { opened.push(clock); return open(); }; return p; };
  await runGo(req(f, 'a'), { page: page('a'), sleep: advance, now });
  await runGo(req(f, 'b'), { page: page('b'), sleep: advance, now });
  assert.ok(opened[1] - opened[0] >= 30_000, `second setup ${opened[1] - opened[0]} ms after the first`);
});

test('the hourly cap fails a fresh request before any tab opens; --max-per-hour only lowers it', async t => {
  const f = await fixture(t, { max_per_hour: 2 });
  const log = newLog();
  await runGo(req(f, 'a'), { page: new Page('a', log), sleep });
  await assert.rejects(runGo({ ...req(f, 'b'), maxPerHour: 1 }, { page: new Page('b', log), sleep }), e => code(e, 'RATE_LIMITED'));
  assert.equal((await runGo({ ...req(f, 'c'), maxPerHour: 50 }, { page: new Page('c', log), sleep })).phase, 'cleaned');
  await assert.rejects(runGo(req(f, 'd'), { page: new Page('d', log), sleep }), e => code(e, 'RATE_LIMITED'));
  assert.ok(!log.opens.has('d'));
});

test('coding slots exclude one checkout but not another; legacy slots block coding', async t => {
  const f = await fixture(t);
  const store = await StateStore.open(f.accountDir);
  const slot = (key: string, kind: 'code' | 'architecture', checkout: string | null) => ({ key, requestId: key, stateDir: f.stateDir, kind, checkout });
  await admitSlot(store, f.accountDir, slot('c1', 'code', '/repos/one'), { sleep });
  await assert.rejects(admitSlot(store, f.accountDir, slot('c2', 'code', '/repos/one'), { sleep }), e => code(e, 'REPOSITORY_BUSY'));
  await admitSlot(store, f.accountDir, slot('c3', 'code', '/repos/two'), { sleep });
  await admitSlot(store, f.accountDir, slot('a1', 'architecture', null), { sleep });
  await admitSlot(store, f.accountDir, slot('a2', 'architecture', null), { sleep });
  assert.equal((await accountStatus(f.accountDir)).slots_in_use, 4);
});

test('a dead waiter is dropped from the queue; a dead slot holder is kept', async t => {
  const f = await fixture(t, { max_concurrent: 1 });
  const store = await StateStore.open(f.accountDir);
  await accountStatus(f.accountDir);
  const dead = { pid: 999999, host: os.hostname(), started: null };
  const record = {
    slots: [{ key: 'gone', request_id: 'gone', state_dir: f.stateDir, kind: 'architecture', checkout: null, since: new Date().toISOString(), ...dead }],
    waiting: [{ key: 'ghost', token: 'x', seq: 1, since: new Date().toISOString(), ...dead }],
    next_seq: 2, attempts: [], latch: null, audit: []
  };
  await store.write('account-v2', 'chatgpt-go-account-v2', record);
  await assert.rejects(admitSlot(store, f.accountDir, { key: 'n', requestId: 'n', stateDir: f.stateDir, kind: 'architecture', checkout: null }, { noWait: true, sleep }),
    e => code(e, 'ACCOUNT_BUSY'));
  const status = await accountStatus(f.accountDir);
  assert.deepEqual(status.slots.map(s => s.key), ['gone'], 'a slot may hide an unresolved turn; it is never pruned');
  await releaseSlot(store, 'gone', { action: 'release-slot', reason: 'owner checked', now: new Date() });
  await admitSlot(store, f.accountDir, { key: 'n', requestId: 'n', stateDir: f.stateDir, kind: 'architecture', checkout: null }, { sleep });
  assert.deepEqual((await accountStatus(f.accountDir)).waiting, []);
});

test('v1 admission migrates to v2 and fences 0.3 binaries', async t => {
  const f = await fixture(t);
  const store = await StateStore.open(f.accountDir);
  const at = new Date().toISOString();
  await store.write('account', 'chatgpt-go-account-v1', { active_request_id: 'old@abc', since: at, sends: [at] });
  const status = await accountStatus(f.accountDir);
  assert.equal(status.slots[0].kind, 'legacy');
  assert.equal(status.slots[0].key, 'old@abc');
  assert.equal(status.sends_last_hour, 1);
  const v1 = await store.read<{ active_request_id: string }>('account', 'chatgpt-go-account-v1');
  assert.equal(v1?.active_request_id, 'migrated-to-v2');
  await assert.rejects(admitSlot(store, f.accountDir, { key: 'k', requestId: 'k', stateDir: f.stateDir, kind: 'code', checkout: '/r' }, { sleep }),
    e => code(e, 'REPOSITORY_BUSY'));
});

test('owner config validates keys and values and reports sources', async t => {
  const f = await fixture(t);
  await rm(path.join(f.accountDir, 'config.json'));
  assert.deepEqual((await accountConfig(f.accountDir)).config, { max_concurrent: 10, max_per_hour: 25, min_gap_seconds: 30, latch_enabled: true });
  for (const bad of ['max_concurrent=0', 'max_concurrent=51', 'max_per_hour=x', 'latch_enabled=1', 'bogus=1', 'nonsense']) {
    await assert.rejects(setAccountConfig(bad, f.accountDir), e => code(e, 'ACCOUNT_CONFIG_INVALID'), bad);
  }
  const set = await setAccountConfig('max_concurrent=3', f.accountDir);
  assert.equal(set.config.max_concurrent, 3);
  assert.equal(set.source.max_concurrent, 'config.json');
  assert.equal(JSON.parse(await readFile(path.join(f.accountDir, 'config.json'), 'utf8')).max_concurrent, 3);
  await writeFile(path.join(f.accountDir, 'config.json'), '{"max_per_hour": 0}');
  await assert.rejects(accountConfig(f.accountDir), e => code(e, 'ACCOUNT_CONFIG_INVALID'));
});

test('task finish is refused while another go request uses the task', async t => {
  const f = await fixture(t, { max_concurrent: 1 });
  // Another session holds the only slot, so request `a` waits while holding its request lock.
  const store = await StateStore.open(f.accountDir);
  await admitSlot(store, f.accountDir, { key: 'other', requestId: 'other', stateDir: f.stateDir, kind: 'architecture', checkout: null }, { sleep });
  let waiting = false;
  const run = runGo({ ...req(f, 'a'), onWait: () => { waiting = true; } }, { page: new Page('a', newLog()), sleep });
  while (!waiting) await tick();
  assert.deepEqual(await activeGoRequestsForTask(f.stateDir, 'task'), ['a']);
  await assert.rejects(finishRegisteredTask({ stateDir: f.stateDir, taskId: 'task', result: 'abandoned' }), /TASK_IN_USE/);
  await releaseSlot(store, 'other');
  assert.equal((await run).phase, 'cleaned');
  assert.deepEqual(await activeGoRequestsForTask(f.stateDir, 'task'), []);
  await finishRegisteredTask({ stateDir: f.stateDir, taskId: 'task', result: 'abandoned' });
});

/** Page and clock for a send whose message never shows: the run ends `uncertain` at once. */
function held(id: string, log: Log) {
  const t = fakeTime();
  return { page: new Page(id, log, { showMessage: false, now: t.now }), ...t };
}

/** A fake clock whose sleeps advance it, so a send confirmation can time out at once. */
function fakeTime() {
  let clock = Date.now();
  return { now: () => new Date(clock), sleep: async (ms: number) => { clock += ms; await tick(); } };
}

// --- review round 1 fixes -------------------------------------------------------------------

test('a task finished after prepare stops the send under the share gate with no click', async t => {
  const f = await fixture(t);
  const page = new Page('a', newLog());
  // Model `task finish` winning the race after reserve: the catalog marks the task done.
  const finishTask = async (phase: string) => {
    if (phase !== 'reserved') return;
    const store = await StateStore.open(f.stateDir);
    const catalog = await store.read<any>('control/multirepo-catalog.json', 'multirepo-catalog');
    catalog.tasks.task.completed = true;
    catalog.revision += 1;
    await store.write('control/multirepo-catalog.json', 'multirepo-catalog', catalog);
  };
  const r = await runGo(req(f, 'a'), { page, sleep, afterPhase: finishTask });
  assert.equal(r.phase, 'failed');
  assert.equal(r.failure_code, 'TASK_FINISHED');
  assert.equal(page.clicks, 0);
  assert.equal((await accountStatus(f.accountDir)).slots_in_use, 0);
});

test('a fresh v2 account still fences 0.3 binaries with the v1 sentinel', async t => {
  const f = await fixture(t);
  await accountStatus(f.accountDir);
  const v1 = await (await StateStore.open(f.accountDir)).read<{ active_request_id: string }>('account', 'chatgpt-go-account-v1');
  assert.equal(v1?.active_request_id, 'migrated-to-v2');
});

test('an unreadable go manifest makes task finish fail closed', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.stateDir, 'chatgpt-go', 'f'.repeat(64)), 'not json').catch(async () => {
    await mkdir(path.join(f.stateDir, 'chatgpt-go'), { recursive: true });
    await writeFile(path.join(f.stateDir, 'chatgpt-go', 'f'.repeat(64)), 'not json');
  });
  await assert.rejects(activeGoRequestsForTask(f.stateDir, 'task'), /TASK_IN_USE/);
  await assert.rejects(finishRegisteredTask({ stateDir: f.stateDir, taskId: 'task', result: 'abandoned' }), /TASK_IN_USE/);
});

test('a damaged slot kind fails closed instead of disabling code exclusion', async t => {
  const f = await fixture(t);
  const store = await StateStore.open(f.accountDir);
  await accountStatus(f.accountDir);
  await store.write('account-v2', 'chatgpt-go-account-v2', {
    slots: [{ key: 'x', request_id: 'x', state_dir: f.stateDir, kind: 'coed', checkout: '/r', since: new Date().toISOString(), pid: 1, host: os.hostname(), started: null }],
    waiting: [], next_seq: 1, attempts: [], latch: null, audit: []
  });
  await assert.rejects(admitSlot(store, f.accountDir, { key: 'k', requestId: 'k', stateDir: f.stateDir, kind: 'code', checkout: '/r' }, { sleep }),
    e => code(e, 'ACCOUNT_STATE_CORRUPT'));
});

test('a setup lease held by a reused PID or a dead process is recovered', async t => {
  const f = await fixture(t);
  const store = await StateStore.open(f.accountDir);
  const since = new Date().toISOString();
  // Live PID (this process) but another start time: a reused PID, not the owner.
  await store.write('setup-lease', 'chatgpt-go-setup-lease-v1', { pid: process.pid, host: os.hostname(), started: 'Thu Jan  1 00:00:00 1970', token: 'old', since });
  const lease = await acquireSetupLease(store, sleep);
  await lease.release();
  await store.write('setup-lease', 'chatgpt-go-setup-lease-v1', { pid: 999999, host: os.hostname(), started: null, token: 'dead', since });
  await (await acquireSetupLease(store, sleep)).release();
  assert.equal(await store.read('setup-lease', 'chatgpt-go-setup-lease-v1'), undefined);
});

test('a challenge seen after a setup failure latches the account', async t => {
  const f = await fixture(t);
  const page = new Page('a', newLog(), { signal: 'BROWSER_CHALLENGE' });
  page.attachRepoMcp = async () => { throw new GoError('UI_MISSING:repo-mcp-item'); };
  const r = await runGo(req(f, 'a'), { page, sleep });
  assert.equal(r.phase, 'failed');
  assert.equal((await accountStatus(f.accountDir)).latch?.code, 'BROWSER_CHALLENGE');
});

// --- review round 2 fixes -------------------------------------------------------------------

test('a challenge before the commit stops the send, latches, and clicks nothing', async t => {
  const f = await fixture(t);
  const page = new Page('a', newLog(), { signal: 'BROWSER_CHALLENGE' });
  page.open = async () => ({ targetId: 't-a' });
  // The challenge appears only after selection, right before the commit.
  let selected = false;
  page.accountSignal = async () => selected ? 'BROWSER_CHALLENGE' : null;
  const select = page.selectEffort.bind(page);
  page.selectEffort = async (label: string) => { const r = await select(label); selected = true; return r; };
  const r = await runGo(req(f, 'a'), { page, sleep });
  assert.equal(r.phase, 'failed');
  assert.equal(r.failure_code, 'BROWSER_CHALLENGE');
  assert.equal(r.run_state, 'failed-pre-submit');
  assert.equal(page.clicks, 0);
  assert.equal((await accountStatus(f.accountDir)).latch?.code, 'BROWSER_CHALLENGE');
});

test('a challenge during send confirmation latches the account', async t => {
  const f = await fixture(t);
  const h = held('a', newLog());
  (h.page as Page).accountSignal = async () => (h.page as Page).sent ? 'BROWSER_CHALLENGE' : null;
  assert.equal((await runGo(req(f, 'a'), h)).phase, 'uncertain');
  assert.equal((await accountStatus(f.accountDir)).latch?.code, 'BROWSER_CHALLENGE');
});

test('a click later than the deadline after the commit is not made; the attempt stays charged', async t => {
  const f = await fixture(t);
  const ft = fakeTime();
  const page = new Page('a', newLog(), { now: ft.now });
  // Model a slow intent write: 50 s pass between the commit and the click.
  const late = async (phase: string) => { if (phase === 'send-intent') await ft.sleep(50_000); };
  const r = await runGo(req(f, 'a'), { page, ...ft, afterPhase: late });
  assert.equal(r.phase, 'failed');
  assert.equal(r.failure_code, 'SEND_LATE');
  assert.equal(page.clicks, 0);
  assert.equal((await accountStatus(f.accountDir, ft.now())).sends_last_hour, 1);
});

test('a confirmed send records the observed time, never an earlier bound', async t => {
  const f = await fixture(t);
  const store = await StateStore.open(f.accountDir);
  await admitSlot(store, f.accountDir, { key: 'k', requestId: 'k', stateDir: f.stateDir, kind: 'architecture', checkout: null }, { sleep });
  const t0 = new Date('2026-10-22T10:00:00Z');
  const id = await commitSend(store, f.accountDir, 'k', { now: t0 });
  const late = new Date(t0.getTime() + 300_000);
  await confirmSend(store, id, late);
  const record = await store.read<any>('account-v2', 'chatgpt-go-account-v2');
  assert.equal(record.attempts.find((a: any) => a.id === id).confirmed_at, late.toISOString());
});

test('a journal-completed run frees its slot even when a later step fails', async t => {
  const f = await fixture(t);
  await assert.rejects(runGo(req(f, 'a'), { page: new Page('a', newLog()), sleep, afterPhase: p => { if (p === 'completed') throw new Error('crash'); } }), /crash/);
  assert.equal((await accountStatus(f.accountDir)).slots_in_use, 0);
  assert.equal((await runGo(req(f, 'a'), { page: new Page('a', newLog()), sleep })).phase, 'cleaned');
});

test('a malformed setup lease fails closed instead of being reclaimed', async t => {
  const f = await fixture(t);
  const store = await StateStore.open(f.accountDir);
  await store.write('setup-lease', 'chatgpt-go-setup-lease-v1', { pid: process.pid, host: os.hostname(), token: 'x', since: new Date().toISOString() });
  await assert.rejects(acquireSetupLease(store, sleep), e => code(e, 'ACCOUNT_STATE_CORRUPT'));
});

test('an unreadable request lock counts as a live request for task finish', async t => {
  const f = await fixture(t, { max_concurrent: 1 });
  const store = await StateStore.open(f.accountDir);
  await admitSlot(store, f.accountDir, { key: 'other', requestId: 'other', stateDir: f.stateDir, kind: 'architecture', checkout: null }, { sleep });
  let waiting = false;
  const run = runGo({ ...req(f, 'a'), onWait: () => { waiting = true; } }, { page: new Page('a', newLog()), sleep });
  while (!waiting) await tick();
  const locks = path.join(f.stateDir, 'locks');
  const { readdir } = await import('node:fs/promises');
  const name = (await readdir(locks)).find(n => n.startsWith('chatgpt-go-'))!;
  const original = await readFile(path.join(locks, name));
  await writeFile(path.join(locks, name), 'garbage');
  assert.deepEqual(await activeGoRequestsForTask(f.stateDir, 'task'), ['a']);
  await writeFile(path.join(locks, name), original);
  await releaseSlot(store, 'other');
  assert.equal((await run).phase, 'cleaned');
});

// --- review round 3 fixes -------------------------------------------------------------------

test('a failed click moves the attempt bound past the settle window and confirms for that long', async t => {
  const f = await fixture(t);
  const ft = fakeTime();
  const page = new Page('a', newLog(), { now: ft.now, showMessage: false });
  page.clickSend = async () => { page.clicks++; throw new GoError('CDP_TIMEOUT'); };
  const start = ft.now().getTime();
  const r = await runGo(req(f, 'a'), { page, ...ft });
  assert.equal(r.phase, 'uncertain');
  assert.ok(ft.now().getTime() - start >= 60_000, 'confirmation kept polling for the settle window');
  const record = await (await StateStore.open(f.accountDir)).read<any>('account-v2', 'chatgpt-go-account-v2');
  const attempt = record.attempts.at(-1);
  assert.ok(Date.parse(attempt.bound) - Date.parse(attempt.at) >= 60_000);
});

test('a latch that cannot be written falls back to a marker that stops admission', async t => {
  const f = await fixture(t);
  const store = await StateStore.open(f.accountDir);
  await accountStatus(f.accountDir);
  const good = await store.read<any>('account-v2', 'chatgpt-go-account-v2');
  await store.write('account-v2', 'chatgpt-go-account-v2', { ...good, slots: 'broken' });
  assert.equal(await setLatch(store, f.accountDir, { code: 'BROWSER_CHALLENGE', by: 'driver' }, new Date()), true);
  await store.write('account-v2', 'chatgpt-go-account-v2', good);
  const slot = { key: 'k', requestId: 'k', stateDir: f.stateDir, kind: 'architecture' as const, checkout: null };
  await assert.rejects(admitSlot(store, f.accountDir, slot, { sleep }), e => code(e, 'ACCOUNT_LATCHED'));
  assert.equal((await accountStatus(f.accountDir)).latch_fallback, true);
  await clearLatch(store, 'checked', new Date());
  await admitSlot(store, f.accountDir, slot, { sleep });
});

test('a setup-lease release that cannot read the lease is raised, not swallowed', async t => {
  const f = await fixture(t);
  const store = await StateStore.open(f.accountDir);
  const lease = await acquireSetupLease(store, sleep);
  await writeFile(path.join(f.accountDir, 'setup-lease'), 'garbage');
  await assert.rejects(lease.release());
});
