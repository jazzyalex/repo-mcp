---
name: repo-mcp
description: Operate Repo MCP for ChatGPT web coding, review, and architecture, coordinated locally by Codex; Claude coordinates read-only review and architecture.
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
   `claude mcp get repo-mcp` to show the expected loopback endpoint. When missing, add
   the user-scoped HTTP server named `repo-mcp` at
   `http://127.0.0.1:8787/mcp`, then verify it with `claude mcp list`.
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
task ID, grant, and browser references internal; use host-native browser control to make
the ChatGPT coding conversation consume the grant and perform every Repo MCP read/write.
The normal user prompt is simply `Use Repo MCP to code this task: ...`. Do not perform
the semantic coding work in Codex and relabel it as Repo MCP/ChatGPT work.
Prepare a durable `chatgpt-run` with kind `code` and profile `code` or `code-hard`; record
the live picker observation, reserve immediately before the single prompt submission, submit only when
`submission_authorized` is `true`, and recover the same run after any uncertain submission.

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
always call prepare-or-join with `--task TASK_ID`. Zero/multiple/coding/stale or
conflicting state requires owner action and must not be silently rebound/frozen. Omitting
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
   Choose `SID=codex-REPO-review-STAMP` and `WSREQ=REPO-review-ws-STAMP` (fresh,
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
     --coordinator codex --profile review --surface chat --session-id "$SID" \
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
11. **Capture the answer** from the page into `$R/output.md`: read the last assistant
   message in the page (`[...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1).innerText`)
   and write that exact text to the file through the browser runtime's file access. If
   the text comes back truncated, use the Copy button and `pbpaste` instead.
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
