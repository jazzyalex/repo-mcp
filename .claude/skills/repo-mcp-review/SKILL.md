---
name: repo-mcp-review
description: Coordinate an independent ChatGPT web review of one local Git task through the permanent Repo MCP broker.
---

# Repo MCP ChatGPT review coordinator

Repo MCP review means **ChatGPT web performs the semantic review** and Repo MCP is its
only source-code evidence source. Claude is the local coordinator. Do not review the
source in Claude and do not identify Claude as the execution surface.

The user does not need to know or supply repository IDs, task IDs, policies, grants,
workspace tokens, request IDs, browser references, or model-policy files. Resolve and
prepare the current checkout, start `chatgpt-run go`, and keep generated authority
internal.

## Prepare the current checkout

This bootstrap is local coordinator work, not review evidence.

1. Resolve `git rev-parse --show-toplevel` in the current session. Do not search sibling
   repositories or infer another checkout from conversation history.
2. Locate the Repo MCP control checkout from the installed server plist
   `WorkingDirectory`, verify it, and read `docs/SHARED-REVIEW-WORKFLOW.md` there.
   Installed skills are standalone; do not assume reference files are adjacent.
3. Run `npm run --silent coord -- repository resolve --repo CURRENT_ROOT`. Reuse the
   registration. If none exists, create an owner-only external read-only policy and
   register this exact checkout. Do not ask the user to invent an ID.
4. Discover and record the exact sole safe unfinished review `TASK_ID` from owner-side
   repository/catalog status before final prompt construction. Do not freeze, rebind, or
   steal an unfinished coding owner. Zero/multiple/coding/conflicting state requires
   explicit owner action. A binding that is stale only because HEAD moved is
   refreshed with `coord task rebind` (it refuses protected reviewers and coding owners)
   and reported. Omitting `--task` is a separate combined
   selection+durable-preparation API for callers intentionally delegating task selection;
   it is not discovery and this browser handoff never uses it.
5. Choose the review target **before** final prompt construction. Legacy working review
   resolves the intended Git base to an immutable commit. Commit-pinned review uses
   explicit `base_ref` + `head_ref` and optional `scope_prefix`; never use
   `head_ref` without `base_ref`. Preallocate a unique `workspace_open` request ID.
   `go` keeps the browser session identity and the conversation URL for recovery.

## Run ChatGPT web through Repo MCP

`chatgpt-run go --kind review` performs every browser and journal step in code: it opens
a normal Chat tab in the owner's main Chrome, attaches Repo MCP, verifies the chip,
calls `prepare-or-join`, checks that the bound task and commits equal the requested
ones, selects the effort, observes and reserves, sends once, waits, saves the answer,
completes the run, closes the review participant and archives the chat. Do not drive
the browser yourself, do not poll the page, and never use Temporary Chat, Work, Oracle,
or a Claude review as a fallback.

- Profile `review` is Extra High. Use `review-critical` (Pro) only for an explicitly
  super-complex review.
- Require ChatGPT to call `service_info`, `repository_list`, open the exact preallocated
  `review` workspace with the requested base/head/scope, call `repo_info`, verify
  `review_assurance=commit_pinned`, the candidate digest and binding, and read complete
  instructions plus every required bounded diff/read page. Do not request `run_tests`
  from a read-only review workspace; local tests and typecheck stay coordinator
  evidence. Never return `SHIP` merely because the working tree is clean or a candidate
  digest exists.
- If `go` reports a failure the recipe below cannot resolve, return `NOT TESTABLE` with
  its `failure_code`.
- `go` records every step in the durable `chatgpt-run` journal. It refuses to send when
  the exact immutable resolved base commit recorded by `chatgpt-run` (and, for
  commit-pinned work, the head) differs from the requested one. Never rewrite the hashed
  prompt, reinterpret a movable name, or choose `HEAD^` after preparation.
- Do not substitute Claude's own review or silently invoke Oracle.

## Command recipe: commit-pinned review

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
per Chrome start. Never connect to Chrome's debugging port yourself.

1. **Resolve.** `npm run --silent coord -- repository resolve --repo "$ROOT"` gives
   `REPO` and the sole unfinished review `TASK`. Pin the target with full commits:
   `BASE=$(git -C "$ROOT" rev-parse BASE_REF)`, `HEADC=$(git -C "$ROOT" rev-parse HEAD)`.
   Set `GOREQ=$REPO-review-$(date +%Y%m%dT%H%M%S)-$RANDOM` and
   `WSREQ=$REPO-review-ws-$(date +%Y%m%dT%H%M%S)-$RANDOM` (fresh, unique each run).
2. **Rebind only when stale.** If repository status shows the task binding is stale
   (HEAD moved), run `npm run --silent coord -- task rebind --task "$TASK"`. Skip it when the
   binding is current, so a second session can join a review already running on the same
   head. Rebind refuses when another reviewer or a coding owner is protected; then stop
   and report that blocker. Mention any rebind in the report.
3. **Write the final prompt** to `$R/prompt.txt`: repository ID, task ID, `review` mode,
   `workspace_open` request ID `$WSREQ`, `base_ref` `$BASE` and `head_ref` `$HEADC`
   (and `scope_prefix` if used), what to review, "make no edits", "end with one line
   `VERDICT: SHIP` or `VERDICT: NO-SHIP`", and "before `workspace_close`, call `finish`
   once with outcome `ship` or `no-ship` and your complete review as
   `summary_markdown`". Never edit it after this step. `go` adds its own run-marker line.
4. **Run `go` once, in the background:**
   ```bash
   npm run --silent chatgpt-run -- go --request-id "$GOREQ" --repository "$REPO" --task "$TASK" \
     --coordinator claude --kind review --profile review --workspace-request-id "$WSREQ" \
     --base-ref "$BASE" --head-ref "$HEADC" --prompt-file "$R/prompt.txt" > "$R/go.json"; echo "exit=$?" >> "$R/go.json"
   ```
   In Claude Code, run it with `run_in_background` and wait for the completion
   notification. An Extra High review takes about 5–15 minutes. Do not check on it in
   between.
5. **Read the result** (first line of `$R/go.json`, one JSON object):
   - `exit=0`, `phase: cleaned`: read the review from `output_file`. `outcome` is `ship`
     or `no-ship`. It comes from the `finish` report when `output_source` is
     `mcp-report`; otherwise from the last `VERDICT:` line of the page text, and a
     missing verdict counts as `no-ship`. `participant: closed` means the review
     participant was released; `warning:<code>` means it was not, so report it.
     `cleanup` is `archived`, or `warning:<code>` when only archiving failed.
   - `exit=3` (any output, with or without `"error"`): the prompt may have been sent.
     Never start a new request or use the manual recipe; the account stays held. Run
     `go --request-id "$GOREQ" --resume` once. It reattaches to the same chat and never
     resends. If it still exits 3, report the `conversation_url` and stop.
     `failure_code: WORKSPACE_RECONCILIATION_REQUIRED` means ChatGPT answered without
     opening the review workspace. If the resume still says so, report the review as
     `NOT TESTABLE`, then free the account with
     `go --request-id "$GOREQ" --release-admission --reason "review workspace never opened"`.
   - `exit=1`, `phase: failed`: nothing was sent when `run_id` is null or the run is
     `failed-pre-submit`; `go` already released the participant. `REVIEW_TARGET_MISMATCH`
     means the journal bound other commits than requested: stop and report it. For
     `UI_*`, `COMPOSER_*` or `BROWSER_SETUP_FAILED`, retry once with a new `GOREQ` and
     `WSREQ` (and a new prompt naming it). For `BROWSER_UNAVAILABLE` or
     `BROWSER_APPROVAL_TIMEOUT`, ask the owner to approve the Chrome prompt or enable
     remote debugging, then retry.
   - `{"error": CODE, ...}` with `exit=1`: nothing was sent. `go` waits in code for a free
     slot. For `ACCOUNT_LATCHED` or `RATE_LIMITED`, report it and stop. `REQUEST_CONFLICT` means `GOREQ` was reused
     with other inputs. `REVIEW_SHARE_STATE_STALE` means step 2 was skipped.
   - `go --request-id "$GOREQ" --status` prints the stored result at any time.

If `go` cannot run at all, use `docs/REVIEW-MANUAL-RECIPE.md` in the control checkout
and say so in the report. Use it only after `go --status` shows your last request
`cleaned` or `failed`; never after exit 3.

## Report contract

Every result must state:

- `Execution surface: ChatGPT web`
- `Coordinator: Claude Code`
- verified model/profile when available
- `Repository evidence: Repo MCP`
- repository/task IDs for recovery
- selected diff base and resolved commit
- exact validation limits

Report the actual assurance from `repo_info`. Legacy working-target review is
`phase_only`. Commit-pinned review is `commit_pinned` only for the exact policy/scope
and immutable base/head pair named by its candidate digest; binary/non-text identity is
not semantic coverage and the deferred large-diff manifest/per-path feature is not
available. Do not claim stronger or complete coverage when bounded evidence is
incomplete.

If repairs are needed, start a separate coding run with the `repo-mcp` skill (Claude or
Codex can coordinate it). This review workflow itself issues no coding grants, makes no
edits through Repo MCP, and does not commit, push, restart services, or change
branches/worktrees.
