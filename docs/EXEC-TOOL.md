# exec: shell for code workspaces (v1)

Status: v1, 2026-10-21. Plan: `docs/AUTONOMOUS-RUN-PLAN.md` section C.
Code: `src/exec-tool.ts`, tools in `src/multirepo-server.ts`, tests in
`test/exec-tool.test.ts`.

## What it is

ChatGPT can run builds, tests, lint and type checks in the owner's repository.

- The command runs as the broker user, through `/bin/sh -c`, in the registered
  repository root.
- There is no sandbox and no extra worktree. This is the owner's decision.
- The command can read and write anything the user can. This includes the Repo MCP
  state directory. Only grant exec for repositories and prompts you trust.

## Who gets it

- The operator enables exec per write grant:
  `coord workspace grant --task ID --exec` (or `issueWorkspaceGrant({ exec: true })`).
- `workspace_open` in code mode with that grant gives the workspace the `exec`
  capability. `repo_info` shows it in `capabilities.workspace_capabilities`.
- A grant without `--exec`, an old grant, or an old workspace never gains exec.
- inspect and review workspaces never get exec. A stored inspect or review selection
  that lists `exec` is rejected as corrupt.
- The grant MAC covers the exec flag. Old grant records have no exec field, so their MAC
  does not change.

## Tools

All three need the `exec` capability and the workspace token.

### `exec(workspace_token, request_id, cmd, yield_ms?, timeout_s?)`

- `cmd`: 1 to 8192 characters, no NUL.
- `yield_ms`: how long to wait for the command to end. Default 10000, max 30000.
- `timeout_s`: wall-clock limit. Default 600, max 1800.
- Returns `session_id`, `state`, `reason` (when set), `exit_code`, `signal` (when
  set), `output` (first page), `cursor`, `has_more`, `truncated`, `output_bytes`,
  `duration_ms`, `timeout_s`, `audit_warning` (when set), and `scope`.

### `exec_poll(workspace_token, session_id, cursor?, wait_ms?)`

- Returns the next output page from `cursor`, and the current state.
- `cursor` is the byte offset that the last call returned. No cursor means offset 0.
- `wait_ms` (default 0, max 30000) waits for new output or for the end of the command.
- Keep polling while `state` is `running` or `has_more` is true.

### `exec_cancel(workspace_token, session_id, request_id)`

- Sends SIGTERM to the whole process group, then SIGKILL after 3 s.
- Returns after the command ended, or after about 9 s at most.
- Safe to repeat. On a finished session it changes nothing (`cancel_applied: false`).

## States

| state | meaning |
|---|---|
| `starting` | Record written, process not yet started. Only seen in stored records. |
| `running` | The process runs. |
| `exited` | The shell ended by itself. `exit_code` is its code (or `signal`). |
| `failed` | The broker stopped it or could not run it. `reason`: `output_limit_4194304_bytes`, `spawn_failed`, `log_unavailable`, `log_write_failed` or `audit_unavailable`. |
| `cancelled` | `reason`: `cancelled_by_request`, `workspace_closed`, `workspace_no_longer_valid` or `broker_shutdown`. |
| `timed_out` | The wall-clock limit ended it. |
| `uncertain` | A broker that stopped left the record in `starting` or `running`. The command is never run again. |

## Identity and replay

- `session_id` = first 32 hex of sha256(`exec-session`, workspace_id, request_id).
- `request_digest` = sha256(workspace_id, cmd).
- The session record is written before spawn. A retry with the same `request_id` and
  the same `cmd` returns the same session, and waits `yield_ms` again. It never runs the
  command again.
- The same `request_id` with a different `cmd` is an error.
- A record in `starting` or `running` that this broker process does not own becomes
  `uncertain` when it is read.

## Limits

| limit | value |
|---|---|
| Running commands per task | 1. A second exec fails and names the running `session_id`. |
| Wall clock | 600 s default, 1800 s max |
| Stored output | 4 MiB per session. More output kills the command: `failed`, `truncated: true`. |
| Page | 24 KiB of UTF-8 text per response |
| Wait per call | 30 s |
| Sessions kept | 20 per task. The oldest finished sessions (record and log) are deleted first. |
| Command length | 8192 characters |

## Process

- New process group (`detached`), stdin is `/dev/null`, stdout and stderr go to one log.
- Environment, nothing else:
  `PATH`, `HOME`, `USER`, `LANG=en_US.UTF-8`, `NO_COLOR=1`, `TERM=dumb`, `PAGER=cat`,
  `GIT_PAGER=cat`, `CI=1`.
- `PATH` comes from `REPO_MCP_EXEC_PATH` when the broker starts. The default is
  `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`. Changing it needs a broker restart.
- When the shell exits, the broker sends SIGTERM to the rest of the group, and SIGKILL
  when the pipes close or after 3 s. Background jobs do not outlive the command.

## Output

- The log is `<state>/exec-logs/<task>/<session>.log`, mode 0600. The record is
  `<state>/exec-sessions/<task>/<session>.json`.
- Invalid UTF-8 becomes U+FFFD. Control characters other than tab, newline and CR
  become U+FFFD.
- Text that looks like a workspace token (`ws1.…`) or write grant (`wg1.…`) becomes
  `[redacted-token]`. The token key secret becomes `[redacted-secret]`.
- A full page ends at a line break when one is in its second half. Otherwise it does not
  split a run of token characters (up to 512 bytes back), so redaction sees whole tokens.

## Lifecycle

| event | effect on a running command |
|---|---|
| `workspace_close` | Cancelled before the close returns (`workspace_closed`). |
| Broker shutdown (`service.close`) | Cancelled (`broker_shutdown`). |
| Revoke, expiry, phase change, rebind, repository disable, task finish | A 1 s watcher re-checks the workspace token. Two failed checks in a row cancel the command (`workspace_no_longer_valid`), so within about 2–3 s. |
| Broker crash or `kill -9` | Not covered. The detached process group keeps running. Its record becomes `uncertain` on the next read. The orphan is not killed. |

After close or revoke, the old token cannot poll. The stored record and log remain for
the operator.

## Audit

Entries go to `<state>/multirepo-audit.jsonl`, as for other tools.

- `phase: started` before spawn: `session_id`, `request_id`, `cmd` (token-redacted),
  `cmd_sha256`, `cmd_length`, `timeout_s`. If this write fails, the command does not run
  and the session is `failed` / `audit_unavailable`.
- `phase: completed` after exit: state, reason, exit code, signal, bytes, truncation,
  duration. If this write fails, the result carries `audit_warning`.
- Each tool call also writes the usual per-call entry. Tokens and grants are never logged.

## Known gaps (v1)

- No retained execution lease. A running command does not hold the task mutation gate, so
  `edit` can run at the same time. Task finish or a phase change does not wait for the
  command; the watcher cancels it.
- No orphan cleanup after a broker crash, and no process-identity check for one.
- No stdin and no interactive programs.
- A retry with a `request_id` whose session was already deleted by retention runs the
  command again.
- Redaction is pattern-based. A command can still print other secrets that the user's
  account can read.
- The verification step of plan section C (drain sessions, fingerprint the candidate,
  run checks) is not part of v1.
