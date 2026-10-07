# Setup and operation

Repo MCP v0.2.0 uses one permanent multi-repository broker for trusted single-user
macOS operation. Normal installation requires Python 3.9+, Node 26+, Git at /usr/bin/git,
npm, and the official OpenAI tunnel client. Install a supported Python on PATH before
onboarding; `python3 scripts/check-prerequisites.py` checks normal dependencies without
changing state. pytest is optional and needed only by the Python fixture runner. Windows and Linux are not certified.

No model inference API call is made by Repo MCP itself. Access to ChatGPT apps and
the private tunnel is controlled separately by OpenAI.

The normative authority/lifecycle contract is
[docs/MULTI-REPO-SPEC.md](docs/MULTI-REPO-SPEC.md).

## Agent-driven setup (recommended)

Open the Repo MCP checkout in Codex or Claude Code and ask:

> Use the Repo MCP skill in this repository to install Repo MCP and verify ChatGPT access.

Codex is routed by `AGENTS.md` to `.codex/skills/repo-mcp/SKILL.md`; Claude is routed by
`CLAUDE.md` to `.claude/skills/repo-mcp/SKILL.md`. The agent runs the commands in this
document, installs the bundled skills globally, inspects existing state before changing
it, and completes the end-to-end smoke test. This document remains the detailed manual
reference and recovery guide.

For a later project, open that checkout in either agent and ask it to connect the current
repository for review or prepare it for a named coding task. The installed skill tells the
agent to create a bounded external policy, register the exact checkout, bind a task, and
verify the workspace without restarting the permanent service.

The user never needs to discover or copy repository IDs, task IDs, policy paths, grants,
or workspace tokens. The agent resolves the current checkout and keeps those coordinator
details internal. Asking `Use Repo MCP to review this repository` is a complete request.

The agent may still need the user for an account-bound action: creating the private
OpenAI tunnel/runtime credential, or connecting/refreshing the developer-mode app in the
signed-in ChatGPT UI when browser control is unavailable. Runtime credentials must be
entered through the hidden local prompt, never in chat.

## 1. Install, migrate, and configure

From the source checkout, validate locally before deploying:

```sh
python3 scripts/check-prerequisites.py
npm ci
npm run build
npm test
python3 scripts/install-agent-skills.py --install
```

Global skills are hash-owned through private state at
`~/Library/Application Support/repo-mcp/agent-skills/installed.json` (or
`REPO_MCP_HOME/agent-skills`). Installation updates only recorded copies whose bytes
still match their owned hash. Foreign/modified copies are preserved; inspect them before
using `python3 scripts/install-agent-skills.py --install --replace` (alias
`--force`), which creates an owner-only backup. Legacy installations without the new
ledger require this explicit backup-and-replace adoption. Keep ownership state and
backups outside every served checkout; never copy them into a release.

Install the repository-agnostic launchd definition:

```sh
python3 scripts/install-server-service.py --install
```

For a machine upgrading from the v0.1 single-active coordinator, first import the
existing active-service/task binding into the v0.2 catalog while the old source/runtime
state is still available:

```sh
npm run coord -- migration active-service --repository LEGACY_REPOSITORY_ID
```

This migration copies the normalized policy into owner-only Repo MCP state. It does
not delete the legacy active-service record. Before any workspace/grant/new catalog
use, the catalog-only migration can be rolled back:

```sh
npm run coord -- migration rollback-active-service
```

The rollback does not change binaries, launchd, tunnel state, repository contents,
or task mutation outcomes.

Configure and start the permanent broker:

```sh
npm run coord -- service configure --port 8787
npm run coord -- service start
npm run coord -- service status
```

The broker can start with an empty catalog. Repository registration, selection,
switching, phase changes and normal task completion do not restart it.

### Register approved repositories

Keep source policy files outside every served repository, for example under
`~/Library/Application Support/repo-mcp/policies/`. Copy `docs/policy-readonly.json` for
inspection or `docs/policy-coding.json` for bounded `src`/`test` coding, set mode 0600,
and tailor scopes/exclusions to the project. Creation scope roots must already exist.
Both templates grant no MCP test execution; dotfiles are opt-in and built-in secret
and VCS denials remain in force.

```sh
npm run coord -- repository resolve --repo /absolute/path/to/checkout

npm run coord -- repository add \
  --repository PROJECT_ID \
  --repo /absolute/path/to/checkout \
  --policy "$HOME/Library/Application Support/repo-mcp/policies/PROJECT_ID.json"

npm run coord -- task bind \
  --repository PROJECT_ID \
  --task TASK_ID

npm run coord -- repository list
npm run coord -- task status --task TASK_ID
```

Registration stores canonical checkout/Git identity and copies a normalized,
content-addressed policy snapshot into private operator state. MCP never accepts a
filesystem root or policy path.

One unfinished task owns one registered checkout. To run independent coding tasks
against the same project at the same time, create and register separate Git worktrees.

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

### Workspace selection

Production repository tools have no ambient repository. A model first uses
`service_info`, `repository_list`, then `workspace_open`.

Read-only inspect/review selections need only registered repository/task IDs. Coding
requires a short-lived single-use write grant issued locally:

```sh
npm run coord -- workspace grant --task TASK_ID
```

The coding handoff uses the returned grant once with `workspace_open`; repository
calls thereafter use the returned `workspace_token`.

A workspace token is a bearer capability, not cryptographic proof of one ChatGPT
conversation. Do not put tokens into source, logs, prompts intended for another
conversation, or release artifacts.

The fixed production tool set is twelve tools:

- bootstrap: `service_info`, `repository_list`, `workspace_open`, `workspace_close`;
- repository: `repo_info`, `list_files`, `search`, `read`, `edit`,
  `create_file`, `run_tests`, `git_diff`.

Every repository tool requires `workspace_token`. Old unscoped production calls
fail closed after the v0.2 schema refresh.

### Task phases, durable epochs, and mutation outcomes

Task state remains outside served repositories under `REPO_MCP_STATE_DIR` (default
`~/Library/Application Support/repo-mcp/state`). The binding records canonical
checkout identity, branch, HEAD and policy digest plus a monotonic binding epoch.
The phase record has a monotonic phase epoch.

```sh
npm run coord -- task phase --task TASK_ID --phase review
npm run coord -- task phase --task TASK_ID --phase coding
npm run coord -- task rebind --task TASK_ID
# only after inspecting a stale task/checkout lock:
npm run coord -- task recover-stale --task TASK_ID
# only after inspecting a dead-owner global broker control lock:
npm run coord -- service recover-stale-control
# only after inspecting a dead-owner admission lock for this persisted workspace:
npm run coord -- workspace recover-stale --workspace WORKSPACE_ID
```

The two multi-repository recovery commands verify the lock is on this host, its owner PID is dead, its purpose matches a known Repo MCP operation, and its exact stale token still matches immediately before replacement. Workspace recovery additionally verifies the persisted workspace status/capability is compatible with the lock purpose. Live, different-host, unexpected-purpose, and replacement locks are never stolen. A stale `.recovery.json` recovery marker still requires manual operator-state inspection/removal; these commands do not alter repository/task/workspace authorization.

Phase and rebind changes invalidate prior workspace selections. An old coding token
therefore cannot become writable again after review/resume.

The review transition waits for admitted MCP mutations and approved fixture checks
to drain. Current v0.2 review assurance is a task-wide write freeze, not a
content-verified candidate snapshot; `repo_info` reports that distinction.

`edit` and `create_file` require public `request_id` values. The broker namespaces
them by workspace before using the durable task outcome journal. Retrying the same
workspace request with identical arguments reconciles the recorded result; changing
arguments under the same request ID is rejected.

**Crash recovery of `create_file`.** A create publishes by hard-linking a complete
temporary file (`.mcp-<uuid>.tmp`) to the target and then removing the temporary.
Before the link, task state records the temporary path/inode. After interruption,
cleanup occurs only when that exact physical identity, content hash and expected link
count still match. Replaced/malformed/extra-link evidence is uncertain and fails
closed. Existing v0.1 outcome records without publication evidence remain
non-destructive and require inspection.

The low-level `npm run task -- ...` interface remains a compatibility/recovery
surface for old task state; new production workflows use the grouped
`npm run coord -- task ...` commands above.

### Limits and paging

Limits come from the policy `limits` block (v1 policies get the defaults): 32 KiB and
200 lines per response page, 8 MiB per readable/editable file, 128 KiB per
create/edit payload (UTF-8 bytes), and a 256 KiB request body. `read`, `search`,
`git_diff`, `repo_info` status and the `repo_info` file lists return `next_cursor`
(`status_next_cursor`, `files_next_cursor`) and `complete`. Every response, metadata
included, fits `page_bytes`. `list_files` and `search` return an explicit error
(naming `page_bytes`) when the metadata plus one entry or match cannot fit, instead of
an oversized response or a cursor that does not advance. `run_tests` output keeps its
documented exception until milestone 3.

Git status and diff run once. Their output is streamed to a retained capture on disk
and later pages are read from it by byte offset; Git is not run again. A capture is
at most 64 MiB (and half of `retained_output_bytes`, default 1 GiB); beyond that the
tool reports a capture-limit error rather than a partial result. Captures expire after
`cursor_ttl_hours` (24), the oldest are evicted when `retained_output_bytes` would be
exceeded, and debris from interrupted captures is removed at the next start. With
`REPO_MCP_TASK_ID` captures live in the task state directory and survive a restart;
otherwise they live in a per-process temporary directory that is removed on exit, so
cursors do not survive a restart. A cursor is bound to its capture, the task, the
checkout identity (root, branch, HEAD) and a fingerprint of the exposed files. A
change to any of them, or an expired or evicted capture, returns an explicit error.
The fingerprint covers each file's type, mode, size, mtime, ctime and inode, so a
permission change also invalidates cursors. It is checked again after Git has run
and before the capture is published: if the files or checkout moved meanwhile, the
capture is discarded and retried, and after three attempts the tool reports that the
files changed while it was capturing. The fingerprint is change metadata, not content
identity; review and commit boundaries verify content hashes.
A capture is also bound to the Git index: a digest of each index entry's mode, object and
stage plus its intent-to-add, skip-worktree and assume-unchanged flags (never the index
file or its stat data, so a refresh or a rewrite that keeps entries and flags changes
nothing). `git_diff` uses the entries of its permitted paths; status uses all entries.
The digest is checked before and after Git runs and on every continuation, is stored
with the capture (so it survives a restart) and follows the worktree's own index.
`git add`, `git reset` or similar between pages returns a stale-cursor error.
The server reads this index listing into memory, not as a stream, with its own 128 MiB
cap (roughly 400,000 paths); beyond it the capture fails with an explicit error. Other
buffered Git calls (identity, tracking checks) stay capped at 16 MiB.
`git_diff` passes an existing working file to Git only if `read` would accept it
(no symlink in the path, one hard link, regular file, same device, within the file size
limit). A changed path that fails the check gets a `# no patch for <path> (<reason>)`
line instead of a patch; a deleted tracked file still shows as a deletion. The check is
repeated after Git runs and a changed path discards the capture, but a path swapped
at the wrong moment is detected, not prevented.
A status capture is a snapshot (`status_captured_at`): new untracked files outside the
exposed files do not invalidate it, but index changes do. Read cursors are bound to the file hash; search
checks each file's metadata before scanning it. Git output that is not valid UTF-8 is rejected.

**Exception:** `run_tests` is not paged yet. It returns up to 32 KiB of raw stdout and
stderr, which can exceed `page_bytes` once JSON-escaped. Retained, paged job logs
arrive in milestone 3.

Changing tool arguments requires refreshing the ChatGPT tool list.

Policies may use the v1 exact-list format or `"version": 2`. Design and rules:
[docs/DESIGN-2B-PATH-POLICY.md](docs/DESIGN-2B-PATH-POLICY.md).

**Patterns (v2).** `read` and `write` take `include` and `exclude` patterns. Only `*`
(within a segment), `?` (one character) and `**` (a whole segment: any number of
directories; a trailing `**` means everything below) are supported; `[ ] { } !` and
`\` are rejected. Excludes win, a path must be readable to be written, and an exclude
also covers everything beneath a directory it names. Wildcards match dot-leading names,
but a path with a dot-leading segment is exposed only if a `dotfiles` pattern matches the
whole path (for example `".github/**"`). `.git` (and other VCS metadata), secret names
(`.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `credentials.json`, ...), the
`.ssh`, `.aws`, `.gnupg`, `.kube` and `.docker` directories, the policy file and the audit
log are always denied, whatever the policy says. Conventional examples such as
`.env.example` can be exposed by listing the exact path in `secret_exceptions` (the name
must end in `.example`, `.sample`, `.template`, `.tmpl` or `.dist`); real secret names
cannot be excepted.

**Dot paths in exact policies.** A v2 policy may list an exact dot path (for example
`.github/workflows/ci.yml`) in `read.include`, `write.include`, `create.paths` or `checks`
if `dotfiles` covers it; it keeps the exact fast path. `.git`, secret names and `.trial` stay
denied, and a v1-format policy (no `dotfiles`) still rejects every dot-leading path.

**Excludes and server-owned paths in exact policies.** Policies made only of exact paths use
the same rules as pattern policies: `read.exclude` and `write.exclude` ignore case and
Unicode form and cover everything beneath an excluded directory, for reading, writing,
creating and checks. A check that an exclude denies stops startup with an error. Naming the
policy file, audit log or state directory (when they lie inside the repository) in
`read.include`, `write.include`, `create.paths` or `checks` also stops startup: remove the entry.

**Creation scopes.** `create.paths` names exact new files. `create.directories` (existing
directories) plus `create.extensions` allow new files, and new subdirectories, up to eight
path segments below the scope, never overwriting. The server never creates a scope root.
Created files must also match `read.include` and `write.include`. Names that differ from an
existing name only by case or Unicode form are refused.

**Discovery.** With patterns the server walks the repository, so use `list_files` to see
what is exposed. It never follows symlinks, skips hard-linked, special, oversize and
undecodable-name files (counted in `inventory.skipped`), and prunes directories that cannot
contain a permitted file. Discovery is capped at `inventory_paths` permitted files (100,000)
and four times that many visited entries, under the 10 second operation budget; exceeding a
cap is an explicit error, never a partial list. Every call re-checks directory and file
metadata, so changes show up immediately; list, search and file-list cursors name the
inventory they came from and go stale when it changes. They need no server memory, so they
survive a restart, but they expire after `cursor_ttl_hours`. `run_tests` copies the readable
inventory into its snapshot and refuses more than 5,000 files or 64 MiB until execution
scopes arrive in milestone 3. Adding `list_files` changes the tool list: refresh the cached
tool list in ChatGPT settings once, then verify discovery in a new conversation.

**Migrating v1 policies.** v1 exact lists behave as before, with two intentional
narrowings. A listed path that matches a built-in denial now fails at startup instead of
being served: `Policy path "credentials.json" ... is denied by built-in rule "secret file name".
Remove it from the policy.` (for a conventional example file, add it to `secret_exceptions`).
A listed path that is not valid under the new path syntax (control characters, backslashes,
undecodable bytes, segments over 255 bytes) fails at startup with the reason. Nothing is
silently filtered. Git status remains the unfiltered output of `git status`; it can list
the names, never the contents, of paths the policy does not expose.

Without `REPO_MCP_TASK_ID` the server runs untracked, but it still refuses
mutations and checks after the branch or HEAD changes; restart it to accept that.

## 2. Create the tunnel and runtime credential once

1. Open https://platform.openai.com/settings/organization/tunnels in your intended
   Platform organization. Create a private tunnel and associate your ChatGPT workspace.
2. Download the official tunnel-client from the link on that page or
   https://github.com/openai/tunnel-client/releases/latest. Verify the release checksum.
   Install it on PATH. During an explicit legacy migration, a checkout-local client is
   copied into the private Repo MCP Application Support directory. Do not copy someone
   else's tunnel configuration or credentials.
3. Open https://platform.openai.com/settings/organization/api-keys. Create a runtime
   API key whose principal has **Tunnels Read + Use**. Tunnel management requires
   Read + Manage separately; never use an admin key in the long-running client.
4. Choose a key expiration suitable for ongoing use, such as 30 or 90 days **if your
   organization allows it**. A one-day key is only suitable for a short trial.
   Organization/project maximum-lifetime settings can restrict this choice. The
   MCP cannot extend or automatically renew an expired API key. Do not change
   organization security policy merely to get around its maximum lifetime.
5. Run `bash scripts/connect.sh --save-key`. Enter your tunnel ID and key when prompted.
   Input is hidden. The key is stored owner-only and passed to the client by file
   reference. Never paste keys into ChatGPT, source files or shell arguments.

Install the standalone tunnel service (no Codex required):

```sh
python3 scripts/install-tunnel-service.py --install
npm run connection:status
```

For an existing durable service, the same `--install` command upgrades its client path
or port only when the current plist exactly matches the private `tunnel/install.json`
installed hash. Use `--client /absolute/path/to/tunnel-client` and `--port PORT` when
needed. Installation is serialized, preserves a backup, requires a successful fresh
post-restart control-plane poll, and restores the previous plist/install record on
failure. Foreign, modified, symlinked or unrecorded definitions are preserved; inspect
and reconcile them locally before retrying. A crash during deployment may require
manual comparison with the retained owner-only `.backup-*.plist`; never delete a foreign
service to bypass the guard.

To migrate the recognized pre-v0.1 tunnel service from an older checkout, name that
checkout explicitly. The installer refuses a modified or foreign service, preserves
the old credentials until a fresh post-restart control-plane poll succeeds, and rolls
the plist back if verification fails:

```sh
python3 scripts/install-tunnel-service.py --migrate --install \
  --legacy-root /absolute/path/to/old/repo-mcp-checkout
```

Do not run both the standalone service and a managed tunnel for the same profile.
If migrating from the trial's managed runtime, stop it first with
`tunnel-client runtimes stop repo-mcp`.

Ordinary restart:

```sh
bash scripts/connect.sh
```

This reuses your saved key. It does not ask you to generate another one.
Explicit rotation when the old key expires or is revoked:

```sh
bash scripts/connect.sh --rotate-key
```

Use the same tunnel ID and ChatGPT plugin after rotation. There is no need to
recreate them. The script reports authentication errors even when local process
health flags say ready; upstream diagnostics stay in private Application Support files.
Do not upload those files. The status summary never emits raw errors or keys.

Optional settings: `REPO_MCP_HOME` (defaults to
`~/Library/Application Support/repo-mcp` for the installer, connection script and
default status command), `MCP_STATE_DIR` (flat `connect.sh` test/compatibility
override), installer `--state-dir` (nested-layout test override),
`TUNNEL_CLIENT_BIN` (official executable), and
`MCP_SERVER_URL` (defaults to localhost:8787/mcp). The standalone installer and
`connect.sh` use the same durable credentials and tunnel directories. It starts
tunnel-client directly, reuses the credential file, and restarts after exit. No Codex
session or source checkout is required after installation. The durable
`tunnel/install.json` record identifies the installed standalone service.

Inspect or stop the tunnel service with:

```sh
launchctl print "gui/$(id -u)/local.repo-mcp.tunnel"
launchctl bootout "gui/$(id -u)/local.repo-mcp.tunnel"
```

Move its plist out of `~/Library/LaunchAgents` to disable login startup. Preserve
`~/Library/Application Support/repo-mcp/credentials/runtime.key` for later reuse.

## 3. Keep the permanent MCP broker running on macOS

v0.2 keeps one repository-agnostic `local.repo-mcp.server` launchd definition.
Build and install only when intentionally deploying new source:

```sh
npm run build
python3 scripts/install-server-service.py --install
npm run coord -- service start
```

The stable plist contains only the Node path, stable service entry point, and owner
state-directory path. It contains no repository, policy, task, workspace token, or
tunnel credential. An unexpected/modified plist is a hard failure rather than an
implicit adoption.

Broker readiness is service-level. It verifies the expected package version and
that the loopback listener PID matches the inspected launchd process. Repository
identity is verified later under each workspace selection; changing repository
selection never calls `kickstart` and never changes the service plist.

Launchd inspection remains fail-closed. The only `launchctl print` result treated
as positively unloaded is exit 113 with empty stdout and the exact C-locale
not-found error. Timeout, truncation, invalid UTF-8, signals, ambiguous output, and
other nonzero results are inspection failures.

If an installation still uses the exact older repository-specific plist, migrate
that plist through the explicit service migration flow before using the broker.
For ordinary v0.1 stable-service upgrades, use the catalog migration described in
section 1; the stable plist itself is already repository-agnostic.

Task completion no longer stops the service:

```sh
npm run coord -- task finish --task TASK_ID
```

v0.2 task finish supports abandonment only. Verified commit completion remains
deferred to the separate candidate/staging/post-commit gate. Git commit/push remain
outside MCP.

The separate tunnel service keeps its private connection across repository/task
changes. Sleep or network loss can still interrupt the route. After recovery,
evaluate local broker process health and tunnel freshness separately, then make a
fresh `service_info` call and re-open the intended workspace before mutation.

Operator state and server logs default under
`~/Library/Application Support/repo-mcp/`. Source edits do not hot-reload the
running service; rebuild/restart only as an explicit deployment action, never as
part of repository selection.

## 4. Connect ChatGPT and verify

Create or retain the developer-mode MCP app using the private tunnel. Never expose
the loopback HTTP port directly to a public network.

After deploying the v0.2 schema, refresh tools in the plugin settings and start a
compatible chat. Expect twelve tools: four bootstrap tools plus the eight repository
tools documented above. All eight repository tool schemas require
`workspace_token`.

End-to-end verification sequence:

1. call `service_info`;
2. call `repository_list`;
3. call `workspace_open` with the intended registered repository/task and mode;
4. call scoped `repo_info` with the returned workspace token;
5. verify repository root/branch/HEAD/task/phase and policy scope before any edit.

A local ready flag or healthy tunnel alone is not end-to-end proof. A valid
workspace token is also not proof of a unique ChatGPT conversation; it is a bearer
capability.

### ChatGPT model-profile authorization helper

`npm run model-policy` has two deliberately separate paths. `resolve` / `verify`
remain the private model-selection authorization helper for adapters that have a
real pre-submit hook: a trusted adapter must record the live browser observation
and atomically consume that authorization immediately before exactly one prompt
submission. The `run` command below is a separate Oracle browser adapter. Oracle
owns its picker/submission boundary, so `run` relies on Oracle's verified picker
gate plus strict postflight metadata; it never calls this helper after submission
and never pretends that a post-submission helper call authorized the prompt.

Supported mappings are exact and never downgrade:

- `code` -> Sol High
- `code-hard` -> Sol Extra High
- `review` -> Sol Extra High only
- `review-critical`, `brainstorm`, `plan`, `architecture` -> Sol Pro

Pro is a distinct model/target, not an Extra High alias.

Resolve the requested profile before touching the picker. At least one browser
context identity is mandatory:

```sh
npm run --silent model-policy -- resolve --profile code-hard --surface work \
  --conversation-id CONVERSATION_ID > /tmp/model-contract.json
```

`--session-id` may be supplied too. Raw conversation/session IDs are never
emitted; the helper hashes them and binds the hashes into both the public contract
and owner-controlled private state. By default, the private model-policy state is under the
normal Repo MCP state root in a `model-policy` directory (0700 directories, 0600
records). Caller-editable contract JSON is only a mirror: verification reloads the
original private request and rejects any changed profile, surface, target,
timestamp, selection ID, or browser-context binding. Malformed or internally
inconsistent mirrors fail public validation first; an internally valid mirror that
differs from private state fails the corresponding state-mismatch check.

After selecting `picker_target`, the **trusted browser adapter** must re-query the
live composer control after any React replacement, obtain the same browser-context
identity from the browser, and call the exported
`recordTrustedBrowserObservation` library function. That function is deliberately
not exposed as an untrusted CLI command. It writes one private observation and
returns a sanitized receipt for `/tmp/model-evidence.json`. Hand-written JSON is
not browser proof; `verify` rejects a receipt when the matching private trusted
observation does not exist or differs.

Current Chat observations may expose only effort labels such as `High` and
`Extra High`. In that case the helper records the model family as absent and
fails closed with `MODEL_UNPROVEN`; it does not invent `Sol`. Where the trusted
adapter actually exposes model text, the allowlist is intentionally narrow:
`Sol`, `GPT-5.6 Sol`, `GPT-6.1 Sol`, and corresponding `Sol Pro` forms.
Work combined controls may use those Sol labels with `High`, `Extra High` /
`XHigh`, or `Light`. `Light` never satisfies any required profile, and Astra
labels such as `GPT-6 Astra Extra High` are rejected. Unknown, localized, and
future labels remain fail-closed until explicitly added with tests.

Immediately before the trusted adapter submits one prompt:

```sh
npm run --silent model-policy -- verify --contract-file /tmp/model-contract.json \
  --evidence-file /tmp/model-evidence.json
```

A successful verify atomically creates a one-use consumed-selection record, then
takes a fresh clock reading and re-checks contract expiry and observation age before
returning `ok: true`. An identical second verification fails, including concurrent
races. The contract TTL is two minutes, but the live-control observation has a
separate 10-second maximum age. If time crosses either boundary during consumption,
verification fails closed and the selection remains consumed/spent. A validation
failure before consumption does not create the consumed marker, but observations are
immutable: if an observation is stale, the adapter must resolve a new selection,
select again, and record a new observation. A successful consume followed by a crash
or uncertain submission is also spent and must never be replayed.

This design assumes the trusted browser adapter and owner-controlled Repo MCP state
are in the same trusted OS-user boundary. It does not defend against arbitrary code
already running as that owner and intentionally makes no claim that the library
itself prevents adapter bypass or post-verification UI changes.

### Oracle browser model-profile runner

The installed Oracle browser controller is integrated through the same CLI with a
narrow `run` command. The supported Oracle contract is pinned to the verified local
Oracle v0.21.1 interface. Resolve the executable from absolute PATH entries by default,
or pass `--oracle-path /absolute/path/to/oracle`. The executable must be a regular,
executable file owned by the current user or root, without group/world write access;
symlink installation aliases resolve to that validated executable. Profile mappings are exact:

- `code` -> `gpt-5.6-sol` / `high`
- `code-hard`, `review` -> `gpt-5.6-sol` / `extra-high`
- `review-critical`, `brainstorm`, `plan`, `architecture` -> `gpt-5-pro` / `pro`

There is no fallback. Before any prompt-bearing invocation, the adapter runs a
non-submitting compatibility preflight against the configured executable and requires
exact Oracle CLI version v0.21.1 plus help entries for every option it will use. A
version/help mismatch fails before a run journal or prompt submission is created.

The prompt-bearing invocation is direct argv with `shell: false` and fixes all browser
controls internally: `--engine browser`, `--browser-cookie-sync`,
`--browser-model-strategy select`, `--browser-archive never`, exact `--model`,
exact `--browser-thinking-time`, explicit `--browser-tab`, one `--slug`, and
`--write-output` for the final assistant response. It never passes `--force`.
Caller flags cannot override engine/model/thinking/strategy/archive/auth/evidence.
The Oracle child receives a minimal allowlist of OS/browser basics (for example
`HOME`, `PATH`, temporary-directory, locale and graphical-session variables);
provider credentials, API endpoints, proxy routing, `NODE_OPTIONS`, Oracle config
overrides, and arbitrary caller variables are not inherited.

A run requires a real Git checkout and embeds its canonical root, branch and HEAD in
the prompt as repository context. Optional `--file` inputs are resolved to regular
non-symlink files inside that checkout. `--prompt-file` is limited to 1 MiB and is
opened nonblocking/no-follow after `lstat`; symlinks, directories, FIFOs, devices,
identity changes, growth during the bounded read, and invalid UTF-8 fail before
Oracle is launched. Supply prompt text directly or from one file:

```sh
npm run --silent model-policy -- run \
  --profile code-hard \
  --repo "$PWD" \
  --repo-mcp-preattached-tab \
  --browser-tab TAB_REFERENCE \
  --prompt-file /absolute/path/to/prompt.txt \
  --file src/example.ts
```

Both `--repo-mcp-preattached-tab` and a conservative `--browser-tab` reference are
required. The tab reference tells Oracle which existing browser tab to control; it
is **not proof** that Repo MCP is attached. Cookie sync authenticates ChatGPT but does
not attach Repo MCP. Use this command only after the operator has attached Repo MCP in
that exact tab. The submitted prompt still requires `repo_info` first and instructs
the model to stop on a root/branch/HEAD mismatch. If the attachment prerequisite or a
safe tab reference cannot be established, fail closed rather than opening a new tab
or guessing.

After compatibility preflight, the adapter atomically reserves the slug in an
owner-only durable journal under `~/.repo-mcp-oracle-runs/<slug>.json`. The record is
bound to profile, requested model/effort, canonical repository root/branch/HEAD and
start time. A concurrent claimant for the same slug is recovery-only. Generated slugs
are journaled before launch and the CLI emits a sanitized `oracle-run-reserved` event
to stderr before the prompt-bearing spawn. Journals are intentionally retained after
success, SIGINT/SIGTERM, child interruption, launch uncertainty or crashes; they are
never removed to enable automatic resubmission.

After Oracle exits, the adapter reads only that slug's owner-controlled
`~/.oracle/sessions/<slug>/meta.json` and fails closed unless postflight evidence is
fresh, owner-safe, internally consistent, and proves all of the following: session
status `completed`, `runtime.promptSubmitted=true`, browser engine, strategy
`select`, archive `never`, authenticated cookie sync, exact top-level model, exact
requested/desired/selected model with verified selection and
`fallbackUsed === false`, and exact requested/desired/selected thinking level with
verified selection and `fallbackUsed === false`. Missing, null, true or wrongly
typed fallback evidence is rejected. `gpt-5-pro` therefore succeeds only with strict
verified Pro-model **and** `pro` thinking evidence.

A false `runtime.promptSubmitted` is considered proven no-submit only when retained
metadata says the exact supported terminal `status=error` state and the Oracle child
ended normally with a nonzero exit code and no signal/post-spawn process error.
`false` combined with running, completed, unknown, or contradictory process/status
state is recovery-only with unknown submission state and the same slug.

Successful output is a sanitized receipt only: profile, requested model/effort,
slug, a SHA-256 hash of the conversation ID, prompt-submitted state, verified
selection status/labels, and completion-output byte count/hash. It never emits raw
prompts, cookies, tokens, endpoints, websocket URLs, Oracle stdout/stderr, or
unrelated metadata.

Recovery is deliberately conservative. Once a slug is journaled, missing, malformed,
stale, symlinked, unsafe or contradictory metadata, duplicate/running evidence,
launch uncertainty, signal interruption, submitted errors, or failed strict
postflight verification all preserve the same slug and never auto-resubmit. Existing
session/output/journal artifacts are recovery-only. The receipt includes an Oracle
session-recovery argv rather than automatically retrying.

The deterministic tests use a fake Oracle and temporary HOME; compatibility checks
invoke only fake `--version` / `--help` and never submit a real ChatGPT request. The
retained `resolve` / `verify` helper above remains for a different class of adapter
that can enforce a real pre-submit hook.

### Claude Code review setup

Claude Code can use the same local MCP endpoint for independent reviews. Add it
once for the current user while the stable server is running:

```sh
claude mcp add --scope user --transport http repo-mcp http://127.0.0.1:8787/mcp
claude mcp get repo-mcp
```

Install the bundled setup and review skills through the ownership-aware installer:

```sh
python3 scripts/install-agent-skills.py --install
```

If a same-name skill is foreign or modified, inspect it and use the documented
`--replace` option only when replacement is intended; the installer retains a backup.

Freeze the task with `npm run coord -- task phase --task TASK_ID --phase review`,
then ask Claude to use `$repo-mcp-review` with the registered repository/task IDs.
The skill opens a new review workspace, verifies scoped `repo_info`, and requires
repository evidence to come only through Repo MCP. Coding grants, task phase, service
control, commits and pushes remain separate operator/coordinator actions.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Local broker unavailable | Check the permanent service and configured loopback port. |
| 401 / credential_rejected | Replace an expired/revoked tunnel key using --rotate-key. Restarting cannot renew it. |
| 403 / access_denied | Check organization membership and Tunnels Read + Use. |
| Local ready but remote_unverified | Do not assume ChatGPT works; check tunnel freshness and call service_info from the actual client. |
| Old eight-tool schema / workspace_token missing | Refresh plugin tools after deploying v0.2 and start a compatible chat. |
| Wrong repository | Stop before edits, call repository_list, and open the intended registered repository/task; do not restart the service. |
| Workspace stale | Open a new workspace; phase/rebind/registration changes intentionally invalidate old tokens. |
| Unknown suite | Only operator-configured fixture suites are supported. No arbitrary shell fallback. |

## Public release boundary

Do not publish this entire working directory. It may include private runtime state,
local repository clones, screenshots and account-specific evidence. Share only
reviewed source, tests, dependency lockfile, generic examples and setup docs through
the allowlisted release packager. Source manifests are generated only inside archives;
do not commit `SOURCE-MANIFEST.json` in the control checkout. The packaging regression
validates a clean extraction using already-installed dependencies and selected tests;
it does not replace a fresh dependency installation and full supported-platform gate. A v0.2 release must be typechecked/tested from a
clean supported environment before publication; this document does not claim that a
particular working tree has already passed that release gate.

MIT licensing, allowlisted packaging and GitHub private vulnerability reporting
remain enabled. This is not a claim of hostile-code isolation, Linux/Windows support,
or universal production suitability.

Official references retained by this project:
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://developers.openai.com/api/docs/guides/production-best-practices

## Instruction spelling and schema refresh gate

Allow the root instruction file using its actual disk spelling, for example
`agents.md` in an exact policy. Scoped `repo_info.instructions_path` names that
exposed file (or is null). Continue using `read` with the same workspace token and
the returned workspace-wrapped continuation cursor. Permission matching stays exact;
expose only one root instruction-file spelling.

After deploying any tool-schema change, refresh the existing Repo MCP app/plugin
tool list, then start a compatible conversation. Refresh reloads tool schemas; a
server version bump alone cannot update a client's cached descriptors.

Before repository work, verify twelve production tools. The eight repository tools
must all require `workspace_token`; `edit` and `create_file` also require
`request_id`. Begin with `service_info`, `repository_list`, `workspace_open`,
then scoped `repo_info`. If the client exposes the old unscoped schema, stop and
refresh rather than relying on a single-repository fallback.

Run the local source test/typecheck suite before deployment. A fresh ChatGPT/Claude
route proof validates client schema/transport separately from local tests.

The older [WORKFLOW-SPEC.md](docs/WORKFLOW-SPEC.md) remains useful historical
context, while [MULTI-REPO-SPEC.md](docs/MULTI-REPO-SPEC.md) is normative for v0.2.
Real-project builds still run locally through a trusted coordinator. Commit/push
remain separately authorized operations outside MCP.
