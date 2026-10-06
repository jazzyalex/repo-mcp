import { constants } from 'node:fs';
import { access, chmod, link, lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SafeError, sha256 } from './errors.js';
import { execute } from './exec.js';
import { StateStore, acquireLock } from './task-state.js';
import { PROJECT_BASE } from './version.js';

export const SERVER_LABEL = 'local.repo-mcp.server';

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };
export type PlistObject = { [key: string]: PlistValue };

export type ActiveServiceRecord = {
  task_id: string;
  root: string;
  root_digest: string;
  policy_path: string;
  policy_digest: string;
  state_dir: string;
  audit_path: string;
  port: number;
  allow_detached: boolean;
  generation: number;
  expected_server_version: string;
  configured_at: string;
};

type ActiveServiceConfig = Omit<ActiveServiceRecord, 'generation' | 'configured_at'>;

export type ActiveServiceDesired = ActiveServiceConfig & {
  generation?: undefined;
  configured_at?: undefined;
};

export type ProcessAttestation = {
  ok: true;
  name: 'repo-mcp';
  server_version: string;
  service_generation: number | null;
  task_id: string | null;
  root_digest: string;
  process_pid: number | null;
};

export type LocalHealthState = 'ready' | 'stopped' | 'wrong_generation' | 'wrong_task' | 'wrong_root' | 'wrong_version' | 'unhealthy' | 'blocked';

export type LoadedServiceJob = {
  pid: number;
  plist_path: string;
  definition?: PlistObject;
  program_arguments?: string[];
  working_directory?: string;
  environment_variables?: Record<string, string>;
  stdout_path?: string;
  stderr_path?: string;
  run_at_load?: boolean;
  keep_alive?: boolean;
  throttle_interval?: number;
};

export type WriterLockEvidence = { state: string; key: string; pid?: number; purpose?: string };

export type ServiceDriver = {
  isLoaded(): Promise<boolean>;
  inspectLoadedJob(): Promise<LoadedServiceJob | undefined>;
  bootout(): Promise<void>;
  bootstrap(): Promise<void>;
  kickstart(): Promise<void>;
  portOwnerPid(port: number): Promise<number | undefined>;
  portOccupied(port: number): Promise<boolean>;
  health(port: number): Promise<unknown>;
};

type InstallRecord = {
  label: string;
  target: string;
  installed_plist_sha256: string | null;
  plist_transaction?: {
    previous_sha256: string | null;
    desired_sha256: string;
    claim_path?: string;
    previous_definition?: PlistObject;
    desired_definition?: PlistObject;
    cleanup_pending?: boolean;
  };
  migration_state?: 'prepared' | 'prepared_unbound' | 'verified';
  legacy_backup_path?: string;
  legacy_backup_sha256?: string;
  legacy_original_path?: string;
  updated_at: string;
};

const HEX64 = /^[a-f0-9]{64}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const rootDigest = (root: string) => sha256(Buffer.from(root, 'utf8'));

function activeConfig(record: ActiveServiceConfig) {
  return {
    task_id: record.task_id,
    root: record.root,
    root_digest: record.root_digest,
    policy_path: record.policy_path,
    policy_digest: record.policy_digest,
    state_dir: record.state_dir,
    audit_path: record.audit_path,
    port: record.port,
    allow_detached: record.allow_detached,
    expected_server_version: record.expected_server_version
  };
}

function assertActive(record: ActiveServiceRecord) {
  if (!TASK_ID.test(record.task_id)) throw new SafeError('Active service record has an invalid task ID.');
  if (!path.isAbsolute(record.root) || !path.isAbsolute(record.policy_path) || !path.isAbsolute(record.state_dir) || !path.isAbsolute(record.audit_path)) {
    throw new SafeError('Active service record paths must be absolute.');
  }
  if (!HEX64.test(record.root_digest) || !HEX64.test(record.policy_digest)) throw new SafeError('Active service record has an invalid digest.');
  if (!Number.isInteger(record.port) || record.port < 1024 || record.port > 65535) throw new SafeError('Active service record has an invalid port.');
  if (!Number.isSafeInteger(record.generation) || record.generation < 1) throw new SafeError('Active service record has an invalid generation.');
  if (typeof record.allow_detached !== 'boolean' || typeof record.expected_server_version !== 'string' || !record.expected_server_version) {
    throw new SafeError('Active service record is incomplete.');
  }
  if (!Number.isFinite(Date.parse(record.configured_at))) throw new SafeError('Active service record has an invalid configured_at.');
}

export async function readActiveService(store: StateStore) {
  const record = await store.read<ActiveServiceRecord>('control/active-service.json', 'active-service');
  if (record) assertActive(record);
  return record;
}

export async function writeActiveService(store: StateStore, desired: ActiveServiceDesired) {
  const previous = await readActiveService(store);
  const normalized = activeConfig(desired);
  if (previous && JSON.stringify(activeConfig(previous)) === JSON.stringify(normalized)) return previous;
  const record: ActiveServiceRecord = {
    ...normalized,
    generation: (previous?.generation ?? 0) + 1,
    configured_at: new Date().toISOString()
  };
  assertActive(record);
  await store.write('control/active-service.json', 'active-service', record);
  return record;
}

function xmlEscape(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function plistNode(value: PlistValue): string {
  if (typeof value === 'string') return `<string>${xmlEscape(value)}</string>`;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new SafeError('Plist integer is invalid.');
    return `<integer>${value}</integer>`;
  }
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  if (Array.isArray(value)) return `<array>${value.map(plistNode).join('')}</array>`;
  return `<dict>${Object.entries(value).map(([key, child]) => `<key>${xmlEscape(key)}</key>${plistNode(child)}`).join('')}</dict>`;
}

export function plistXml(value: PlistObject) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${plistNode(value)}\n</plist>\n`;
}

export function stableServerPlist(options: { base: string; node: string; stateDir: string }): PlistObject {
  const runtime = path.join(path.dirname(options.stateDir), 'server');
  return {
    Label: SERVER_LABEL,
    ProgramArguments: [options.node, path.join(options.base, 'dist/src/service-main.js')],
    WorkingDirectory: options.base,
    EnvironmentVariables: { REPO_MCP_STATE_DIR: options.stateDir },
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 10,
    StandardOutPath: path.join(runtime, 'stdout.log'),
    StandardErrorPath: path.join(runtime, 'stderr.log')
  };
}

export function legacyServerPlist(options: { base: string; node: string; repo: string; policy: string; port: string }): PlistObject {
  const trial = path.join(options.base, '.trial');
  return {
    Label: SERVER_LABEL,
    ProgramArguments: [options.node, path.join(options.base, 'dist/src/main.js')],
    WorkingDirectory: options.base,
    EnvironmentVariables: {
      REPO_ROOT: options.repo,
      REPO_MCP_POLICY: options.policy,
      REPO_MCP_AUDIT: path.join(trial, 'service-audit.jsonl'),
      PORT: options.port
    },
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 10,
    StandardOutPath: path.join(trial, 'service-stdout.log'),
    StandardErrorPath: path.join(trial, 'service-stderr.log')
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, canonical(object[key])]));
  }
  return value;
}

const samePlist = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function jobMatchesDefinition(job: LoadedServiceJob, target: string, expected: PlistObject) {
  if (job.plist_path !== target || !Number.isSafeInteger(job.pid) || job.pid < 1) return false;
  if (job.definition) return samePlist(job.definition, expected);
  const args = expected.ProgramArguments;
  const cwd = expected.WorkingDirectory;
  const env = expected.EnvironmentVariables;
  if (!Array.isArray(args) || !args.every(v => typeof v === 'string') || JSON.stringify(job.program_arguments) !== JSON.stringify(args) || typeof cwd !== 'string' || job.working_directory !== cwd || !env || typeof env !== 'object' || Array.isArray(env)) return false;
  const configured = env as Record<string, PlistValue>;
  const runtime = job.environment_variables ?? {};
  for (const [key, value] of Object.entries(configured)) if (typeof value !== 'string' || runtime[key] !== value) return false;
  if (!Object.keys(runtime).every(key => key in configured || key === 'XPC_SERVICE_NAME')) return false;
  return typeof expected.StandardOutPath === 'string' && job.stdout_path === expected.StandardOutPath &&
    typeof expected.StandardErrorPath === 'string' && job.stderr_path === expected.StandardErrorPath &&
    typeof expected.RunAtLoad === 'boolean' && job.run_at_load === expected.RunAtLoad &&
    typeof expected.KeepAlive === 'boolean' && job.keep_alive === expected.KeepAlive &&
    typeof expected.ThrottleInterval === 'number' && job.throttle_interval === expected.ThrottleInterval;
}

function assertLoadedJob(job: LoadedServiceJob | undefined, target: string, expected: PlistObject) {
  if (!job || !jobMatchesDefinition(job, target, expected)) throw new SafeError('Loaded launchd job definition does not match the trusted installed service; refusing service control.');
  return job;
}

async function bootoutControlledTrustedJob(driver: ServiceDriver, target: string, expected: PlistObject) {
  const loaded = await driver.inspectLoadedJob();
  if (loaded && jobMatchesDefinition(loaded, target, expected)) await driver.bootout();
}

export function recognizeLegacyServerPlist(actual: unknown, expected: { base: string; node: string; repo: string; policy: string; port: string }) {
  return samePlist(actual, legacyServerPlist(expected));
}

function looksLegacy(actual: unknown) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const value = actual as Record<string, unknown>;
  const args = value.ProgramArguments;
  const env = value.EnvironmentVariables;
  return value.Label === SERVER_LABEL && Array.isArray(args) && args.some(v => typeof v === 'string' && v.endsWith('/dist/src/main.js')) &&
    !!env && typeof env === 'object' && !Array.isArray(env) && 'REPO_ROOT' in env && 'REPO_MCP_POLICY' in env;
}

async function syncDir(dir: string) {
  const handle = await open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function ensureOwnerDir(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

async function publishBytesIfAbsent(target: string, bytes: Uint8Array, ownerParent = false) {
  const parent = path.dirname(target);
  if (ownerParent) await ensureOwnerDir(parent); else await mkdir(parent, { recursive: true });
  const temp = path.join(parent, `.tmp-${randomUUID()}`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await link(temp, target);
    await chmod(target, 0o600);
    await syncDir(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new SafeError(`Refusing to overwrite a later occupant at ${target}; reconcile the service plist manually.`);
    }
    throw error;
  } finally {
    await unlink(temp).catch(() => {});
  }
}

async function parsePlistSnapshot(bytes: Uint8Array, target: string, parsePlist: (file: string) => Promise<PlistObject>) {
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const snapshot = path.join(parent, `.${path.basename(target)}.inspect-${randomUUID()}`);
  const handle = await open(snapshot, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  try {
    return await parsePlist(snapshot);
  } finally {
    await unlink(snapshot).catch(() => {});
  }
}

const MAX_PLIST_BYTES = 1024 * 1024;

async function parsePlistBytes(bytes: Uint8Array, cwd: string): Promise<PlistObject> {
  if (bytes.byteLength > MAX_PLIST_BYTES) throw new SafeError('Installed server plist exceeds the bounded inspection limit.');
  const result = await execute(
    '/usr/bin/plutil',
    ['-convert', 'json', '-o', '-', '-'],
    cwd,
    10_000,
    {},
    { strictUtf8: true, maxOutputBytes: MAX_PLIST_BYTES, stdin: bytes }
  );
  if (result.exit_code !== 0 || result.signal !== null || result.timed_out || result.truncated || result.invalid_utf8) {
    throw new SafeError('Installed server plist is unreadable or invalid.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); } catch { throw new SafeError('Installed server plist is unreadable or invalid.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SafeError('Installed server plist is not a dictionary.');
  return parsed as PlistObject;
}

async function fileBytes(file: string) {
  try { return await readFile(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

const SERVICE_PLIST_LOCK_PURPOSE = 'service plist transaction';

function servicePlistLockState(target: string) {
  const canonicalTarget = path.resolve(target);
  const key = `service-plist-${sha256(Buffer.from(`${SERVER_LABEL}\0${canonicalTarget}`, 'utf8')).slice(0, 32)}`;
  return {
    stateDir: path.join(path.dirname(canonicalTarget), '.repo-mcp-service-control'),
    key
  };
}

async function acquireServicePlistLock(target: string) {
  const lockState = servicePlistLockState(target);
  const store = await StateStore.open(lockState.stateDir);
  return acquireLock(store, lockState.key, SERVICE_PLIST_LOCK_PURPOSE, {
    recoverStale: true,
    expectedExistingPurpose: SERVICE_PLIST_LOCK_PURPOSE
  });
}

function claimPrefix(target: string) {
  return `.${path.basename(target)}.claim-`;
}

function assertClaimPath(target: string, claimPath: string) {
  const prefix = claimPrefix(target);
  const basename = path.basename(claimPath);
  if (!path.isAbsolute(claimPath) ||
      path.dirname(claimPath) !== path.dirname(target) ||
      !basename.startsWith(prefix) ||
      basename.length <= prefix.length) {
    throw new SafeError('Recorded server plist claim path is outside the trusted target directory or does not match the generated claim prefix.');
  }
}

async function claimFileBytes(target: string, claimPath: string) {
  assertClaimPath(target, claimPath);
  let info;
  try { info = await lstat(claimPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SafeError('Recorded server plist claim is not a regular file; refusing cleanup or recovery.');
  }
  return readFile(claimPath);
}

async function unlinkClaim(target: string, claimPath: string) {
  assertClaimPath(target, claimPath);
  let info;
  try { info = await lstat(claimPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SafeError('Recorded server plist claim is not a regular file; refusing cleanup or recovery.');
  }
  await unlink(claimPath);
  await syncDir(path.dirname(claimPath));
  return true;
}

function newClaimPath(target: string) {
  return path.join(path.dirname(target), `${claimPrefix(target)}${randomUUID()}`);
}

async function restoreClaimIfVacant(claimPath: string, target: string) {
  try {
    await link(claimPath, target);
    await chmod(target, 0o600);
    await syncDir(path.dirname(target));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Move the exact pathname occupant aside before replacement, then prove that the
 * claimed bytes are the durable previous hash. A concurrent later occupant is
 * never overwritten: hash mismatch restores only with create-if-absent semantics.
 */
async function claimExactTarget(target: string, claimPath: string, expectedHash: string) {
  let claimed = await claimFileBytes(target, claimPath);
  if (!claimed) {
    if (!await fileBytes(target)) throw new SafeError('Prepared server plist claim has neither the previous target nor its claimed bytes; manual recovery is required.');
    try {
      await rename(target, claimPath);
      await syncDir(path.dirname(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SafeError('Server plist changed while it was being claimed; refusing replacement.');
      throw error;
    }
    claimed = await claimFileBytes(target, claimPath);
  }
  if (!claimed || sha256(claimed) !== expectedHash) {
    if (claimed && await restoreClaimIfVacant(claimPath, target)) {
      await unlinkClaim(target, claimPath).catch(() => {});
    }
    throw new SafeError('Claimed server plist bytes do not match the durable previous hash; refusing replacement and preserving later occupants.');
  }
  return claimed;
}

export async function parsePlistFile(file: string, cwd = PROJECT_BASE): Promise<PlistObject> {
  const result = await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], cwd, 10_000, {}, { strictUtf8: true });
  if (result.exit_code !== 0 || result.timed_out || result.truncated || result.invalid_utf8) throw new SafeError('Installed server plist is unreadable or invalid.');
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); } catch { throw new SafeError('Installed server plist is unreadable or invalid.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SafeError('Installed server plist is not a dictionary.');
  return parsed as PlistObject;
}

export async function currentNodePath(cwd = PROJECT_BASE) {
  const result = await execute(
    '/usr/bin/python3',
    ['-c', 'import shutil,sys; p=shutil.which("node"); sys.stdout.write(p or "")'],
    cwd,
    10_000,
    { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    { strictUtf8: true }
  );
  const node = result.stdout.trim();
  if (result.exit_code !== 0 || !node || !path.isAbsolute(node)) throw new SafeError('Unable to resolve node with the migration environment PATH.');
  await access(node, constants.X_OK).catch(() => { throw new SafeError('Resolved node executable is not executable.'); });
  return node;
}

function targetPath(launchAgentsDir?: string) {
  return path.join(launchAgentsDir ?? path.join(os.homedir(), 'Library', 'LaunchAgents'), `${SERVER_LABEL}.plist`);
}

function domain() {
  const uid = process.getuid?.();
  if (uid === undefined) throw new SafeError('Per-user launchd service control requires a local user ID.');
  return `gui/${uid}`;
}

async function runLaunchctl(args: string[], cwd: string) {
  return execute('/bin/launchctl', args, cwd, 10_000, { PATH: process.env.PATH ?? '/usr/bin:/bin' }, { strictUtf8: true });
}

export function classifyLaunchctlPrint(result: Awaited<ReturnType<typeof execute>>) {
  if (result.timed_out || result.truncated || result.invalid_utf8 || result.signal !== null || result.exit_code === null) {
    throw new SafeError('Unable to inspect the Repo MCP launchd service safely.');
  }
  if (result.exit_code === 0) return { state: 'loaded' as const, stdout: result.stdout };
  const missing = result.exit_code === 113 && result.stdout === '' &&
    /^Bad request\.\r?\nCould not find service "local\.repo-mcp\.server" in domain for user gui: \d+\r?\n?$/.test(result.stderr);
  if (missing) return { state: 'absent' as const };
  throw new SafeError('launchctl could not inspect the Repo MCP service; absence was not positively established.');
}

function launchValue(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

function launchBlock(text: string, name: string) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === `${name} = {`);
  if (start < 0) return undefined;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '}') return out;
    out.push(lines[i].trim());
  }
  return undefined;
}

function parseLoadedJob(text: string): LoadedServiceJob {
  const pidMatch = text.match(/^\s*pid = (\d+)\s*$/m);
  const pathMatch = text.match(/^\s*path = (.+?)\s*$/m);
  const wdMatch = text.match(/^\s*working directory = (.+?)\s*$/m);
  const stdoutMatch = text.match(/^\s*stdout path = (.+?)\s*$/m);
  const stderrMatch = text.match(/^\s*stderr path = (.+?)\s*$/m);
  const runtimeMatch = text.match(/^\s*minimum runtime = (\d+)\s*$/m);
  const propertiesMatch = text.match(/^\s*properties = (.+?)\s*$/m);
  const args = launchBlock(text, 'arguments')?.filter(Boolean).map(launchValue);
  const envLines = launchBlock(text, 'environment');
  const environment: Record<string, string> = {};
  for (const line of envLines ?? []) {
    const match = line.match(/^([^=]+?)\s*=>\s*(.*)$/);
    if (!match) throw new SafeError('Loaded launchd environment could not be parsed safely.');
    environment[match[1].trim()] = launchValue(match[2]);
  }
  if (!pidMatch || !pathMatch || !wdMatch || !stdoutMatch || !stderrMatch || !runtimeMatch || !propertiesMatch || !args || !envLines) throw new SafeError('Loaded launchd job definition is incomplete; refusing service control.');
  const pid = Number(pidMatch[1]);
  const throttle = Number(runtimeMatch[1]);
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(throttle) || throttle < 0) throw new SafeError('Loaded launchd job PID/runtime is invalid.');
  const properties = propertiesMatch[1].toLowerCase().split('|').map(v => v.trim());
  return {
    pid,
    plist_path: launchValue(pathMatch[1]),
    program_arguments: args,
    working_directory: launchValue(wdMatch[1]),
    environment_variables: environment,
    stdout_path: launchValue(stdoutMatch[1]),
    stderr_path: launchValue(stderrMatch[1]),
    run_at_load: properties.includes('runatload'),
    keep_alive: properties.includes('keepalive'),
    throttle_interval: throttle
  };
}

export function classifyLsofPortOwner(result: Awaited<ReturnType<typeof execute>>) {
  if (result.timed_out || result.truncated || result.invalid_utf8 || result.signal !== null || result.exit_code === null) {
    throw new SafeError('Unable to inspect the loopback listener PID safely.');
  }
  if (result.exit_code === 1 && result.stdout === '' && result.stderr === '') return undefined;
  if (result.exit_code !== 0 || result.stderr !== '') {
    throw new SafeError('lsof could not inspect the loopback listener PID; absence was not positively established.');
  }
  const raw = result.stdout.trim();
  if (!raw) throw new SafeError('lsof reported success without a loopback listener PID.');
  const values = raw.split(/\s+/);
  if (values.length !== 1 || !/^\d+$/.test(values[0])) throw new SafeError(`Expected exactly one loopback listener PID; found ${values.length} entries.`);
  const pid = Number(values[0]);
  if (!Number.isSafeInteger(pid) || pid < 1) throw new SafeError('lsof returned an invalid loopback listener PID.');
  return pid;
}

function realDriver(target: string, cwd: string): ServiceDriver {
  const service = `${domain()}/${SERVER_LABEL}`;
  const portOwnerPid = async (port: number) => {
    const result = await execute('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], cwd, 10_000, {}, { strictUtf8: true });
    try {
      return classifyLsofPortOwner(result);
    } catch (error) {
      if (error instanceof SafeError) throw new SafeError(`Unable to inspect the listener PID on port ${port}: ${error.message}`);
      throw error;
    }
  };
  return {
    async isLoaded() {
      const classified = classifyLaunchctlPrint(await runLaunchctl(['print', service], cwd));
      return classified.state === 'loaded';
    },
    async inspectLoadedJob() {
      const classified = classifyLaunchctlPrint(await runLaunchctl(['print', service], cwd));
      if (classified.state === 'absent') return undefined;
      return parseLoadedJob(classified.stdout);
    },
    async bootout() {
      const result = await runLaunchctl(['bootout', service], cwd);
      if (result.exit_code !== 0) throw new SafeError('Unable to unload the Repo MCP server service.');
    },
    async bootstrap() {
      const result = await runLaunchctl(['bootstrap', domain(), target], cwd);
      if (result.exit_code !== 0) throw new SafeError('Unable to bootstrap the Repo MCP server service.');
    },
    async kickstart() {
      const result = await runLaunchctl(['kickstart', '-k', service], cwd);
      if (result.exit_code !== 0) throw new SafeError('Unable to reload the Repo MCP server service.');
    },
    portOwnerPid,
    async portOccupied(port: number) { return (await portOwnerPid(port)) !== undefined; },
    async health(port: number) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
        if (!response.ok) return undefined;
        return await response.json();
      } catch { return undefined; }
    }
  };
}

export function compareAttestation(desired: ActiveServiceRecord, value: unknown): { state: LocalHealthState; process?: ProcessAttestation } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'unhealthy' };
  const v = value as Record<string, unknown>;
  if (v.ok !== true || v.name !== 'repo-mcp') return { state: 'unhealthy' };
  const process: ProcessAttestation = {
    ok: true,
    name: 'repo-mcp',
    server_version: typeof v.server_version === 'string' ? v.server_version : '',
    service_generation: typeof v.service_generation === 'number' ? v.service_generation : null,
    task_id: typeof v.task_id === 'string' ? v.task_id : null,
    root_digest: typeof v.root_digest === 'string' ? v.root_digest : '',
    process_pid: typeof v.process_pid === 'number' && Number.isSafeInteger(v.process_pid) && v.process_pid > 0 ? v.process_pid : null
  };
  if (process.process_pid === null) return { state: 'unhealthy', process };
  if (process.service_generation !== desired.generation) return { state: 'wrong_generation', process };
  if (process.task_id !== desired.task_id) return { state: 'wrong_task', process };
  if (process.root_digest !== desired.root_digest) return { state: 'wrong_root', process };
  if (process.server_version !== desired.expected_server_version) return { state: 'wrong_version', process };
  return { state: 'ready', process };
}

async function waitForAttestation(desired: ActiveServiceRecord, driver: ServiceDriver, waitMs = 5_000) {
  const deadline = Date.now() + waitMs;
  let last: ReturnType<typeof compareAttestation> = { state: 'unhealthy' };
  do {
    last = compareAttestation(desired, await driver.health(desired.port));
    if (last.state === 'ready') return last;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (true);
  throw new SafeError(`Server reload did not produce the requested process attestation (${last.state}).`);
}

async function readInstall(store: StateStore) {
  return store.read<InstallRecord>('control/install.json', 'install');
}

function retainedInstallFields(install?: InstallRecord) {
  return {
    ...(install?.migration_state ? { migration_state: install.migration_state } : {}),
    ...(install?.legacy_backup_path ? { legacy_backup_path: install.legacy_backup_path } : {}),
    ...(install?.legacy_backup_sha256 ? { legacy_backup_sha256: install.legacy_backup_sha256 } : {}),
    ...(install?.legacy_original_path ? { legacy_original_path: install.legacy_original_path } : {})
  };
}

async function writeInstall(store: StateStore, record: Omit<InstallRecord, 'updated_at'>) {
  const next: InstallRecord = { ...record, updated_at: new Date().toISOString() };
  await store.write('control/install.json', 'install', next);
  return next;
}

async function validatePreparedCleanupClaim(target: string, txn: NonNullable<InstallRecord['plist_transaction']>) {
  if (txn.cleanup_pending !== undefined && typeof txn.cleanup_pending !== 'boolean') {
    throw new SafeError('Prepared server plist cleanup state is invalid.');
  }
  if (!txn.claim_path) {
    if (txn.cleanup_pending) throw new SafeError('Cleanup-pending transaction is missing its durable claim path.');
    return undefined;
  }
  if (txn.previous_sha256 === null) throw new SafeError('Fresh-install transaction unexpectedly contains a claim path; manual recovery is required.');
  const claim = await claimFileBytes(target, txn.claim_path);
  if (claim && sha256(claim) !== txn.previous_sha256) {
    throw new SafeError('Cleanup claim does not match the durable previous hash; refusing to delete it or publish trusted install state.');
  }
  if (!txn.cleanup_pending && !claim) {
    throw new SafeError('Prepared cleanup claim disappeared before durable cleanup-pending state was published.');
  }
  return claim;
}

async function finalizePlistTransaction(store: StateStore, install: InstallRecord, desiredHash: string) {
  const installed = await fileBytes(install.target);
  if (!installed || sha256(installed) !== desiredHash) {
    throw new SafeError('Installed server plist changed before transaction commit; refusing to publish trusted install state.');
  }
  let current = install;
  const txn = current.plist_transaction;
  if (!txn) return current;
  const claim = await validatePreparedCleanupClaim(current.target, txn);

  if (txn.claim_path) {
    if (!txn.cleanup_pending) {
      current = await writeInstall(store, {
        label: current.label,
        target: current.target,
        installed_plist_sha256: desiredHash,
        plist_transaction: { ...txn, cleanup_pending: true },
        ...retainedInstallFields(current)
      });
    }
    if (claim) {
      const cleanupClaim = await claimFileBytes(current.target, txn.claim_path);
      if (cleanupClaim) {
        if (sha256(cleanupClaim) !== txn.previous_sha256) {
          throw new SafeError('Cleanup claim changed after durable cleanup-pending publication; refusing to delete it or clear transaction evidence.');
        }
        await unlinkClaim(current.target, txn.claim_path);
      }
    }
  }

  return writeInstall(store, {
    label: current.label,
    target: current.target,
    installed_plist_sha256: desiredHash,
    ...retainedInstallFields(current)
  });
}

async function ensureStableDefinition(options: {
  stateDir: string;
  base: string;
  node: string;
  launchAgentsDir?: string;
  driver: ServiceDriver;
  parsePlist: (file: string) => Promise<PlistObject>;
}) {
  const store = await StateStore.open(options.stateDir);
  const target = targetPath(options.launchAgentsDir);
  const desired = stableServerPlist({ base: options.base, node: options.node, stateDir: options.stateDir });
  const desiredBytes = Buffer.from(plistXml(desired));
  const desiredHash = sha256(desiredBytes);
  await ensureOwnerDir(path.join(path.dirname(options.stateDir), 'server'));

  let current = await fileBytes(target);
  let currentHash = current ? sha256(current) : null;
  let install = await readInstall(store);
  let changed = false;

  const updatePreparedPrevious = async (record: InstallRecord, claimPath: string, previous: PlistObject) => {
    const txn = record.plist_transaction;
    if (!txn) throw new SafeError('Prepared server plist transaction disappeared during reconciliation.');
    if (txn.previous_definition && !samePlist(txn.previous_definition, previous)) {
      throw new SafeError('Prepared transaction previous definition does not match the exact claimed previous bytes.');
    }
    if (txn.previous_definition && txn.claim_path === claimPath) return record;
    return writeInstall(store, {
      label: record.label,
      target: record.target,
      installed_plist_sha256: record.installed_plist_sha256,
      plist_transaction: {
        ...txn,
        claim_path: claimPath,
        previous_definition: previous,
        desired_definition: desired
      },
      ...retainedInstallFields(record)
    });
  };

  const publishDesired = async () => {
    const occupant = await fileBytes(target);
    if (occupant) {
      if (sha256(occupant) !== desiredHash) throw new SafeError('A later server plist occupant appeared before desired publication; refusing to overwrite it.');
      return;
    }
    await publishBytesIfAbsent(target, desiredBytes);
  };

  const reconcilePrevious = async (record: InstallRecord) => {
    const txn = record.plist_transaction!;
    if (!txn.previous_sha256) throw new SafeError('Prepared previous-plist transaction is missing its previous hash.');
    let claimPath = txn.claim_path;
    if (!claimPath) {
      claimPath = newClaimPath(target);
      record = await writeInstall(store, {
        label: record.label,
        target: record.target,
        installed_plist_sha256: record.installed_plist_sha256,
        plist_transaction: { ...txn, claim_path: claimPath, desired_definition: desired },
        ...retainedInstallFields(record)
      });
    }
    await claimExactTarget(target, claimPath, txn.previous_sha256);
    const previous = await options.parsePlist(claimPath);
    record = await updatePreparedPrevious(record, claimPath, previous);
    const loaded = await options.driver.inspectLoadedJob();
    if (loaded) {
      assertLoadedJob(loaded, target, previous);
      await options.driver.bootout();
    }
    await publishDesired();
    changed = true;
    return record;
  };

  if (install?.plist_transaction) {
    const txn = install.plist_transaction;
    if (install.target !== target || txn.desired_sha256 !== desiredHash) throw new SafeError('Prepared server plist transaction does not match the current desired definition.');
    if (txn.desired_definition && !samePlist(txn.desired_definition, desired)) throw new SafeError('Prepared transaction desired definition does not match current configuration.');
    if (currentHash === txn.desired_sha256) {
      await validatePreparedCleanupClaim(target, txn);
      changed = true;
    } else if (txn.previous_sha256 === null) {
      if (currentHash !== null) throw new SafeError('A later server plist occupant appeared during a prepared fresh install; refusing reconciliation.');
      const loaded = await options.driver.inspectLoadedJob();
      if (loaded) throw new SafeError('Unexpected pre-existing loaded server service has no installed plist at the trusted path. Refusing installation.');
      await publishDesired();
      changed = true;
    } else {
      const claimedAlready = txn.claim_path ? await claimFileBytes(target, txn.claim_path) : undefined;
      if (currentHash !== txn.previous_sha256 && !(currentHash === null && claimedAlready && sha256(claimedAlready) === txn.previous_sha256)) {
        throw new SafeError('Installed server plist matches neither the exact previous side nor the desired side of the prepared transaction; refusing reconciliation.');
      }
      install = await reconcilePrevious(install);
    }
    return { store, target, desired, desiredHash, changed, install };
  }

  if (!current) {
    const loaded = await options.driver.inspectLoadedJob();
    if (loaded) throw new SafeError('Unexpected pre-existing loaded server service has no installed plist at the trusted path. Refusing installation.');
    install = await writeInstall(store, {
      label: SERVER_LABEL,
      target,
      installed_plist_sha256: null,
      plist_transaction: { previous_sha256: null, desired_sha256: desiredHash, desired_definition: desired },
      ...retainedInstallFields(install)
    });
    await publishDesired();
    changed = true;
    return { store, target, desired, desiredHash, changed, install };
  }

  if (currentHash === desiredHash) {
    if (!install) throw new SafeError('Unexpected pre-existing stable server plist has no trusted install record. Refusing to adopt it implicitly.');
    if (install.target !== target || install.installed_plist_sha256 !== currentHash) {
      throw new SafeError('Installed stable server plist no longer matches its trusted install record. Refusing reload.');
    }
    return { store, target, desired, desiredHash, changed, install };
  }

  if (!install || install.target !== target || install.installed_plist_sha256 !== currentHash) {
    const parsed = await parsePlistSnapshot(current, target, options.parsePlist);
    if (looksLegacy(parsed)) throw new SafeError('Exact legacy Repo MCP server service detected. Run coord migrate-legacy; ordinary start will not replace it.');
    throw new SafeError('Unexpected or modified server plist. Refusing to overwrite it.');
  }

  const claimPath = newClaimPath(target);
  install = await writeInstall(store, {
    label: SERVER_LABEL,
    target,
    installed_plist_sha256: currentHash,
    plist_transaction: {
      previous_sha256: currentHash,
      desired_sha256: desiredHash,
      claim_path: claimPath,
      desired_definition: desired
    },
    ...retainedInstallFields(install)
  });
  install = await reconcilePrevious(install);
  return { store, target, desired, desiredHash, changed, install };
}

export async function installOrReloadStable(active: ActiveServiceRecord, options: {
  base?: string;
  node?: string;
  launchAgentsDir?: string;
  driver?: ServiceDriver;
  parsePlist?: (file: string) => Promise<PlistObject>;
  waitMs?: number;
} = {}) {
  assertActive(active);
  const base = await realpath(options.base ?? PROJECT_BASE);
  const node = options.node ?? await currentNodePath(base);
  const target = targetPath(options.launchAgentsDir);
  const driver = options.driver ?? realDriver(target, base);
  const parsePlist = options.parsePlist ?? ((file: string) => parsePlistFile(file, base));
  const plistLock = await acquireServicePlistLock(target);
  try {
  const prepared = await ensureStableDefinition({ stateDir: active.state_dir, base, node, launchAgentsDir: options.launchAgentsDir, driver, parsePlist });
  const loadedJob = await driver.inspectLoadedJob();
  if (loadedJob) {
    if (jobMatchesDefinition(loadedJob, prepared.target, prepared.desired)) {
      await driver.kickstart();
    } else {
      const previous = prepared.install?.plist_transaction?.previous_definition;
      if (!previous || !jobMatchesDefinition(loadedJob, prepared.target, previous)) {
        throw new SafeError('Loaded launchd job matches neither the prepared previous nor desired trusted definition; refusing service control.');
      }
      await driver.bootout();
      if (await driver.portOccupied(active.port)) throw new SafeError(`Port ${active.port} is occupied after service unload; refusing bootstrap.`);
      await driver.bootstrap();
    }
  } else {
    if (await driver.portOccupied(active.port)) throw new SafeError(`Port ${active.port} is occupied; refusing to bootstrap the Repo MCP service.`);
    await driver.bootstrap();
  }
  let attestation: Awaited<ReturnType<typeof waitForAttestation>>;
  try {
    attestation = await waitForAttestation(active, driver, options.waitMs);
    const runningJob = assertLoadedJob(await driver.inspectLoadedJob(), prepared.target, prepared.desired);
    const listenerPid = await driver.portOwnerPid(active.port);
    if (runningJob.pid !== attestation.process?.process_pid || listenerPid !== runningJob.pid) throw new SafeError('Loopback listener/health PID does not match the inspected launchd process PID.');
  } catch (error) {
    await bootoutControlledTrustedJob(driver, prepared.target, prepared.desired);
    throw error;
  }
  let committedInstall = prepared.install;
  if (committedInstall?.plist_transaction) committedInstall = await finalizePlistTransaction(prepared.store, committedInstall, prepared.desiredHash);
  if (committedInstall?.migration_state === 'prepared' || committedInstall?.migration_state === 'prepared_unbound') {
    committedInstall = await writeInstall(prepared.store, {
      label: committedInstall.label,
      target: committedInstall.target,
      installed_plist_sha256: prepared.desiredHash,
      migration_state: 'verified',
      ...(committedInstall.legacy_backup_path ? { legacy_backup_path: committedInstall.legacy_backup_path } : {}),
      ...(committedInstall.legacy_backup_sha256 ? { legacy_backup_sha256: committedInstall.legacy_backup_sha256 } : {}),
      ...(committedInstall.legacy_original_path ? { legacy_original_path: committedInstall.legacy_original_path } : {})
    });
  }
  return { ...attestation, target: prepared.target, plist_changed: prepared.changed };
  } finally {
    await plistLock.release();
  }
}

async function validateLegacy(actual: PlistObject, base: string, node: string) {
  const env = actual.EnvironmentVariables;
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new SafeError('Installed server service is not the exact documented legacy Repo MCP plist.');
  const vars = env as Record<string, unknown>;
  const repoRaw = vars.REPO_ROOT;
  const policyRaw = vars.REPO_MCP_POLICY;
  const portRaw = vars.PORT;
  if (typeof repoRaw !== 'string' || typeof policyRaw !== 'string' || typeof portRaw !== 'string' || !/^\d+$/.test(portRaw)) {
    throw new SafeError('Installed server service is not the exact documented legacy Repo MCP plist.');
  }
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || String(port) !== portRaw) throw new SafeError('Legacy server port is outside the exact old-installer contract.');
  if (!path.isAbsolute(node)) throw new SafeError('Legacy migration node path must be absolute.');
  await access(node, constants.X_OK).catch(() => { throw new SafeError('Current node executable is unavailable; refusing legacy migration.'); });
  const legacyMain = path.join(base, 'dist/src/main.js');
  if (!(await stat(legacyMain).catch(() => undefined))?.isFile()) throw new SafeError('Legacy server entry point is missing; refusing migration.');
  const repo = await realpath(repoRaw).catch(() => undefined);
  const policy = await realpath(policyRaw).catch(() => undefined);
  if (!repo || !policy) throw new SafeError('Legacy repository or policy path no longer exists; refusing migration.');
  if (!(await stat(repo).catch(() => undefined))?.isDirectory() || !(await stat(policy).catch(() => undefined))?.isFile()) {
    throw new SafeError('Legacy repository/policy no longer have the object types required by the old installer.');
  }
  if (!recognizeLegacyServerPlist(actual, { base, node, repo, policy, port: portRaw })) {
    throw new SafeError('Installed server service is modified or foreign. Refusing legacy migration without changing it.');
  }
  return { repo, policy, port };
}

export async function migrateLegacyServer(options: {
  stateDir: string;
  active?: ActiveServiceRecord;
  base?: string;
  node?: string;
  launchAgentsDir?: string;
  backupDir?: string;
  driver?: ServiceDriver;
  parsePlist?: (file: string) => Promise<PlistObject>;
  waitMs?: number;
}) {
  const base = await realpath(options.base ?? PROJECT_BASE);
  const node = options.node ?? await currentNodePath(base);
  const target = targetPath(options.launchAgentsDir);
  const driver = options.driver ?? realDriver(target, base);
  const parsePlist = options.parsePlist ?? ((file: string) => parsePlistFile(file, base));
  const plistLock = await acquireServicePlistLock(target);
  try {
    const store = await StateStore.open(options.stateDir);
    if (await readInstall(store)) throw new SafeError('Existing server install transaction/state must be reconciled before starting a new legacy migration.');

    const bytes = await fileBytes(target);
    if (!bytes) throw new SafeError('No installed legacy server plist was found.');
    const backupHash = sha256(bytes);
    const parsed = await parsePlistSnapshot(bytes, target, parsePlist);
    const legacy = await validateLegacy(parsed, base, node);

    const loadedJob = await driver.inspectLoadedJob();
    if (loadedJob) {
      assertLoadedJob(loadedJob, target, parsed);
      const health = await driver.health(legacy.port);
      if (!health || typeof health !== 'object' || (health as Record<string, unknown>).ok !== true || (health as Record<string, unknown>).name !== 'repo-mcp') {
        throw new SafeError('Running legacy service could not be verified on its configured loopback port; refusing migration.');
      }
      const portPid = await driver.portOwnerPid(legacy.port);
      if (portPid !== loadedJob.pid) throw new SafeError('Legacy loopback responder PID does not match the inspected launchd service PID; refusing migration.');
      await driver.bootout();
    }
    if (await driver.portOccupied(legacy.port)) throw new SafeError('A process still owns the legacy server port after bootout; refusing migration.');

    const desired = stableServerPlist({ base, node, stateDir: options.stateDir });
    const desiredBytes = Buffer.from(plistXml(desired));
    const desiredHash = sha256(desiredBytes);
    const claimPath = newClaimPath(target);
    const migrationState = options.active ? 'prepared' : 'prepared_unbound';

    const backupRoot = options.backupDir ?? path.join(path.dirname(options.stateDir), 'migration', 'server');
    await ensureOwnerDir(backupRoot);
    const backup = path.join(backupRoot, `legacy-server-${backupHash}.plist`);
    const priorBackup = await fileBytes(backup);
    if (priorBackup) {
      if (sha256(priorBackup) !== backupHash) throw new SafeError('Legacy migration backup path contains unexpected bytes.');
    } else {
      await publishBytesIfAbsent(backup, bytes, true);
    }

    let install = await writeInstall(store, {
      label: SERVER_LABEL,
      target,
      installed_plist_sha256: backupHash,
      plist_transaction: {
        previous_sha256: backupHash,
        desired_sha256: desiredHash,
        claim_path: claimPath,
        previous_definition: parsed,
        desired_definition: desired
      },
      migration_state: migrationState,
      legacy_backup_path: backup,
      legacy_backup_sha256: backupHash,
      legacy_original_path: target
    });

    let claimed: Buffer;
    try {
      claimed = await claimExactTarget(target, claimPath, backupHash);
    } catch (error) {
      const occupant = await fileBytes(target);
      const retainedClaim = await claimFileBytes(target, claimPath);
      if (occupant && sha256(occupant) !== backupHash && !retainedClaim) {
        await store.remove('control/install.json');
      }
      throw error;
    }
    const claimedDefinition = await parsePlistSnapshot(claimed, claimPath, parsePlist);
    if (!samePlist(claimedDefinition, parsed)) throw new SafeError('Claimed legacy server plist definition differs from the validated legacy snapshot; prepared claim is retained for exact recovery.');

    await ensureOwnerDir(path.join(path.dirname(options.stateDir), 'server'));
    const occupant = await fileBytes(target);
    if (occupant) throw new SafeError('A later server plist occupant appeared during legacy migration; refusing to overwrite it.');
    await publishBytesIfAbsent(target, desiredBytes);

    if (!options.active) return { migration_state: 'prepared_unbound' as const, backup, target };
    assertActive(options.active);
    if (await driver.portOccupied(options.active.port)) throw new SafeError(`Port ${options.active.port} is occupied; stable service remains prepared but unverified.`);
    await driver.bootstrap();
    let attestation: Awaited<ReturnType<typeof waitForAttestation>>;
    try {
      attestation = await waitForAttestation(options.active, driver, options.waitMs);
      const runningJob = assertLoadedJob(await driver.inspectLoadedJob(), target, desired);
      const listenerPid = await driver.portOwnerPid(options.active.port);
      if (runningJob.pid !== attestation.process?.process_pid || listenerPid !== runningJob.pid) throw new SafeError('Migrated service listener/health PID does not match the inspected launchd process PID.');
    } catch (error) {
      await bootoutControlledTrustedJob(driver, target, desired);
      throw error;
    }

    install = await finalizePlistTransaction(store, install, desiredHash);
    await writeInstall(store, {
      label: install.label,
      target: install.target,
      installed_plist_sha256: desiredHash,
      migration_state: 'verified',
      legacy_backup_path: backup,
      legacy_backup_sha256: backupHash,
      legacy_original_path: target
    });
    return { migration_state: 'verified' as const, backup, target, ...attestation };
  } finally {
    await plistLock.release();
  }
}

async function trustedInstalledDefinition(
  stateDir: string,
  target: string,
  base: string,
  parseBytes: (bytes: Uint8Array) => Promise<PlistObject> = bytes => parsePlistBytes(bytes, base)
) {
  const store = await StateStore.inspect(stateDir);
  if (!store) throw new SafeError('Operator install state is missing; refusing service control.');
  const install = await readInstall(store);
  const bytes = await fileBytes(target);
  if (!install || !bytes || install.target !== target || install.plist_transaction || install.installed_plist_sha256 !== sha256(bytes)) {
    throw new SafeError('Installed server plist is not in a trusted committed state; refusing service control.');
  }
  return parseBytes(bytes);
}

export type BrokerProcessAttestation = {
  ok: true;
  name: 'repo-mcp';
  server_version: string;
  service_mode: 'multirepo';
  process_pid: number | null;
};

export function compareBrokerAttestation(expectedVersion: string, value: unknown): { state: LocalHealthState; process?: BrokerProcessAttestation } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'unhealthy' };
  const v = value as Record<string, unknown>;
  if (v.ok !== true || v.name !== 'repo-mcp' || v.service_mode !== 'multirepo') return { state: 'unhealthy' };
  const process: BrokerProcessAttestation = {
    ok: true,
    name: 'repo-mcp',
    server_version: typeof v.server_version === 'string' ? v.server_version : '',
    service_mode: 'multirepo',
    process_pid: typeof v.process_pid === 'number' && Number.isSafeInteger(v.process_pid) && v.process_pid > 0 ? v.process_pid : null
  };
  if (process.process_pid === null) return { state: 'unhealthy', process };
  if (process.server_version !== expectedVersion) return { state: 'wrong_version', process };
  return { state: 'ready', process };
}

async function waitForBrokerAttestation(expectedVersion: string, port: number, driver: ServiceDriver, waitMs = 5_000) {
  const deadline = Date.now() + waitMs;
  let last: ReturnType<typeof compareBrokerAttestation> = { state: 'unhealthy' };
  do {
    last = compareBrokerAttestation(expectedVersion, await driver.health(port));
    if (last.state === 'ready') return last;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (true);
  throw new SafeError(`Server reload did not produce the requested multi-repository process attestation (${last.state}).`);
}

export async function installOrReloadBroker(options: {
  stateDir: string;
  port: number;
  expectedServerVersion: string;
  base?: string;
  node?: string;
  launchAgentsDir?: string;
  driver?: ServiceDriver;
  parsePlist?: (file: string) => Promise<PlistObject>;
  waitMs?: number;
}) {
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw new SafeError('Broker service port is invalid.');
  const base = await realpath(options.base ?? PROJECT_BASE);
  const node = options.node ?? await currentNodePath(base);
  const target = targetPath(options.launchAgentsDir);
  const driver = options.driver ?? realDriver(target, base);
  const parsePlist = options.parsePlist ?? ((file: string) => parsePlistFile(file, base));
  const plistLock = await acquireServicePlistLock(target);
  try {
    const prepared = await ensureStableDefinition({ stateDir: options.stateDir, base, node, launchAgentsDir: options.launchAgentsDir, driver, parsePlist });
    const loadedJob = await driver.inspectLoadedJob();
    if (loadedJob) {
      if (jobMatchesDefinition(loadedJob, prepared.target, prepared.desired)) {
        await driver.kickstart();
      } else {
        const previous = prepared.install?.plist_transaction?.previous_definition;
        if (!previous || !jobMatchesDefinition(loadedJob, prepared.target, previous)) {
          throw new SafeError('Loaded launchd job matches neither the prepared previous nor desired trusted definition; refusing service control.');
        }
        await driver.bootout();
        if (await driver.portOccupied(options.port)) throw new SafeError(`Port ${options.port} is occupied after service unload; refusing bootstrap.`);
        await driver.bootstrap();
      }
    } else {
      if (await driver.portOccupied(options.port)) throw new SafeError(`Port ${options.port} is occupied; refusing to bootstrap the Repo MCP service.`);
      await driver.bootstrap();
    }
    let attestation: Awaited<ReturnType<typeof waitForBrokerAttestation>>;
    try {
      attestation = await waitForBrokerAttestation(options.expectedServerVersion, options.port, driver, options.waitMs);
      const runningJob = assertLoadedJob(await driver.inspectLoadedJob(), prepared.target, prepared.desired);
      const listenerPid = await driver.portOwnerPid(options.port);
      if (runningJob.pid !== attestation.process?.process_pid || listenerPid !== runningJob.pid) {
        throw new SafeError('Loopback listener/health PID does not match the inspected launchd process PID.');
      }
    } catch (error) {
      await bootoutControlledTrustedJob(driver, prepared.target, prepared.desired);
      throw error;
    }
    let committedInstall = prepared.install;
    if (committedInstall?.plist_transaction) committedInstall = await finalizePlistTransaction(prepared.store, committedInstall, prepared.desiredHash);
    if (committedInstall?.migration_state === 'prepared' || committedInstall?.migration_state === 'prepared_unbound') {
      committedInstall = await writeInstall(prepared.store, {
        label: committedInstall.label,
        target: committedInstall.target,
        installed_plist_sha256: prepared.desiredHash,
        migration_state: 'verified',
        ...(committedInstall.legacy_backup_path ? { legacy_backup_path: committedInstall.legacy_backup_path } : {}),
        ...(committedInstall.legacy_backup_sha256 ? { legacy_backup_sha256: committedInstall.legacy_backup_sha256 } : {}),
        ...(committedInstall.legacy_original_path ? { legacy_original_path: committedInstall.legacy_original_path } : {})
      });
    }
    return { ...attestation, target: prepared.target, plist_changed: prepared.changed };
  } finally { await plistLock.release(); }
}

export async function brokerServiceStatus(options: {
  stateDir: string;
  port: number;
  expectedServerVersion: string;
  base?: string;
  launchAgentsDir?: string;
  driver?: ServiceDriver;
  parsePlistBytes?: (bytes: Uint8Array) => Promise<PlistObject>;
} ) {
  const base = options.base ?? PROJECT_BASE;
  const target = targetPath(options.launchAgentsDir);
  const driver = options.driver ?? realDriver(target, base);
  const loadedJob = await driver.inspectLoadedJob();
  if (!loadedJob) {
    if (await driver.portOccupied(options.port)) return { launchd: 'unloaded', local_mcp: 'blocked' as LocalHealthState };
    return { launchd: 'unloaded', local_mcp: 'stopped' as LocalHealthState };
  }
  let definition: PlistObject;
  try {
    definition = await trustedInstalledDefinition(options.stateDir, target, base, options.parsePlistBytes);
    assertLoadedJob(loadedJob, target, definition);
  } catch (error) {
    return { launchd: 'loaded', local_mcp: 'blocked' as LocalHealthState, service_error: error instanceof Error ? error.message : 'Loaded service identity is untrusted.' };
  }
  const compared = compareBrokerAttestation(options.expectedServerVersion, await driver.health(options.port));
  if (compared.state !== 'ready') return { launchd: 'loaded', local_mcp: compared.state, process: compared.process };
  const processPid = compared.process?.process_pid;
  const listenerPid = await driver.portOwnerPid(options.port);
  if (loadedJob.pid !== processPid || listenerPid !== processPid) {
    return { launchd: 'loaded', local_mcp: 'blocked' as LocalHealthState, process: compared.process };
  }
  return { launchd: 'loaded', local_mcp: 'ready' as LocalHealthState, process: compared.process };
}

export async function stopBrokerService(options: {
  stateDir: string;
  port: number;
  base?: string;
  launchAgentsDir?: string;
  driver?: ServiceDriver;
}) {
  const base = options.base ?? PROJECT_BASE;
  const target = targetPath(options.launchAgentsDir);
  const driver = options.driver ?? realDriver(target, base);
  const loadedJob = await driver.inspectLoadedJob();
  if (loadedJob) {
    const definition = await trustedInstalledDefinition(options.stateDir, target, base);
    assertLoadedJob(loadedJob, target, definition);
    await driver.bootout();
  }
  for (let i = 0; i < 20; i++) {
    if (!await driver.portOccupied(options.port)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new SafeError(`Port ${options.port} remains occupied after server service shutdown.`);
}

export async function serviceStatus(active: ActiveServiceRecord, options: {
  base?: string;
  launchAgentsDir?: string;
  driver?: ServiceDriver;
  writerLock?: WriterLockEvidence;
  parsePlistBytes?: (bytes: Uint8Array) => Promise<PlistObject>;
} = {}) {
  const base = options.base ?? PROJECT_BASE;
  const target = targetPath(options.launchAgentsDir);
  const driver = options.driver ?? realDriver(target, base);
  const loadedJob = await driver.inspectLoadedJob();
  if (!loadedJob) {
    if (await driver.portOccupied(active.port)) return { launchd: 'unloaded', local_mcp: 'blocked' as LocalHealthState };
    return { launchd: 'unloaded', local_mcp: 'stopped' as LocalHealthState };
  }
  let definition: PlistObject;
  try {
    definition = await trustedInstalledDefinition(active.state_dir, target, base, options.parsePlistBytes);
    assertLoadedJob(loadedJob, target, definition);
  } catch (error) {
    return { launchd: 'loaded', local_mcp: 'blocked' as LocalHealthState, service_error: error instanceof Error ? error.message : 'Loaded service identity is untrusted.' };
  }
  const compared = compareAttestation(active, await driver.health(active.port));
  if (compared.state !== 'ready') return { launchd: 'loaded', local_mcp: compared.state, process: compared.process };
  const processPid = compared.process?.process_pid;
  const listenerPid = await driver.portOwnerPid(active.port);
  const writer = options.writerLock;
  if (loadedJob.pid !== processPid || listenerPid !== processPid || !writer || writer.state !== 'live' || writer.pid !== processPid || writer.purpose !== `task ${active.task_id}`) {
    return { launchd: 'loaded', local_mcp: 'blocked' as LocalHealthState, process: compared.process, writer_lock: writer ?? null };
  }
  return { launchd: 'loaded', local_mcp: 'ready' as LocalHealthState, process: compared.process, writer_lock: writer };
}

export async function stopStableService(active: ActiveServiceRecord, options: {
  base?: string;
  launchAgentsDir?: string;
  driver?: ServiceDriver;
} = {}) {
  const base = options.base ?? PROJECT_BASE;
  const target = targetPath(options.launchAgentsDir);
  const driver = options.driver ?? realDriver(target, base);
  const loadedJob = await driver.inspectLoadedJob();
  if (loadedJob) {
    const definition = await trustedInstalledDefinition(active.state_dir, target, base);
    assertLoadedJob(loadedJob, target, definition);
    await driver.bootout();
  }
  for (let i = 0; i < 20; i++) {
    if (!await driver.portOccupied(active.port)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new SafeError(`Port ${active.port} remains occupied after server service shutdown.`);
}
