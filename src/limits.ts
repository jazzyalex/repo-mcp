// Separate operator limits (WORKFLOW-SPEC "MCP interface requirements").
export const DEFAULT_LIMITS = {
  page_lines: 200,
  page_bytes: 32 * 1024,
  edit_file_bytes: 8 * 1024 * 1024,
  request_body_bytes: 256 * 1024,
  payload_bytes: 128 * 1024,
  inventory_paths: 100_000,
  retained_output_bytes: 1024 ** 3,
  cursor_ttl_hours: 24,
  job_log_retention_days: 7
};
export type Limits = typeof DEFAULT_LIMITS;

/** Largest single retained Git capture; also bounded to half of retained_output_bytes. */
export const GIT_CAPTURE_BYTES = 64 * 1024 * 1024;
/** Git calls whose output is read into memory (identity, tracking checks); never paged to clients. */
export const GIT_BUFFERED_BYTES = 16 * 1024 * 1024;
/** Synchronous operation budget; longer discovery returns a continuation. */
export const OPERATION_BUDGET_MS = 10_000;
/** Test-runner output (replaced by retained job logs in milestone 3). */
export const COMMAND_OUTPUT_BYTES = 32 * 1024;
