---
name: repo-mcp
description: Install, configure, upgrade, or operate the permanent Repo MCP broker and connect approved local Git repositories for ChatGPT or Claude coding, planning, and review.
---

# Repo MCP operator

Use this skill when the user asks to set up Repo MCP, connect a local repository, or
prepare a Repo MCP coding or review task. The user should describe the outcome; run the
coordinator and installation commands yourself.

When invoked from another project, locate the installed Repo MCP control checkout from
the `WorkingDirectory` in `~/Library/LaunchAgents/local.repo-mcp.server.plist` and verify
its `package.json` and coordinator before running control commands there. The user's
current Git checkout is the repository being registered. If the service is not installed
and no source checkout was provided, clone the public Repo MCP repository into a
user-approved development location first.

## First-time setup or upgrade

1. Work from the Repo MCP source checkout. Read its `README.md`, `SETUP.md`, and current
   repository instructions. Verify macOS, Git, npm, and Node 26 or newer.
2. Inspect existing Repo MCP launchd definitions and state before changing them. Never
   overwrite a foreign or modified service definition. For an existing v0.1 service,
   follow the documented migration before issuing a v0.2 workspace or grant.
3. Run `npm ci`, `npm run build`, `npm test`, and
   `python3 scripts/install-agent-skills.py --install`. Then install the stable broker
   with `python3 scripts/install-server-service.py --install`, configure it if needed,
   start it with `npm run coord -- service start`, and verify `service status`.
4. Configure the durable tunnel only if it is missing or unhealthy. Reuse saved
   credentials. If no tunnel ID or runtime credential exists, explain the one-time
   account action and guide the user through creating a private tunnel and a runtime key
   with **Tunnels Read + Use**. Accept the key only through the hidden prompt used by
   `scripts/connect.sh --save-key`; never ask the user to paste it into chat or a command.
   Install the tunnel service and verify `npm run connection:status`.
5. Help create or refresh the developer-mode ChatGPT MCP app using the private tunnel.
   If browser control is available and authorized, do the UI work. Otherwise ask for the
   single required UI action precisely. A schema update requires **Refresh tools** and a
   new ChatGPT conversation; an ordinary repository switch does not.
6. Prove the real client route with `service_info`, `repository_list`,
   `workspace_open`, scoped `repo_info`, and `workspace_close`. Local process health is
   insufficient evidence.

## Connect a repository

1. Resolve the exact checkout with `git rev-parse --show-toplevel` and read its root
   instructions. Never guess among sibling checkouts or worktrees.
2. Create an owner-only v2 policy outside the checkout, normally under
   `~/Library/Application Support/repo-mcp/policies/`. Expose only files needed for the
   requested task. Exclude credentials, generated caches, dependencies, build products,
   private operator state, and unrelated large data. Grant write and creation only when
   coding is requested.
3. Register the checkout once with a stable repository ID. Bind a fresh task ID. Never
   silently replace an unfinished task. One unfinished task owns one registered checkout;
   concurrent coding uses separately registered Git worktrees.
4. For inspection or planning, use a read-only workspace. For coding, issue one
   short-lived write grant and give the target conversation only the repository ID, task
   ID, and grant. For review, freeze the task in `review` and open a fresh review
   workspace without a write grant.

## Handoff and authority

Tell the target conversation to verify `service_info`, select the exact registered
repository/task, inspect `repo_info`, read all instructions, and page through the entire
diff. Coding retries must reuse the same public request ID and identical arguments after
a lost response.

Repository registration, policy changes, task phases, grants, service control, Git
branch/worktree changes, commit, push, dependency installation, and arbitrary shell
remain trusted local coordinator actions. Repo MCP exposes none of them. Use the
separate `repo-mcp-review` skill for an evidence-only review.

See `SETUP.md` and `docs/MULTI-REPO-SPEC.md` in the Repo MCP source checkout for exact
recovery and migration rules.
