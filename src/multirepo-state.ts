import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SafeError, sha256 } from './errors.js';
import { resolveIdentity } from './identity.js';
import { compilePolicyFor, loadPolicy, policyDigest, type PolicyV2 } from './policy.js';
import { StateStore, acquireLock, defaultStateDir, lockOwnerAlive, validateLockRecord, withShortLock } from './task-state.js';
import { bindTask, completeTask, rebindTask, setTaskPhase, taskStatus, taskWriterLockStatus, withTaskCoordinatorGate, type Phase } from './task.js';
import { readActiveService, rootDigest } from './service-control.js';

const CATALOG_PATH = 'control/multirepo-catalog.json';
const INITIALIZED_PATH = 'control/multirepo-initialized.json';
const AUTH_PATH = 'control/multirepo-auth.json';
const TOKEN_KEY_PATH = 'control/workspace-token-key.json';
const CONTROL_LOCK = 'multirepo-control-v1';
const WORKSPACE_TTL_MS = 8 * 60 * 60_000;
const GRANT_TTL_MS = 10 * 60_000;
const WORKSPACE_DRAIN_WAIT_MS = 60_000;
const MAX_AUTH_RECORDS = 4096;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;

export type WorkspaceMode = 'inspect' | 'code' | 'review';
export type WorkspaceCapability = 'read' | 'write' | 'check';

export type RepositoryRegistration = {
  repository_id: string;
  name: string;
  root: string;
  root_digest: string;
  git_dir: string;
  common_dir: string;
  policy_source: string;
  policy_ref: string;
  policy_digest: string;
  registration_epoch: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type TaskRegistration = {
  task_id: string;
  repository_id: string;
  binding_epoch: number;
  phase_epoch: number;
  phase: Phase;
  allow_detached: boolean;
  completed: boolean;
  created_at: string;
  updated_at: string;
};

export type MultiRepoCatalog = {
  schema_version: 1;
  revision: number;
  service: { port: number; configured_at: string };
  repositories: Record<string, RepositoryRegistration>;
  tasks: Record<string, TaskRegistration>;
  migration?: {
    source: 'active-service-v1';
    migrated_at: string;
    active_generation: number;
    repository_id: string;
    task_id: string;
  };
};

export type WorkspaceGrant = {
  grant_id: string;
  repository_id: string;
  task_id: string;
  registration_epoch: number;
  binding_epoch: number;
  phase_epoch: number;
  policy_digest: string;
  issued_at: string;
  expires_at: string;
  status: 'open' | 'consumed' | 'revoked';
  consumed_by?: string;
};

export type WorkspaceSelection = {
  workspace_id: string;
  repository_id: string;
  task_id: string;
  mode: WorkspaceMode;
  capabilities: WorkspaceCapability[];
  registration_epoch: number;
  binding_epoch: number;
  phase_epoch: number;
  policy_digest: string;
  issued_at: string;
  expires_at: string;
  status: 'open' | 'closed' | 'revoked';
};

type RequestLedgerEntry = {
  operation: 'workspace_open' | 'workspace_close';
  args_digest: string;
  workspace_id: string;
  at: string;
};

type AuthState = {
  schema_version: 1;
  grants: Record<string, WorkspaceGrant>;
  workspaces: Record<string, WorkspaceSelection>;
  requests: Record<string, RequestLedgerEntry>;
};

type TokenKey = { key_id: string; secret: string; created_at: string };

export type AuthorizedWorkspace = {
  selection: WorkspaceSelection;
  repository: RepositoryRegistration;
  task: TaskRegistration;
  live_task: Awaited<ReturnType<typeof taskStatus>>;
  scope: {
    workspace_id: string;
    repository_id: string;
    task_id: string;
    registration_epoch: number;
    binding_epoch: number;
    phase_epoch: number;
    policy_digest: string;
    phase: Phase;
    mode: WorkspaceMode;
  };
};

function nowIso() { return new Date().toISOString(); }
function futureIso(ms: number) { return new Date(Date.now() + ms).toISOString(); }
function validDate(value: unknown) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function object(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SafeError(`Corrupt ${what}; inspect operator state before continuing.`);
  return value as Record<string, unknown>;
}
function stringField(value: unknown, what: string) {
  if (typeof value !== 'string' || !value) throw new SafeError(`Corrupt ${what}; inspect operator state before continuing.`);
  return value;
}
function absoluteField(value: unknown, what: string) {
  const resolved = stringField(value, what);
  if (!path.isAbsolute(resolved)) throw new SafeError(`Corrupt ${what}; expected an absolute path in operator state.`);
  return resolved;
}
function integerField(value: unknown, what: string, min = 0) {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new SafeError(`Corrupt ${what}; inspect operator state before continuing.`);
  return value as number;
}
function booleanField(value: unknown, what: string) {
  if (typeof value !== 'boolean') throw new SafeError(`Corrupt ${what}; inspect operator state before continuing.`);
  return value;
}
function assertId(value: string, what: string) {
  if (!ID.test(value)) throw new SafeError(`Invalid ${what}: use 1-64 letters, digits, ".", "_" or "-".`);
  return value;
}
function within(child: string, parent: string) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function parseRepository(value: unknown, key: string): RepositoryRegistration {
  const v = object(value, `repository registration ${key}`);
  const repository_id = assertId(stringField(v.repository_id, 'repository_id'), 'repository ID');
  if (repository_id !== key) throw new SafeError('Corrupt repository catalog key; inspect operator state before continuing.');
  const root_digest = stringField(v.root_digest, 'root_digest');
  const policy_digest = stringField(v.policy_digest, 'policy_digest');
  const name = stringField(v.name, 'repository name');
  if (!name.trim()) throw new SafeError('Corrupt repository name; it must contain at least one non-whitespace character.');
  if (!HEX64.test(root_digest) || !HEX64.test(policy_digest)) throw new SafeError('Corrupt repository digest; inspect operator state before continuing.');
  if (!validDate(v.created_at) || !validDate(v.updated_at)) throw new SafeError('Corrupt repository timestamps; inspect operator state before continuing.');
  return {
    repository_id,
    name,
    root: absoluteField(v.root, 'repository root'),
    root_digest,
    git_dir: absoluteField(v.git_dir, 'git_dir'),
    common_dir: absoluteField(v.common_dir, 'common_dir'),
    policy_source: absoluteField(v.policy_source, 'policy_source'),
    policy_ref: stringField(v.policy_ref, 'policy_ref'),
    policy_digest,
    registration_epoch: integerField(v.registration_epoch, 'registration_epoch', 1),
    enabled: booleanField(v.enabled, 'repository enabled'),
    created_at: v.created_at as string,
    updated_at: v.updated_at as string
  };
}

function parseTask(value: unknown, key: string): TaskRegistration {
  const v = object(value, `task registration ${key}`);
  const task_id = assertId(stringField(v.task_id, 'task_id'), 'task ID');
  if (task_id !== key) throw new SafeError('Corrupt task catalog key; inspect operator state before continuing.');
  const phase = stringField(v.phase, 'task phase');
  if (phase !== 'coding' && phase !== 'review') throw new SafeError('Corrupt task phase; inspect operator state before continuing.');
  if (!validDate(v.created_at) || !validDate(v.updated_at)) throw new SafeError('Corrupt task timestamps; inspect operator state before continuing.');
  return {
    task_id,
    repository_id: assertId(stringField(v.repository_id, 'task repository_id'), 'repository ID'),
    binding_epoch: integerField(v.binding_epoch, 'binding_epoch', 1),
    phase_epoch: integerField(v.phase_epoch, 'phase_epoch', 1),
    phase,
    allow_detached: booleanField(v.allow_detached, 'allow_detached'),
    completed: booleanField(v.completed, 'completed'),
    created_at: v.created_at as string,
    updated_at: v.updated_at as string
  };
}

function parseCatalog(value: unknown): MultiRepoCatalog {
  const v = object(value, 'multi-repository catalog');
  if (v.schema_version !== 1) throw new SafeError('Unsupported multi-repository catalog version.');
  const service = object(v.service, 'multi-repository service configuration');
  const port = integerField(service.port, 'service port', 1024);
  if (port > 65535 || !validDate(service.configured_at)) throw new SafeError('Corrupt multi-repository service configuration.');
  const repositoriesRaw = object(v.repositories, 'repository catalog');
  const tasksRaw = object(v.tasks, 'task catalog');
  const repositories: Record<string, RepositoryRegistration> = {};
  const tasks: Record<string, TaskRegistration> = {};
  for (const [key, entry] of Object.entries(repositoriesRaw)) repositories[key] = parseRepository(entry, key);
  for (const [key, entry] of Object.entries(tasksRaw)) tasks[key] = parseTask(entry, key);
  let migration: MultiRepoCatalog['migration'];
  if (v.migration !== undefined) {
    const m = object(v.migration, 'migration record');
    if (m.source !== 'active-service-v1' || !validDate(m.migrated_at)) throw new SafeError('Corrupt migration record.');
    migration = {
      source: 'active-service-v1',
      migrated_at: m.migrated_at as string,
      active_generation: integerField(m.active_generation, 'migration generation', 1),
      repository_id: assertId(stringField(m.repository_id, 'migration repository_id'), 'repository ID'),
      task_id: assertId(stringField(m.task_id, 'migration task_id'), 'task ID')
    };
  }
  const unfinishedByRepository = new Set<string>();
  for (const task of Object.values(tasks)) {
    if (task.completed) continue;
    if (!repositories[task.repository_id]) {
      throw new SafeError(`Corrupt task catalog: unfinished task ${task.task_id} references missing repository ${task.repository_id}.`);
    }
    if (unfinishedByRepository.has(task.repository_id)) {
      throw new SafeError(`Corrupt task catalog: repository ${task.repository_id} has multiple unfinished tasks.`);
    }
    unfinishedByRepository.add(task.repository_id);
  }
  return {
    schema_version: 1,
    revision: integerField(v.revision, 'catalog revision', 1),
    service: { port, configured_at: service.configured_at as string },
    repositories,
    tasks,
    ...(migration ? { migration } : {})
  };
}

function defaultCatalog(port = 8787): MultiRepoCatalog {
  return { schema_version: 1, revision: 1, service: { port, configured_at: nowIso() }, repositories: {}, tasks: {} };
}

function parseCapabilities(value: unknown): WorkspaceCapability[] {
  if (!Array.isArray(value) || !value.length || value.some(v => v !== 'read' && v !== 'write' && v !== 'check')) {
    throw new SafeError('Corrupt workspace capabilities; inspect operator state before continuing.');
  }
  return [...value] as WorkspaceCapability[];
}

function parseGrant(value: unknown, key: string): WorkspaceGrant {
  const v = object(value, `workspace grant ${key}`);
  const grant_id = stringField(v.grant_id, 'grant_id');
  if (!HEX32.test(grant_id) || grant_id !== key) throw new SafeError('Corrupt workspace grant ID.');
  const status = stringField(v.status, 'grant status');
  if (status !== 'open' && status !== 'consumed' && status !== 'revoked') throw new SafeError('Corrupt workspace grant status.');
  if (!validDate(v.issued_at) || !validDate(v.expires_at)) throw new SafeError('Corrupt workspace grant timestamps.');
  const consumed_by = v.consumed_by === undefined ? undefined : stringField(v.consumed_by, 'consumed_by');
  if (consumed_by !== undefined && !HEX32.test(consumed_by)) throw new SafeError('Corrupt consumed workspace ID.');
  return {
    grant_id,
    repository_id: assertId(stringField(v.repository_id, 'grant repository_id'), 'repository ID'),
    task_id: assertId(stringField(v.task_id, 'grant task_id'), 'task ID'),
    registration_epoch: integerField(v.registration_epoch, 'grant registration_epoch', 1),
    binding_epoch: integerField(v.binding_epoch, 'grant binding_epoch', 1),
    phase_epoch: integerField(v.phase_epoch, 'grant phase_epoch', 1),
    policy_digest: (() => { const digest = stringField(v.policy_digest, 'grant policy_digest'); if (!HEX64.test(digest)) throw new SafeError('Corrupt workspace grant policy digest.'); return digest; })(),
    issued_at: v.issued_at as string,
    expires_at: v.expires_at as string,
    status,
    ...(consumed_by ? { consumed_by } : {})
  };
}

function parseWorkspace(value: unknown, key: string): WorkspaceSelection {
  const v = object(value, `workspace selection ${key}`);
  const workspace_id = stringField(v.workspace_id, 'workspace_id');
  if (!HEX32.test(workspace_id) || workspace_id !== key) throw new SafeError('Corrupt workspace selection ID.');
  const mode = stringField(v.mode, 'workspace mode');
  if (mode !== 'inspect' && mode !== 'code' && mode !== 'review') throw new SafeError('Corrupt workspace mode.');
  const status = stringField(v.status, 'workspace status');
  if (status !== 'open' && status !== 'closed' && status !== 'revoked') throw new SafeError('Corrupt workspace status.');
  const policy_digest = stringField(v.policy_digest, 'workspace policy_digest');
  if (!HEX64.test(policy_digest) || !validDate(v.issued_at) || !validDate(v.expires_at)) throw new SafeError('Corrupt workspace selection.');
  return {
    workspace_id,
    repository_id: assertId(stringField(v.repository_id, 'workspace repository_id'), 'repository ID'),
    task_id: assertId(stringField(v.task_id, 'workspace task_id'), 'task ID'),
    mode,
    capabilities: parseCapabilities(v.capabilities),
    registration_epoch: integerField(v.registration_epoch, 'workspace registration_epoch', 1),
    binding_epoch: integerField(v.binding_epoch, 'workspace binding_epoch', 1),
    phase_epoch: integerField(v.phase_epoch, 'workspace phase_epoch', 1),
    policy_digest,
    issued_at: v.issued_at as string,
    expires_at: v.expires_at as string,
    status
  };
}

function parseAuth(value: unknown): AuthState {
  const v = object(value, 'workspace authorization state');
  if (v.schema_version !== 1) throw new SafeError('Unsupported workspace authorization state version.');
  const grantsRaw = object(v.grants, 'workspace grants');
  const workspacesRaw = object(v.workspaces, 'workspace selections');
  const requestsRaw = object(v.requests, 'workspace request ledger');
  const grants: Record<string, WorkspaceGrant> = {};
  const workspaces: Record<string, WorkspaceSelection> = {};
  const requests: Record<string, RequestLedgerEntry> = {};
  for (const [key, entry] of Object.entries(grantsRaw)) grants[key] = parseGrant(entry, key);
  for (const [key, entry] of Object.entries(workspacesRaw)) workspaces[key] = parseWorkspace(entry, key);
  for (const [key, raw] of Object.entries(requestsRaw)) {
    if (!HEX64.test(key)) throw new SafeError('Corrupt workspace request ledger key.');
    const e = object(raw, 'workspace request ledger entry');
    const operation = stringField(e.operation, 'workspace request operation');
    if (operation !== 'workspace_open' && operation !== 'workspace_close') throw new SafeError('Corrupt workspace request operation.');
    const args_digest = stringField(e.args_digest, 'workspace request args_digest');
    const workspace_id = stringField(e.workspace_id, 'workspace request workspace_id');
    if (!HEX64.test(args_digest) || !HEX32.test(workspace_id) || !validDate(e.at)) throw new SafeError('Corrupt workspace request ledger entry.');
    requests[key] = { operation, args_digest, workspace_id, at: e.at as string };
  }
  return { schema_version: 1, grants, workspaces, requests };
}

function emptyAuth(): AuthState { return { schema_version: 1, grants: {}, workspaces: {}, requests: {} }; }

function parseTokenKey(value: unknown): TokenKey {
  const v = object(value, 'workspace token key');
  const key_id = stringField(v.key_id, 'workspace token key ID');
  const secret = stringField(v.secret, 'workspace token secret');
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(key_id) || !/^[A-Za-z0-9_-]{43,64}$/.test(secret) || !validDate(v.created_at)) {
    throw new SafeError('Corrupt workspace token key; inspect operator state before continuing.');
  }
  return { key_id, secret, created_at: v.created_at as string };
}

type MultiRepoInitialization = { initialized_at: string };

function parseInitialization(value: unknown): MultiRepoInitialization {
  const v = object(value, 'multi-repository initialization marker');
  if (!validDate(v.initialized_at)) throw new SafeError('Corrupt multi-repository initialization marker; inspect operator state before continuing.');
  return { initialized_at: v.initialized_at as string };
}

async function ensureInitialized(store: StateStore) {
  const existing = await store.read<unknown>(INITIALIZED_PATH, 'multirepo-initialized');
  if (existing !== undefined) return parseInitialization(existing);
  const desired: MultiRepoInitialization = { initialized_at: nowIso() };
  if (await store.create(INITIALIZED_PATH, 'multirepo-initialized', desired)) return desired;
  const raced = await store.read<unknown>(INITIALIZED_PATH, 'multirepo-initialized');
  if (raced === undefined) throw new SafeError('Multi-repository initialization marker creation raced and no durable marker is available.');
  return parseInitialization(raced);
}

function authHasHistory(auth: AuthState) {
  return !!(Object.keys(auth.grants).length || Object.keys(auth.workspaces).length || Object.keys(auth.requests).length);
}

async function readCatalogStore(store: StateStore) {
  const raw = await store.read<unknown>(CATALOG_PATH, 'multirepo-catalog');
  if (raw !== undefined) return parseCatalog(raw);

  const initializedRaw = await store.read<unknown>(INITIALIZED_PATH, 'multirepo-initialized');
  const authRaw = await store.read<unknown>(AUTH_PATH, 'multirepo-auth');
  const tokenKeyRaw = await store.read<unknown>(TOKEN_KEY_PATH, 'workspace-token-key');
  if (initializedRaw !== undefined) parseInitialization(initializedRaw);
  const auth = authRaw === undefined ? emptyAuth() : parseAuth(authRaw);
  if (tokenKeyRaw !== undefined) parseTokenKey(tokenKeyRaw);
  if (initializedRaw !== undefined || authHasHistory(auth) || tokenKeyRaw !== undefined) {
    throw new SafeError('Multi-repository catalog is missing after durable authorization state was initialized; refusing to reset repository epochs. Restore or explicitly repair operator state.');
  }
  return defaultCatalog();
}
async function readAuthStore(store: StateStore) {
  const raw = await store.read<unknown>(AUTH_PATH, 'multirepo-auth');
  return raw === undefined ? emptyAuth() : parseAuth(raw);
}
async function writeCatalog(store: StateStore, catalog: MultiRepoCatalog) {
  const next = parseCatalog({ ...catalog, revision: catalog.revision + 1 });
  await ensureInitialized(store);
  await store.write(CATALOG_PATH, 'multirepo-catalog', next);
  return next;
}
async function writeAuth(store: StateStore, auth: AuthState) {
  const checked = parseAuth(auth);
  await ensureInitialized(store);
  await store.write(AUTH_PATH, 'multirepo-auth', checked);
}
async function withControlLock<T>(stateDir: string, purpose: string, fn: (store: StateStore) => Promise<T>, forbiddenRoots: string[] = []) {
  const store = await StateStore.open(stateDir, { forbiddenRoots });
  const lock = await acquireLock(store, CONTROL_LOCK, purpose);
  try { return await fn(store); } finally { await lock.release(); }
}
function activeRepositoryTask(catalog: MultiRepoCatalog, repositoryId: string) {
  const active = Object.values(catalog.tasks).filter(task => task.repository_id === repositoryId && !task.completed);
  if (active.length > 1) throw new SafeError(`Repository ${repositoryId} has multiple unfinished catalog tasks; operator-state repair is required before authorization changes.`);
  return active[0];
}

async function withRepositoryTaskDrain<T>(
  stateDir: string,
  repositoryId: string,
  purpose: string,
  fn: (store: StateStore, catalog: MultiRepoCatalog) => Promise<T>,
  forbiddenRoots: string[] = []
) {
  const snapshot = await readMultiRepoCatalog(stateDir);
  const active = activeRepositoryTask(snapshot, repositoryId);
  const apply = () => withControlLock(stateDir, purpose, async store => {
    const catalog = await readCatalogStore(store);
    const current = activeRepositoryTask(catalog, repositoryId);
    if ((current?.task_id ?? null) !== (active?.task_id ?? null)) {
      throw new SafeError(`Repository ${repositoryId} task ownership changed while authorization was draining; retry the coordinator operation.`);
    }
    return fn(store, catalog);
  }, forbiddenRoots);
  return active ? withTaskCoordinatorGate(stateDir, active.task_id, apply) : apply();
}
const admissionKey = (workspaceId: string) => `workspace-${workspaceId}-admission`;

function knownControlPurpose(purpose: string) {
  if (purpose === 'configure multi-repository service' || purpose === 'rollback active-service catalog migration' || purpose === 'explicit multirepo control recovery') return true;
  const idPrefixes = [
    'register repository ', 'enable repository ', 'disable repository ', 'remove repository ',
    'bind task ', 'publish task ', 'drain task ', 'grant workspace for task ',
    'migrate active service to repository '
  ];
  for (const prefix of idPrefixes) {
    if (!purpose.startsWith(prefix)) continue;
    const rest = purpose.slice(prefix.length);
    if (prefix === 'publish task ') {
      const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63}) (?:phase (?:coding|review)|rebind)$/.exec(rest);
      return !!match;
    }
    return ID.test(rest);
  }
  const open = /^open (?:inspect|code|review) workspace for ([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(purpose);
  if (open) return true;
  const workspace = /^(?:close|revoke) workspace ([a-f0-9]{32})$/.exec(purpose);
  if (workspace) return true;
  return /^revoke grant [a-f0-9]{32}$/.test(purpose);
}

function admissionPurposeMatchesSelection(selection: WorkspaceSelection, purpose: string) {
  const workspaceId = selection.workspace_id;
  if (purpose === `workspace ${workspaceId} read`) return selection.status === 'open' && selection.capabilities.includes('read');
  if (purpose === `workspace ${workspaceId} write`) return selection.status === 'open' && selection.capabilities.includes('write');
  if (purpose === `workspace ${workspaceId} check`) return selection.status === 'open' && selection.capabilities.includes('check');
  if (purpose === `close workspace ${workspaceId}`) return selection.status === 'open' || selection.status === 'closed';
  if (purpose === `revoke workspace ${workspaceId}`) return selection.status === 'open' || selection.status === 'revoked';
  if (purpose === `explicit workspace ${workspaceId} admission recovery`) return true;
  return false;
}

async function staleLockForRecovery(
  store: StateStore,
  key: string,
  purposeAllowed: (purpose: string) => boolean
) {
  const raw = await store.read<unknown>(`locks/${key}.json`, 'lock');
  if (raw === undefined) return undefined;
  const record = validateLockRecord(raw, key);
  if (record.hostname !== os.hostname()) throw new SafeError(`Lock ${key} belongs to host ${record.hostname}; recovery is refused from this host.`);
  if (lockOwnerAlive(record.pid)) throw new SafeError(`Lock ${key} is owned by live process ${record.pid} (${record.purpose}); live locks are never recovered.`);
  if (!purposeAllowed(record.purpose)) throw new SafeError(`Lock ${key} has unexpected purpose "${record.purpose}"; inspect operator state before recovery.`);
  return record;
}

export async function recoverMultiRepoControlLock(options: { stateDir?: string; beforeRecover?: () => void | Promise<void> } = {}) {
  const stateDir = options.stateDir ?? defaultStateDir();
  const store = await StateStore.open(stateDir);
  const existing = await staleLockForRecovery(store, CONTROL_LOCK, knownControlPurpose);
  if (!existing) return { recovered: false, lock: CONTROL_LOCK };
  await options.beforeRecover?.();
  const recovered = await acquireLock(store, CONTROL_LOCK, 'explicit multirepo control recovery', {
    recoverStale: true,
    expectedExistingPurpose: existing.purpose,
    expectedExistingToken: existing.token
  });
  await recovered.release();
  return { recovered: true, lock: CONTROL_LOCK, previous_pid: existing.pid, previous_purpose: existing.purpose, acquired_at: existing.acquired_at };
}

export async function recoverWorkspaceAdmissionLock(options: {
  stateDir?: string;
  workspaceId: string;
  beforeRecover?: () => void | Promise<void>;
}) {
  const stateDir = options.stateDir ?? defaultStateDir();
  const workspaceId = options.workspaceId;
  if (!HEX32.test(workspaceId)) throw new SafeError('Invalid workspace ID.');
  const store = await StateStore.open(stateDir);
  const auth = await readAuthStore(store);
  const selection = auth.workspaces[workspaceId];
  if (!selection) throw new SafeError('Workspace selection is unknown; refusing admission-lock recovery.');
  const key = admissionKey(workspaceId);
  const existing = await staleLockForRecovery(store, key, purpose => admissionPurposeMatchesSelection(selection, purpose));
  if (!existing) return { recovered: false, workspace_id: workspaceId, status: selection.status };
  await options.beforeRecover?.();
  const recovered = await acquireLock(store, key, `explicit workspace ${workspaceId} admission recovery`, {
    recoverStale: true,
    expectedExistingPurpose: existing.purpose,
    expectedExistingToken: existing.token
  });
  await recovered.release();
  return {
    recovered: true,
    workspace_id: workspaceId,
    status: selection.status,
    previous_pid: existing.pid,
    previous_purpose: existing.purpose,
    acquired_at: existing.acquired_at
  };
}

async function tokenKey(store: StateStore) {
  const existing = await store.read<unknown>(TOKEN_KEY_PATH, 'workspace-token-key');
  if (existing !== undefined) return parseTokenKey(existing);
  const desired: TokenKey = { key_id: 'k1', secret: randomBytes(32).toString('base64url'), created_at: nowIso() };
  if (await store.create(TOKEN_KEY_PATH, 'workspace-token-key', desired)) return desired;
  const raced = await store.read<unknown>(TOKEN_KEY_PATH, 'workspace-token-key');
  if (raced === undefined) throw new SafeError('Workspace token key creation raced and no durable key is available.');
  return parseTokenKey(raced);
}
function hmac(secret: string, domain: string, payload: string) {
  return createHmac('sha256', Buffer.from(secret, 'base64url')).update(domain).update('\0').update(payload).digest('base64url');
}
function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function selectionPayload(selection: WorkspaceSelection) {
  return JSON.stringify({
    workspace_id: selection.workspace_id,
    repository_id: selection.repository_id,
    task_id: selection.task_id,
    mode: selection.mode,
    capabilities: selection.capabilities,
    registration_epoch: selection.registration_epoch,
    binding_epoch: selection.binding_epoch,
    phase_epoch: selection.phase_epoch,
    policy_digest: selection.policy_digest,
    issued_at: selection.issued_at,
    expires_at: selection.expires_at
  });
}
function grantPayload(grant: WorkspaceGrant) {
  return JSON.stringify({
    grant_id: grant.grant_id,
    repository_id: grant.repository_id,
    task_id: grant.task_id,
    registration_epoch: grant.registration_epoch,
    binding_epoch: grant.binding_epoch,
    phase_epoch: grant.phase_epoch,
    policy_digest: grant.policy_digest,
    issued_at: grant.issued_at,
    expires_at: grant.expires_at
  });
}
async function workspaceToken(store: StateStore, selection: WorkspaceSelection) {
  const key = await tokenKey(store);
  return `ws1.${key.key_id}.${selection.workspace_id}.${hmac(key.secret, 'workspace', selectionPayload(selection))}`;
}
async function grantToken(store: StateStore, grant: WorkspaceGrant) {
  const key = await tokenKey(store);
  return `wg1.${key.key_id}.${grant.grant_id}.${hmac(key.secret, 'grant', grantPayload(grant))}`;
}
function tokenParts(token: string, prefix: 'ws1' | 'wg1') {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== prefix || !/^[A-Za-z0-9_-]{1,32}$/.test(parts[1]) || !HEX32.test(parts[2]) || !/^[A-Za-z0-9_-]{43,64}$/.test(parts[3])) {
    throw new SafeError(prefix === 'ws1' ? 'Invalid workspace_token.' : 'Invalid write_grant.');
  }
  return { keyId: parts[1], id: parts[2], mac: parts[3] };
}
async function verifyGrantToken(store: StateStore, auth: AuthState, token: string) {
  const parts = tokenParts(token, 'wg1');
  const key = await tokenKey(store);
  if (parts.keyId !== key.key_id) throw new SafeError('Invalid write_grant.');
  const grant = auth.grants[parts.id];
  if (!grant || !safeEqual(parts.mac, hmac(key.secret, 'grant', grantPayload(grant)))) throw new SafeError('Invalid write_grant.');
  return grant;
}
async function selectionFromToken(store: StateStore, auth: AuthState, token: string, allowInactive = false) {
  const parts = tokenParts(token, 'ws1');
  const key = await tokenKey(store);
  if (parts.keyId !== key.key_id) throw new SafeError('Invalid workspace_token.');
  const selection = auth.workspaces[parts.id];
  if (!selection || !safeEqual(parts.mac, hmac(key.secret, 'workspace', selectionPayload(selection)))) throw new SafeError('Invalid workspace_token.');
  if (!allowInactive) {
    if (selection.status !== 'open') throw new SafeError('Workspace selection is closed or revoked. Open a new workspace.');
    if (Date.now() >= Date.parse(selection.expires_at)) throw new SafeError('Workspace selection expired. Open a new workspace.');
  }
  return selection;
}
function validateRequestId(requestId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) throw new SafeError('Invalid request_id.');
}
function requestKey(namespace: string, requestId: string) {
  validateRequestId(requestId);
  return sha256(`${namespace}\0${requestId}`);
}
function requestDigest(operation: string, args: unknown[]) { return sha256(JSON.stringify([operation, ...args])); }

async function loadPolicySnapshot(store: StateStore, repository: RepositoryRegistration): Promise<PolicyV2> {
  const raw = await store.read<unknown>(repository.policy_ref, 'repository-policy');
  if (raw === undefined) throw new SafeError(`Registered policy for ${repository.repository_id} is missing.`);
  const policy = loadPolicy(raw);
  if (policyDigest(policy) !== repository.policy_digest) throw new SafeError(`Registered policy for ${repository.repository_id} is corrupt or changed.`);
  return policy;
}

async function verifyRepositoryLive(repository: RepositoryRegistration) {
  const root = await realpath(repository.root).catch(() => undefined);
  if (!root || root !== repository.root || rootDigest(root) !== repository.root_digest) throw new SafeError(`Repository ${repository.repository_id} no longer matches its registered canonical root.`);
  const identity = await resolveIdentity(root);
  if (identity.root !== repository.root || identity.git_dir !== repository.git_dir || identity.common_dir !== repository.common_dir) {
    throw new SafeError(`Repository ${repository.repository_id} checkout identity changed; operator reconciliation is required.`);
  }
  return identity;
}

function taskFromLive(task: TaskRegistration, live: Awaited<ReturnType<typeof taskStatus>>) {
  const bindingEpoch = typeof live.binding_epoch === 'number' ? live.binding_epoch : 1;
  const phaseEpoch = typeof live.phase_epoch === 'number' ? live.phase_epoch : 1;
  if (bindingEpoch !== task.binding_epoch || phaseEpoch !== task.phase_epoch || live.phase !== task.phase || !!live.completion !== task.completed) {
    throw new SafeError(`Task ${task.task_id} catalog state is stale; reconcile it through the multi-repository coordinator before use.`);
  }
  return { bindingEpoch, phaseEpoch };
}

export async function readMultiRepoCatalog(stateDir = defaultStateDir()) {
  const store = await StateStore.inspect(stateDir);
  if (!store) return defaultCatalog();
  return readCatalogStore(store);
}

export async function getMultiRepoServiceConfig(stateDir = defaultStateDir()) {
  const catalog = await readMultiRepoCatalog(stateDir);
  return { ...catalog.service, catalog_revision: catalog.revision };
}

export async function configureMultiRepoService(options: { stateDir?: string; port: number }) {
  const stateDir = options.stateDir ?? defaultStateDir();
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw new SafeError('Service port must be an integer from 1024 to 65535.');
  return withControlLock(stateDir, 'configure multi-repository service', async store => {
    let catalog = await readCatalogStore(store);
    if (catalog.service.port === options.port) return { ...catalog.service, catalog_revision: catalog.revision, unchanged: true };
    const service = { port: options.port, configured_at: nowIso() };
    catalog = await writeCatalog(store, { ...catalog, service });
    return { ...service, catalog_revision: catalog.revision, unchanged: false };
  });
}

export async function registerRepository(options: { stateDir?: string; repositoryId: string; name?: string; root: string; policyPath: string }) {
  const stateDir = options.stateDir ?? defaultStateDir();
  const repositoryId = assertId(options.repositoryId, 'repository ID');
  if (options.name !== undefined && !options.name.trim()) throw new SafeError('Repository name must contain at least one non-whitespace character.');
  const root = await realpath(options.root);
  const identity = await resolveIdentity(root);
  const policyPath = await realpath(options.policyPath);
  if (within(policyPath, root)) throw new SafeError('Policy must remain outside the served repository.');
  const loaded = loadPolicy(JSON.parse(await readFile(policyPath, 'utf8')));
  const digest = policyDigest(loaded);
  const stateCanonical = await StateStore.canonicalPath(stateDir);
  if (within(stateCanonical, root) || within(root, stateCanonical)) throw new SafeError('Operator state directory must remain outside the served repository.');
  await compilePolicyFor(loaded, { root, protectedPaths: [stateCanonical, policyPath] });
  return withRepositoryTaskDrain(stateDir, repositoryId, `register repository ${repositoryId}`, async (store, catalog) => {
    const existing = catalog.repositories[repositoryId];
    for (const other of Object.values(catalog.repositories)) {
      if (within(policyPath, other.root)) throw new SafeError(`Policy source must remain outside every served repository; it is inside registered repository ${other.repository_id}.`);
      if (within(other.policy_source, root)) throw new SafeError(`Repository root would contain the operator policy source for registered repository ${other.repository_id}; choose a different checkout or move that policy first.`);
      if (other.repository_id === repositoryId) continue;
      if (within(root, other.root) || within(other.root, root)) throw new SafeError(`Repository root overlaps registered repository ${other.repository_id}; use a distinct checkout/worktree.`);
      if (other.root === identity.root && other.git_dir === identity.git_dir) throw new SafeError(`Checkout is already registered as ${other.repository_id}.`);
    }
    const desiredName = options.name ?? existing?.name ?? repositoryId;
    if (existing) {
      if (existing.root !== root || existing.git_dir !== identity.git_dir || existing.common_dir !== identity.common_dir) throw new SafeError(`Repository ID ${repositoryId} is already bound to a different checkout.`);
      if (existing.policy_digest === digest && existing.enabled && existing.name === desiredName) return { repository: existing, catalog_revision: catalog.revision, unchanged: true };
    }
    const policyRef = `policies/${digest}.json`;
    const snapshot = await store.read<unknown>(policyRef, 'repository-policy');
    if (snapshot === undefined) {
      if (!(await store.create(policyRef, 'repository-policy', loaded))) {
        const raced = await store.read<unknown>(policyRef, 'repository-policy');
        if (raced === undefined || policyDigest(loadPolicy(raced)) !== digest) throw new SafeError('Policy snapshot publication raced with incompatible state.');
      }
    } else if (policyDigest(loadPolicy(snapshot)) !== digest) throw new SafeError('Policy snapshot digest collision or corrupt operator state.');
    const at = nowIso();
    const repository: RepositoryRegistration = {
      repository_id: repositoryId,
      name: desiredName,
      root,
      root_digest: rootDigest(root),
      git_dir: identity.git_dir,
      common_dir: identity.common_dir,
      policy_source: policyPath,
      policy_ref: policyRef,
      policy_digest: digest,
      registration_epoch: (existing?.registration_epoch ?? 0) + 1,
      enabled: true,
      created_at: existing?.created_at ?? at,
      updated_at: at
    };
    catalog = await writeCatalog(store, {
      ...catalog,
      repositories: { ...catalog.repositories, [repositoryId]: repository }
    });
    return { repository, catalog_revision: catalog.revision, unchanged: false };
  }, [root, identity.common_dir]);
}

export async function setRepositoryEnabled(options: { stateDir?: string; repositoryId: string; enabled: boolean }) {
  const stateDir = options.stateDir ?? defaultStateDir();
  const repositoryId = assertId(options.repositoryId, 'repository ID');
  return withRepositoryTaskDrain(stateDir, repositoryId, `${options.enabled ? 'enable' : 'disable'} repository ${repositoryId}`, async (store, catalog) => {
    const repository = catalog.repositories[repositoryId];
    if (!repository) throw new SafeError(`Repository ${repositoryId} is not registered.`);
    if (repository.enabled === options.enabled) return { repository, catalog_revision: catalog.revision, unchanged: true };
    const next = { ...repository, enabled: options.enabled, registration_epoch: repository.registration_epoch + 1, updated_at: nowIso() };
    catalog = await writeCatalog(store, { ...catalog, repositories: { ...catalog.repositories, [repositoryId]: next } });
    return { repository: next, catalog_revision: catalog.revision, unchanged: false };
  });
}

export async function removeRepository(options: { stateDir?: string; repositoryId: string }) {
  const stateDir = options.stateDir ?? defaultStateDir();
  const repositoryId = assertId(options.repositoryId, 'repository ID');
  return withControlLock(stateDir, `remove repository ${repositoryId}`, async store => {
    let catalog = await readCatalogStore(store);
    const repository = catalog.repositories[repositoryId];
    if (!repository) return { removed: false, catalog_revision: catalog.revision };
    const liveTasks = Object.values(catalog.tasks).filter(t => t.repository_id === repositoryId && !t.completed);
    if (liveTasks.length) throw new SafeError(`Repository ${repositoryId} still has unfinished task ${liveTasks[0].task_id}; finish it before removal.`);
    const repositories = { ...catalog.repositories };
    delete repositories[repositoryId];
    catalog = await writeCatalog(store, { ...catalog, repositories });
    return { removed: true, catalog_revision: catalog.revision };
  });
}

export async function bindRegisteredTask(options: { stateDir?: string; repositoryId: string; taskId: string; allowDetached?: boolean }) {
  const stateDir = options.stateDir ?? defaultStateDir();
  const repositoryId = assertId(options.repositoryId, 'repository ID');
  const taskId = assertId(options.taskId, 'task ID');
  return withControlLock(stateDir, `bind task ${taskId}`, async store => {
    let catalog = await readCatalogStore(store);
    const repository = catalog.repositories[repositoryId];
    if (!repository || !repository.enabled) throw new SafeError(`Repository ${repositoryId} is not registered and enabled.`);
    await verifyRepositoryLive(repository);
    await loadPolicySnapshot(store, repository);
    const previous = catalog.tasks[taskId];
    if (previous && previous.repository_id !== repositoryId) throw new SafeError(`Task ID ${taskId} is already registered to a different repository.`);
    const conflict = Object.values(catalog.tasks).find(t => t.repository_id === repositoryId && t.task_id !== taskId && !t.completed);
    if (conflict) throw new SafeError(`Repository ${repositoryId} already has unfinished task ${conflict.task_id}; finish it before binding another writable task.`);
    if (previous) {
      if (previous.completed) throw new SafeError(`Task ${taskId} is already draining/completed; use a new task ID.`);
      const live = await taskStatus(stateDir, taskId, { readOnly: true });
      taskFromLive(previous, live);
      if (live.root !== repository.root || live.git_dir !== repository.git_dir || live.common_dir !== repository.common_dir || live.policy_digest !== repository.policy_digest) {
        throw new SafeError('Bound task identity does not match the registered repository.');
      }
      if (options.allowDetached !== undefined && options.allowDetached !== live.allow_detached) {
        throw new SafeError('Task detached-HEAD approval differs from the existing binding; use task rebind for an explicit authorization change.');
      }
      return { task: previous, catalog_revision: catalog.revision, unchanged: true };
    }
    await bindTask(stateDir, taskId, repository.root, repository.policy_digest, { allowDetached: options.allowDetached, gateWaitMs: 0 });
    const live = await taskStatus(stateDir, taskId);
    if (live.root !== repository.root || live.git_dir !== repository.git_dir || live.common_dir !== repository.common_dir || live.policy_digest !== repository.policy_digest) {
      throw new SafeError('Bound task identity does not match the registered repository.');
    }
    const at = nowIso();
    const task: TaskRegistration = {
      task_id: taskId,
      repository_id: repositoryId,
      binding_epoch: typeof live.binding_epoch === 'number' ? live.binding_epoch : 1,
      phase_epoch: typeof live.phase_epoch === 'number' ? live.phase_epoch : 1,
      phase: live.phase ?? 'coding',
      allow_detached: live.allow_detached,
      completed: !!live.completion,
      created_at: at,
      updated_at: at
    };
    catalog = await writeCatalog(store, { ...catalog, tasks: { ...catalog.tasks, [taskId]: task } });
    return { task, catalog_revision: catalog.revision, unchanged: false };
  });
}

export async function setRegisteredTaskPhase(options: { stateDir?: string; taskId: string; phase: Phase }) {
  const stateDir = options.stateDir ?? defaultStateDir();
  const taskId = assertId(options.taskId, 'task ID');
  const before = await readMultiRepoCatalog(stateDir);
  const beforeTask = before.tasks[taskId];
  if (!beforeTask) throw new SafeError(`Task ${taskId} is not registered in the multi-repository catalog.`);
  if (beforeTask.completed) throw new SafeError(`Task ${taskId} is already draining/completed and cannot change phase.`);

  // The task gate drains mutations/checks without holding the service-wide catalog lock.
  await setTaskPhase(stateDir, taskId, options.phase);

  return withControlLock(stateDir, `publish task ${taskId} phase ${options.phase}`, async store => {
    let catalog = await readCatalogStore(store);
    const registered = catalog.tasks[taskId];
    if (!registered) throw new SafeError(`Task ${taskId} is no longer registered in the multi-repository catalog.`);
    if (registered.completed) throw new SafeError(`Task ${taskId} became draining/completed while the phase transition was publishing; no active task authority remains.`);
    const repository = catalog.repositories[registered.repository_id];
    if (!repository || !repository.enabled) throw new SafeError('Registered repository was disabled while the phase transition was publishing.');
    const live = await taskStatus(stateDir, taskId, { readOnly: true });
    if (live.root !== repository.root || live.git_dir !== repository.git_dir || live.common_dir !== repository.common_dir || live.policy_digest !== repository.policy_digest) {
      throw new SafeError('Task binding changed while the phase transition was publishing; reconcile the task and retry.');
    }
    const task: TaskRegistration = {
      ...registered,
      binding_epoch: live.binding_epoch,
      phase_epoch: live.phase_epoch,
      phase: live.phase,
      completed: !!live.completion,
      updated_at: nowIso()
    };
    const unchanged = task.binding_epoch === registered.binding_epoch && task.phase_epoch === registered.phase_epoch &&
      task.phase === registered.phase && task.completed === registered.completed;
    if (unchanged) return { task: registered, catalog_revision: catalog.revision, unchanged: true };
    catalog = await writeCatalog(store, { ...catalog, tasks: { ...catalog.tasks, [taskId]: task } });
    return { task, catalog_revision: catalog.revision, unchanged: false };
  });
}

export async function rebindRegisteredTask(options: { stateDir?: string; taskId: string; allowDetached?: boolean }) {
  const stateDir = options.stateDir ?? defaultStateDir();
  const taskId = assertId(options.taskId, 'task ID');
  const before = await readMultiRepoCatalog(stateDir);
  const beforeTask = before.tasks[taskId];
  if (!beforeTask) throw new SafeError(`Task ${taskId} is not registered in the multi-repository catalog.`);
  if (beforeTask.completed) throw new SafeError(`Task ${taskId} is already draining/completed and cannot be rebound.`);
  const beforeRepository = before.repositories[beforeTask.repository_id];
  if (!beforeRepository || !beforeRepository.enabled) throw new SafeError('Registered repository is disabled or missing.');
  await verifyRepositoryLive(beforeRepository);

  // Rebind owns the task gate itself. Publish the resulting epoch afterward so the
  // service-wide catalog lock is never held while repository work drains.
  await rebindTask(stateDir, taskId, beforeRepository.root, {
    policyDigest: beforeRepository.policy_digest,
    allowDetached: options.allowDetached
  });

  return withControlLock(stateDir, `publish task ${taskId} rebind`, async store => {
    let catalog = await readCatalogStore(store);
    const registered = catalog.tasks[taskId];
    if (!registered || registered.repository_id !== beforeTask.repository_id) {
      throw new SafeError(`Task ${taskId} catalog ownership changed while the rebind was publishing; operator reconciliation is required.`);
    }
    if (registered.completed) throw new SafeError(`Task ${taskId} became draining/completed while the rebind was publishing; no active task authority remains.`);
    const repository = catalog.repositories[registered.repository_id];
    if (!repository || !repository.enabled) throw new SafeError('Registered repository was disabled while the rebind was publishing.');
    const live = await taskStatus(stateDir, taskId, { readOnly: true });
    if (live.root !== repository.root || live.git_dir !== repository.git_dir || live.common_dir !== repository.common_dir || live.policy_digest !== repository.policy_digest) {
      throw new SafeError('Repository authorization changed while the rebind was publishing; rerun task rebind against the current registration.');
    }
    const task: TaskRegistration = {
      ...registered,
      binding_epoch: live.binding_epoch,
      phase_epoch: live.phase_epoch,
      phase: live.phase,
      allow_detached: live.allow_detached,
      completed: !!live.completion,
      updated_at: nowIso()
    };
    catalog = await writeCatalog(store, { ...catalog, tasks: { ...catalog.tasks, [taskId]: task } });
    return { task, catalog_revision: catalog.revision };
  });
}

export async function finishRegisteredTask(options: { stateDir?: string; taskId: string; result: 'abandoned' | 'committed'; commitSha?: string }) {
  const stateDir = options.stateDir ?? defaultStateDir();
  const taskId = assertId(options.taskId, 'task ID');
  if (options.result === 'committed') throw new SafeError('Verified commit completion remains unavailable through the multi-repository coordinator; commit/push stay outside MCP.');

  const markDraining = () => withControlLock(stateDir, `drain task ${taskId}`, async store => {
    let catalog = await readCatalogStore(store);
    const registered = catalog.tasks[taskId];
    if (!registered) throw new SafeError(`Task ${taskId} is not registered in the multi-repository catalog.`);
    if (registered.completed) return { task: registered, catalog_revision: catalog.revision };
    const task: TaskRegistration = { ...registered, completed: true, updated_at: nowIso() };
    catalog = await writeCatalog(store, { ...catalog, tasks: { ...catalog.tasks, [taskId]: task } });
    return { task, catalog_revision: catalog.revision };
  });

  // Completion authority is published only after every admitted mutation/check
  // has drained. If another finisher already published the terminal marker, the
  // task gate is no longer needed and the catalog is reconciled idempotently.
  const liveBefore = await taskStatus(stateDir, taskId, { readOnly: true });
  let draining;
  if (liveBefore.completion) {
    draining = await markDraining();
  } else {
    try {
      draining = await withTaskCoordinatorGate(stateDir, taskId, markDraining);
    } catch (error) {
      const liveAfter = await taskStatus(stateDir, taskId, { readOnly: true });
      if (!liveAfter.completion) throw error;
      draining = await markDraining();
    }
  }

  let writer = await taskWriterLockStatus(stateDir, taskId);
  for (let i = 0; writer.state === 'live' && i < 240; i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    writer = await taskWriterLockStatus(stateDir, taskId);
  }
  if (writer.state !== 'absent') {
    const owner = writer.state === 'live' ? `live in process ${writer.pid}` : `stale from exited process ${writer.pid}`;
    throw new SafeError(`Task ${taskId} is marked draining but its checkout writer lock is ${owner}; no completion was published. Let the permanent broker drain, or recover a stale lock explicitly, then retry finish.`);
  }
  const completion = await completeTask(stateDir, taskId, { result: 'abandoned' });
  return { ...draining, completion };
}

export async function listRegisteredRepositories(stateDir = defaultStateDir()) {
  const catalog = await readMultiRepoCatalog(stateDir);
  return {
    catalog_revision: catalog.revision,
    repositories: Object.values(catalog.repositories).map(repository => ({
      repository_id: repository.repository_id,
      name: repository.name,
      enabled: repository.enabled,
      registration_epoch: repository.registration_epoch,
      policy_digest: repository.policy_digest,
      tasks: Object.values(catalog.tasks).filter(t => t.repository_id === repository.repository_id).map(t => ({
        task_id: t.task_id,
        phase: t.phase,
        binding_epoch: t.binding_epoch,
        phase_epoch: t.phase_epoch,
        completed: t.completed
      }))
    }))
  };
}

/** Local coordinator lookup for agent workflows. Never exposed through MCP. */
export async function resolveRegisteredRepository(root: string, stateDir = defaultStateDir()) {
  const canonicalRoot = await realpath(root).catch(() => undefined);
  if (!canonicalRoot) throw new SafeError('Repository checkout does not exist or cannot be resolved.');
  const catalog = await readMultiRepoCatalog(stateDir);
  const repository = Object.values(catalog.repositories).find(candidate => candidate.root === canonicalRoot);
  if (!repository) return { catalog_revision: catalog.revision, repository: null };
  return {
    catalog_revision: catalog.revision,
    repository: {
      repository_id: repository.repository_id,
      name: repository.name,
      enabled: repository.enabled,
      registration_epoch: repository.registration_epoch,
      policy_digest: repository.policy_digest,
      tasks: Object.values(catalog.tasks).filter(task => task.repository_id === repository.repository_id).map(task => ({
        task_id: task.task_id,
        phase: task.phase,
        binding_epoch: task.binding_epoch,
        phase_epoch: task.phase_epoch,
        completed: task.completed
      }))
    }
  };
}

export async function issueWorkspaceGrant(options: { stateDir?: string; taskId: string; ttlMs?: number }) {
  const stateDir = options.stateDir ?? defaultStateDir();
  const taskId = assertId(options.taskId, 'task ID');
  const ttlMs = options.ttlMs ?? GRANT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60 * 60_000) throw new SafeError('Grant TTL must be between 1 second and 1 hour.');
  return withControlLock(stateDir, `grant workspace for task ${taskId}`, async store => {
    const catalog = await readCatalogStore(store);
    const task = catalog.tasks[taskId];
    if (!task || task.completed) throw new SafeError(`Task ${taskId} is not an active registered task.`);
    const repository = catalog.repositories[task.repository_id];
    if (!repository || !repository.enabled) throw new SafeError('Registered repository is disabled or missing.');
    const live = await taskStatus(stateDir, taskId);
    taskFromLive(task, live);
    if (live.root !== repository.root || live.git_dir !== repository.git_dir || live.common_dir !== repository.common_dir || live.policy_digest !== repository.policy_digest) {
      throw new SafeError('Write grant refused because the registered repository/task binding is stale; rebind the task first.');
    }
    if (live.phase !== 'coding') throw new SafeError('Write grants can be issued only while the task is in coding phase.');
    const auth = await readAuthStore(store);
    if (Object.keys(auth.grants).length + Object.keys(auth.workspaces).length + Object.keys(auth.requests).length >= MAX_AUTH_RECORDS) {
      throw new SafeError('Workspace authorization state reached its retention limit; revoke/expire old selections before issuing more grants.');
    }
    const grant: WorkspaceGrant = {
      grant_id: randomBytes(16).toString('hex'),
      repository_id: repository.repository_id,
      task_id: taskId,
      registration_epoch: repository.registration_epoch,
      binding_epoch: task.binding_epoch,
      phase_epoch: task.phase_epoch,
      policy_digest: repository.policy_digest,
      issued_at: nowIso(),
      expires_at: futureIso(ttlMs),
      status: 'open'
    };
    auth.grants[grant.grant_id] = grant;
    await writeAuth(store, auth);
    return { grant_id: grant.grant_id, write_grant: await grantToken(store, grant), expires_at: grant.expires_at, repository_id: grant.repository_id, task_id: taskId };
  });
}

function openCapabilities(mode: WorkspaceMode): WorkspaceCapability[] {
  return mode === 'code' ? ['read', 'write', 'check'] : ['read'];
}

export async function openWorkspace(options: {
  stateDir?: string;
  repositoryId: string;
  taskId: string;
  mode: WorkspaceMode;
  requestId: string;
  writeGrant?: string;
  ttlMs?: number;
}) {
  const stateDir = options.stateDir ?? defaultStateDir();
  const repositoryId = assertId(options.repositoryId, 'repository ID');
  const taskId = assertId(options.taskId, 'task ID');
  const ttlMs = options.ttlMs ?? WORKSPACE_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 60 * 60_000) throw new SafeError('Workspace TTL must be between 1 minute and 24 hours.');
  return withControlLock(stateDir, `open ${options.mode} workspace for ${taskId}`, async store => {
    const catalog = await readCatalogStore(store);
    const repository = catalog.repositories[repositoryId];
    const task = catalog.tasks[taskId];
    if (!repository || !repository.enabled || !task || task.repository_id !== repositoryId || task.completed) throw new SafeError('Requested repository/task is not an enabled active catalog selection.');
    await verifyRepositoryLive(repository);
    const live = await taskStatus(stateDir, taskId);
    taskFromLive(task, live);
    if (live.root !== repository.root || live.git_dir !== repository.git_dir || live.common_dir !== repository.common_dir || live.policy_digest !== repository.policy_digest) {
      throw new SafeError('Registered repository/task identity is stale; operator reconciliation is required.');
    }
    if (options.mode === 'code' && live.phase !== 'coding') throw new SafeError('Coding workspace requires the task to be in coding phase.');
    if (options.mode === 'review' && live.phase !== 'review') throw new SafeError('Review workspace requires the task to be frozen in review phase.');
    const auth = await readAuthStore(store);
    const requestKeyValue = requestKey('workspace_open', options.requestId);
    const argsDigest = requestDigest('workspace_open', [repositoryId, taskId, options.mode, options.writeGrant ? sha256(options.writeGrant) : null, ttlMs]);
    const prior = auth.requests[requestKeyValue];
    if (prior) {
      if (prior.operation !== 'workspace_open' || prior.args_digest !== argsDigest) throw new SafeError('request_id was already used with different workspace arguments.');
      const selection = auth.workspaces[prior.workspace_id];
      if (!selection) throw new SafeError('Previous workspace_open outcome is missing; operator inspection is required.');
      if (selection.status !== 'open' || Date.now() >= Date.parse(selection.expires_at)) throw new SafeError('Previous workspace_open selection is no longer active; use a new request_id.');
      return { workspace_token: await workspaceToken(store, selection), selection, scope: scopeFor(selection, live), already_applied: true };
    }
    if (Object.keys(auth.grants).length + Object.keys(auth.workspaces).length + Object.keys(auth.requests).length >= MAX_AUTH_RECORDS) throw new SafeError('Workspace authorization state reached its retention limit.');
    let grant: WorkspaceGrant | undefined;
    if (options.mode === 'code') {
      if (!options.writeGrant) throw new SafeError('Coding workspace requires an operator-issued write_grant.');
      grant = await verifyGrantToken(store, auth, options.writeGrant);
      if (grant.status !== 'open') throw new SafeError('write_grant was already consumed or revoked.');
      if (Date.now() >= Date.parse(grant.expires_at)) throw new SafeError('write_grant expired; request a new operator grant.');
      if (grant.repository_id !== repositoryId || grant.task_id !== taskId ||
          grant.registration_epoch !== repository.registration_epoch || grant.binding_epoch !== task.binding_epoch ||
          grant.phase_epoch !== task.phase_epoch || grant.policy_digest !== repository.policy_digest) {
        throw new SafeError('write_grant does not match the current repository/task authorization.');
      }
      const otherWriter = Object.values(auth.workspaces).find(w =>
        w.task_id === taskId && w.mode === 'code' && w.status === 'open' && Date.now() < Date.parse(w.expires_at) &&
        w.registration_epoch === repository.registration_epoch && w.binding_epoch === task.binding_epoch &&
        w.phase_epoch === task.phase_epoch && w.policy_digest === repository.policy_digest
      );
      if (otherWriter) throw new SafeError(`Task ${taskId} already has an open coding workspace; close or revoke it before opening another writer.`);
    }
    const selection: WorkspaceSelection = {
      workspace_id: randomBytes(16).toString('hex'),
      repository_id: repositoryId,
      task_id: taskId,
      mode: options.mode,
      capabilities: openCapabilities(options.mode),
      registration_epoch: repository.registration_epoch,
      binding_epoch: task.binding_epoch,
      phase_epoch: task.phase_epoch,
      policy_digest: repository.policy_digest,
      issued_at: nowIso(),
      expires_at: futureIso(ttlMs),
      status: 'open'
    };
    auth.workspaces[selection.workspace_id] = selection;
    if (grant) auth.grants[grant.grant_id] = { ...grant, status: 'consumed', consumed_by: selection.workspace_id };
    auth.requests[requestKeyValue] = { operation: 'workspace_open', args_digest: argsDigest, workspace_id: selection.workspace_id, at: nowIso() };
    await writeAuth(store, auth);
    return { workspace_token: await workspaceToken(store, selection), selection, scope: scopeFor(selection, live), already_applied: false };
  });
}

function scopeFor(selection: WorkspaceSelection, live: Awaited<ReturnType<typeof taskStatus>>) {
  return {
    workspace_id: selection.workspace_id,
    repository_id: selection.repository_id,
    task_id: selection.task_id,
    registration_epoch: selection.registration_epoch,
    binding_epoch: selection.binding_epoch,
    phase_epoch: selection.phase_epoch,
    policy_digest: selection.policy_digest,
    phase: (live.phase ?? 'coding') as Phase,
    mode: selection.mode
  };
}

export async function authorizeWorkspace(stateDir: string, token: string, capability: WorkspaceCapability): Promise<AuthorizedWorkspace> {
  const store = await StateStore.inspect(stateDir);
  if (!store) throw new SafeError('Repo MCP multi-repository state is not initialized.');
  const auth = await readAuthStore(store);
  const selection = await selectionFromToken(store, auth, token);
  if (!selection.capabilities.includes(capability)) throw new SafeError(`Workspace mode ${selection.mode} does not grant ${capability} capability.`);
  const catalog = await readCatalogStore(store);
  const repository = catalog.repositories[selection.repository_id];
  const task = catalog.tasks[selection.task_id];
  if (!repository || !repository.enabled || !task || task.repository_id !== repository.repository_id || task.completed) throw new SafeError('Workspace repository/task is no longer active.');
  if (repository.registration_epoch !== selection.registration_epoch || repository.policy_digest !== selection.policy_digest || task.binding_epoch !== selection.binding_epoch || task.phase_epoch !== selection.phase_epoch) {
    throw new SafeError('Workspace selection is stale because repository/task authorization changed. Open a new workspace.');
  }
  const live = await taskStatus(stateDir, task.task_id);
  taskFromLive(task, live);
  if (live.root !== repository.root || live.git_dir !== repository.git_dir || live.common_dir !== repository.common_dir || live.policy_digest !== repository.policy_digest) {
    throw new SafeError('Workspace repository/task identity no longer matches the registered checkout.');
  }
  if (selection.mode === 'code' && live.phase !== 'coding') throw new SafeError('Coding workspace is no longer valid because the task phase changed. Open a new workspace after coordinator reconciliation.');
  if (selection.mode === 'review' && live.phase !== 'review') throw new SafeError('Review workspace is no longer valid because the task phase changed. Open a new workspace.');
  return { selection, repository, task, live_task: live, scope: scopeFor(selection, live) };
}

export async function withWorkspaceAdmission<T>(stateDir: string, token: string, capability: WorkspaceCapability, fn: (authorized: AuthorizedWorkspace) => Promise<T>) {
  const parts = tokenParts(token, 'ws1');
  const store = await StateStore.open(stateDir);
  return withShortLock(store, admissionKey(parts.id), async () => {
    const authorized = await authorizeWorkspace(stateDir, token, capability);
    return fn(authorized);
  }, { waitMs: WORKSPACE_DRAIN_WAIT_MS, purpose: `workspace ${parts.id} ${capability}` });
}

export async function closeWorkspace(options: { stateDir?: string; workspaceToken: string; requestId: string }) {
  const stateDir = options.stateDir ?? defaultStateDir();
  const parts = tokenParts(options.workspaceToken, 'ws1');
  const store = await StateStore.open(stateDir);
  return withShortLock(store, admissionKey(parts.id), () =>
    withControlLock(stateDir, `close workspace ${parts.id}`, async controlStore => {
      const auth = await readAuthStore(controlStore);
      const selection = await selectionFromToken(controlStore, auth, options.workspaceToken, true);
      const key = requestKey(`workspace_close:${selection.workspace_id}`, options.requestId);
      const digest = requestDigest('workspace_close', [selection.workspace_id]);
      const prior = auth.requests[key];
      if (prior) {
        if (prior.operation !== 'workspace_close' || prior.args_digest !== digest || prior.workspace_id !== selection.workspace_id) throw new SafeError('request_id was already used with different workspace arguments.');
        return { workspace_id: selection.workspace_id, status: auth.workspaces[selection.workspace_id]?.status ?? selection.status, already_applied: true };
      }
      const next = { ...selection, status: 'closed' as const };
      auth.workspaces[selection.workspace_id] = next;
      auth.requests[key] = { operation: 'workspace_close', args_digest: digest, workspace_id: selection.workspace_id, at: nowIso() };
      await writeAuth(controlStore, auth);
      return { workspace_id: selection.workspace_id, status: next.status, already_applied: false };
    }),
  { waitMs: WORKSPACE_DRAIN_WAIT_MS, purpose: `close workspace ${parts.id}` });
}

export async function revokeWorkspace(options: { stateDir?: string; workspaceId: string }) {
  const stateDir = options.stateDir ?? defaultStateDir();
  if (!HEX32.test(options.workspaceId)) throw new SafeError('Invalid workspace ID.');
  const store = await StateStore.open(stateDir);
  return withShortLock(store, admissionKey(options.workspaceId), () =>
    withControlLock(stateDir, `revoke workspace ${options.workspaceId}`, async controlStore => {
      const auth = await readAuthStore(controlStore);
      const selection = auth.workspaces[options.workspaceId];
      if (!selection) throw new SafeError('Workspace selection is unknown.');
      if (selection.status === 'revoked') return { workspace_id: selection.workspace_id, status: 'revoked', unchanged: true };
      auth.workspaces[selection.workspace_id] = { ...selection, status: 'revoked' };
      await writeAuth(controlStore, auth);
      return { workspace_id: selection.workspace_id, status: 'revoked', unchanged: false };
    }),
  { waitMs: WORKSPACE_DRAIN_WAIT_MS, purpose: `revoke workspace ${options.workspaceId}` });
}

export async function revokeGrant(options: { stateDir?: string; grantId: string }) {
  const stateDir = options.stateDir ?? defaultStateDir();
  if (!HEX32.test(options.grantId)) throw new SafeError('Invalid grant ID.');
  return withControlLock(stateDir, `revoke grant ${options.grantId}`, async store => {
    const auth = await readAuthStore(store);
    const grant = auth.grants[options.grantId];
    if (!grant) throw new SafeError('Workspace grant is unknown.');
    if (grant.status === 'consumed') throw new SafeError('Consumed write_grant cannot be revoked; revoke its workspace selection instead.');
    if (grant.status === 'revoked') return { grant_id: grant.grant_id, status: grant.status, unchanged: true };
    auth.grants[grant.grant_id] = { ...grant, status: 'revoked' };
    await writeAuth(store, auth);
    return { grant_id: grant.grant_id, status: 'revoked', unchanged: false };
  });
}

export async function getRuntimeMaterial(stateDir: string, authorized: AuthorizedWorkspace) {
  const store = await StateStore.inspect(stateDir);
  if (!store) throw new SafeError('Repo MCP multi-repository state is not initialized.');
  const policy = await loadPolicySnapshot(store, authorized.repository);
  return {
    root: authorized.repository.root,
    policy,
    policy_digest: authorized.repository.policy_digest,
    audit_path: path.join(stateDir, 'audit', `${authorized.task.task_id}.jsonl`),
    task: { stateDir, taskId: authorized.task.task_id, allowDetached: authorized.task.allow_detached },
    protected_paths: [stateDir]
  };
}

export function internalMutationRequestId(workspaceId: string, requestId: string) {
  if (!HEX32.test(workspaceId)) throw new SafeError('Invalid workspace ID.');
  validateRequestId(requestId);
  return `ws-${workspaceId}-${sha256(requestId)}`;
}

export async function wrapWorkspaceCursor(stateDir: string, workspaceId: string, kind: string, inner: string | null | undefined) {
  if (!inner) return inner ?? null;
  if (!HEX32.test(workspaceId) || !/^[A-Za-z0-9_-]{1,32}$/.test(kind)) throw new SafeError('Invalid workspace cursor binding.');
  const store = await StateStore.inspect(stateDir);
  if (!store) throw new SafeError('Repo MCP multi-repository state is not initialized.');
  const key = await tokenKey(store);
  const payload = Buffer.from(inner, 'utf8').toString('base64url');
  const mac = hmac(key.secret, 'cursor', JSON.stringify([workspaceId, kind, payload]));
  return `wc1.${key.key_id}.${workspaceId}.${kind}.${payload}.${mac}`;
}

export async function unwrapWorkspaceCursor(stateDir: string, workspaceId: string, kind: string, cursor: string | undefined) {
  if (!cursor) return undefined;
  const parts = cursor.split('.');
  if (parts.length !== 6 || parts[0] !== 'wc1' || !HEX32.test(parts[2]) || !/^[A-Za-z0-9_-]{1,32}$/.test(parts[3]) || !/^[A-Za-z0-9_-]+$/.test(parts[4]) || !/^[A-Za-z0-9_-]{43,64}$/.test(parts[5])) {
    throw new SafeError('Invalid workspace cursor. Start again without a cursor.');
  }
  if (parts[2] !== workspaceId || parts[3] !== kind) throw new SafeError('Cursor belongs to a different workspace or tool. Start again without a cursor.');
  const store = await StateStore.inspect(stateDir);
  if (!store) throw new SafeError('Repo MCP multi-repository state is not initialized.');
  const key = await tokenKey(store);
  if (parts[1] !== key.key_id || !safeEqual(parts[5], hmac(key.secret, 'cursor', JSON.stringify([workspaceId, kind, parts[4]])))) {
    throw new SafeError('Invalid workspace cursor. Start again without a cursor.');
  }
  let inner: string;
  try { inner = Buffer.from(parts[4], 'base64url').toString('utf8'); } catch { throw new SafeError('Invalid workspace cursor. Start again without a cursor.'); }
  if (!inner || inner.length > 4096) throw new SafeError('Invalid workspace cursor. Start again without a cursor.');
  return inner;
}

export async function migrateActiveServiceToCatalog(options: { stateDir?: string; repositoryId: string; name?: string }) {
  const stateDir = options.stateDir ?? defaultStateDir();
  const repositoryId = assertId(options.repositoryId, 'repository ID');
  if (options.name !== undefined && !options.name.trim()) throw new SafeError('Repository name must contain at least one non-whitespace character.');
  return withControlLock(stateDir, `migrate active service to repository ${repositoryId}`, async store => {
    let catalog = await readCatalogStore(store);
    if (catalog.migration) {
      if (catalog.migration.repository_id !== repositoryId) throw new SafeError(`Active-service migration is already recorded as repository ${catalog.migration.repository_id}.`);
      return { migration: catalog.migration, catalog_revision: catalog.revision, unchanged: true };
    }
    if (catalog.repositories[repositoryId]) {
      throw new SafeError(`Repository ID ${repositoryId} is already registered; active-service migration will not overwrite catalog state.`);
    }
    const active = await readActiveService(store);
    if (!active) throw new SafeError('No current active-service record exists to migrate.');
    if (catalog.tasks[active.task_id]) {
      throw new SafeError(`Task ID ${active.task_id} is already registered; active-service migration will not overwrite catalog state.`);
    }
    const root = await realpath(active.root);
    const policyPath = await realpath(active.policy_path);
    if (root !== active.root || rootDigest(root) !== active.root_digest) throw new SafeError('Active-service root no longer matches its canonical identity.');
    if (within(policyPath, root)) throw new SafeError('Legacy active-service policy is inside the served repository; migration refuses to preserve that unsafe placement.');
    const policy = loadPolicy(JSON.parse(await readFile(policyPath, 'utf8')));
    if (policyDigest(policy) !== active.policy_digest) throw new SafeError('Active-service policy digest changed; reconcile before migration.');
    const identity = await resolveIdentity(root);
    const live = await taskStatus(stateDir, active.task_id);
    if (live.completion) throw new SafeError('Active-service task is already completed; do not migrate it as an active workspace.');
    if (identity.root !== live.root || identity.git_dir !== live.git_dir || identity.common_dir !== live.common_dir || identity.branch !== live.branch || identity.head !== live.head || live.policy_digest !== active.policy_digest) {
      throw new SafeError('Active-service task binding no longer matches the live checkout.');
    }
    for (const other of Object.values(catalog.repositories)) {
      if (within(policyPath, other.root)) throw new SafeError(`Legacy policy source is inside registered repository ${other.repository_id}; migration refuses that cross-repository policy placement.`);
      if (within(other.policy_source, root)) throw new SafeError(`Legacy repository root would contain the operator policy source for registered repository ${other.repository_id}; migration refuses that placement.`);
      if (within(root, other.root) || within(other.root, root)) throw new SafeError(`Legacy root overlaps already registered repository ${other.repository_id}.`);
    }
    const policyRef = `policies/${active.policy_digest}.json`;
    const existingPolicy = await store.read<unknown>(policyRef, 'repository-policy');
    if (existingPolicy === undefined) await store.create(policyRef, 'repository-policy', policy);
    else if (policyDigest(loadPolicy(existingPolicy)) !== active.policy_digest) throw new SafeError('Existing migrated policy snapshot is corrupt.');
    const at = nowIso();
    const repository: RepositoryRegistration = {
      repository_id: repositoryId,
      name: options.name ?? repositoryId,
      root,
      root_digest: active.root_digest,
      git_dir: identity.git_dir,
      common_dir: identity.common_dir,
      policy_source: policyPath,
      policy_ref: policyRef,
      policy_digest: active.policy_digest,
      registration_epoch: 1,
      enabled: true,
      created_at: at,
      updated_at: at
    };
    const task: TaskRegistration = {
      task_id: active.task_id,
      repository_id: repositoryId,
      binding_epoch: typeof live.binding_epoch === 'number' ? live.binding_epoch : 1,
      phase_epoch: typeof live.phase_epoch === 'number' ? live.phase_epoch : 1,
      phase: live.phase ?? 'coding',
      allow_detached: live.allow_detached,
      completed: false,
      created_at: at,
      updated_at: at
    };
    const migration: NonNullable<MultiRepoCatalog['migration']> = {
      source: 'active-service-v1',
      migrated_at: at,
      active_generation: active.generation,
      repository_id: repositoryId,
      task_id: active.task_id
    };
    catalog = await writeCatalog(store, {
      ...catalog,
      service: { port: active.port, configured_at: at },
      repositories: { ...catalog.repositories, [repositoryId]: repository },
      tasks: { ...catalog.tasks, [active.task_id]: task },
      migration
    });
    return { migration, repository, task, catalog_revision: catalog.revision, unchanged: false };
  });
}

export async function rollbackActiveServiceCatalogMigration(options: { stateDir?: string } = {}) {
  const stateDir = options.stateDir ?? defaultStateDir();
  return withControlLock(stateDir, 'rollback active-service catalog migration', async store => {
    const catalog = await readCatalogStore(store);
    const migration = catalog.migration;
    if (!migration) throw new SafeError('No active-service catalog migration is recorded.');
    const auth = await readAuthStore(store);
    if (Object.keys(auth.grants).length || Object.keys(auth.workspaces).length || Object.keys(auth.requests).length) {
      throw new SafeError('Migration rollback is refused after any grant, workspace selection or workspace request was published.');
    }
    if (Object.keys(catalog.repositories).length !== 1 || Object.keys(catalog.tasks).length !== 1 ||
        !catalog.repositories[migration.repository_id] || !catalog.tasks[migration.task_id]) {
      throw new SafeError('Migration rollback is refused after additional repository or task catalog state was published.');
    }
    const active = await readActiveService(store);
    const repository = catalog.repositories[migration.repository_id];
    const task = catalog.tasks[migration.task_id];
    if (!active || active.generation !== migration.active_generation || active.task_id !== migration.task_id ||
        active.root !== repository.root || active.root_digest !== repository.root_digest ||
        active.policy_digest !== repository.policy_digest || task.repository_id !== repository.repository_id) {
      throw new SafeError('Legacy active-service state no longer matches the migrated generation/catalog; rollback is unsafe.');
    }
    const live = await taskStatus(stateDir, migration.task_id);
    taskFromLive(task, live);
    const identity = await resolveIdentity(repository.root);
    if (live.completion || live.root !== repository.root || live.git_dir !== repository.git_dir || live.common_dir !== repository.common_dir ||
        live.branch !== identity.branch || live.head !== identity.head || live.policy_digest !== repository.policy_digest) {
      throw new SafeError('Legacy task state changed incompatibly after migration; rollback is unsafe.');
    }
    // Remove the initialization marker first while the authoritative catalog still
    // exists. If catalog removal then fails, rollback remains retryable; only a
    // successful catalog removal returns the installation to the unused state.
    await store.remove(INITIALIZED_PATH);
    await store.remove(CATALOG_PATH);
    return {
      rolled_back: true,
      source: migration.source,
      repository_id: migration.repository_id,
      task_id: migration.task_id,
      note: 'Multi-repository catalog/initialization state only was rolled back. Installed binaries/services are not changed by this command.'
    };
  });
}
