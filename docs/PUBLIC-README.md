# Repo MCP

Repo MCP is a local MCP service for policy-bounded coding and review across multiple operator-approved Git checkouts. Install one permanent service, register repositories locally, and let different ChatGPT or Claude conversations use different approved repositories at the same time without retargeting or restarting the service.

The service makes no model inference API calls. Git commit/push, repository registration, policy changes, task lifecycle control, dependency installation, and unrestricted shell commands stay outside MCP.

**Status:** v0.2.1 source targets trusted, single-user macOS operation with Python 3.9+, Node 26+, Git, npm, and the official OpenAI tunnel client. Python is required for normal installation and release validation; pytest is optional and used only by the Python fixture runner. Linux and Windows are not certified. Repo MCP reduces accidental scope expansion; it is not a hostile-code sandbox.

## Set up with Codex or Claude

You do not need to copy setup commands. Clone or open this repository in Codex or
Claude Code and say:

> Use the Repo MCP skill in this repository to install Repo MCP and verify Claude Code and ChatGPT access.

The bundled agent instructions lead the agent through dependency checks, tests, broker
and tunnel installation, durable service startup, Claude MCP registration, ChatGPT tool
refresh, and an end-to-end smoke test in every configured client. They also install the
Repo MCP skills into the user's Codex and Claude skill directories so future sessions in
other projects can find them.
The installed skill locates the permanent broker's control checkout automatically; the
user does not need to remember its path or manage repository IDs, task IDs, policies,
grants, or workspace tokens. The agent resolves the current Git checkout, reuses or
creates its registration and task, and keeps the coordinator details internal.

To connect a project later, open that project in Codex or Claude and say one of:

> Use the Repo MCP skill to connect this repository for read-only review.

> Use Repo MCP to review my latest committed change.

> Use the Repo MCP skill to prepare this repository for coding task NAME.

The reviewer uses the working-tree diff when changes are uncommitted and automatically
compares `HEAD^` to the current checkout when the requested changes are already committed.
The response identifies the resolved base commit, so a clean checkout is never mistaken
for an empty review.

The agent creates a policy for the requested scope, registers the checkout, binds a task,
and verifies the workspace. It should ask the user only for account-bound steps it cannot
perform. On a new installation, that can include creating the private OpenAI tunnel and
its **Tunnels Read + Use** runtime credential, and connecting or refreshing the Repo MCP
app in ChatGPT. The credential is entered through a hidden local prompt and is never
pasted into chat.

Codex follows [AGENTS.md](AGENTS.md) and the bundled Repo MCP skill. Claude follows
[CLAUDE.md](CLAUDE.md) and its bundled setup/review skills.

## Manual setup and troubleshooting

If Repo MCP is already installed, inspect
`~/Library/LaunchAgents/local.repo-mcp.server.plist` first and run the upgrade from its
`WorkingDirectory`. The installer refuses to relocate a permanent service from a second
clone.

From the selected control checkout:

```sh
python3 scripts/check-prerequisites.py
npm ci
npm run build
npm test
python3 scripts/install-agent-skills.py --install
python3 scripts/install-server-service.py --install
```

The installed launchd definition is repository-agnostic. It contains the Repo MCP runtime and owner state directory, not a repository, task, policy, or tunnel credential.

Configure/start the permanent broker once:

```sh
npm run coord -- service configure --port 8787
npm run coord -- service start
npm run coord -- service status
```

`service start` intentionally reloads launchd so new code takes effect. It can interrupt an
in-flight request; persisted task and workspace records survive and clients can open a
fresh workspace. Do not run it merely to switch repositories.

Connect Claude Code once at user scope:

```sh
claude mcp add --scope user --transport http repo-mcp http://127.0.0.1:8787/mcp
claude mcp get repo-mcp
```

Repository registration and selection do not restart that process. `npm start` runs the same production `service-main` broker in the foreground; installed launchd operation should still be controlled with `npm run coord -- service start`.

For a disposable single-repository fixture, the historical `startServer` adapter remains available through the development/demo path; it is not the production multi-repository authority model.

Global skills are hash-owned through private state at
`~/Library/Application Support/repo-mcp/agent-skills/installed.json` (or
`REPO_MCP_HOME/agent-skills`). Installation updates only recorded copies whose bytes
still match their owned hash. Foreign/modified copies are preserved; inspect them before
using `python3 scripts/install-agent-skills.py --install --replace` (alias
`--force`), which creates an owner-only backup. Legacy installations without the new
ledger require this explicit backup-and-replace adoption. Keep ownership state and
backups outside every served checkout; never copy them into a release.

## Register repositories and tasks

Policies remain operator-owned files outside every served checkout. Registration validates the checkout and copies the normalized policy into owner-only, content-addressed Repo MCP state.

Agents resolve an existing registration for the current checkout locally with
`repository resolve`; users should not have to look through `repository list` or paste
identifiers between sessions.

Copy [the read-only v2 template](docs/policy-readonly.json) or [the bounded coding v2 template](docs/policy-coding.json) to an external owner-only policy file. Tailor it to the target: the coding example permits only `src`/`test` edits and creation under existing directories; it grants no dependency installation, package-file edits, or test execution. Dotfiles require explicit opt-in. Review exclusions for private project-specific data.

```sh
npm run coord -- repository resolve --repo /absolute/path/to/checkout

npm run coord -- repository add \
  --repository agent-sessions \
  --repo /absolute/path/to/checkout \
  --policy "$HOME/Library/Application Support/repo-mcp/policies/agent-sessions.json"

npm run coord -- task bind \
  --repository agent-sessions \
  --task agent-sessions-20261005
```

List approved repository/task IDs without exposing arbitrary filesystem roots:

```sh
npm run coord -- repository list
```

One unfinished task owns one registered checkout. For independent concurrent coding against the same project, use separately registered Git worktrees.

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

In the actual ChatGPT client, call `service_info`, `repository_list`,
open an `inspect` workspace for repository `repo-mcp-onboarding` and task
`repo-mcp-onboarding-smoke` with a fresh request ID, then call scoped `repo_info`.
Verify the fixture root/branch/HEAD and read its complete `AGENTS.md` and `README.md`;
inspect the complete diff and close the workspace. No write grant is needed.
The fixture contains an intentionally failing clamp test; that is unrelated to this
read-only transport/schema smoke. Local health alone does not pass this gate.

The preparation command refuses overwrite. Never remove or reset a user's checkout.
Reuse an unfinished smoke task; if it was already finished, bind a fresh task ID
such as `repo-mcp-onboarding-smoke-YYYYMMDD` and use that ID in the client calls.
After successful smoke, the operator may finish this disposable task with
`npm run coord -- task finish --task repo-mcp-onboarding-smoke`.

## Production MCP tools

The permanent service exposes twelve tools with fixed schemas.

Bootstrap tools:

- `service_info`
- `repository_list`
- `workspace_open`
- `workspace_close`

Repository tools:

- `repo_info`
- `list_files`
- `search`
- `read`
- `edit`
- `create_file`
- `run_tests`
- `git_diff`

Every repository tool requires a server-issued `workspace_token`. There is no ambient or “current” repository. Old unscoped production calls fail closed after the v0.2 schema refresh.

`workspace_open` accepts only registered `repository_id` and `task_id` values; it never accepts a filesystem root or policy path.

Modes are:

- `inspect`: read-only.
- `code`: read/write/approved fixture checks; requires a short-lived, single-use operator write grant.
- `review`: read-only and available only while the task is in review phase.

Issue a coding grant locally:

```sh
npm run coord -- workspace grant --task agent-sessions-20261005
```

Pass that returned grant only to the intended coding handoff. The model uses it once with `workspace_open`; subsequent repository calls use the returned workspace token.

A phase change or rebind increments durable authorization epochs, invalidating older selections. An old coding token cannot become writable again after review/resume.

## Review workflow

Freeze the whole task:

```sh
npm run coord -- task phase --task agent-sessions-20261005 --phase review
```

The transition waits for admitted MCP mutations and approved checks to drain. A reviewer opens a new `review` workspace and verifies `repo_info` before reading the full paginated diff.

Current v0.2 review assurance is deliberately limited: review phase is a **write freeze**, not a content-verified frozen candidate. `repo_info` reports `review_assurance: "phase_only"` and no candidate digest until the separate candidate-manifest work is implemented.

Return to coding with:

```sh
npm run coord -- task phase --task agent-sessions-20261005 --phase coding
```

Open a new coding workspace with a new write grant. The pre-review coding token stays stale.

## Crash-stale coordinator locks

Normal coordinator operations never steal locks from a live process. After inspecting operator state and confirming the recorded owner process is gone on this same host, recover the global broker control lock with:

```sh
npm run coord -- service recover-stale-control
```

Recover one persisted workspace admission lock with its server-issued workspace ID:

```sh
npm run coord -- workspace recover-stale --workspace WORKSPACE_ID
```

Recovery is deliberately narrow: the lock must have a recognized Repo MCP purpose, the workspace command requires a matching persisted workspace/status/capability, and the exact stale lock token is checked again immediately before recovery. A live lock, a different-host lock, an unexpected purpose, or a replacement lock fails closed. These commands recover only cooperative lock records; they do not change repository/task/workspace authorization. If the separate `.recovery.json` marker itself was left by a crashed recovery process, automatic recovery refuses it; inspect that marker and operator state before manual removal.

## Policy and repository safety

Policies define read/write/create scopes, dotfile access, approved fixture tests, exclusions, and resource limits. Denials win. Existing protections remain in force for VCS metadata, secret names, server-owned state, traversal, symlinks, hard links, unsafe paths, stale file hashes, no-overwrite creation, bounded Git captures, and durable mutation request outcomes.

Repository policy snapshots, workspace signing keys, grants/selections, task state, captures, audit logs, and tunnel credentials live outside served repositories.

`run_tests` remains limited to operator-approved fixture suites. Real project builds/integration tests should run through a trusted local coordinator. No arbitrary command execution is exposed through MCP.

## Workspace security

Workspace and write-grant tokens are bearer capabilities. They are authenticated by an owner-only local signing key and bound to repository/task/policy/authorization epochs, but they are **not** cryptographic proof of a particular ChatGPT conversation or reviewer identity.

Repo MCP does not infer authority from MCP transport sessions, request IDs, SDK protocol-era identifiers, or optional conversation metadata. A copied valid bearer token remains a bearer token within its lifetime and permissions.

The loopback HTTP listener has no independent end-user identity boundary. Never expose it directly to a public network; use the private authenticated tunnel.

See [SECURITY.md](SECURITY.md) and [docs/MULTI-REPO-SPEC.md](docs/MULTI-REPO-SPEC.md).

## Migration from v0.1 single-active service

Before deploying the new broker, import the current active-service binding explicitly:

```sh
npm run coord -- migration active-service --repository legacy-repo
```

This copies the normalized policy into operator state and publishes one repository/task catalog entry. It does not delete the legacy active-service record.

Before any workspace/grant/new catalog use, state-only rollback is available:

```sh
npm run coord -- migration rollback-active-service
```

That rollback removes only the new multi-repository catalog/initialization state; it does not roll back binaries, launchd, tunnel state, repository contents, or task mutation outcomes.

After installing/upgrading the broker and refreshing the ChatGPT tool schema, production repository calls require `workspace_token`; there is no automatic single-repository fallback.

## Tunnel and ChatGPT

Use a private authenticated OpenAI tunnel and keep runtime credentials in owner-only Application Support state. After a tool-schema change, refresh the existing Repo MCP app/plugin tool list and start a compatible conversation.

A local ready process or healthy tunnel is not by itself an end-to-end ChatGPT route proof. Verify the actual route with `service_info`, then select a repository using `repository_list` and `workspace_open`.

ChatGPT plan limits still apply. Repo MCP itself does not make model inference API calls.

## Release archive

Build the deterministic allowlisted source archive with:

```sh
npm run release:pack
```

The archive excludes `.git`, `.trial`, runtime credentials, operator state, logs, evidence, build output, and local repositories. It includes a generated SHA-256 source manifest and archive checksum. `SOURCE-MANIFEST.json` belongs only inside generated archives and is not maintained as a source-tree manifest.

The bounded packaging regression extracts into a temporary directory, verifies manifest hashes, builds there using the current installation's dependencies, and runs selected onboarding/model tests without recursively invoking the release test. A release still needs a separate fresh `npm ci`, build, and full test gate on supported macOS.

The normative multi-repository contract is [docs/MULTI-REPO-SPEC.md](docs/MULTI-REPO-SPEC.md). Older workflow/hardening documents remain useful historical and future-hardening references where they do not conflict with that v0.2 contract.

MIT licensed.
