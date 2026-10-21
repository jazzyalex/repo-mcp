# Plan: autonomous ChatGPT runs with low coordinator cost

Status: v2, 2026-10-21. v1 was reviewed by a ChatGPT Pro architecture pass (run
`6738d7c0`), verdict "proceed with changes". The full review is in
`reports/Architect review - autonomous run plan.md`. Background:
`reports/Repo MCP vs devspace and DC - code comparison.md`.

## Goal

Cheap Codex or Claude agents use ChatGPT web chats to do coding, review and
architecture work. No human is in the loop. Target: 80–90% less Codex/Claude limit use
than doing the work directly.

## Diagnosis (hypothesis, to be measured)

- **The coordinator runs each pass as about 13 LLM steps.** Polling every 30–60 s is
  the biggest avoidable part (`.claude/skills/repo-mcp/SKILL.md:336`).
- **Other coordinator costs remain after automation:** prompt preparation, reading the
  result, verification and repair rounds, recovery, re-reading recipes, and copying big
  logs into prompts.
- **What ChatGPT cannot do today:** `run_tests` only runs configured suites with a 10 s
  limit. ChatGPT cannot run real builds, lint or type checks, so it cannot fix its own
  build errors.
- **Small MCP calls** mostly cost ChatGPT time. Once polling is gone, they no longer cost
  coordinator tokens.
- **Savings math:** total saving = f × r. Here f is the orchestration share of coordinator
  usage, and r is the part of it that automation removes. 80% overall needs f ≥ 0.89 at
  r = 0.9. So measure before claiming.

## Order of work

1. **Measure and specify (P0).** Record coordinator tokens on 3 equal tasks done three
   ways: direct, today's recipe, and `go`. Write the driver state, recovery table,
   account admission and invocation identity (sections A2–A5) before any code.
2. **`go` for architecture (P1).** Use the current journal. The DOM check and capture run
   in the process, not in the LLM.
3. **`go` for review (P1).** Use the existing `prepareOrJoinReview` and participant
   lifecycle.
4. **Switch the review and architecture recipes to `go`** after crash and restart tests pass.
5. **`finish` reports (P1).** Section B.
6. **`exec` (P1), then `go` for code with project checks.** Section C.
7. **Descriptions and read limits (P2).** Patch and fuzzy feedback only if measurements
   show a need (P3).

## A. `go`: one-shot run command

`npm run --silent chatgpt-run -- go --request-id ID --repository ID --task ID
--kind code|review|architecture --profile P --prompt-file FILE [--timeout 45m]`

`go --resume --request-id ID` continues an earlier invocation. Output is one JSON line:
`{run_id, state, outcome, output_file, chat_url, cleanup, failure_code?}`.

### A1. Sequence (selection windows stay as they are)

The selection contract lasts 120 s, and an observation must be fresh within 10 s
(`src/model-policy.ts:11,555`). So all browser setup happens **before** prepare:

1. **Admit:** take account admission (A4) and the rate limit. Do this before any grant
   or prepare.
2. **Preflight:** use CDP over the built-in `WebSocket` with an explicit
   `--user-data-dir` profile. Chrome 136+ refuses remote debugging on the default
   profile. Verify that the endpoint is the intended profile.
3. **Set up the tab:** open a normal Chat tab, attach Repo MCP and check the chip.
   Finalize the prompt (workspace request ID, grant), paste it, and read the composer back.
4. **Prepare:** call `prepareChatGptRun` (architecture, code). For review, call
   `prepareOrJoinReview`.
5. **Select and reserve:** click the effort control, reread the live control, call
   `recordTrustedBrowserObservation`, then call `reserveChatGptRun` at once. This
   happens inside the process, which is a valid trusted adapter (`src/model-policy.ts:621`).
6. **Send once:** persist the send intent first, then click Send. Confirm the send by
   finding the expected user message in the conversation, not only by the `/c/` URL.
   Then call `markChatGptRunSubmitted` right away.
7. **Wait in code.** A missing selector means "unknown", never "not busy". Completion
   needs the current turn, nonempty output and a terminal state.
8. **Capture** the output with `Runtime.evaluate` and `returnByValue`. Do not use the
   clipboard: another process overwrote it during the review run.
9. **Complete and clean up:** call `completeChatGptRun`, check the saved output with
   `chatGptRunOutput`, then archive. If archiving fails, record a cleanup warning. Never
   resubmit because of it.

The selector table has no "first plausible match" fallback. An ambiguous selector fails
the step. `probe` checks each phase (compose, running turn, final answer, archive)
against fixtures and checks that each selector is unique.

### A2. Reserve result

If `submission_authorized` is false, the run is already `submission-reserved`, and
`recovery_required` is true. `fail-pre-submit` does not accept that state
(`src/chatgpt-run.ts:827,1004`). The process must use same-run recovery and must never
prepare a new run and send again. Only a failed observation before reserve ends the
run with `fail-pre-submit`.

### A3. Driver manifest

An owner-only file outside served repos holds:
- the run ID and the logical session ID;
- the CDP profile and target ID;
- the conversation URL;
- the workspace request ID;
- the prompt path and digest;
- the send intent;
- the receipt metadata;
- the cleanup status.

Journal calls keep the original session binding. Adding a conversation ID later changes
the context hash and fails validation (`src/model-policy.ts:157`). The URL lives only in
the manifest.

### A4. Locks and admission

- **Process lock:** one short process lock per run, so only one driver controls it.
- **Account admission:** a durable record names the one active or unresolved run and
  keeps a rolling attempt history. A timeout or a dead PID does **not** release it. Only
  a positively resolved turn does.
- **Request claims:** existing claims stay until their terminal transitions
  (`src/chatgpt-run.ts:860`).
- **Rate:** default 1 live run, and N per hour as a config value. No number is
  proven safe. On any account warning, challenge or restriction, stop.

### A5. `--resume` per state

| State | Action |
|---|---|
| prepared | Continue only if the selection is still valid, else `fail-pre-submit` |
| verification-pending | Reconcile. Never assume the authorization is unused |
| submission-reserved | Inspect the original chat. Never click Send again |
| submitted | Reattach, wait, capture |
| uncertain | `recoverChatGptRun` with fresh same-context evidence |
| completed | Hash-check the saved output, retry cleanup only |
| failed-pre-submit | Return the result. A new attempt needs a new prepare |

## B. `finish`: report delivery (after `go` works without it)

`finish(workspace_token, run_id, request_id, outcome, summary_markdown)`

- **Binding:**
  - The workspace token gives authority, and `run_id` names the run.
  - A coordinator-made link (prepared run → preallocated `workspace_open` request ID →
    workspace ID) must prove the pair belongs together.
  - Generalize the `reconcileReviewParticipant` pattern (`src/review-share.ts:520`) to
    architecture and code.
- **Storage:**
  - The report is a separate immutable record: bytes, digest, outcome, ack ID and
    provenance "MCP report".
  - The run stays `submitted` until the browser turn ends. There is no new run state
    (`src/chatgpt-run.ts:30,345`).
- **Idempotency:** per run. The same request returns the same ack, and different content
  is rejected.
- **Limits:**
  - The payload must fit the 256 KiB request body (`src/limits.ts:6`) after JSON
    escaping. An oversized payload is rejected and never truncated.
- **Timing:**
  - A call before the send is recorded is rejected.
  - An early call is a report, not proof of completion.
  - The prompt orders `finish` before `workspace_close`.
- **Seal:** for coding, an accepted report seals further mutations.
  - Do not call `closeWorkspace` inside `withWorkspaceAdmission`.
  - If commands are active, the result is "busy, retry".
- **Watching:** `fs.watch` is only a wake-up. Watch the directory, reread, and keep
  polling, because `StateStore.write` replaces files by rename.

## C. `exec`: shell for coding workspaces

`exec(workspace_token, request_id, cmd, yield_ms?, max_output_tokens?)`,
`exec_poll(workspace_token, session_id, cursor?)`,
`exec_cancel(workspace_token, session_id, request_id)`. No stdin in v1.

- **Execution model:**
  - Runs as the user in the repo checkout, with no sandbox and no extra worktree
    (owner's decision).
- **Capability:**
  - The coding grant gets an explicit `exec` capability.
  - Old edit-only grants do not silently gain a shell.
  - Update the server instructions, which today say "unrestricted shell remains outside
    MCP".
- **Lease:**
  - `RuntimeManager.use` releases its lease when the callback returns.
  - Add a retained execution lease that keeps task mutation ownership while the child
    runs, and releases the short admission lock so poll and cancel still work.
  - Allow one active command per task.
  - Close, revoke, expiry and shutdown cancel or drain the command.
- **Idempotency:**
  - Persist the request digest and session ID before spawn. A retry returns the same
    session.
  - A crash between reserve and spawn gives `uncertain`. Never re-run automatically.
- **Audit:** generalize `auditedEdit` (`src/audit.ts:3`):
  - If the start record cannot be written, the command does not run.
  - If the end record fails, return the success with a warning.
  - Never log grants or tokens.
- **Limits:** keep these separate:
  - wall-clock limit;
  - retention;
  - stored bytes;
  - per-response budget;
  - max sessions.
- **Environment:**
  - An operator-configured toolchain PATH. The current `/usr/bin:/bin` is too small for
    npm or Python.
  - `NO_COLOR=1 TERM=dumb PAGER=cat GIT_PAGER=cat`.
  - Kill the process group, and verify process identity before killing an orphan.
- **Code to port:** the process-session pattern from devspace (MIT), wired into the
  lease above.
- **Verification:**
  - Drain sessions, fingerprint the uncommitted candidate, run the checks, and confirm the
    candidate did not change.
  - A HEAD or branch change keeps the existing drift failure.

## D. Smaller changes (measure first)

- **Keep:** configurable read limits. Change the tool schema and the policy, not only
  `DEFAULT_LIMITS` (`src/multirepo-server.ts:621`).
- **Keep:** rich multi-repo tool descriptions.
- **Keep:** `expected_replacements` on `edit`, with an exact count.
- **Later:** single-file multi-hunk patches. Multi-file `apply_patch` is not atomic with
  the current journal.
- **Later:** fuzzy miss feedback, advisory only.
- **Cut:** grant TTL. It already exists: `coord workspace grant --ttl-seconds`, up to
  1 h. Workspaces last 8 h.
- **Cut:** compact edit output. It already exists.
- **Cut:** conversation-based workspace reuse. Replay by request ID already exists.
- **Cut:** the clipboard capture path.

## Gates before "unattended" is claimed

- **Connector refresh:** new `finish` and `exec` schemas need a ChatGPT connector refresh.
- **Write confirmations:** check the write-confirmation behavior on the real account and
  profile. Keep honest tool annotations.
- **Tests:** fault-injection tests for crashes at each step:
  - before and after reserve;
  - the click;
  - submitted persistence;
  - report acceptance;
  - output save;
  - archive;
  - competing resumes;
  - lost replies;
  - broker restart with a live command;
  - DOM changes.
- **Live runs:** few, and under the rate limit.
- **Terms risk:** delivery through MCP does not by itself lower the terms risk of browser
  automation. That is still the owner's pending decision.

## Out of scope

Windows/Linux, a public listing, Oracle, and multiple accounts.
