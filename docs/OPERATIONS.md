# Repo MCP operations reference

This is the detailed operator reference that used to be the project README. Start with [README.md](../README.md) for the overview and [SETUP.md](../SETUP.md) for installation.

Repo MCP is a local MCP service for policy-bounded coding and review across multiple operator-approved Git checkouts. Install one permanent service, register repositories locally, and let different ChatGPT or Claude conversations use different approved repositories at the same time without retargeting or restarting the service.

The service makes no model inference API calls. Git commit/push, repository registration, policy changes, task lifecycle control, dependency installation, and shell commands stay outside MCP. The one exception is the `exec` shell in code workspaces whose write grant was issued with `--exec` (`docs/EXEC-TOOL.md`).

**Status:** v0.3.0 (unreleased; main after the v0.2.3 tag) targets trusted, single-user macOS operation with Python 3.9+, Node 26+, Git, npm, and the official OpenAI tunnel client. Python is required for normal installation and release validation; pytest is optional and used only by the Python fixture runner. Linux and Windows are not certified. Repo MCP reduces accidental scope expansion; it is not a hostile-code sandbox.

**Release validation (v0.2.3, history):** v0.2.3 is a prerelease. The release checkout passed dependency installation, build, typecheck and the complete 578-test suite (577 passed, one optional skip) on an existing Mac installation. First installation on a clean Mac, new tunnel credentials and first client registration remain unproven. See the GitHub release notes for the validation scope. v0.3.0 (the `go` driver, `finish`, `exec`) has no release validation yet.

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

Codex follows [AGENTS.md](../AGENTS.md) and the bundled Repo MCP skill. Claude follows
[CLAUDE.md](../CLAUDE.md) and its bundled setup, review, and architecture skills.

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

Remove only installer-owned copies with `python3 scripts/install-agent-skills.py
--uninstall`. Add `--client claude` or `--client codex` to remove one client's skills
without touching the other. Uninstall preflights every selected skill: if any selected
file is modified or foreign, it removes none of them. Otherwise it removes all selected
owned files and their matching ownership records. Newly created skill directories are
owner-only (`0700`);
existing safe directories are preserved at their current mode.

## Register repositories and tasks

Policies remain operator-owned files outside every served checkout. Registration validates the checkout and copies the normalized policy into owner-only, content-addressed Repo MCP state.

Agents resolve an existing registration for the current checkout locally with
`repository resolve`; users should not have to look through `repository list` or paste
identifiers between sessions.

Copy [the read-only v2 template](policy-readonly.json) or [the bounded coding v2 template](policy-coding.json) to an external owner-only policy file. Tailor it to the target: the coding example permits only `src`/`test` edits and creation under existing directories; it grants no dependency installation, package-file edits, or test execution. Dotfiles require explicit opt-in. Review exclusions for private project-specific data.

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

The permanent service exposes sixteen tools with fixed schemas: twelve from v0.2 and, since v0.3.0 (unreleased), `finish`, `exec`, `exec_poll` and `exec_cancel`.

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

Report and shell tools (v0.3.0):

- `finish`: ChatGPT delivers its final report once per workspace (review: `ship` or
  `no-ship`; inspect and code: `completed`; at most 192 KiB; immutable). It changes no
  file and does not finish the task.
- `exec`, `exec_poll`, `exec_cancel`: a shell in code workspaces whose write grant was
  issued with `--exec`. See [EXEC-TOOL.md](EXEC-TOOL.md).

Every repository tool requires a server-issued `workspace_token`. There is no ambient or “current” repository. Old unscoped production calls fail closed after the v0.2 schema refresh.

`workspace_open` accepts only registered `repository_id` and `task_id` values; it never accepts a filesystem root or policy path.

Modes are:

- `inspect`: read-only.
- `code`: read/write/approved fixture checks; requires a short-lived, single-use operator write grant. With a grant issued by `--exec`, it also has the `exec` shell tools.
- `review`: read-only and available only while the task is in review phase.

Issue a coding grant locally:

```sh
npm run coord -- workspace grant --task agent-sessions-20261005
```

Add `--exec` to give the workspace the `exec` shell. exec has no sandbox and runs as you
(see [SECURITY.md](../SECURITY.md)); use it only for repositories and prompts you trust.

Pass that returned grant only to the intended coding handoff. The model uses it once with `workspace_open`; subsequent repository calls use the returned workspace token.

A phase change or rebind increments durable authorization epochs, invalidating older selections. An old coding token cannot become writable again after review/resume.

## Review workflow

The accepted source implements same-target shared reviews. The running broker may still
be on an older deployed build until an authorized deployment; validate source first,
deploy intentionally, and refresh ChatGPT tools only if the deployed MCP schema changed.

The user can simply ask to review the current repository. The coordinator resolves the
Git root and internal repository/task authority; it never asks the user for IDs, policy
paths, tokens, request IDs, or browser-session IDs.

First discover the sole safe review task from owner-side repository/catalog status
before constructing the final browser prompt. Embed that exact `TASK_ID`, then call
`coord review prepare-or-join --task TASK_ID`. The optional-task API is a combined
task-selection and durable-preparation path for callers that intentionally delegate task
selection; it still requires the final prompt, session ID, and workspace request ID and
is not a discovery step. The browser handoff never uses that form.
Zero/multiple/coding/stale/conflicting task state requires explicit owner action and never
binds/freezes/rebinds over an existing coding owner.
Compatible Codex- and Claude-coordinated reviews can share one task/target generation
while keeping distinct participants, normal Chat sessions, workspace-open request IDs,
runs, workspaces, and results.

Before preparation, resolve the intended Git base to an immutable commit and preallocate
a unique `workspace_open` request ID plus a stable logical browser session ID. Construct
the **final** Chat prompt with repository/task IDs, review mode, request ID, and immutable
base already present; do not append handoff instructions after the prompt is hashed.
Persist exact `prepared.run` separately from the outer
`{generation, participant, run}` result. Before observe/reserve/send, compare
`participant.task_id` and `run.task_id` with the exact task embedded in the prompt and
compare the returned resolved base with the pre-resolved commit; stop on any mismatch and
never rewrite the hashed prompt.

The trusted browser route is: verify Chat + Repo MCP visible chip + exact required effort,
observe, reserve once, submit only when `submission_authorized: true`, record the actual
submission, reconcile the participant by task+participant from the authoritative
`workspace_open` ledger, complete from a trusted finished-response receipt, then close
only that participant with a fresh request ID. Reconciliation accepts no caller workspace
ID and must be bound before normal completion. Uncertain work recovers the same run and
normal Chat conversation; it is never silently resent.

Legacy working-target assurance remains `phase_only`. Commit-pinned review instead
binds a server-verified immutable base/head and optional scope and reports a scoped
candidate digest; that digest is not whole-repository coverage. The deferred large-diff
manifest/per-path feature is still unavailable. Bounded, denied, unsafe, binary/non-UTF-8,
over-cap, stale, or capture-limited evidence can prevent a complete review and cannot
justify SHIP.

Shared review never steals the coding owner. Before an explicit owner transition from
coding to review, close the coding workspace and durably complete/reconcile the coding
run. Normal phase/rebind/finish operations refuse protected participants, active relevant
workspaces/admitted operations, and currently authorized unresolved runs. Returning to
coding requires explicit owner action, a fresh write grant, and a new coding workspace.

See [docs/SHARED-REVIEW-WORKFLOW.md](SHARED-REVIEW-WORKFLOW.md) for the executable
Codex/Claude browser protocol.

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

## Local state garbage collection

`coord gc` cleans expired local Repo MCP state without touching ChatGPT or Claude
conversation history. It defaults to a read-only plan:

```sh
npm run --silent coord -- gc --dry-run
npm run --silent coord -- gc --apply
```

The defaults retain authorization records for 24 hours after expiry, retain captures
until their existing cursor expiry, and retain terminal mutation outcomes for 30 days
after both task completion and the outcome update. Override them with
`--auth-retention-hours`, `--capture-retention-hours`, and
`--task-retention-days`. GC removes expired workspace/grant/request records in one
authorization rewrite and removes verified expired capture pairs and old
completed/failed outcomes only for durably completed, idle tasks.

It preserves repository registrations, task binding/phase/protocol/completion records,
intent or publication-bearing outcomes, audits, policies, model-policy and Oracle
journals, token keys, locks, unknown files, and unfinished or draining tasks. Busy or
unsafe units are reported and retained. No separate durable runtime-record or retained
job-log store exists in v0.2.2, so GC does not invent those deletion targets.

## Policy and repository safety

Policies define read/write/create scopes, dotfile access, approved fixture tests, exclusions, and resource limits. Denials win. Existing protections remain in force for VCS metadata, secret names, server-owned state, traversal, symlinks, hard links, unsafe paths, stale file hashes, no-overwrite creation, bounded Git captures, and durable mutation request outcomes.

Repository policy snapshots, workspace signing keys, grants/selections, task state, captures, audit logs, and tunnel credentials live outside served repositories.

`run_tests` remains limited to operator-approved fixture suites. Real project builds/integration tests should run through a trusted local coordinator. No arbitrary command execution is exposed through MCP.

## Workspace security

Workspace and write-grant tokens are bearer capabilities. They are authenticated by an owner-only local signing key and bound to repository/task/policy/authorization epochs, but they are **not** cryptographic proof of a particular ChatGPT conversation or reviewer identity.

Repo MCP does not infer authority from MCP transport sessions, request IDs, SDK protocol-era identifiers, or optional conversation metadata. A copied valid bearer token remains a bearer token within its lifetime and permissions.

The loopback HTTP listener has no independent end-user identity boundary. Never expose it directly to a public network; use the private authenticated tunnel.

See [SECURITY.md](../SECURITY.md) and [docs/MULTI-REPO-SPEC.md](MULTI-REPO-SPEC.md).

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

### Review execution surface

Repo MCP gives ChatGPT web bounded access to a repository. Codex and Claude are local
coordinators: they prepare authority and drive their browser controls, while ChatGPT
performs review and architecture through Repo MCP. A Codex subagent or Claude process
that judges the code itself is outside this product contract and must not be labeled a
Repo MCP review.

The installed Codex operator skill gives `Use Repo MCP to review this repository` a
specific token-saving meaning: resolve the current checkout internally, use
`coord review prepare-or-join` without stealing another owner, and drive a normal
ChatGPT web Chat conversation through the trusted observe/reserve/submit/reconcile/
complete/close sequence. The `review` profile requires Extra High; `review-critical`
requires Pro only for explicitly super-complex/critical review. Work, Oracle, Codex
subagents and Claude-native review are not silent fallbacks. If Chat surface, model
evidence, the Repo MCP chip, repository identity, required bounded evidence, or completion
cannot be verified, the result is `NOT TESTABLE`.

Claude supports Repo MCP coding, review and architecture as a coordinator: it uses its
own host-native browser controls to make ChatGPT web perform the work through Repo MCP.
Claude does not perform the semantic Repo MCP work itself. Coding uses the same
single-use write grant and `code` workspace for both coordinators.

New `chatgpt-run prepare` authorizations default to Chat when `--surface` is omitted:
code -> High, code-hard/review -> Extra High, and review-critical/architecture -> Pro.
`architecture-current-pro` remains an accepted compatibility alias for `architecture`.
A repository may durably forbid Work with
`npm run --silent coord -- repository surface-policy --repository ID --mode chat-only`;
`default` restores the generic policy. A real surface-policy change increments the
repository registration epoch and invalidates older grants/workspaces/run currentness;
setting the same mode is an idempotent no-op. On a `default` repository, explicit Work
requires `--surface work --surface-override-reason REASON`; the bounded control-free
reason is retained only in owner authorization state and is not returned in run/status
output. `chat-only` rejects Work before model-selection, request-claim, or run state is
created.

Authorization depends only on the exact visible effort control: High, Extra High, or
Pro. The visible model label is optional, sanitized evidence and never authorizes or
rejects a run. Labels such as GPT-5.6, GPT-6, GPT-6.1, or a future replacement therefore
do not require a Repo MCP release. Versioned effort controls are normalized to the same
effort. Lower or different effort still fails closed. Existing durable contracts that
recorded the former Sol/Sol Pro/GPT-6 expectation remain readable. New Work runs require
a bare independently observed effort control; ambiguous combined model text such as
`Sol Pro` cannot authorize them. `npm run --silent coord -- --help` and
`npm run --silent chatgpt-run -- --help` print complete static help without initializing
operator state.

Both coordinator paths use the durable `chatgpt-run` journal. It binds the repository,
task epochs, HEAD, diff base, prompt digest, hashed browser context and verified model
selection before one submission. Only a reservation response with
`submission_authorized: true` permits that submission; replay returns recovery-only state.
Fresh browser receipts bind separate submission and completion events to the exact prompt,
immutable base, task, and hashed browser context. Completion requires an observed finished
response, the submitted event hash, and the observed output digest; the submission event
cannot double as completion evidence. Submitted or uncertain runs are recovered by the
same run identity; they are never silently resubmitted. Prompts and full responses are not
stored in the journal. Explicit `chatgpt-run recover-request --request-key REQUEST_KEY`
recovers terminal claim cleanup or an orphan claim whose same-host initializer is proven
dead. It preserves every unresolved run. `recover-lock` also accepts a dead recovery
operation's own replacement lock; live, corrupt, foreign-host, changed-token, and
unrelated-purpose locks fail closed.

## One-shot ChatGPT runs (`chatgpt-run go`)

Status: v0.3.0, unreleased. The normative driver contract is
[GO-DRIVER-SPEC.md](GO-DRIVER-SPEC.md). The agent skills start `go`. They do not drive
the browser by hand. Manual browser control, polling and clipboard capture are fallback
only (see the manual recipes in this directory).

`go` runs one ChatGPT pass (kinds `architecture`, `review` and `code`) in the owner's
main, signed-in Chrome, through the CDP relay. It opens its own tab, attaches Repo MCP,
pastes the prompt with a `Run <hash>` marker line, selects the effort, sends once,
waits, saves the answer, cleans up and archives the chat. It prints one JSON line.
Exit code 0 means cleaned. Exit code 3 means the prompt may have been sent: only resume.
Exit code 1 means failure.

Profiles: `architecture` (Pro), `architecture-xhigh` (Extra High), `review` (Extra High),
`review-critical` (Pro), `code` (High), `code-hard` (Extra High).

### Prerequisites

- macOS, with Chrome running and signed in to ChatGPT.
- Remote debugging switched on at `chrome://inspect/#remote-debugging`.
- A built tree (`npm run build`) and a running broker.

### Relay start and approval

`go` starts the relay when it needs it. You can start it yourself:

```sh
npm run --silent chatgpt-run -- relay
```

The relay connects to Chrome and waits up to 5 minutes. Chrome shows an approval prompt.
Approve it once. The relay then serves any number of `go` runs until Chrome restarts.
When Chrome restarts, the relay exits and the next `go` starts a new one, which needs
one new approval. `go` never starts Chrome and never signs in. Without approval it
fails with `BROWSER_APPROVAL_TIMEOUT`.

### Probe

```sh
npm run --silent chatgpt-run -- probe
```

`probe` checks the ChatGPT controls read-only. It never sends. Run it after a ChatGPT
UI change, and before a long run.

### Run, status, resume, release

```sh
npm run --silent chatgpt-run -- go --request-id ID --repository REPO --task TASK \
  --coordinator claude --kind architecture --prompt-file FILE
npm run --silent chatgpt-run -- go --request-id ID --status
npm run --silent chatgpt-run -- go --resume --request-id ID
npm run --silent chatgpt-run -- go --release-admission --request-id ID --reason "TEXT"
```

- The same `--request-id` with the same inputs resumes. With different inputs it fails
  with `REQUEST_CONFLICT`. A workspace request ID (`--workspace-request-id`) is single-use.
- `--status` prints the stored request state without touching the browser.
- `--resume` never sends again. If a send is unconfirmed, the run stays `uncertain`
  (exit 3) and holds the account.
- `--release-admission --reason` is the operator escape for a held account. It refuses
  while the run is `submitted`. Use it only after you have checked the chat by hand.
- Review passes use `--kind review` with `--base-ref` and `--head-ref` (full commits) and
  `--workspace-request-id`. Code passes use `--kind code`, `--check CMD` (repeatable) and
  `--exec`. `go` issues the single-use write grant itself. It seals (revokes) the
  workspace when the run ends, then runs the `--check` commands. It never commits.

### Account admission

One unresolved ChatGPT run is allowed per machine. `--max-per-hour` limits sends
(default 4). A second request gets `ACCOUNT_BUSY`. Too many sends gets `RATE_LIMITED`.
A crash or timeout does not release the account. Do not bulk-run `go`.

### After a tool change

When a change adds or alters an MCP tool:

1. `npm run build` (the broker runs `dist/`).
2. `npm run coord -- service start` (reloads the broker; it can interrupt a request).
3. In ChatGPT, open Settings, Plugins, Repo MCP, and click "Refresh tools". Without this,
   ChatGPT keeps the old tool list.

### Where state lives

All paths are under the owner state directory (`~/Library/Application Support/repo-mcp`
by default) unless noted. Everything is owner-only and outside every served checkout.

| State | Location |
|---|---|
| Driver manifests, outputs, check logs | `chatgpt-go/` (`<hash>`, `<hash>.output.md`, `<hash>.check-<n>.log`) |
| Workspace request claims | `chatgpt-go-ws/` |
| Account admission and send history | `chatgpt-account/account` |
| Relay socket, `relay.log`, failure screenshots | `relay/` (`cdp.sock`, `relay.log`, `shots/`) |
| Exec session records and logs | `exec-sessions/<task>/`, `exec-logs/<task>/` |
| `finish` reports | `mcp-reports/<workspace_id>` |
| Saved run answers | `chatgpt-run-outputs/` |

### Chat cleanup

`go` archives the ChatGPT conversation when the run is cleaned. If archiving fails, the
result shows `cleanup: warning:<code>` and the output is kept. A rerun of the same
request retries the archive. You can also archive the chat by hand in ChatGPT. Archiving
does not delete the chat.

### Troubleshooting

| Code | Meaning and action |
|---|---|
| `BROWSER_UNAVAILABLE` | Remote debugging is off or the endpoint is unreadable. Switch it on in `chrome://inspect/#remote-debugging`. |
| `BROWSER_APPROVAL_TIMEOUT` | Chrome did not get approval in 5 minutes. Run `relay` again and approve the prompt. |
| `CHATGPT_SIGNED_OUT` | The page is signed out. Sign in by hand, then run again. |
| `BROWSER_CHALLENGE` | ChatGPT shows a bot check. Solve it by hand. Do not automate it. |
| `UI_MISSING:<name>` / `UI_AMBIGUOUS:<name>` / `UI_DISABLED:<name>` | A control was not found, matched more than once, or was disabled. ChatGPT may have changed its UI. Run `probe`. The run failed before sending, so a new request can start. For the Repo MCP menu item and the Archive item, `relay/shots/` holds a failure screenshot. |
| `ACCOUNT_BUSY` / `RATE_LIMITED` | Another run is active, or the hourly limit is reached. Resume with the same command later. |
| `REQUEST_BUSY` | Another `go` process holds this request. Wait for it. |
| `REQUEST_CONFLICT` | The request ID was used with different inputs. Use a new ID. |
| `SEND_UNCONFIRMED` | The send click may have happened but the message was not seen. The run is `uncertain` (exit 3). Check the chat. Never resend. Resume. |
| `COMPLETION_UNOBSERVED` | The finished answer was not seen in time. The run is `uncertain`. Resume. |
| `WORKSPACE_NOT_OPENED` / `WORKSPACE_RECONCILIATION_REQUIRED` / `WORKSPACE_STALE` | ChatGPT did not open a workspace with the request ID, or it opened a stale one. The run is held. Resume, or check the chat. |

## Release archive

Build the deterministic allowlisted source archive with:

```sh
npm run release:pack
```

The archive excludes `.git`, `.trial`, runtime credentials, operator state, logs, evidence, build output, and local repositories. It includes a generated SHA-256 source manifest and archive checksum. `SOURCE-MANIFEST.json` belongs only inside generated archives and is not maintained as a source-tree manifest.

The bounded packaging regression extracts into a temporary directory, verifies manifest hashes, builds there using the current installation's dependencies, and runs selected onboarding/model tests without recursively invoking the release test. A release still needs a separate fresh `npm ci`, build, and full test gate on supported macOS.

The normative multi-repository contract is [docs/MULTI-REPO-SPEC.md](MULTI-REPO-SPEC.md). Older workflow/hardening documents remain useful historical and future-hardening references where they do not conflict with that v0.2 contract.

MIT licensed.
