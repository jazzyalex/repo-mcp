import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { prepareFixture } from '../src/fixture.js';
import { defaultPolicy } from '../src/repo.js';
import { sha256 } from '../src/errors.js';
import { migrateV1, policyDigest } from '../src/policy.js';
import { resolveIdentity } from '../src/identity.js';
import { startServer } from '../src/server.js';
import { coordinatorBind, coordinatorFinish, coordinatorOverallState, coordinatorStart, coordinatorStatus, formatCoordinatorStatusText } from '../src/coordinator.js';
import { bindTask, completeTask, rebindTask, recoverTaskStaleLocks, setTaskPhase, TaskContext, taskStatus, taskWriterLockStatus } from '../src/task.js';
import { acquireLock, STATE_VERSION, StateStore } from '../src/task-state.js';
import { RELEASE_VERSION } from '../src/version.js';
import {
  compareAttestation,
  installOrReloadStable,
  legacyServerPlist,
  migrateLegacyServer,
  plistXml,
  readActiveService,
  recognizeLegacyServerPlist,
  rootDigest,
  serviceStatus,
  stableServerPlist,
  writeActiveService,
  type ActiveServiceRecord,
  type PlistObject,
  type ServiceDriver
} from '../src/service-control.js';

const tmp = (name: string) => mkdtemp(path.join(os.tmpdir(), name));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runCoordinatorStatus(stateDir: string, json = false) {
  return spawnSync(process.execPath, [
    '--import', 'tsx', path.join(projectRoot, 'scripts/coordinator.ts'), 'status',
    ...(json ? ['--json'] : []), '--state-dir', stateDir
  ], { cwd: projectRoot, encoding: 'utf8' });
}

async function fixture(base: string, name: string) {
  const root = path.join(base, name);
  await prepareFixture(root);
  return await realpath(root);
}

function active(taskId: string, root: string, stateDir: string, generation = 1): ActiveServiceRecord {
  return {
    task_id: taskId,
    root,
    root_digest: rootDigest(root),
    policy_path: path.join(stateDir, `${taskId}.policy.json`),
    policy_digest: 'a'.repeat(64),
    state_dir: stateDir,
    audit_path: path.join(stateDir, `${taskId}.audit.jsonl`),
    port: 8787,
    allow_detached: false,
    generation,
    expected_server_version: RELEASE_VERSION,
    configured_at: '2026-10-02T00:00:00.000Z'
  };
}

const checkoutLockKey = (root: string, gitDir: string) => `checkout-${sha256(`${root}\0${gitDir}`).slice(0, 32)}`;

class FakeDriver implements ServiceDriver {
  loaded = false;
  occupied = false;
  healthValue: unknown;
  job: { pid: number; plist_path: string; definition: PlistObject } | undefined;
  nextJob: { pid: number; plist_path: string; definition: PlistObject } | undefined;
  portPid: number | undefined;
  calls: string[] = [];
  constructor(healthValue?: unknown) { this.healthValue = healthValue; }
  async isLoaded() { this.calls.push('print'); return this.loaded; }
  async inspectLoadedJob() { this.calls.push('inspect'); return this.loaded ? this.job : undefined; }
  async bootout() { this.calls.push('bootout'); this.loaded = false; this.occupied = false; }
  async bootstrap() { this.calls.push('bootstrap'); this.loaded = true; this.occupied = true; if (this.nextJob) { this.job = this.nextJob; this.portPid = this.nextJob.pid; } }
  async kickstart() { this.calls.push('kickstart'); this.loaded = true; this.occupied = true; if (this.nextJob) { this.job = this.nextJob; this.portPid = this.nextJob.pid; } }
  async portOwnerPid() { this.calls.push('port-pid'); return this.occupied ? (this.portPid ?? this.job?.pid ?? 999_999) : undefined; }
  async portOccupied() { this.calls.push('port'); return this.occupied; }
  async health() { this.calls.push('health'); return this.healthValue; }
}

async function legacyBinding(root: string, taskId: string, digest: string) {
  const identity = await resolveIdentity(root);
  return {
    task_id: taskId,
    root: identity.root,
    git_dir: identity.git_dir,
    common_dir: identity.common_dir,
    branch: identity.branch,
    head: identity.head,
    allow_detached: false,
    policy_digest: digest,
    bound_at: '2026-10-02T00:00:00.000Z'
  };
}

async function writeTrustedInstall(stateDir: string, target: string, bytes: Buffer, extra: Record<string, unknown> = {}) {
  const store = await StateStore.open(stateDir);
  await store.write('control/install.json', 'install', {
    label: 'local.repo-mcp.server', target, installed_plist_sha256: sha256(bytes),
    updated_at: '2026-10-02T00:00:00.000Z', ...extra
  });
  return store;
}

test('task-mode mutation schemas require request_id and health attests loaded generation/version', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-schema-'));
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const policy = migrateV1(defaultPolicy);
  await bindTask(stateDir, 'stage1-schema', root, policyDigest(policy));
  const service = await startServer(root, 0, undefined, policy, {
    task: { stateDir, taskId: 'stage1-schema' },
    serviceGeneration: 7
  });
  const client = new Client({ name: 'stage1-schema', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url)));
    const tools = await client.listTools();
    for (const name of ['edit', 'create_file']) {
      const schema = tools.tools.find(t => t.name === name)!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      assert.ok(schema.properties?.request_id, name);
      assert.ok(schema.required?.includes('request_id'), `${name} request_id must be required in task mode`);
    }
    const source = JSON.parse(((await client.callTool({ name: 'read', arguments: { path: 'src/clamp.js' } })).content as { text: string }[])[0].text);
    const missing = await client.callTool({ name: 'edit', arguments: {
      path: 'src/clamp.js', old_text: 'max - 1', new_text: 'max', expected_sha256: source.sha256
    } }).catch((error: Error) => ({ isError: true, content: [{ type: 'text', text: error.message }] }));
    assert.equal(missing.isError, true);
    assert.equal((await readFile(path.join(root, 'src/clamp.js'), 'utf8')).includes('max - 1'), true);

    const response = await fetch(new URL('/', service.url));
    const health = await response.json() as Record<string, unknown>;
    assert.deepEqual(health, {
      ok: true,
      name: 'repo-mcp',
      server_version: RELEASE_VERSION,
      service_generation: 7,
      task_id: 'stage1-schema',
      root_digest: rootDigest(root),
      process_pid: process.pid
    });
    const info = JSON.parse(((await client.callTool({ name: 'repo_info', arguments: {} })).content as { text: string }[])[0].text) as {
      server: Record<string, unknown>;
    };
    assert.deepEqual(info.server, health, 'repo_info must expose the canonical running-process attestation for remote route proof');
  } finally {
    await client.close();
    await service.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('untracked mode still omits request_id from mutation schemas', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-untracked-'));
  const root = await fixture(base, 'repo');
  const service = await startServer(root, 0);
  const client = new Client({ name: 'stage1-untracked', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url)));
    const tools = await client.listTools();
    for (const name of ['edit', 'create_file']) {
      const schema = tools.tools.find(t => t.name === name)!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      assert.ok(!schema.properties?.request_id);
      assert.ok(!schema.required?.includes('request_id'));
    }
  } finally {
    await client.close();
    await service.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('status --json is accepted and emits stable machine-readable fields', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-status-json-'));
  const stateDir = path.join(base, 'state');
  const result = runCoordinatorStatus(stateDir, true);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(parsed.state, 'unbound');
  assert.equal(parsed.server_version, RELEASE_VERSION);
  assert.equal(parsed.active_task_id, null);
  assert.equal(parsed.local_mcp, 'stopped');
  assert.equal(parsed.tunnel, 'unverified_stage4');
  assert.equal(parsed.chatgpt_route, 'probe_required');
  await rm(base, { recursive: true, force: true });
});

test('status text is the default and separates overall local tunnel and route state', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-status-text-'));
  const stateDir = path.join(base, 'state');
  const result = runCoordinatorStatus(stateDir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^UNVERIFIED\b/m);
  assert.match(result.stdout, /^local_mcp: stopped$/m);
  assert.match(result.stdout, /^tunnel: unverified_stage4$/m);
  assert.match(result.stdout, /^chatgpt_route: probe_required$/m);
  assert.doesNotMatch(result.stdout.trimStart(), /^\{/);
  await rm(base, { recursive: true, force: true });
});

test('overall status cannot be ready while local MCP is ready but tunnel or ChatGPT route is unverified', () => {
  assert.equal(coordinatorOverallState({
    completion: false,
    local_mcp: 'ready',
    identity_matches: true,
    tunnel: 'unverified_stage4',
    chatgpt_route: 'verified'
  }), 'degraded');
  assert.equal(coordinatorOverallState({
    completion: false,
    local_mcp: 'ready',
    identity_matches: true,
    tunnel: 'ready',
    chatgpt_route: 'probe_required'
  }), 'degraded');
  assert.equal(coordinatorOverallState({
    completion: false,
    local_mcp: 'ready',
    identity_matches: true,
    tunnel: 'ready',
    chatgpt_route: 'verified'
  }), 'ready');
});

test('text status exposes distinct required overall labels', () => {
  for (const state of ['ready', 'degraded', 'stale', 'blocked', 'unverified']) {
    const text = formatCoordinatorStatusText({
      state,
      active_task_id: 'task-a',
      local_mcp: state === 'ready' ? 'ready' : 'stopped',
      launchd: 'loaded',
      tunnel: 'unverified_stage4',
      chatgpt_route: 'probe_required'
    });
    assert.match(text, new RegExp(`^${state.toUpperCase()}\\b`), state);
  }
});

test('completion is terminal and blocks task reopening, phase change and rebind while a new task ID works', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-completion-'));
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const policy = migrateV1(defaultPolicy);
  const digest = policyDigest(policy);
  await bindTask(stateDir, 'done-task', root, digest);
  const first = await startServer(root, 0, undefined, policy, { task: { stateDir, taskId: 'done-task' } });
  await first.close();
  const completion = await completeTask(stateDir, 'done-task', { result: 'abandoned' });
  assert.equal(completion.result, 'abandoned');
  await assert.rejects(startServer(root, 0, undefined, policy, { task: { stateDir, taskId: 'done-task' } }), /completed/i);
  await assert.rejects(setTaskPhase(stateDir, 'done-task', 'coding'), /completed/i);
  await assert.rejects(rebindTask(stateDir, 'done-task', root, { policyDigest: digest }), /completed/i);
  assert.equal((await completeTask(stateDir, 'done-task', { result: 'abandoned' })).result, 'abandoned');
  await assert.rejects(completeTask(stateDir, 'done-task', { result: 'committed', commit_sha: 'a'.repeat(40) }), /different outcome/i);
  await bindTask(stateDir, 'new-task', root, digest);
  const next = await startServer(root, 0, undefined, policy, { task: { stateDir, taskId: 'new-task' } });
  await next.close();
  await rm(base, { recursive: true, force: true });
});

test('completion refuses a stale checkout writer lock and preserves it for explicit recovery', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-stale-finish-'));
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const digest = policyDigest(migrateV1(defaultPolicy));
  await bindTask(stateDir, 'task-a', root, digest);
  const status = await taskStatus(stateDir, 'task-a');
  const key = checkoutLockKey(status.root, status.git_dir);
  const store = await StateStore.open(stateDir);
  const stale = { pid: 2147483647, hostname: os.hostname(), token: 'task-a-stale-token', purpose: 'task task-a', acquired_at: '2026-10-02T00:00:00.000Z' };
  await store.write(`locks/${key}.json`, 'lock', stale);

  await assert.rejects(completeTask(stateDir, 'task-a', { result: 'abandoned' }), /stale|recover/i);
  assert.equal(await store.read('tasks/task-a/completion.json', 'completion'), undefined);
  assert.deepEqual(await store.read(`locks/${key}.json`, 'lock'), stale);
  await rm(base, { recursive: true, force: true });
});

test('explicit stale recovery refuses another task owner on the same checkout and preserves the old lock', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-cross-task-lock-'));
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const digest = policyDigest(migrateV1(defaultPolicy));
  await bindTask(stateDir, 'task-a', root, digest);
  await bindTask(stateDir, 'task-b', root, digest);
  const status = await taskStatus(stateDir, 'task-a');
  const key = checkoutLockKey(status.root, status.git_dir);
  const store = await StateStore.open(stateDir);
  const stale = { pid: 2147483647, hostname: os.hostname(), token: 'task-a-stale-token', purpose: 'task task-a', acquired_at: '2026-10-02T00:00:00.000Z' };
  await store.write(`locks/${key}.json`, 'lock', stale);

  await assert.rejects(recoverTaskStaleLocks(stateDir, 'task-b'), /task-a|different task|belongs/i);
  assert.deepEqual(await store.read(`locks/${key}.json`, 'lock'), stale);
  await rm(base, { recursive: true, force: true });
});

test('active-service record is owner-only, versioned and increments generation only when desired configuration changes', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-active-'));
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const store = await StateStore.open(stateDir, { forbiddenRoots: [root] });
  const desired = active('task-a', root, stateDir, 1);
  const first = await writeActiveService(store, { ...desired, generation: undefined, configured_at: undefined });
  const same = await writeActiveService(store, { ...desired, generation: undefined, configured_at: undefined });
  const changed = await writeActiveService(store, { ...desired, task_id: 'task-b', generation: undefined, configured_at: undefined });
  assert.equal(first.generation, 1);
  assert.equal(same.generation, 1);
  assert.equal(changed.generation, 2);
  assert.equal((await readActiveService(store))?.task_id, 'task-b');
  assert.equal((await stat(path.join(stateDir, 'control/active-service.json'))).mode & 0o777, 0o600);
  await rm(base, { recursive: true, force: true });
});

test('stable plist is repository-agnostic and legacy recognition is exact', () => {
  const base = '/opt/repo-mcp';
  const node = '/opt/node/bin/node';
  const stateDir = '/tmp/repo-mcp-test-user/Library/Application Support/repo-mcp/state';
  const stable = stableServerPlist({ base, node, stateDir });
  assert.deepEqual(stable.ProgramArguments, [node, path.join(base, 'dist/src/service-main.js')]);
  assert.deepEqual(stable.EnvironmentVariables, { REPO_MCP_STATE_DIR: stateDir });
  assert.doesNotMatch(JSON.stringify(stable), /REPO_ROOT|REPO_MCP_POLICY|runtime\.key/);

  const legacy = legacyServerPlist({ base, node, repo: '/tmp/repo', policy: '/tmp/policy.json', port: '8787' });
  assert.equal(recognizeLegacyServerPlist(legacy, { base, node, repo: '/tmp/repo', policy: '/tmp/policy.json', port: '8787' }), true);
  assert.equal(recognizeLegacyServerPlist({ ...legacy, KeepAlive: false }, { base, node, repo: '/tmp/repo', policy: '/tmp/policy.json', port: '8787' }), false);
  assert.equal(recognizeLegacyServerPlist({ ...legacy, Extra: true }, { base, node, repo: '/tmp/repo', policy: '/tmp/policy.json', port: '8787' }), false);
});

test('old surviving process after reload cannot satisfy a new desired generation', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-generation-'));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, 'dist/src'), { recursive: true });
  await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const launchDir = path.join(base, 'LaunchAgents');
  const driver = new FakeDriver();
  const old = active('task-a', root, stateDir, 8);
  const target = path.join(launchDir, 'local.repo-mcp.server.plist');
  const definition = stableServerPlist({ base: project, node: process.execPath, stateDir });
  driver.nextJob = { pid: 801, plist_path: target, definition };
  driver.healthValue = { ok: true, name: 'repo-mcp', server_version: RELEASE_VERSION, service_generation: 8, task_id: old.task_id, root_digest: old.root_digest, process_pid: 801 };
  await installOrReloadStable(old, { base: project, node: process.execPath, launchAgentsDir: launchDir, driver });
  const wanted = { ...old, generation: 9, configured_at: '2026-10-02T01:00:00.000Z' };
  assert.equal(compareAttestation(wanted, driver.healthValue).state, 'wrong_generation');
  await assert.rejects(installOrReloadStable(wanted, { base: project, node: process.execPath, launchAgentsDir: launchDir, driver, waitMs: 0 }), /wrong_generation/);
  assert.ok(driver.calls.includes('kickstart'));
  assert.equal(driver.loaded, false, 'post-kickstart attestation failure must unload the controlled trusted job');
  assert.ok(driver.calls.includes('bootout'));
  await rm(base, { recursive: true, force: true });
});

test('post-start listener PID mismatch unloads the exact trusted job controlled by this invocation', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-post-start-pid-'));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, 'dist/src'), { recursive: true });
  await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const launchDir = path.join(base, 'LaunchAgents');
  const target = path.join(launchDir, 'local.repo-mcp.server.plist');
  const desired = active('task-a', root, stateDir);
  const definition = stableServerPlist({ base: project, node: process.execPath, stateDir });
  const driver = new FakeDriver({
    ok: true, name: 'repo-mcp', server_version: RELEASE_VERSION,
    service_generation: desired.generation, task_id: desired.task_id, root_digest: desired.root_digest, process_pid: 821
  });
  driver.nextJob = { pid: 821, plist_path: target, definition };
  driver.portOwnerPid = async () => {
    driver.calls.push('port-pid');
    return 822;
  };

  await assert.rejects(
    installOrReloadStable(desired, { base: project, node: process.execPath, launchAgentsDir: launchDir, driver }),
    /listener\/health PID|process PID/i
  );
  assert.equal(driver.loaded, false, 'post-start PID verification failure must unload the controlled trusted job');
  assert.ok(driver.calls.includes('bootstrap'));
  assert.ok(driver.calls.includes('bootout'));
  await rm(base, { recursive: true, force: true });
});

test('legacy migration can prepare stable service unbound without publishing generation or loading service', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-migration-'));
  const project = path.join(base, 'project');
  const dist = path.join(project, 'dist/src');
  await mkdir(dist, { recursive: true });
  await writeFile(path.join(dist, 'main.js'), '// legacy\n');
  await writeFile(path.join(dist, 'service-main.js'), '// stable\n');
  const repo = await fixture(base, 'repo');
  const policy = path.join(base, 'policy.json');
  await writeFile(policy, '{}\n');
  const node = process.execPath;
  const stateDir = path.join(base, 'state');
  const launchDir = path.join(base, 'LaunchAgents');
  await mkdir(launchDir, { recursive: true });
  const target = path.join(launchDir, 'local.repo-mcp.server.plist');
  const legacy = legacyServerPlist({ base: project, node, repo, policy, port: '8787' });
  const original = Buffer.from(plistXml(legacy));
  await writeFile(target, original, { mode: 0o600 });
  const driver = new FakeDriver({ ok: true, name: 'repo-mcp' });
  driver.loaded = true;
  driver.occupied = true;
  driver.job = { pid: 802, plist_path: target, definition: legacy };
  driver.portPid = 802;

  const result = await migrateLegacyServer({
    stateDir, base: project, node, launchAgentsDir: launchDir, driver,
    parsePlist: async () => legacy
  });
  assert.equal(result.migration_state, 'prepared_unbound');
  assert.equal(driver.calls.includes('bootstrap'), false);
  assert.equal(driver.loaded, false);
  const store = await StateStore.open(stateDir);
  assert.equal(await readActiveService(store), undefined, 'migration must not publish task-bound generation');
  const install = await store.read<{ migration_state: string; legacy_backup_path: string }>('control/install.json', 'install');
  assert.equal(install?.migration_state, 'prepared_unbound');
  assert.deepEqual(await readFile(install!.legacy_backup_path), original);
  assert.match(await readFile(target, 'utf8'), /service-main\.js/);
  await rm(base, { recursive: true, force: true });
});

test('stable service definition is reused unchanged across task generations', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-switch-'));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, 'dist/src'), { recursive: true });
  await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
  const rootA = await fixture(base, 'a');
  const rootB = await fixture(base, 'b');
  const stateDir = path.join(base, 'state');
  const launchDir = path.join(base, 'LaunchAgents');
  const driver = new FakeDriver();
  const a = active('task-a', rootA, stateDir, 1);
  const target = path.join(launchDir, 'local.repo-mcp.server.plist');
  const definition = stableServerPlist({ base: project, node: process.execPath, stateDir });
  driver.nextJob = { pid: 803, plist_path: target, definition };
  driver.healthValue = { ok: true, name: 'repo-mcp', server_version: RELEASE_VERSION, service_generation: 1, task_id: a.task_id, root_digest: a.root_digest, process_pid: 803 };
  await installOrReloadStable(a, { base: project, node: process.execPath, launchAgentsDir: launchDir, driver });
  const firstBytes = await readFile(target);

  await driver.bootout();
  const b = active('task-b', rootB, stateDir, 2);
  driver.nextJob = { pid: 804, plist_path: target, definition };
  driver.healthValue = { ok: true, name: 'repo-mcp', server_version: RELEASE_VERSION, service_generation: 2, task_id: b.task_id, root_digest: b.root_digest, process_pid: 804 };
  await installOrReloadStable(b, { base: project, node: process.execPath, launchAgentsDir: launchDir, driver });
  assert.deepEqual(await readFile(target), firstBytes, 'task switch must not rewrite stable plist');
  await rm(base, { recursive: true, force: true });
});

test('exact legacy migration with a safe active task bootstraps only after backup and verifies attestation', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-verified-migration-'));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, 'dist/src'), { recursive: true });
  await writeFile(path.join(project, 'dist/src/main.js'), '// legacy\n');
  await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
  const repo = await fixture(base, 'repo');
  const policy = path.join(base, 'policy.json');
  await writeFile(policy, '{}\n');
  const node = process.execPath;
  const stateDir = path.join(base, 'state');
  const launchDir = path.join(base, 'LaunchAgents');
  await mkdir(launchDir, { recursive: true });
  const target = path.join(launchDir, 'local.repo-mcp.server.plist');
  const legacy = legacyServerPlist({ base: project, node, repo, policy, port: '8787' });
  await writeFile(target, plistXml(legacy), { mode: 0o600 });
  const desired = active('safe-task', repo, stateDir, 3);
  const store = await StateStore.open(stateDir);
  await writeActiveService(store, { ...desired, generation: undefined, configured_at: undefined });
  const published = (await readActiveService(store))!;
  const driver = new FakeDriver({ ok: true, name: 'repo-mcp', server_version: RELEASE_VERSION, service_generation: published.generation, task_id: published.task_id, root_digest: published.root_digest, process_pid: 806 });
  driver.loaded = true;
  driver.occupied = true;
  driver.job = { pid: 805, plist_path: target, definition: legacy };
  driver.portPid = 805;
  driver.nextJob = { pid: 806, plist_path: target, definition: stableServerPlist({ base: project, node, stateDir }) };
  const result = await migrateLegacyServer({ stateDir, active: published, base: project, node, launchAgentsDir: launchDir, driver, parsePlist: async () => legacy });
  assert.equal(result.migration_state, 'verified');
  assert.equal(driver.loaded, true);
  const install = await store.read<{ migration_state: string; legacy_backup_path: string }>('control/install.json', 'install');
  assert.equal(install?.migration_state, 'verified');
  assert.ok((await readFile(install!.legacy_backup_path)).length > 0);
  await rm(base, { recursive: true, force: true });
});

test('active legacy migration unloads the controlled stable job when post-bootstrap attestation fails', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-migration-attestation-fail-'));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, 'dist/src'), { recursive: true });
  await writeFile(path.join(project, 'dist/src/main.js'), '// legacy\n');
  await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
  const repo = await fixture(base, 'repo');
  const policy = path.join(base, 'policy.json');
  await writeFile(policy, '{}\n');
  const stateDir = path.join(base, 'state');
  const launchDir = path.join(base, 'LaunchAgents');
  await mkdir(launchDir, { recursive: true });
  const target = path.join(launchDir, 'local.repo-mcp.server.plist');
  const legacy = legacyServerPlist({ base: project, node: process.execPath, repo, policy, port: '8787' });
  await writeFile(target, plistXml(legacy), { mode: 0o600 });
  const desired = active('safe-task', repo, stateDir, 3);
  const store = await StateStore.open(stateDir);
  await writeActiveService(store, { ...desired, generation: undefined, configured_at: undefined });
  const published = (await readActiveService(store))!;
  const stable = stableServerPlist({ base: project, node: process.execPath, stateDir });
  const driver = new FakeDriver({
    ok: true, name: 'repo-mcp', server_version: RELEASE_VERSION,
    service_generation: published.generation + 1, task_id: published.task_id,
    root_digest: published.root_digest, process_pid: 826
  });
  driver.loaded = true;
  driver.occupied = true;
  driver.job = { pid: 825, plist_path: target, definition: legacy };
  driver.portPid = 825;
  driver.nextJob = { pid: 826, plist_path: target, definition: stable };

  await assert.rejects(
    migrateLegacyServer({
      stateDir, active: published, base: project, node: process.execPath,
      launchAgentsDir: launchDir, driver, parsePlist: async () => legacy, waitMs: 0
    }),
    /wrong_generation/
  );
  assert.equal(driver.loaded, false, 'failed migrated-service attestation must not leave the controlled stable job running');
  assert.equal(driver.calls.filter(call => call === 'bootout').length, 2, 'legacy unload and failed stable-service cleanup must both occur');
  const install = await store.read<{ migration_state?: string; plist_transaction?: unknown }>('control/install.json', 'install');
  assert.equal(install?.migration_state, 'prepared');
  assert.ok(install?.plist_transaction, 'failed attestation must preserve the prepared migration transaction');
  await rm(base, { recursive: true, force: true });
});

test('modified legacy plist field classes are each refused unchanged', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-modified-legacy-'));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, 'dist/src'), { recursive: true });
  await writeFile(path.join(project, 'dist/src/main.js'), '// legacy\n');
  const repo = await fixture(base, 'repo');
  const policy = path.join(base, 'policy.json');
  await writeFile(policy, '{}\n');
  const node = process.execPath;
  const stateDir = path.join(base, 'state');
  const launchDir = path.join(base, 'LaunchAgents');
  await mkdir(launchDir, { recursive: true });
  const target = path.join(launchDir, 'local.repo-mcp.server.plist');
  const legacy = legacyServerPlist({ base: project, node, repo, policy, port: '8787' });
  const environment = { REPO_ROOT: repo, REPO_MCP_POLICY: policy, REPO_MCP_AUDIT: path.join(project, '.trial/service-audit.jsonl'), PORT: '8787' };
  const cases: [string, ReturnType<typeof legacyServerPlist>][] = [
    ['label', { ...legacy, Label: 'foreign.label' }],
    ['program arguments', { ...legacy, ProgramArguments: [node, path.join(project, 'dist/src/main.js'), '--extra'] }],
    ['working directory', { ...legacy, WorkingDirectory: base }],
    ['environment', { ...legacy, EnvironmentVariables: { ...environment, EXTRA: '1' } }],
    ['run at load', { ...legacy, RunAtLoad: false }],
    ['keep alive', { ...legacy, KeepAlive: false }],
    ['throttle interval', { ...legacy, ThrottleInterval: 11 }],
    ['stdout path', { ...legacy, StandardOutPath: path.join(base, 'other.stdout') }],
    ['stderr path', { ...legacy, StandardErrorPath: path.join(base, 'other.stderr') }],
    ['extra top-level key', { ...legacy, Extra: true }]
  ];
  for (const [name, modified] of cases) {
    const bytes = Buffer.from(plistXml(modified));
    await writeFile(target, bytes, { mode: 0o600 });
    const driver = new FakeDriver();
    await assert.rejects(
      migrateLegacyServer({ stateDir, base: project, node, launchAgentsDir: launchDir, driver, parsePlist: async () => modified }),
      /modified or foreign|exact documented legacy/i,
      name
    );
    assert.deepEqual(await readFile(target), bytes, `${name}: installed bytes changed`);
    assert.deepEqual(driver.calls, [], `${name}: service driver was touched`);
  }
  await rm(base, { recursive: true, force: true });
});

test('start refuses an unexpected foreign plist without overwrite', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-foreign-plist-'));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, 'dist/src'), { recursive: true });
  await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const launchDir = path.join(base, 'LaunchAgents');
  await mkdir(launchDir, { recursive: true });
  const target = path.join(launchDir, 'local.repo-mcp.server.plist');
  const foreign = {
    Label: 'foreign.service', ProgramArguments: [process.execPath, '/tmp/foreign.js'], WorkingDirectory: project,
    EnvironmentVariables: {}, RunAtLoad: true, KeepAlive: true, ThrottleInterval: 10,
    StandardOutPath: path.join(base, 'foreign.out'), StandardErrorPath: path.join(base, 'foreign.err')
  };
  const bytes = Buffer.from(plistXml(foreign));
  await writeFile(target, bytes, { mode: 0o600 });
  const driver = new FakeDriver();
  await assert.rejects(
    installOrReloadStable(active('task-a', root, stateDir), { base: project, node: process.execPath, launchAgentsDir: launchDir, driver, parsePlist: async () => foreign }),
    /unexpected or modified/i
  );
  assert.deepEqual(await readFile(target), bytes);
  assert.equal(driver.calls.includes('bootstrap'), false);
  await rm(base, { recursive: true, force: true });
});

test('start refuses an occupied configured port before bootstrap', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-port-collision-'));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, 'dist/src'), { recursive: true });
  await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const launchDir = path.join(base, 'LaunchAgents');
  const driver = new FakeDriver();
  driver.occupied = true;
  await assert.rejects(
    installOrReloadStable(active('task-a', root, stateDir), { base: project, node: process.execPath, launchAgentsDir: launchDir, driver }),
    /port 8787 is occupied/i
  );
  assert.equal(driver.calls.includes('bootstrap'), false);
  assert.match(await readFile(path.join(launchDir, 'local.repo-mcp.server.plist'), 'utf8'), /service-main\.js/);
  await rm(base, { recursive: true, force: true });
});

test('coordinator refuses implicit adoption of a pre-hardening task ID', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-old-task-'));
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const policy = migrateV1(defaultPolicy);
  const digest = policyDigest(policy);
  const store = await StateStore.open(stateDir);
  await store.write('tasks/legacy-task/binding.json', 'binding', await legacyBinding(root, 'legacy-task', digest));
  await store.write('tasks/legacy-task/phase.json', 'phase', { phase: 'coding' });
  const policyPath = path.join(base, 'policy.json');
  await writeFile(policyPath, JSON.stringify(policy));
  await assert.rejects(coordinatorBind({ stateDir, taskId: 'legacy-task', repo: root, policyPath }), /pre-hardening binding/i);
  await rm(base, { recursive: true, force: true });
});

test('direct tracked startup refuses the same unmarked pre-hardening binding as coordinator bind', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-direct-legacy-'));
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const policy = migrateV1(defaultPolicy);
  const digest = policyDigest(policy);
  const taskId = 'legacy-direct';
  const store = await StateStore.open(stateDir);
  const binding = await legacyBinding(root, taskId, digest);
  await store.write(`tasks/${taskId}/binding.json`, 'binding', binding);
  await store.write(`tasks/${taskId}/phase.json`, 'phase', { phase: 'coding' });
  const policyPath = path.join(base, 'policy.json');
  await writeFile(policyPath, JSON.stringify(policy));

  await assert.rejects(coordinatorBind({ stateDir, taskId, repo: root, policyPath }), /pre-hardening|protocol/i);
  let service: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    service = await startServer(root, 0, undefined, policy, { task: { stateDir, taskId } });
    assert.fail('direct tracked startup reopened an unmarked pre-hardening task');
  } catch (error) {
    assert.match(error instanceof Error ? error.message : String(error), /pre-hardening|protocol|Stage 1/i);
  } finally {
    await service?.close();
  }
  assert.equal(await store.read(`tasks/${taskId}/protocol.json`, 'task-protocol'), undefined);
  await rm(base, { recursive: true, force: true });
});

test('Stage 1 rejects finish --commit in CLI and production without publishing completion', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-finish-commit-'));
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const policyPath = path.join(base, 'policy.json');
  await writeFile(policyPath, JSON.stringify(migrateV1(defaultPolicy)));
  await coordinatorBind({ stateDir, taskId: 'commit-task', repo: root, policyPath });
  const sha = 'a'.repeat(40);

  const cli = spawnSync(process.execPath, [
    '--import', 'tsx', path.join(projectRoot, 'scripts/coordinator.ts'),
    'task', 'finish', '--task', 'commit-task', '--commit', sha, '--state-dir', stateDir
  ], { cwd: projectRoot, encoding: 'utf8' });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /commit|unknown option/i);
  await assert.rejects(
    coordinatorFinish({ stateDir, result: 'committed', commitSha: sha }),
    /Stage 3|not supported.*commit|abandon/i
  );
  const store = await StateStore.open(stateDir);
  assert.equal(await store.read('tasks/commit-task/completion.json', 'completion'), undefined);
  assert.equal((await taskStatus(stateDir, 'commit-task')).completion, null);
  await rm(base, { recursive: true, force: true });
});

test('task open and completion are serialized so completion and live writable ownership cannot coexist', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-open-finish-race-'));
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const taskId = 'race-task';
  const policy = migrateV1(defaultPolicy);
  const digest = policyDigest(policy);
  await bindTask(stateDir, taskId, root, digest);
  const store = await StateStore.open(stateDir);
  const barrier = await acquireLock(store, `task-${taskId}-gate`, 'test lifecycle barrier');
  const identity = await resolveIdentity(root);

  const completionPromise = completeTask(stateDir, taskId, { result: 'abandoned' });
  await new Promise(resolve => setTimeout(resolve, 40));
  const openPromise = TaskContext.open({ stateDir, taskId, policyDigest: digest }, identity);
  await new Promise(resolve => setTimeout(resolve, 40));
  await barrier.release();

  const [completionResult, openResult] = await Promise.allSettled([completionPromise, openPromise]);
  const fulfilled = [completionResult, openResult].filter(result => result.status === 'fulfilled');
  if (openResult.status === 'fulfilled') await openResult.value.close();
  assert.equal(fulfilled.length, 1, 'completion and writable task ownership must be mutually exclusive');
  const completion = await store.read(`tasks/${taskId}/completion.json`, 'completion');
  const writer = await store.read(`locks/${checkoutLockKey(identity.root, identity.git_dir)}.json`, 'lock');
  assert.ok(!(completion && writer), 'terminal completion must never coexist with a checkout writer record');
  await rm(base, { recursive: true, force: true });
});

test('service control refuses a loaded same-label job whose in-memory definition differs from the trusted plist', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-loaded-job-mismatch-'));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, 'dist/src'), { recursive: true });
  await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const launchDir = path.join(base, 'LaunchAgents');
  await mkdir(launchDir, { recursive: true });
  const target = path.join(launchDir, 'local.repo-mcp.server.plist');
  const definition = stableServerPlist({ base: project, node: process.execPath, stateDir });
  const bytes = Buffer.from(plistXml(definition));
  await writeFile(target, bytes, { mode: 0o600 });
  await writeTrustedInstall(stateDir, target, bytes);
  const desired = active('task-a', root, stateDir);
  const driver = new FakeDriver({
    ok: true, name: 'repo-mcp', server_version: RELEASE_VERSION,
    service_generation: desired.generation, task_id: desired.task_id, root_digest: desired.root_digest, process_pid: 333
  });
  driver.loaded = true;
  driver.job = { pid: 333, plist_path: target, definition: { ...definition, WorkingDirectory: base } };
  await assert.rejects(
    installOrReloadStable(desired, { base: project, node: process.execPath, launchAgentsDir: launchDir, driver, parsePlist: async () => definition }),
    /loaded.*definition|in-memory|mismatch|refusing.*control/i
  );
  assert.equal(driver.calls.includes('kickstart'), false);
  assert.equal(driver.calls.includes('bootout'), false);
  await rm(base, { recursive: true, force: true });
});

test('legacy migration ties the loopback responder to the inspected launchd PID before bootout', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-legacy-pid-'));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, 'dist/src'), { recursive: true });
  await writeFile(path.join(project, 'dist/src/main.js'), '// legacy\n');
  await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
  const repo = await fixture(base, 'repo');
  const policy = path.join(base, 'policy.json');
  await writeFile(policy, '{}\n');
  const stateDir = path.join(base, 'state');
  const launchDir = path.join(base, 'LaunchAgents');
  await mkdir(launchDir, { recursive: true });
  const target = path.join(launchDir, 'local.repo-mcp.server.plist');
  const legacy = legacyServerPlist({ base: project, node: process.execPath, repo, policy, port: '8787' });
  const legacyBytes = Buffer.from(plistXml(legacy));
  await writeFile(target, legacyBytes, { mode: 0o600 });
  const driver = new FakeDriver({ ok: true, name: 'repo-mcp' });
  driver.loaded = true;
  driver.occupied = true;
  driver.job = { pid: 444, plist_path: target, definition: legacy };
  driver.portPid = 555;
  await assert.rejects(
    migrateLegacyServer({ stateDir, base: project, node: process.execPath, launchAgentsDir: launchDir, driver, parsePlist: async () => legacy }),
    /PID|port owner|same process|responder/i
  );
  assert.equal(driver.calls.includes('bootout'), false);
  assert.deepEqual(await readFile(target), legacyBytes, 'pre-claim launchd/PID verification failure must leave the legacy plist unchanged');
  const store = await StateStore.open(stateDir);
  assert.equal(await store.read('control/install.json', 'install'), undefined, 'pre-claim verification failure must not publish a migration transaction');
  await rm(base, { recursive: true, force: true });
});

test('local MCP readiness requires a live same-task writer lock tied to the serving process', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-local-ready-lock-'));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, 'dist/src'), { recursive: true });
  await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const launchDir = path.join(base, 'LaunchAgents');
  await mkdir(launchDir, { recursive: true });
  const target = path.join(launchDir, 'local.repo-mcp.server.plist');
  const definition = stableServerPlist({ base: project, node: process.execPath, stateDir });
  const bytes = Buffer.from(plistXml(definition));
  await writeFile(target, bytes, { mode: 0o600 });
  await writeTrustedInstall(stateDir, target, bytes);
  const desired = active('task-a', root, stateDir);
  const driver = new FakeDriver({
    ok: true, name: 'repo-mcp', server_version: RELEASE_VERSION,
    service_generation: desired.generation, task_id: desired.task_id, root_digest: desired.root_digest, process_pid: 777
  });
  driver.loaded = true;
  driver.occupied = true;
  driver.portPid = 777;
  driver.job = { pid: 777, plist_path: target, definition };

  const common = { base: project, launchAgentsDir: launchDir, driver, parsePlistBytes: async () => definition };
  assert.equal((await serviceStatus(desired, { ...common, writerLock: { state: 'absent', key: 'checkout-x' } })).local_mcp, 'blocked');
  assert.equal((await serviceStatus(desired, { ...common, writerLock: { state: 'stale', key: 'checkout-x', pid: 777, purpose: 'task task-a' } })).local_mcp, 'blocked');
  assert.equal((await serviceStatus(desired, { ...common, writerLock: { state: 'live', key: 'checkout-x', pid: 777, purpose: 'task task-b' } })).local_mcp, 'blocked');
  assert.equal((await serviceStatus(desired, { ...common, writerLock: { state: 'live', key: 'checkout-x', pid: 778, purpose: 'task task-a' } })).local_mcp, 'blocked');
  assert.equal((await serviceStatus(desired, { ...common, writerLock: { state: 'live', key: 'checkout-x', pid: 777, purpose: 'task task-a' } })).local_mcp, 'ready');
  await rm(base, { recursive: true, force: true });
});

test('prepared plist transactions reconcile fresh-install crash boundaries', async () => {
  for (const installedDesired of [false, true]) {
    const base = await realpath(await tmp('repo-mcp-stage1-fresh-txn-'));
    const project = path.join(base, 'project');
    await mkdir(path.join(project, 'dist/src'), { recursive: true });
    await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
    const root = await fixture(base, 'repo');
    const stateDir = path.join(base, 'state');
    const launchDir = path.join(base, 'LaunchAgents');
    await mkdir(launchDir, { recursive: true });
    const target = path.join(launchDir, 'local.repo-mcp.server.plist');
    const definition = stableServerPlist({ base: project, node: process.execPath, stateDir });
    const bytes = Buffer.from(plistXml(definition));
    const desiredHash = sha256(bytes);
    if (installedDesired) await writeFile(target, bytes, { mode: 0o600 });
    const store = await StateStore.open(stateDir);
    await store.write('control/install.json', 'install', {
      label: 'local.repo-mcp.server', target, installed_plist_sha256: null,
      plist_transaction: { previous_sha256: null, desired_sha256: desiredHash },
      updated_at: '2026-10-02T00:00:00.000Z'
    });
    const desired = active('task-a', root, stateDir);
    const driver = new FakeDriver({
      ok: true, name: 'repo-mcp', server_version: RELEASE_VERSION,
      service_generation: desired.generation, task_id: desired.task_id, root_digest: desired.root_digest, process_pid: 101
    });
    driver.nextJob = { pid: 101, plist_path: target, definition };
    await installOrReloadStable(desired, { base: project, node: process.execPath, launchAgentsDir: launchDir, driver });
    const record = await store.read<Record<string, unknown>>('control/install.json', 'install');
    assert.equal(record?.installed_plist_sha256, desiredHash);
    assert.equal(record?.plist_transaction, undefined);
    assert.deepEqual(await readFile(target), bytes);
    await rm(base, { recursive: true, force: true });
  }
});

test('prepared plist transactions reconcile trusted-upgrade crash boundaries', async () => {
  for (const installedDesired of [false, true]) {
    const base = await realpath(await tmp('repo-mcp-stage1-upgrade-txn-'));
    const project = path.join(base, 'project');
    await mkdir(path.join(project, 'dist/src'), { recursive: true });
    await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
    const root = await fixture(base, 'repo');
    const stateDir = path.join(base, 'state');
    const launchDir = path.join(base, 'LaunchAgents');
    await mkdir(launchDir, { recursive: true });
    const target = path.join(launchDir, 'local.repo-mcp.server.plist');
    const previousDefinition = stableServerPlist({ base: project, node: '/old/node', stateDir });
    const desiredDefinition = stableServerPlist({ base: project, node: process.execPath, stateDir });
    const previousBytes = Buffer.from(plistXml(previousDefinition));
    const desiredBytes = Buffer.from(plistXml(desiredDefinition));
    const previousHash = sha256(previousBytes);
    const desiredHash = sha256(desiredBytes);
    await writeFile(target, installedDesired ? desiredBytes : previousBytes, { mode: 0o600 });
    const store = await StateStore.open(stateDir);
    await store.write('control/install.json', 'install', {
      label: 'local.repo-mcp.server', target, installed_plist_sha256: previousHash,
      plist_transaction: { previous_sha256: previousHash, desired_sha256: desiredHash, previous_definition: previousDefinition, desired_definition: desiredDefinition },
      updated_at: '2026-10-02T00:00:00.000Z'
    });
    const desired = active('task-a', root, stateDir);
    const driver = new FakeDriver({
      ok: true, name: 'repo-mcp', server_version: RELEASE_VERSION,
      service_generation: desired.generation, task_id: desired.task_id, root_digest: desired.root_digest, process_pid: 102
    });
    driver.loaded = true;
    driver.occupied = true;
    driver.job = { pid: 91, plist_path: target, definition: previousDefinition };
    driver.portPid = 91;
    driver.nextJob = { pid: 102, plist_path: target, definition: desiredDefinition };
    await installOrReloadStable(desired, { base: project, node: process.execPath, launchAgentsDir: launchDir, driver });
    const record = await store.read<Record<string, unknown>>('control/install.json', 'install');
    assert.equal(record?.installed_plist_sha256, desiredHash);
    assert.equal(record?.plist_transaction, undefined);
    assert.deepEqual(await readFile(target), desiredBytes);
    await rm(base, { recursive: true, force: true });
  }
});

test('start --recover-stale never recovers the global coordinator lock, while exact task writer recovery still works', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-global-stale-'));
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const store = await StateStore.open(stateDir);
  const globalStale = {
    pid: 2147483647, hostname: os.hostname(), token: 'global-stale-token',
    purpose: 'finish active task', acquired_at: '2026-10-02T00:00:00.000Z'
  };
  await store.write('locks/coordinator-v1.json', 'lock', globalStale);
  await assert.rejects(coordinatorStart({ stateDir, recoverStale: true }), /Stale lock coordinator-v1|global coordinator/i);
  assert.deepEqual(await store.read('locks/coordinator-v1.json', 'lock'), globalStale);

  await store.remove('locks/coordinator-v1.json');
  const policyPath = path.join(base, 'policy.json');
  await writeFile(policyPath, JSON.stringify(migrateV1(defaultPolicy)));
  await coordinatorBind({ stateDir, taskId: 'task-a', repo: root, policyPath });
  assert.equal((await readActiveService(store))?.task_id, 'task-a');
  const binding = await taskStatus(stateDir, 'task-a');
  const key = checkoutLockKey(binding.root, binding.git_dir);
  await store.write(`locks/${key}.json`, 'lock', {
    pid: 2147483647, hostname: os.hostname(), token: 'task-stale-token',
    purpose: 'task task-a', acquired_at: '2026-10-02T00:00:00.000Z'
  });
  await recoverTaskStaleLocks(stateDir, 'task-a');
  assert.equal(await store.read(`locks/${key}.json`, 'lock'), undefined);
  await rm(base, { recursive: true, force: true });
});

test('loaded service health PID must match the inspected launchd process PID', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-loaded-pid-mismatch-'));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, 'dist/src'), { recursive: true });
  await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const launchDir = path.join(base, 'LaunchAgents');
  await mkdir(launchDir, { recursive: true });
  const target = path.join(launchDir, 'local.repo-mcp.server.plist');
  const definition = stableServerPlist({ base: project, node: process.execPath, stateDir });
  const bytes = Buffer.from(plistXml(definition));
  await writeFile(target, bytes, { mode: 0o600 });
  await writeTrustedInstall(stateDir, target, bytes);
  const desired = active('task-a', root, stateDir);
  const driver = new FakeDriver({
    ok: true, name: 'repo-mcp', server_version: RELEASE_VERSION,
    service_generation: desired.generation, task_id: desired.task_id, root_digest: desired.root_digest, process_pid: 334
  });
  driver.loaded = true;
  driver.job = { pid: 333, plist_path: target, definition };
  await assert.rejects(
    installOrReloadStable(desired, { base: project, node: process.execPath, launchAgentsDir: launchDir, driver, parsePlist: async () => definition }),
    /PID|process.*mismatch|launchd process/i
  );
  await rm(base, { recursive: true, force: true });
});

test('bind compiles policy before publishing task or active-service state', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-bind-policy-'));
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const policyPath = path.join(base, 'invalid-policy.json');
  const policy = migrateV1(defaultPolicy);
  policy.checks = [{ id: 'named-check', path: 'test/clamp.test.js' }];
  await writeFile(policyPath, JSON.stringify(policy));
  await assert.rejects(
    coordinatorBind({ stateDir, taskId: 'compile-invalid', repo: root, policyPath }),
    /named check|check id|not supported/i
  );
  const store = await StateStore.open(stateDir);
  assert.equal(await store.read('tasks/compile-invalid/protocol.json', 'task-protocol'), undefined);
  assert.equal(await store.read('tasks/compile-invalid/binding.json', 'binding'), undefined);
  assert.equal(await store.read('tasks/compile-invalid/phase.json', 'phase'), undefined);
  assert.equal(await readActiveService(store), undefined);
  await rm(base, { recursive: true, force: true });
});

test('new-task bind recovers exact protocol-only and protocol-plus-binding crash states idempotently', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-bind-crash-'));
  const root = await fixture(base, 'repo');
  const digest = policyDigest(migrateV1(defaultPolicy));
  const binding = await legacyBinding(root, 'placeholder', digest);
  const protocolFor = (taskId: string) => ({
    protocol: 'v1-stage1',
    root: binding.root,
    git_dir: binding.git_dir,
    common_dir: binding.common_dir,
    branch: binding.branch,
    head: binding.head,
    allow_detached: false,
    policy_digest: digest,
    created_at: '2026-10-02T00:00:00.000Z'
  });

  for (const state of ['protocol-only', 'protocol-binding', 'complete'] as const) {
    const taskId = `partial-${state}`;
    const stateDir = path.join(base, state);
    const store = await StateStore.open(stateDir);
    const protocol = protocolFor(taskId);
    const taskBinding = { ...binding, task_id: taskId };
    if (state !== 'complete') await store.write(`tasks/${taskId}/protocol.json`, 'task-protocol', protocol);
    if (state === 'protocol-binding') await store.write(`tasks/${taskId}/binding.json`, 'binding', taskBinding);
    if (state === 'complete') await bindTask(stateDir, taskId, root, digest);

    const result = await bindTask(stateDir, taskId, root, digest);
    assert.equal(result.task_id, taskId, state);
    assert.equal((await store.read<{ phase: string }>(`tasks/${taskId}/phase.json`, 'phase'))?.phase, 'coding', state);
    assert.ok(await store.read(`tasks/${taskId}/protocol.json`, 'task-protocol'), state);
    assert.ok(await store.read(`tasks/${taskId}/binding.json`, 'binding'), state);
  }
  await rm(base, { recursive: true, force: true });
});

test('status on nonexistent operator state is read-only and does not create the directory', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-status-no-create-'));
  const stateDir = path.join(base, 'does-not-exist');
  const result = await coordinatorStatus({ stateDir });
  assert.equal(result.state, 'unbound');
  const exists = await stat(stateDir).then(() => true).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  });
  assert.equal(exists, false);
  await rm(base, { recursive: true, force: true });
});

test('status reports operator-state permission anomalies without repairing them', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-status-perms-'));
  const stateDir = path.join(base, 'state');
  await mkdir(stateDir, { mode: 0o755 });
  await chmod(stateDir, 0o755);
  const before = (await stat(stateDir)).mode & 0o777;
  await assert.rejects(coordinatorStatus({ stateDir }), /permission|0700|operator state/i);
  const after = (await stat(stateDir)).mode & 0o777;
  assert.equal(before, 0o755);
  assert.equal(after, before);
  await rm(base, { recursive: true, force: true });
});

test('rebind publication fails at pre-publication and rename-to-directory-fsync faults, then retries cleanly', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-rebind-atomic-'));
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const digestA = policyDigest(migrateV1(defaultPolicy));
  const alternate = migrateV1(defaultPolicy);
  alternate.write.include = [];
  const digestB = policyDigest(alternate);
  const taskId = 'atomic-rebind';
  await bindTask(stateDir, taskId, root, digestA);
  const store = await StateStore.open(stateDir);
  const protocolBefore = await store.read(`tasks/${taskId}/protocol.json`, 'task-protocol');
  const bindingBefore = await store.read<{ policy_digest: string }>(`tasks/${taskId}/binding.json`, 'binding');
  const originalWrite = StateStore.prototype.write;

  try {
    StateStore.prototype.write = (async function (this: StateStore, rel: string, kind: string, data: unknown) {
      if (rel === `tasks/${taskId}/binding.json`) throw new Error('injected before binding publication');
      return originalWrite.call(this, rel, kind, data);
    }) as typeof StateStore.prototype.write;
    await assert.rejects(rebindTask(stateDir, taskId, root, { policyDigest: digestB }), /injected before/);
  } finally {
    StateStore.prototype.write = originalWrite;
  }
  assert.deepEqual(await store.read(`tasks/${taskId}/binding.json`, 'binding'), bindingBefore);
  assert.deepEqual(await store.read(`tasks/${taskId}/protocol.json`, 'task-protocol'), protocolBefore);

  const retried = await rebindTask(stateDir, taskId, root, { policyDigest: digestB });
  assert.equal(retried.policy_digest, digestB);

  try {
    StateStore.prototype.write = (async function (this: StateStore, rel: string, kind: string, data: unknown) {
      if (rel !== `tasks/${taskId}/binding.json`) return originalWrite.call(this, rel, kind, data);
      const target = path.join(stateDir, ...rel.split('/'));
      const temp = path.join(path.dirname(target), '.tmp-injected-rebind-fsync-boundary');
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: STATE_VERSION, kind, data }) + '\n', 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, target);
      throw new Error('injected directory fsync failure after binding rename');
    }) as typeof StateStore.prototype.write;
    await assert.rejects(
      rebindTask(stateDir, taskId, root, { policyDigest: digestA }),
      /directory fsync failure/
    );
  } finally {
    StateStore.prototype.write = originalWrite;
  }
  assert.equal(
    (await store.read<{ policy_digest: string }>(`tasks/${taskId}/binding.json`, 'binding'))?.policy_digest,
    digestA,
    'rename is visible even though the containing-directory fsync failed'
  );
  const retriedAfterFsyncFailure = await rebindTask(stateDir, taskId, root, { policyDigest: digestA });
  assert.equal(retriedAfterFsyncFailure.policy_digest, digestA);
  assert.deepEqual(await store.read(`tasks/${taskId}/protocol.json`, 'task-protocol'), protocolBefore);
  await rm(base, { recursive: true, force: true });
});

test('fresh stable install never overwrites an occupant that appears after absence inspection', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-fresh-interleave-'));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, 'dist/src'), { recursive: true });
  await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const launchDir = path.join(base, 'LaunchAgents');
  await mkdir(launchDir, { recursive: true });
  const target = path.join(launchDir, 'local.repo-mcp.server.plist');
  const desired = active('task-a', root, stateDir);
  const definition = stableServerPlist({ base: project, node: process.execPath, stateDir });
  const foreign = Buffer.from('foreign later occupant\n');
  const driver = new FakeDriver({
    ok: true, name: 'repo-mcp', server_version: RELEASE_VERSION,
    service_generation: desired.generation, task_id: desired.task_id, root_digest: desired.root_digest, process_pid: 901
  });
  driver.nextJob = { pid: 901, plist_path: target, definition };
  const inspect = driver.inspectLoadedJob.bind(driver);
  let inject = true;
  driver.inspectLoadedJob = async () => {
    if (inject) {
      inject = false;
      await writeFile(target, foreign, { mode: 0o600 });
    }
    return inspect();
  };

  await assert.rejects(
    installOrReloadStable(desired, { base: project, node: process.execPath, launchAgentsDir: launchDir, driver }),
    /occupied|changed|foreign|claim|refus/i
  );
  assert.deepEqual(await readFile(target), foreign);
  assert.equal(driver.calls.includes('bootstrap'), false);
  await rm(base, { recursive: true, force: true });
});

test('trusted upgrade claims exact previous bytes and never overwrites a later occupant', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-upgrade-interleave-'));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, 'dist/src'), { recursive: true });
  await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const launchDir = path.join(base, 'LaunchAgents');
  await mkdir(launchDir, { recursive: true });
  const target = path.join(launchDir, 'local.repo-mcp.server.plist');
  const previousDefinition = stableServerPlist({ base: project, node: '/old/node', stateDir });
  const previousBytes = Buffer.from(plistXml(previousDefinition));
  await writeFile(target, previousBytes, { mode: 0o600 });
  await writeTrustedInstall(stateDir, target, previousBytes);
  const desired = active('task-a', root, stateDir);
  const desiredDefinition = stableServerPlist({ base: project, node: process.execPath, stateDir });
  const foreign = Buffer.from('foreign upgrade occupant\n');
  const driver = new FakeDriver({
    ok: true, name: 'repo-mcp', server_version: RELEASE_VERSION,
    service_generation: desired.generation, task_id: desired.task_id, root_digest: desired.root_digest, process_pid: 902
  });
  driver.nextJob = { pid: 902, plist_path: target, definition: desiredDefinition };
  let inject = true;
  await assert.rejects(
    installOrReloadStable(desired, {
      base: project,
      node: process.execPath,
      launchAgentsDir: launchDir,
      driver,
      parsePlist: async () => {
        if (inject) {
          inject = false;
          await writeFile(target, foreign, { mode: 0o600 });
        }
        return previousDefinition;
      }
    }),
    /occupied|changed|foreign|claim|refus/i
  );
  assert.deepEqual(await readFile(target), foreign);
  assert.equal(driver.calls.includes('bootstrap'), false);
  await rm(base, { recursive: true, force: true });
});

test('legacy migration backs up the exact claimed bytes and never overwrites a later occupant', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-migrate-interleave-'));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, 'dist/src'), { recursive: true });
  await writeFile(path.join(project, 'dist/src/main.js'), '// legacy\n');
  await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
  const repo = await fixture(base, 'repo');
  const policy = path.join(base, 'policy.json');
  await writeFile(policy, '{}\n');
  const stateDir = path.join(base, 'state');
  const launchDir = path.join(base, 'LaunchAgents');
  await mkdir(launchDir, { recursive: true });
  const target = path.join(launchDir, 'local.repo-mcp.server.plist');
  const legacy = legacyServerPlist({ base: project, node: process.execPath, repo, policy, port: '8787' });
  const legacyBytes = Buffer.from(plistXml(legacy));
  await writeFile(target, legacyBytes, { mode: 0o600 });
  const foreign = Buffer.from('foreign migration occupant\n');
  const driver = new FakeDriver();
  let inject = true;

  await assert.rejects(
    migrateLegacyServer({
      stateDir,
      base: project,
      node: process.execPath,
      launchAgentsDir: launchDir,
      driver,
      parsePlist: async () => {
        if (inject) {
          inject = false;
          await writeFile(target, foreign, { mode: 0o600 });
        }
        return legacy;
      }
    }),
    /occupied|changed|foreign|claim|refus/i
  );
  assert.deepEqual(await readFile(target), foreign);
  assert.equal(driver.calls.includes('bootstrap'), false);
  const store = await StateStore.open(stateDir);
  const install = await store.read<{ legacy_backup_path?: string }>('control/install.json', 'install');
  if (install?.legacy_backup_path) assert.deepEqual(await readFile(install.legacy_backup_path), legacyBytes);
  await rm(base, { recursive: true, force: true });
});

test('prepared plist claim recovers after interruption between exact claim and desired publication', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-claim-recovery-'));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, 'dist/src'), { recursive: true });
  await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const launchDir = path.join(base, 'LaunchAgents');
  await mkdir(launchDir, { recursive: true });
  const target = path.join(launchDir, 'local.repo-mcp.server.plist');
  const claim = path.join(launchDir, '.local.repo-mcp.server.plist.claim-recovery');
  const previousDefinition = stableServerPlist({ base: project, node: '/old/node', stateDir });
  const desiredDefinition = stableServerPlist({ base: project, node: process.execPath, stateDir });
  const previousBytes = Buffer.from(plistXml(previousDefinition));
  const desiredBytes = Buffer.from(plistXml(desiredDefinition));
  await writeFile(claim, previousBytes, { mode: 0o600 });
  const store = await StateStore.open(stateDir);
  await store.write('control/install.json', 'install', {
    label: 'local.repo-mcp.server',
    target,
    installed_plist_sha256: sha256(previousBytes),
    plist_transaction: {
      previous_sha256: sha256(previousBytes),
      desired_sha256: sha256(desiredBytes),
      previous_definition: previousDefinition,
      desired_definition: desiredDefinition,
      claim_path: claim
    },
    updated_at: '2026-10-02T00:00:00.000Z'
  });
  const desired = active('task-a', root, stateDir);
  const driver = new FakeDriver({
    ok: true, name: 'repo-mcp', server_version: RELEASE_VERSION,
    service_generation: desired.generation, task_id: desired.task_id, root_digest: desired.root_digest, process_pid: 903
  });
  driver.nextJob = { pid: 903, plist_path: target, definition: desiredDefinition };

  await installOrReloadStable(desired, { base: project, node: process.execPath, launchAgentsDir: launchDir, driver });
  assert.deepEqual(await readFile(target), desiredBytes);
  const committed = await store.read<Record<string, unknown>>('control/install.json', 'install');
  assert.equal(committed?.plist_transaction, undefined);
  await assert.rejects(readFile(claim), /ENOENT/);
  await rm(base, { recursive: true, force: true });
});

test('plist transaction finalization refuses a later occupant after desired publication', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-finalize-interleave-'));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, 'dist/src'), { recursive: true });
  await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const launchDir = path.join(base, 'LaunchAgents');
  await mkdir(launchDir, { recursive: true });
  const target = path.join(launchDir, 'local.repo-mcp.server.plist');
  const desired = active('task-a', root, stateDir);
  const definition = stableServerPlist({ base: project, node: process.execPath, stateDir });
  const foreign = Buffer.from('later finalize occupant\n');
  const driver = new FakeDriver({
    ok: true, name: 'repo-mcp', server_version: RELEASE_VERSION,
    service_generation: desired.generation, task_id: desired.task_id, root_digest: desired.root_digest, process_pid: 904
  });
  driver.nextJob = { pid: 904, plist_path: target, definition };
  let injected = false;
  driver.portOwnerPid = async () => {
    if (!injected) {
      injected = true;
      await writeFile(target, foreign, { mode: 0o600 });
    }
    return 904;
  };

  await assert.rejects(
    installOrReloadStable(desired, { base: project, node: process.execPath, launchAgentsDir: launchDir, driver }),
    /changed before transaction commit|trusted install state/i
  );
  assert.deepEqual(await readFile(target), foreign);
  const store = await StateStore.open(stateDir);
  const install = await store.read<{ plist_transaction?: unknown }>('control/install.json', 'install');
  assert.ok(install?.plist_transaction, 'failed finalization must retain its durable transaction for recovery');
  await rm(base, { recursive: true, force: true });
});

test('launchctl print classification distinguishes exact absence from command/transport failures', async () => {
  const serviceControl = await import('../src/service-control.js') as unknown as Record<string, unknown>;
  const classify = serviceControl.classifyLaunchctlPrint as ((result: Record<string, unknown>) => unknown) | undefined;
  assert.equal(typeof classify, 'function');
  const common = {
    signal: null,
    stdout: '',
    timed_out: false,
    truncated: false,
    invalid_utf8: false,
    duration_ms: 1
  };
  assert.deepEqual(classify!({
    ...common,
    exit_code: 113,
    stderr: 'Bad request.\nCould not find service "local.repo-mcp.server" in domain for user gui: 501\n'
  }), { state: 'absent' });
  assert.deepEqual(classify!({ ...common, exit_code: 0, stdout: 'launchd job text', stderr: '' }), {
    state: 'loaded',
    stdout: 'launchd job text'
  });
  for (const result of [
    { ...common, exit_code: 1, stderr: 'unknown launchctl failure\n' },
    { ...common, exit_code: 113, stderr: 'permission denied\n' },
    { ...common, exit_code: null, timed_out: true, stderr: '' },
    { ...common, exit_code: 1, truncated: true, stderr: '' },
    { ...common, exit_code: 1, invalid_utf8: true, stderr: '' }
  ]) assert.throws(() => classify!(result), /inspect|launchd|launchctl/i);
});

test('corrupt checkout writer lock cannot be stale/readiness evidence', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-lock-status-strict-'));
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const digest = policyDigest(migrateV1(defaultPolicy));
  await bindTask(stateDir, 'task-a', root, digest);
  const binding = await taskStatus(stateDir, 'task-a');
  const key = checkoutLockKey(binding.root, binding.git_dir);
  const store = await StateStore.open(stateDir);
  await store.write(`locks/${key}.json`, 'lock', {
    pid: 2147483647,
    hostname: os.hostname(),
    purpose: 'task task-a',
    acquired_at: '2026-10-02T00:00:00.000Z'
  });
  await assert.rejects(taskWriterLockStatus(stateDir, 'task-a'), /corrupt lock record|manual inspection/i);
  await assert.rejects(recoverTaskStaleLocks(stateDir, 'task-a'), /corrupt lock record|manual inspection/i);
  assert.ok(await store.read(`locks/${key}.json`, 'lock'));
  await rm(base, { recursive: true, force: true });
});

test('policy rebind makes local readiness blocked until active service policy matches the task binding', async () => {
  const digestA = 'a'.repeat(64);
  const digestB = 'b'.repeat(64);
  assert.equal((coordinatorOverallState as (value: Record<string, unknown>) => string)({
    completion: false,
    local_mcp: 'ready',
    identity_matches: true,
    policy_matches: false,
    tunnel: 'ready',
    chatgpt_route: 'verified'
  }), 'blocked');

  const coordinator = await import('../src/coordinator.js') as unknown as Record<string, unknown>;
  const reconcile = coordinator.reconcileCoordinatorLocalPolicy as ((local: string, activeDigest: string, boundDigest: string | undefined) => unknown) | undefined;
  assert.equal(typeof reconcile, 'function');
  assert.deepEqual(reconcile!('ready', digestA, digestB), {
    local_mcp: 'blocked',
    policy_matches: false,
    active_policy_digest: digestA,
    bound_policy_digest: digestB
  });
  assert.deepEqual(reconcile!('ready', digestA, digestA), {
    local_mcp: 'ready',
    policy_matches: true,
    active_policy_digest: digestA,
    bound_policy_digest: digestA
  });
});

test('multi-repository coordinator CLI rejects extra positionals and out-of-command options', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-cli-contract-'));
  const stateDir = path.join(base, 'state');
  const run = (...args: string[]) => spawnSync(process.execPath, [
    '--import', 'tsx', path.join(projectRoot, 'scripts/coordinator.ts'), ...args, '--state-dir', stateDir
  ], { cwd: projectRoot, encoding: 'utf8' });

  const extra = run('service', 'status', 'extra');
  assert.notEqual(extra.status, 0);
  assert.match(extra.stderr, /Use: coord|single-active CLI/i);

  const startTask = run('service', 'start', '--task', 'not-valid-here');
  assert.notEqual(startTask.status, 0);
  assert.match(startTask.stderr, /--task.*not valid.*service start/i);

  const repositoryPort = run('repository', 'list', '--port', '9000');
  assert.notEqual(repositoryPort.status, 0);
  assert.match(repositoryPort.stderr, /--port.*not valid.*repository list/i);

  const resolveMissing = run('repository', 'resolve');
  assert.notEqual(resolveMissing.status, 0);
  assert.match(resolveMissing.stderr, /resolve requires --repo/i);

  const legacyStatusTask = run('status', '--task', 'not-valid-here');
  assert.notEqual(legacyStatusTask.status, 0);
  assert.match(legacyStatusTask.stderr, /--task.*not valid.*status/i);

  const finishJson = run('task', 'finish', '--task', 't1', '--json');
  assert.notEqual(finishJson.status, 0);
  assert.match(finishJson.stderr, /--json.*not valid.*task finish/i);

  const recoverControlTask = run('service', 'recover-stale-control', '--task', 'not-valid-here');
  assert.notEqual(recoverControlTask.status, 0);
  assert.match(recoverControlTask.stderr, /--task.*not valid.*service recover-stale-control/i);

  const recoverWorkspaceMissing = run('workspace', 'recover-stale');
  assert.notEqual(recoverWorkspaceMissing.status, 0);
  assert.match(recoverWorkspaceMissing.stderr, /requires --workspace/i);

  const gcPlan = run('gc', '--dry-run', '--json');
  assert.equal(gcPlan.status, 0, gcPlan.stderr);
  assert.equal(JSON.parse(gcPlan.stdout).mode, 'dry-run');
  await assert.rejects(stat(stateDir), { code: 'ENOENT' });

  const contradictoryGc = run('gc', '--dry-run', '--apply');
  assert.notEqual(contradictoryGc.status, 0);
  assert.match(contradictoryGc.stderr, /only one of --apply or --dry-run/i);

  const invalidGcRetention = run('gc', '--auth-retention-hours=-1');
  assert.notEqual(invalidGcRetention.status, 0);
  assert.match(invalidGcRetention.stderr, /decimal integer/i);
  await rm(base, { recursive: true, force: true });
});

test('Python installer uses the shared serialized exact-claim/create-if-absent plist contract', async () => {
  const source = await readFile(path.join(projectRoot, 'scripts/install-server-service.py'), 'utf8');
  const tsSource = await readFile(path.join(projectRoot, 'src/service-control.ts'), 'utf8');
  assert.match(source, /service-plist|plist-writer|plist.*lock/i);
  assert.match(source, /claim/i);
  assert.match(source, /FileExistsError|EEXIST|create-if-absent|link\(/i);
  assert.match(source, /cleanup_pending/);
  assert.match(source, /cleanup_claim\s*=\s*read_claim_bytes\(claim\)/);
  assert.match(source, /\.repo-mcp-service-control/);
  assert.match(source, /lock_key\s*=\s*['"]service-plist-['"]\s*\+\s*hashlib\.sha256/);
  assert.match(source, /lock-recovery/);
  assert.match(source, /claim\.is_absolute\(\)/);
  assert.match(source, /claim\.parent\s*!=\s*target\.parent/);
  assert.match(source, /claim\.name\.startswith\(claim_prefix\)/);
  assert.match(source, /claim\.lstat\(\)/);
  assert.match(source, /stat\.S_ISREG/);
  assert.match(tsSource, /path\.isAbsolute\(claimPath\)/);
  assert.match(tsSource, /path\.dirname\(claimPath\)\s*!==\s*path\.dirname\(target\)/);
  assert.match(tsSource, /const prefix = claimPrefix\(target\)/);
  assert.match(tsSource, /basename\.startsWith\(prefix\)/);
  assert.match(tsSource, /lstat\(claimPath\)/);
  assert.doesNotMatch(source, /lock_path\s*=\s*state\s*\/\s*['"]locks\/service-plist/);
  assert.doesNotMatch(source, /os\.replace\(temporary, path\)/);
});

test('server installer preview is side-effect free and a second checkout cannot relocate an install', async t => {
  const base = await realpath(await tmp('repo-mcp-installer-safety-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const stateDir = path.join(home, 'Library/Application Support/repo-mcp/state');
  await mkdir(home, { recursive: true });
  const env = { ...process.env, HOME: home };
  const installer = path.join(projectRoot, 'scripts/install-server-service.py');

  const previewState = path.join(base, 'preview-state');
  const preview = spawnSync('python3', [installer, '--state-dir', previewState], {
    cwd: projectRoot, env, encoding: 'utf8'
  });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /^<\?xml version=/);
  await assert.rejects(stat(previewState), { code: 'ENOENT' });

  const installed = spawnSync('python3', [installer, '--state-dir', stateDir, '--install'], {
    cwd: projectRoot, env, encoding: 'utf8'
  });
  assert.equal(installed.status, 0, installed.stderr);
  const target = path.join(home, 'Library/LaunchAgents/local.repo-mcp.server.plist');
  const before = await readFile(target);
  const legacyPreview = path.join(
    home, 'Library/Application Support/repo-mcp/server/local.repo-mcp.server.preview.plist'
  );
  await writeFile(legacyPreview, before, { mode: 0o600 });

  const current = spawnSync('python3', [installer, '--state-dir', stateDir, '--install'], {
    cwd: projectRoot, env, encoding: 'utf8'
  });
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /Current stable definition/);
  assert.doesNotMatch(current.stdout, /service start/i);
  await assert.rejects(stat(legacyPreview), { code: 'ENOENT' });

  await writeFile(legacyPreview, 'foreign preview\n', { mode: 0o600 });
  const preserveForeign = spawnSync('python3', [installer, '--state-dir', stateDir, '--install'], {
    cwd: projectRoot, env, encoding: 'utf8'
  });
  assert.equal(preserveForeign.status, 0, preserveForeign.stderr);
  assert.equal(await readFile(legacyPreview, 'utf8'), 'foreign preview\n');
  await rm(legacyPreview);

  const serviceControl = path.join(home, 'Library/LaunchAgents/.repo-mcp-service-control');
  await rm(serviceControl, { recursive: true, force: true });

  const other = path.join(base, 'other-checkout');
  await mkdir(path.join(other, 'scripts'), { recursive: true });
  await mkdir(path.join(other, 'dist/src'), { recursive: true });
  await writeFile(path.join(other, 'scripts/install-server-service.py'), await readFile(installer));
  await writeFile(
    path.join(other, 'scripts/prerequisites.py'),
    await readFile(path.join(projectRoot, 'scripts/prerequisites.py'))
  );
  await writeFile(path.join(other, 'dist/src/service-main.js'), '// alternate checkout\n');

  const relocation = spawnSync('python3', [
    path.join(other, 'scripts/install-server-service.py'), '--state-dir', stateDir, '--install'
  ], { cwd: other, env, encoding: 'utf8' });
  assert.notEqual(relocation.status, 0);
  assert.match(relocation.stderr, /bound to .*Run the installer from that control checkout.*relocation is refused/is);
  assert.deepEqual(await readFile(target), before);
  await assert.rejects(stat(serviceControl), { code: 'ENOENT' });
  const installRecord = JSON.parse(await readFile(path.join(stateDir, 'control/install.json'), 'utf8'));
  assert.equal(installRecord.data.plist_transaction, undefined);
});

test('service plist writer lock serializes distinct operator state dirs for one launchd target', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-global-plist-lock-'));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, 'dist/src'), { recursive: true });
  await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
  const root = await fixture(base, 'repo');
  const stateA = path.join(base, 'state-a');
  const stateB = path.join(base, 'state-b');
  const launchDir = path.join(base, 'LaunchAgents');
  await mkdir(launchDir, { recursive: true });
  const target = path.join(launchDir, 'local.repo-mcp.server.plist');
  const desiredA = active('task-a', root, stateA);
  const definitionA = stableServerPlist({ base: project, node: process.execPath, stateDir: stateA });
  const driverA = new FakeDriver({
    ok: true, name: 'repo-mcp', server_version: RELEASE_VERSION,
    service_generation: desiredA.generation, task_id: desiredA.task_id, root_digest: desiredA.root_digest, process_pid: 811
  });
  driverA.nextJob = { pid: 811, plist_path: target, definition: definitionA };

  let releaseFirst!: () => void;
  let enteredFirst!: () => void;
  const holdFirst = new Promise<void>(resolve => { releaseFirst = resolve; });
  const firstEntered = new Promise<void>(resolve => { enteredFirst = resolve; });
  let firstInspect = true;
  driverA.inspectLoadedJob = async () => {
    driverA.calls.push('inspect');
    if (firstInspect) {
      firstInspect = false;
      enteredFirst();
      await holdFirst;
      return undefined;
    }
    return driverA.loaded ? driverA.job : undefined;
  };

  const first = installOrReloadStable(desiredA, {
    base: project, node: process.execPath, launchAgentsDir: launchDir, driver: driverA
  });
  await firstEntered;

  const lockFiles = await readdir(path.join(launchDir, '.repo-mcp-service-control', 'locks'));
  assert.equal(lockFiles.filter(name => name.endsWith('.json') && !name.includes('.recovery.')).length, 1);

  const desiredB = active('task-b', root, stateB);
  const driverB = new FakeDriver();
  await assert.rejects(
    installOrReloadStable(desiredB, {
      base: project, node: process.execPath, launchAgentsDir: launchDir, driver: driverB
    }),
    /service plist transaction|lock.*live|live process|owned/i
  );
  assert.equal(driverB.calls.length, 0, 'second state dir must not enter launchd/plist control while the canonical lock is held');

  releaseFirst();
  await first;
  await rm(base, { recursive: true, force: true });
});

test('desired-side cleanup refuses a correct-hash recorded claim outside LaunchAgents and preserves pending evidence', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-outside-cleanup-claim-'));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, 'dist/src'), { recursive: true });
  await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const launchDir = path.join(base, 'LaunchAgents');
  await mkdir(launchDir, { recursive: true });
  const target = path.join(launchDir, 'local.repo-mcp.server.plist');
  const claim = path.join(base, '.local.repo-mcp.server.plist.claim-outside');
  const previousDefinition = stableServerPlist({ base: project, node: '/old/node', stateDir });
  const desiredDefinition = stableServerPlist({ base: project, node: process.execPath, stateDir });
  const previousBytes = Buffer.from(plistXml(previousDefinition));
  const desiredBytes = Buffer.from(plistXml(desiredDefinition));
  await writeFile(target, desiredBytes, { mode: 0o600 });
  await writeFile(claim, previousBytes, { mode: 0o600 });
  const store = await StateStore.open(stateDir);
  await store.write('control/install.json', 'install', {
    label: 'local.repo-mcp.server', target, installed_plist_sha256: sha256(previousBytes),
    plist_transaction: {
      previous_sha256: sha256(previousBytes),
      desired_sha256: sha256(desiredBytes),
      claim_path: claim,
      previous_definition: previousDefinition,
      desired_definition: desiredDefinition,
      cleanup_pending: true
    },
    updated_at: '2026-10-02T00:00:00.000Z'
  });
  const desired = active('task-a', root, stateDir);
  const driver = new FakeDriver({
    ok: true, name: 'repo-mcp', server_version: RELEASE_VERSION,
    service_generation: desired.generation, task_id: desired.task_id, root_digest: desired.root_digest, process_pid: 814
  });
  driver.loaded = true;
  driver.occupied = true;
  driver.portPid = 814;
  driver.job = { pid: 814, plist_path: target, definition: desiredDefinition };

  await assert.rejects(
    installOrReloadStable(desired, { base: project, node: process.execPath, launchAgentsDir: launchDir, driver }),
    /claim.*path|claim.*parent|LaunchAgents|recorded claim/i
  );
  assert.deepEqual(await readFile(claim), previousBytes, 'outside correct-hash claim must not be deleted');
  assert.deepEqual(driver.calls, [], 'unsafe recorded claim must fail before launchd/process control');
  const retained = await store.read<{ plist_transaction?: { claim_path?: string; cleanup_pending?: boolean } }>('control/install.json', 'install');
  assert.equal(retained?.plist_transaction?.claim_path, claim);
  assert.equal(retained?.plist_transaction?.cleanup_pending, true);
  await rm(base, { recursive: true, force: true });
});

test('desired-side plist recovery rejects a corrupt surviving claim without clearing transaction evidence', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-corrupt-cleanup-claim-'));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, 'dist/src'), { recursive: true });
  await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const launchDir = path.join(base, 'LaunchAgents');
  await mkdir(launchDir, { recursive: true });
  const target = path.join(launchDir, 'local.repo-mcp.server.plist');
  const claim = path.join(launchDir, '.local.repo-mcp.server.plist.claim-corrupt');
  const previousDefinition = stableServerPlist({ base: project, node: '/old/node', stateDir });
  const desiredDefinition = stableServerPlist({ base: project, node: process.execPath, stateDir });
  const previousBytes = Buffer.from(plistXml(previousDefinition));
  const desiredBytes = Buffer.from(plistXml(desiredDefinition));
  const foreignClaim = Buffer.from('later claim occupant\n');
  await writeFile(target, desiredBytes, { mode: 0o600 });
  await writeFile(claim, foreignClaim, { mode: 0o600 });
  const store = await StateStore.open(stateDir);
  await store.write('control/install.json', 'install', {
    label: 'local.repo-mcp.server', target, installed_plist_sha256: sha256(previousBytes),
    plist_transaction: {
      previous_sha256: sha256(previousBytes),
      desired_sha256: sha256(desiredBytes),
      claim_path: claim,
      previous_definition: previousDefinition,
      desired_definition: desiredDefinition
    },
    updated_at: '2026-10-02T00:00:00.000Z'
  });
  const desired = active('task-a', root, stateDir);
  const driver = new FakeDriver({
    ok: true, name: 'repo-mcp', server_version: RELEASE_VERSION,
    service_generation: desired.generation, task_id: desired.task_id, root_digest: desired.root_digest, process_pid: 812
  });
  driver.loaded = true;
  driver.occupied = true;
  driver.portPid = 812;
  driver.job = { pid: 812, plist_path: target, definition: desiredDefinition };

  await assert.rejects(
    installOrReloadStable(desired, { base: project, node: process.execPath, launchAgentsDir: launchDir, driver }),
    /claim.*previous hash|cleanup.*claim|durable previous/i
  );
  assert.deepEqual(await readFile(claim), foreignClaim);
  assert.deepEqual(driver.calls, [], 'corrupt cleanup evidence must fail before launchd/process control');
  const retained = await store.read<{ plist_transaction?: unknown }>('control/install.json', 'install');
  assert.ok(retained?.plist_transaction);
  await rm(base, { recursive: true, force: true });
});

test('plist claim cleanup is recoverable across durable cleanup-pending and post-unlink crash boundaries', async () => {
  const setup = async (name: string, cleanupPending = false) => {
    const base = await realpath(await tmp(name));
    const project = path.join(base, 'project');
    await mkdir(path.join(project, 'dist/src'), { recursive: true });
    await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
    const root = await fixture(base, 'repo');
    const stateDir = path.join(base, 'state');
    const launchDir = path.join(base, 'LaunchAgents');
    await mkdir(launchDir, { recursive: true });
    const target = path.join(launchDir, 'local.repo-mcp.server.plist');
    const claim = path.join(launchDir, '.local.repo-mcp.server.plist.claim-cleanup');
    const previousDefinition = stableServerPlist({ base: project, node: '/old/node', stateDir });
    const desiredDefinition = stableServerPlist({ base: project, node: process.execPath, stateDir });
    const previousBytes = Buffer.from(plistXml(previousDefinition));
    const desiredBytes = Buffer.from(plistXml(desiredDefinition));
    await writeFile(target, desiredBytes, { mode: 0o600 });
    await writeFile(claim, previousBytes, { mode: 0o600 });
    const store = await StateStore.open(stateDir);
    await store.write('control/install.json', 'install', {
      label: 'local.repo-mcp.server', target, installed_plist_sha256: sha256(previousBytes),
      plist_transaction: {
        previous_sha256: sha256(previousBytes),
        desired_sha256: sha256(desiredBytes),
        claim_path: claim,
        previous_definition: previousDefinition,
        desired_definition: desiredDefinition,
        ...(cleanupPending ? { cleanup_pending: true } : {})
      },
      updated_at: '2026-10-02T00:00:00.000Z'
    });
    const desired = active('task-a', root, stateDir);
    const driver = new FakeDriver({
      ok: true, name: 'repo-mcp', server_version: RELEASE_VERSION,
      service_generation: desired.generation, task_id: desired.task_id, root_digest: desired.root_digest, process_pid: 813
    });
    driver.loaded = true;
    driver.occupied = true;
    driver.portPid = 813;
    driver.job = { pid: 813, plist_path: target, definition: desiredDefinition };
    return { base, project, stateDir, launchDir, claim, store, desired, driver };
  };

  const first = await setup('repo-mcp-stage1-cleanup-pending-');
  const originalWrite = StateStore.prototype.write;
  try {
    StateStore.prototype.write = (async function (this: StateStore, rel: string, kind: string, data: unknown) {
      const result = await originalWrite.call(this, rel, kind, data);
      const record = data as { plist_transaction?: { cleanup_pending?: boolean } };
      if (rel === 'control/install.json' && record.plist_transaction?.cleanup_pending === true) {
        throw new Error('injected after cleanup-pending publication');
      }
      return result;
    }) as typeof StateStore.prototype.write;
    await assert.rejects(
      installOrReloadStable(first.desired, {
        base: first.project, node: process.execPath, launchAgentsDir: first.launchDir, driver: first.driver
      }),
      /injected after cleanup-pending/
    );
  } finally {
    StateStore.prototype.write = originalWrite;
  }
  const pending = await first.store.read<{ plist_transaction?: { cleanup_pending?: boolean } }>('control/install.json', 'install');
  assert.equal(pending?.plist_transaction?.cleanup_pending, true);
  assert.ok(await stat(first.claim));
  await installOrReloadStable(first.desired, {
    base: first.project, node: process.execPath, launchAgentsDir: first.launchDir, driver: first.driver
  });
  assert.equal((await first.store.read<{ plist_transaction?: unknown }>('control/install.json', 'install'))?.plist_transaction, undefined);
  await assert.rejects(readFile(first.claim), /ENOENT/);
  await rm(first.base, { recursive: true, force: true });

  const second = await setup('repo-mcp-stage1-cleanup-unlink-', true);
  try {
    StateStore.prototype.write = (async function (this: StateStore, rel: string, kind: string, data: unknown) {
      const record = data as { plist_transaction?: unknown; installed_plist_sha256?: string | null };
      if (rel === 'control/install.json' && record.plist_transaction === undefined && typeof record.installed_plist_sha256 === 'string') {
        throw new Error('injected after trusted claim unlink');
      }
      return originalWrite.call(this, rel, kind, data);
    }) as typeof StateStore.prototype.write;
    await assert.rejects(
      installOrReloadStable(second.desired, {
        base: second.project, node: process.execPath, launchAgentsDir: second.launchDir, driver: second.driver
      }),
      /injected after trusted claim unlink/
    );
  } finally {
    StateStore.prototype.write = originalWrite;
  }
  await assert.rejects(readFile(second.claim), /ENOENT/);
  const stillPending = await second.store.read<{ plist_transaction?: { cleanup_pending?: boolean } }>('control/install.json', 'install');
  assert.equal(stillPending?.plist_transaction?.cleanup_pending, true);
  await installOrReloadStable(second.desired, {
    base: second.project, node: process.execPath, launchAgentsDir: second.launchDir, driver: second.driver
  });
  assert.equal((await second.store.read<{ plist_transaction?: unknown }>('control/install.json', 'install'))?.plist_transaction, undefined);
  await rm(second.base, { recursive: true, force: true });

  const third = await setup('repo-mcp-stage1-cleanup-replaced-', false);
  const replacement = Buffer.from('replacement after cleanup-pending\n');
  try {
    StateStore.prototype.write = (async function (this: StateStore, rel: string, kind: string, data: unknown) {
      const result = await originalWrite.call(this, rel, kind, data);
      const record = data as { plist_transaction?: { cleanup_pending?: boolean } };
      if (rel === 'control/install.json' && record.plist_transaction?.cleanup_pending === true) {
        await writeFile(third.claim, replacement, { mode: 0o600 });
      }
      return result;
    }) as typeof StateStore.prototype.write;
    await assert.rejects(
      installOrReloadStable(third.desired, {
        base: third.project, node: process.execPath, launchAgentsDir: third.launchDir, driver: third.driver
      }),
      /cleanup claim changed|cleanup-pending|previous hash/i
    );
  } finally {
    StateStore.prototype.write = originalWrite;
  }
  assert.deepEqual(await readFile(third.claim), replacement);
  const replacedPending = await third.store.read<{ plist_transaction?: { cleanup_pending?: boolean } }>('control/install.json', 'install');
  assert.equal(replacedPending?.plist_transaction?.cleanup_pending, true);
  await rm(third.base, { recursive: true, force: true });
});

test('lsof listener classification fails closed on signals, null exits and unrecognized empty failures', async () => {
  const serviceControl = await import('../src/service-control.js') as unknown as Record<string, unknown>;
  const classify = serviceControl.classifyLsofPortOwner as ((result: Record<string, unknown>) => number | undefined) | undefined;
  assert.equal(typeof classify, 'function');
  const common = {
    signal: null,
    stdout: '',
    stderr: '',
    timed_out: false,
    truncated: false,
    invalid_utf8: false,
    duration_ms: 1
  };
  assert.equal(classify!({ ...common, exit_code: 1 }), undefined);
  assert.equal(classify!({ ...common, exit_code: 0, stdout: '123\n' }), 123);
  for (const result of [
    { ...common, exit_code: null, signal: 'SIGKILL' },
    { ...common, exit_code: null },
    { ...common, exit_code: 2 },
    { ...common, exit_code: 1, stderr: 'permission denied\n' },
    { ...common, exit_code: 0 }
  ]) assert.throws(() => classify!(result), /listener|lsof|port/i);
});

test('coordinator status is filesystem-read-only and reports running-service binding identity drift as stale', async () => {
  const base = await realpath(await tmp('repo-mcp-stage1-status-readonly-drift-'));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, 'dist/src'), { recursive: true });
  await writeFile(path.join(project, 'dist/src/service-main.js'), '// stable\n');
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const launchDir = path.join(base, 'LaunchAgents');
  await mkdir(launchDir, { recursive: true });
  const digest = 'a'.repeat(64);
  await bindTask(stateDir, 'task-a', root, digest);
  const binding = await taskStatus(stateDir, 'task-a');
  const desired = active('task-a', root, stateDir);
  const store = await StateStore.open(stateDir);
  await store.write('control/active-service.json', 'active-service', desired);
  const definition = stableServerPlist({ base: project, node: process.execPath, stateDir });
  const bytes = Buffer.from(plistXml(definition));
  const target = path.join(launchDir, 'local.repo-mcp.server.plist');
  await writeFile(target, bytes, { mode: 0o600 });
  await writeTrustedInstall(stateDir, target, bytes);
  await store.write(`locks/${checkoutLockKey(binding.root, binding.git_dir)}.json`, 'lock', {
    pid: process.pid,
    hostname: os.hostname(),
    token: 'status-live-token',
    purpose: 'task task-a',
    acquired_at: '2026-10-03T00:00:00.000Z'
  });
  const driver = new FakeDriver({
    ok: true, name: 'repo-mcp', server_version: RELEASE_VERSION,
    service_generation: desired.generation, task_id: desired.task_id, root_digest: desired.root_digest, process_pid: process.pid
  });
  driver.loaded = true;
  driver.occupied = true;
  driver.portPid = process.pid;
  driver.job = { pid: process.pid, plist_path: target, definition };

  const serviceOptions = {
    base: project,
    launchAgentsDir: launchDir,
    driver,
    parsePlistBytes: async () => definition
  };
  const before = (await readdir(base, { recursive: true })).sort();
  const ready = await coordinatorStatus({ stateDir, serviceOptions });
  assert.equal(ready.local_mcp, 'ready');
  assert.equal(ready.state, 'degraded');
  assert.deepEqual((await readdir(base, { recursive: true })).sort(), before);

  const bindingPath = 'tasks/task-a/binding.json';
  const rawBinding = await store.read<Record<string, unknown>>(bindingPath, 'binding');
  assert.ok(rawBinding);
  await store.write(bindingPath, 'binding', {
    ...rawBinding,
    branch: `${binding.branch}-drift`,
    head: 'f'.repeat(40)
  });
  const driftBefore = (await readdir(base, { recursive: true })).sort();
  const drift = await coordinatorStatus({ stateDir, serviceOptions });
  assert.equal(drift.local_mcp, 'stale');
  assert.equal(drift.state, 'stale');
  const driftIdentity = (drift as { current_identity?: { branch?: string | null; head?: string | null } }).current_identity;
  assert.equal(driftIdentity?.branch, binding.branch);
  assert.equal(driftIdentity?.head, binding.head);
  assert.deepEqual((await readdir(base, { recursive: true })).sort(), driftBefore);

  await store.write(bindingPath, 'binding', {
    ...rawBinding,
    root: `${binding.root}-drift`
  });
  const rootDriftBefore = (await readdir(base, { recursive: true })).sort();
  const rootDrift = await coordinatorStatus({ stateDir, serviceOptions });
  assert.equal(rootDrift.local_mcp, 'stale');
  assert.equal(rootDrift.state, 'stale');
  const rootOnly = rootDrift as {
    bound_branch?: string | null;
    bound_head?: string | null;
    current_identity?: { root?: string | null };
    writer_lock?: { state?: string };
  };
  assert.equal(rootOnly.bound_branch, binding.branch);
  assert.equal(rootOnly.bound_head, binding.head);
  assert.equal(rootOnly.current_identity?.root, binding.root);
  assert.equal(rootOnly.writer_lock?.state, 'absent');
  assert.deepEqual((await readdir(base, { recursive: true })).sort(), rootDriftBefore);

  await rm(base, { recursive: true, force: true });
});
