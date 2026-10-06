# Repo MCP

Repo MCP is a local MCP service for policy-bounded coding and review across multiple operator-approved Git checkouts. Install one permanent service, register repositories locally, and let different ChatGPT or Claude conversations use different approved repositories at the same time without retargeting or restarting the service.

The service makes no model inference API calls. Git commit/push, repository registration, policy changes, task lifecycle control, dependency installation, and unrestricted shell commands stay outside MCP.

**Status:** v0.2.0 source targets trusted, single-user macOS operation with Node 26+, Git, npm, and the official OpenAI tunnel client. Linux and Windows are not certified. Repo MCP reduces accidental scope expansion; it is not a hostile-code sandbox.

## Install

From the source checkout:

```sh
npm ci
npm run build
npm test
python3 scripts/install-server-service.py --install
```

The installed launchd definition is repository-agnostic. It contains the Repo MCP runtime and owner state directory, not a repository, task, policy, or tunnel credential.

Configure/start the permanent broker once:

```sh
npm run coord -- service configure --port 8787
npm run coord -- service start
npm run coord -- service status
```

Repository registration and selection do not restart that process. `npm start` runs the same production `service-main` broker in the foreground; installed launchd operation should still be controlled with `npm run coord -- service start`.

For a disposable single-repository fixture, the historical `startServer` adapter remains available through the development/demo path; it is not the production multi-repository authority model.

## Register repositories and tasks

Policies remain operator-owned files outside every served checkout. Registration validates the checkout and copies the normalized policy into owner-only, content-addressed Repo MCP state.

```sh
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

The archive excludes `.git`, `.trial`, runtime credentials, operator state, logs, evidence, build output, and local repositories. It includes a SHA-256 source manifest and archive checksum.

The normative multi-repository contract is [docs/MULTI-REPO-SPEC.md](docs/MULTI-REPO-SPEC.md). Older workflow/hardening documents remain useful historical and future-hardening references where they do not conflict with that v0.2 contract.

MIT licensed.
