import { defaultStateDir } from './task-state.js';
import { getMultiRepoServiceConfig } from './multirepo-state.js';
import { startMultiRepoServer } from './multirepo-server.js';

const stateDir = process.env.REPO_MCP_STATE_DIR || defaultStateDir();
const configured = await getMultiRepoServiceConfig(stateDir);
const service = await startMultiRepoServer(stateDir, configured.port);
console.log(`Repo MCP permanent multi-repository service listening at ${service.url}; catalog revision ${configured.catalog_revision}.`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => {
  await service.close();
  process.exit(0);
});
