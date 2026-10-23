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

// --- review round 4 fixes -------------------------------------------------------------------

test('a dead lease owner (killed process) is taken over in place; nobody else sets up during the settle window', async t => {
  const f = await fixture(t);
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--import', 'tsx', path.join('test', 'fixtures-go', 'hold-lease.ts'), f.accountDir], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', d => { if (String(d).includes('held')) resolve(); });
    child.on('exit', c => reject(new Error(`child exited ${c}`)));
  });
  child.kill('SIGKILL');
  await new Promise(r => child.once('exit', r));
  const store = await StateStore.open(f.accountDir);
  const events: string[] = [];
  let settling!: () => void;
  const settleGate = new Promise<void>(r => { settling = r; });
  // B recovers the dead lease and waits out the settle window (held open by the test).
  const b = acquireSetupLease(store, async ms => { if (ms >= 60_000) { events.push('b-settling'); await settleGate; } else await tick(); })
    .then(lease => { events.push('b-acquired'); return lease; });
  while (!events.includes('b-settling')) await tick();
  const c = acquireSetupLease(store, async () => { await tick(); }).then(lease => { events.push('c-acquired'); return lease; });
  for (let i = 0; i < 20; i++) await tick();
  assert.ok(!events.includes('c-acquired'), 'C must not set up while B settles the dead owner\'s lease');
  settling();
  await (await b).release();
  await (await c).release();
  assert.deepEqual(events, ['b-settling', 'b-acquired', 'c-acquired']);
});

test('a challenge whose latch cannot be persisted anywhere fails the run and keeps its slot', async t => {
  const f = await fixture(t);
  const { chmod } = await import('node:fs/promises');
  const page = new Page('a', newLog());
  page.open = async () => { await chmod(f.accountDir, 0o500); throw new GoError('BROWSER_CHALLENGE'); };
  t.after(() => chmod(f.accountDir, 0o700).catch(() => {}));
  await assert.rejects(runGo(req(f, 'a'), { page, sleep, latchRetries: 2 }), e => code(e, 'LATCH_WRITE_FAILED'));
  await chmod(f.accountDir, 0o700);
  assert.deepEqual((await accountStatus(f.accountDir)).slots.map(s => s.request_id), ['a']);
});

test('a request lock whose PID was reused does not count as a live request', async t => {
  const f = await fixture(t, { max_concurrent: 1 });
  const store = await StateStore.open(f.accountDir);
  await admitSlot(store, f.accountDir, { key: 'other', requestId: 'other', stateDir: f.stateDir, kind: 'architecture', checkout: null }, { sleep });
  await assert.rejects(runGo({ ...req(f, 'a'), noWait: true }, { page: new Page('a', newLog()), sleep }), e => code(e, 'ACCOUNT_BUSY'));
  const state = await StateStore.open(f.stateDir);
  const { sha256 } = await import('../src/errors.js');
  const lockRel = `locks/chatgpt-go-${sha256('chatgpt-go\0a').slice(0, 16)}.json`;
  const lock = { pid: process.pid, hostname: os.hostname(), token: 't', purpose: 'chatgpt-go request', acquired_at: '1990-01-01T00:00:00.000Z' };
  await state.write(lockRel, 'lock', lock);
  assert.deepEqual(await activeGoRequestsForTask(f.stateDir, 'task'), [], 'this process started after 1990: the PID was reused');
  await state.write(lockRel, 'lock', { ...lock, acquired_at: new Date().toISOString() });
  assert.deepEqual(await activeGoRequestsForTask(f.stateDir, 'task'), ['a']);
  await state.remove(lockRel);
});

// --- review round 5 fixes -------------------------------------------------------------------

test('a challenge before the commit whose latch cannot be persisted keeps the slot; a rerun persists it', async t => {
  const f = await fixture(t);
  const { chmod } = await import('node:fs/promises');
  t.after(() => chmod(f.accountDir, 0o700).catch(() => {}));
  const page = new Page('a', newLog());
  let selected = false;
  page.accountSignal = async () => selected ? 'BROWSER_CHALLENGE' : null;
  page.selectEffort = async (label: string) => { selected = true; await chmod(f.accountDir, 0o500); return { selectedAt: new Date(), observedLabel: label }; };
  const r = await runGo(req(f, 'a'), { page, sleep, latchRetries: 2 }).catch(e => e);
  assert.equal(r.phase, 'failed');
  assert.equal(page.clicks, 0);
  await chmod(f.accountDir, 0o700);
  assert.deepEqual((await accountStatus(f.accountDir)).slots.map(s => s.request_id), ['a'], 'an unpersisted stop keeps the slot');
  await runGo(req(f, 'a'), { page: new Page('a', newLog()), sleep });
  const status = await accountStatus(f.accountDir);
  assert.equal(status.latch?.code, 'BROWSER_CHALLENGE', 'the rerun persisted the pending latch');
  assert.equal(status.slots_in_use, 0);
});

test('coding recovery never adopts a slot beside a migrated legacy slot', async t => {
  const f = await fixture(t);
  const store = await StateStore.open(f.accountDir);
  const at = new Date().toISOString();
  await store.write('account', 'chatgpt-go-account-v1', { active_request_id: 'old@abc', since: at, sends: [] });
  await accountStatus(f.accountDir);
  const { adoptSlot } = await import('../src/go-account.js');
  await assert.rejects(adoptSlot(store, { key: 'k', requestId: 'k', stateDir: f.stateDir, kind: 'code', checkout: '/r' }, new Date()), e => code(e, 'REPOSITORY_BUSY'));
  // The legacy request itself re-adopts with its real kind and checkout.
  await adoptSlot(store, { key: 'old@abc', requestId: 'old', stateDir: f.stateDir, kind: 'code', checkout: '/r' }, new Date());
  const slot = (await accountStatus(f.accountDir)).slots[0];
  assert.equal(slot.kind, 'code');
  assert.equal(slot.checkout, '/r');
});

// --- review round 6 fixes -------------------------------------------------------------------

test('the checkout quiet scan fails closed on unreadable, unknown or live exec sessions', async t => {
  const f = await fixture(t);
  const { execSessionsQuiet } = await import('../src/exec-tool.js');
  const store = await StateStore.open(f.stateDir);
  const since = '2026-10-22T10:00:00.000Z';
  const rec = (over: Record<string, unknown>) => ({ session_id: 's', workspace_id: 'w', repository_id: 'repo', task_id: 'task', request_id: 'r',
    request_digest: 'd', cmd: 'x', cmd_sha256: 'h', cmd_length: 1, timeout_s: 1, state: 'running', reason: null, exit_code: null, signal: null,
    output_bytes: 0, truncated: false, broker_instance: 'b', broker_pid: 999999, created_at: '2026-10-22T11:00:00.000Z', started_at: null,
    ended_at: null, duration_ms: null, ...over });
  const at = (n: string) => `exec-sessions/task/${n.repeat(32)}.json`;
  assert.deepEqual(await execSessionsQuiet(f.stateDir, 'task', since), { quiet: true });
  await store.write(at('a'), 'exec-session-v1', rec({}));
  assert.equal((await execSessionsQuiet(f.stateDir, 'task', since)).quiet, false, 'dead broker with unknown process group');
  await store.write(at('a'), 'exec-session-v1', rec({ pgid: 999998 }));
  assert.equal((await execSessionsQuiet(f.stateDir, 'task', since)).quiet, true, 'dead broker and dead process group');
  await store.write(at('a'), 'exec-session-v1', rec({ broker_pid: process.pid }));
  assert.equal((await execSessionsQuiet(f.stateDir, 'task', since)).quiet, false, 'live broker');
  await store.write(at('a'), 'exec-session-v1', rec({ broker_pid: process.pid, created_at: '2026-10-22T09:00:00.000Z' }));
  assert.equal((await execSessionsQuiet(f.stateDir, 'task', since)).quiet, true, 'a session from before this request is not its concern');
  await writeFile(path.join(f.stateDir, at('b')), 'garbage');
  assert.equal((await execSessionsQuiet(f.stateDir, 'task', since)).quiet, false, 'unreadable record');
});

test('a terminal coding request with an unsealed workspace keeps the task in use', async t => {
  const f = await fixture(t);
  const store = await StateStore.open(f.stateDir);
  const now = new Date().toISOString();
  await store.write(`chatgpt-go/${'c'.repeat(64)}`, 'chatgpt-go-v1', {
    request_id: 'code-x', request_digest: 'd', repository_id: 'repo', task_id: 'task', coordinator: 'claude', kind: 'code', profile: 'code',
    prompt_sha256: 'p', prompt_file: '', session_id: 's', created_at: now, updated_at: now, phase: 'failed', grant_id: 'g', sealed: 'warning:SEAL_FAILED'
  });
  assert.deepEqual(await activeGoRequestsForTask(f.stateDir, 'task'), ['code-x']);
});

// --- review round 7 fixes -------------------------------------------------------------------

const execRecord = (over: Record<string, unknown>) => ({ session_id: 's', workspace_id: 'w', repository_id: 'repo', task_id: 'task', request_id: 'r',
  request_digest: 'd', cmd: 'x', cmd_sha256: 'h', cmd_length: 1, timeout_s: 1, state: 'running', reason: null, exit_code: null, signal: null,
  output_bytes: 0, truncated: false, broker_instance: 'b', broker_pid: 999999, created_at: new Date().toISOString(), started_at: null,
  ended_at: null, duration_ms: null, ...over });

test('the quiet scan treats unknown exec states as busy and a reused broker PID as dead', async t => {
  const f = await fixture(t);
  const { execSessionsQuiet } = await import('../src/exec-tool.js');
  const store = await StateStore.open(f.stateDir);
  const rel = `exec-sessions/task/${'a'.repeat(32)}.json`;
  await store.write(rel, 'exec-session-v1', execRecord({ state: 'runnng' }));
  assert.equal((await execSessionsQuiet(f.stateDir, 'task', '1989-01-01T00:00:00Z')).quiet, false);
  // This process started long after 1990: as the broker of a 1990 session its PID was reused.
  await store.write(rel, 'exec-session-v1', execRecord({ broker_pid: process.pid, created_at: '1990-01-01T00:00:00.000Z', pgid: 999998 }));
  assert.equal((await execSessionsQuiet(f.stateDir, 'task', '1989-01-01T00:00:00Z')).quiet, true);
});

test('a terminal sealed coding request with a live exec command keeps the task in use', async t => {
  const f = await fixture(t);
  const store = await StateStore.open(f.stateDir);
  const now = new Date(Date.now() - 1000).toISOString();
  await store.write(`chatgpt-go/${'d'.repeat(64)}`, 'chatgpt-go-v1', {
    request_id: 'code-y', request_digest: 'd', repository_id: 'repo', task_id: 'task', coordinator: 'claude', kind: 'code', profile: 'code',
    prompt_sha256: 'p', prompt_file: '', session_id: 's', created_at: now, updated_at: now, phase: 'cleaned', grant_id: 'g', sealed: 'revoked'
  });
  assert.deepEqual(await activeGoRequestsForTask(f.stateDir, 'task'), []);
  await store.write(`exec-sessions/task/${'e'.repeat(32)}.json`, 'exec-session-v1', execRecord({ broker_pid: process.pid }));
  assert.deepEqual(await activeGoRequestsForTask(f.stateDir, 'task'), ['code-y']);
});

test('a fresh request re-entering its slot still stops at the owner latch', async t => {
  const f = await fixture(t);
  const store = await StateStore.open(f.accountDir);
  const slot = { key: 'k', requestId: 'k', stateDir: f.stateDir, kind: 'architecture' as const, checkout: null };
  await admitSlot(store, f.accountDir, slot, { sleep });
  await setLatch(store, f.accountDir, { code: 'OWNER_STOP', by: 'owner', reason: 'stop' }, new Date());
  await assert.rejects(admitSlot(store, f.accountDir, slot, { sleep }), e => code(e, 'ACCOUNT_LATCHED'));
});

// --- review round 8 fixes -------------------------------------------------------------------

test('before any click input the attempt bound covers the whole click sequence and its settle window', async t => {
  const f = await fixture(t);
  const page = new Page('a', newLog());
  let seen: { bound: number; at: number; budget: number } | undefined;
  const click = page.clickSend.bind(page);
  page.clickSend = async (budget?: number) => {
    const record = await (await StateStore.open(f.accountDir)).read<any>('account-v2', 'chatgpt-go-account-v2');
    const a = record.attempts.at(-1);
    seen = { bound: Date.parse(a.bound), at: Date.parse(a.at), budget: budget ?? Infinity };
    await click();
  };
  assert.equal((await runGo(req(f, 'a'), { page, sleep })).phase, 'cleaned');
  assert.ok(seen!.bound - seen!.at >= 45_000 + 60_000 + 60_000, 'a crash mid-click leaves a bound past every possible press');
  assert.ok(seen!.budget > 0 && seen!.budget <= 45_000, 'the page gets the remaining press budget');
  const after = await (await StateStore.open(f.accountDir)).read<any>('account-v2', 'chatgpt-go-account-v2');
  assert.ok(after.attempts.at(-1).confirmed_at, 'a clean click is confirmed at the observed time');
});

test('a press budget that runs out inside the page clicks nothing and fails pre-submit', async t => {
  const f = await fixture(t);
  const page = new Page('a', newLog());
  page.clickSend = async () => { throw new GoError('SEND_NOT_CLICKED'); };
  const r = await runGo(req(f, 'a'), { page, sleep });
  assert.equal(r.phase, 'failed');
  assert.equal(r.failure_code, 'SEND_LATE');
  assert.equal(r.run_state, 'failed-pre-submit');
  assert.equal((await accountStatus(f.accountDir)).slots_in_use, 0);
});

// --- review round 9 fixes -------------------------------------------------------------------

test('a project check whose process group still runs keeps the coding request in use', async t => {
  const f = await fixture(t);
  const { spawn } = await import('node:child_process');
  const child = spawn('/bin/sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } });
  const store = await StateStore.open(f.stateDir);
  const now = new Date(Date.now() - 1000).toISOString();
  const manifest = {
    request_id: 'code-z', request_digest: 'd', repository_id: 'repo', task_id: 'task', coordinator: 'claude', kind: 'code', profile: 'code',
    prompt_sha256: 'p', prompt_file: '', session_id: 's', created_at: now, updated_at: now, phase: 'cleaned', grant_id: 'g', sealed: 'revoked',
    check_running: { index: 0, pgid: child.pid }
  };
  await store.write(`chatgpt-go/${'9'.repeat(64)}`, 'chatgpt-go-v1', manifest);
  assert.deepEqual(await activeGoRequestsForTask(f.stateDir, 'task'), ['code-z']);
  process.kill(-child.pid!, 'SIGKILL');
  await new Promise(r => child.once('exit', r));
  assert.deepEqual(await activeGoRequestsForTask(f.stateDir, 'task'), []);
});

// --- review round 10 fixes ------------------------------------------------------------------

test('a project check runs only after its process group is recorded; a failed record means it never runs', async t => {
  const f = await fixture(t);
  const { runCheck } = await import('../src/go-checks.js');
  const dir = path.dirname(f.stateDir);
  const marker = path.join(dir, 'ran.txt');
  const recorded: number[] = [];
  const ok = await runCheck(dir, `echo ran > ${marker}`, path.join(dir, 'ok.log'), async pgid => { recorded.push(pgid); });
  assert.equal(ok.exit_code, 0);
  assert.equal(recorded.length, 1);
  assert.equal(await readFile(marker, 'utf8'), 'ran\n');
  await rm(marker);
  await assert.rejects(runCheck(dir, `echo ran > ${marker}`, path.join(dir, 'bad.log'), async () => { throw new Error('disk full'); }), /disk full/);
  await new Promise(r => setTimeout(r, 300));
  await assert.rejects(readFile(marker), /ENOENT/, 'an unrecorded check never runs its command');
});

test('a go manifest with an unknown kind fails task finish closed', async t => {
  const f = await fixture(t);
  const store = await StateStore.open(f.stateDir);
  const now = new Date().toISOString();
  await store.write(`chatgpt-go/${'8'.repeat(64)}`, 'chatgpt-go-v1', {
    request_id: 'x', request_digest: 'd', repository_id: 'repo', task_id: 'task', coordinator: 'claude', kind: 'coed', profile: 'code',
    prompt_sha256: 'p', prompt_file: '', session_id: 's', created_at: now, updated_at: now, phase: 'cleaned', grant_id: 'g', sealed: 'warning:X'
  });
  await assert.rejects(activeGoRequestsForTask(f.stateDir, 'task'), /TASK_IN_USE/);
});

// --- review round 11 fixes ------------------------------------------------------------------

test('task finish fails closed on a future created_at and counts a live check without a grant', async t => {
  const f = await fixture(t);
  const store = await StateStore.open(f.stateDir);
  const now = new Date().toISOString();
  const base = { request_digest: 'd', repository_id: 'repo', task_id: 'task', coordinator: 'claude', kind: 'code', profile: 'code',
    prompt_sha256: 'p', prompt_file: '', session_id: 's', updated_at: now, phase: 'cleaned' };
  await store.write(`chatgpt-go/${'7'.repeat(64)}`, 'chatgpt-go-v1', { ...base, request_id: 'future', created_at: '9999-01-01T00:00:00.000Z', grant_id: 'g', sealed: 'revoked' });
  await assert.rejects(activeGoRequestsForTask(f.stateDir, 'task'), /TASK_IN_USE/);
  await store.remove(`chatgpt-go/${'7'.repeat(64)}`);
  const { spawn } = await import('node:child_process');
  const child = spawn('/bin/sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } });
  await store.write(`chatgpt-go/${'6'.repeat(64)}`, 'chatgpt-go-v1', { ...base, kind: 'architecture', request_id: 'arch', created_at: now, check_running: { index: 0, pgid: child.pid } });
  assert.deepEqual(await activeGoRequestsForTask(f.stateDir, 'task'), []);
  await store.write(`chatgpt-go/${'6'.repeat(64)}`, 'chatgpt-go-v1', { ...base, kind: 'code', request_id: 'code-ng', created_at: now, grant_id: 'g', sealed: 'revoked', check_running: { index: 0, pgid: child.pid } });
  assert.deepEqual(await activeGoRequestsForTask(f.stateDir, 'task'), ['code-ng']);
});

// --- review round 12 fixes ------------------------------------------------------------------

test('a finished exec record whose process group is still alive is not quiet', async t => {
  const f = await fixture(t);
  const { execSessionsQuiet } = await import('../src/exec-tool.js');
  const { spawn } = await import('node:child_process');
  const child = spawn('/bin/sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } });
  const store = await StateStore.open(f.stateDir);
  const rel = `exec-sessions/task/${'f'.repeat(32)}.json`;
  await store.write(rel, 'exec-session-v1', execRecord({ state: 'exited', pgid: child.pid, started_at: new Date().toISOString() }));
  assert.equal((await execSessionsQuiet(f.stateDir, 'task', '1989-01-01T00:00:00Z')).quiet, false);
  process.kill(-child.pid!, 'SIGKILL');
  await new Promise(r => child.once('exit', r));
  assert.equal((await execSessionsQuiet(f.stateDir, 'task', '1989-01-01T00:00:00Z')).quiet, true);
  await store.write(rel, 'exec-session-v1', execRecord({ state: 'exited', started_at: new Date().toISOString() }));
  assert.equal((await execSessionsQuiet(f.stateDir, 'task', '1989-01-01T00:00:00Z')).quiet, false, 'ran with no recorded group');
  await store.write(rel, 'exec-session-v1', execRecord({ state: 'failed', started_at: null }));
  assert.equal((await execSessionsQuiet(f.stateDir, 'task', '1989-01-01T00:00:00Z')).quiet, true, 'never spawned');
});

test('a latch write that fails once then succeeds frees the slot at the end of the run', async t => {
  const f = await fixture(t);
  const { chmod } = await import('node:fs/promises');
  t.after(() => chmod(f.accountDir, 0o700).catch(() => {}));
  const page = new Page('a', newLog());
  let selected = false;
  page.accountSignal = async () => selected ? 'BROWSER_CHALLENGE' : null;
  page.selectEffort = async (label: string) => { selected = true; await chmod(f.accountDir, 0o500); return { selectedAt: new Date(), observedLabel: label }; };
  // The first latch retry wait restores the store, so the next attempt persists the latch.
  const heal = async (ms: number) => { if (ms === 5_000) await chmod(f.accountDir, 0o700); await tick(); };
  const r = await runGo(req(f, 'a'), { page, sleep: heal });
  assert.equal(r.phase, 'failed');
  assert.equal(page.clicks, 0);
  const status = await accountStatus(f.accountDir);
  assert.equal(status.latch?.code, 'BROWSER_CHALLENGE');
  assert.equal(status.slots_in_use, 0);
});
