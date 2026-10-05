// Coordinator-only task control. Not exposed through MCP.
// Usage: tsx scripts/task.ts <status|phase|rebind> --task ID [--state-dir DIR] [--root DIR] [--phase coding|review] [--policy FILE] [--allow-detached]
import { realpath } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { prepareValidatedTaskPolicy } from '../src/coordinator.js';
import { defaultStateDir } from '../src/task-state.js';
import { rebindTask, setTaskPhase, taskStatus, type Phase } from '../src/task.js';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  task: { type: 'string' }, 'state-dir': { type: 'string' }, root: { type: 'string' },
  phase: { type: 'string' }, policy: { type: 'string' }, 'allow-detached': { type: 'boolean' }
} });
const [command] = positionals;
const taskId = values.task;
const stateDir = values['state-dir'] ?? process.env.REPO_MCP_STATE_DIR ?? defaultStateDir();
try {
  if (!taskId) throw new Error('--task is required.');
  if (command === 'status') console.log(JSON.stringify(await taskStatus(stateDir, taskId), null, 2));
  else if (command === 'phase') { await setTaskPhase(stateDir, taskId, values.phase as Phase); console.log(`Task ${taskId} phase: ${values.phase}`); }
  else if (command === 'rebind') {
    if (!values.root) throw new Error('--root is required for rebind.');
    const root = await realpath(values.root);
    const prepared = values.policy
      ? await prepareValidatedTaskPolicy({ policyPath: values.policy, root, stateDir, taskId })
      : undefined;
    const binding = await rebindTask(stateDir, taskId, prepared?.root ?? root, {
      policyDigest: prepared?.digest,
      allowDetached: values['allow-detached']
    });
    console.log(JSON.stringify(binding, null, 2));
  } else throw new Error('Command must be status, phase or rebind.');
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
