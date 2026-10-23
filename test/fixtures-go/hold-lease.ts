// Child process for go-concurrency tests: take the setup lease, report, then hang until killed.
import { StateStore } from '../../src/task-state.js';
import { acquireSetupLease } from '../../src/go-account.js';

const lease = await acquireSetupLease(await StateStore.open(process.argv[2]), ms => new Promise(r => setTimeout(r, ms)));
void lease;
process.stdout.write('held\n');
setInterval(() => {}, 1_000);
