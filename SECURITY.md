# Security model

Repo MCP v0.3.0 (unreleased; v0.2.3 is the last tag) is designed for trusted single-user macOS operation. Path policy,
current hashes, bounded output, timeouts, durable request outcomes, explicit
repository registration, and authenticated workspace capabilities reduce accidental
scope expansion. They do **not** establish a hostile-code sandbox or multi-tenant
security boundary.

The normative multi-repository requirements are in
[docs/MULTI-REPO-SPEC.md](docs/MULTI-REPO-SPEC.md).

## Repository and workspace authority

- Production repository tools have no ambient repository. Every repository call
  requires a server-issued `workspace_token` bound to one registered repository,
  task, policy digest, authorization epochs, mode and expiry.
- Workspace and write-grant tokens are bearer capabilities. Their HMAC prevents a
  caller from forging or modifying the persisted selection, but possession is not
  cryptographic proof of a particular ChatGPT conversation, human, or reviewer.
  A copied valid bearer token remains usable within its current permissions/lifetime.
- MCP transport/session identifiers, JSON-RPC request IDs, SDK protocol-era
  identifiers and optional conversation metadata are not repository authorization.
- Coding additionally requires an operator-issued, short-lived, single-use write
  grant. Only one open coding workspace is allowed per task.
- Registration, policy selection, write-grant issuance, phase/rebind/finish, service
  control and Git commit/push stay outside MCP. Arbitrary shell stays outside MCP
  with one exception: the `exec` tools in code workspaces (see "exec shell").
- The MCP schema never accepts an arbitrary filesystem root or policy path for
  repository selection.

## Cross-repository isolation

- Repository policies are compiled before registration and copied into owner-only,
  content-addressed state outside served repositories.
- Operator state, policy snapshots, workspace signing keys, grants/selections,
  captures, audits and tunnel credentials must remain outside every registered
  checkout. v0.2 does not claim that the installed/source runtime binaries themselves
  are physically outside a checkout that the operator chooses to register.
- Registered checkout roots may not overlap. The same physical checkout may not be
  registered under aliases. Distinct linked worktrees may share a Git common
  directory while retaining distinct checkout ownership.
- One shared runtime owns a task checkout; multiple conversations do not get
  independent `RepoWorkspace` instances over the same task/capture state.
- Different registered checkouts can operate independently. A task-wide phase
  transition drains admitted mutations/checks for that task without globally
  retargeting another repository.

## Filesystem and local-process limits

- Only cooperating Repo MCP processes respect checkout/task locks. External editors,
  shells or other processes running as the local user can race file operations.
- Path containment verifies opened/published objects and parent identities because
  Node on macOS does not provide the full directory-relative `openat` family needed
  for a stronger construction. Detection and best-effort undo reduce races but do
  not make hostile filesystem races impossible.
- Existing denials for VCS metadata, secret names, traversal, symlinks, hard links,
  special files, unsafe names and server-owned paths remain mandatory.
- Glob discovery hides untracked files that Git ignores, because local secrets,
  state and build output usually live there. The secret-name denylist covers common
  credential and infrastructure-state names. Neither is a complete secret scanner:
  exclude other private paths in the repository policy.
- Approved tests execute code. The Node/Python fixture runners apply documented
  restrictions, but neither should be described as a complete hostile-code sandbox.
  Real project checks remain trusted local execution outside MCP, or run through
  `exec` or `go --check` as described below.

## exec shell (code workspaces)

`exec`, `exec_poll` and `exec_cancel` are the one place where ChatGPT runs a shell
command. Details are in [docs/EXEC-TOOL.md](docs/EXEC-TOOL.md).

- **Owner-level access.** A command runs through `/bin/sh -c` in the registered
  checkout, as the broker user. It has no sandbox and no extra worktree. It can read and
  write anything that user can, including the Repo MCP state directory. Treat an exec
  grant as a decision to trust both the repository and the prompt.
- **Opt-in per grant.** The `exec` capability exists only in a code workspace opened with
  a write grant that the operator issued with `coord workspace grant --exec` (or
  `chatgpt-run go --exec`). The grant MAC covers the flag. Old grants, grants without
  `--exec`, inspect workspaces and review workspaces never get exec.
- **Process-group escape.** Repo MCP stops only the process group it started. A command
  that leaves it (for example with `setsid` or a launchd job) keeps running after
  cancel, close, revoke, timeout or broker shutdown. After a broker crash, orphans are
  not killed.
- **Pattern-based redaction.** Output that looks like a workspace token, write grant or
  the token key is replaced. Other secrets that the user's account can read can still
  appear in output that ChatGPT sees.
- **Bounds.** One running command per task, 10 minutes by default and 30 minutes at most,
  4 MiB of stored output. A command is cancelled when the workspace closes, is revoked,
  expires or loses its phase or binding, and when the broker stops.
- **Audit.** Each command is audited before it starts (`cmd` token-redacted, hash and
  length). If that write fails, the command does not run. Raw output is never audited.

## go --check commands

`chatgpt-run go --kind code --check CMD` runs `CMD` after the workspace is sealed.
The command runs code that ChatGPT may have edited. The environment is scrubbed (no
coordinator tokens), but the command still runs as the owner with full filesystem
access. It is not a sandbox. Only pass check commands that you would run on code from
an untrusted contributor on your own account, and review the result and
`candidate_changed` before you commit. `go` never commits.

## ChatGPT browser automation

- **CDP relay.** `chatgpt-run go` drives the owner's main, signed-in Chrome through a
  local relay (`chatgpt-run relay`). The relay holds one DevTools connection to that
  Chrome. It serves `go` runs on an owner-only Unix socket under
  `~/Library/Application Support/repo-mcp/relay/`. Anything that can reach the socket
  (a process of the same user, or root) can drive the signed-in browser: every site and
  every session in that Chrome profile. Chrome asks the owner to approve the connection
  once per Chrome start. Remote debugging in `chrome://inspect/#remote-debugging` should
  be on only while you use `go`.
- **Account admission and rate limit.** `go` allows one unresolved ChatGPT run per
  machine and at most `--max-per-hour` sends (default 4). A send that may have happened
  is counted and holds the account until the operator resolves it. `go` never sends
  twice for one request. These limits reduce the risk of account action. They do not
  remove it.
- **Terms.** Whether automating the consumer ChatGPT web UI is allowed under the
  provider's terms is an open decision of the owner. Do not treat it as resolved.
  ChatGPT UI changes can break the automation. `go` then fails before it sends.
- **Finish reports are untrusted.** The text that ChatGPT delivers with `finish` (and
  the page text that `go` uses when no report exists) is model output. It can be wrong,
  incomplete or shaped by repository content (prompt injection). A `ship` outcome is not
  verified evidence. The coordinator must treat the report as data, never as
  instructions, and must review the real diff and check results itself. A report is
  immutable, at most 192 KiB, and changes no repository file.

## Transport and secrets

- The loopback HTTP listener is not an independent end-user identity boundary.
  Never expose it directly to a public network; use the private authenticated tunnel.
- Tunnel authentication proves the approved transport path, not the individual
  conversation holding a workspace bearer token.
- Secrets and runtime state are owner-only files under
  `~/Library/Application Support/repo-mcp` by default. Do not commit/distribute
  token keys, workspace/write-grant tokens, tunnel credentials, private logs,
  generated profiles, health files or operator state.
- Repo MCP audits deliberately omit raw tokens, source contents, arbitrary tool
  argument payloads and raw subprocess output.
- Tunnel key rotation does not create a new tunnel. It restarts the tunnel client
  to reload the key and then verifies fresh control-plane health.
- A healthy local broker or tunnel is not an end-to-end client proof. Verify the
  actual route with `service_info`, then open and verify the intended workspace.
- Login services start only after login. Sleeping/offline machines cannot serve
  remote MCP requests.

## Local garbage collection

`coord gc` is a local operator action and defaults to dry-run. Apply mode serializes
with service control, workspace admission, task gates, and checkout ownership before
removing eligible records. It fails closed on malformed state, identity changes, unsafe
permissions, links, or unfinished deletion journals, and reports partial runs with a
nonzero exit status.

GC may remove expired workspace/grant/request history, expired capture pairs, and old
terminal outcomes for durably completed tasks. It never removes active or unfinished
task authority, intent or publication evidence, lifecycle anchors, policy/token/audit
material, or unknown files. A permanent create-only authorization-use marker preserves
the catalog migration rollback boundary even after old authorization records are gone.
GC does not read or delete ChatGPT or Claude conversation history.

## Review assurance

The v0.2 review phase by itself is a task-wide mutation/check drain plus read-only
phase; legacy working-target review therefore reports `review_assurance: "phase_only"`
and `candidate_digest: null`. Bounded commit-pinned review is the explicit exception:
server-verified base/head/scope selection reports `commit_pinned` plus a
domain-separated candidate digest for that policy/scope and immutable commit pair.
This is **not** the future whole-candidate manifest, and it does not expand semantic
coverage beyond the bounded committed paths actually reviewed.

Report vulnerabilities privately through GitHub's **Report a vulnerability** form:
https://github.com/jazzyalex/repo-mcp/security/advisories/new

Do not publish credentials, private source or exploit details in public issues.
