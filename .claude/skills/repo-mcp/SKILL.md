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
coordinates local setup and starts `chatgpt-run go`, which drives the browser. Never substitute
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
repository through Repo MCP itself. `chatgpt-run go --kind code` does every browser and
journal step in code: it issues the single-use write grant and appends it to the sent
text, attaches Repo MCP, selects the effort, sends once, waits, saves the answer,
revokes the coding workspace, runs your checks and archives the chat. Do not drive the
browser yourself and do not poll the page.

```bash
C=$(plutil -extract WorkingDirectory raw ~/Library/LaunchAgents/local.repo-mcp.server.plist); cd "$C"
R=$(mktemp -d)  # private run folder (mode 700); keep the prompt file until go finishes
```

Browser prerequisite: the owner's main Chrome runs with remote debugging enabled in
`chrome://inspect/#remote-debugging` and is signed in to ChatGPT. Chrome asks the owner
to approve `go`'s relay once per Chrome start. Never connect to Chrome's debugging port
yourself.

1. **Set the run variables.** `npm run --silent coord -- repository resolve --repo "$ROOT"`
   gives `REPO` and its unfinished coding `TASK` (bind one with `coord task bind` when
   there is none). Set `GOREQ=$REPO-code-$(date +%Y%m%dT%H%M%S)-$RANDOM` and
   `WSREQ=$REPO-code-ws-$(date +%Y%m%dT%H%M%S)-$RANDOM`. The phase must be coding:
   ```bash
   npm run --silent coord -- task status --task "$TASK"                 # phase must be coding
   npm run --silent coord -- task phase --task "$TASK" --phase coding   # only if it is in review; refuses protected reviewers
   ```
2. **Write `$R/prompt.txt`** with repository ID, task ID, `code` mode, `workspace_open`
   request ID `$WSREQ`, the expected HEAD, the coding instructions, "use the write_grant
   on the last line of this message", "before `workspace_close`, call `finish` once with
   outcome `completed` and a summary of your changes and checks", and "end with one
   VERDICT line". Never put a grant in the prompt; `go` adds it.
3. **Run `go` once, in the background:**
   ```bash
   npm run --silent chatgpt-run -- go --request-id "$GOREQ" --repository "$REPO" --task "$TASK" \
     --coordinator claude --kind code --profile code --workspace-request-id "$WSREQ" \
     --check "PROJECT TEST COMMAND" --prompt-file "$R/prompt.txt" > "$R/go.json"; echo "exit=$?" >> "$R/go.json"
   ```
   Use `--profile code-hard` (Extra High) for hard changes. Add `--exec` only when
   ChatGPT should run builds and tests itself through the `exec` tool. Repeat `--check`
   for each project check (tests, typecheck, lint). In Claude Code, run it with `run_in_background` and wait for the completion notification. A coding run usually takes
   5–20 minutes.
4. **Read the result** (first line of `$R/go.json`, one JSON object):
   - `exit=0`, `phase: cleaned`: read the answer from `output_file`. `sealed: revoked`
     means no further edit can land. Each `checks[]` entry has `exit_code`, `timed_out`,
     a `tail` and a full `log`. `candidate_changed: true` means a check changed the
     checkout; inspect before you trust the results.
   - `exit=3`: the prompt may have been sent. Run `go --request-id "$GOREQ" --resume`
     once; never start a new request. If it still exits 3, report `conversation_url`
     and stop.
   - `exit=1`, `phase: failed`: nothing was sent when `run_id` is null or the run is
     `failed-pre-submit`; the grant is already revoked. Retry once with a new `GOREQ`
     and `WSREQ` for `UI_*`, `COMPOSER_*` or `BROWSER_SETUP_FAILED`.
   - `{"error": CODE, ...}` with `exit=1`: nothing was sent. Stop on `ACCOUNT_LATCHED`,
     `RATE_LIMITED` and `REPOSITORY_BUSY` (another coding run owns this checkout).
5. **Check the result locally, outside MCP:** `git -C "$ROOT" diff`, the check logs, and
   anything the checks do not cover. Commit and push only when the user asks. To move
   the task to review: `npm run --silent coord -- task phase --task "$TASK" --phase review`.

If `go` cannot run at all, use `docs/CODING-MANUAL-RECIPE.md` in the control checkout
and say so; only after `go --status` shows your last request `cleaned` or `failed`.

### Recover a run

Use the run's own IDs from its run folder. Never resend a prompt that may have been sent.

```bash
npm run --silent chatgpt-run -- status --run "$RUN"
```

- **Not sent yet (a failed `observe` or `reserve`, or an expired selection):** close
  the run with the failure code `reserve` itself uses, so the command is a no-op when
  `reserve` already closed it. For a review, also recover and close the participant
  (see the review recipe), then prepare a new run.
  ```bash
  npm run --silent chatgpt-run -- fail-pre-submit --run "$RUN" --failure-code MODEL_SELECTION_NOT_VERIFIED
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
- **`task finish`, `task phase` or `task rebind` refuses with `REVIEW_PROTECTED` and names
  an open workspace:** a ChatGPT run ended without `workspace_close`. Check that no run
  of this task is still `submitted` or `uncertain` (`chatgpt-run status`), then revoke
  each named workspace and retry. Never edit Repo MCP state files by hand. A workspace
  also stops blocking on its own when it expires (8 hours after it opened).
  `npm run --silent coord -- workspace revoke --workspace WORKSPACE_ID`.
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
