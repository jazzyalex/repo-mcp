import { createServer } from 'node:http';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { auditedEdit } from './audit.js';
import { DEFAULT_LIMITS } from './limits.js';
import { compilePolicyFor, policyDigest } from './policy.js';
import { RepoWorkspace, SafeError } from './repo.js';
import { StateStore } from './task-state.js';
import { RELEASE_VERSION } from './version.js';
import {
  authorizeWorkspace,
  closeWorkspace,
  getMultiRepoServiceConfig,
  getRuntimeMaterial,
  internalMutationRequestId,
  listRegisteredRepositories,
  openWorkspace,
  readMultiRepoCatalog,
  unwrapWorkspaceCursor,
  withWorkspaceAdmission,
  wrapWorkspaceCursor,
  type AuthorizedWorkspace,
  type WorkspaceCapability
} from './multirepo-state.js';

const BROKER_RESPONSE_RESERVE = 4 * 1024;

type RuntimeSlot = {
  repo: RepoWorkspace;
  task_id: string;
  root: string;
  policy_digest: string;
  binding_epoch: number;
  active: number;
  closing: boolean;
  idle_waiters: Set<() => void>;
};

export type RuntimeManagerHooks = {
  /** Test seam: runs after outer authorization and before a repository mutation/check asks for the task gate. */
  beforeOperation?: (taskId: string, capability: WorkspaceCapability) => void | Promise<void>;
  /** Test seam: holds task-slot serialization after runtime creation but before the first lease is exposed. */
  afterCreateBeforeLease?: (taskId: string) => void | Promise<void>;
  /** Test seam: holds task-slot serialization after a slot is marked closing but before RepoWorkspace.close(). */
  beforeClose?: (taskId: string) => void | Promise<void>;
};

export type RuntimeManagerOptions = {
  reconcileIntervalMs?: number;
  hooks?: RuntimeManagerHooks;
};

export class RuntimeManager {
  private readonly slots = new Map<string, RuntimeSlot>();
  private readonly taskSerial = new Map<string, Promise<void>>();
  private readonly reconcileTimer?: NodeJS.Timeout;
  private readonly hooks: RuntimeManagerHooks;
  private shuttingDown = false;

  constructor(private readonly stateDir: string, options: RuntimeManagerOptions = {}) {
    this.hooks = options.hooks ?? {};
    const interval = options.reconcileIntervalMs ?? 500;
    if (interval > 0) {
      this.reconcileTimer = setInterval(() => { void this.reconcileNow().catch(() => {}); }, interval);
      this.reconcileTimer.unref();
    }
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

  private same(slot: RuntimeSlot, authorized: AuthorizedWorkspace) {
    return !slot.closing &&
      slot.root === authorized.repository.root &&
      slot.policy_digest === authorized.repository.policy_digest &&
      slot.binding_epoch === authorized.task.binding_epoch;
  }

  private waitForIdle(slot: RuntimeSlot) {
    if (!slot.active) return Promise.resolve();
    return new Promise<void>(resolve => slot.idle_waiters.add(resolve));
  }

  private releaseIdleWaiters(slot: RuntimeSlot) {
    if (slot.active) return;
    for (const resolve of slot.idle_waiters) resolve();
    slot.idle_waiters.clear();
  }

  private async closeSlotLocked(taskId: string, slot: RuntimeSlot) {
    if (slot.closing) return;
    slot.closing = true;
    try {
      await this.hooks.beforeClose?.(taskId);
      await slot.repo.close();
      if (this.slots.get(taskId) === slot) this.slots.delete(taskId);
    } catch (error) {
      slot.closing = false;
      throw error;
    }
  }

  async reconcileNow() {
    const catalog = await readMultiRepoCatalog(this.stateDir);
    const taskIds = [...this.slots.keys()];
    await Promise.all(taskIds.map(taskId => this.serialized(taskId, async () => {
      const slot = this.slots.get(taskId);
      if (!slot) return;
      const task = catalog.tasks[taskId];
      const repository = task ? catalog.repositories[task.repository_id] : undefined;
      const stale = !task || task.completed || !repository || !repository.enabled ||
        task.binding_epoch !== slot.binding_epoch || repository.root !== slot.root || repository.policy_digest !== slot.policy_digest;
      if (!stale || slot.active || slot.closing) return;
      await this.closeSlotLocked(taskId, slot);
    })));
  }

  private async create(authorized: AuthorizedWorkspace) {
    const material = await getRuntimeMaterial(this.stateDir, authorized);
    if (policyDigest(material.policy) !== material.policy_digest) throw new SafeError('Registered policy snapshot no longer matches its catalog digest.');
    const compiled = await compilePolicyFor(material.policy, { root: material.root, protectedPaths: material.protected_paths });
    if (material.policy.limits.page_bytes <= BROKER_RESPONSE_RESERVE) {
      throw new SafeError(`Policy page_bytes (${material.policy.limits.page_bytes}) is too small for the multi-repository workspace envelope; use more than ${BROKER_RESPONSE_RESERVE} bytes.`);
    }
    const repo = await RepoWorkspace.create(material.root, compiled, {
      limits: { ...material.policy.limits, page_bytes: material.policy.limits.page_bytes - BROKER_RESPONSE_RESERVE },
      task: { ...material.task, policyDigest: material.policy_digest }
    });
    return {
      repo,
      task_id: authorized.task.task_id,
      root: authorized.repository.root,
      policy_digest: authorized.repository.policy_digest,
      binding_epoch: authorized.task.binding_epoch,
      active: 0,
      closing: false,
      idle_waiters: new Set<() => void>()
    } satisfies RuntimeSlot;
  }

  private async lease(authorized: AuthorizedWorkspace) {
    const taskId = authorized.task.task_id;
    return this.serialized(taskId, async () => {
      if (this.shuttingDown) throw new SafeError('Repository runtime manager is shutting down.');
      const existing = this.slots.get(taskId);
      if (existing) {
        if (this.same(existing, authorized)) {
          existing.active++;
          return existing;
        }
        if (existing.active) throw new SafeError('Repository runtime is draining after a binding change; retry after active operations finish.');
        await this.closeSlotLocked(taskId, existing);
      }
      const created = await this.create(authorized);
      this.slots.set(taskId, created);
      try {
        await this.hooks.afterCreateBeforeLease?.(taskId);
        created.active++;
        return created;
      } catch (error) {
        await this.closeSlotLocked(taskId, created);
        throw error;
      }
    });
  }

  private async releaseLease(taskId: string, slot: RuntimeSlot) {
    await this.serialized(taskId, async () => {
      if (slot.active > 0) slot.active--;
      this.releaseIdleWaiters(slot);
    });
  }

  private async freshAuthorization(authorized: AuthorizedWorkspace, token: string, capability: WorkspaceCapability) {
    const fresh = await authorizeWorkspace(this.stateDir, token, capability);
    if (fresh.selection.workspace_id !== authorized.selection.workspace_id ||
        fresh.repository.registration_epoch !== authorized.repository.registration_epoch ||
        fresh.repository.policy_digest !== authorized.repository.policy_digest ||
        fresh.task.binding_epoch !== authorized.task.binding_epoch ||
        fresh.task.phase_epoch !== authorized.task.phase_epoch) {
      throw new SafeError('Workspace authorization changed while repository work was being admitted. Retry with a fresh workspace.');
    }
    return fresh;
  }

  async use<T>(
    authorized: AuthorizedWorkspace,
    token: string,
    capability: WorkspaceCapability,
    fn: (repo: RepoWorkspace, gatedPreflight: () => Promise<void>) => Promise<T>
  ) {
    const taskId = authorized.task.task_id;
    const slot = await this.lease(authorized);
    try {
      await this.freshAuthorization(authorized, token, capability);
      await this.hooks.beforeOperation?.(taskId, capability);
      const gatedPreflight = async () => { await this.freshAuthorization(authorized, token, capability); };
      return await fn(slot.repo, gatedPreflight);
    } finally {
      await this.releaseLease(taskId, slot);
    }
  }

  async close() {
    this.shuttingDown = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    while (this.taskSerial.size) {
      await Promise.allSettled([...this.taskSerial.values()]);
    }
    const initial = [...this.slots.values()];
    await Promise.all(initial.map(slot => this.waitForIdle(slot)));
    const taskIds = [...this.slots.keys()];
    await Promise.all(taskIds.map(taskId => this.serialized(taskId, async () => {
      const slot = this.slots.get(taskId);
      if (!slot) return;
      if (slot.active) throw new SafeError(`Repository runtime ${taskId} is still active during shutdown.`);
      await this.closeSlotLocked(taskId, slot);
    })));
  }
}

const requestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const workspaceToken = z.string().min(20).max(512).describe('Required immutable workspace capability returned by workspace_open. Old unscoped production calls are not accepted.');
const cursor = z.string().min(1).max(4096).optional();
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

function requirePayload(repo: RepoWorkspace, ...values: string[]) {
  for (const value of values) if (Buffer.byteLength(value, 'utf8') > repo.limits.payload_bytes) {
    throw new SafeError(`Payload exceeds this repository policy limit of ${repo.limits.payload_bytes} bytes.`);
  }
}

async function wrapResult(stateDir: string, authorized: AuthorizedWorkspace, kind: string, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { result: value, scope: authorized.scope };
  const result = { ...(value as Record<string, unknown>) };
  if (typeof result.next_cursor === 'string') result.next_cursor = await wrapWorkspaceCursor(stateDir, authorized.selection.workspace_id, kind, result.next_cursor);
  if (typeof result.status_next_cursor === 'string') result.status_next_cursor = await wrapWorkspaceCursor(stateDir, authorized.selection.workspace_id, 'repo-status', result.status_next_cursor);
  if (typeof result.files_next_cursor === 'string') result.files_next_cursor = await wrapWorkspaceCursor(stateDir, authorized.selection.workspace_id, 'repo-files', result.files_next_cursor);
  if (typeof result.instructions_next_cursor === 'string') result.instructions_next_cursor = await wrapWorkspaceCursor(stateDir, authorized.selection.workspace_id, 'read', result.instructions_next_cursor);
  return { ...result, scope: authorized.scope };
}

export type MultiRepoServerOptions = {
  runtimeHooks?: RuntimeManagerHooks;
  reconcileIntervalMs?: number;
};

export async function startMultiRepoServer(stateDir: string, port?: number, options: MultiRepoServerOptions = {}) {
  await StateStore.open(stateDir);
  const configured = await getMultiRepoServiceConfig(stateDir);
  const listenPort = port ?? configured.port;
  const runtimes = new RuntimeManager(stateDir, { hooks: options.runtimeHooks, reconcileIntervalMs: options.reconcileIntervalMs });
  const auditFile = path.join(stateDir, 'multirepo-audit.jsonl');
  const processAttestation = {
    ok: true as const,
    name: 'repo-mcp' as const,
    server_version: RELEASE_VERSION,
    service_mode: 'multirepo' as const,
    catalog_revision_at_start: configured.catalog_revision,
    process_pid: process.pid
  };

  const audit = async (tool: string, era: string, ok: boolean, authorized?: AuthorizedWorkspace, data?: unknown) => {
    const entry = {
      at: new Date().toISOString(),
      tool,
      era,
      ok,
      ...(authorized ? {
        workspace_id: authorized.selection.workspace_id,
        repository_id: authorized.repository.repository_id,
        task_id: authorized.task.task_id,
        binding_epoch: authorized.task.binding_epoch,
        phase_epoch: authorized.task.phase_epoch
      } : {}),
      ...(data ? { result: data } : {})
    };
    await appendFile(auditFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
  };

  const handler = createMcpHandler(({ era }) => {
    const server = new McpServer({ name: 'repo-mcp', version: RELEASE_VERSION }, {
      instructions: 'Install-once multi-repository Repo MCP service. Begin with service_info and repository_list, then workspace_open using only operator-registered repository_id/task_id values. Every repository tool requires the immutable workspace_token returned by workspace_open; there is no ambient or current repository and no filesystem root/policy path is accepted through MCP. Coding mode additionally requires a short-lived operator-issued write_grant and only one coding workspace may own a task at a time. A phase change, rebind, disable, close, revocation or expiry invalidates old workspace authority. Git commit/push, policy changes, repository registration, task lifecycle control and unrestricted shell remain outside MCP.'
    });

    const respond = (fn: () => Promise<unknown>, tool: string) => async (): Promise<CallToolResult> => {
      try {
        const value = await fn();
        await audit(tool, era, true);
        return { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } catch (error) {
        await audit(tool, era, false).catch(() => {});
        return { isError: true, content: [{ type: 'text', text: error instanceof SafeError ? error.message : 'Operation failed. Inspect Repo MCP operator state.' }] };
      }
    };

    const scoped = (
      tool: string,
      capability: WorkspaceCapability,
      kind: string,
      fn: (repo: RepoWorkspace, args: any, authorized: AuthorizedWorkspace, gatedPreflight: () => Promise<void>) => Promise<unknown>,
      mutation = false
    ) => async (args: any): Promise<CallToolResult> => {
      let authorizedForAudit: AuthorizedWorkspace | undefined;
      try {
        if (!args?.workspace_token) throw new SafeError('This production service requires workspace_token. Use repository_list and workspace_open; old unscoped single-repository calls fail closed.');
        const value = await withWorkspaceAdmission(stateDir, args.workspace_token, capability, async authorized => {
          authorizedForAudit = authorized;
          return runtimes.use(authorized, args.workspace_token, capability, async (repo, gatedPreflight) => {
            if (mutation) {
              return auditedEdit(
                () => fn(repo, args, authorized, gatedPreflight) as Promise<{ path: string; before_sha256: string | null; after_sha256: string }>,
                async (phase, data) => audit(tool, era, true, authorized, { phase, ...(data ? { path: data.path, before_sha256: data.before_sha256, after_sha256: data.after_sha256 } : {}) })
              );
            }
            return fn(repo, args, authorized, gatedPreflight);
          });
        });
        if (!mutation) {
          const data = value as any;
          const summary = tool === 'run_tests' ? { suite: args.suite ?? 'all', exit_code: data?.exit_code, timed_out: data?.timed_out, truncated: data?.truncated, duration_ms: data?.duration_ms } : undefined;
          await audit(tool, era, true, authorizedForAudit, summary);
        }
        const responseValue = mutation && authorizedForAudit && value && typeof value === 'object' && !Array.isArray(value)
          ? { ...(value as Record<string, unknown>), scope: authorizedForAudit.scope }
          : value;
        return { content: [{ type: 'text', text: JSON.stringify(responseValue) }] };
      } catch (error) {
        await audit(tool, era, false, authorizedForAudit).catch(() => {});
        return { isError: true, content: [{ type: 'text', text: error instanceof SafeError ? error.message : 'Operation failed. Check workspace authorization and repository state.' }] };
      }
    };

    server.registerTool('service_info', {
      description: 'Inspect the permanent Repo MCP service and catalog summary. This tool does not select a repository.',
      inputSchema: z.strictObject({}),
      annotations: readOnly
    }, respond(async () => {
      const catalog = await readMultiRepoCatalog(stateDir);
      return {
        ...processAttestation,
        catalog_revision: catalog.revision,
        registered_repositories: Object.keys(catalog.repositories).length,
        registered_tasks: Object.keys(catalog.tasks).length,
        workspace_contract: 'explicit-token',
        conversation_identity: 'not-an-authorization-source',
        repository_tools_require_workspace_token: true
      };
    }, 'service_info'));

    server.registerTool('repository_list', {
      description: 'List operator-approved repository IDs and prepared tasks. Does not accept or reveal arbitrary filesystem roots or policy paths.',
      inputSchema: z.strictObject({}),
      annotations: readOnly
    }, respond(() => listRegisteredRepositories(stateDir), 'repository_list'));

    return registerWorkspaceTools(server, era, {
      stateDir,
      runtimes,
      audit,
      scoped,
      workspaceToken,
      cursor
    });
  }, { legacy: 'stateless', maxRequestBodySize: DEFAULT_LIMITS.request_body_bytes });

  const handle = toNodeHandler(handler, { maxRequestBodySize: DEFAULT_LIMITS.request_body_bytes });
  const host = localhostHostValidation();
  const origin = localhostOriginValidation();
  const http = createServer(async (req, res) => {
    if (!host(req, res) || !origin(req, res)) return;
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(processAttestation));
      return;
    }
    if (req.url !== '/mcp') { res.writeHead(404); res.end(); return; }
    try { await handle(req, res); } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  http.requestTimeout = 15_000;
  http.headersTimeout = 10_000;
  try { await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(listenPort, '127.0.0.1', resolve); }); }
  catch (error) { await runtimes.close(); throw error; }
  const addr = http.address();
  if (!addr || typeof addr === 'string') throw new Error('No listening address');
  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    processAttestation,
    close: async () => {
      await handler.close();
      await runtimes.close();
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    }
  };
}

function registerWorkspaceTools(
  server: McpServer,
  era: string,
  deps: {
    stateDir: string;
    runtimes: RuntimeManager;
    audit: (tool: string, era: string, ok: boolean, authorized?: AuthorizedWorkspace, data?: unknown) => Promise<void>;
    scoped: (tool: string, capability: WorkspaceCapability, kind: string, fn: (repo: RepoWorkspace, args: any, authorized: AuthorizedWorkspace, gatedPreflight: () => Promise<void>) => Promise<unknown>, mutation?: boolean) => (args: any) => Promise<CallToolResult>;
    workspaceToken: typeof workspaceToken;
    cursor: typeof cursor;
  }
) {
  const { stateDir, scoped } = deps;

  server.registerTool('workspace_open', {
    description: 'Open an immutable selection for an operator-registered repository/task. inspect and review are read-only. code requires an operator-issued single-use write_grant. No filesystem root or policy path is accepted.',
    inputSchema: z.strictObject({
      repository_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      task_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      mode: z.enum(['inspect', 'code', 'review']),
      request_id: requestId,
      write_grant: z.string().min(20).max(512).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async args => {
    try {
      const result = await openWorkspace({ stateDir, repositoryId: args.repository_id, taskId: args.task_id, mode: args.mode, requestId: args.request_id, writeGrant: args.write_grant });
      await deps.audit('workspace_open', era, true);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      await deps.audit('workspace_open', era, false).catch(() => {});
      return { isError: true, content: [{ type: 'text', text: error instanceof SafeError ? error.message : 'Workspace selection failed.' }] };
    }
  });

  server.registerTool('workspace_close', {
    description: 'Close this immutable workspace selection after admitted operations drain. Closing does not finish the underlying task.',
    inputSchema: z.strictObject({ workspace_token: deps.workspaceToken, request_id: requestId }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async args => {
    try {
      const result = await closeWorkspace({ stateDir, workspaceToken: args.workspace_token, requestId: args.request_id });
      await deps.audit('workspace_close', era, true);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      await deps.audit('workspace_close', era, false).catch(() => {});
      return { isError: true, content: [{ type: 'text', text: error instanceof SafeError ? error.message : 'Workspace close failed.' }] };
    }
  });

  server.registerTool('repo_info', {
    description: 'Inspect the repository selected by required workspace_token. Old unscoped calls are rejected; there is no ambient repository.',
    inputSchema: z.strictObject({ workspace_token: deps.workspaceToken, status_cursor: deps.cursor, files_cursor: deps.cursor }),
    annotations: readOnly
  }, scoped('repo_info', 'read', 'repo_info', async (repo, args, authorized) => {
    if (args.status_cursor && args.files_cursor) throw new SafeError('Pass only one of status_cursor and files_cursor.');
    if (args.status_cursor) {
      const inner = await unwrapWorkspaceCursor(stateDir, authorized.selection.workspace_id, 'repo-status', args.status_cursor);
      return wrapResult(stateDir, authorized, 'repo-status', await repo.statusPage(inner!));
    }
    if (args.files_cursor) {
      const inner = await unwrapWorkspaceCursor(stateDir, authorized.selection.workspace_id, 'repo-files', args.files_cursor);
      return wrapResult(stateDir, authorized, 'repo-files', await repo.filesPage(inner!));
    }
    const info = await repo.info({
      capabilities: {
        policy_version: 2,
        path_policy: repo.exactPolicy ? 'exact' : 'glob',
        request_ids: true,
        task_state: true,
        paging: true,
        workspace_selection: true,
        workspace_mode: authorized.selection.mode,
        workspace_capabilities: authorized.selection.capabilities,
        limits: repo.limits
      },
      server: { name: 'repo-mcp', server_version: RELEASE_VERSION, service_mode: 'multirepo', process_pid: process.pid },
      review_assurance: authorized.live_task.phase === 'review' ? 'phase_only' : 'not_frozen',
      candidate_digest: null
    });
    return wrapResult(stateDir, authorized, 'repo_info', info);
  }));

  server.registerTool('list_files', {
    description: 'List exposed files in the selected workspace.',
    inputSchema: z.strictObject({ workspace_token: deps.workspaceToken, prefix: z.string().max(256).optional(), cursor: deps.cursor }),
    annotations: readOnly
  }, scoped('list_files', 'read', 'list_files', async (repo, args, authorized) => {
    const inner = await unwrapWorkspaceCursor(stateDir, authorized.selection.workspace_id, 'list_files', args.cursor);
    return wrapResult(stateDir, authorized, 'list_files', await repo.listFiles(args.prefix, inner));
  }));

  server.registerTool('read', {
    description: 'Read one exposed text file in the selected workspace.',
    inputSchema: z.strictObject({
      workspace_token: deps.workspaceToken,
      path: z.string().min(1).max(256),
      start_line: z.number().int().min(1).optional(),
      max_lines: z.number().int().min(1).max(DEFAULT_LIMITS.page_lines).optional(),
      cursor: deps.cursor
    }),
    annotations: readOnly
  }, scoped('read', 'read', 'read', async (repo, args, authorized) => {
    const inner = await unwrapWorkspaceCursor(stateDir, authorized.selection.workspace_id, 'read', args.cursor);
    return wrapResult(stateDir, authorized, 'read', await repo.readRange(args.path, args.start_line, args.max_lines, inner));
  }));

  server.registerTool('search', {
    description: 'Search exposed files in the selected workspace.',
    inputSchema: z.strictObject({ workspace_token: deps.workspaceToken, query: z.string().min(1).max(200), prefix: z.string().max(256).optional(), cursor: deps.cursor }),
    annotations: readOnly
  }, scoped('search', 'read', 'search', async (repo, args, authorized) => {
    const inner = await unwrapWorkspaceCursor(stateDir, authorized.selection.workspace_id, 'search', args.cursor);
    return wrapResult(stateDir, authorized, 'search', await repo.search(args.query, args.prefix, inner));
  }));

  server.registerTool('git_diff', {
    description: 'Inspect the bounded diff for the selected workspace. Optional base_ref compares the working tree to that commit, branch, tag, or relative commit (for example HEAD^) so committed changes remain reviewable. Continue every page with the same base_ref. In review phase this is still a phase freeze, not a content-verified candidate unless future candidate fields say otherwise.',
    inputSchema: z.strictObject({ workspace_token: deps.workspaceToken, prefix: z.string().max(256).optional(), base_ref: z.string().min(1).max(128).optional(), cursor: deps.cursor }),
    annotations: readOnly
  }, scoped('git_diff', 'read', 'git_diff', async (repo, args, authorized) => {
    const inner = await unwrapWorkspaceCursor(stateDir, authorized.selection.workspace_id, 'git_diff', args.cursor);
    return wrapResult(stateDir, authorized, 'git_diff', await repo.diff(args.prefix, inner, args.base_ref));
  }));

  server.registerTool('edit', {
    description: 'Edit one exact occurrence inside a coding workspace. Requires the current full-file hash and a fresh request_id.',
    inputSchema: z.strictObject({
      workspace_token: deps.workspaceToken,
      path: z.string().min(1).max(256),
      old_text: z.string().min(1).max(DEFAULT_LIMITS.payload_bytes),
      new_text: z.string().max(DEFAULT_LIMITS.payload_bytes),
      expected_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      request_id: requestId
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, scoped('edit', 'write', 'edit', async (repo, args, authorized, gatedPreflight) => {
    requirePayload(repo, args.old_text, args.new_text);
    return repo.edit(
      args.path,
      args.old_text,
      args.new_text,
      args.expected_sha256,
      internalMutationRequestId(authorized.selection.workspace_id, args.request_id),
      gatedPreflight
    );
  }, true));

  server.registerTool('create_file', {
    description: 'Create one policy-approved text file inside a coding workspace. Never overwrites.',
    inputSchema: z.strictObject({
      workspace_token: deps.workspaceToken,
      path: z.string().min(1).max(256),
      content: z.string().min(1).max(DEFAULT_LIMITS.payload_bytes),
      request_id: requestId
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, scoped('create_file', 'write', 'create_file', async (repo, args, authorized, gatedPreflight) => {
    requirePayload(repo, args.content);
    return repo.createFile(
      args.path,
      args.content,
      internalMutationRequestId(authorized.selection.workspace_id, args.request_id),
      gatedPreflight
    );
  }, true));

  server.registerTool('run_tests', {
    description: 'Run only an operator-approved fixture suite in a coding workspace. No arbitrary command is accepted.',
    inputSchema: z.strictObject({ workspace_token: deps.workspaceToken, suite: z.string().max(256).optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, scoped('run_tests', 'check', 'run_tests', (repo, args, authorized, gatedPreflight) => repo.test(args.suite, gatedPreflight).then(result => wrapResult(stateDir, authorized, 'run_tests', result))));

  return server;
}
