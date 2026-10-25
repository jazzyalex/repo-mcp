---
name: repo-mcp
description: Operate Repo MCP for ChatGPT web coding, review, and architecture, coordinated locally by Codex; Claude can coordinate the same flows.
---

# Repo MCP operator

Use one installed Repo MCP broker across approved repositories. The user describes the
outcome; run the installation and coordinator commands yourself. Repository selection is
per workspace and does not restart or retarget the service. Filesystem roots, policies,
task phases and write grants remain local operator decisions; the model selects only
registered repository/task IDs.

Never ask the user to provide `REPOSITORY_ID`, `TASK_ID`, policy paths, or workspace
tokens for the current checkout. Resolve existing registration with
`npm run --silent coord -- repository resolve --repo CURRENT_ROOT`; create missing local
state yourself. Keep generated identifiers internal unless reporting them helps recovery.

Common requests are:

- "Use the Repo MCP skill to install Repo MCP and verify Claude Code and ChatGPT access."
- "Use the Repo MCP skill to connect this repository for read-only review."
- "Use the Repo MCP skill to prepare this repository for coding task NAME."

When this skill is invoked from another project, locate the installed Repo MCP control
checkout from the `WorkingDirectory` in
`~/Library/LaunchAgents/local.repo-mcp.server.plist` and verify that it contains the
expected `package.json` and coordinator. Run Repo MCP control commands there while
treating the user's current Git checkout as the repository being registered. If the
service is not installed and no source checkout was provided, clone the public Repo MCP
repository into a user-approved development location first.

## First-time setup or upgrade

1. Work from the Repo MCP source checkout. Read `README.md`, `SETUP.md`, and its root
   instructions. Verify macOS, Git, npm, Node 26 or newer, and Python 3.9 or newer.
   Run `python3 scripts/check-prerequisites.py` before installation. pytest is optional
   and used only for the Python fixture runner.
2. Inspect existing Repo MCP launchd definitions and state before changing them. Never
   overwrite a foreign or modified service. If a service exists, read its
   `WorkingDirectory` and perform the upgrade from that control checkout; never relocate
   it merely because setup began in another clone. For v0.1, follow the documented
   migration before issuing a v0.2 workspace or write grant.
3. Run `npm ci`, `npm run build`, `npm test`, and
   `python3 scripts/install-agent-skills.py --install`. From the selected control
   checkout, run `python3 scripts/install-server-service.py --install`, configure the
   broker if needed, and inspect `service status`. Run `service start` only for first
   load or intentional upgrade/recovery because it reloads launchd and may interrupt
   in-flight calls.
4. Configure the durable tunnel only if missing or unhealthy. Reuse saved credentials.
   If no tunnel ID/runtime credential exists, explain the one-time account step and guide
   the user through creating a private tunnel and a runtime key with **Tunnels Read +
   Use**. Accept the key only through the hidden prompt used by
   `scripts/connect.sh --save-key`; never ask for it in chat or in a command. Install the
   tunnel service and verify `npm run connection:status`.
5. Configure Claude Code for the current user when it is not already connected. Require
   `claude mcp get repo-mcp` to show the stdio bridge (`dist/src/stdio-main.js`). When
   missing, or when it is an older `--transport http` entry (the broker now requires its
   client token, which only the bridge adds), run from the control checkout
   `claude mcp remove --scope user repo-mcp` if needed, then
   `claude mcp add --scope user repo-mcp -- "$(command -v node)" "$PWD/dist/src/stdio-main.js" --original-names`,
   and verify it with `claude mcp list`.
6. Help create or refresh the developer-mode ChatGPT MCP app using the private tunnel.
   Use available authorized browser control; otherwise ask for the single precise UI
   action. After a schema update, use **Refresh tools** and a new ChatGPT conversation.
   Repository selection alone never needs a refresh.
7. Prepare the explicit disposable `repo-mcp-onboarding` / `repo-mcp-onboarding-smoke`
   target below, then prove each configured real client route with `service_info`,
   `repository_list`, `workspace_open`, scoped `repo_info`, and `workspace_close`.
   Local process/tunnel health alone is insufficient.

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

## Prepare a repository and task

1. Resolve the intended checkout with `git rev-parse --show-toplevel`. Read its root
   agent instructions before changing Repo MCP state. Never guess among sibling
   checkouts/worktrees.
2. Create the operator policy outside every served repository, normally under
   `~/Library/Application Support/repo-mcp/policies/`, owner-only. Exclude generated
   caches, dependencies, build products, vendor snapshots, credentials and private
   operator state. Start from `docs/policy-readonly.json` or `docs/policy-coding.json` in the control
   checkout and tailor them. Expose only the requested task scope. Grant write/create only where
   the task needs them; inspection and planning should remain read-only.
3. Verify the permanent broker separately from repository state:

   ```sh
   npm run --silent coord -- service status
   npm run --silent connection:status
   ```

   Start/rebuild the service only for deployment/recovery, never merely to select a
   repository.
4. Resolve the current checkout first:

   ```sh
   npm run --silent coord -- repository resolve --repo /absolute/path/to/checkout
   ```

   Reuse the returned registration. Register the checkout only when no match exists:

   ```sh
   npm run --silent coord -- repository add \
     --repository REPOSITORY_ID \
     --repo /absolute/path/to/checkout \
     --policy "$HOME/Library/Application Support/repo-mcp/policies/NAME.json"
   ```

5. Bind a new task ID to the registered checkout:

   ```sh
   npm run --silent coord -- task bind \
     --repository REPOSITORY_ID \
     --task TASK_ID
   ```

   Never silently replace an unfinished task. One unfinished task owns one registered
   checkout; use separately registered Git worktrees for independent concurrent coding.

## Coding handoff

For a coding conversation, issue one short-lived write grant:

```sh
npm run --silent coord -- workspace grant --task TASK_ID
```

Give the coding conversation the exact REPOSITORY_ID, TASK_ID and returned write grant.
The model must:

1. call `service_info`;
2. call `repository_list` and verify the named task exists;
3. call `workspace_open` in `code` mode with that grant;
4. pass the returned `workspace_token` to every repository tool;
5. call scoped `repo_info`, verify root/branch/HEAD/task/phase/policy scope and read the
   complete instruction file before edits;
6. use fresh file hashes and fresh public request IDs; after a lost mutation reply,
   retry the identical workspace/request/arguments;
7. inspect the complete paginated `git_diff`.

Do not copy workspace/write-grant tokens into source, logs or unrelated conversations.
They are bearer capabilities, not proof of conversation identity.

Run real project builds/integration tests locally through the trusted coordinator.
MCP `run_tests` is only for policy-approved fixture suites.

For coding, Codex is the coordinator and ChatGPT web is the worker. Keep repository ID,
task ID, grant, and browser references internal. Start the ChatGPT coding conversation
with `chatgpt-run go --kind code` (the "Coding run" recipe below): it issues the grant
itself, makes the conversation consume it, records every step in the durable `chatgpt-run` journal and recovers the
same run after any uncertain submission. The normal user prompt is simply `Use Repo MCP
to code this task: ...`. Do not perform the semantic coding work in Codex and relabel it
as Repo MCP/ChatGPT work.

## Review handoff

In this Codex skill, a request to "use Repo MCP review" means **ChatGPT web Chat
performs the semantic review** and Repo MCP is the repository evidence source. It must
not be satisfied by a Codex subagent or host-model review.

Resolve the installed control checkout from launchd `WorkingDirectory`, then read
`docs/SHARED-REVIEW-WORKFLOW.md` there and follow that accepted protocol. Do not
assume the reference was installed beside this standalone skill.

Use `coord review prepare-or-join`, not an automatic freeze-first handoff. First
discover the sole safe review task from owner-side repository/catalog status before
constructing the final browser prompt. Embed that exact `TASK_ID` in the prompt and
always call prepare-or-join with `--task TASK_ID`. Zero/multiple/coding or
conflicting state requires owner action and must not be silently rebound/frozen. A
binding that is stale only because HEAD moved is refreshed with `coord task rebind` (it
refuses protected reviewers and coding owners) and reported. Omitting
`--task` is a separate combined selection+durable-preparation API for callers that
intentionally delegate task selection; it is not discovery and the browser handoff never
uses it. Compatible reviewers share one target generation but retain distinct
participants, normal Chat sessions, workspace requests/runs/workspaces, and results.

Use model profile `review` (Extra High) by default and `review-critical` (Pro)
only for explicitly super-complex/critical Pro review. Verify Chat surface, exact live
effort evidence, Repo MCP attachment and visible chip. Record a visible model label only
as optional evidence. Never silently fall back
to Work, Oracle, a Codex subagent, Claude-native review, or another backend.

For every work kind, completion must use a trusted finished-response receipt with
`kind: "completion"`, `responseState: "completed"`, the submitted event hash, and
the observed output digest. Never reuse the submission event or derive browser proof
from supplied output text. The `complete` CLI requires `--response-state completed`,
`--submission-event-sha256`, and `--output-sha256`.
After a crash during initialization or terminal cleanup, use explicit
`chatgpt-run recover-request --request-key REQUEST_KEY` as documented in `SETUP.md`;
unresolved runs must still be recovered by their existing run identity. Reclaim an
orphan only after the helper proves its initializer is dead on this host.

Every review report must identify `Execution surface: ChatGPT web`, `Coordinator:
Codex`, verified model/profile when available, `Repository evidence: Repo MCP`, and the
selected diff base/resolved commit. Never label a Codex or Claude review as a ChatGPT
Repo MCP review.

Before preparing the shared review, choose the target mode. Legacy working review
resolves the intended Git base to an immutable commit. For commit-pinned review choose
explicit `base_ref` + `head_ref` and optional `scope_prefix`; never request
`head_ref` without `base_ref`. Preallocate both a unique `workspace_open` request ID
and one stable logical browser session ID. Preserve a private mapping from that session ID
to the normal ChatGPT conversation URL/tab; never use Temporary Chat. Construct the
**final** browser prompt with repository/task IDs, review workspace mode, request ID and
selected target already present. For commit-pinned work include requested base/head/scope
and expected resolved commits, and require browser `workspace_open` to use those same
requested values. Do not append handoff text or a late conversation ID after prompt
hashing.

Run `coord review prepare-or-join --task TASK_ID` (adding
`--base-ref ... --head-ref ... [--scope-prefix ...]` for commit-pinned review), persist
its nested result, and save exact `prepared.run` separately. Before
observe/reserve/send, compare both returned task IDs (`participant.task_id` and
`run.task_id`) to the exact task embedded in the final prompt and compare the returned
resolved base to the pre-resolved commit. For commit-pinned review also require exact
`participant.commit_binding === run.commit_binding` in value, including resolved head,
scope and candidate digest. Stop on any mismatch and never rewrite the hashed prompt.
Observe the live Chat control, reserve the saved run once, and submit only when
`submission_authorized: true`; the entire outer `{generation, participant, run}`
object is never a reserve contract.

After ChatGPT opens the preallocated review workspace, reconcile only by task and
participant; never pass a caller workspace ID. Commit-pinned browser `workspace_open`
must use the same requested base/head/scope as preparation. Reconciliation must be bound
before normal completion. In the pinned workspace, verify `repo_info.review_assurance`
is `commit_pinned`, read instructions/context from the bound head, and page the bound
commit `git_diff`; inconsistent read/diff refs or scope must fail closed. Do not request
`run_tests` from a read-only review workspace: local tests/typecheck are separate
coordinator evidence. Record actual submission and finished-response receipts, then close
only that participant with a fresh close request ID. A compatible sibling remains live.
If submission becomes uncertain, recover the same run and normal Chat conversation
without resending.

Legacy working-target review remains `phase_only`. Commit-pinned assurance binds format
version, policy, immutable base/head and scope through a domain-separated candidate
digest, but that digest is not a blanket whole-repository SHIP claim and binary/non-text
identity is not semantic review. The deferred large-diff manifest/per-path feature remains
unavailable. Incomplete bounded diff/read coverage cannot justify SHIP.

Shared review never steals the coding owner. Before an explicit owner transition from
coding to review, close the coding workspace and durably complete/reconcile its run.
Normal phase/rebind/finish operations refuse protected participants, active relevant
workspaces/admitted operations, and currently authorized unresolved runs. Returning to
coding requires explicit owner action, a fresh write grant, and a new coding workspace;
old coding tokens never revive.

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
     --coordinator codex --kind review --profile review --workspace-request-id "$WSREQ" \
     --base-ref "$BASE" --head-ref "$HEADC" --prompt-file "$R/prompt.txt" > "$R/go.json"; echo "exit=$?" >> "$R/go.json"
   ```
   In Codex, start it as a background process and wait for it to exit. An Extra High review takes about 5–15 minutes. Do not check on it in
   between.
5. **Read the result** (first line of `$R/go.json`, one JSON object):
   - `exit=0`, `phase: cleaned`: read the review from `output_file`. `outcome` is `ship`
     or `no-ship`. It comes from the `finish` report when `output_source` is
     `mcp-report`; otherwise (only with the owner's `page_text_fallback` opt-in; without
     it the run holds `MCP_REPORT_MISSING`) from the last `VERDICT:` line of the page text, and a
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
claude mcp get repo-mcp                           # expect "Connected", stdio bridge dist/src/stdio-main.js
python3 scripts/install-agent-skills.py --check   # expect "agent skills are current"
```

Local health is not route proof. Prove a client route with real tool calls: Codex coordinates and is not
itself a Repo MCP client. The ChatGPT route is proven by the next real run, whose
conversation must show `service_info`, `repository_list` and `workspace_open`. If Claude
Code is installed, its route is proven by the Claude skill's tool-call check. After any real run, the broker audit log shows each client call:
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

ChatGPT does the coding through Repo MCP; Codex coordinates and never edits the served
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
     --coordinator codex --kind code --profile code --workspace-request-id "$WSREQ" \
     --check "PROJECT TEST COMMAND" --prompt-file "$R/prompt.txt" > "$R/go.json"; echo "exit=$?" >> "$R/go.json"
   ```
   Use `--profile code-hard` (Extra High) for hard changes. Add `--exec` only when
   ChatGPT should run builds and tests itself through the `exec` tool. Repeat `--check`
   for each project check (tests, typecheck, lint). In Codex, start it as a background process and wait for it to exit. A coding run usually takes
   5–20 minutes.
   Never edit, switch branches or commit in this checkout while the run is active (also
   from parallel sessions): the binding or candidate goes stale (`PREPARE_FAILED` "binding
   is stale", or exit 3 "candidate changed"). Edit in a separate worktree instead.
4. **Read the result** (first line of `$R/go.json`, one JSON object):
   - `exit=0`, `phase: cleaned`: read the answer from `output_file`. `sealed: revoked`
     means no further edit can land. Each `checks[]` entry has `exit_code`, `timed_out`,
     a `tail` and a full `log`. `candidate_changed: true` means a check changed the
     checkout; inspect before you trust the results.
   - `exit=3`: the prompt may have been sent. Run `go --request-id "$GOREQ" --resume`
     once; never start a new request. If it still exits 3, report `conversation_url`
     and stop.
     `failure_code: MCP_REPORT_MISSING` means ChatGPT gave no `finish` report and the
     owner has not opted in to reading the page (`account config-set
     page_text_fallback=true`); report `conversation_url` and stop.
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

## Local state maintenance

When the user asks to clean Repo MCP state, run `coord gc --dry-run` first and explain
the exact plan. Use `coord gc --apply` only within the requested cleanup scope. Treat
exit 2 or `complete: false` as a partial cleanup that needs inspection; never recover or
delete a reported lock automatically. GC does not remove ChatGPT or Claude chats.

## Authority boundaries

- Repository add/enable/disable/remove, task bind/phase/rebind/finish, grant/revoke,
  service control, policies, Git commit/push, branch/worktree changes and arbitrary
  shell remain coordinator/operator actions.
- The MCP never accepts a filesystem root or policy path for repository selection.
- Repository switching uses a new workspace token; it does not call `service start`.
- Disable/rebind/phase/finish intentionally invalidate old workspace authority.
- Commit/push remain outside MCP and need the user's normal authorization.
- Keep the existing tunnel/plugin across repository switches. Refresh plugin tools only
  after a deployed schema change, not after ordinary repository selection.

See `docs/MULTI-REPO-SPEC.md` for the normative v0.2 contract.
