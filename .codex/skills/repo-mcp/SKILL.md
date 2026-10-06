---
name: repo-mcp
description: Register approved local Git checkouts with the permanent Repo MCP broker and coordinate policy-bounded ChatGPT or Claude coding, planning, and review.
---

# Repo MCP operator

Use one installed Repo MCP broker across approved repositories. Repository selection is
per workspace and does not restart or retarget the service. Filesystem roots, policies,
task phases and write grants remain local operator decisions; the model selects only
registered repository/task IDs.

## Prepare a repository and task

1. Resolve the intended checkout with `git rev-parse --show-toplevel`. Read its root
   agent instructions before changing Repo MCP state. Never guess among sibling
   checkouts/worktrees.
2. Keep the operator policy outside every served repository, normally under
   `~/Library/Application Support/repo-mcp/policies/`, owner-only. Exclude generated
   caches, vendor snapshots, credentials and private operator state. Grant write/create
   only where the task needs them.
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
