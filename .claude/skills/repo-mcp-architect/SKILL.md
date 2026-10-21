---
name: repo-mcp-architect
description: Coordinate a ChatGPT Pro architecture pass over an approved local repository through Repo MCP from Claude Code.
---

# Repo MCP ChatGPT architect coordinator

Repo MCP architecture means **ChatGPT web performs the architecture work** using Repo MCP as its repository evidence source. Claude Code prepares local read-only authority and starts `chatgpt-run go`, which drives the ChatGPT web page in code. Do not replace the requested ChatGPT pass with Claude analysis.

1. Resolve the current Git root and instructions.
2. Locate the permanent Repo MCP control checkout from the installed launchd `WorkingDirectory`, verify it, then read `docs/SHARED-REVIEW-WORKFLOW.md` there. Installed skills are standalone; do not assume reference files are adjacent.
3. Resolve/register this exact checkout with a narrow read-only policy. Reuse a safe task or bind one only when no owner is displaced. Architecture requires no coding grant and no unsolicited review-phase freeze.
4. Use the generic durable run path through `chatgpt-run go --kind architecture`. The default `--profile architecture` requires the visible Pro effort control. Use `--profile architecture-xhigh` (Extra High) only when the user explicitly asks for Extra High; never downgrade a Pro request on your own. Model labels are optional evidence. Do **not** call `coord review prepare-or-join`; that command accepts review profiles only.
5. `go` opens a normal Chat tab in the owner's main Chrome, attaches Repo MCP, verifies the chip, selects the effort, sends once, waits, saves the answer and archives the chat. Never use Temporary Chat, Work, Oracle, or a Claude subagent as an implicit fallback.
6. Require ChatGPT to call `service_info`, `repository_list`, open an `inspect` workspace with a fresh request ID, verify `repo_info`, read instructions and relevant bounded source, and make no edits.
7. Do not drive the browser yourself and do not poll the page. `go` reserves once, submits only when authorized, records trusted receipts, and recovers the same run after interruption.
8. If `go` reports a failure that the steps below cannot resolve, return `NOT TESTABLE` with its `failure_code`; do not silently substitute Claude, Work, or Oracle.

## Command recipe: architecture pass

Follow it literally; do not re-derive commands from SETUP.md, source code or old
transcripts. Every command runs from the control checkout. Keep run files in a private
folder outside the reviewed repository, and keep the prompt file until `go` finishes:
`--resume` reads it again. Resolve `ROOT=$(git rev-parse --show-toplevel)` inside the
user's project first.

```bash
C=$(plutil -extract WorkingDirectory raw ~/Library/LaunchAgents/local.repo-mcp.server.plist); cd "$C"
R=$(mktemp -d)  # private run folder (mode 700)
```

Browser prerequisite: the owner's main Chrome runs with remote debugging enabled in
`chrome://inspect/#remote-debugging` and is signed in to ChatGPT. `go` starts a local
relay that holds one DevTools connection, so Chrome asks the owner to approve it once
per Chrome start. Never connect to Chrome's debugging port yourself; every new
connection prompts the owner again.

1. **Resolve and bind.** `npm run --silent coord -- repository resolve --repo "$ROOT"`
   gives `REPO`. If the repository has no unfinished task, bind one and use it as `TASK`:
   `npm run --silent coord -- task bind --repository "$REPO" --task "$REPO-architect-$(date +%Y%m%d)"`.
   Set `GOREQ=$REPO-architect-$(date +%Y%m%dT%H%M%S)` and
   `WSREQ=$REPO-architect-ws-$(date +%Y%m%dT%H%M%S)`.
2. **Write the prompt** to `$R/prompt.txt`: repository ID, task ID, `inspect` mode,
   request ID `$WSREQ`, expected root/branch/HEAD, the question, "make no edits", and
   "end with one VERDICT line". `go` adds its own run-marker line on top.
3. **Run `go` once, in the background:**
   ```bash
   npm run --silent chatgpt-run -- go --request-id "$GOREQ" --repository "$REPO" --task "$TASK" \
     --coordinator claude --kind architecture --profile architecture --prompt-file "$R/prompt.txt" > "$R/go.json"; echo "exit=$?" >> "$R/go.json"
   ```
   Use `--profile architecture-xhigh` only when the user asked for Extra High. In Claude Code, run it with `run_in_background` and wait for the completion notification.
   A Pro pass takes about 15–20 minutes, Extra High less. Do not check on it in between.
4. **Read the result** (first line of `$R/go.json`, one JSON object):
   - `exit=0`, `phase: cleaned`: read the answer from `output_file`. `cleanup` is
     `archived`, or `warning:<code>` when only archiving failed; the answer is still saved.
     Check that the answer ends with the requested `VERDICT` line. If it does not, report
     the pass as incomplete and do not finish the task as successful.
   - `exit=3` (any output, with or without `"error"`): the prompt may have been sent.
     Never start a new request or use the manual recipe; the account stays held. Run the
     same request once more with `go --request-id "$GOREQ" --resume`. It reattaches to the
     same chat and never resends. If it still exits 3, report the `conversation_url` and stop.
   - `exit=1`, `phase: failed`: nothing was sent when `run_id` is null or the run is
     `failed-pre-submit`. For `UI_*`, `COMPOSER_*` or `BROWSER_SETUP_FAILED`, retry once with
     a new `GOREQ`. For `BROWSER_UNAVAILABLE` or `BROWSER_APPROVAL_TIMEOUT`, ask the owner to
     approve the Chrome prompt or enable remote debugging, then retry.
   - `{"error": CODE, ...}` with `exit=1`: nothing was sent. For
     `ACCOUNT_BUSY` (another pass is unresolved) or `RATE_LIMITED`, report it and stop;
     do not work around it. `REQUEST_CONFLICT` means `GOREQ` was reused with other inputs.
   - `go --request-id "$GOREQ" --status` prints the stored result at any time.
5. **Finish** a task you bound for this pass: `npm run --silent coord -- task finish --task "$TASK"`.

If `go` cannot run at all (for example ChatGPT changed its page and the selectors fail
repeatedly), use the manual recipe in `docs/ARCHITECT-MANUAL-RECIPE.md` in the control
checkout, and say so in the report. Use it only after `go --status` shows your last
request `cleaned` or `failed`; never after exit 3.

Report `Execution surface: ChatGPT web`, `Coordinator: Claude Code`, the verified profile (Pro or Extra High), `Repository evidence: Repo MCP`, and exact scope/limitations.
