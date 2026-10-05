import { parseArgs } from 'node:util';
import {
  coordinatorBind,
  coordinatorFinish,
  coordinatorMigrateLegacy,
  coordinatorStart,
  coordinatorStatus,
  formatCoordinatorStatusText,
  refusePreHardeningAdoption
} from '../src/coordinator.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    task: { type: 'string' },
    repo: { type: 'string' },
    policy: { type: 'string' },
    port: { type: 'string' },
    'state-dir': { type: 'string' },
    'allow-detached': { type: 'boolean' },
    'recover-stale': { type: 'boolean' },
    json: { type: 'boolean' },
    abandon: { type: 'boolean' },
    commit: { type: 'string' },
    'use-active-task': { type: 'boolean' },
    owned: { type: 'string', multiple: true }
  }
});

const [command] = positionals;
const stateDir = values['state-dir'];

const allowedOptions: Record<string, ReadonlySet<string>> = {
  bind: new Set(['task', 'repo', 'policy', 'port', 'state-dir', 'allow-detached', 'owned']),
  start: new Set(['state-dir', 'recover-stale']),
  status: new Set(['state-dir', 'json']),
  finish: new Set(['state-dir', 'abandon', 'commit']),
  'migrate-legacy': new Set(['state-dir', 'use-active-task', 'task', 'owned'])
};

try {
  if (positionals.length !== 1) throw new Error('Exactly one coordinator command positional is required.');
  const allowed = allowedOptions[command];
  if (!allowed) throw new Error('Command must be bind, start, status, finish or migrate-legacy.');
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && !allowed.has(name as keyof typeof values)) throw new Error(`--${name} is not valid for ${command}.`);
  }

  if (command === 'bind') {
    if (!values.task || !values.repo || !values.policy) throw new Error('bind requires --task, --repo and --policy.');
    if (values.owned?.length) throw new Error('--owned is part of Stage 2 authoritative claims and is not accepted by Stage 1 bind.');
    const port = values.port === undefined ? undefined : Number(values.port);
    if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error('--port must be an integer from 1024 to 65535.');
    console.log(JSON.stringify(await coordinatorBind({
      stateDir,
      taskId: values.task,
      repo: values.repo,
      policyPath: values.policy,
      port,
      allowDetached: values['allow-detached']
    }), null, 2));
  } else if (command === 'start') {
    console.log(JSON.stringify(await coordinatorStart({ stateDir, recoverStale: values['recover-stale'] }), null, 2));
  } else if (command === 'status') {
    const status = await coordinatorStatus({ stateDir });
    console.log(values.json ? JSON.stringify(status, null, 2) : formatCoordinatorStatusText(status));
  } else if (command === 'finish') {
    if (values.commit !== undefined) throw new Error('Stage 1 does not support finish --commit; verified commit handoff is unavailable until Stage 3. Use --abandon only.');
    if (!values.abandon) throw new Error('Stage 1 finish requires --abandon.');
    console.log(JSON.stringify(await coordinatorFinish({ stateDir, result: 'abandoned' }), null, 2));
  } else if (command === 'migrate-legacy') {
    if (values.task) await refusePreHardeningAdoption(values.task);
    if (values.owned?.length) throw new Error('--owned adoption is deferred with Stage 2 claims; bind a new task ID instead of inferring ownership.');
    console.log(JSON.stringify(await coordinatorMigrateLegacy({ stateDir, useActiveTask: values['use-active-task'] }), null, 2));
  } else {
    throw new Error('Command must be bind, start, status, finish or migrate-legacy.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Coordinator operation failed.');
  process.exit(1);
}
