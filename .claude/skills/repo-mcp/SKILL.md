---
name: repo-mcp
description: Operate Repo MCP from Claude as the local coordinator for ChatGPT web review and architecture; coding/write coordination stays with Codex.
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
2. Create an owner-only v2 policy outside the checkout, normally under
   `~/Library/Application Support/repo-mcp/policies/`. Start from `docs/policy-readonly.json` or `docs/policy-coding.json` in the control
   checkout and tailor them. Expose only files needed for the requested task. Exclude credentials, generated caches, dependencies, build products,
   private operator state, and unrelated large data. Grant write and creation only when
   coding is requested.
3. Resolve the checkout through `repository resolve`; register it once if missing with a
   stable collision-resistant repository ID. Bind a fresh internal task ID. Never
   silently replace an unfinished task. One unfinished task owns one registered checkout;
   concurrent coding uses separately registered Git worktrees.
4. For inspection, planning, and architecture, use a read-only workspace. For review,
   freeze the task in `review` and open a fresh review workspace without a write grant.
   Claude's maintained Repo MCP paths are read-only; do not issue or consume a coding
   write grant. Return coding/write work to the Codex Repo MCP operator.

The normal user prompt is simply `Use Repo MCP to review this repository` or `Use Repo
MCP to architect this repository`. Both mean that ChatGPT web performs the semantic
work through Repo MCP while Claude coordinates local setup and browser control. Do not
turn them into a request for coordinator identifiers. Keep repository/task IDs internal,
prepare the read-only task, and use Claude's host-native browser controls plus the
durable `chatgpt-run` contract to drive the user's signed-in ChatGPT conversation.
ChatGPT must open the exact Repo MCP workspace and perform the work. Never substitute
Claude's own analysis or invoke Oracle implicitly. Recover the same submitted browser
conversation after interruption, and report `Execution surface: ChatGPT web`,
`Coordinator: Claude Code`, and `Repository evidence: Repo MCP`.

## Local state maintenance

When the user asks to clean Repo MCP state, run `coord gc --dry-run` first and explain
the exact plan. Use `coord gc --apply` only within the requested cleanup scope. Treat
exit 2 or `complete: false` as a partial cleanup that needs inspection; never recover or
delete a reported lock automatically. GC does not remove ChatGPT or Claude chats.

## Handoff and authority

For an explicitly requested read-only handoff, give the target conversation only the
repository and task IDs. Claude does not issue coding grants. Never make a handoff the
default current-session workflow.

Repository registration, policy changes, task phases, grants, service control, Git
branch/worktree changes, commit, push, dependency installation, and arbitrary shell
remain trusted local coordinator actions. Repo MCP exposes none of them. Use the
separate `repo-mcp-review` and `repo-mcp-architect` skills for ChatGPT web review and
architecture coordination.

See `SETUP.md` and `docs/MULTI-REPO-SPEC.md` in the Repo MCP source checkout for exact
recovery and migration rules.
