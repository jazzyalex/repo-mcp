---
name: repo-mcp-architect
description: Coordinate a ChatGPT Pro architecture pass over an approved local repository through Repo MCP from Claude Code.
---

# Repo MCP ChatGPT architect coordinator

Repo MCP architecture means **ChatGPT web performs the architecture work** using Repo MCP as its repository evidence source. Claude prepares local read-only authority and uses Claude's host-native browser controls. Do not replace the requested ChatGPT Pro pass with Claude analysis.

1. Resolve the current Git root and instructions.
2. Locate the permanent Repo MCP control checkout from the installed launchd `WorkingDirectory`, verify it, then read `docs/SHARED-REVIEW-WORKFLOW.md` there. Installed skills are standalone; do not assume reference files are adjacent.
3. Resolve/register this exact checkout with a narrow read-only policy. Reuse a safe task or bind one only when no owner is displaced. Architecture requires no coding grant and no unsolicited review-phase freeze.
4. Use the generic durable run path: `chatgpt-run prepare --kind architecture --profile architecture --surface chat`. Profile `architecture` requires the visible Pro effort control; model labels are optional evidence. Do **not** call `coord review prepare-or-join`; that command accepts review profiles only.
5. Use a stable normal-Chat session identity from the start, preserve the private conversation URL/tab mapping, attach Repo MCP through the tool picker and verify the visible chip. No Temporary Chat, Work, Oracle, or Claude-native semantic fallback.
6. Require ChatGPT to call `service_info`, `repository_list`, open an `inspect` workspace with a fresh request ID, verify `repo_info`, read instructions and relevant bounded source, and make no edits.
7. Observe the exact live Chat model/Pro control, reserve once, submit only when `submission_authorized: true`, record submitted/completed with trusted browser receipts, and recover the same run/conversation after interruption.
8. If model selection, Repo MCP attachment, repository identity, bounded evidence, or completion cannot be verified, return `NOT TESTABLE` without substituting Claude, Work, or Oracle.

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
   Set `SID=claude-$REPO-architect-$(date +%Y%m%dT%H%M%S)` and
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
   npm run --silent chatgpt-run -- prepare --repository "$REPO" --task "$TASK" --coordinator claude \
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
   more seconds and check again before clicking Send again. As soon as the URL shows
   `/c/`, always save it (recovery needs it most):
   `printf '%s\n' 'https://chatgpt.com/c/CONVERSATION_ID' > "$R/chat-url"`. If you still
   cannot tell whether it was sent, record `chatgpt-run uncertain` and recover; never
   send twice blindly.
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
    (() => { const ANSWER = '[data-message-author-role="assistant"],[data-content-search-unit-key$=":assistant"]';
      const m = [...document.querySelectorAll(ANSWER)].at(-1);
      const t = (m ? m.innerText : (document.querySelector('main')?.innerText || '')).trim();
      const turn = [...document.querySelectorAll('[data-talvt-turn-state]')].at(-1)?.getAttribute('data-talvt-turn-state');
      return {busy: !!document.querySelector('[data-testid="stop-button"],button[aria-label*="Stop"]') || (turn !== undefined && turn !== 'complete'),
        chars: t.length, tail: t.slice(-150)}; })()
    ```
    `ANSWER` matches both the old and the October 2026 ChatGPT layouts. If `chars` stays near 0 while the
    page shows an answer, the layout changed again: find the answer element before
    trusting the check.
    The answer is done when two checks in a row show `busy: false` with the same `chars`,
    and `tail` ends with the verdict or the end of the report. A Pro pass usually takes 15–20 minutes.
11. **Capture the answer** into `$R/output.md`: back up the clipboard
    (`LANG=en_US.UTF-8 pbpaste > "$R/clip.bak"`), click the Copy button under the last
    answer, then `sleep 1; LANG=en_US.UTF-8 pbpaste > "$R/output.md"; LANG=en_US.UTF-8 pbcopy < "$R/clip.bak"`.
    Check that the file ends with the verdict. Do not read long answers through
    JavaScript output; it gets truncated.
12. **Complete:**
    ```bash
    H=$(shasum -a 256 "$R/output.md" | cut -d' ' -f1); NOW=$(now)
    npm run --silent chatgpt-run -- complete --run "$RUN" --output-file "$R/output.md" --outcome completed \
      --response-state completed --submission-event-sha256 "$SUBSHA" --output-sha256 "$H" \
      --repository "$REPO" --task "$TASK" --prompt-sha256 "$PSHA" --base-commit "$BASE" \
      --browser-event-id "chatgpt-response-complete-CONVERSATION_ID-$NOW" --observed-at "$NOW" --session-id "$SID"
    ```
13. **Archive the chat** so it leaves the ChatGPT sidebar. `complete` saves the answer
    in the broker state; first confirm that saved copy matches what you captured:
    ```bash
    npm run --silent chatgpt-run -- output --run "$RUN" > "$R/saved.md" && [ -s "$R/saved.md" ] \
      && cmp -s "$R/saved.md" "$R/output.md" && echo SAVED
    ```
    Only when it prints `SAVED`: in the conversation tab (`$R/chat-url`), click the
    **More** (`…`) button at the top right, then **Archive**. The chat stays in your
    account (Settings, Archived chats) and its URL still opens with the full answer.
    Archiving asks for no confirmation; the tab moves to a new chat.
    Never use **Delete**. Skip this step and keep the chat when the run is `uncertain`,
    needs recovery, or the check did not print `SAVED`. Later, `chatgpt-run output --run
    RUN_ID` prints the saved answer again.
14. If you bound a task for this pass, finish it: `npm run --silent coord -- task finish --task "$TASK"`.

Report `Execution surface: ChatGPT web`, `Coordinator: Claude Code`, verified Pro profile, `Repository evidence: Repo MCP`, and exact scope/limitations.
