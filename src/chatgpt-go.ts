import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, realpath, rename, writeFile } from 'node:fs/promises';
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
import { readMcpReportForRequest, type McpReportOutcome } from './mcp-report.js';
import { activeExecSessions, execSessionsQuiet } from './exec-tool.js';
import { candidateDigest, runCheck, type CheckResult } from './go-checks.js';
import {
  AccountError, DEFAULT_ACCOUNT_DIR, acquireSetupLease, admitSlot, adoptSlot, commitSend, confirmSend,
  pidReusedSince, releaseSlot, CLICK_SETTLE_MS, SEND_CLICK_DEADLINE_MS, extendSend, setLatch, waitForSendWindow, type SetupLease, type SlotRequest
} from './go-account.js';
import { grantState, issueWorkspaceGrant, readMultiRepoCatalog, revokeGrant, revokeWorkspace, workspaceForOpenRequest } from './multirepo-state.js';
import { closeReviewParticipant, prepareOrJoinReview, reconcileReviewParticipant, recoverReviewParticipant } from './review-share.js';
import { ReviewShareError } from './review-state.js';
import { StateStore, acquireLock, lockOwnerAlive, validateLockRecord } from './task-state.js';
import { withTaskShareGate } from './review-state.js';

// One-shot ChatGPT web run driver (docs/GO-DRIVER-SPEC.md). The run journal stays the
// authority; this module only sequences it and keeps a private manifest for recovery.
// Account-wide slots, the send budget, the setup lease and the latch live in
// `go-account.ts` (docs/GO-CONCURRENCY-SPEC.md).

export { DEFAULT_ACCOUNT_DIR };
export const GO_KIND = 'chatgpt-go-v1';
const WS_CLAIM_KIND = 'chatgpt-go-ws-claim-v1';
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COMMIT = /^[0-9a-f]{40}$/;
/** A stop latch that cannot be persisted is retried this often, holding the setup lease. */
const LATCH_RETRY_MS = 5_000;
const LATCH_RETRIES = 360;
/** Longest gap between the effort observation and the send commit. */
const OBSERVATION_MAX_AGE_MS = 10_000;
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
  /** The tab now attached; reattach may have opened a replacement. */
  currentTargetId?(): string | undefined;
  /** A verified account-level warning on the page (`BROWSER_CHALLENGE`), or null. */
  accountSignal?(): Promise<string | null>;
}

export type GoPhase = 'admitted' | 'tab-ready' | 'prepared' | 'reserved' | 'send-intent' |
  'submitted' | 'completed' | 'cleaned' | 'failed' | 'uncertain';

export type GoKind = 'architecture' | 'review' | 'code';

/** Code runs: `go` issues the write grant itself and runs the project checks after sealing. */
export type GoCodeTarget = { base_ref?: string; checks: string[]; exec: boolean };

/** Commit-pinned review target; the coordinator resolves both commits before writing the prompt. */
export type GoReviewTarget = { workspace_request_id: string; base_ref: string; head_ref: string; scope_prefix?: string };

export type GoManifest = {
  request_id: string; request_digest: string; repository_id: string; task_id: string;
  coordinator: ChatGptCoordinator; kind: GoKind; profile: ModelProfile; prompt_sha256: string;
  review?: GoReviewTarget;
  /** Architecture and code: the workspace_open request ID the prompt names (review keeps it in `review`). */
  workspace_request_id?: string;
  code?: GoCodeTarget;
  /** Code only: the single-use write grant this request issued (never the grant itself). */
  grant_id?: string;
  /** Code only: `revoked` once the coding workspace (or unused grant) is revoked, or `warning:<code>`. */
  sealed?: string;
  checks?: CheckResult[];
  candidate_changed?: boolean;
  /** Code only: candidate digest taken before the first check. */
  check_baseline?: string;
  /** Code only: why the checks could not run or finish; the run still completes. */
  checks_error?: string;
  /** Where the saved answer came from: the `finish` MCP report, or the page text. */
  output_source?: 'mcp-report' | 'page';
  /** Review only: `closed`, or `warning:<code>` when the shared-review participant could not be closed. */
  participant?: string;
  prompt_file: string; session_id: string; created_at: string; updated_at: string;
  phase: GoPhase; target_id?: string; pending_run_id?: string; run_id?: string; selection_id?: string; send_intent_at?: string;
  /** A detected challenge whose latch could not be persisted yet; retried on every run. */
  latch_pending?: string;
  /** The account send attempt committed before the click (docs/GO-CONCURRENCY-SPEC.md section 5). */
  send_attempt_id?: string;
  conversation_url?: string; submission_event_id?: string; output_file?: string; output_sha256?: string;
  cleanup?: string; failure_code?: string;
};

export type GoOptions = {
  stateDir: string; requestId: string; accountDir?: string;
  repositoryId?: string; taskId?: string; coordinator?: ChatGptCoordinator; kind?: string; profile?: ModelProfile;
  prompt?: string; promptFile?: string; timeoutMinutes?: number; maxPerHour?: number;
  /** Fail with ACCOUNT_BUSY instead of waiting for a free slot. */
  noWait?: boolean;
  /** Called while the request waits for a slot. */
  onWait?: (position: number, used: number, max: number) => void;
  workspaceRequestId?: string; baseRef?: string; headRef?: string; scopePrefix?: string;
  /** Code only: commands run in the checkout after the workspace is sealed. */
  checks?: string[];
  /** Code only: let the write grant enable the `exec` shell tool. */
  exec?: boolean;
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
  outcome: string | null; participant: string | null; output_source: string | null;
  sealed: string | null; checks: CheckResult[] | null; candidate_changed: boolean | null; checks_error: string | null;
};

const requestHash = (requestId: string) => sha256(`chatgpt-go\0${requestId}`);
const manifestPath = (requestId: string) => `chatgpt-go/${requestHash(requestId)}`;
/** Admission identity: the same request ID in two state directories is two different requests. */
const accountKey = (stateDir: string, requestId: string) => `${requestId}@${sha256(stateDir).slice(0, 12)}`;
const requestLockKey = (requestId: string) => `chatgpt-go-${requestHash(requestId).slice(0, 16)}`;
const conversationId = (url: string | undefined) => url?.match(/\/c\/([A-Za-z0-9-]+)/)?.[1] ?? 'unknown';

export function goRequestDigest(o: {
  repositoryId: string; taskId: string; coordinator: string; kind: string; profile: string; promptSha256: string;
  review?: GoReviewTarget; workspaceRequestId?: string; code?: GoCodeTarget;
}) {
  const parts: unknown[] = ['chatgpt-go-request-v1', o.repositoryId, o.taskId, o.coordinator, o.kind, o.profile, o.promptSha256];
  if (o.review) parts.push(o.review.workspace_request_id, o.review.base_ref, o.review.head_ref, o.review.scope_prefix ?? '');
  else if (o.workspaceRequestId) parts.push('workspace', o.workspaceRequestId);
  if (o.code) parts.push('code', o.code.base_ref ?? '', o.code.checks, o.code.exec);
  return sha256(JSON.stringify(parts));
}

function result(m: GoManifest, run?: ChatGptRunRecord): GoResult {
  return {
    request_id: m.request_id, phase: m.phase, run_id: m.run_id ?? null, run_state: run?.state ?? null,
    conversation_url: m.conversation_url ?? null, output_file: m.output_file ?? null,
    cleanup: m.cleanup ?? null, failure_code: m.failure_code ?? null,
    outcome: run?.outcome ?? null, participant: m.participant ?? null, output_source: m.output_source ?? null,
    sealed: m.sealed ?? null, checks: m.checks ?? null, candidate_changed: m.candidate_changed ?? null,
    checks_error: m.checks_error ?? null
  };
}

/** Account-module failures surface with their own codes. */
const asGo = (error: unknown) => error instanceof AccountError ? new GoError(error.code, error.message) : error;

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
    await releaseSlot(await StateStore.open(accountDir), accountKey(store.dir, requestId),
      { action: 'release-admission', reason, now: new Date() });
    return { request_id: requestId, released: true, run_state: run?.state ?? null, reason };
  } finally { await lock.release(); }
}

export async function goStatus(stateDir: string, requestId: string) {
  const store = await StateStore.inspect(stateDir);
  const m = await store?.read<GoManifest>(manifestPath(requestId), GO_KIND);
  if (!m) throw new GoError('NO_SUCH_REQUEST', `No go request ${requestId}.`);
  return result(m, m.run_id ? await chatGptRunStatus(m.run_id, stateDir) : undefined);
}

/**
 * `go` requests that still use `taskId`: non-terminal manifests that have a run, or whose
 * request lock a live process holds (waiting for a slot or setting up). `task finish`
 * refuses while any exist (docs/GO-CONCURRENCY-SPEC.md section 9).
 */
export async function activeGoRequestsForTask(stateDir: string, taskId: string) {
  const store = await StateStore.inspect(stateDir);
  if (!store) return [];
  const active: string[] = [];
  for (const name of await store.list('chatgpt-go')) {
    if (!/^[0-9a-f]{64}$/.test(name)) continue;
    // An unreadable manifest may belong to a running request: fail closed, never skip it.
    let m: GoManifest | undefined;
    try { m = await store.read<GoManifest>(`chatgpt-go/${name}`, GO_KIND); }
    catch (error) { throw new SafeError(`TASK_IN_USE: go manifest ${name} is unreadable (${error instanceof Error ? error.message : 'error'}); inspect it before finishing a task.`); }
    if (!m) continue;
    if (typeof m.task_id !== 'string' || typeof m.request_id !== 'string' || typeof m.phase !== 'string') {
      throw new SafeError(`TASK_IN_USE: go manifest ${name} is corrupt; inspect it before finishing a task.`);
    }
    if (m.task_id !== taskId) continue;
    const terminal = m.phase === 'cleaned' || m.phase === 'failed';
    // A terminal coding request whose workspace is not verified revoked may still own it.
    if (terminal && m.kind === 'code' && m.grant_id && m.sealed !== 'revoked') { active.push(m.request_id); continue; }
    let live = false;
    // An unreadable lock may belong to a live waiter: count it as live.
    let lock: unknown;
    try { lock = await store.read<unknown>(`locks/${requestLockKey(m.request_id)}.json`, 'lock'); }
    catch { lock = 'unreadable'; }
    if (lock === 'unreadable') live = true;
    else if (lock) {
      try {
        const r = validateLockRecord(lock, 'chatgpt-go request');
        live = r.hostname !== os.hostname() || (lockOwnerAlive(r.pid) && !pidReusedSince(r.pid, r.acquired_at));
      }
      catch { live = true; }
    }
    if (live || (!terminal && (m.run_id || m.pending_run_id))) active.push(m.request_id);
  }
  return active;
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
          (options.profile !== undefined && options.profile !== saved.profile) ||
          (options.workspaceRequestId !== undefined &&
            options.workspaceRequestId !== (saved.review?.workspace_request_id ?? saved.workspace_request_id)) ||
          (options.baseRef !== undefined && options.baseRef !== (saved.review?.base_ref ?? saved.code?.base_ref)) ||
          (options.headRef !== undefined && options.headRef !== saved.review?.head_ref) ||
          (options.scopePrefix !== undefined && options.scopePrefix !== saved.review?.scope_prefix) ||
          (options.checks !== undefined && JSON.stringify(options.checks) !== JSON.stringify(saved.code?.checks ?? [])) ||
          (options.exec !== undefined && options.exec !== (saved.code?.exec ?? false))) {
        throw new GoError('REQUEST_CONFLICT', `Request ${options.requestId} already exists with different inputs.`);
      }
    } else if (prompt !== undefined) {
      const kind = options.kind ?? 'architecture';
      if (kind !== 'architecture' && kind !== 'review' && kind !== 'code') throw new GoError('KIND_UNSUPPORTED', 'go supports --kind architecture, review or code.');
      const profile = options.profile ?? kind;
      if (!options.repositoryId || !options.taskId || !options.coordinator) throw new GoError('INVALID_REQUEST', 'go needs --repository, --task and --coordinator.');
      const review = kind === 'review' ? reviewTarget(options, prompt, profile) : undefined;
      if (!review && [options.headRef, options.scopePrefix].some(v => v !== undefined)) {
        throw new GoError('INVALID_REQUEST', 'Review target options need --kind review.');
      }
      if (kind === 'architecture' && options.baseRef !== undefined) throw new GoError('INVALID_REQUEST', '--base-ref needs --kind review or code.');
      if (kind !== 'code' && (options.checks?.length || options.exec)) throw new GoError('INVALID_REQUEST', '--check and --exec need --kind code.');
      let code: GoCodeTarget | undefined;
      if (kind === 'code') {
        if (profile !== 'code' && profile !== 'code-hard') throw new GoError('INVALID_REQUEST', 'Code profile must be code or code-hard.');
        if (!options.workspaceRequestId) throw new GoError('INVALID_REQUEST', 'go --kind code needs --workspace-request-id.');
        if (/write_grant:\s*wg1\./.test(prompt)) throw new GoError('INVALID_REQUEST', 'go issues the write grant itself; remove it from the prompt.');
        code = { ...(options.baseRef ? { base_ref: options.baseRef } : {}), checks: options.checks ?? [], exec: !!options.exec };
      }
      const workspaceRequestId = review ? undefined : options.workspaceRequestId;
      if (workspaceRequestId !== undefined) requireNamedWorkspace(workspaceRequestId, prompt);
      // A request ID that already opened a workspace would bind this run to an older
      // workspace, its participant and its report.
      const ws = review?.workspace_request_id ?? workspaceRequestId;
      if (ws) {
        // A durable claim makes the ID single-use across requests, including one that is
        // queued behind ACCOUNT_BUSY while another request still has to open it.
        const claim = `chatgpt-go-ws/${sha256(`chatgpt-go-ws\0${ws}`)}`;
        const owner = await store.create(claim, WS_CLAIM_KIND, { request_id: options.requestId })
          ? options.requestId : (await store.read<{ request_id: string }>(claim, WS_CLAIM_KIND))?.request_id;
        if (owner !== options.requestId || await workspaceForOpenRequest(options.stateDir, ws)) {
          throw new GoError('INVALID_REQUEST', `Workspace request ID ${ws} was already used; use a fresh one.`);
        }
      }
      const promptSha256 = sha256(prompt);
      const digest = goRequestDigest({ repositoryId: options.repositoryId, taskId: options.taskId,
        coordinator: options.coordinator, kind, profile, promptSha256, review, workspaceRequestId, code });
      const at = now().toISOString();
      m = {
        request_id: options.requestId, request_digest: digest, repository_id: options.repositoryId,
        task_id: options.taskId, coordinator: options.coordinator, kind, profile, ...(review ? { review } : {}),
        ...(workspaceRequestId ? { workspace_request_id: workspaceRequestId } : {}), ...(code ? { code } : {}),
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
      sessionId: this.m.session_id,
      ...(run.commit_binding ? { headCommit: run.commit_binding.head_commit, candidateDigest: run.commit_binding.candidate_digest } : {})
    };
  }

  private requirePrompt() {
    if (this.prompt === undefined) throw new GoError('PROMPT_REQUIRED', 'This step needs the prompt; pass the same --prompt-file again.');
    if (sha256(this.prompt) !== this.m.prompt_sha256) throw new GoError('REQUEST_CONFLICT', 'Prompt does not match this request.');
    // A per-request marker on the first line lets recovery tell this run's message from any
    // other chat that starts with the same text.
    return `Run ${requestHash(this.m.request_id).slice(0, 16)}\n\n${this.prompt}`;
  }

  private get key() { return accountKey(this.store.dir, this.m.request_id); }
  private get accountDir() { return this.options.accountDir ?? DEFAULT_ACCOUNT_DIR; }

  /**
   * Release this request's slot unless something may still need it: a latch that could not
   * be persisted, or a coding run whose workspace is not revoked or whose exec still runs.
   */
  private async releaseSlot() {
    if (this.keepSlot) return;
    if (this.m.kind === 'code' && !(await this.checkoutQuiet())) {
      process.stderr.write(`keeping the coding slot: workspace ${this.m.sealed ?? 'not sealed'}; resume to finish cleanup\n`);
      return;
    }
    await releaseSlot(this.account, this.key);
  }

  /** A coding run may give up its checkout only once its workspace is revoked and no exec runs. */
  private async checkoutQuiet() {
    if (!this.m.grant_id) return true;
    if (this.m.sealed !== 'revoked') return false;
    const scan = await execSessionsQuiet(this.stateDir, this.m.task_id, this.m.created_at).catch(() => ({ quiet: false, reason: 'scan failed' }));
    if (!scan.quiet) process.stderr.write(`checkout not quiet: ${scan.reason}\n`);
    return scan.quiet;
  }

  /** The setup lease covers every step that activates a tab or sends input; it is never held while waiting for an answer. */
  private lease?: SetupLease;
  private async takeLease() { this.lease ??= await acquireSetupLease(this.account, this.sleep); }
  /** Release the lease; a release that keeps failing is raised, never forgotten. */
  private async dropLease() {
    const lease = this.lease;
    if (!lease || this.holdLease) return;
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await lease.release(); this.lease = undefined; return; }
      catch (error) { last = error; await new Promise(r => setTimeout(r, 200)); }
    }
    throw new GoError('LEASE_RELEASE_FAILED', `Could not release the setup lease: ${last instanceof Error ? last.message : String(last)}`);
  }

  /** Record a tab that reattach replaced, so cleanup closes the right one. */
  private async trackTarget() {
    const current = this.page.currentTargetId?.();
    if (current && current !== this.m.target_id) await this.save({ target_id: current });
  }

  /** Latch the account on a verified page warning (docs/GO-CONCURRENCY-SPEC.md section 6). */
  private async checkSignal() {
    const signal = await this.page.accountSignal?.().catch(() => null);
    if (signal) await this.latch(signal);
    return signal ?? null;
  }

  /** A latch that could not be persisted anywhere keeps this request's slot and is raised. */
  private keepSlot = false;
  private async latch(code: string) {
    for (let attempt = 0; ; attempt++) {
      try {
        await setLatch(this.account, this.accountDir, { code, key: this.key, by: 'driver' }, this.now());
        if (this.m.latch_pending) await this.save({ latch_pending: undefined });
        return;
      } catch (error) {
        // Remember the stop in the manifest so every later run of this request retries it,
        // and hold the setup lease meanwhile: every send commit of every run happens under it.
        this.keepSlot = true;
        if (attempt === 0) await this.save({ latch_pending: code }).catch(() => {});
        if (!this.lease) await this.takeLease().catch(() => {});
        if (attempt >= LATCH_RETRIES) {
          // Leave the lease to dead-owner recovery when this process exits.
          this.holdLease = true;
          throw error;
        }
        await this.sleep(LATCH_RETRY_MS);
      }
    }
  }
  /** Set when a stop could not be persisted: the lease is never released by this process. */
  private holdLease = false;

  private async finish(phase: 'cleaned' | 'failed', patch: Partial<GoManifest> = {}) {
    // The process ends right after; a lease it could not release is recovered from a dead owner.
    await this.dropLease().catch(() => {});
    // The run is terminal: release the account even if a manifest or cleanup write fails.
    try {
      await this.save({ ...patch, phase });
      await this.closeReview();
      await this.seal();
    } finally {
      await this.releaseSlot();
    }
    return result(this.m, this.m.run_id ? await this.run() : undefined);
  }

  private async hold(code: string) {
    await this.dropLease().catch(() => {});
    const run = await this.run();
    if (run.state === 'submission-reserved' || run.state === 'submitted') await markChatGptRunUncertain(run.run_id, code, this.stateDir, this.now());
    await this.save({ phase: 'uncertain', failure_code: code });
    return result(this.m, await this.run());
  }

  private async slotRequest(): Promise<SlotRequest> {
    let checkout: string | null = null;
    if (this.m.kind === 'code') {
      const root = (await readMultiRepoCatalog(this.stateDir)).repositories[this.m.repository_id]?.root;
      // Fail closed: a lexical fallback could give one checkout two identities.
      if (!root) throw new GoError('REPOSITORY_UNAVAILABLE', `Registered repository ${this.m.repository_id} is missing.`);
      checkout = await realpath(root).catch(() => { throw new GoError('REPOSITORY_UNAVAILABLE', `Cannot resolve checkout ${root}.`); });
    }
    return { key: this.key, requestId: this.m.request_id, stateDir: this.store.dir, kind: this.m.kind, checkout };
  }

  /**
   * A slot means "this request may have an unresolved turn". Without a journal run nothing
   * was sent, and a terminal run has nothing left to send: only then is the slot freed.
   */
  private async releaseIfProvablyUnsent() {
    if (this.keepSlot) return;
    const runId = this.m.run_id ?? this.m.pending_run_id;
    const run = runId ? await chatGptRunStatus(runId, this.stateDir).catch(() => undefined) : undefined;
    // A completed coding run may still be sealing or running checks in its checkout: keep
    // the slot until a resume finishes cleanup.
    if (run?.state === 'completed' && this.m.kind === 'code') return;
    // A terminal journal run has nothing left to send, whatever the manifest says.
    if (run && (run.state === 'completed' || run.state === 'failed-pre-submit')) { await this.releaseSlot().catch(() => {}); return; }
    if (this.m.send_intent_at) return;
    const unreadable = runId && !run && this.m.run_id;
    if (!unreadable && !run) await this.releaseSlot().catch(() => {});
  }

  async drive(): Promise<GoResult> {
    // Ctrl-C or a kill while holding a slot: free it when nothing can have been sent.
    const onSignal = (signal: NodeJS.Signals) => {
      // The lease is left to dead-owner recovery, which waits for in-flight input to settle.
      void (async () => {
        await this.releaseIfProvablyUnsent();
      })().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    try {
      return await this.driveInner();
    } catch (error) {
      // A click may still be in flight after a post-commit failure: let it settle first.
      if (this.lease && this.m.phase === 'send-intent') await this.sleep(CLICK_SETTLE_MS).catch(() => {});
      await this.dropLease().catch(() => {});
      await this.releaseIfProvablyUnsent();
      throw asGo(error);
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  }

  private async driveInner(): Promise<GoResult> {
    if (this.m.latch_pending) await this.latch(this.m.latch_pending);
    if (this.m.phase === 'cleaned' || this.m.phase === 'failed') {
      // A finished request must never keep the account; output repair is reported separately.
      let repair: unknown;
      try {
        if (this.m.output_file) await this.ensureOutputFile().catch(error => { repair = error; });
        await this.closeReview();
        await this.seal();
        if (this.m.phase === 'cleaned') await this.runChecks();
      } finally {
        await this.releaseSlot();
      }
      if (repair) throw repair;
      return result(this.m, this.m.run_id ? await this.run() : undefined);
    }
    if (!this.m.run_id && this.m.pending_run_id) {
      // Preparation may have become durable before the manifest recorded it.
      const exists = await chatGptRunStatus(this.m.pending_run_id, this.stateDir).then(() => true, () => false);
      if (exists) await this.save({ run_id: this.m.pending_run_id });
    }
    if (this.m.run_id) {
      // Recovery never sends, so it never waits for capacity, the queue or the latch.
      await adoptSlot(this.account, await this.slotRequest(), this.now());
      return this.recover();
    }
    await admitSlot(this.account, this.accountDir, await this.slotRequest(),
      { noWait: this.options.noWait, sleep: this.sleep, now: this.now, onWait: this.options.onWait });
    return this.fresh();
  }

  /** No run exists yet: set up the tab, then prepare, select, reserve and send once. */
  private async fresh(): Promise<GoResult> {
    const prompt = this.requirePrompt();
    // Wait for the send gap before taking the lease and before preparing, so no wait
    // sits inside the selection window. Recheck under the lease.
    while (true) {
      await waitForSendWindow(this.account, this.accountDir, { maxPerHour: this.options.maxPerHour, sleep: this.sleep, now: this.now });
      await this.takeLease();
      try {
        await waitForSendWindow(this.account, this.accountDir, { maxPerHour: this.options.maxPerHour, sleep: async () => { throw new GoError('GAP_RECHECK'); }, now: this.now });
        break;
      } catch (error) {
        await this.dropLease();
        if (!(error instanceof GoError && error.code === 'GAP_RECHECK')) throw error;
      }
    }
    // The text actually sent; for code it ends with the write grant. Page matching uses
    // `prompt`, a prefix of it, so recovery never needs the grant again.
    let sent = prompt;
    try {
      const { targetId } = await this.page.open();
      await this.page.attachRepoMcp();
      sent = await this.withGrant(prompt);
      await this.page.pastePrompt(sent);
      await this.save({ phase: 'tab-ready', target_id: targetId, pending_run_id: this.m.pending_run_id ?? randomUUID() });
    } catch (error) {
      process.stderr.write(`browser setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
      // A latch failure is raised and keeps the slot (never swallowed).
      if (error instanceof GoError && error.code === 'BROWSER_CHALLENGE') await this.latch('BROWSER_CHALLENGE');
      else await this.checkSignal();
      await this.page.closeTab().catch(() => {});
      return this.finish('failed', { failure_code: codeOf(error, 'BROWSER_SETUP_FAILED') });
    }
    let prepared: ChatGptRunRecord;
    let targetOk = true;
    try {
      if (this.m.review) {
        const r = this.m.review;
        const joined = await prepareOrJoinReview({
          stateDir: this.stateDir, repositoryId: this.m.repository_id, taskId: this.m.task_id,
          coordinator: this.m.coordinator, profile: this.m.profile as 'review' | 'review-critical', surface: 'chat',
          sessionId: this.m.session_id, workspaceRequestId: r.workspace_request_id, prompt,
          baseRef: r.base_ref, headRef: r.head_ref, scopePrefix: r.scope_prefix, runId: this.m.pending_run_id, now: this.now()
        });
        prepared = joined.run;
        // The pinned target the prompt names must be exactly what the journal bound.
        const binding = prepared.commit_binding;
        targetOk = joined.participant.task_id === this.m.task_id && prepared.task_id === this.m.task_id &&
          binding?.base_commit === r.base_ref && binding?.head_commit === r.head_ref &&
          JSON.stringify(joined.participant.commit_binding ?? null) === JSON.stringify(binding);
      } else {
        prepared = await prepareChatGptRun({
          stateDir: this.stateDir, repositoryId: this.m.repository_id, taskId: this.m.task_id,
          coordinator: this.m.coordinator, workKind: this.m.kind, profile: this.m.profile, surface: 'chat',
          sessionId: this.m.session_id, prompt: sent, runId: this.m.pending_run_id, now: this.now(),
          ...(this.m.code?.base_ref ? { baseRef: this.m.code.base_ref } : {})
        });
      }
    } catch (error) {
      process.stderr.write(`prepare failed: ${error instanceof Error ? error.message : String(error)}\n`);
      await this.checkSignal();
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
    // A joined participant from an earlier attempt is not this attempt's fresh run.
    if (prepared.run_id !== this.m.pending_run_id) return this.recover();
    if (!targetOk) {
      await failChatGptRunBeforeSubmit(prepared.run_id, 'REVIEW_TARGET_MISMATCH', this.stateDir, this.now());
      await this.page.closeTab().catch(() => {});
      return this.finish('failed', { failure_code: 'REVIEW_TARGET_MISMATCH' });
    }
    let authorized: boolean;
    let observedAt: Date;
    try {
      const picked = await this.page.selectEffort(target ?? '');
      observedAt = this.now();
      const evidence = await recordTrustedBrowserObservation({
        selectionId: prepared.selection.selection_id, surface: 'chat', controlLabel: picked.observedLabel,
        selectedAt: picked.selectedAt.toISOString(), observedAt: observedAt.toISOString(), sessionId: this.m.session_id
      }, { stateDir: path.join(this.stateDir, 'model-policy'), now: this.now() });
      const reserved = await reserveChatGptRun({ stateDir: this.stateDir, runId: prepared.run_id, contract: prepared.selection, evidence, now: this.now() });
      authorized = reserved.submission_authorized;
    } catch (error) {
      process.stderr.write(`model selection failed: ${error instanceof Error ? error.message : String(error)}\n`);
      await this.checkSignal();
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
    return this.send(prompt, observedAt);
  }

  private async send(prompt: string, observedAt: Date): Promise<GoResult> {
    // The send commit (spec section 5): slot, latch, cap and gap are checked and one
    // attempt is recorded atomically. A denial means nothing was clicked.
    // The commit and the send intent run under the task share gate, the same gate `task
    // finish` holds: either finish sees this request in use, or this send sees the task done.
    let committedAt = 0;
    try {
      // A challenge on this tab latches the account and stops this send before its commit.
      const signal = await this.checkSignal();
      if (signal) throw new GoError(signal, 'ChatGPT shows a browser check; nothing was sent.');
      await withTaskShareGate(this.stateDir, this.m.task_id, async () => {
        if (this.now().getTime() - observedAt.getTime() > OBSERVATION_MAX_AGE_MS) throw new GoError('SELECTION_STALE', 'The effort observation is too old to send on.');
        const task = (await readMultiRepoCatalog(this.stateDir)).tasks[this.m.task_id];
        if (!task || task.completed) throw new GoError('TASK_FINISHED', `Task ${this.m.task_id} was finished; nothing was sent.`);
        committedAt = this.now().getTime();
        const attemptId = await commitSend(this.account, this.accountDir, this.key, { maxPerHour: this.options.maxPerHour, now: new Date(committedAt) });
        await this.save({ phase: 'send-intent', send_intent_at: this.now().toISOString(), send_attempt_id: attemptId });
      }, `go send ${this.m.request_id}`);
    } catch (error) {
      // An intent that became durable means the click may follow; never treat it as denied.
      if (this.m.send_intent_at) throw error;
      // An unpersisted stop keeps the slot; nothing was sent, so the run still fails pre-submit.
      if (error instanceof AccountError && error.code === 'LATCH_WRITE_FAILED') this.keepSlot = true;
      return this.denySend(codeOf(asGo(error), 'SEND_DENIED'));
    }
    if (this.now().getTime() - committedAt > SEND_CLICK_DEADLINE_MS) {
      // This process has not clicked: the attempt stays charged, the run is not submitted.
      return this.denySend('SEND_LATE');
    }
    let clickFailed = false;
    try { await this.page.clickSend(); }
    catch { clickFailed = true; }
    // Every click command has returned. One that failed or timed out may still run in
    // Chrome, so move the attempt bound past a settle window and keep the lease while
    // confirming for that long; a clean return bounds the send by now.
    const settle = clickFailed ? CLICK_SETTLE_MS : 0;
    await extendSend(this.account, this.m.send_attempt_id!, new Date(this.now().getTime() + settle));
    if (clickFailed) await this.checkSignal();
    return this.confirmOrHold(prompt, 'SEND_UNCONFIRMED', Math.max(SEND_CONFIRM_MS, settle));
  }

  /** Nothing was clicked by this process: resolve the reserved run as not submitted. */
  private async denySend(code: string): Promise<GoResult> {
    const run = await this.run();
    await markChatGptRunUncertain(run.run_id, code, this.stateDir, this.now());
    await recoverChatGptRun(run.run_id, 'not-submitted', this.receipt(await this.run(),
      `chatgpt-go-denied-${requestHash(this.m.request_id).slice(0, 16)}-${this.now().toISOString()}`), this.stateDir, this.now());
    await this.page.closeTab().catch(() => {});
    return this.finish('failed', { failure_code: code });
  }

  /** Mark submitted only after the expected user message is seen in the conversation. */
  private async confirmOrHold(prompt: string, code: string, timeoutMs = SEND_CONFIRM_MS): Promise<GoResult> {
    const deadline = this.now().getTime() + timeoutMs;
    while (true) {
      // A challenge while confirming stops other runs' sends; this run keeps its own state.
      await this.checkSignal();
      const url = await this.page.conversationUrl().catch(() => undefined);
      if (url && url !== this.m.conversation_url) await this.save({ conversation_url: url });
      if (url && await this.page.hasExpectedUserMessage(prompt).catch(() => false)) break;
      if (this.now().getTime() >= deadline) return this.hold(code);
      await this.sleep(2_000);
    }
    if (this.m.send_attempt_id) await confirmSend(this.account, this.m.send_attempt_id, this.now()).catch(() => {});
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
    // Waiting for the answer runs in parallel with other requests.
    await this.dropLease();
    const deadline = this.now().getTime() + (this.options.timeoutMinutes ?? 45) * 60_000;
    let previous: TurnState | undefined;
    let unknownSince: number | undefined;
    let signalled = false;
    while (true) {
      // A challenge stops new work account-wide; this turn keeps being watched.
      if (!signalled) signalled = (await this.checkSignal()) !== null;
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
    // A report delivered through `finish` is the exact text ChatGPT chose to hand back; the
    // page text is the fallback. Either way only a finished turn completes the run.
    const report = await this.report();
    const answer = report?.summary_markdown ?? await this.page.readAnswer(prompt);
    if (!answer.trim()) return this.hold('EMPTY_ANSWER');
    return this.complete(answer, report ? report.outcome : undefined);
  }

  private async report() {
    const ws = this.m.review?.workspace_request_id ?? this.m.workspace_request_id;
    if (!ws) return undefined;
    const report = await readMcpReportForRequest(this.stateDir, ws).catch(() => undefined);
    // Only a workspace opened after this run's send can carry this run's report.
    const sentAt = this.m.send_intent_at ? Date.parse(this.m.send_intent_at) : NaN;
    return report && report.repository_id === this.m.repository_id && report.task_id === this.m.task_id &&
      Date.parse(report.workspace_issued_at) >= sentAt ? report : undefined;
  }

  private async complete(answer: string, reported?: McpReportOutcome): Promise<GoResult> {
    const run = await this.run();
    if (this.m.kind === 'review') {
      // The journal completes a shared review only after its participant is bound to the
      // workspace ChatGPT opened. Unbound means ChatGPT never opened it (yet): hold, and a
      // resume reconciles again; nothing is resent.
      try {
        await reconcileReviewParticipant({ stateDir: this.stateDir, taskId: this.m.task_id, participantId: run.participant_id! });
      } catch (error) {
        return this.hold(codeOf(error, 'WORKSPACE_RECONCILIATION_REQUIRED'));
      }
      // Only a workspace opened after this run's send can be this run's evidence.
      const selection = await workspaceForOpenRequest(this.stateDir, this.m.review!.workspace_request_id);
      if (!selection || !this.m.send_intent_at || Date.parse(selection.issued_at) < Date.parse(this.m.send_intent_at)) {
        return this.hold('WORKSPACE_STALE');
      }
    }
    if (this.m.kind === 'code' && this.m.grant_id) {
      // A coding answer without a coding workspace changed nothing; never report it as done.
      // The grant exists only in the sent text, so a consumed grant proves a fresh workspace.
      const grant = await grantState({ stateDir: this.stateDir, grantId: this.m.grant_id });
      if (grant.status !== 'consumed') return this.hold('WORKSPACE_NOT_OPENED');
    }
    const outputFile = path.join(this.store.dir, `${manifestPath(this.m.request_id)}.output.md`);
    await writeFile(outputFile, answer, { mode: 0o600 });
    const outcome = this.m.kind !== 'review' ? 'completed'
      : reported === 'ship' || reported === 'no-ship' ? reported : reviewVerdict(answer);
    const eventId = `chatgpt-go-complete-${conversationId(this.m.conversation_url)}-${this.now().toISOString()}`;
    // Build the receipt before reading the journal's "now", so the observation can never
    // appear to come from the future when the clock ticks between the two reads.
    const receipt = this.receipt(run, eventId);
    await completeChatGptRun({
      stateDir: this.stateDir, runId: run.run_id, output: answer, outcome, now: this.now(),
      receipt: { ...receipt, kind: 'completion', responseState: 'completed',
        submissionEventSha256: run.submission_event_sha256!, outputSha256: sha256(answer) }
    });
    if (await chatGptRunOutput(run.run_id, this.stateDir) !== answer) throw new GoError('OUTPUT_MISMATCH', 'Saved output differs from the capture.');
    await this.save({ phase: 'completed', output_file: outputFile, output_sha256: sha256(answer),
      output_source: reported ? 'mcp-report' : 'page' });
    return this.cleanup();
  }

  private async cleanup(): Promise<GoResult> {
    let cleanup = 'archived';
    try {
      await this.closeReview();
      await this.seal();
      await this.runChecks();
      try {
        await this.takeLease();
        if (!(await this.page.reattach(this.m.target_id, this.m.conversation_url))) throw new GoError('TAB_GONE');
        await this.trackTarget();
        if (await this.checkSignal()) throw new GoError('BROWSER_CHALLENGE');
        await this.page.archive();
        await this.page.closeTab();
      } catch (error) {
        cleanup = `warning:${codeOf(error, 'ARCHIVE_FAILED')}`;
      } finally {
        await this.dropLease();
      }
    } catch (error) {
      // The journal run is terminal: a failed cleanup write frees the slot unless the
      // checkout may still be in use (releaseSlot keeps coding slots until verified).
      await this.releaseSlot().catch(() => {});
      throw error;
    }
    return this.finish('cleaned', { cleanup });
  }

  /** Issue this request's single-use write grant (code only) and return the text to send. */
  private async withGrant(prompt: string) {
    if (this.m.kind !== 'code') return prompt;
    // A grant from an interrupted earlier setup was never sent; retire it first.
    if (this.m.grant_id) await revokeGrant({ stateDir: this.stateDir, grantId: this.m.grant_id }).catch(() => {});
    const grant = await issueWorkspaceGrant({ stateDir: this.stateDir, taskId: this.m.task_id, ttlMs: 15 * 60_000,
      ...(this.m.code?.exec ? { exec: true } : {}) });
    await this.save({ grant_id: grant.grant_id });
    return `${prompt}\n\nwrite_grant: ${grant.write_grant}`;
  }

  /**
   * Seal a code run once its run is terminal: revoke the workspace ChatGPT opened, or the
   * grant if it was never used, so no edit can land after the answer was saved.
   */
  private async seal() {
    if (this.m.kind !== 'code' || this.m.sealed === 'revoked' || !this.m.grant_id) return;
    if (this.m.run_id) {
      const run = await this.run().catch(() => undefined);
      if (run && run.state !== 'completed' && run.state !== 'failed-pre-submit') return;
    }
    let status = 'revoked';
    try {
      // The grant names the workspace it actually opened, whatever request ID ChatGPT used.
      const grant = await grantState({ stateDir: this.stateDir, grantId: this.m.grant_id });
      if (grant.status === 'open') await revokeGrant({ stateDir: this.stateDir, grantId: this.m.grant_id });
      else if (grant.consumed_by) await revokeWorkspace({ stateDir: this.stateDir, workspaceId: grant.consumed_by });
    } catch (error) {
      status = `warning:${codeOf(error, 'SEAL_FAILED')}`;
    }
    await this.save({ sealed: status });
  }

  /**
   * Run the requested project checks after sealing and report whether they changed the
   * candidate. Each result is saved as it lands, so a crash never reruns a finished check.
   * A failure here is recorded, never thrown: the run is terminal and must still finish.
   */
  private async runChecks() {
    if (this.m.kind !== 'code' || !this.m.code?.checks.length) return;
    if (this.m.checks?.length === this.m.code.checks.length || this.m.checks_error) return;
    try {
      // Checks against a workspace that may still accept edits would prove nothing.
      if (this.m.sealed !== 'revoked') throw new GoError('NOT_SEALED', `Workspace is not sealed (${this.m.sealed ?? 'unknown'}); checks skipped.`);
      const root = (await readMultiRepoCatalog(this.stateDir)).repositories[this.m.repository_id]?.root;
      if (!root) throw new GoError('REPOSITORY_UNAVAILABLE', 'Registered repository is missing.');
      if (!this.m.check_baseline && this.m.code.exec) {
        // A revoked workspace's exec command is cancelled within seconds; never take the
        // baseline while one still runs.
        const deadline = Date.now() + 20_000;
        while ((await activeExecSessions(this.stateDir, this.m.task_id)).length) {
          if (Date.now() > deadline) throw new GoError('EXEC_STILL_RUNNING', 'An exec command still runs after the seal; checks skipped.');
          await this.sleep(1_000);
        }
      }
      const before = this.m.check_baseline ?? await candidateDigest(root);
      if (!this.m.check_baseline) await this.save({ check_baseline: before });
      const checks = [...(this.m.checks ?? [])];
      for (let i = checks.length; i < this.m.code.checks.length; i++) {
        checks.push(await runCheck(root, this.m.code.checks[i], path.join(this.store.dir, `${manifestPath(this.m.request_id)}.check-${i}.log`)));
        await this.save({ checks });
      }
      await this.save({ candidate_changed: (await candidateDigest(root)) !== before });
    } catch (error) {
      await this.save({ checks_error: error instanceof Error ? error.message.slice(0, 500) : 'Checks failed.' });
    }
  }

  /**
   * Release this request's shared-review participant once its run is terminal, so it does
   * not block later rebind, phase or finish commands. Best effort: a failure is recorded
   * and retried by every later rerun of the request.
   */
  private async closeReview() {
    if (this.m.kind !== 'review' || !this.m.run_id || this.m.participant === 'closed') return;
    let status = 'closed';
    try {
      const run = await this.run();
      if (run.state !== 'completed' && run.state !== 'failed-pre-submit') return;
      if (!run.participant_id) throw new GoError('NO_PARTICIPANT');
      const ids = { stateDir: this.stateDir, taskId: this.m.task_id, participantId: run.participant_id };
      if (run.state === 'failed-pre-submit') await recoverReviewParticipant(ids);
      // ChatGPT may close its workspace before it finishes; the open-request ledger still binds it.
      else await reconcileReviewParticipant(ids).catch(() => {});
      await closeReviewParticipant({ ...ids, requestId: `go-close-${requestHash(this.m.request_id).slice(0, 32)}` });
    } catch (error) {
      status = `warning:${codeOf(error, 'REVIEW_CLOSE_FAILED')}`;
    }
    await this.save({ participant: status });
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
    await this.dropLease();
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
      case 'completed': {
        // The run is terminal: output repair must never keep the account held.
        let repair: unknown;
        await this.ensureOutputFile().catch(error => { repair = error; });
        const done = await this.cleanup();
        if (repair) throw repair;
        return done;
      }
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
        await this.takeLease();
        if (!(await this.page.reattach(this.m.target_id, this.m.conversation_url))) { await this.checkSignal(); return this.hold('TAB_GONE'); }
        await this.trackTarget();
        await this.checkSignal();
        await this.dropLease();
        if (this.m.phase !== 'submitted') await this.save({ phase: 'submitted' });
        return this.awaitAnswer(prompt);
      }
      default:
        throw new GoError('UNKNOWN_RUN_STATE', `Unexpected run state ${String(run.state)}.`);
    }
  }

  private async reattachAndConfirm(code: string): Promise<GoResult> {
    const prompt = this.requirePrompt();
    await this.takeLease();
    if (!(await this.page.reattach(this.m.target_id, this.m.conversation_url))) { await this.checkSignal(); return this.hold(code); }
    await this.trackTarget();
    await this.checkSignal();
    return this.confirmOrHold(prompt, code);
  }
}

function codeOf(error: unknown, fallback: string) {
  return (error instanceof GoError || error instanceof ReviewShareError) && /^[A-Z][A-Za-z0-9_:-]{0,63}$/.test(error.code)
    ? error.code.replace(/[:-]/g, '_').toUpperCase() : fallback;
}

/** ChatGPT opens the workspace with the ID the prompt names; a prompt without it cannot be linked. */
function requireNamedWorkspace(ws: string, prompt: string) {
  if (!REQUEST_ID.test(ws)) throw new GoError('INVALID_REQUEST', 'Invalid --workspace-request-id.');
  if (!prompt.includes(ws)) throw new GoError('INVALID_REQUEST', 'The prompt must name the --workspace-request-id.');
}

function reviewTarget(options: GoOptions, prompt: string, profile: string): GoReviewTarget {
  if (profile !== 'review' && profile !== 'review-critical') throw new GoError('INVALID_REQUEST', 'Review profile must be review or review-critical.');
  const ws = options.workspaceRequestId;
  if (!ws) throw new GoError('INVALID_REQUEST', 'go --kind review needs --workspace-request-id.');
  requireNamedWorkspace(ws, prompt);
  if (!COMMIT.test(options.baseRef ?? '') || !COMMIT.test(options.headRef ?? '')) {
    throw new GoError('INVALID_REQUEST', 'go --kind review needs --base-ref and --head-ref as full 40-hex commits.');
  }
  return { workspace_request_id: ws, base_ref: options.baseRef!, head_ref: options.headRef!,
    ...(options.scopePrefix ? { scope_prefix: options.scopePrefix } : {}) };
}

/** The last `VERDICT: SHIP|NO-SHIP` line decides; anything else fails closed to no-ship. */
export function reviewVerdict(answer: string): 'ship' | 'no-ship' {
  const lines = [...answer.matchAll(/^[\s>*_#`]*VERDICT[\s*_`]*[:\-–—][\s*_`]*(NO[- ]?SHIP|SHIP)\b/gim)];
  const last = lines.at(-1)?.[1]?.toUpperCase().replace(/[- ]/g, '');
  return last === 'SHIP' ? 'ship' : 'no-ship';
}
