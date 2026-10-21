import { randomUUID } from 'node:crypto';
import { SafeError, sha256 } from './errors.js';
import { workspaceForOpenRequest, type WorkspaceSelection } from './multirepo-state.js';
import { StateStore } from './task-state.js';

// Reports that ChatGPT delivers through the `finish` MCP tool (docs/AUTONOMOUS-RUN-PLAN.md
// section B). A report is a separate immutable record per workspace; it never changes a
// run's state. The coordinator finds it through the workspace_open request ID it put in
// the prompt, and still needs a finished browser turn before it completes the run.

export const MCP_REPORT_KIND = 'mcp-report-v1';
/** Fits the 256 KiB MCP request body after JSON escaping of ordinary Markdown. */
export const MCP_REPORT_MAX_BYTES = 192 * 1024;

export type McpReportOutcome = 'ship' | 'no-ship' | 'completed';

export type McpReport = {
  workspace_id: string; repository_id: string; task_id: string; mode: string;
  outcome: McpReportOutcome; summary_markdown: string; summary_sha256: string;
  request_id: string; ack_id: string; created_at: string; provenance: 'MCP report';
};

const reportPath = (workspaceId: string) => `mcp-reports/${workspaceId}`;

/** Store this workspace's report once. The same report again returns the same ack; a different one is rejected. */
export async function recordMcpReport(stateDir: string, selection: WorkspaceSelection, input: {
  outcome: McpReportOutcome; summaryMarkdown: string; requestId: string;
}) {
  const allowed: McpReportOutcome[] = selection.mode === 'review' ? ['ship', 'no-ship'] : ['completed'];
  if (!allowed.includes(input.outcome)) {
    throw new SafeError(`A ${selection.mode} workspace reports outcome ${allowed.join(' or ')}.`);
  }
  if (!input.summaryMarkdown.trim()) throw new SafeError('The report must not be empty.');
  if (Buffer.byteLength(input.summaryMarkdown, 'utf8') > MCP_REPORT_MAX_BYTES) {
    throw new SafeError(`The report exceeds ${MCP_REPORT_MAX_BYTES} bytes; shorten it. It is never truncated.`);
  }
  const store = await StateStore.open(stateDir);
  const digest = sha256(input.summaryMarkdown);
  const record: McpReport = {
    workspace_id: selection.workspace_id, repository_id: selection.repository_id, task_id: selection.task_id,
    mode: selection.mode, outcome: input.outcome, summary_markdown: input.summaryMarkdown, summary_sha256: digest,
    request_id: input.requestId, ack_id: randomUUID(), created_at: new Date().toISOString(), provenance: 'MCP report'
  };
  if (await store.create(reportPath(selection.workspace_id), MCP_REPORT_KIND, record)) {
    return { ack_id: record.ack_id, summary_sha256: digest, outcome: record.outcome, already_applied: false };
  }
  const prior = validReport(await store.read<McpReport>(reportPath(selection.workspace_id), MCP_REPORT_KIND));
  if (!prior || prior.summary_sha256 !== digest || prior.outcome !== input.outcome) {
    throw new SafeError('A different report was already delivered for this workspace; reports are immutable.');
  }
  return { ack_id: prior.ack_id, summary_sha256: digest, outcome: prior.outcome, already_applied: true };
}

/** The report for the workspace opened with `workspaceRequestId`, or undefined if none was delivered. */
export async function readMcpReportForRequest(stateDir: string, workspaceRequestId: string) {
  const selection = await workspaceForOpenRequest(stateDir, workspaceRequestId);
  if (!selection) return undefined;
  const store = await StateStore.inspect(stateDir);
  const report = validReport(await store?.read<McpReport>(reportPath(selection.workspace_id), MCP_REPORT_KIND));
  if (!report || report.workspace_id !== selection.workspace_id || report.repository_id !== selection.repository_id ||
      report.task_id !== selection.task_id) return undefined;
  return report;
}

function validReport(value: McpReport | undefined) {
  if (!value || typeof value.summary_markdown !== 'string' || sha256(value.summary_markdown) !== value.summary_sha256 ||
      !['ship', 'no-ship', 'completed'].includes(value.outcome)) return undefined;
  return value;
}
