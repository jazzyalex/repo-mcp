import type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * Return repository data through both MCP result channels.
 *
 * `content` preserves compatibility with clients that parse JSON text. The
 * stable `result` envelope keeps repository fields such as a file's own
 * `content` from colliding with MCP protocol fields in clients that consume
 * structured results.
 */
export function jsonToolResult(value: unknown): CallToolResult {
  return {
    structuredContent: { result: value },
    content: [{ type: 'text', text: JSON.stringify(value) }]
  };
}
