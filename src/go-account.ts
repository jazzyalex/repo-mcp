import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeError } from './errors.js';
import { StateStore, acquireLock, lockOwnerAlive } from './task-state.js';

// Account-wide admission for `chatgpt-run go` (docs/GO-CONCURRENCY-SPEC.md). Every state
// dir drives the same main-Chrome ChatGPT account, so slots, the send budget, the setup
// lease and the stop latch live in one owner-only store per OS user.

/** One admission store per OS user: every state dir drives the same main-Chrome ChatGPT account. */
export const DEFAULT_ACCOUNT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'repo-mcp', 'chatgpt-account');
const V1_KIND = 'chatgpt-go-account-v1';
const V1_PATH = 'account';
const V1_SENTINEL = 'migrated-to-v2';
const KIND = 'chatgpt-go-account-v2';
const PATH = 'account-v2';
const CONFIG_FILE = 'config.json';
const HOUR_MS = 3_600_000;
/**
 * Latest time a committed send can still reach ChatGPT when its confirmation is never
 * seen. The driver clicks only within SEND_CLICK_DEADLINE_MS of the commit, and one CDP
 * command times out after 30 s, so the click cannot land later than this.
 */
export const SEND_BOUND_MS = 120_000;
export const SEND_CLICK_DEADLINE_MS = 45_000;
/** Longest the press and release commands can take after the press starts: 30 s each. */
export const CLICK_SEQUENCE_MAX_MS = 60_000;
/**
 * A click command that failed or timed out may still run in Chrome: the driver keeps the
 * setup lease and moves the attempt bound this far past the failure while it settles.
 */
export const CLICK_SETTLE_MS = 60_000;
/** Durable stop written next to the record when the latch itself cannot be written. */
const LATCH_FALLBACK = 'latch-fallback.json';
const WAIT_POLL_MS = 5_000;
const LEASE_POLL_MS = 1_000;
/** After a lease owner died, input it already sent may still run: wait as long as a click settles. */
const LEASE_SETTLE_MS = 60_000;

/** Error with a reported failure code; `chatgpt-go.ts` maps it onto GoError. */
export class AccountError extends SafeError {
  constructor(readonly code: string, message = code) { super(message); }
}

// --- owner configuration ---------------------------------------------------------------

export type AccountConfig = { max_concurrent: number; max_per_hour: number; min_gap_seconds: number; latch_enabled: boolean; page_text_fallback: boolean };

const CONFIG_KEYS: Record<keyof AccountConfig, { default: number | boolean; min?: number; max?: number }> = {
  max_concurrent: { default: 10, min: 1, max: 50 },
  max_per_hour: { default: 25, min: 1, max: 500 },
  min_gap_seconds: { default: 30, min: 0, max: 3600 },
  latch_enabled: { default: true },
  // Off by default: without a `finish` report, go reads the answer from the page only when the owner opts in.
  page_text_fallback: { default: false }
};

function checkValue(key: string, value: unknown): number | boolean {
  const spec = CONFIG_KEYS[key as keyof AccountConfig];
  if (!spec) throw new AccountError('ACCOUNT_CONFIG_INVALID', `Unknown account config key ${key}; valid keys: ${Object.keys(CONFIG_KEYS).join(', ')}.`);
  if (typeof spec.default === 'boolean') {
    if (typeof value !== 'boolean') throw new AccountError('ACCOUNT_CONFIG_INVALID', `${key} must be true or false.`);
    return value;
  }
  if (!Number.isSafeInteger(value) || (value as number) < spec.min! || (value as number) > spec.max!) {
    throw new AccountError('ACCOUNT_CONFIG_INVALID', `${key} must be an integer from ${spec.min} to ${spec.max}.`);
  }
  return value as number;
}

async function readConfigFile(dir: string): Promise<Record<string, unknown>> {
  let text: string;
  try { text = await readFile(path.join(dir, CONFIG_FILE), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new AccountError('ACCOUNT_CONFIG_INVALID', `Cannot read ${CONFIG_FILE}: ${(error as Error).message}`);
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new AccountError('ACCOUNT_CONFIG_INVALID', `${CONFIG_FILE} is not valid JSON.`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AccountError('ACCOUNT_CONFIG_INVALID', `${CONFIG_FILE} must hold a JSON object.`);
  return raw as Record<string, unknown>;
}

/** Effective configuration and where each value came from. */
export async function accountConfig(dir = DEFAULT_ACCOUNT_DIR) {
  const raw = await readConfigFile(dir);
  const config = {} as Record<string, number | boolean>;
  const source = {} as Record<string, 'default' | 'config.json'>;
  for (const key of Object.keys(raw)) checkValue(key, raw[key]);
  for (const [key, spec] of Object.entries(CONFIG_KEYS)) {
    config[key] = Object.hasOwn(raw, key) ? raw[key] as number | boolean : spec.default;
    source[key] = Object.hasOwn(raw, key) ? 'config.json' : 'default';
  }
  return { config: config as AccountConfig, source, file: path.join(dir, CONFIG_FILE) };
}

/** Validate one `KEY=VALUE` and write the config file atomically (mode 600). */
export async function setAccountConfig(assignment: string, dir = DEFAULT_ACCOUNT_DIR) {
  const match = /^([a-z_]+)=(.+)$/.exec(assignment.trim());
  if (!match) throw new AccountError('ACCOUNT_CONFIG_INVALID', 'Use KEY=VALUE, for example max_concurrent=10.');
  const [, key, text] = match;
  const value = text === 'true' ? true : text === 'false' ? false : /^-?\d+$/.test(text) ? Number(text) : text;
  checkValue(key, value);
  return withAccountLock(await StateStore.open(dir), async () => {
    const raw = await readConfigFile(dir);
    for (const k of Object.keys(raw)) checkValue(k, raw[k]);
    const next = { ...raw, [key]: value };
    const file = path.join(dir, CONFIG_FILE);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, file);
    return accountConfig(dir);
  });
}

// --- account record --------------------------------------------------------------------

export type SlotKind = 'architecture' | 'review' | 'code' | 'legacy';
type Owner = { pid: number; host: string; started: string | null };
export type Slot = Owner & { key: string; request_id: string; state_dir: string; kind: SlotKind; checkout: string | null; since: string };
type Waiter = Owner & { key: string; token: string; seq: number; since: string };
type Attempt = { id: string; key: string; at: string; bound: string; confirmed_at?: string };
type Latch = { code: string; at: string; key?: string; reason?: string; by: 'driver' | 'owner' };
type Audit = { at: string; action: string; key: string | null; reason: string };
export type AccountRecord = { slots: Slot[]; waiting: Waiter[]; next_seq: number; attempts: Attempt[]; latch: Latch | null; audit: Audit[] };

const SLOT_KINDS = new Set<string>(['architecture', 'review', 'code', 'legacy']);
const empty = (): AccountRecord => ({ slots: [], waiting: [], next_seq: 1, attempts: [], latch: null, audit: [] });
const iso = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const corrupt = (why: string) => new AccountError('ACCOUNT_STATE_CORRUPT', `Corrupt ChatGPT account record (${why}); inspect ${PATH} before continuing.`);

function validate(raw: unknown): AccountRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw corrupt('not an object');
  const r = raw as AccountRecord;
  if (!Array.isArray(r.slots) || !Array.isArray(r.waiting) || !Array.isArray(r.attempts) || !Array.isArray(r.audit)) throw corrupt('missing lists');
  if (!Number.isSafeInteger(r.next_seq) || r.next_seq < 1) throw corrupt('next_seq');
  const str = (v: unknown) => typeof v === 'string';
  const owner = (o: Owner) => Number.isSafeInteger(o.pid) && o.pid >= 0 && str(o.host) && (o.started === null || str(o.started));
  const keys = new Set<string>();
  for (const s of r.slots) {
    if (!s || !str(s.key) || !s.key || keys.has(s.key) || !iso(s.since) || !owner(s) || !str(s.request_id) || !str(s.state_dir) ||
        !SLOT_KINDS.has(s.kind) || (s.checkout !== null && !str(s.checkout)) || (s.kind === 'code' && !s.checkout)) throw corrupt('slot');
    keys.add(s.key);
  }
  let seq = 0;
  for (const w of r.waiting) {
    if (!w || !str(w.key) || keys.has(w.key) || !str(w.token) || !w.token || !Number.isSafeInteger(w.seq) || w.seq <= seq ||
        w.seq >= r.next_seq || !iso(w.since) || !owner(w)) throw corrupt('waiter');
    keys.add(w.key);
    seq = w.seq;
  }
  const ids = new Set<string>();
  for (const a of r.attempts) {
    if (!a || !str(a.id) || ids.has(a.id) || !str(a.key) || !iso(a.at) || !iso(a.bound) || (a.confirmed_at !== undefined && !iso(a.confirmed_at))) throw corrupt('attempt');
    ids.add(a.id);
  }
  if (r.latch !== null && (typeof r.latch !== 'object' || !str(r.latch.code) || !iso(r.latch.at) || (r.latch.by !== 'driver' && r.latch.by !== 'owner'))) throw corrupt('latch');
  return r;
}

/** Read the v2 record, migrating from v1 (restartably) on first use. Call only under the account lock. */
async function load(store: StateStore): Promise<AccountRecord> {
  const v1 = await store.read<{ active_request_id: string | null; since: string | null; sends: string[] }>(V1_PATH, V1_KIND);
  let current = await store.read<unknown>(PATH, KIND);
  if (current === undefined) {
    const next = empty();
    if (v1 && Array.isArray(v1.sends)) {
      for (const at of v1.sends.filter(iso)) next.attempts.push({ id: randomUUID(), key: 'legacy', at, bound: at, confirmed_at: at });
    }
    if (v1?.active_request_id && v1.active_request_id !== V1_SENTINEL) {
      next.slots.push({ key: v1.active_request_id, request_id: v1.active_request_id.split('@')[0], state_dir: '', kind: 'legacy',
        checkout: null, since: v1.since && iso(v1.since) ? v1.since : new Date().toISOString(), pid: 0, host: '', started: null });
    }
    await store.write(PATH, KIND, next);
    current = next;
  }
  // Fence 0.3 binaries, even on a fresh install: they only know v1 and now always see an
  // unresolved request.
  if (!v1 || v1.active_request_id !== V1_SENTINEL) {
    await store.write(V1_PATH, V1_KIND, { active_request_id: V1_SENTINEL, since: new Date().toISOString(), sends: v1?.sends ?? [] });
  }
  return validate(current);
}

async function withAccountLock<T>(store: StateStore, fn: () => Promise<T>) {
  const deadline = Date.now() + 10_000;
  while (true) {
    let lock;
    try { lock = await acquireLock(store, 'chatgpt-go-account', 'chatgpt-go account admission', { recoverStale: true }); }
    catch (error) {
      if (Date.now() > deadline || !(error instanceof Error) || !/live process|recovery is already in progress/.test(error.message)) throw error;
      await new Promise(r => setTimeout(r, 25));
      continue;
    }
    try { return await fn(); } finally { await lock.release(); }
  }
}

/** Run `fn` on the record under the account lock; a returned record is written back. */
async function update<T>(store: StateStore, fn: (account: AccountRecord) => Promise<{ value: T; next?: AccountRecord }> | { value: T; next?: AccountRecord }) {
  return withAccountLock(store, async () => {
    const { value, next } = await fn(await load(store));
    if (next) await store.write(PATH, KIND, validate(next));
    return value;
  });
}

// --- process identity --------------------------------------------------------------------

const startCache = new Map<number, string | null>();
/** Process start time, so a reused PID is not taken for the original owner. */
function processStart(pid: number): string | null {
  if (pid === process.pid && startCache.has(pid)) return startCache.get(pid)!;
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 });
  const value = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  if (pid === process.pid) startCache.set(pid, value);
  return value;
}

const self = (): Owner => ({ pid: process.pid, host: os.hostname(), started: processStart(process.pid) });

/**
 * True when the process now running as `pid` started after `since`: the PID was reused,
 * so a lock taken at `since` does not belong to it. Unknown start times are not reuse.
 */
export function pidReusedSince(pid: number, since: string) {
  const start = processStart(pid);
  const started = start ? Date.parse(start) : NaN;
  return Number.isFinite(started) && Number.isFinite(Date.parse(since)) && started > Date.parse(since) + 1_000;
}

/** A process with no recorded start time is trusted for at most this long. */
const UNKNOWN_START_TRUST_MS = 6 * HOUR_MS;

/** Same PID and same start time on this host; an owner on another host cannot be checked. */
function ownerAlive(o: Owner, since: string) {
  if (o.host !== os.hostname()) return true;
  if (!lockOwnerAlive(o.pid)) return false;
  // A start time we cannot read now is unknown, not different: trust it for a bounded time.
  const current = processStart(o.pid);
  if (o.started === null || current === null) return Date.now() - Date.parse(since) < UNKNOWN_START_TRUST_MS;
  return current === o.started;
}
const waiterAlive = (w: Waiter) => ownerAlive(w, w.since);

// --- admission ---------------------------------------------------------------------------

export type SlotRequest = { key: string; requestId: string; stateDir: string; kind: Exclude<SlotKind, 'legacy'>; checkout: string | null };

function slotFor(req: SlotRequest, now: Date): Slot {
  return { key: req.key, request_id: req.requestId, state_dir: req.stateDir, kind: req.kind, checkout: req.checkout, since: now.toISOString(), ...self() };
}

/** Recovery never sends, so it takes its slot back at once: above capacity, past the latch and the queue. */
export async function adoptSlot(store: StateStore, req: SlotRequest, now: Date) {
  await update(store, account => {
    // Recovery of a coding run still mutates its checkout (checks, seal): never beside
    // another coding run or a legacy slot whose checkout is unknown.
    const owner = req.kind === 'code' && account.slots.find(s => s.key !== req.key &&
      ((s.kind === 'code' && s.checkout === req.checkout) || s.kind === 'legacy'));
    if (owner) throw new AccountError('REPOSITORY_BUSY', `Request ${owner.key} may own this checkout; resume after it finishes or release it.`);
    const own = account.slots.find(s => s.key === req.key);
    // A migrated legacy slot of this request gets its real kind and checkout.
    if (own?.kind === 'legacy') return { value: undefined, next: { ...account, slots: account.slots.map(s => s.key === req.key ? slotFor(req, now) : s) } };
    if (own) return { value: undefined };
    return { value: undefined, next: { ...account, waiting: account.waiting.filter(w => w.key !== req.key), slots: [...account.slots, slotFor(req, now)] } };
  });
}

export type AdmitOptions = { noWait?: boolean; sleep?: (ms: number) => Promise<void>; now?: () => Date; onWait?: (position: number, used: number, max: number) => void };

/**
 * Wait in FIFO order for a free slot. Fails at once on the latch, on a coding run that
 * already owns this checkout, or (with `noWait`) when no slot is free.
 */
export async function admitSlot(store: StateStore, dir: string, req: SlotRequest, options: AdmitOptions = {}) {
  const sleep = options.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  const now = options.now ?? (() => new Date());
  const token = randomUUID();
  let queued = false;
  const leave = () => update(store, account => account.waiting.some(w => w.token === token)
    ? { value: undefined, next: { ...account, waiting: account.waiting.filter(w => w.token !== token) } } : { value: undefined });
  const onSignal = (signal: NodeJS.Signals) => { void leave().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143)); };
  try {
    while (true) {
      type State = { admitted: boolean; position?: number; used?: number; max?: number };
      const state = await update<State>(store, async account => {
        // Read the limits under the account lock, the same lock config-set holds.
        const { config } = await accountConfig(dir);
        // The latch is checked before re-entering an existing slot: a fresh request never
        // continues past an owner stop (journal recovery uses adoptSlot instead).
        if (existsSync(path.join(dir, LATCH_FALLBACK))) throw new AccountError('ACCOUNT_LATCHED', `New ChatGPT work is stopped by ${LATCH_FALLBACK}; the owner clears it with chatgpt-run account unlatch --reason TEXT.`);
        if (account.latch) throw new AccountError('ACCOUNT_LATCHED', `New ChatGPT work is stopped: ${account.latch.code} at ${account.latch.at}. The owner clears it with chatgpt-run account unlatch --reason TEXT.`);
        if (account.slots.some(s => s.key === req.key)) return { value: { admitted: true } };
        if (req.kind === 'code') {
          const owner = account.slots.find(s => (s.kind === 'code' && s.checkout === req.checkout) || s.kind === 'legacy');
          if (owner) throw new AccountError('REPOSITORY_BUSY', owner.kind === 'legacy'
            ? `A legacy 0.3 request ${owner.key} may still hold a coding run; resolve it or release it with chatgpt-run account release-slot.`
            : `Coding request ${owner.key} already owns this checkout.`);
        }
        const waiting = account.waiting.filter(w => w.key !== req.key || w.token === token).filter(w => w.token === token || waiterAlive(w));
        const first = waiting[0];
        if (account.slots.length < config.max_concurrent && (!first || first.token === token)) {
          return { value: { admitted: true }, next: { ...account, waiting: waiting.filter(w => w.token !== token), slots: [...account.slots, slotFor(req, now())] } };
        }
        if (options.noWait) throw new AccountError('ACCOUNT_BUSY', `All ${config.max_concurrent} ChatGPT slots are in use (${account.slots.map(s => s.key).join(', ')}).`);
        let next = { ...account, waiting };
        if (!waiting.some(w => w.token === token)) {
          next = { ...next, next_seq: account.next_seq + 1, waiting: [...waiting, { key: req.key, token, seq: account.next_seq, since: now().toISOString(), ...self() }] };
        }
        const position = next.waiting.findIndex(w => w.token === token) + 1;
        return { value: { admitted: false, position, used: account.slots.length, max: config.max_concurrent }, next };
      });
      if (state.admitted) return;
      if (!queued) { queued = true; process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal); }
      options.onWait?.(state.position!, state.used!, state.max!);
      await sleep(WAIT_POLL_MS);
    }
  } finally {
    if (queued) {
      process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
      await leave().catch(() => {});
    }
  }
}

/** Remove this request's slot; `audit` records an owner release. */
export async function releaseSlot(store: StateStore, key: string, audit?: { action: string; reason: string; now: Date }) {
  return update(store, account => {
    const held = account.slots.some(s => s.key === key);
    if (!held && !audit) return { value: false };
    const log = audit ? [...account.audit, { at: audit.now.toISOString(), action: audit.action, key, reason: audit.reason }].slice(-100) : account.audit;
    return { value: held, next: { ...account, slots: account.slots.filter(s => s.key !== key), audit: log } };
  });
}

// --- send budget -------------------------------------------------------------------------

const attemptTime = (a: Attempt) => Date.parse(a.confirmed_at ?? a.bound);

/** When the next send may be committed; `capped` means the hourly cap, not the gap, is the limit. */
function nextSend(account: AccountRecord, config: AccountConfig, cap: number, now: number) {
  const recent = account.attempts.map(attemptTime).filter(t => t > now - HOUR_MS).sort((a, b) => a - b);
  // An unconfirmed attempt counts at its latest possible send time; a zero gap needs no wait.
  const gapAt = recent.length && config.min_gap_seconds > 0 ? recent.at(-1)! + config.min_gap_seconds * 1000 : now;
  if (recent.length >= cap) return { at: recent[recent.length - cap] + HOUR_MS, capped: true, recent: recent.length };
  return { at: gapAt, capped: false, recent: recent.length };
}

const effectiveCap = (config: AccountConfig, override?: number) => Math.min(config.max_per_hour, override ?? Infinity);

/**
 * Wait until the gap allows another send; fail with RATE_LIMITED when the hourly cap is
 * reached. Called before preparation, so no wait sits inside a selection window.
 */
export async function waitForSendWindow(store: StateStore, dir: string, options: { maxPerHour?: number; sleep: (ms: number) => Promise<void>; now: () => Date }) {
  while (true) {
    const { config } = await accountConfig(dir);
    const cap = effectiveCap(config, options.maxPerHour);
    const t = options.now().getTime();
    const next = await update(store, account => ({ value: nextSend(account, config, cap, t) }));
    if (next.capped) throw new AccountError('RATE_LIMITED', `${next.recent} ChatGPT sends in the last hour (limit ${cap}).`);
    if (next.at <= t) return;
    await options.sleep(Math.min(next.at - t, WAIT_POLL_MS));
  }
}

/**
 * The send commit: under the account lock, check slot, latch, cap and gap, then record
 * one attempt. Only after this may the caller write its send intent and click.
 */
export async function commitSend(store: StateStore, dir: string, key: string, options: { maxPerHour?: number; now: Date }) {
  return update(store, async account => {
    // Read the limits under the account lock, so a concurrent config-set cannot race the commit.
    const { config } = await accountConfig(dir);
    const cap = effectiveCap(config, options.maxPerHour);
    if (!account.slots.some(s => s.key === key)) throw new AccountError('ADMISSION_LOST', 'Account admission is not held by this request; refusing to send.');
    if (account.latch || existsSync(path.join(dir, LATCH_FALLBACK))) throw new AccountError('ACCOUNT_LATCHED', `New ChatGPT sends are stopped: ${account.latch?.code ?? LATCH_FALLBACK}.`);
    const t = options.now.getTime();
    const next = nextSend(account, config, cap, t);
    if (next.capped) throw new AccountError('RATE_LIMITED', `${next.recent} ChatGPT sends in the last hour (limit ${cap}).`);
    if (next.at > t) throw new AccountError('SEND_GAP', `The previous send was less than ${config.min_gap_seconds} s ago.`);
    const attempt: Attempt = { id: randomUUID(), key, at: options.now.toISOString(), bound: new Date(t + SEND_BOUND_MS).toISOString() };
    const attempts = [...account.attempts.filter(a => attemptTime(a) > t - 24 * HOUR_MS), attempt];
    return { value: attempt.id, next: { ...account, attempts } };
  });
}

/**
 * Set an unconfirmed attempt's latest possible send time. The driver raises it before the
 * click and sets it to the observed return time after a clean click.
 */
export async function boundSend(store: StateStore, attemptId: string, bound: Date) {
  await update(store, account => {
    const a = account.attempts.find(x => x.id === attemptId);
    if (!a) throw new AccountError('ACCOUNT_STATE_CORRUPT', `Send attempt ${attemptId} is missing.`);
    if (a.confirmed_at) return { value: undefined };
    return { value: undefined, next: { ...account, attempts: account.attempts.map(x => x.id === attemptId ? { ...x, bound: bound.toISOString() } : x) } };
  });
}

/** The user message was seen: the send happened no later than `now`. */
export async function confirmSend(store: StateStore, attemptId: string, now: Date) {
  await update(store, account => {
    const a = account.attempts.find(x => x.id === attemptId);
    if (!a || a.confirmed_at) return { value: undefined };
    // The message was observed at `now`: never record an earlier, speculative time.
    return { value: undefined, next: { ...account, attempts: account.attempts.map(x => x.id === attemptId ? { ...x, confirmed_at: now.toISOString() } : x) } };
  });
}

// --- latch -------------------------------------------------------------------------------

/** The driver latches only when the owner enabled it; the owner always can. */
export async function setLatch(store: StateStore, dir: string, latch: Omit<Latch, 'at'>, now: Date) {
  if (latch.by === 'owner' && !latch.reason?.trim()) throw new AccountError('REASON_REQUIRED', 'Setting the latch needs a reason.');
  // A detected challenge must stop every run: retry, then fall back to a plain marker file
  // that admission and the send commit also honor. Only if both fail is it raised.
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await writeLatch(store, dir, latch, now); }
    catch (error) {
      if (error instanceof AccountError && error.code === 'ACCOUNT_CONFIG_INVALID') throw error;
      last = error;
      await new Promise(r => setTimeout(r, 100));
    }
  }
  try {
    await writeFile(path.join(dir, LATCH_FALLBACK), JSON.stringify({ ...latch, at: now.toISOString() }) + '\n', { mode: 0o600 });
    return true;
  } catch {
    throw new AccountError('LATCH_WRITE_FAILED', `Could not persist the stop latch: ${last instanceof Error ? last.message : String(last)}`);
  }
}

async function writeLatch(store: StateStore, dir: string, latch: Omit<Latch, 'at'>, now: Date) {
  return update(store, async account => {
    // Read latch_enabled under the lock that config-set holds.
    if (latch.by === 'driver' && !(await accountConfig(dir)).config.latch_enabled) return { value: false };
    if (account.latch) return { value: false };
    const audit = [...account.audit, { at: now.toISOString(), action: `latch:${latch.code}`, key: latch.key ?? null, reason: latch.reason ?? latch.by }].slice(-100);
    return { value: true, next: { ...account, latch: { ...latch, at: now.toISOString() }, audit } };
  });
}

export async function clearLatch(store: StateStore, reason: string, now: Date) {
  if (!reason.trim()) throw new AccountError('REASON_REQUIRED', 'Clearing the latch needs a reason.');
  // Marker and record are cleared under the lock that latch setters hold.
  return update(store, async account => {
    await rm(path.join(store.dir, LATCH_FALLBACK), { force: true });
    return { value: account.latch, next: { ...account, latch: null, audit: [...account.audit, { at: now.toISOString(), action: 'unlatch', key: null, reason }].slice(-100) } };
  });
}

export async function accountStatus(dir = DEFAULT_ACCOUNT_DIR, now = new Date()) {
  const store = await StateStore.open(dir);
  const { config, source } = await accountConfig(dir);
  const account = await update(store, a => ({ value: a }));
  const t = now.getTime();
  return {
    config, config_source: source,
    slots_in_use: account.slots.length, max_concurrent: config.max_concurrent,
    slots: account.slots, waiting: account.waiting,
    sends_last_hour: account.attempts.filter(a => attemptTime(a) > t - HOUR_MS).length, max_per_hour: config.max_per_hour,
    latch: account.latch, latch_fallback: existsSync(path.join(dir, LATCH_FALLBACK)), audit: account.audit.slice(-10)
  };
}

// --- setup lease -------------------------------------------------------------------------

const LEASE_PATH = 'setup-lease';
const LEASE_KIND = 'chatgpt-go-setup-lease-v1';
type LeaseRecord = Owner & { token: string; since: string };
export type SetupLease = { release(): Promise<void> };

/**
 * The setup lease serializes the steps that activate a tab or send input. Its owner is a
 * PID plus process start time, so a reused PID never holds it. A dead owner's lease is
 * removed under the account lock, then we wait for anything it already sent to settle;
 * nothing it sent is ever replayed.
 */
export async function acquireSetupLease(store: StateStore, sleep: (ms: number) => Promise<void>): Promise<SetupLease> {
  const record: LeaseRecord = { ...self(), token: randomUUID(), since: new Date().toISOString() };
  const lease: SetupLease = {
    release: () => withAccountLock(store, async () => {
      // A read error is raised, so the driver keeps its lease and retries the release.
      const current = await store.read<LeaseRecord>(LEASE_PATH, LEASE_KIND);
      if (current?.token === record.token) await store.remove(LEASE_PATH);
    })
  };
  while (true) {
    if (await store.create(LEASE_PATH, LEASE_KIND, record)) return lease;
    const recovered = await withAccountLock(store, async () => {
      const current = await store.read<LeaseRecord>(LEASE_PATH, LEASE_KIND);
      if (!current) return false;
      if (!current || typeof current !== 'object' || !Number.isSafeInteger(current.pid) || current.pid <= 0 ||
          typeof current.host !== 'string' || !current.host || typeof current.token !== 'string' || !current.token ||
          !iso(current.since) || !(current.started === null || (typeof current.started === 'string' && current.started.length > 0))) {
        throw new AccountError('ACCOUNT_STATE_CORRUPT', `Corrupt setup lease; inspect ${LEASE_PATH} before continuing.`);
      }
      if (ownerAlive(current, current.since)) return false;
      // Take the dead owner's lease over in place, so no other process can start setup
      // during the settle window.
      await store.write(LEASE_PATH, LEASE_KIND, record);
      return true;
    });
    if (recovered) {
      await sleep(LEASE_SETTLE_MS);
      return lease;
    }
    await sleep(LEASE_POLL_MS);
  }
}
