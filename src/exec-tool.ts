import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { SafeError, sha256 } from './errors.js';
import { authorizeWorkspace, WorkspaceInvalidError, type AuthorizedWorkspace } from './multirepo-state.js';
import { StateStore, lockOwnerAlive } from './task-state.js';

// The exec shell for code workspaces (docs/EXEC-TOOL.md). A command runs as the broker
// user through /bin/sh in the registered checkout, with no sandbox. Each session has a
// durable record (written before spawn) and an owner-only log of merged stdout+stderr.

export const EXEC_DEFAULT_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
export const EXEC_PAGE_BYTES = 24 * 1024;
export const EXEC_OUTPUT_CAP_BYTES = 4 * 1024 * 1024;
export const EXEC_MAX_SESSIONS_PER_TASK = 20;
export const EXEC_DEFAULT_TIMEOUT_S = 600;
export const EXEC_MAX_TIMEOUT_S = 1800;
export const EXEC_DEFAULT_YIELD_MS = 10_000;
export const EXEC_MAX_WAIT_MS = 30_000;
export const EXEC_MAX_CMD_CHARS = 8192;
const KILL_GRACE_MS = 3_000;
const CLOSE_FALLBACK_MS = 5_000;
const WATCH_INTERVAL_MS = 1_000;
const RECORD_KIND = 'exec-session-v1';
/** Raw bytes per page leave room for a token that must not be split. */
const PAGE_SLACK = 256;
/** Bytes read past the page end so a token that crosses the cut is seen whole. */
const LOOKAHEAD = 256;
/** Longest token-like text (ws1/wg1 token is at most 134 chars) held back at a growing end. */
const HOLD_BYTES = 160;

export type ExecState = 'starting' | 'running' | 'exited' | 'failed' | 'cancelled' | 'timed_out' | 'uncertain';
const FINISHED: ExecState[] = ['exited', 'failed', 'cancelled', 'timed_out', 'uncertain'];

export type ExecSessionRecord = {
  session_id: string;
  workspace_id: string;
  repository_id: string;
  task_id: string;
  request_id: string;
  request_digest: string;
  cmd: string;
  cmd_sha256: string;
  cmd_length: number;
  timeout_s: number;
  state: ExecState;
  reason: string | null;
  exit_code: number | null;
  signal: string | null;
  output_bytes: number;
  truncated: boolean;
  broker_instance: string;
  broker_pid: number;
  /** Process group of the detached shell (its PID), once spawned. */
  pgid?: number;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  audit_warning?: string;
};

export type ExecAudit = (tool: string, era: string, ok: boolean, authorized?: AuthorizedWorkspace, data?: unknown) => Promise<void>;

type Running = {
  record: ExecSessionRecord;
  token: string;
  era: string;
  authorized: AuthorizedWorkspace;
  child?: ChildProcess;
  out?: WriteStream;
  flushed: number;
  written: number;
  waiters: Set<() => void>;
  done: Promise<void>;
  resolveDone: () => void;
  finalized: boolean;
  persistChain: Promise<void>;
  cancelReason?: string;
  timedOut: boolean;
  spawnFailed: boolean;
  logFailed: boolean;
  exited: boolean;
  terminating: boolean;
  killTimer?: NodeJS.Timeout;
  timeoutTimer?: NodeJS.Timeout;
  closeFallback?: NodeJS.Timeout;
  exitCode: number | null;
  exitSignal: string | null;
  startedMs: number;
  watchFailures: number;
  watching: boolean;
};

const TOKEN_PATTERN = /\b(?:ws1|wg1)\.[A-Za-z0-9_-]{1,32}\.[a-f0-9]{32}\.[A-Za-z0-9_-]{43,64}/g;
const TOKEN_CHAR = /[A-Za-z0-9._-]/;

/** Remove workspace tokens and write grants from text that leaves the broker. */
export function redactSecrets(text: string, extraSecrets: string[] = []) {
  let value = text.replace(TOKEN_PATTERN, '[redacted-token]');
  for (const secret of extraSecrets) if (secret.length >= 20) value = value.split(secret).join('[redacted-secret]');
  return value;
}

// Keep tab/newline/CR; other C0 controls and DEL become U+FFFD so the page stays plain text.
const sanitize = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '�');

const nowIso = () => new Date().toISOString();
const isFinished = (state: ExecState) => FINISHED.includes(state);

export class ExecManager {
  private readonly running = new Map<string, Running>();
  /** Final records whose disk write failed; authoritative for this broker's lifetime. */
  private readonly unsaved = new Map<string, ExecSessionRecord>();
  private readonly taskSerial = new Map<string, Promise<void>>();
  private readonly instance = randomBytes(16).toString('hex');
  private readonly toolchainPath: string;
  private readonly watchTimer: NodeJS.Timeout;
  private shuttingDown = false;
  private keySecret?: string;

  constructor(private readonly stateDir: string, private readonly audit: ExecAudit, options: { toolchainPath?: string } = {}) {
    const configured = options.toolchainPath ?? process.env.REPO_MCP_EXEC_PATH;
    this.toolchainPath = configured && configured.trim() ? configured : EXEC_DEFAULT_PATH;
    this.watchTimer = setInterval(() => this.watch(), WATCH_INTERVAL_MS);
    this.watchTimer.unref();
  }

  private recordPath(taskId: string, sessionId: string) { return `exec-sessions/${taskId}/${sessionId}.json`; }
  private async logPath(taskId: string, sessionId: string) {
    const store = await StateStore.open(this.stateDir);
    const dir = path.join(store.dir, 'exec-logs', taskId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return path.join(dir, `${sessionId}.log`);
  }

  private async serialized<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.taskSerial.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    this.taskSerial.set(taskId, tail);
    await previous;
    try { return await fn(); }
    finally {
      release();
      if (this.taskSerial.get(taskId) === tail) this.taskSerial.delete(taskId);
    }
  }

  private async secrets() {
    if (this.keySecret) return [this.keySecret];
    const store = await StateStore.inspect(this.stateDir).catch(() => undefined);
    const key = await store?.read<{ secret?: unknown }>('control/workspace-token-key.json', 'workspace-token-key').catch(() => undefined);
    if (key && typeof key.secret === 'string') this.keySecret = key.secret;
    return this.keySecret ? [this.keySecret] : [];
  }

  private notify(entry: Running) {
    // Waiters may re-register themselves, so detach the current set before calling them.
    const waiters = [...entry.waiters];
    entry.waiters.clear();
    for (const resolve of waiters) resolve();
  }

  /** Write the record (one retry). Resolves false when both attempts failed. */
  private persist(entry: Running): Promise<boolean> {
    const snapshot = { ...entry.record };
    const write = async () => {
      const store = await StateStore.open(this.stateDir);
      await store.write(this.recordPath(snapshot.task_id, snapshot.session_id), RECORD_KIND, snapshot);
    };
    const result = entry.persistChain.then(() => write().then(() => true, () =>
      new Promise(resolve => setTimeout(resolve, 100)).then(write).then(() => true, () => false)));
    entry.persistChain = result.then(() => {});
    return result;
  }

  /** A stored record, with starting/running records left by another broker instance turned into uncertain. */
  private async readRecord(taskId: string, sessionId: string): Promise<ExecSessionRecord | undefined> {
    const live = this.running.get(sessionId);
    if (live) return live.record;
    const unsaved = this.unsaved.get(sessionId);
    if (unsaved) return unsaved;
    const store = await StateStore.open(this.stateDir);
    const record = await store.read<ExecSessionRecord>(this.recordPath(taskId, sessionId), RECORD_KIND);
    if (!record || record.session_id !== sessionId || record.task_id !== taskId) return undefined;
    if ((record.state === 'starting' || record.state === 'running') && !this.running.has(sessionId)) {
      const uncertain: ExecSessionRecord = {
        ...record, state: 'uncertain',
        reason: record.state === 'starting' ? 'broker_stopped_before_spawn_was_confirmed' : 'broker_stopped_while_running'
      };
      await store.write(this.recordPath(taskId, sessionId), RECORD_KIND, uncertain);
      return uncertain;
    }
    return record;
  }

  /** Delete the oldest finished sessions (record and log) until at most `keep` remain. */
  private async prune(taskId: string, keep: number) {
    const store = await StateStore.open(this.stateDir);
    const names = (await store.list(`exec-sessions/${taskId}`)).filter(name => /^[a-f0-9]{32}\.json$/.test(name));
    const records: ExecSessionRecord[] = [];
    for (const name of names) {
      const record = await this.readRecord(taskId, name.slice(0, 32)).catch(() => undefined);
      if (record) records.push(record);
    }
    records.sort((a, b) => a.created_at.localeCompare(b.created_at));
    let count = records.length;
    for (const record of records) {
      if (count <= keep) break;
      if (!isFinished(record.state) || this.running.has(record.session_id)) continue;
      await rm(await this.logPath(taskId, record.session_id), { force: true });
      await store.remove(this.recordPath(taskId, record.session_id));
      this.unsaved.delete(record.session_id);
      count--;
    }
  }

  /**
   * Reserve, audit and spawn a command, or return the session an earlier call with the
   * same request_id created. Call under the workspace admission lock.
   */
  async start(authorized: AuthorizedWorkspace, token: string, era: string, input: { requestId: string; cmd: string; timeoutS?: number }) {
    if (this.shuttingDown) throw new SafeError('Repo MCP is shutting down; exec is not available.');
    if (input.cmd.includes('\u0000')) throw new SafeError('cmd must not contain NUL characters.');
    if (!input.cmd.trim()) throw new SafeError('cmd must not be empty.');
    const timeoutS = input.timeoutS ?? EXEC_DEFAULT_TIMEOUT_S;
    if (!Number.isSafeInteger(timeoutS) || timeoutS < 1 || timeoutS > EXEC_MAX_TIMEOUT_S) {
      throw new SafeError(`timeout_s must be an integer from 1 to ${EXEC_MAX_TIMEOUT_S}.`);
    }
    const workspaceId = authorized.selection.workspace_id;
    const taskId = authorized.task.task_id;
    const sessionId = sha256(`exec-session\0${workspaceId}\0${input.requestId}`).slice(0, 32);
    const digest = sha256(`${workspaceId}\0${input.cmd}`);
    return this.serialized(taskId, async () => {
      const prior = await this.readRecord(taskId, sessionId);
      if (prior) {
        if (prior.workspace_id !== workspaceId || prior.request_digest !== digest) {
          throw new SafeError('request_id was already used with a different cmd in this workspace; use a new request_id.');
        }
        return { session_id: sessionId, already_applied: true };
      }
      const busy = [...this.running.values()].find(entry => entry.record.task_id === taskId && !entry.finalized);
      if (busy) {
        throw new SafeError(`Another command is still running for this task (session_id ${busy.record.session_id}). Poll it with exec_poll or stop it with exec_cancel first.`);
      }
      await this.prune(taskId, EXEC_MAX_SESSIONS_PER_TASK - 1);
      const record: ExecSessionRecord = {
        session_id: sessionId, workspace_id: workspaceId, repository_id: authorized.repository.repository_id, task_id: taskId,
        request_id: input.requestId, request_digest: digest, cmd: redactSecrets(input.cmd), cmd_sha256: sha256(input.cmd),
        cmd_length: input.cmd.length, timeout_s: timeoutS, state: 'starting', reason: null, exit_code: null, signal: null,
        output_bytes: 0, truncated: false, broker_instance: this.instance, broker_pid: process.pid, created_at: nowIso(),
        started_at: null, ended_at: null, duration_ms: null
      };
      let resolveDone!: () => void;
      const done = new Promise<void>(resolve => { resolveDone = resolve; });
      const entry: Running = {
        record, token, era, authorized, flushed: 0, written: 0, waiters: new Set(), done, resolveDone, finalized: false,
        persistChain: Promise.resolve(), timedOut: false, spawnFailed: false, logFailed: false, exited: false, terminating: false, exitCode: null,
        exitSignal: null, startedMs: performance.now(), watchFailures: 0, watching: false
      };
      const store = await StateStore.open(this.stateDir);
      this.running.set(sessionId, entry);
      try {
        if (!await store.create(this.recordPath(taskId, sessionId), RECORD_KIND, record)) {
          throw new SafeError('exec session record already exists; retry with the same request_id to read it.');
        }
      } catch (error) {
        this.running.delete(sessionId);
        throw error;
      }
      try {
        await this.audit('exec', era, true, authorized, {
          phase: 'started', session_id: sessionId, request_id: input.requestId, cmd: record.cmd,
          cmd_sha256: record.cmd_sha256, cmd_length: record.cmd_length, timeout_s: timeoutS
        });
      } catch {
        entry.record = { ...record, state: 'failed', reason: 'audit_unavailable', ended_at: nowIso(), duration_ms: 0 };
        entry.finalized = true;
        await this.persist(entry);
        this.running.delete(sessionId);
        resolveDone();
        throw new SafeError('Audit log unavailable. The command was not run.');
      }
      await this.spawn(entry, authorized.repository.root, input.cmd);
      return { session_id: sessionId, already_applied: false };
    });
  }

  private async spawn(entry: Running, cwd: string, cmd: string) {
    const record = entry.record;
    let out: WriteStream;
    try {
      const logFile = await this.logPath(record.task_id, record.session_id);
      out = createWriteStream(logFile, { flags: 'wx', mode: 0o600 });
      await new Promise<void>((resolve, reject) => { out.once('open', () => resolve()); out.once('error', reject); });
    } catch {
      entry.spawnFailed = true;
      await this.finalize(entry, 'log_unavailable');
      return;
    }
    entry.out = out;
    out.on('error', () => { entry.logFailed = true; this.terminate(entry); });
    if (entry.cancelReason) { await this.finalize(entry); return; }
    const env: Record<string, string> = {
      PATH: this.toolchainPath,
      HOME: process.env.HOME ?? os.homedir(),
      USER: process.env.USER ?? os.userInfo().username,
      LANG: 'en_US.UTF-8',
      NO_COLOR: '1',
      TERM: 'dumb',
      PAGER: 'cat',
      GIT_PAGER: 'cat',
      CI: '1'
    };
    let child: ChildProcess;
    try {
      child = spawn('/bin/sh', ['-c', cmd], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch {
      entry.spawnFailed = true;
      await this.finalize(entry, 'spawn_failed');
      return;
    }
    entry.child = child;
    entry.startedMs = performance.now();
    entry.record = { ...entry.record, state: 'running', started_at: nowIso(), ...(child.pid ? { pgid: child.pid } : {}) };
    void this.persist(entry);
    entry.timeoutTimer = setTimeout(() => { entry.timedOut = true; this.terminate(entry); }, record.timeout_s * 1000);
    entry.timeoutTimer.unref();
    const onData = (stream: NodeJS.ReadableStream) => (chunk: Buffer) => {
      if (entry.record.truncated) return;
      const left = EXEC_OUTPUT_CAP_BYTES - entry.written;
      const part = chunk.length > left ? chunk.subarray(0, left) : chunk;
      if (part.length) {
        entry.written += part.length;
        const ok = out.write(part, error => {
          if (!error) { entry.flushed += part.length; this.notify(entry); }
        });
        if (!ok) { stream.pause(); out.once('drain', () => stream.resume()); }
      }
      if (chunk.length > left) {
        entry.record = { ...entry.record, truncated: true };
        this.terminate(entry);
      }
    };
    child.stdout!.on('data', onData(child.stdout!));
    child.stderr!.on('data', onData(child.stderr!));
    child.on('error', () => {
      if (!child.pid) { entry.spawnFailed = true; void this.finalize(entry, 'spawn_failed'); }
    });
    child.on('exit', (code, signal) => {
      entry.exited = true;
      entry.exitCode = code;
      entry.exitSignal = signal;
      // Stop any background leftovers of the command; the pipes then close.
      this.terminate(entry);
      entry.closeFallback = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); }, CLOSE_FALLBACK_MS);
      entry.closeFallback.unref();
    });
    child.on('close', () => { void this.finalize(entry); });
  }

  private killGroup(entry: Running, signal: NodeJS.Signals) {
    const pid = entry.child?.pid;
    if (!pid) return;
    try { process.kill(-pid, signal); } catch {}
  }

  /** SIGTERM the process group, then SIGKILL it after the grace period. Idempotent. */
  private terminate(entry: Running) {
    if (entry.terminating || entry.finalized) return;
    entry.terminating = true;
    this.killGroup(entry, 'SIGTERM');
    entry.killTimer = setTimeout(() => this.killGroup(entry, 'SIGKILL'), KILL_GRACE_MS);
    entry.killTimer.unref();
  }

  private async finalize(entry: Running, failure?: string) {
    if (entry.finalized) return;
    entry.finalized = true;
    clearTimeout(entry.timeoutTimer);
    clearTimeout(entry.killTimer);
    clearTimeout(entry.closeFallback);
    this.killGroup(entry, 'SIGKILL');
    if (entry.out && !entry.out.destroyed) {
      await Promise.race([
        new Promise<void>(resolve => entry.out!.end(() => resolve())),
        new Promise<void>(resolve => setTimeout(resolve, 2_000).unref())
      ]);
    }
    entry.flushed = entry.written;
    let state: ExecState, reason: string | null = null;
    if (entry.spawnFailed || failure) { state = 'failed'; reason = failure ?? 'spawn_failed'; }
    else if (entry.logFailed) { state = 'failed'; reason = 'log_write_failed'; }
    else if (entry.cancelReason) { state = 'cancelled'; reason = entry.cancelReason; }
    else if (entry.timedOut) { state = 'timed_out'; reason = `wall_clock_limit_${entry.record.timeout_s}s`; }
    else if (entry.record.truncated) { state = 'failed'; reason = `output_limit_${EXEC_OUTPUT_CAP_BYTES}_bytes`; }
    else state = 'exited';
    entry.record = {
      ...entry.record, state, reason, exit_code: entry.exitCode, signal: entry.exitSignal, output_bytes: entry.written,
      ended_at: nowIso(), duration_ms: Math.round(performance.now() - entry.startedMs)
    };
    try {
      await this.audit('exec', entry.era, true, entry.authorized, {
        phase: 'completed', session_id: entry.record.session_id, state, reason, exit_code: entry.exitCode,
        signal: entry.exitSignal, output_bytes: entry.written, truncated: entry.record.truncated, duration_ms: entry.record.duration_ms
      });
    } catch {
      entry.record = { ...entry.record, audit_warning: 'The command finished, but the completion audit record could not be written.' };
    }
    if (!await this.persist(entry)) {
      // Keep the final state in memory so this broker never reports it running or uncertain.
      entry.record = { ...entry.record, audit_warning: [entry.record.audit_warning, 'The final session record could not be saved; this result is kept only until the broker restarts.'].filter(Boolean).join(' ') };
      this.unsaved.set(entry.record.session_id, entry.record);
      await this.audit('exec', entry.era, false, entry.authorized, { phase: 'record_write_failed', session_id: entry.record.session_id, state }).catch(() => {});
    }
    this.running.delete(entry.record.session_id);
    this.notify(entry);
    entry.resolveDone();
    await this.prune(entry.record.task_id, EXEC_MAX_SESSIONS_PER_TASK).catch(() => {});
  }

  private async owned(workspaceId: string, taskId: string, sessionId: string) {
    if (!/^[a-f0-9]{32}$/.test(sessionId)) throw new SafeError('Unknown exec session for this workspace.');
    const record = await this.readRecord(taskId, sessionId);
    if (!record || record.workspace_id !== workspaceId) throw new SafeError('Unknown exec session for this workspace.');
    return record;
  }

  /** Check that the session belongs to the workspace. Call under the workspace admission lock. */
  async assertOwned(authorized: AuthorizedWorkspace, sessionId: string) {
    await this.owned(authorized.selection.workspace_id, authorized.task.task_id, sessionId);
  }

  // Resolves when `ready`, when the session left the running set (finalize completed), or after `ms`.
  private wait(sessionId: string, ms: number, ready: (entry: Running) => boolean) {
    const entry = this.running.get(sessionId);
    if (!entry || ms <= 0 || ready(entry)) return Promise.resolve();
    return new Promise<void>(resolve => {
      const deadline = Date.now() + ms;
      let timer: NodeJS.Timeout | undefined;
      const check = () => {
        const current = this.running.get(sessionId);
        if (!current || ready(current) || Date.now() >= deadline) { clearTimeout(timer); resolve(); return; }
        current.waiters.add(check);
      };
      timer = setTimeout(() => { entry.waiters.delete(check); resolve(); }, ms);
      check();
    });
  }

  waitForExit(sessionId: string, ms: number) { return this.wait(sessionId, ms, () => false); }
  waitForOutput(sessionId: string, offset: number, ms: number) { return this.wait(sessionId, ms, entry => entry.flushed > offset); }

  /** The session state and one output page from `cursor` (a byte offset). */
  async view(authorized: AuthorizedWorkspace, sessionId: string, cursor?: string) {
    const record = await this.owned(authorized.selection.workspace_id, authorized.task.task_id, sessionId);
    const live = this.running.get(sessionId);
    const finished = !live && isFinished(record.state);
    const total = live ? live.flushed : record.output_bytes;
    let offset = cursor === undefined ? 0 : Number(cursor);
    if (!/^(?:0|[1-9][0-9]{0,9})$/.test(cursor ?? '0') || !Number.isSafeInteger(offset) || offset > total) {
      throw new SafeError('Invalid exec cursor; pass the cursor value a previous exec or exec_poll returned.');
    }
    // A finished session can only page through what its log really holds.
    let available = total;
    if (finished) {
      const size = await stat(await this.logPath(record.task_id, record.session_id)).then(info => info.size, () => 0);
      available = Math.min(total, size);
      offset = Math.min(offset, available);
    }
    const page = await this.readPage(record, offset, available, finished);
    const next = offset + page.bytes;
    return {
      session_id: sessionId,
      state: record.state,
      ...(record.reason ? { reason: record.reason } : {}),
      exit_code: record.exit_code,
      ...(record.signal ? { signal: record.signal } : {}),
      output: page.text,
      cursor: String(next),
      has_more: finished ? next < available : true,
      truncated: record.truncated,
      output_bytes: total,
      duration_ms: live ? Math.round(performance.now() - live.startedMs) : record.duration_ms,
      timeout_s: record.timeout_s,
      ...(record.audit_warning ? { audit_warning: record.audit_warning } : {})
    };
  }

  private async readPage(record: ExecSessionRecord, offset: number, available: number, finished: boolean) {
    const want = Math.min(EXEC_PAGE_BYTES - PAGE_SLACK, available - offset);
    if (want <= 0) return { text: '', bytes: 0 };
    const handle = await open(await this.logPath(record.task_id, record.session_id), 'r').catch(() => undefined);
    if (!handle) return { text: '', bytes: 0 };
    let buffer: Buffer;
    try {
      buffer = Buffer.alloc(Math.min(available - offset, want + LOOKAHEAD));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      buffer = buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
    // tailKnown: the buffer ends where the output will always end, so nothing can be appended to a token there.
    const tailKnown = finished && offset + buffer.length >= available;
    const secrets = await this.secrets();
    const spans = secretSpans(buffer, secrets);
    let end = Math.min(want, buffer.length);
    if (end < buffer.length) {
      const newline = buffer.lastIndexOf(0x0a, end - 1);
      if (newline >= end / 2) end = newline + 1;
    }
    const settle = (cut: number) => {
      cut = avoidSpans(spans, cut);
      if (!tailKnown) {
        // The token-character run at the buffer end may be the first half of a token: hold it back.
        let runStart = buffer.length;
        while (runStart > 0 && TOKEN_CHAR.test(String.fromCharCode(buffer[runStart - 1]))) runStart--;
        const holdFrom = Math.max(runStart, buffer.length - HOLD_BYTES);
        if (holdFrom < cut) cut = holdFrom;
      }
      return cut < buffer.length || !tailKnown ? utf8Boundary(buffer, cut) : cut;
    };
    end = settle(end);
    let text = '';
    for (;;) {
      text = redactSecrets(sanitize(new TextDecoder('utf-8').decode(buffer.subarray(0, end))), secrets);
      const over = Buffer.byteLength(text, 'utf8') - EXEC_PAGE_BYTES;
      if (over <= 0 || end <= 1) break;
      end = settle(Math.max(1, end - over));
    }
    return { text, bytes: end };
  }

  /** Cancel a session. Returns after the process group is gone or the grace period passed. */
  async cancel(sessionId: string, reason: string) {
    const entry = this.running.get(sessionId);
    if (!entry) return false;
    const grace = () => Promise.race([entry.done, new Promise(resolve => setTimeout(resolve, KILL_GRACE_MS + CLOSE_FALLBACK_MS + 1_000).unref())]);
    // A command that already exited by itself keeps its exit result; only wait for its cleanup.
    if (entry.exited || entry.finalized) { await grace(); return false; }
    entry.cancelReason ??= reason;
    if (!entry.child) return true;
    this.terminate(entry);
    await Promise.race([entry.done, new Promise(resolve => setTimeout(resolve, KILL_GRACE_MS + CLOSE_FALLBACK_MS + 1_000).unref())]);
    return true;
  }

  /** Cancel every running command of a workspace (workspace_close, invalidation). */
  async cancelWorkspace(workspaceId: string, reason: string) {
    const targets = [...this.running.values()].filter(entry => entry.record.workspace_id === workspaceId);
    await Promise.all(targets.map(entry => this.cancel(entry.record.session_id, reason)));
  }

  // Revocation, expiry, phase change, rebind, disable and task finish make the token fail
  // authorization; two failed checks in a row cancel the command.
  private watch() {
    for (const entry of this.running.values()) {
      if (entry.finalized || entry.watching || !entry.child) continue;
      entry.watching = true;
      authorizeWorkspace(this.stateDir, entry.token, 'exec').then(
        () => { entry.watchFailures = 0; },
        error => {
          // Only a real loss of authority counts; transient read or I/O errors never cancel.
          if (!(error instanceof WorkspaceInvalidError)) return;
          if (++entry.watchFailures >= 2) void this.cancel(entry.record.session_id, 'workspace_no_longer_valid');
        }
      ).finally(() => { entry.watching = false; });
    }
  }

  async close() {
    this.shuttingDown = true;
    clearInterval(this.watchTimer);
    await Promise.all([...this.running.keys()].map(sessionId => this.cancel(sessionId, 'broker_shutdown')));
  }
}

/** Byte ranges of whole tokens and secrets in `buffer` (all are ASCII, so latin1 keeps offsets). */
function secretSpans(buffer: Buffer, secrets: string[]) {
  const text = buffer.toString('latin1');
  const spans: [number, number][] = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) spans.push([match.index!, match.index! + match[0].length]);
  for (const secret of secrets) {
    if (secret.length < 20) continue;
    for (let i = text.indexOf(secret); i >= 0; i = text.indexOf(secret, i + 1)) spans.push([i, i + secret.length]);
  }
  return spans;
}

/** Move a cut out of any span: before it, or after it when the span starts the page. */
function avoidSpans(spans: [number, number][], cut: number) {
  for (const [start, stop] of spans) if (start < cut && stop > cut) cut = start > 0 ? start : stop;
  return cut;
}

/** Are any exec sessions of `taskId` still starting or running, per the on-disk records? */
export async function activeExecSessions(stateDir: string, taskId: string) {
  const store = await StateStore.inspect(stateDir);
  if (!store) return [];
  const names = (await store.list(`exec-sessions/${taskId}`)).filter(name => /^[a-f0-9]{32}\.json$/.test(name));
  const active: { session_id: string; workspace_id: string; state: ExecState; broker_pid: number; created_at: string }[] = [];
  for (const name of names) {
    const record = await store.read<ExecSessionRecord>(`exec-sessions/${taskId}/${name}`, RECORD_KIND).catch(() => undefined);
    if (!record || (record.state !== 'starting' && record.state !== 'running')) continue;
    // A dead broker cannot be running it (an orphaned process group is not tracked).
    let alive = true;
    try { alive = lockOwnerAlive(record.broker_pid); } catch { alive = true; }
    if (!alive) continue;
    active.push({ session_id: record.session_id, workspace_id: record.workspace_id, state: record.state, broker_pid: record.broker_pid, created_at: record.created_at });
  }
  return active;
}

/**
 * Fail-closed proof that no exec command of `taskId` created at or after `since` can still
 * touch the checkout: every such record is readable and finished, or its broker and its
 * detached process group are both gone. Anything unprovable counts as busy.
 */
export async function execSessionsQuiet(stateDir: string, taskId: string, since: string): Promise<{ quiet: boolean; reason?: string }> {
  const store = await StateStore.inspect(stateDir);
  if (!store) return { quiet: true };
  const from = Date.parse(since);
  for (const name of await store.list(`exec-sessions/${taskId}`)) {
    if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
    let record: ExecSessionRecord | undefined;
    try { record = await store.read<ExecSessionRecord>(`exec-sessions/${taskId}/${name}`, RECORD_KIND); }
    catch { return { quiet: false, reason: `unreadable exec session ${name}` }; }
    if (!record || typeof record.state !== 'string' || !Number.isFinite(Date.parse(record.created_at))) return { quiet: false, reason: `malformed exec session ${name}` };
    if (Date.parse(record.created_at) < from) continue;
    if (record.state !== 'starting' && record.state !== 'running' && record.state !== 'uncertain') continue;
    let brokerAlive = true;
    try { brokerAlive = lockOwnerAlive(record.broker_pid); } catch { brokerAlive = true; }
    if (brokerAlive) return { quiet: false, reason: `exec session ${record.session_id} is ${record.state}` };
    if (!record.pgid) return { quiet: false, reason: `exec session ${record.session_id} lost its broker; its process group is unknown` };
    try { process.kill(-record.pgid, 0); return { quiet: false, reason: `exec session ${record.session_id} process group ${record.pgid} is still alive` }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return { quiet: false, reason: `cannot check process group ${record.pgid}` }; }
  }
  return { quiet: true };
}

/** Largest end <= `end` that does not cut a UTF-8 sequence. */
function utf8Boundary(buffer: Buffer, end: number) {
  if (end >= buffer.length) {
    // Trailing incomplete sequence: back off to its lead byte.
    let i = buffer.length - 1, cont = 0;
    while (i >= 0 && (buffer[i] & 0xc0) === 0x80 && cont < 3) { i--; cont++; }
    if (i < 0) return buffer.length;
    const lead = buffer[i];
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    return cont + 1 < need ? i : buffer.length;
  }
  let i = end;
  while (i > 0 && (buffer[i] & 0xc0) === 0x80 && end - i < 3) i--;
  return i > 0 ? i : end;
}
