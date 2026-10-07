import { parseArgs } from 'node:util';
import { coordinatorMigrateLegacy, coordinatorStatus, formatCoordinatorStatusText } from '../src/coordinator.js';
import { garbageCollect } from '../src/gc.js';
import {
  bindRegisteredTask,
  configureMultiRepoService,
  finishRegisteredTask,
  getMultiRepoServiceConfig,
  issueWorkspaceGrant,
  listRegisteredRepositories,
  migrateActiveServiceToCatalog,
  readMultiRepoCatalog,
  rebindRegisteredTask,
  resolveRegisteredRepository,
  recoverMultiRepoControlLock,
  recoverWorkspaceAdmissionLock,
  registerRepository,
  rollbackActiveServiceCatalogMigration,
  removeRepository,
  revokeGrant,
  revokeWorkspace,
  setRegisteredTaskPhase,
  setRepositoryEnabled
} from '../src/multirepo-state.js';
import { brokerServiceStatus, installOrReloadBroker, stopBrokerService } from '../src/service-control.js';
import { defaultStateDir } from '../src/task-state.js';
import { recoverTaskStaleLocks, taskStatus } from '../src/task.js';
import { RELEASE_VERSION } from '../src/version.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    task: { type: 'string' },
    repository: { type: 'string' },
    name: { type: 'string' },
    repo: { type: 'string' },
    policy: { type: 'string' },
    port: { type: 'string' },
    phase: { type: 'string' },
    workspace: { type: 'string' },
    grant: { type: 'string' },
    'ttl-seconds': { type: 'string' },
    'state-dir': { type: 'string' },
    'allow-detached': { type: 'boolean' },
    'use-active-task': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    apply: { type: 'boolean' },
    'auth-retention-hours': { type: 'string' },
    'capture-retention-hours': { type: 'string' },
    'task-retention-days': { type: 'string' },
    'max-records': { type: 'string' },
    json: { type: 'boolean' }
  }
});

const [area, command] = positionals;
const stateDir = values['state-dir'] ?? process.env.REPO_MCP_STATE_DIR ?? defaultStateDir();
const asStrictInteger = (name: 'auth-retention-hours' | 'capture-retention-hours' | 'task-retention-days' | 'max-records') => {
  const raw = values[name];
  if (raw === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) throw new Error(`--${name} must be a decimal integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`--${name} is too large.`);
  return value;
};
const asPort = () => {
  if (values.port === undefined) return undefined;
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be an integer from 1024 to 65535.');
  return port;
};
const asTtlMs = () => {
  if (values['ttl-seconds'] === undefined) return undefined;
  const seconds = Number(values['ttl-seconds']);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error('--ttl-seconds must be an integer from 1 to 3600.');
  return seconds * 1000;
};
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const assertOnly = (...allowed: string[]) => {
  const allow = new Set(allowed);
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && !allow.has(name)) throw new Error(`--${name} is not valid for ${positionals.join(' ')}.`);
  }
};

try {
  if (positionals.length === 1 && area === 'status') {
    assertOnly('state-dir', 'json');
    const status = await coordinatorStatus({ stateDir });
    console.log(values.json ? JSON.stringify(status, null, 2) : formatCoordinatorStatusText(status));
  } else if (positionals.length === 1 && area === 'gc') {
    assertOnly('state-dir', 'dry-run', 'apply', 'auth-retention-hours', 'capture-retention-hours', 'task-retention-days', 'max-records', 'json');
    if (values.apply && values['dry-run']) throw new Error('coord gc accepts only one of --apply or --dry-run.');
    const summary = await garbageCollect({
      stateDir,
      apply: !!values.apply,
      authRetentionHours: asStrictInteger('auth-retention-hours'),
      captureRetentionHours: asStrictInteger('capture-retention-hours'),
      taskRetentionDays: asStrictInteger('task-retention-days'),
      maxRecords: asStrictInteger('max-records')
    });
    console.log(values.json ? JSON.stringify(summary) : JSON.stringify(summary, null, 2));
    if (!summary.complete) process.exitCode = 2;
  } else if (positionals.length !== 2) {
    throw new Error('Use: coord <service|repository|task|workspace|migration> <command>. The pre-0.2 single-active CLI no longer selects production repository scope; only read-only `coord status` remains as a compatibility alias.');
  } else if (area === 'service') {
    if (command === 'configure') {
      assertOnly('state-dir', 'port');
      const port = asPort();
      if (port === undefined) throw new Error('service configure requires --port.');
      print(await configureMultiRepoService({ stateDir, port }));
    } else if (command === 'start') {
      assertOnly('state-dir', 'port');
      const requestedPort = asPort();
      if (requestedPort !== undefined) await configureMultiRepoService({ stateDir, port: requestedPort });
      const configured = await getMultiRepoServiceConfig(stateDir);
      print(await installOrReloadBroker({ stateDir, port: configured.port, expectedServerVersion: RELEASE_VERSION }));
    } else if (command === 'status') {
      assertOnly('state-dir');
      const configured = await getMultiRepoServiceConfig(stateDir);
      print(await brokerServiceStatus({ stateDir, port: configured.port, expectedServerVersion: RELEASE_VERSION }));
    } else if (command === 'stop') {
      assertOnly('state-dir');
      const configured = await getMultiRepoServiceConfig(stateDir);
      await stopBrokerService({ stateDir, port: configured.port });
      print({ stopped: true, port: configured.port });
    } else if (command === 'migrate-legacy-plist') {
      assertOnly('state-dir', 'use-active-task');
      print(await coordinatorMigrateLegacy({ stateDir, useActiveTask: values['use-active-task'] }));
    } else if (command === 'recover-stale-control') {
      assertOnly('state-dir');
      print(await recoverMultiRepoControlLock({ stateDir }));
    } else throw new Error('service command must be configure, start, status, stop, recover-stale-control or migrate-legacy-plist.');
  } else if (area === 'repository') {
    if (command === 'add') {
      assertOnly('state-dir', 'repository', 'name', 'repo', 'policy');
      if (!values.repository || !values.repo || !values.policy) throw new Error('repository add requires --repository, --repo and --policy.');
      print(await registerRepository({
        stateDir,
        repositoryId: values.repository,
        name: values.name,
        root: values.repo,
        policyPath: values.policy
      }));
    } else if (command === 'list') {
      assertOnly('state-dir');
      print(await listRegisteredRepositories(stateDir));
    } else if (command === 'resolve') {
      assertOnly('state-dir', 'repo');
      if (!values.repo) throw new Error('repository resolve requires --repo.');
      print(await resolveRegisteredRepository(values.repo, stateDir));
    } else if (command === 'enable' || command === 'disable') {
      assertOnly('state-dir', 'repository');
      if (!values.repository) throw new Error(`repository ${command} requires --repository.`);
      print(await setRepositoryEnabled({ stateDir, repositoryId: values.repository, enabled: command === 'enable' }));
    } else if (command === 'remove') {
      assertOnly('state-dir', 'repository');
      if (!values.repository) throw new Error('repository remove requires --repository.');
      print(await removeRepository({ stateDir, repositoryId: values.repository }));
    } else throw new Error('repository command must be add, list, resolve, enable, disable or remove.');
  } else if (area === 'task') {
    if (command === 'bind') {
      assertOnly('state-dir', 'repository', 'task', 'allow-detached');
      if (!values.repository || !values.task) throw new Error('task bind requires --repository and --task.');
      print(await bindRegisteredTask({ stateDir, repositoryId: values.repository, taskId: values.task, allowDetached: values['allow-detached'] }));
    } else if (command === 'status') {
      assertOnly('state-dir', 'task');
      if (!values.task) throw new Error('task status requires --task.');
      const catalog = await readMultiRepoCatalog(stateDir);
      const registered = catalog.tasks[values.task] ?? null;
      const live = registered ? await taskStatus(stateDir, values.task, { readOnly: true }) : null;
      print({ catalog_revision: catalog.revision, registered, live });
    } else if (command === 'phase') {
      assertOnly('state-dir', 'task', 'phase');
      if (!values.task || (values.phase !== 'coding' && values.phase !== 'review')) throw new Error('task phase requires --task and --phase coding|review.');
      print(await setRegisteredTaskPhase({ stateDir, taskId: values.task, phase: values.phase }));
    } else if (command === 'rebind') {
      assertOnly('state-dir', 'task', 'allow-detached');
      if (!values.task) throw new Error('task rebind requires --task.');
      print(await rebindRegisteredTask({ stateDir, taskId: values.task, allowDetached: values['allow-detached'] }));
    } else if (command === 'recover-stale') {
      assertOnly('state-dir', 'task');
      if (!values.task) throw new Error('task recover-stale requires --task.');
      await recoverTaskStaleLocks(stateDir, values.task);
      print({ task_id: values.task, recovered: true });
    } else if (command === 'finish') {
      assertOnly('state-dir', 'task');
      if (!values.task) throw new Error('task finish requires --task. Multi-repository 0.2 supports abandonment only; commit/push remain external.');
      print(await finishRegisteredTask({ stateDir, taskId: values.task, result: 'abandoned' }));
    } else throw new Error('task command must be bind, status, phase, rebind, recover-stale or finish.');
  } else if (area === 'workspace') {
    if (command === 'grant') {
      assertOnly('state-dir', 'task', 'ttl-seconds');
      if (!values.task) throw new Error('workspace grant requires --task.');
      print(await issueWorkspaceGrant({ stateDir, taskId: values.task, ttlMs: asTtlMs() }));
    } else if (command === 'revoke') {
      assertOnly('state-dir', 'workspace', 'grant');
      if (!!values.workspace === !!values.grant) throw new Error('workspace revoke requires exactly one of --workspace or --grant.');
      print(values.workspace
        ? await revokeWorkspace({ stateDir, workspaceId: values.workspace })
        : await revokeGrant({ stateDir, grantId: values.grant! }));
    } else if (command === 'recover-stale') {
      assertOnly('state-dir', 'workspace');
      if (!values.workspace) throw new Error('workspace recover-stale requires --workspace.');
      print(await recoverWorkspaceAdmissionLock({ stateDir, workspaceId: values.workspace }));
    } else throw new Error('workspace command must be grant, revoke or recover-stale.');
  } else if (area === 'migration') {
    if (command === 'active-service') {
      assertOnly('state-dir', 'repository', 'name');
      if (!values.repository) throw new Error('migration active-service requires --repository to assign a stable operator-chosen ID.');
      print(await migrateActiveServiceToCatalog({ stateDir, repositoryId: values.repository, name: values.name }));
    } else if (command === 'rollback-active-service') {
      assertOnly('state-dir');
      print(await rollbackActiveServiceCatalogMigration({ stateDir }));
    } else throw new Error('migration command must be active-service or rollback-active-service.');
  } else {
    throw new Error('Area must be service, repository, task, workspace or migration.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Coordinator operation failed.');
  process.exit(1);
}
