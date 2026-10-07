# Security model

Repo MCP v0.2.1 is designed for trusted single-user macOS operation. Path policy,
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
  control, Git commit/push and arbitrary shell stay outside MCP.
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
- Approved tests execute code. The Node/Python fixture runners apply documented
  restrictions, but neither should be described as a complete hostile-code sandbox.
  Real project checks remain trusted local execution outside MCP.

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

The v0.2 review phase is a task-wide mutation/check drain plus read-only phase.
It is **not** yet the content-verified candidate manifest specified in the future
hardening roadmap. Production `repo_info` reports
`review_assurance: "phase_only"` and `candidate_digest: null` until that separate
feature is implemented.

Report vulnerabilities privately through GitHub's **Report a vulnerability** form:
https://github.com/jazzyalex/repo-mcp/security/advisories/new

Do not publish credentials, private source or exploit details in public issues.
