# Manual coding recipe (fallback)

Use this only when `chatgpt-run go --kind code` cannot run (for example ChatGPT changed
its page and the selectors fail repeatedly), and only after `go --status` shows every
earlier request `cleaned` or `failed`. Never use it after `go` exited 3: that run may
have been sent. Never click Send a second time.

The primary path is the `go` coding recipe in the `repo-mcp` skill.

## Coding run (manual)

ChatGPT does the coding through Repo MCP; Claude coordinates and never edits the served
repository through Repo MCP itself. Set up the run folder and helpers first:

```bash
C=$(plutil -extract WorkingDirectory raw ~/Library/LaunchAgents/local.repo-mcp.server.plist); cd "$C"
R=$(mktemp -d)  # private run folder (mode 700)
now(){ python3 -I -c 'import datetime;print(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z"))'; }
jget(){ python3 -I -c 'import json,sys
o=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."): o=o[k]
print(o)' "$1" "$2"; }  # jget FILE dotted.key.path
```

1. **Set the run variables.** `npm run --silent coord -- repository resolve --repo "$ROOT"`
   gives `REPO` and its unfinished coding `TASK` (bind one with `coord task bind` when
   there is none). Set `SID=claude-$REPO-code-$(date +%Y%m%dT%H%M%S)` and
   `WSREQ=$REPO-code-ws-$(date +%Y%m%dT%H%M%S)`. Check the phase:
   ```bash
   npm run --silent coord -- task status --task "$TASK"                 # phase must be coding
   npm run --silent coord -- task phase --task "$TASK" --phase coding   # only if it is in review; refuses protected reviewers
   ```
2. **Prepare the browser.** Open a normal ChatGPT **Chat** tab (not Work, not Temporary
   Chat) and attach Repo MCP through the tool picker. The required effort is `High` for
   profile `code`, `Extra High` for `code-hard`. Check it in the page:
   ```js
   ({chip:[...document.querySelectorAll('button,span,div')].some(e=>e.childElementCount===0&&e.innerText?.trim()==='Repo MCP'),
     effort:[...document.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(x=>/^(Light|Medium|High|Extra High|Pro)$/.test(x))})
   ```
3. **Issue the grant** right before preparing; it is single-use and expires in 10 minutes:
   ```bash
   npm run --silent coord -- workspace grant --task "$TASK" > "$R/grant.json"; GRANT=$(jget "$R/grant.json" write_grant)
   ```
4. **Write `$R/prompt.txt`** with repository ID, task ID, `code` mode, `write_grant` `$GRANT`,
   request ID `$WSREQ`, the expected HEAD and the coding instructions. The grant goes
   only into this prompt; never into files in a repository or logs.
5. **Paste the prompt** into the composer now, before preparing (the prompt file is
   final, and pasting later wastes the 2-minute selection window). Do not send.
6. **Prepare the run** (the 2-minute selection window starts now; use `--profile code-hard`
   for Extra High):
   ```bash
   npm run --silent chatgpt-run -- prepare --repository "$REPO" --task "$TASK" --coordinator claude \
     --kind code --profile code --surface chat --session-id "$SID" --prompt-file "$R/prompt.txt" \
     --base-ref "$(git -C "$ROOT" rev-parse HEAD)" > "$R/run.json"
   RUN=$(jget "$R/run.json" run_id); SEL=$(jget "$R/run.json" selection.selection_id)
   PSHA=$(jget "$R/run.json" prompt_sha256); BASE=$(jget "$R/run.json" resolved_base_commit)
   ```
7. **Select the effort, then observe and reserve.** Open the model picker and click
   **High** (or **Extra High** for `code-hard`), even if it already shows it (the selection must happen after
   preparation). Right after the click, record `SELAT=$(now)`. Read the label the page
   now shows (the `effort` value from the check above) into `LABEL`; it must be exactly
   the required effort. Within 10 seconds run this one command:
   ```bash
   npm run --silent chatgpt-run -- observe --selection-id "$SEL" --surface chat \
     --control-label "$LABEL" --selected-at "$SELAT" --observed-at "$(now)" --session-id "$SID" > "$R/evidence.json" \
   && npm run --silent chatgpt-run -- reserve --run "$RUN" --contract-file "$R/run.json" \
     --evidence-file "$R/evidence.json" > "$R/reserve.json"; jget "$R/reserve.json" submission_authorized
   ```
   Send only when it prints `True`.
8. **If observe or reserve fails, or prints anything but `True`:** do not send. That run
   cannot be retried: `observe` is accepted once per selection, and a failed `reserve`
   ends the run. A failed `observe` (or an expired 2-minute window) leaves the run
   open, so always close it first; the command is a no-op after a failed `reserve`,
   which uses the same failure code:
   ```bash
   npm run --silent chatgpt-run -- fail-pre-submit --run "$RUN" --failure-code MODEL_SELECTION_NOT_VERIFIED
   npm run --silent coord -- workspace revoke --grant "$(jget "$R/grant.json" grant_id)"
   ```
   Then start again from issuing a new grant (the prompt names the grant and `WSREQ`).
9. **Send once.** Close any open picker menu, then click the composer's **Send** button
   (pressing Return after closing a menu may do nothing). Wait 5 seconds, then confirm
   the send: the URL is `/c/CONVERSATION_ID` and the composer is empty. If not, wait 5
   more seconds and check again before clicking Send again. As soon as the URL shows
   `/c/`, always save it (recovery needs it most):
   `printf '%s\n' 'https://chatgpt.com/c/CONVERSATION_ID' > "$R/chat-url"`. If you still
   cannot tell whether it was sent, record `chatgpt-run uncertain` and recover; never
   send twice blindly.
10. **Record the send** (no head commit or candidate digest for this kind):
    ```bash
    NOW=$(now); npm run --silent chatgpt-run -- submitted --run "$RUN" --repository "$REPO" --task "$TASK" \
      --prompt-sha256 "$PSHA" --base-commit "$BASE" \
      --browser-event-id "chatgpt-send-CONVERSATION_ID-$NOW" --observed-at "$NOW" --session-id "$SID" > "$R/submitted.json"
    SUBSHA=$(jget "$R/submitted.json" submission_event_sha256)
    ```
11. **Wait for the answer, not for the workspace.** Never use the broker audit log,
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
    and `tail` ends with the verdict or the end of the report. A coding run usually takes 5–20 minutes.
12. **Capture the answer** into `$R/output.md`: back up the clipboard
    (`LANG=en_US.UTF-8 pbpaste > "$R/clip.bak"`), click the Copy button under the last
    answer, then `sleep 1; LANG=en_US.UTF-8 pbpaste > "$R/output.md"; LANG=en_US.UTF-8 pbcopy < "$R/clip.bak"`.
    Check that the file ends with the verdict. Do not read long answers through
    JavaScript output; it gets truncated.
13. **Complete:**
    ```bash
    H=$(shasum -a 256 "$R/output.md" | cut -d' ' -f1); NOW=$(now)
    npm run --silent chatgpt-run -- complete --run "$RUN" --output-file "$R/output.md" --outcome completed \
      --response-state completed --submission-event-sha256 "$SUBSHA" --output-sha256 "$H" \
      --repository "$REPO" --task "$TASK" --prompt-sha256 "$PSHA" --base-commit "$BASE" \
      --browser-event-id "chatgpt-response-complete-CONVERSATION_ID-$NOW" --observed-at "$NOW" --session-id "$SID"
    ```
14. **Archive the chat** so it leaves the ChatGPT sidebar. `complete` saves the answer
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
15. **Check the result locally, outside MCP:** `git -C "$ROOT" diff`, the project's own
    tests and build. Commit and push only when the user asks. To move the task to review:
    `npm run --silent coord -- task phase --task "$TASK" --phase review`.

