import { createHash, createHmac } from 'node:crypto';
import { SafeError, sha256 } from './errors.js';
import { runGit } from './exec.js';
import { Deadline } from './deadline.js';
import { resolveIdentity, identityDrift, type RepoIdentity } from './identity.js';
import { GIT_BUFFERED_BYTES, GIT_CAPTURE_BYTES, OPERATION_BUDGET_MS, type Limits } from './limits.js';
import { walk, fingerprint as statFingerprint, type Inventory } from './inventory.js';
import { diffInput, openVerified, safeStatInput, type SafeStatInput } from './safe-fs.js';
import { batchPaths } from './git-batches.js';
import { pathProblem } from './glob.js';
import type { PathPolicy } from './path-policy.js';

const TARGET_FINGERPRINT_VERSION = 1 as const;
const CAPTURE_ATTEMPTS = 3;
const INDEX_FLAGS = 0x8000 | 0x20000000 | 0x40000000;
const HIDDEN_WORKTREE_FLAGS = 0x8000 | 0x40000000;
const DEBUG_STAT = /^ {2}ctime: [^\n]*\n {2}mtime: [^\n]*\n {2}dev: [^\n]*\n {2}uid: [^\n]*\n {2}size: [^\n]*\tflags: ([0-9a-f]+)\n/;
const DEBUG_STAT_MAX = 512;
const INDEX_READ_BYTES = 128 * 1024 * 1024;
const DENIED_DOMAIN = 'repo-mcp-target-fingerprint-v1-denied\0';

export type TargetFingerprintV1 = {
  fingerprint: string;
  assurance: 'phase_only';
  branch: string | null;
  head: string;
};

export type TargetFingerprintV1Options = {
  root: string;
  pathPolicy: PathPolicy;
  limits: Limits;
  deniedMetadataKey: Uint8Array;
  operationBudgetMs?: number;
};

class TargetFingerprintUnavailable extends SafeError {
  readonly code = 'TARGET_FINGERPRINT_UNAVAILABLE';
  constructor() {
    super('Target fingerprint is unavailable because repository state could not be captured safely within configured bounds.');
  }
}

const unavailable = () => new TargetFingerprintUnavailable();
const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sorted = (values: Iterable<string>) => [...values].sort(byteOrder);
const statState = (input: SafeStatInput) => input.state === 'file'
  ? `file:${statFingerprint(input.stat)}`
  : input.state === 'absent'
    ? 'absent'
    : `refused:${input.reason}`;

type IndexEntry = {
  path: string;
  mode: string;
  object: string;
  stage: number;
  flags: number;
  canonical: string;
};

type StatusRecord = { status: string; path: string; canonical: string };

type Structure = {
  identity: RepoIdentity;
  index: IndexEntry[];
  indexByPath: Map<string, IndexEntry[]>;
  headNames: Set<string>;
  inventory: Inventory;
  trackedVisible: Set<string>;
  untrackedVisible: Set<string>;
  flaggedVisible: Set<string>;
  changedTracked: Set<string>;
  structuralDigest: string;
  canonicalInputs: {
    visibleIndexDigest: string;
    visibleHeadDigest: string;
    inventoryDigest: string;
    metadataDigest: string;
    statusDigest: string;
    deniedToken: string;
  };
};

async function boundedGit(
  root: string,
  args: string[],
  deadline: Deadline,
  maxBytes = GIT_BUFFERED_BYTES
) {
  deadline.check(unavailable);
  const result = await runGit(root, args, {
    timeout: deadline.timeout(),
    maxBytes,
    strictUtf8: true
  });
  if (result.timed_out || result.truncated || result.invalid_utf8 || result.exit_code !== 0) throw unavailable();
  deadline.check(unavailable);
  return result.stdout;
}

async function readIndex(root: string, deadline: Deadline, limits: Limits) {
  const out = await boundedGit(root, ['ls-files', '--stage', '--debug', '-z'], deadline, INDEX_READ_BYTES);
  const entries: IndexEntry[] = [];
  for (let pos = 0; pos < out.length;) {
    const end = out.indexOf('\0', pos);
    const stat = end === -1 ? null : DEBUG_STAT.exec(out.slice(end + 1, end + 1 + DEBUG_STAT_MAX));
    if (end === -1 || !stat) throw unavailable();
    const entry = out.slice(pos, end);
    const tab = entry.indexOf('\t');
    const header = tab < 0 ? '' : entry.slice(0, tab);
    const name = tab < 0 ? '' : entry.slice(tab + 1);
    const match = /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/.exec(header);
    if (!match || !name) throw unavailable();
    const flags = (parseInt(stat[1], 16) & INDEX_FLAGS) >>> 0;
    entries.push({
      path: name,
      mode: match[1],
      object: match[2],
      stage: Number(match[3]),
      flags,
      canonical: `${header}\t${name}\t${flags}`
    });
    if (entries.length > 4 * limits.inventory_paths) throw unavailable();
    pos = end + 1 + stat[0].length;
  }
  entries.sort((a, b) => byteOrder(a.canonical, b.canonical));
  const byPath = new Map<string, IndexEntry[]>();
  for (const entry of entries) byPath.set(entry.path, [...(byPath.get(entry.path) ?? []), entry]);
  return { entries, byPath };
}

async function readHeadNames(root: string, deadline: Deadline, limits: Limits) {
  const out = await boundedGit(root, ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], deadline);
  const names = out.split('\0').filter(Boolean);
  if (names.length > 4 * limits.inventory_paths) throw unavailable();
  return new Set(names);
}

function isVisible(policy: PathPolicy, name: string) {
  return !pathProblem(name) && policy.decide(name, 'read').ok;
}

async function metadataRecords(root: string, names: Iterable<string>, deadline: Deadline) {
  const records: string[] = [];
  const states = new Map<string, SafeStatInput>();
  for (const name of sorted(names)) {
    deadline.check(unavailable);
    const input = await safeStatInput(root, name);
    states.set(name, input);
    records.push(`${name}\0${statState(input)}`);
  }
  return { records, states };
}

async function deniedToken(
  root: string,
  deniedNames: Iterable<string>,
  headNames: Set<string>,
  indexByPath: Map<string, IndexEntry[]>,
  key: Uint8Array,
  deadline: Deadline
) {
  if (key.byteLength === 0) throw unavailable();
  const hmac = createHmac('sha256', key);
  hmac.update(DENIED_DOMAIN);
  for (const name of sorted(deniedNames)) {
    deadline.check(unavailable);
    const input = await safeStatInput(root, name);
    const index = (indexByPath.get(name) ?? []).map(entry => entry.canonical).sort(byteOrder);
    hmac.update(name);
    hmac.update('\0');
    hmac.update(headNames.has(name) ? 'head' : 'no-head');
    hmac.update('\0');
    hmac.update(index.join('\0'));
    hmac.update('\0');
    hmac.update(statState(input));
    hmac.update('\0');
  }
  return hmac.digest('hex');
}

function captureLimit(limits: Limits) {
  return Math.max(1, Math.min(GIT_CAPTURE_BYTES, Math.floor(limits.retained_output_bytes / 2)));
}

async function statusRecords(
  root: string,
  names: Iterable<string>,
  deadline: Deadline,
  limits: Limits
) {
  const candidates = sorted(names);
  if (candidates.length > limits.inventory_paths) throw unavailable();
  if (!candidates.length) return [] as StatusRecord[];
  const allowed = new Set(candidates);
  const cap = captureLimit(limits);
  let captured = 0;
  const records: StatusRecord[] = [];
  for (const batch of batchPaths(candidates)) {
    deadline.check(unavailable);
    const remaining = cap - captured;
    if (remaining <= 0) throw unavailable();
    const out = await boundedGit(root, [
      'status', '--porcelain=v1', '-z', '--untracked-files=no', '--no-renames',
      '--', ...batch
    ], deadline, remaining);
    captured += Buffer.byteLength(out);
    if (captured > cap) throw unavailable();
    for (let pos = 0; pos < out.length;) {
      const end = out.indexOf('\0', pos);
      if (end === -1) throw unavailable();
      const record = out.slice(pos, end);
      if (record.length < 4 || record[2] !== ' ') throw unavailable();
      const status = record.slice(0, 2);
      const name = record.slice(3);
      if (!allowed.has(name)) throw unavailable();
      records.push({ status, path: name, canonical: `${status}\t${name}` });
      pos = end + 1;
    }
  }
  records.sort((a, b) => byteOrder(a.canonical, b.canonical));
  return records;
}

function assertVisibleCaptureBound(status: StatusRecord[], untracked: Iterable<string>, limits: Limits) {
  const captured = [
    ...status.map(record => record.canonical),
    ...sorted(untracked).map(name => `??\t${name}`)
  ].join('\0');
  if (Buffer.byteLength(captured) > captureLimit(limits)) throw unavailable();
}

function unsafeInventorySkipped(inv: Inventory) {
  const { symlinks, special, linked, unsafe_name, too_long, other_device } = inv.skipped;
  return symlinks + special + linked + unsafe_name + too_long + other_device;
}

async function captureStructure(options: TargetFingerprintV1Options, deadline: Deadline): Promise<Structure> {
  deadline.check(unavailable);
  const identity = await resolveIdentity(options.root, { timeout: () => deadline.timeout() });
  const { entries: index, byPath: indexByPath } = await readIndex(options.root, deadline, options.limits);
  const headNames = await readHeadNames(options.root, deadline, options.limits);

  const inventory = await walk({
    root: options.root,
    policy: options.pathPolicy,
    inventoryPaths: options.limits.inventory_paths,
    maxFileBytes: options.limits.edit_file_bytes,
    deadline,
    expired: unavailable
  });
  if (unsafeInventorySkipped(inventory) !== 0) throw unavailable();

  const trackedAll = new Set<string>([...headNames, ...indexByPath.keys()]);
  const trackedVisible = new Set(sorted(trackedAll).filter(name => isVisible(options.pathPolicy, name)));
  const deniedNames = new Set(sorted(trackedAll).filter(name => !isVisible(options.pathPolicy, name)));
  const visibleMetadata = await metadataRecords(options.root, trackedVisible, deadline);

  let trackedOverCap = 0;
  for (const input of visibleMetadata.states.values()) {
    if (input.state === 'file' && Number(input.stat.size) > options.limits.edit_file_bytes) trackedOverCap++;
  }
  if (inventory.skipped.too_large !== trackedOverCap) throw unavailable();

  const untrackedVisible = new Set(
    inventory.entries.map(entry => entry.path).filter(name => !trackedAll.has(name))
  );
  const candidates = new Set<string>([...trackedVisible, ...untrackedVisible]);
  if (candidates.size > options.limits.inventory_paths) throw unavailable();

  const status = await statusRecords(options.root, trackedVisible, deadline, options.limits);
  assertVisibleCaptureBound(status, untrackedVisible, options.limits);
  const changedTracked = new Set(
    status
      .filter(record => trackedVisible.has(record.path))
      .map(record => record.path)
  );
  const flaggedVisible = new Set(
    index
      .filter(entry => isVisible(options.pathPolicy, entry.path) && (entry.flags & HIDDEN_WORKTREE_FLAGS) !== 0)
      .map(entry => entry.path)
  );

  const visibleIndex = index.filter(entry => isVisible(options.pathPolicy, entry.path)).map(entry => entry.canonical);
  const visibleHead = sorted(headNames).filter(name => isVisible(options.pathPolicy, name));
  const denied = await deniedToken(
    options.root, deniedNames, headNames, indexByPath, options.deniedMetadataKey, deadline
  );
  const canonicalInputs = {
    visibleIndexDigest: sha256(visibleIndex.join('\0')),
    visibleHeadDigest: sha256(visibleHead.join('\0')),
    inventoryDigest: inventory.digest,
    metadataDigest: sha256(visibleMetadata.records.join('\0')),
    statusDigest: sha256(status.map(record => record.canonical).join('\0')),
    deniedToken: denied
  };
  const structuralDigest = sha256(JSON.stringify([
    'TargetFingerprintV1-structure',
    options.pathPolicy.digest,
    identity.root,
    identity.git_dir,
    identity.common_dir,
    identity.branch,
    identity.head,
    canonicalInputs,
    inventory.skipped
  ]));
  return {
    identity,
    index,
    indexByPath,
    headNames,
    inventory,
    trackedVisible,
    untrackedVisible,
    flaggedVisible,
    changedTracked,
    structuralDigest,
    canonicalInputs
  };
}

function sameFileStat(
  a: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  b: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

async function hashVisibleFile(
  root: string,
  name: string,
  maxBytes: number,
  deadline: Deadline
) {
  deadline.check(unavailable);
  const judged = await diffInput(root, name, maxBytes);
  if (judged.state === 'absent') return 'missing';
  if (judged.state !== 'file') throw unavailable();

  const { handle, stat } = await openVerified(root, name);
  try {
    if (stat.size > maxBytes) throw unavailable();
    if (
      BigInt(stat.dev) !== judged.stat.dev ||
      BigInt(stat.ino) !== judged.stat.ino ||
      BigInt(stat.size) !== judged.stat.size
    ) throw unavailable();

    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    for (;;) {
      deadline.check(unavailable);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > maxBytes) throw unavailable();
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (offset !== stat.size) throw unavailable();
    const after = await handle.stat();
    if (!sameFileStat(stat, after)) throw unavailable();
    const pathname = await safeStatInput(root, name);
    if (pathname.state !== 'file' || statFingerprint(pathname.stat) !== statFingerprint(judged.stat)) throw unavailable();
    return `sha256:${hash.digest('hex')}`;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function contentDigest(options: TargetFingerprintV1Options, structure: Structure, deadline: Deadline) {
  const names = new Set<string>([
    ...structure.changedTracked,
    ...structure.untrackedVisible,
    ...structure.flaggedVisible
  ]);
  const records: string[] = [];
  for (const name of sorted(names)) {
    const content = await hashVisibleFile(options.root, name, options.limits.edit_file_bytes, deadline);
    records.push(`${name}\0${content}`);
  }
  return sha256(records.join('\0'));
}

function identitySame(a: RepoIdentity, b: RepoIdentity) {
  return !identityDrift(a, b) &&
    a.root === b.root &&
    a.git_dir === b.git_dir &&
    a.common_dir === b.common_dir;
}

async function compute(options: TargetFingerprintV1Options): Promise<TargetFingerprintV1> {
  if (!Number.isFinite(options.operationBudgetMs ?? OPERATION_BUDGET_MS) || (options.operationBudgetMs ?? OPERATION_BUDGET_MS) < 0) {
    throw unavailable();
  }
  const deadline = new Deadline(options.operationBudgetMs ?? OPERATION_BUDGET_MS);
  for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt++) {
    deadline.check(unavailable);
    const before = await captureStructure(options, deadline);
    const content = await contentDigest(options, before, deadline);
    const after = await captureStructure(options, deadline);
    if (!identitySame(before.identity, after.identity) || before.structuralDigest !== after.structuralDigest) continue;

    return {
      fingerprint: sha256(JSON.stringify([
        'TargetFingerprintV1',
        TARGET_FINGERPRINT_VERSION,
        before.identity.branch,
        before.identity.head,
        before.canonicalInputs,
        content
      ])),
      assurance: 'phase_only',
      branch: before.identity.branch,
      head: before.identity.head
    };
  }
  throw unavailable();
}

export async function computeTargetFingerprintV1(options: TargetFingerprintV1Options): Promise<TargetFingerprintV1> {
  try {
    return await compute(options);
  } catch (error) {
    if (error instanceof TargetFingerprintUnavailable) throw error;
    throw unavailable();
  }
}
