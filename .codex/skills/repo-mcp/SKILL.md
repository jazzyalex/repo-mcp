---
name: repo-mcp
description: Bind the installed Repo MCP service to the current local Git checkout and coordinate policy-bounded ChatGPT or Claude coding, planning, and review.
---

# Repo MCP operator

Use one installed Repo MCP service sequentially across local repositories. The MCP
server never chooses a repository; the local coordinator binds the checkout and an
operator-owned policy before ChatGPT or Claude uses the tools.

## Select a repository

1. Resolve the current checkout with `git rev-parse --show-toplevel`. Read its root
   agent instructions before changing Repo MCP state.
2. Use the operator's canonical Repo MCP source checkout. Record it in
   `REPO_MCP_PROJECT` or resolve the installed checkout explicitly; never guess among
   sibling repositories. Build it before installing a changed server.
3. Inspect `npm run --silent coord -- status --json`. Never silently replace an
   unfinished task. Finish or rebind it only when the user's request authorizes moving
   Repo MCP to another task/repository.
4. Store policies outside served repositories, under
   `~/Library/Application Support/repo-mcp/policies/`, mode `0600`. Read access can be
   broad, but exclude generated caches, derived data, archives, vendor snapshots,
   credentials and project-private operator state. Grant write and creation only where
   the requested work needs them. Real project builds remain local coordinator actions;
   do not expose arbitrary shell commands as MCP checks.
5. For a new repository/task, use a new task ID:

   ```sh
   npm run --silent coord -- bind --task TASK_ID \
     --repo /absolute/path/to/checkout \
     --policy "$HOME/Library/Application Support/repo-mcp/policies/NAME.json"
   npm run --silent coord -- start
   npm run --silent coord -- status --json
   ```

6. Prove the local MCP route with a read-only handshake and `repo_info`. Confirm root,
   branch, HEAD, task ID, phase, policy digest, instruction path and all eight tools.
   Also require `npm run --silent connection:status` before relying on ChatGPT access.

## Use the bound service

- Coding or planning begins with `repo_info`, then the complete exposed instruction
  file. Use `list_files`, `search` and bounded `read` for evidence. Mutations use current
  hashes and unique request IDs. Run real builds/tests locally through Codex.
- Before an independent review, set the task phase to `review`; review the complete
  paged diff in a fresh ChatGPT or Claude conversation. Review mode is read-only.
- Commits, pushes, branch/worktree changes, service control and policy changes remain
  local coordinator actions and require the user's normal authorization.
- After a repository switch, server upgrade or tool-schema change, refresh the Repo MCP
  plugin tools, start a new chat and require a fresh `repo_info` before any mutation.

The stable tunnel and plugin are reused across repository switches. Do not create a new
tunnel, runtime key or plugin merely to bind another local checkout.
