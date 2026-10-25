import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SafeError } from './errors.js';

/**
 * The client token every MCP request to the loopback listener must carry as
 * `Authorization: Bearer <token>`. It lives owner-only in the broker state directory:
 * `client-auth/token` holds the token and `client-auth/authorization` the full header
 * value, which the tunnel client sends by file reference.
 */
export function clientAuthPaths(stateDir: string) {
  const dir = path.join(stateDir, 'client-auth');
  return { dir, token: path.join(dir, 'token'), header: path.join(dir, 'authorization') };
}

const TOKEN = /^[a-f0-9]{64}$/;

async function ownerOnlyFile(file: string) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new SafeError(`Client auth file ${file} must be an owner-only regular file (mode 600).`);
  }
}

/** Read the client token; fails when it is missing or unsafe. */
export async function readClientToken(stateDir: string) {
  const { token } = clientAuthPaths(stateDir);
  await ownerOnlyFile(token);
  const value = (await readFile(token, 'utf8')).trim();
  if (!TOKEN.test(value)) throw new SafeError(`Client token ${token} is malformed.`);
  return value;
}

/** Create the client token and its header file once; later calls return the same token. */
export async function ensureClientToken(stateDir: string) {
  const paths = clientAuthPaths(stateDir);
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await chmod(paths.dir, 0o700);
  try { await writeFile(paths.token, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const token = await readClientToken(stateDir);
  const header = `Bearer ${token}`;
  const current = await readFile(paths.header, 'utf8').catch(() => undefined);
  if (current !== header) {
    const temp = `${paths.header}.${process.pid}.tmp`;
    await writeFile(temp, header, { mode: 0o600 });
    await rename(temp, paths.header);
  }
  await ownerOnlyFile(paths.header);
  return token;
}

/** Constant-time check of an Authorization header against the client token. */
export function clientTokenMatches(header: string | string[] | undefined, token: string) {
  if (typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}
