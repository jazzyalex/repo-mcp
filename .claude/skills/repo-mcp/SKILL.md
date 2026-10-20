---
name: repo-mcp
description: Operate Repo MCP from Claude as the local coordinator for ChatGPT web coding, review and architecture.
---

# Repo MCP operator

Use this skill when the user asks to set up Repo MCP, connect a local repository, or
prepare a Repo MCP coding or review task. The user should describe the outcome; run the
coordinator and installation commands yourself.

Never ask the user to provide `REPOSITORY_ID`, `TASK_ID`, policy paths, or workspace
tokens for the current checkout. Resolve existing registration with
`npm run --silent coord -- repository resolve --repo CURRENT_ROOT`; create missing local
state yourself. Keep generated identifiers internal unless reporting them helps recovery.

When invoked from another project, locate the installed Repo MCP control checkout from
the `WorkingDirectory` in `~/Library/LaunchAgents/local.repo-mcp.server.plist` and verify
its `package.json` and coordinator before running control commands there. The user's
current Git checkout is the repository being registered. If the service is not installed
and no source checkout was provided, clone the public Repo MCP repository into a
user-approved development location first.

## First-time setup or upgrade

1. Work from the Repo MCP source checkout. Read its `README.md`, `SETUP.md`, and current
   repository instructions. Verify macOS, Git, npm, Node 26 or newer, and Python 3.9 or newer.
   Run `python3 scripts/check-prerequisites.py` before installation. pytest is optional
   and used only for the Python fixture runner.
2. Inspect existing Repo MCP launchd definitions and state before changing them. Never
   overwrite a foreign or modified service definition. If the service already exists,
   read its `WorkingDirectory` and run upgrades from that control checkout; never move
   the permanent service merely because setup began in a second clone. For an existing
   v0.1 service, follow the documented migration before issuing a v0.2 workspace or grant.
3. Run `npm ci`, `npm run build`, `npm test`, and
   `python3 scripts/install-agent-skills.py --install`. Then install the stable broker
   from the selected control checkout with
   `python3 scripts/install-server-service.py --install`, configure it if needed, and
   inspect `service status`. Run `service start` only for first load or an intentional
   upgrade/recovery: it reloads launchd and can interrupt in-flight calls, although
   persisted tasks and workspace records survive.
4. Configure the durable tunnel only if it is missing or unhealthy. Reuse saved
   credentials. If no tunnel ID or runtime credential exists, explain the one-time
   account action and guide the user through creating a private tunnel and a runtime key
   with **Tunnels Read + Use**. Accept the key only through the hidden prompt used by
   `scripts/connect.sh --save-key`; never ask the user to paste it into chat or a command.
   Install the tunnel service and verify `npm run connection:status`.
5. Configure Claude Code for the current user if it is not already connected. Check
   `claude mcp get repo-mcp`; when missing, run
   `claude mcp add --scope user --transport http repo-mcp http://127.0.0.1:8787/mcp`,
   then verify it with `claude mcp list`.
6. Help create or refresh the developer-mode ChatGPT MCP app using the private tunnel.
   If browser control is available and authorized, do the UI work. Otherwise ask for the
   single required UI action precisely. A schema update requires **Refresh tools** and a
   new ChatGPT conversation; an ordinary repository switch does not.
7. Prepare the explicit disposable `repo-mcp-onboarding` / `repo-mcp-onboarding-smoke`
   target below, then prove each configured real client route with `service_info`,
   `repository_list`, `workspace_open`, scoped `repo_info`, and `workspace_close`.
   Local process health is insufficient evidence.

Global skills are hash-owned through private state at
`~/Library/Application Support/repo-mcp/agent-skills/installed.json` (or
`REPO_MCP_HOME/agent-skills`). Installation updates only recorded copies whose bytes
still match their owned hash. Foreign/modified copies are preserved; inspect them before
using `python3 scripts/install-agent-skills.py --install --replace` (alias
`--force`), which creates an owner-only backup. Legacy installations without the new
ledger require this explicit backup-and-replace adoption. Keep ownership state and
backups outside every served checkout; never copy them into a release.

Remove only installer-owned copies with `python3 scripts/install-agent-skills.py
--uninstall`. Add `--client claude` or `--client codex` to remove one client's skills
without touching the other. Uninstall preflights every selected skill: if any selected
file is modified or foreign, it removes none of them. Otherwise it removes all selected
owned files and their matching ownership records. Newly created skill directories are
owner-only (`0700`);
existing safe directories are preserved at their current mode.

### First-install smoke target

For a fresh install, prepare a disposable, committed Git fixture outside the control
checkout. If any named fixture, policy, repository registration or task already exists,
inspect and reuse it instead of rerunning this block. This works from a clone or
extracted source archive and never edits a user's project:

```sh
npm run prepare:fixture -- --root "$HOME/Library/Application Support/repo-mcp/onboarding/repo"
mkdir -p "$HOME/Library/Application Support/repo-mcp/policies"
cp -n docs/policy-readonly.json "$HOME/Library/Application Support/repo-mcp/policies/onboarding.json"
chmod 600 "$HOME/Library/Application Support/repo-mcp/policies/onboarding.json"
npm run coord -- repository add --repository repo-mcp-onboarding \
  --repo "$HOME/Library/Application Support/repo-mcp/onboarding/repo" \
  --policy "$HOME/Library/Application Support/repo-mcp/policies/onboarding.json"
npm run coord -- task bind --repository repo-mcp-onboarding --task repo-mcp-onboarding-smoke
```

In every configured client (Claude Code and/or ChatGPT), call `service_info` and
`repository_list`, open an `inspect` workspace for repository
`repo-mcp-onboarding` and task `repo-mcp-onboarding-smoke` with a fresh request ID,
then call scoped `repo_info`.
Verify the fixture root/branch/HEAD and read its complete `AGENTS.md` and `README.md`;
inspect the complete diff and close the workspace. No write grant is needed.
The fixture contains an intentionally failing clamp test; that is unrelated to this
read-only transport/schema smoke. Local health alone does not pass this gate.

The preparation command refuses overwrite. Never remove or reset a user's checkout.
Reuse an unfinished smoke task; if it was already finished, bind a fresh task ID
such as `repo-mcp-onboarding-smoke-YYYYMMDD` and use that ID in the client calls.
After successful smoke, the operator may finish this disposable task with
`npm run coord -- task finish --task repo-mcp-onboarding-smoke`.

## Connect a repository

1. Resolve the exact checkout with `git rev-parse --show-toplevel` and read its root
   instructions. Never guess among sibling checkouts or worktrees.
2. Locate the installed Repo MCP control checkout from launchd `WorkingDirectory`,
   verify its coordinator, and read `docs/SHARED-REVIEW-WORKFLOW.md` there. Installed
   skills are standalone; never assume that reference is adjacent to this file.
3. Resolve the checkout with
   `npm run --silent coord -- repository resolve --repo CURRENT_ROOT`. Reuse the
   registration. If it is absent, create a narrow owner-only external policy and stable
   internal repository ID yourself. Do not ask the user for repository/task/policy/token
   identifiers.
4. Preserve the one-unfinished-task/one-coding-owner invariant. Do not bind a second
   unfinished task, freeze or rebind another coding owner, or revive stale authority.
5. Review and architecture are read-only. Coding is allowed: ChatGPT web makes the edits
   through a `code` workspace, and Claude coordinates it with a single-use write grant
   (see "Coding run" below). Claude never edits a served repository through Repo MCP
   itself.

The normal user prompts `Use Repo MCP to review this repository`, `Use Repo MCP to
architect this repository` and `Use Repo MCP to code this task: ...` mean **ChatGPT web performs the semantic work** while Claude
coordinates local setup and Claude's host-native browser controls. Never substitute
Claude's own analysis, Work, Oracle, or a Claude subagent.

For review use the `repo-mcp-review` skill and `coord review prepare-or-join`.
Discover the sole safe review task from owner-side repository/catalog status before final
prompt construction, embed that exact `TASK_ID`, and always prepare with
`--task TASK_ID`. Zero/multiple/coding or conflicting state requires owner action
and is never auto-fixed. A binding that is stale only because HEAD moved is refreshed
with `coord task rebind` (it refuses protected reviewers and coding owners) and reported. Omitting `--task` is a separate combined
selection+durable-preparation API for callers intentionally delegating task selection; it
is not discovery and the browser handoff never uses it. Profile `review` is Extra
High; `review-critical` is explicit super-complex Pro. Compatible Codex/Claude
reviews may share one task/target while keeping distinct participants, normal Chat
sessions, workspace requests/runs/workspaces, and results. When the user requests review
of an immutable commit range, use the review skill's commit-pinned
`--base-ref ... --head-ref ... [--scope-prefix ...]` path; otherwise preserve the
legacy `phase_only` working-target workflow.

For architecture, planning, or brainstorming intentions, use the implemented generic
`chatgpt-run prepare --kind architecture --profile architecture --surface chat` route
with an `inspect` workspace and Pro. Planning/brainstorming do not have separate
executable work kinds or profiles. Do not use shared-review prepare-or-join or an
unsolicited review freeze.

Recover the same submitted normal Chat conversation/run after interruption. Report
`Execution surface: ChatGPT web`, `Coordinator: Claude Code`, and
`Repository evidence: Repo MCP`.

## Local state maintenance

When the user asks to clean Repo MCP state, run `coord gc --dry-run` first and explain
the exact plan. Use `coord gc --apply` only within the requested cleanup scope. Treat
exit 2 or `complete: false` as a partial cleanup that needs inspection; never recover or
delete a reported lock automatically. GC does not remove ChatGPT or Claude chats.

## Command recipes

Run these literally from the control checkout. Do not re-derive commands from SETUP.md,
source code or old transcripts, and do not hand them to the user to run.

```bash
ROOT=$(git rev-parse --show-toplevel)   # run first, inside the user's project
C=$(plutil -extract WorkingDirectory raw ~/Library/LaunchAgents/local.repo-mcp.server.plist); cd "$C"
now(){ python3 -I -c 'import datetime;print(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z"))'; }
```

### Check health

```bash
npm run --silent coord -- service status          # expect "local_mcp": "ready"
npm run --silent connection:status                # expect "state": "ready" (ChatGPT tunnel)
claude mcp get repo-mcp                           # expect "Connected", http://127.0.0.1:8787/mcp
python3 scripts/install-agent-skills.py --check   # expect "agent skills are current"
```

Local health is not route proof. Prove a client route with real tool calls: load the
`mcp__repo-mcp__*` tools, then call `service_info`, `repository_list`, `workspace_open`
(repository `repo-mcp-onboarding`, task `repo-mcp-onboarding-smoke`, mode `inspect`, a
fresh `request_id`), `repo_info`, `read` `README.md`, and `workspace_close` (another
fresh `request_id`). After any real run, the broker audit log shows each client call:
`tail -5 "$HOME/Library/Application Support/repo-mcp/state/multirepo-audit.jsonl"` (`"ok": true`).

### Connect a repository

```bash
npm run --silent coord -- repository resolve --repo "$ROOT"   # "repository": null means not registered
```

Reuse an existing registration. Only when it is `null`:

```bash
REPO=$(basename "$ROOT" | tr 'A-Z_ ' 'a-z--' | tr -cd 'a-z0-9.-')
P="$HOME/Library/Application Support/repo-mcp/policies/$REPO.json"
cp -n docs/policy-readonly.json "$P"; chmod 600 "$P"   # add this repo's build, dependency and data folders to read.exclude
npm run --silent coord -- repository add --repository "$REPO" --repo "$ROOT" --policy "$P"
```

Then bind a task only if the repository has no unfinished task:

```bash
npm run --silent coord -- task bind --repository "$REPO" --task "$REPO-review-$(date +%Y%m%d)"
```

`repository add` refuses nested, duplicate or overlapping checkouts and policies inside
a served checkout. `task bind` refuses a second unfinished task; reuse that task instead.

### Deploy a Repo MCP change

Only when Repo MCP source changed (an upgrade or a fix). Never just to switch repositories.

```bash
npm ci                      # only when package-lock.json changed
npm run build
npm test                    # run in the background; takes about 5 minutes
```

Time-limited tests (for example "large trees list and page within budget") can fail when
the machine is busy. Rerun only the failing tests alone with
`npx tsx --test --test-name-pattern="TEST NAME" test/FILE.test.ts`; any other failure
blocks the deploy. Before restarting, prove every stored repository policy still compiles:

```bash
node --input-type=module -e 'import {readdir,readFile} from "node:fs/promises"; import {loadPolicy,compilePolicy} from "./dist/src/policy.js"; const d=process.env.HOME+"/Library/Application Support/repo-mcp/state/policies"; let bad=0; for (const f of (await readdir(d)).filter(f=>f.endsWith(".json"))) { try { compilePolicy(loadPolicy(JSON.parse(await readFile(d+"/"+f,"utf8")).data)); } catch(e) { bad++; console.log("FAIL",f,e.message); } } console.log("policy snapshots failing:",bad)'
```

Stop if any fail. Otherwise:

```bash
python3 scripts/install-agent-skills.py --install
npm run --silent coord -- service start     # reloads launchd; interrupts in-flight calls
npm run --silent coord -- service status    # new process_pid, "local_mcp": "ready"
```

Then run the client route proof above. After an MCP schema change, also refresh the
Repo MCP app's tools in ChatGPT and start a new ChatGPT conversation.

### Coding run

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
   ends the run. Revoke the unused grant with
   `npm run --silent coord -- workspace revoke --grant "$(jget "$R/grant.json" grant_id)"`,
   then start again from issuing a new grant (the prompt names the grant and `WSREQ`).
   If the 2-minute window ran out before `observe` was recorded, first close the run
   with `npm run --silent chatgpt-run -- fail-pre-submit --run "$RUN" --failure-code MODEL_OBSERVATION_EXPIRED`.
9. **Send once.** Close any open picker menu, then click the composer's **Send** button
   (pressing Return after closing a menu may do nothing). Wait 5 seconds, then confirm
   the send: the URL is `/c/CONVERSATION_ID` and the composer is empty. If not, wait 5
   more seconds and check again before clicking Send again. If you still cannot tell,
   record `chatgpt-run uncertain` and recover; never send twice blindly.
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
   (() => { const m = [...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1);
     const t = (m ? m.innerText : (document.querySelector('main')?.innerText || '')).trim();
     return {busy: !!document.querySelector('[data-testid="stop-button"],button[aria-label*="Stop"]'), chars: t.length, tail: t.slice(-150)}; })()
   ```
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
14. **Check the result locally, outside MCP:** `git -C "$ROOT" diff`, the project's own
   tests and build. Commit and push only when the user asks. To move the task to review:
   `npm run --silent coord -- task phase --task "$TASK" --phase review`.

### Recover a run

Use the run's own IDs from its run folder. Never resend a prompt that may have been sent.

```bash
npm run --silent chatgpt-run -- status --run "$RUN"
```

- **Not sent yet, and the selection expired before `observe` was recorded:** close the
  run, then prepare a new one. (After a failed `observe` or `reserve` the run is
  already closed; do not run `fail-pre-submit` again.)
  ```bash
  npm run --silent chatgpt-run -- fail-pre-submit --run "$RUN" --failure-code MODEL_OBSERVATION_EXPIRED
  ```
- **Not sure whether it was sent:** mark it, check the ChatGPT conversation, then
  resolve it with the same receipt flags as `submitted`.
  ```bash
  npm run --silent chatgpt-run -- uncertain --run "$RUN" --failure-code SUBMISSION_UNCERTAIN
  NOW=$(now); npm run --silent chatgpt-run -- recover --run "$RUN" --resolution submitted \
    --repository "$REPO" --task "$TASK" --prompt-sha256 "$PSHA" --base-commit "$BASE" \
    --browser-event-id "chatgpt-recover-CONVERSATION_ID-$NOW" --observed-at "$NOW" --session-id "$SID"
  # commit-pinned review runs also need: --head-commit "$HEADC" --candidate-digest "$CDIG"
  # use --resolution not-submitted when the conversation shows no sent prompt
  ```
- **A review participant is left behind after a failed run:**
  `npm run --silent coord -- review recover-participant --task "$TASK" --participant "$PART"`.
- **A lock is left by a dead process** (check the recorded PID is gone first):
  `coord service recover-stale-control`, `coord task recover-stale --task "$TASK"`,
  `coord workspace recover-stale --workspace WORKSPACE_ID`,
  `chatgpt-run recover-lock --run "$RUN"`.

Failure codes must be uppercase identifiers. Report what you recovered.

### Clean up local state

```bash
npm run --silent coord -- gc --dry-run    # read-only plan; explain it
npm run --silent coord -- gc --apply      # only within the requested scope
```

Exit 2 or `"complete": false` means a partial cleanup; inspect, never force. GC never
touches ChatGPT or Claude conversations.

## Handoff and authority

For an explicitly requested read-only handoff, give the target conversation only the
repository and task IDs. Claude issues a write grant only for a coding run it
coordinates itself, never for a handoff. Never make a handoff the default
current-session workflow.

Repository registration, policy changes, task phases, grants, service control, Git
branch/worktree changes, commit, push, dependency installation, and arbitrary shell
remain trusted local coordinator actions. Repo MCP exposes none of them. Use the
separate `repo-mcp-review` and `repo-mcp-architect` skills for ChatGPT web review and
architecture coordination.

See `SETUP.md` and `docs/MULTI-REPO-SPEC.md` in the Repo MCP source checkout for exact
recovery and migration rules.
