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

This is the exact sequence that completed cleanly on 2026-10-20. Follow it literally;
do not re-derive commands from SETUP.md, source code or old transcripts. Every command
runs from the control checkout. Keep run files in a private folder outside the reviewed
repository.

```bash
C=$(plutil -extract WorkingDirectory raw ~/Library/LaunchAgents/local.repo-mcp.server.plist); cd "$C"
R=$(mktemp -d)  # private run folder (mode 700)
now(){ python3 -I -c 'import datetime;print(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z"))'; }
jget(){ python3 -I -c 'import json,sys
o=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."): o=o[k]
print(o)' "$1" "$2"; }  # jget FILE dotted.key.path
```

1. **Resolve and bind.** `npm run --silent coord -- repository resolve --repo "$ROOT"`.
   If the repository has no unfinished task, bind one:
   `npm run --silent coord -- task bind --repository "$REPO" --task REPO-architect-DATE`.
   Choose `SID` and `WSREQ` (fresh, unique each run).
2. **Prepare the browser.** Normal ChatGPT **Chat** tab, Repo MCP attached and its chip
   visible, and **Pro** available in the picker (you select it after preparing).
3. **Write the final prompt** to `$R/prompt.txt` with repository ID, task ID, `inspect`
   mode, request ID `$WSREQ`, expected root/branch/HEAD and "make no edits".
4. **Prepare the run** (2-minute selection window starts now):
   ```bash
   npm run --silent chatgpt-run -- prepare --repository "$REPO" --task "$TASK" --coordinator claude \
     --kind architecture --profile architecture --surface chat --session-id "$SID" --prompt-file "$R/prompt.txt" > "$R/run.json"
   RUN=$(jget "$R/run.json" run_id); SEL=$(jget "$R/run.json" selection.selection_id)
   PSHA=$(jget "$R/run.json" prompt_sha256); BASE=$(jget "$R/run.json" resolved_base_commit)
   ```
5. **Paste the prompt, select the effort, then observe and reserve.** Run `SELAT=$(now)`,
   then open the model picker and click the `Pro` effort, even if it already shows
   it. The selection must happen after preparation, and `--selected-at` must record
   that click. Read the label, then within 10 seconds run this one command:
   ```bash
   npm run --silent chatgpt-run -- observe --selection-id "$SEL" --surface chat \
     --control-label "Pro" --selected-at "$SELAT" --observed-at "$(now)" --session-id "$SID" > "$R/evidence.json" \
   && npm run --silent chatgpt-run -- reserve --run "$RUN" --contract-file "$R/run.json" \
     --evidence-file "$R/evidence.json" > "$R/reserve.json"; jget "$R/reserve.json" submission_authorized
   ```
   Send only when it prints `True`. If the observation is "too old", select `Pro` again
   (new `SELAT`) and repeat this one command.
6. **Send once and record it** (no head commit or candidate digest for this kind):
   ```bash
   NOW=$(now); npm run --silent chatgpt-run -- submitted --run "$RUN" --repository "$REPO" --task "$TASK" \
     --prompt-sha256 "$PSHA" --base-commit "$BASE" --browser-event-id "chatgpt-send-CONVERSATION_ID-$NOW" \
     --observed-at "$NOW" --session-id "$SID" > "$R/submitted.json"
   SUBSHA=$(jget "$R/submitted.json" submission_event_sha256)
   ```
7. **Wait for the answer, not for the workspace.** ChatGPT often closes the Repo MCP
   workspace minutes before it finishes writing, so a closed workspace or a quiet audit
   log does not mean the answer is ready. Every 30–60 seconds run this instant page
   check. Never wait inside the page: background tabs slow page timers, and the browser
   call fails after 45 seconds. Wait between checks outside the page (Claude Code: a
   `sleep 45` command with `run_in_background`; Codex: a short wait). The answer is done
   when `busy` is false and `tail` ends with the verdict or the end of the report:
   ```js
   ({busy:!!document.querySelector('[data-testid="stop-button"],button[aria-label*="Stop"]'), tail:document.body.innerText.slice(-200)})
   ```
   A Pro pass usually takes 15–20 minutes.
8. **Capture the answer** into `$R/output.md`: back up the clipboard
   (`LANG=en_US.UTF-8 pbpaste > "$R/clip.bak"`), click the Copy button under the last
   answer, then `sleep 1; LANG=en_US.UTF-8 pbpaste > "$R/output.md"; LANG=en_US.UTF-8 pbcopy < "$R/clip.bak"`.
   Check that the file ends with the verdict. Do not read long answers through
   JavaScript output; it gets truncated.
9. **Complete:**
   ```bash
   H=$(shasum -a 256 "$R/output.md" | cut -d' ' -f1); NOW=$(now)
   npm run --silent chatgpt-run -- complete --run "$RUN" --output-file "$R/output.md" --outcome completed \
     --response-state completed --submission-event-sha256 "$SUBSHA" --output-sha256 "$H" \
     --repository "$REPO" --task "$TASK" --prompt-sha256 "$PSHA" --base-commit "$BASE" \
     --browser-event-id "chatgpt-response-complete-CONVERSATION_ID-$NOW" --observed-at "$NOW" --session-id "$SID"
   ```
10. If you bound a task for this pass, finish it: `npm run --silent coord -- task finish --task "$TASK"`.

Report `Execution surface: ChatGPT web`, `Coordinator: Claude Code`, verified Pro profile, `Repository evidence: Repo MCP`, and exact scope/limitations.
