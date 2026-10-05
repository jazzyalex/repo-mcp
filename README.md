# Repo MCP

Repo MCP is a local, repository-scoped MCP server for ChatGPT and Claude Code. Eight tools expose a checkout through an explicit policy: `repo_info`, `list_files`, `search`, `read`, `edit`, `create_file`, `run_tests`, and `git_diff`.

The server makes no model API calls. ChatGPT or Claude supplies the model; Repo MCP supplies controlled access to local files and approved fixture tests. Git commits, pushes, task coordination, and unrestricted shell commands stay outside the MCP interface.

**Status:** source release candidate for trusted, single-user macOS use. Current support is macOS, Node 26+, Git, and npm. The official OpenAI tunnel client is required for ChatGPT access. Linux and Windows have not been certified.

## Install

```sh
npm ci
npm run build
npm test
```

Start with the disposable fixture before exposing a real checkout:

```sh
npm run prepare:fixture
REPO_ROOT="$PWD/.trial/repo" npm start
```

For daily use, install the repository-agnostic launchd service, bind a new task ID to one checkout and policy, then start it through the coordinator:

```sh
python3 scripts/install-server-service.py --install
npm run coord -- bind --task TASK_ID --repo /path/to/checkout \
  --policy /path/to/policy.json
npm run coord -- start
npm run coord -- status
```

Read [SETUP.md](SETUP.md) before installing the live service. It covers the private tunnel, durable task state, legacy-service migration, recovery, schema refresh, and exact coordinator commands.

## Policy and tools

Policies define readable and writable paths, scoped creation, dotfile access, approved tests, exclusions, and resource limits. Denials always win. `.git`, secret names, server-owned state, symlinks, unsafe paths, and files outside the configured scope are not exposed.

Reads, searches, listings, status, and diffs are paged. Mutations require current file hashes, exact unique text matches, and task-mode request IDs. Request outcomes survive restarts. New files never overwrite existing files. Task mode binds the canonical checkout root, Git directories, branch, HEAD, policy digest, and a single cooperative writer.

`run_tests` executes only operator-approved fixture suites in constrained snapshots. Codex or another trusted local coordinator should run real project builds and integration tests. Repo MCP does not provide arbitrary command execution.

## ChatGPT

Use a private authenticated OpenAI tunnel; never expose the loopback HTTP server directly. Add the tunnel as a developer-mode MCP app, refresh its tools after an upgrade, attach it to a new chat, and require `repo_info` before repository work. Task-mode `edit` and `create_file` must advertise a required `request_id`.

ChatGPT plan limits still apply. The server does not use an OpenAI API key for inference and does not itself incur API model charges. Tunnel credential eligibility and expiration are controlled by OpenAI.

## Claude Code reviews

Claude Code can connect directly to the local endpoint:

```sh
claude mcp add --scope user --transport http repo-mcp http://127.0.0.1:8787/mcp
```

The included `.claude/skills/repo-mcp-review/SKILL.md` performs an independent, read-only review through Repo MCP and refuses identity or phase mismatches. Copy it to `~/.claude/skills/repo-mcp-review/SKILL.md` to use it from other projects. Freeze the task in `review` before invoking `$repo-mcp-review`.

## Security boundary

Repo MCP reduces accidental scope expansion; it is not a hostile-code sandbox. Filesystem containment uses descriptor and parent checks but cannot eliminate all races on macOS. Approved tests are executable code. Treat the local user, checkout, policies, and test suites as trusted.

See [SECURITY.md](SECURITY.md) for the full model and [docs/V1-HARDENING-SPEC.md](docs/V1-HARDENING-SPEC.md) for the staged hardening contract.

## Source archive

Build a deterministic, allowlisted source archive:

```sh
npm run release:pack
```

The archive excludes `.git`, `.trial`, runtime credentials, logs, evidence, build output, and local repositories. It includes a SHA-256 manifest and an archive checksum. Nothing is published automatically.

MIT licensed.
