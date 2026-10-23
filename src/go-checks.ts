import { execFile, spawn } from 'node:child_process';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { sha256 } from './errors.js';

// Coordinator-side project checks for `go --kind code` (docs/GO-DRIVER-SPEC.md section 11).
// They run in the owner's checkout after the coding workspace is sealed, as the owner,
// with the coordinator's own environment. Output goes to owner-only log files; the
// result keeps only a short tail.

const run = promisify(execFile);
const CHECK_TIMEOUT_MS = 15 * 60_000;
const TAIL_BYTES = 2_000;

export type CheckResult = { cmd: string; exit_code: number | null; timed_out: boolean; log: string; tail: string };

/** Wait up to `ms` for a process group to disappear; false if it is still there. */
export async function processGroupGone(pgid: number, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (processGroupAlive(pgid)) {
    if (Date.now() > deadline) return false;
    await new Promise(r => setTimeout(r, 100));
  }
  return true;
}

/** Digest of everything a commit would take from the checkout: HEAD, tracked changes and untracked files. */
export async function candidateDigest(root: string) {
  const git = (...args: string[]) => run('git', ['-C', root, ...args], { maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' })
    .then(r => r.stdout as Buffer);
  const parts = await Promise.all([
    git('rev-parse', 'HEAD'),
    git('status', '--porcelain=v1', '-z', '--untracked-files=all'),
    git('diff', 'HEAD', '--binary'),
    git('ls-files', '-z', '--others', '--exclude-standard').then(async list => {
      // Untracked content, not just names, so an edit to a new file changes the digest.
      // Paths go through stdin (no argv limit); directories (nested repositories) are
      // named but not hashed, since hash-object rejects them.
      const names = list.toString('utf8').split('\0').filter(Boolean);
      const files: string[] = [];
      for (const name of names) if ((await lstat(path.join(root, name)).catch(() => undefined))?.isFile()) files.push(name);
      const hashes = files.length ? await hashPaths(root, files) : Buffer.alloc(0);
      return Buffer.concat([list, hashes]);
    })
  ]);
  return sha256(Buffer.concat(parts.flatMap(p => [p, Buffer.from('\0')])).toString('latin1'));
}

function hashPaths(root: string, files: string[]) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn('git', ['-C', root, 'hash-object', '--stdin-paths'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const out: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`git hash-object exited ${code}`)));
    child.stdin.end(files.join('\n') + '\n');
  });
}

/**
 * Checks run code ChatGPT may have edited, so they get a scrubbed environment: the
 * toolchain PATH and identity, never the coordinator's tokens or API keys.
 */
function checkEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat', CI: '1' };
}

/** True while the process group `pgid` (a detached check) still exists; unknown counts as alive. */
export function processGroupAlive(pgid: number) {
  try { process.kill(-pgid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Exit code of a gated check that was never released: its command did not run. */
const GATE_CLOSED = 97;

/**
 * Run one check in its own detached process group. The group starts gated: it waits on
 * stdin and runs `cmd` only after `onSpawn` has durably recorded the group. If recording
 * fails, or this process dies first, the gate closes (EOF) and the command never runs.
 */
export async function runCheck(root: string, cmd: string, log: string, onSpawn?: (pgid: number) => Promise<void>): Promise<CheckResult> {
  const file = await open(log, 'w+', 0o600);
  try {
    const { exit_code, timed_out } = await new Promise<{ exit_code: number | null; timed_out: boolean }>((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', `IFS= read -r _ || exit ${GATE_CLOSED}; exec /bin/sh -c "$1" check`, 'gate', cmd], {
        cwd: root, detached: true, stdio: ['pipe', file.fd, file.fd],
        env: checkEnv()
      });
      const release = async () => {
        try { if (child.pid && onSpawn) await onSpawn(child.pid); }
        catch (error) {
          // Not recorded: close the gate and stop the group; the command never ran.
          child.stdin?.end();
          try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ }
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        child.stdin?.end('go\n');
      };
      child.stdin?.on('error', () => { /* the gate may already be closed */ });
      void release();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } }, CHECK_TIMEOUT_MS);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        // Background children of the check must not outlive it and change the candidate later.
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* group already gone */ }
        resolve({ exit_code: code, timed_out: timedOut });
      });
    });
    const { size } = await file.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    return { cmd, exit_code, timed_out, log, tail: buffer.toString('utf8') };
  } finally {
    await file.close();
  }
}
