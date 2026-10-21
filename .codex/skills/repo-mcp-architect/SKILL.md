---
name: repo-mcp-architect
description: Coordinate a ChatGPT Pro architecture pass over an approved local repository through Repo MCP.
---

# Repo MCP ChatGPT architect coordinator

Repo MCP architecture means **ChatGPT web performs the architecture work** using Repo MCP as its repository evidence source. Codex prepares local read-only authority and controls the browser. Do not replace the requested ChatGPT Pro pass with Codex analysis.

1. Resolve the current Git root and instructions.
2. Locate the permanent Repo MCP control checkout from the installed launchd `WorkingDirectory`, verify it, then read `docs/SHARED-REVIEW-WORKFLOW.md` from that checkout. Installed skills are standalone; do not assume reference files are adjacent.
3. Resolve or register this exact checkout with a narrow read-only policy. Reuse a safe task or bind one only when no owner is displaced. Architecture requires no coding grant and no unsolicited review-phase freeze.
4. Use the generic durable run path: `chatgpt-run prepare --kind architecture --profile architecture --surface chat`. This profile requires the visible `Pro` effort control. A visible model label is optional evidence and never authorizes or rejects the run. Do **not** route architecture through `coord review prepare-or-join`; that command accepts review profiles only.
5. Use one stable normal-Chat session identity from the start and preserve the private conversation URL/tab mapping for recovery. Attach Repo MCP through the tool picker and verify the visible chip. Never use Temporary Chat, Work, Oracle, or a Codex subagent as an implicit fallback.
6. Require ChatGPT to call `service_info`, `repository_list`, open an `inspect` workspace with a fresh request ID, verify `repo_info`, read all instructions and relevant bounded source, state assumptions/evidence, and make no edits.
7. Observe the exact live Chat model/Pro control, reserve once, submit only when `submission_authorized: true`, record submitted/completed with fresh trusted browser receipts, and recover the same run/conversation after interruption.
8. If model selection, Repo MCP attachment, repository identity, bounded evidence, or completion cannot be verified, return `NOT TESTABLE`; do not silently substitute Codex, Work, or Oracle.

## Command recipe: architecture pass

This sequence completed cleanly on 2026-10-20. Follow it literally; do not re-derive
commands from SETUP.md, source code or old transcripts. Every command runs from the
control checkout. Keep run files in a private folder outside the reviewed repository.
Resolve `ROOT=$(git rev-parse --show-toplevel)` inside the user's project first.

```bash
C=$(plutil -extract WorkingDirectory raw ~/Library/LaunchAgents/local.repo-mcp.server.plist); cd "$C"
R=$(mktemp -d)  # private run folder (mode 700)
now(){ python3 -I -c 'import datetime;print(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z"))'; }
jget(){ python3 -I -c 'import json,sys
o=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."): o=o[k]
print(o)' "$1" "$2"; }  # jget FILE dotted.key.path
```

1. **Resolve and bind.** `npm run --silent coord -- repository resolve --repo "$ROOT"`
   gives `REPO`. If the repository has no unfinished task, bind one and use it as `TASK`:
   `npm run --silent coord -- task bind --repository "$REPO" --task "$REPO-architect-$(date +%Y%m%d)"`.
   Set `SID=codex-$REPO-architect-$(date +%Y%m%dT%H%M%S)` and
   `WSREQ=$REPO-architect-ws-$(date +%Y%m%dT%H%M%S)`.
2. **Prepare the browser.** Open a normal ChatGPT **Chat** tab (not Work, not Temporary
   Chat) and attach Repo MCP through the tool picker. The required effort is `Pro`. Check it in the page:
   ```js
   ({chip:[...document.querySelectorAll('button,span,div')].some(e=>e.childElementCount===0&&e.innerText?.trim()==='Repo MCP'),
     effort:[...document.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(x=>/^(Light|Medium|High|Extra High|Pro)$/.test(x))})
   ```
3. **Write the final prompt** to `$R/prompt.txt` with repository ID, task ID, `inspect`
   mode, request ID `$WSREQ`, expected root/branch/HEAD and "make no edits".
4. **Paste the prompt** into the composer now, before preparing (the prompt file is
   final, and pasting later wastes the 2-minute selection window). Do not send.
5. **Prepare the run** (the 2-minute selection window starts now):
   ```bash
   npm run --silent chatgpt-run -- prepare --repository "$REPO" --task "$TASK" --coordinator codex \
     --kind architecture --profile architecture --surface chat --session-id "$SID" --prompt-file "$R/prompt.txt" > "$R/run.json"
   RUN=$(jget "$R/run.json" run_id); SEL=$(jget "$R/run.json" selection.selection_id)
   PSHA=$(jget "$R/run.json" prompt_sha256); BASE=$(jget "$R/run.json" resolved_base_commit)
   ```
6. **Select the effort, then observe and reserve.** Open the model picker and click
   **Pro**, even if it already shows it (the selection must happen after
   preparation). Right after the click, record `SELAT=$(now)`. Read the label the page
   now shows (the `effort` value from the check above) into `LABEL`; it must be exactly
   `Pro`. Within 10 seconds run this one command:
   ```bash
   npm run --silent chatgpt-run -- observe --selection-id "$SEL" --surface chat \
     --control-label "$LABEL" --selected-at "$SELAT" --observed-at "$(now)" --session-id "$SID" > "$R/evidence.json" \
   && npm run --silent chatgpt-run -- reserve --run "$RUN" --contract-file "$R/run.json" \
     --evidence-file "$R/evidence.json" > "$R/reserve.json"; jget "$R/reserve.json" submission_authorized
   ```
   Send only when it prints `True`.
7. **If observe or reserve fails, or prints anything but `True`:** do not send. That run
   cannot be retried: `observe` is accepted once per selection, and a failed `reserve`
   ends the run. A failed `observe` (or an expired 2-minute window) leaves the run
   open, so always close it first; the command is a no-op after a failed `reserve`,
   which uses the same failure code:
   ```bash
   npm run --silent chatgpt-run -- fail-pre-submit --run "$RUN" --failure-code MODEL_SELECTION_NOT_VERIFIED
   ```
   Then start again from writing the prompt with a new `WSREQ` (the prompt names it).
8. **Send once.** Close any open picker menu, then click the composer's **Send** button
   (pressing Return after closing a menu may do nothing). Wait 5 seconds, then confirm
   the send: the URL is `/c/CONVERSATION_ID` and the composer is empty. If not, wait 5
   more seconds and check again before clicking Send again. If you still cannot tell,
   record `chatgpt-run uncertain` and recover; never send twice blindly. Save the
   conversation URL: `printf '%s\n' 'https://chatgpt.com/c/CONVERSATION_ID' > "$R/chat-url"`.
9. **Record the send** (no head commit or candidate digest for this kind):
   ```bash
   NOW=$(now); npm run --silent chatgpt-run -- submitted --run "$RUN" --repository "$REPO" --task "$TASK" \
     --prompt-sha256 "$PSHA" --base-commit "$BASE" \
     --browser-event-id "chatgpt-send-CONVERSATION_ID-$NOW" --observed-at "$NOW" --session-id "$SID" > "$R/submitted.json"
   SUBSHA=$(jget "$R/submitted.json" submission_event_sha256)
   ```
10. **Wait for the answer, not for the workspace.** Never use the broker audit log,
    `workspace_close`, or reconcile output as the completion signal: ChatGPT often closes
    the Repo MCP workspace minutes before it finishes writing, and keeps writing after.
    The page is the only signal. Every 30–60 seconds run this instant check (never wait
    inside the page: background tabs slow page timers, and the browser call fails after
    45 seconds). Wait between checks outside the page (Claude Code: a `sleep 45` command
    with `run_in_background`; Codex: a short wait).
    ```js
    (() => { const m = [...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1);
      const t = (m ? m.innerText : (document.querySelector('main')?.innerText || '')).trim();
      return {busy: !!document.querySelector('[data-testid="stop-button"],button[aria-label*="Stop"]'), chars: t.length, tail: t.slice(-150)}; })()
    ```
    The answer is done when two checks in a row show `busy: false` with the same `chars`,
    and `tail` ends with the verdict or the end of the report. A Pro pass usually takes 15–20 minutes.
11. **Capture the answer** into `$R/output.md`: read the last assistant message in the
    page (`[...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1).innerText`)
    and write that exact text to the file through the browser runtime's file access. If
    that selector finds nothing (the page layout changes) or the text comes back
    truncated, use the Copy button under the last answer and `pbpaste` instead.
12. **Complete:**
    ```bash
    H=$(shasum -a 256 "$R/output.md" | cut -d' ' -f1); NOW=$(now)
    npm run --silent chatgpt-run -- complete --run "$RUN" --output-file "$R/output.md" --outcome completed \
      --response-state completed --submission-event-sha256 "$SUBSHA" --output-sha256 "$H" \
      --repository "$REPO" --task "$TASK" --prompt-sha256 "$PSHA" --base-commit "$BASE" \
      --browser-event-id "chatgpt-response-complete-CONVERSATION_ID-$NOW" --observed-at "$NOW" --session-id "$SID"
    ```
13. **Archive the chat** so it leaves the ChatGPT sidebar. Do this only after the
    commands above printed `completed` (and `closed` for a review) and `$R/output.md`
    holds the whole answer. In the conversation tab (`$R/chat-url`), click the **More**
    (`…`) button at the top right, then **Archive**. The chat stays in your account under
    Settings → Data controls → Archived chats, and its URL still opens. Never use
    **Delete**. Skip this step and keep the chat when the run is `uncertain`, needs
    recovery, or the answer was not captured.
14. If you bound a task for this pass, finish it: `npm run --silent coord -- task finish --task "$TASK"`.

Report `Execution surface: ChatGPT web`, `Coordinator: Codex`, the exact verified picker and Pro control, `Repository evidence: Repo MCP`, and exact scope/limitations. If the response self-identifies a backend, label that as self-report rather than UI proof.
