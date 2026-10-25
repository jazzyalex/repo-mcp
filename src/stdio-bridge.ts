import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import { RELEASE_VERSION } from './version.js';

/**
 * Generic tool names (read, edit, search, ...) can be confused with a client's own tools,
 * so the bridge exposes them with a `repo_` prefix unless asked for the original names.
 * Names that already say what they act on keep their spelling.
 */
const KEEP = /^(?:repo_|repository_|workspace_|service_)/;
export const prefixedName = (name: string) => KEEP.test(name) ? name : `repo_${name}`;

export type BridgeOptions = { url: string; token: string; originalNames?: boolean };

/**
 * A stdio MCP server that forwards tool listing and tool calls to the loopback broker,
 * adding the client token. For clients that cannot reach a loopback HTTP server with a
 * header, such as Claude Desktop chat.
 */
export async function createBridge(options: BridgeOptions) {
  const client = new Client({ name: 'repo-mcp-stdio-bridge', version: RELEASE_VERSION });
  await client.connect(new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: { headers: { Authorization: `Bearer ${options.token}` } }
  }));
  const toBroker = new Map<string, string>();
  const rename = (name: string) => options.originalNames ? name : prefixedName(name);
  const server = new Server({ name: 'repo-mcp', version: RELEASE_VERSION }, {
    capabilities: { tools: {} },
    instructions: client.getInstructions()
  });
  server.setRequestHandler('tools/list', async request => {
    const listed = await client.listTools(request.params);
    return {
      ...listed,
      tools: listed.tools.map(tool => {
        const name = rename(tool.name);
        toBroker.set(name, tool.name);
        return { ...tool, name };
      })
    };
  });
  server.setRequestHandler('tools/call', async request => {
    if (!toBroker.size) await client.listTools().then(listed => { for (const tool of listed.tools) toBroker.set(rename(tool.name), tool.name); });
    const name = toBroker.get(request.params.name);
    if (!name) return { isError: true, content: [{ type: 'text' as const, text: `Unknown tool ${request.params.name}.` }] };
    return client.callTool({ ...request.params, name });
  });
  return { server, client };
}

export function parseBridgeArgs(argv: string[]) {
  let url = 'http://127.0.0.1:8787/mcp', stateDir: string | undefined, originalNames = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') url = argv[++i] ?? '';
    else if (arg === '--state-dir') stateDir = argv[++i];
    else if (arg === '--original-names') originalNames = true;
    else throw new Error(`Unknown argument ${arg}. Use: [--url URL] [--state-dir DIR] [--original-names]`);
  }
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('--url must be a loopback http URL.');
  return { url, stateDir, originalNames };
}
