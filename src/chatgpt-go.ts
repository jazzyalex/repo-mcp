import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readRegularFile } from './bounded-file.js';
import { SafeError, sha256 } from './errors.js';
import {
  CHATGPT_RUN_MAX_PROMPT_BYTES,
  chatGptRunOutput,
  chatGptRunStatus,
  completeChatGptRun,
  failChatGptRunBeforeSubmit,
  markChatGptRunSubmitted,
  markChatGptRunUncertain,
  prepareChatGptRun,
  recoverChatGptRun,
  recoverChatGptRunLock,
  reserveChatGptRun,
  type ChatGptCoordinator,
  type ChatGptRunRecord,
  type TrustedChatGptRunReceipt
} from './chatgpt-run.js';
import { recordTrustedBrowserObservation, type ModelProfile } from './model-policy.js';
import { StateStore, acquireLock } from './task-state.js';

// One-shot ChatGPT web run driver (docs/GO-DRIVER-SPEC.md). The run journal stays the
// authority; this module only sequences it, keeps a private manifest for recovery and
// holds the account-wide admission so at most one ChatGPT turn is unresolved at a time.

export const GO_KIND = 'chatgpt-go-v1';
const ACCOUNT_KIND = 'chatgpt-go-account-v1';
const ACCOUNT_PATH = 'account';
/** One admission store per machine: every state dir drives the same main-Chrome ChatGPT account. */
export const DEFAULT_ACCOUNT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'repo-mcp', 'chatgpt-account');
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HOUR_MS = 3_600_000;
const POLL_MS = 15_000;
const SEND_CONFIRM_MS = 30_000;
const UNKNOWN_LIMIT_MS = 10 * 60_000;

/** A failure the driver understands; `code` is the reported failure code. */
export class GoError extends SafeError {
  constructor(readonly code: string, message = code) { super(message); }
}

export type TurnState = { state: 'busy' | 'done' | 'unknown'; chars: number };

/** The browser operations the driver needs; `src/chatgpt-browser.ts` implements them over CDP. */
export interface ChatGptPage {
  open(): Promise<{ targetId: string }>;
  /** Reattach to the run's tab or conversation; false when neither can be found. */
  reattach(targetId: string | undefined, conversationUrl: string | undefined): Promise<boolean>;
  attachRepoMcp(): Promise<void>;
  pastePrompt(prompt: string): Promise<void>;
  /** Click the effort control named `label`, then reread the live control. */
  selectEffort(label: string): Promise<{ selectedAt: Date; observedLabel: string }>;
  clickSend(): Promise<void>;
  conversationUrl(): Promise<string | undefined>;
  hasExpectedUserMessage(prompt: string): Promise<boolean>;
  turnState(prompt: string): Promise<TurnState>;
  readAnswer(prompt: string): Promise<string>;
  archive(): Promise<void>;
  /** Close this run's own tab; never any other tab. */
  closeTab(): Promise<void>;
  close(): Promise<void>;
}

export type GoPhase = 'admitted' | 'tab-ready' | 'prepared' | 'reserved' | 'send-intent' |
  'submitted' | 'completed' | 'cleaned' | 'failed' | 'uncertain';

export type GoManifest = {
  request_id: string; request_digest: string; repository_id: string; task_id: string;
  coordinator: ChatGptCoordinator; kind: 'architecture'; profile: ModelProfile; prompt_sha256: string;
  prompt_file: string; session_id: string; created_at: string; updated_at: string;
  phase: GoPhase; target_id?: string; pending_run_id?: string; run_id?: string; selection_id?: string; send_intent_at?: string;
  conversation_url?: string; submission_event_id?: string; output_file?: string; output_sha256?: string;
  cleanup?: string; failure_code?: string;
};

export type GoOptions = {
  stateDir: string; requestId: string; accountDir?: string;
  repositoryId?: string; taskId?: string; coordinator?: ChatGptCoordinator; kind?: string; profile?: ModelProfile;
  prompt?: string; promptFile?: string; timeoutMinutes?: number; maxPerHour?: number;
};

export type GoDeps = {
  page: ChatGptPage;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: called after each durable manifest write; throwing simulates a crash there. */
  afterPhase?: (phase: GoPhase) => void | Promise<void>;
};

export type GoResult = {
  request_id: string; phase: GoPhase; run_id: string | null; run_state: string | null;
  conversation_url: string | null; output_file: string | null; cleanup: string | null; failure_code: string | null;
};

const requestHash = (requestId: string) => sha256(`chatgpt-go\0${requestId}`);
const manifestPath = (requestId: string) => `chatgpt-go/${requestHash(requestId)}`;
/** Admission identity: the same request ID in two state directories is two different requests. */
const accountKey = (stateDir: string, requestId: string) => `${requestId}@${sha256(stateDir).slice(0, 12)}`;
const requestLockKey = (requestId: string) => `chatgpt-go-${requestHash(requestId).slice(0, 16)}`;
const conversationId = (url: string | undefined) => url?.match(/\/c\/([A-Za-z0-9-]+)/)?.[1] ?? 'unknown';

export function goRequestDigest(o: {
  repositoryId: string; taskId: string; coordinator: string; kind: string; profile: string; promptSha256: string;
}) {
  return sha256(JSON.stringify(['chatgpt-go-request-v1', o.repositoryId, o.taskId, o.coordinator, o.kind, o.profile, o.promptSha256]));
}

function result(m: GoManifest, run?: ChatGptRunRecord): GoResult {
  return {
    request_id: m.request_id, phase: m.phase, run_id: m.run_id ?? null, run_state: run?.state ?? null,
    conversation_url: m.conversation_url ?? null, output_file: m.output_file ?? null,
    cleanup: m.cleanup ?? null, failure_code: m.failure_code ?? null
  };
}

type AccountRecord = { active_request_id: string | null; since: string | null; sends: string[] };

async function readAccount(store: StateStore): Promise<AccountRecord> {
  const raw = await store.read<AccountRecord>(ACCOUNT_PATH, ACCOUNT_KIND);
  if (raw === undefined) return { active_request_id: null, since: null, sends: [] };
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sends) ||
      (raw.active_request_id !== null && typeof raw.active_request_id !== 'string')) {
    throw new SafeError('Corrupt ChatGPT account admission record; inspect it before continuing.');
  }
  return raw;
}

/** Account lock that recovers a lock left by a dead process, so a crash cannot block resume. */
async function withAccount<T>(store: StateStore, fn: (account: AccountRecord) => Promise<T>) {
  const deadline = Date.now() + 10_000;
  while (true) {
    let lock;
    try { lock = await acquireLock(store, 'chatgpt-go-account', 'chatgpt-go account admission', { recoverStale: true }); }
    catch (error) {
      if (Date.now() > deadline || !(error instanceof Error) || !/live process|recovery is already in progress/.test(error.message)) throw error;
      await new Promise(r => setTimeout(r, 25));
      continue;
    }
    try { return await fn(await readAccount(store)); } finally { await lock.release(); }
  }
}

/** Hold the account for `requestId`, or fail with ACCOUNT_BUSY / RATE_LIMITED. A request may re-enter its own admission. */
async function admit(store: StateStore, requestId: string, maxPerHour: number, now: Date) {
  await withAccount(store, async account => {
    if (account.active_request_id === requestId) return;
    if (account.active_request_id !== null) {
      throw new GoError('ACCOUNT_BUSY', `ChatGPT account is held by unresolved request ${account.active_request_id}; resume or release it first.`);
    }
    const recent = account.sends.filter(at => now.getTime() - Date.parse(at) < HOUR_MS);
    if (recent.length >= maxPerHour) throw new GoError('RATE_LIMITED', `${recent.length} ChatGPT sends in the last hour (limit ${maxPerHour}).`);
    await store.write(ACCOUNT_PATH, ACCOUNT_KIND, { ...account, active_request_id: requestId, since: now.toISOString() });
  });
}

async function recordSend(store: StateStore, requestId: string, now: Date) {
  await withAccount(store, async account => {
    if (account.active_request_id !== requestId) throw new GoError('ADMISSION_LOST', 'Account admission is not held by this request; refusing to send.');
    const sends = [...account.sends.filter(at => now.getTime() - Date.parse(at) < 24 * HOUR_MS), now.toISOString()];
    await store.write(ACCOUNT_PATH, ACCOUNT_KIND, { ...account, sends });
  });
}

async function releaseAccount(store: StateStore, requestId: string) {
  await withAccount(store, async account => {
    if (account.active_request_id !== requestId) return;
    await store.write(ACCOUNT_PATH, ACCOUNT_KIND, { ...account, active_request_id: null, since: null });
  });
}

/** Operator escape for an `uncertain` request after its conversation was inspected by other means. */
export async function releaseGoAdmission(stateDir: string, requestId: string, reason: string, accountDir = DEFAULT_ACCOUNT_DIR) {
  const store = await StateStore.open(stateDir);
  // The request lock proves no live `go` process is between its send intent and submission.
  const lock = await acquireLock(store, requestLockKey(requestId), 'chatgpt-go request', { recoverStale: true })
    .catch(error => { throw new GoError('REQUEST_BUSY', error instanceof Error ? error.message : 'Request is busy.'); });
  try {
    const m = await store.read<GoManifest>(manifestPath(requestId), GO_KIND);
    if (!m) throw new GoError('NO_SUCH_REQUEST', `No go request ${requestId}.`);
    // An unreadable journal is not permission to release: only a positively read state is.
    const run = m.run_id ? await chatGptRunStatus(m.run_id, stateDir) : undefined;
    if (run?.state === 'submitted') throw new GoError('RUN_ACTIVE', 'The run is submitted; resume it instead of releasing the account.');
    if (!reason.trim()) throw new GoError('REASON_REQUIRED', 'Releasing the account needs a reason.');
    await releaseAccount(await StateStore.open(accountDir), accountKey(store.dir, requestId));
    return { request_id: requestId, released: true, run_state: run?.state ?? null, reason };
  } finally { await lock.release(); }
}

export async function goStatus(stateDir: string, requestId: string) {
  const store = await StateStore.inspect(stateDir);
  const m = await store?.read<GoManifest>(manifestPath(requestId), GO_KIND);
  if (!m) throw new GoError('NO_SUCH_REQUEST', `No go request ${requestId}.`);
  return result(m, m.run_id ? await chatGptRunStatus(m.run_id, stateDir) : undefined);
}

export async function runGo(options: GoOptions, deps: GoDeps): Promise<GoResult> {
  if (!REQUEST_ID.test(options.requestId)) throw new GoError('INVALID_REQUEST', 'Invalid --request-id.');
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  const store = await StateStore.open(options.stateDir);
  const rel = manifestPath(options.requestId);
  const account = await StateStore.open(options.accountDir ?? DEFAULT_ACCOUNT_DIR);
  const lock = await acquireLock(store, requestLockKey(options.requestId), 'chatgpt-go request', { recoverStale: true })
    .catch(error => { throw new GoError('REQUEST_BUSY', error instanceof Error ? error.message : 'Request is busy.'); });
  try {
    let m = await store.read<GoManifest>(rel, GO_KIND);
    let prompt = options.prompt;
    if (m) {
      // Resume reuses the stored identity; any input given again must match it.
      const saved = m;
      if (prompt === undefined && saved.prompt_file && saved.phase !== 'cleaned' && saved.phase !== 'failed') {
        prompt = await readRegularFile(saved.prompt_file, CHATGPT_RUN_MAX_PROMPT_BYTES, 'Prompt file')
          // Loaded lazily: a completed run recovers without it; browser steps fail with PROMPT_REQUIRED.
          .catch(() => undefined);
      }
      if (prompt !== undefined && sha256(prompt) !== saved.prompt_sha256) throw new GoError('REQUEST_CONFLICT', `Request ${options.requestId} already exists with a different prompt.`);
      if ((options.repositoryId !== undefined && options.repositoryId !== saved.repository_id) ||
          (options.taskId !== undefined && options.taskId !== saved.task_id) ||
          (options.coordinator !== undefined && options.coordinator !== saved.coordinator) ||
          (options.kind !== undefined && options.kind !== saved.kind) ||
          (options.profile !== undefined && options.profile !== saved.profile)) {
        throw new GoError('REQUEST_CONFLICT', `Request ${options.requestId} already exists with different inputs.`);
      }
    } else if (prompt !== undefined) {
      const kind = options.kind ?? 'architecture';
      if (kind !== 'architecture') throw new GoError('KIND_UNSUPPORTED', 'go supports --kind architecture only for now.');
      const profile = options.profile ?? 'architecture';
      if (!options.repositoryId || !options.taskId || !options.coordinator) throw new GoError('INVALID_REQUEST', 'go needs --repository, --task and --coordinator.');
      const promptSha256 = sha256(prompt);
      const digest = goRequestDigest({ repositoryId: options.repositoryId, taskId: options.taskId,
        coordinator: options.coordinator, kind, profile, promptSha256 });
      const at = now().toISOString();
      m = {
        request_id: options.requestId, request_digest: digest, repository_id: options.repositoryId,
        task_id: options.taskId, coordinator: options.coordinator, kind: 'architecture', profile,
        prompt_sha256: promptSha256, prompt_file: options.promptFile ? path.resolve(options.promptFile) : '',
        session_id: `go-${digest.slice(0, 16)}-${randomBytes(4).toString('hex')}`,
        created_at: at, updated_at: at, phase: 'admitted'
      };
      // The manifest is durable before the account is claimed, so a crash in between
      // leaves a resumable request, never an orphaned admission. drive() admits it.
      if (!(await store.create(rel, GO_KIND, m))) throw new GoError('REQUEST_BUSY', 'Request was created concurrently.');
    }
    if (!m) throw new GoError('NO_SUCH_REQUEST', `No go request ${options.requestId}; start it with --prompt-file.`);
    const driver = new Driver(store, account, options, deps, m, prompt, now, sleep);
    return await driver.drive();
  } finally {
    await deps.page.close().catch(() => {});
    await lock.release();
  }
}

class Driver {
  constructor(
    private store: StateStore, private account: StateStore, private options: GoOptions, private deps: GoDeps, private m: GoManifest,
    private prompt: string | undefined, private now: () => Date, private sleep: (ms: number) => Promise<void>
  ) {}

  private get page() { return this.deps.page; }
  private get stateDir() { return this.options.stateDir; }

  private async save(patch: Partial<GoManifest>) {
    this.m = { ...this.m, ...patch, updated_at: this.now().toISOString() };
    await this.store.write(manifestPath(this.m.request_id), GO_KIND, this.m);
    await this.deps.afterPhase?.(this.m.phase);
  }

  private run() { return chatGptRunStatus(this.m.run_id!, this.stateDir); }

  private receipt(run: ChatGptRunRecord, eventId: string): TrustedChatGptRunReceipt {
    return {
      repositoryId: run.repository_id, taskId: run.task_id, promptSha256: run.prompt_sha256,
      baseCommit: run.resolved_base_commit, browserEventId: eventId, observedAt: this.now().toISOString(),
      sessionId: this.m.session_id
    };
  }

  private requirePrompt() {
    if (this.prompt === undefined) throw new GoError('PROMPT_REQUIRED', 'This step needs the prompt; pass the same --prompt-file again.');
    if (sha256(this.prompt) !== this.m.prompt_sha256) throw new GoError('REQUEST_CONFLICT', 'Prompt does not match this request.');
    // A per-request marker on the first line lets recovery tell this run's message from any
    // other chat that starts with the same text.
    return `Run ${requestHash(this.m.request_id).slice(0, 16)}\n\n${this.prompt}`;
  }

  private async finish(phase: 'cleaned' | 'failed', patch: Partial<GoManifest> = {}) {
    await this.save({ ...patch, phase });
    await releaseAccount(this.account, accountKey(this.store.dir, this.m.request_id));
    return result(this.m, this.m.run_id ? await this.run() : undefined);
  }

  private async hold(code: string) {
    const run = await this.run();
    if (run.state === 'submission-reserved' || run.state === 'submitted') await markChatGptRunUncertain(run.run_id, code, this.stateDir, this.now());
    await this.save({ phase: 'uncertain', failure_code: code });
    return result(this.m, await this.run());
  }

  async drive(): Promise<GoResult> {
    if (this.m.phase === 'cleaned' || this.m.phase === 'failed') {
      if (this.m.output_file) await this.ensureOutputFile();
      await releaseAccount(this.account, accountKey(this.store.dir, this.m.request_id));
      return result(this.m, this.m.run_id ? await this.run() : undefined);
    }
    await admit(this.account, accountKey(this.store.dir, this.m.request_id), this.options.maxPerHour ?? 4, this.now());
    if (!this.m.run_id && this.m.pending_run_id) {
      // Preparation may have become durable before the manifest recorded it.
      const exists = await chatGptRunStatus(this.m.pending_run_id, this.stateDir).then(() => true, () => false);
      if (exists) await this.save({ run_id: this.m.pending_run_id });
    }
    if (!this.m.run_id) return this.fresh();
    return this.recover();
  }

  /** No run exists yet: set up the tab, then prepare, select, reserve and send once. */
  private async fresh(): Promise<GoResult> {
    const prompt = this.requirePrompt();
    try {
      const { targetId } = await this.page.open();
      await this.page.attachRepoMcp();
      await this.page.pastePrompt(prompt);
      await this.save({ phase: 'tab-ready', target_id: targetId, pending_run_id: this.m.pending_run_id ?? randomUUID() });
    } catch (error) {
      process.stderr.write(`browser setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
      await this.page.closeTab().catch(() => {});
      return this.finish('failed', { failure_code: codeOf(error, 'BROWSER_SETUP_FAILED') });
    }
    let prepared: Awaited<ReturnType<typeof prepareChatGptRun>>;
    try {
      prepared = await prepareChatGptRun({
        stateDir: this.stateDir, repositoryId: this.m.repository_id, taskId: this.m.task_id,
        coordinator: this.m.coordinator, workKind: this.m.kind, profile: this.m.profile, surface: 'chat',
        sessionId: this.m.session_id, prompt, runId: this.m.pending_run_id, now: this.now()
      });
    } catch (error) {
      process.stderr.write(`prepare failed: ${error instanceof Error ? error.message : String(error)}\n`);
      // Publication may have succeeded before a later step threw; never hide such a run.
      const published = await chatGptRunStatus(this.m.pending_run_id!, this.stateDir).catch(() => undefined);
      if (published) {
        await this.save({ run_id: published.run_id });
        return this.recover();
      }
      return this.finish('failed', { failure_code: 'PREPARE_FAILED' });
    }
    const target = prepared.selection.expected_target_label;
    await this.save({ phase: 'prepared', run_id: prepared.run_id, selection_id: prepared.selection.selection_id });
    let authorized: boolean;
    try {
      const picked = await this.page.selectEffort(target ?? '');
      const evidence = await recordTrustedBrowserObservation({
        selectionId: prepared.selection.selection_id, surface: 'chat', controlLabel: picked.observedLabel,
        selectedAt: picked.selectedAt.toISOString(), observedAt: this.now().toISOString(), sessionId: this.m.session_id
      }, { stateDir: path.join(this.stateDir, 'model-policy'), now: this.now() });
      const reserved = await reserveChatGptRun({ stateDir: this.stateDir, runId: prepared.run_id, contract: prepared.selection, evidence, now: this.now() });
      authorized = reserved.submission_authorized;
    } catch (error) {
      process.stderr.write(`model selection failed: ${error instanceof Error ? error.message : String(error)}\n`);
      const run = await this.run();
      if (run.state === 'prepared' || run.state === 'verification-pending') {
        await failChatGptRunBeforeSubmit(run.run_id, 'MODEL_SELECTION_NOT_VERIFIED', this.stateDir, this.now());
      }
      if ((await this.run()).state === 'failed-pre-submit') {
        await this.page.closeTab().catch(() => {});
        return this.finish('failed', { failure_code: codeOf(error, 'MODEL_SELECTION_NOT_VERIFIED') });
      }
      return this.recover();
    }
    if (!authorized) return this.recover();
    await this.save({ phase: 'reserved' });
    return this.send(prompt);
  }

  private async send(prompt: string): Promise<GoResult> {
    await recordSend(this.account, accountKey(this.store.dir, this.m.request_id), this.now());
    await this.save({ phase: 'send-intent', send_intent_at: this.now().toISOString() });
    try { await this.page.clickSend(); }
    catch { return this.confirmOrHold(prompt, 'SEND_UNCONFIRMED'); }
    return this.confirmOrHold(prompt, 'SEND_UNCONFIRMED');
  }

  /** Mark submitted only after the expected user message is seen in the conversation. */
  private async confirmOrHold(prompt: string, code: string): Promise<GoResult> {
    const deadline = this.now().getTime() + SEND_CONFIRM_MS;
    while (true) {
      const url = await this.page.conversationUrl().catch(() => undefined);
      if (url && url !== this.m.conversation_url) await this.save({ conversation_url: url });
      if (url && await this.page.hasExpectedUserMessage(prompt).catch(() => false)) break;
      if (this.now().getTime() >= deadline) return this.hold(code);
      await this.sleep(2_000);
    }
    const run = await this.run();
    const eventId = `chatgpt-go-send-${conversationId(this.m.conversation_url)}-${this.now().toISOString()}`;
    if (run.state === 'uncertain') {
      await recoverChatGptRun(run.run_id, 'submitted', this.receipt(run, eventId), this.stateDir, this.now());
    } else if (run.state === 'submission-reserved') {
      await markChatGptRunSubmitted({ stateDir: this.stateDir, runId: run.run_id, receipt: this.receipt(run, eventId), now: this.now() });
    }
    await this.save({ phase: 'submitted', submission_event_id: eventId, failure_code: undefined });
    return this.awaitAnswer(prompt);
  }

  private async awaitAnswer(prompt: string): Promise<GoResult> {
    const deadline = this.now().getTime() + (this.options.timeoutMinutes ?? 45) * 60_000;
    let previous: TurnState | undefined;
    let unknownSince: number | undefined;
    while (true) {
      const state = await this.page.turnState(prompt).catch((): TurnState => ({ state: 'unknown', chars: 0 }));
      const at = this.now().getTime();
      if (state.state === 'done') {
        unknownSince = undefined;
        if (previous?.state === 'done' && previous.chars === state.chars) break;
      } else if (state.state === 'unknown') {
        unknownSince ??= at;
        if (at - unknownSince > UNKNOWN_LIMIT_MS) return this.hold('COMPLETION_UNOBSERVED');
      } else {
        unknownSince = undefined;
      }
      if (at >= deadline) return this.hold('COMPLETION_TIMEOUT');
      previous = state;
      await this.sleep(POLL_MS);
    }
    const answer = await this.page.readAnswer(prompt);
    if (!answer.trim()) return this.hold('EMPTY_ANSWER');
    return this.complete(answer);
  }

  private async complete(answer: string): Promise<GoResult> {
    const run = await this.run();
    const outputFile = path.join(this.store.dir, `${manifestPath(this.m.request_id)}.output.md`);
    await writeFile(outputFile, answer, { mode: 0o600 });
    const eventId = `chatgpt-go-complete-${conversationId(this.m.conversation_url)}-${this.now().toISOString()}`;
    await completeChatGptRun({
      stateDir: this.stateDir, runId: run.run_id, output: answer, outcome: 'completed', now: this.now(),
      receipt: { ...this.receipt(run, eventId), kind: 'completion', responseState: 'completed',
        submissionEventSha256: run.submission_event_sha256!, outputSha256: sha256(answer) }
    });
    if (await chatGptRunOutput(run.run_id, this.stateDir) !== answer) throw new GoError('OUTPUT_MISMATCH', 'Saved output differs from the capture.');
    await this.save({ phase: 'completed', output_file: outputFile, output_sha256: sha256(answer) });
    return this.cleanup();
  }

  private async cleanup(): Promise<GoResult> {
    let cleanup = 'archived';
    try {
      if (!(await this.page.reattach(this.m.target_id, this.m.conversation_url))) throw new GoError('TAB_GONE');
      await this.page.archive();
      await this.page.closeTab();
    } catch (error) {
      cleanup = `warning:${codeOf(error, 'ARCHIVE_FAILED')}`;
    }
    return this.finish('cleaned', { cleanup });
  }

  /**
   * Make the output file equal the journal's verified answer. The file is checked by
   * content, not by the manifest's word; a missing or altered file is rewritten atomically.
   */
  private async ensureOutputFile() {
    const saved = await chatGptRunOutput(this.m.run_id!, this.stateDir);
    const digest = sha256(saved);
    if (this.m.output_sha256 && digest !== this.m.output_sha256) throw new GoError('OUTPUT_MISMATCH', 'Saved output differs from the manifest.');
    const outputFile = path.join(this.store.dir, `${manifestPath(this.m.request_id)}.output.md`);
    const current = await readFile(outputFile, 'utf8').catch(() => undefined);
    if (current === undefined || sha256(current) !== digest) {
      const temp = `${outputFile}.${process.pid}.tmp`;
      await writeFile(temp, saved, { mode: 0o600 });
      await rename(temp, outputFile);
    }
    if (this.m.output_file !== outputFile || this.m.output_sha256 !== digest || (this.m.phase !== 'completed' && this.m.phase !== 'cleaned')) {
      await this.save({ phase: this.m.phase === 'cleaned' ? 'cleaned' : 'completed', output_file: outputFile, output_sha256: digest });
    }
  }

  /** Continue from whatever the journal says happened (spec section 4). */
  private async recover(): Promise<GoResult> {
    // A crash can leave the journal's own run lock behind; it is removed only if its owner is dead.
    await recoverChatGptRunLock(this.m.run_id!, this.stateDir).catch(() => {});
    const run = await this.run();
    switch (run.state) {
      case 'prepared':
      case 'verification-pending':
        await failChatGptRunBeforeSubmit(run.run_id, 'DRIVER_INTERRUPTED', this.stateDir, this.now());
        return this.finish('failed', { failure_code: 'DRIVER_INTERRUPTED' });
      case 'failed-pre-submit':
        return this.finish('failed', { failure_code: this.m.failure_code ?? run.failure_code });
      case 'completed':
        await this.ensureOutputFile();
        return this.cleanup();
      case 'submission-reserved':
        if (!this.m.send_intent_at) {
          // The click is ordered after the intent write, so nothing was sent.
          await markChatGptRunUncertain(run.run_id, 'DRIVER_INTERRUPTED', this.stateDir, this.now());
          const current = await this.run();
          await recoverChatGptRun(run.run_id, 'not-submitted',
            this.receipt(current, `chatgpt-go-recover-${requestHash(this.m.request_id).slice(0, 16)}-${this.now().toISOString()}`),
            this.stateDir, this.now());
          return this.finish('failed', { failure_code: 'CONFIRMED_NOT_SUBMITTED' });
        }
        return this.reattachAndConfirm('SEND_UNCONFIRMED');
      case 'uncertain':
        if (!this.m.send_intent_at && run.uncertain_from === 'submission-reserved') {
          await recoverChatGptRun(run.run_id, 'not-submitted',
            this.receipt(run, `chatgpt-go-recover-${requestHash(this.m.request_id).slice(0, 16)}-${this.now().toISOString()}`),
            this.stateDir, this.now());
          return this.finish('failed', { failure_code: 'CONFIRMED_NOT_SUBMITTED' });
        }
        return this.reattachAndConfirm(run.failure_code ?? 'SEND_UNCONFIRMED');
      case 'submitted': {
        const prompt = this.requirePrompt();
        if (!(await this.page.reattach(this.m.target_id, this.m.conversation_url))) return this.hold('TAB_GONE');
        if (this.m.phase !== 'submitted') await this.save({ phase: 'submitted' });
        return this.awaitAnswer(prompt);
      }
      default:
        throw new GoError('UNKNOWN_RUN_STATE', `Unexpected run state ${String(run.state)}.`);
    }
  }

  private async reattachAndConfirm(code: string): Promise<GoResult> {
    const prompt = this.requirePrompt();
    if (!(await this.page.reattach(this.m.target_id, this.m.conversation_url))) return this.hold(code);
    return this.confirmOrHold(prompt, code);
  }
}

function codeOf(error: unknown, fallback: string) {
  return error instanceof GoError && /^[A-Z][A-Za-z0-9_:-]{0,63}$/.test(error.code)
    ? error.code.replace(/[:-]/g, '_').toUpperCase() : fallback;
}
