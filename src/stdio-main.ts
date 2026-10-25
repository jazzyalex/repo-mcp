import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { readClientToken } from './client-auth.js';
import { createBridge, parseBridgeArgs } from './stdio-bridge.js';
import { defaultStateDir } from './task-state.js';
import { getMultiRepoServiceConfig } from './multirepo-state.js';

// stdout carries the MCP protocol; diagnostics go to stderr only.
try {
  const args = parseBridgeArgs(process.argv.slice(2));
  const stateDir = args.stateDir ?? process.env.REPO_MCP_STATE_DIR ?? defaultStateDir();
  const token = await readClientToken(stateDir);
  // Without --url, connect to the port the broker in this state directory is configured for.
  const url = args.url ?? `http://127.0.0.1:${(await getMultiRepoServiceConfig(stateDir)).port}/mcp`;
  const { server } = await createBridge({ url, token, originalNames: args.originalNames });
  await server.connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(`repo-mcp stdio bridge: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
