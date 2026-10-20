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
prepare the current checkout, use Claude's host-native browser controls, and keep
generated authority internal.

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
   steal an unfinished coding owner. Zero/multiple/coding/stale/conflicting state requires
   explicit owner action. Omitting `--task` is a separate combined
   selection+durable-preparation API for callers intentionally delegating task selection;
   it is not discovery and this browser handoff never uses it.
5. Choose the review target **before** final prompt construction. Legacy working review
   resolves the intended Git base to an immutable commit. Commit-pinned review uses
   explicit `base_ref` + `head_ref` and optional `scope_prefix`; never use
   `head_ref` without `base_ref`. Preallocate a unique `workspace_open` request ID
   and one stable logical browser session ID. Preserve a private mapping from that session
   ID to a normal ChatGPT conversation URL/tab for recovery; no Temporary Chat.

## Run ChatGPT web through Repo MCP

1. Use Claude's host-native browser controls with the user's normal signed-in ChatGPT
   conversation. Verify Chat surface, Repo MCP attachment and visible chip; do not use
   Temporary Chat, Work, Oracle, or Claude-native semantic review as fallback.
2. Run `coord review prepare-or-join --task TASK_ID` with the exact task embedded in
   the final prompt, coordinator `claude`, profile `review` for Extra High, or
   `review-critical` only for explicitly super-complex Pro review. Add
   `--base-ref ... --head-ref ... [--scope-prefix ...]` for commit-pinned review. The
   **final** prompt must already contain repository/task IDs, `review` workspace mode,
   preallocated workspace request ID, and selected target. For commit-pinned work include
   requested base/head/scope and expected resolved commits, and require browser
   `workspace_open` to use those same requested values. Before observe/reserve/send,
   compare both returned task IDs (`participant.task_id` and `run.task_id`) to the
   embedded `TASK_ID`. The exact immutable resolved base commit recorded by
   `chatgpt-run` must equal the pre-resolved base; for commit-pinned work the resolved
   head must also match and `participant.commit_binding` must exactly equal
   `run.commit_binding`. Stop on
   any mismatch; never rewrite the hashed prompt, reinterpret a movable name, or choose
   `HEAD^` after preparation.
3. Persist exact `prepared.run` (including `selection`) separately from the outer
   `{generation, participant, run}` result. Observe the live model/effort with the same
   session identity, reserve the saved run once, and submit only when
   `submission_authorized: true`. Never pass the outer wrapper as the reserve contract,
   append prompt text after hashing, or late-add a conversation ID to a session-only
   browser binding.
4. Require ChatGPT to call `service_info`, `repository_list`, open the exact
   preallocated `review` workspace, call `repo_info`, verify task/policy/target, and
   read complete instructions plus every required bounded diff/read page. In
   commit-pinned mode verify `review_assurance=commit_pinned`, candidate digest and
   binding; committed instructions/context read from the bound head and `git_diff`
   uses the bound base/head/scope. Inconsistent read/diff refs or scope must fail closed.
   Do not request `run_tests` from a read-only review workspace; local tests/typecheck
   remain coordinator evidence. Never return `SHIP` merely because the working tree is
   clean or because a candidate digest exists.
5. After `workspace_open`, run `coord review reconcile --task TASK_ID --participant
   PARTICIPANT_ID`. Reconciliation accepts no caller workspace ID and must be bound
   before normal completion. ChatGPT may close its workspace before the final response;
   the authoritative open-request ledger can still reconcile it.
6. Record the actual submission event and complete only from a trusted finished-response
   receipt with matching submission hash and observed output digest. Close only that
   participant with a fresh close request ID; compatible siblings stay live.
7. If browser control stalls or submission/completion is uncertain, recover the same
   durable `chatgpt-run` and normal Chat conversation/session. Never submit a duplicate.
   Submitted/uncertain pending work remains protected. Participant absence recovery is
   allowed for an actual terminal failed-pre-submit run or for a never-created run after
   its dead initializer claim is recovered; both require authoritative proof that no
   workspace_open outcome exists. Existing/corrupt runs and live/foreign initializers
   remain protected.
8. If model selection, Repo MCP attachment, repository identity, required bounded
   evidence, or final response cannot be verified, return `NOT TESTABLE`.
   Do not substitute Claude's own review or silently invoke Oracle.

For every work kind, completion must use a trusted finished-response receipt with
`kind: "completion"`, `responseState: "completed"`, the submitted event hash, and
the observed output digest. Never reuse the submission event or derive browser proof
from supplied output text. The `complete` CLI requires `--response-state completed`,
`--submission-event-sha256`, and `--output-sha256`.
After a crash during initialization or terminal cleanup, use explicit
`chatgpt-run recover-request --request-key REQUEST_KEY` as documented in `SETUP.md`;
unresolved runs must still be recovered by their existing run identity. Reclaim an
orphan only after the helper proves its initializer is dead on this host.

## Command recipe: commit-pinned review

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

1. **Resolve.** `npm run --silent coord -- repository resolve --repo "$ROOT"` gives
   `REPO` and the sole unfinished review `TASK`. Pin the target:
   `BASE=$(git -C "$ROOT" rev-parse BASE_REF)`, `HEADC=$(git -C "$ROOT" rev-parse HEAD)`.
   Choose `SID=claude-REPO-review-STAMP` and `WSREQ=REPO-review-ws-STAMP` (fresh,
   unique each run).
2. **Rebind first.** `npm run --silent coord -- task rebind --task "$TASK"`. This clears
   "Task binding is stale" after HEAD moved. It refuses when another reviewer or a
   coding owner is protected; then stop and report that blocker. Mention the rebind in
   the report.
3. **Prepare the browser before the run.** Open a normal ChatGPT **Chat** tab (not Work,
   not Temporary Chat), choose the required effort (`Extra High` for `review`, `Pro`
   for `review-critical`) and attach Repo MCP through the tool picker. Check it in the
   page:
   ```js
   ({chip:[...document.querySelectorAll('button,span,div')].some(e=>e.childElementCount===0&&e.innerText?.trim()==='Repo MCP'),
     effort:[...document.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(x=>/^(Light|Medium|High|Extra High|Pro)$/.test(x))})
   ```
4. **Write the final prompt** to `$R/prompt.txt`: repository ID, task ID, `review`
   mode, `workspace_open` request ID `$WSREQ`, and the requested and resolved base/head.
   Never edit it after this step.
5. **Prepare the run** (the selection expires 2 minutes after this, so go straight on):
   ```bash
   npm run --silent coord -- review prepare-or-join --repository "$REPO" --task "$TASK" \
     --coordinator claude --profile review --surface chat --session-id "$SID" \
     --workspace-request-id "$WSREQ" --prompt-file "$R/prompt.txt" \
     --base-ref "$BASE" --head-ref "$HEADC" > "$R/wrapper.json"
   python3 -I -c 'import json,sys;json.dump(json.load(open(sys.argv[1]))["run"],open(sys.argv[2],"w"))' "$R/wrapper.json" "$R/run.json"
   RUN=$(jget "$R/run.json" run_id); SEL=$(jget "$R/run.json" selection.selection_id)
   PSHA=$(jget "$R/run.json" prompt_sha256); CDIG=$(jget "$R/run.json" commit_binding.candidate_digest)
   PART=$(jget "$R/run.json" participant_id)
   ```
   Check that both task IDs equal `$TASK`, the resolved base equals `$BASE`, and
   `participant.commit_binding` equals `run.commit_binding`. Stop on any mismatch.
6. **Paste the prompt** into the composer. Do not send yet.
7. **Observe and reserve in ONE command**, right after reading the effort label (the
   observation must be under 10 seconds old):
   ```bash
   NOW=$(now); npm run --silent chatgpt-run -- observe --selection-id "$SEL" --surface chat \
     --control-label "Extra High" --selected-at "$NOW" --observed-at "$NOW" --session-id "$SID" > "$R/evidence.json" \
   && npm run --silent chatgpt-run -- reserve --run "$RUN" --contract-file "$R/run.json" \
     --evidence-file "$R/evidence.json" > "$R/reserve.json"; jget "$R/reserve.json" submission_authorized
   ```
   If the label check fails or the observation is "too old", read the label again and
   repeat this one command. Send only when it prints `True`.
8. **Send once**, then record the submission with the conversation ID from the URL:
   ```bash
   NOW=$(now); npm run --silent chatgpt-run -- submitted --run "$RUN" --repository "$REPO" --task "$TASK" \
     --prompt-sha256 "$PSHA" --base-commit "$BASE" --head-commit "$HEADC" --candidate-digest "$CDIG" \
     --browser-event-id "chatgpt-send-CONVERSATION_ID-$NOW" --observed-at "$NOW" --session-id "$SID" > "$R/submitted.json"
   SUBSHA=$(jget "$R/submitted.json" submission_event_sha256)
   ```
9. **Reconcile** in the background until ChatGPT has opened the workspace:
   ```bash
   for i in $(seq 1 30); do npm run --silent coord -- review reconcile --task "$TASK" --participant "$PART" 2>&1 | grep -q '"bound"' && { echo BOUND; break; }; sleep 15; done
   ```
10. **Wait for the answer.** Check the page every 60 seconds; do not use long blind
    sleeps. The answer is finished when there is no Stop button:
    ```js
    ({busy:!!document.querySelector('[data-testid="stop-button"],button[aria-label*="Stop"]'),
      tail:([...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1)?.innerText||'').slice(-200)})
    ```
11. **Capture the answer** from the page into `$R/output.md`: back up the clipboard
   (`LANG=en_US.UTF-8 pbpaste > "$R/clip.bak"`), click the Copy button under the last
   answer, then `sleep 1; LANG=en_US.UTF-8 pbpaste > "$R/output.md"; LANG=en_US.UTF-8 pbcopy < "$R/clip.bak"`.
   Check that the file ends with the verdict. Do not read long answers through
   JavaScript output; it gets truncated.
12. **Complete and close:**
    ```bash
    H=$(shasum -a 256 "$R/output.md" | cut -d' ' -f1); NOW=$(now)
    npm run --silent chatgpt-run -- complete --run "$RUN" --output-file "$R/output.md" --outcome ship \
      --response-state completed --submission-event-sha256 "$SUBSHA" --output-sha256 "$H" \
      --repository "$REPO" --task "$TASK" --prompt-sha256 "$PSHA" --base-commit "$BASE" --head-commit "$HEADC" \
      --candidate-digest "$CDIG" --browser-event-id "chatgpt-response-complete-CONVERSATION_ID-$NOW" \
      --observed-at "$NOW" --session-id "$SID"
    npm run --silent coord -- review close --task "$TASK" --participant "$PART" --request-id "REPO-review-close-STAMP"
    ```
    Use `--outcome no-ship` when the verdict is NO-SHIP. Both commands print
    `"state": "completed"` and `"state": "closed"`.

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

If repairs are needed, return the findings to the Codex coding coordinator. Claude does
not issue coding grants, edit through Repo MCP, commit, push, restart services, or change
branches/worktrees in this review workflow.
