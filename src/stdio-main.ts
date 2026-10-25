import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { readClientToken } from './client-auth.js';
import { createBridge, parseBridgeArgs } from './stdio-bridge.js';
import { defaultStateDir } from './task-state.js';

// stdout carries the MCP protocol; diagnostics go to stderr only.
try {
  const args = parseBridgeArgs(process.argv.slice(2));
  const token = await readClientToken(args.stateDir ?? process.env.REPO_MCP_STATE_DIR ?? defaultStateDir());
  const { server } = await createBridge({ url: args.url, token, originalNames: args.originalNames });
  await server.connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(`repo-mcp stdio bridge: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
