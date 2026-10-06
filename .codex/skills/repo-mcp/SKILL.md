---
name: repo-mcp
description: Install, configure, upgrade, or operate the permanent Repo MCP broker and connect approved local Git repositories for ChatGPT or Claude coding, planning, and review.
---

# Repo MCP operator

Use one installed Repo MCP broker across approved repositories. The user describes the
outcome; run the installation and coordinator commands yourself. Repository selection is
per workspace and does not restart or retarget the service. Filesystem roots, policies,
task phases and write grants remain local operator decisions; the model selects only
registered repository/task IDs.

Common requests are:

- "Use the Repo MCP skill to install Repo MCP and verify ChatGPT access."
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
   instructions. Verify macOS, Git, npm, and Node 26 or newer.
2. Inspect existing Repo MCP launchd definitions and state before changing them. Never
   overwrite a foreign or modified service. For v0.1, follow the documented migration
   before issuing a v0.2 workspace or write grant.
3. Run `npm ci`, `npm run build`, `npm test`, and
   `python3 scripts/install-agent-skills.py --install`. Install the stable broker with
   `python3 scripts/install-server-service.py --install`, configure it if needed, start
   it with `npm run coord -- service start`, and verify `service status`.
4. Configure the durable tunnel only if missing or unhealthy. Reuse saved credentials.
   If no tunnel ID/runtime credential exists, explain the one-time account step and guide
   the user through creating a private tunnel and a runtime key with **Tunnels Read +
   Use**. Accept the key only through the hidden prompt used by
   `scripts/connect.sh --save-key`; never ask for it in chat or in a command. Install the
   tunnel service and verify `npm run connection:status`.
5. Help create or refresh the developer-mode ChatGPT MCP app using the private tunnel.
   Use available authorized browser control; otherwise ask for the single precise UI
   action. After a schema update, use **Refresh tools** and a new ChatGPT conversation.
   Repository selection alone never needs a refresh.
6. Prove the real route with `service_info`, `repository_list`, `workspace_open`, scoped
   `repo_info`, and `workspace_close`. Local process/tunnel health alone is insufficient.

## Prepare a repository and task

1. Resolve the intended checkout with `git rev-parse --show-toplevel`. Read its root
   agent instructions before changing Repo MCP state. Never guess among sibling
   checkouts/worktrees.
2. Create the operator policy outside every served repository, normally under
   `~/Library/Application Support/repo-mcp/policies/`, owner-only. Exclude generated
   caches, dependencies, build products, vendor snapshots, credentials and private
   operator state. Expose only the requested task scope. Grant write/create only where
   the task needs them; inspection and planning should remain read-only.
3. Verify the permanent broker separately from repository state:

   ```sh
   npm run --silent coord -- service status
   npm run --silent connection:status
   ```

   Start/rebuild the service only for deployment/recovery, never merely to select a
   repository.
4. Register the checkout once if it is not already in `repository list`:

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

## Review handoff

Freeze the whole task:

```sh
npm run --silent coord -- task phase --task TASK_ID --phase review
```

The transition drains admitted mutations/checks and advances the phase epoch, so every
older workspace for that task becomes stale. A separate reviewer opens a fresh
`review` workspace; no write grant is needed.

Current review assurance is `phase_only`: it is a task-wide write freeze, not a
content-verified candidate manifest. Do not present it as stronger evidence.

If repairs are required:

```sh
npm run --silent coord -- task phase --task TASK_ID --phase coding
npm run --silent coord -- workspace grant --task TASK_ID
```

Open a new coding workspace. A pre-review coding token never becomes valid again.

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
