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

Repo MCP is the repository-access layer; it does not choose or launch the reviewing
model. In this Codex operator skill, a request to "use Repo MCP review" means an
independent **ChatGPT web** review. Do not satisfy it with a Codex subagent or the current
Codex conversation merely calling Repo MCP. Those are Codex reviews, consume Codex
usage, and are outside the Repo MCP review product contract.

For the independent route, prepare and freeze the repository task locally, then use
host-native browser control to drive the user's signed-in ChatGPT web conversation. Use
the durable `chatgpt-run` prepare/observe/reserve/submitted/complete contract described
in `SETUP.md`; do not invoke `model-policy run`, Oracle, or another external launcher unless
the user explicitly names that backend. Use model profile `review` (Sol Extra High) by
default. Use `review-critical` (Sol Pro) only when the user asks for Pro or the review is
explicitly classified as critical/architectural. The selected browser tab must already
have Repo MCP attached; the submitted prompt must make the ChatGPT conversation call
`service_info` and open the review workspace itself. If host-native browser control,
model evidence, or Repo MCP attachment cannot be verified, report the review as
`NOT TESTABLE`; never silently substitute a Codex subagent, Claude, Oracle, or a local
source review. If a submitted browser run stalls or disconnects, recover that same
run/tab instead of submitting a duplicate. Record separate trusted browser receipts for
submission and completion; a local assertion without the matching browser context is not
completion evidence.

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

Freeze the whole task:

```sh
npm run --silent coord -- task phase --task TASK_ID --phase review
```

The transition drains admitted mutations/checks and advances the phase epoch, so every
older workspace for that task becomes stale. A separate reviewer opens a fresh
`review` workspace; no write grant is needed.

Before the ChatGPT browser launch, the Codex operator must resolve/register the target
checkout and create or reuse its review task. Keep those identifiers internal to the
user interaction, but include the exact repository and task IDs in the submitted browser
prompt so ChatGPT can call `repository_list` and `workspace_open`; no write grant is
needed. The normal user prompt remains `Use Repo MCP to review this repository`; do not
send the user elsewhere to obtain IDs. Choose the requested diff base before preparing
the run: use `HEAD` for uncommitted changes, `HEAD^` for the latest committed change, or
the user-named branch, tag, or commit. Put the immutable `resolved_base_commit` returned
by `chatgpt-run prepare` in the browser prompt. ChatGPT must pass that exact commit to
every `git_diff` page; it must not reinterpret the movable name after preparation. Never
treat a clean working tree as proof that requested changes were reviewed.

Current review assurance is `phase_only`: it is a task-wide write freeze, not a
content-verified candidate manifest. Do not present it as stronger evidence.

If repairs are required:

```sh
npm run --silent coord -- task phase --task TASK_ID --phase coding
npm run --silent coord -- workspace grant --task TASK_ID
```

Open a new coding workspace. A pre-review coding token never becomes valid again.

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
