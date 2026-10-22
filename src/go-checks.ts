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

export async function runCheck(root: string, cmd: string, log: string): Promise<CheckResult> {
  const file = await open(log, 'w+', 0o600);
  try {
    const { exit_code, timed_out } = await new Promise<{ exit_code: number | null; timed_out: boolean }>((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', cmd], {
        cwd: root, detached: true, stdio: ['ignore', file.fd, file.fd],
        env: checkEnv()
      });
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
