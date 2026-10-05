import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { SafeError } from './errors.js';
import { COMMAND_OUTPUT_BYTES, GIT_BUFFERED_BYTES } from './limits.js';

// Output beyond maxOutputBytes kills the process and sets truncated; callers choose a
// storage cap independent of response page size. With strictUtf8, stdout that is not
// valid UTF-8 sets invalid_utf8 and is never returned with replacement characters.
export async function execute(executable: string, args: string[], cwd: string, timeout = 10_000, runtimeEnv: Record<string, string> = {}, options: { maxOutputBytes?: number; strictUtf8?: boolean; stdin?: Uint8Array | string } = {}) {
  const maxBytes = options.maxOutputBytes ?? COMMAND_OUTPUT_BYTES;
  return new Promise<{ exit_code: number | null; signal: string | null; stdout: string; stderr: string; timed_out: boolean; truncated: boolean; invalid_utf8: boolean; duration_ms: number }>((resolve, reject) => {
    const start = performance.now();
    const hasStdin = options.stdin !== undefined;
    const child = spawn(executable, args, {
      cwd, shell: false, detached: true, stdio: [hasStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...runtimeEnv }
    });
    if (hasStdin) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(options.stdin);
    }
    const buffers = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    let bytes = 0, timed_out = false, truncated = false;
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
    const timer = setTimeout(() => { timed_out = true; kill(); }, timeout);
    for (const stream of ['stdout', 'stderr'] as const) child[stream]!.on('data', (b: Buffer) => {
      const left = maxBytes - bytes;
      if (left > 0) { const part = b.subarray(0, left); buffers[stream].push(part); bytes += part.length; }
      if (b.length > left) { truncated = true; kill(); }
    });
    child.on('error', () => { clearTimeout(timer); reject(new SafeError('Unable to start the configured command.')); });
    child.on('close', (exit_code, signal) => {
      clearTimeout(timer);
      kill();
      const out = Buffer.concat(buffers.stdout);
      const err = Buffer.concat(buffers.stderr);
      let stdout: string, stderr: string, invalid_utf8 = false;
      if (options.strictUtf8) {
        try {
          stdout = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(out);
          stderr = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(err);
        } catch {
          stdout = '';
          stderr = '';
          invalid_utf8 = true;
        }
      } else {
        stdout = out.toString('utf8');
        stderr = err.toString('utf8');
      }
      resolve({ exit_code, signal, stdout, stderr, timed_out, truncated, invalid_utf8, duration_ms: Math.round(performance.now() - start) });
    });
  });
}

const GIT_BASE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '--no-pager', '--literal-pathspecs'];
const CHILD_ENV = { PATH: '/usr/bin:/bin', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };

/**
 * Stream stdout to `dest` without holding it in memory. Output beyond maxBytes, invalid UTF-8,
 * a timeout or a write failure kills the process group; the caller discards `dest` unless the
 * result is clean. stderr is not kept.
 */
export async function executeToFile(executable: string, args: string[], cwd: string, dest: string, options: { maxBytes: number; timeout?: number; append?: boolean }) {
  return new Promise<{ exit_code: number | null; signal: string | null; bytes: number; timed_out: boolean; truncated: boolean; invalid_utf8: boolean; duration_ms: number }>((resolve, reject) => {
    const start = performance.now();
    const child = spawn(executable, args, { cwd, shell: false, detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: CHILD_ENV });
    const out = createWriteStream(dest, { flags: options.append ? 'a' : 'wx', mode: 0o600 });
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let bytes = 0, timed_out = false, truncated = false, invalid_utf8 = false, writeError: Error | undefined, spawnError = false;
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
    const timer = setTimeout(() => { timed_out = true; kill(); }, options.timeout ?? 10_000);
    out.on('error', error => { writeError = error; kill(); });
    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated || invalid_utf8 || writeError) return;
      bytes += chunk.length;
      if (bytes > options.maxBytes) { truncated = true; kill(); return; }
      try { decoder.decode(chunk, { stream: true }); } catch { invalid_utf8 = true; kill(); return; }
      if (!out.write(chunk)) { child.stdout.pause(); out.once('drain', () => child.stdout.resume()); }
    });
    child.on('error', () => { spawnError = true; clearTimeout(timer); out.destroy(); reject(new SafeError('Unable to start the configured command.')); });
    child.on('close', (exit_code, signal) => {
      if (spawnError) return;
      clearTimeout(timer);
      kill();
      try { decoder.decode(); } catch { invalid_utf8 = true; }
      out.end(() => {
        if (writeError) reject(new SafeError('Unable to store Git output.'));
        else resolve({ exit_code, signal, bytes, timed_out, truncated, invalid_utf8, duration_ms: Math.round(performance.now() - start) });
      });
    });
  });
}

export const runGitToFile = (cwd: string, args: string[], dest: string, options: { maxBytes: number; timeout?: number; append?: boolean }) =>
  executeToFile('/usr/bin/git', [...GIT_BASE, ...args], cwd, dest, options);

// Hooks, fsmonitor and pagers are disabled for every inspection command.
export const runGit = (cwd: string, args: string[], options: { strictUtf8?: boolean; timeout?: number; maxBytes?: number } = {}) =>
  execute('/usr/bin/git', [...GIT_BASE, ...args], cwd, options.timeout ?? 10_000, {}, { maxOutputBytes: options.maxBytes ?? GIT_BUFFERED_BYTES, strictUtf8: options.strictUtf8 });
