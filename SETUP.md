# Setup and operation

This is an unpublished MIT-licensed release candidate. Current tested support is macOS with
Node 26+, Git at /usr/bin/git, and the official OpenAI tunnel-client. The Python
runner additionally needs Python and pytest. Windows and Linux are not certified.
No API inference calls are made by this server. Access to ChatGPT custom apps and
OpenAI tunnel permissions is required; account eligibility is controlled by OpenAI.

## 1. Install and verify locally

From your copy of this project:

```sh
npm ci
npm run build
npm test
npm run prepare:fixture
REPO_ROOT="$PWD/.trial/repo" npm start
```

Keep the last command running. Preparation refuses to overwrite existing files.
This starts a disposable fixture; do not begin by exposing your main repository.
The default profile permits one source edit and protects tests. For other projects,
select an existing checkout or a linked Git worktree and write an explicit policy.
Bare repositories are rejected. See README.md for policy examples, creation
permissions, and supported runners. Do not share a writable checkout with an
editor or another agent while a task runs.

### Task mode (durable binding and locks)

Set `REPO_MCP_TASK_ID` to bind the server to a task. State lives outside served
repositories in `REPO_MCP_STATE_DIR` (default
`~/Library/Application Support/repo-mcp/state` on macOS). The binding records the
checkout, Git directories, branch, HEAD and policy digest. A cooperative lock allows
one server per checkout; it does not stop editors or shells. If the branch, HEAD or
policy changes, mutations and checks stop until the coordinator rebinds. A detached
HEAD needs `REPO_MCP_ALLOW_DETACHED=1`. A lock left by a crashed server is reported
as stale; after inspection, start once with `REPO_MCP_RECOVER_STALE_LOCK=1`.
That also clears a stale mutation gate left by a crashed server or coordinator command.
`phase` and `rebind` wait for in-flight mutations to finish, and return only after
the change is durable (up to 60 s, then they report busy). After a policy rebind, the
running server refuses all tools until it restarts with the new policy file.
`edit` and `create_file` accept a `request_id`; a retry with the same ID and
arguments returns the recorded outcome instead of applying the change twice.
`already_applied` confirms the file already has the request's resulting contents; it
is not proof that this request wrote them. Request IDs exist only in task mode;
untracked servers omit the argument and reject it if sent.

**Crash recovery of `create_file`.** A create publishes by hard-linking a complete temporary
file (`.mcp-<uuid>.tmp`, in the target's directory) to the target and then removing the
temporary. Before the link, the task state records the temporary's path and inode. If the
server dies between the link and the removal, the target has two links, which reads and
discovery refuse. On the next start of that task (before exact-mode validation), and on a
retry with the same `request_id`, the server removes only that recorded temporary, and only
if it is still the recorded inode, in the target's directory, with the recorded content hash
and exactly the expected links. Then the retry returns `already_applied`. If anything
differs (a replaced temporary, an extra hard link, a symlink, a different file at the
target, malformed evidence), nothing is removed or written and the retry reports an
uncertain outcome to inspect by hand. A target that exists but that reads refuse is never
treated as absent. Outcomes recorded by older versions have no evidence and are never
cleaned up (a hard-linked target stays and is reported as uncertain). A crash before the
evidence is recorded leaves an unexposed `.mcp-*.tmp` orphan that is not removed by name;
delete it by hand if it bothers you. The retry still creates the file once.

```sh
npm run task -- status --task TASK_ID
npm run task -- phase --task TASK_ID --phase review
npm run task -- rebind --task TASK_ID --root /path/to/checkout
```

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
   Install it on PATH, or place it at .trial/bin/tunnel-client. Do not copy someone
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
health flags say ready; upstream diagnostics stay in private .trial files.
Do not upload those files. The status summary never emits raw errors or keys.

Optional settings: MCP_STATE_DIR (private state directory), TUNNEL_CLIENT_BIN
(official executable), and MCP_SERVER_URL (defaults to localhost:8787/mcp).
The standalone installer uses .trial state in this project and macOS launchd.
It starts tunnel-client directly, reuses the credential file, and restarts after
exit. No Codex session is required. After installation, connect.sh detects
the standalone marker and restarts that service. Without the marker, it retains
the older Codex-managed path for compatibility. MCP_STATE_DIR overrides apply to
the legacy path; the standalone installer always uses the project .trial folder.

Inspect or stop the tunnel service with:

```sh
launchctl print "gui/$(id -u)/local.repo-mcp.tunnel"
launchctl bootout "gui/$(id -u)/local.repo-mcp.tunnel"
```

Move its plist out of ~/Library/LaunchAgents to disable login startup. Preserve
runtime.key for later reuse. If returning to the legacy managed path, remove the
.trial/standalone-tunnel marker only after stopping the standalone service.

## 3. Keep the MCP server running on macOS

V1 uses one repository-agnostic `local.repo-mcp.server` definition. Build first,
then preview or install that stable definition:

```sh
npm run build
python3 scripts/install-server-service.py
python3 scripts/install-server-service.py --install
```

The stable plist contains only the Node path, stable service entry point, and the
operator state-directory path. It contains no repository, policy, task, or tunnel
credential. `--install` is idempotent only for a definition whose exact bytes are
still backed by the private install record; an unexpected or modified plist is a
hard failure rather than an implicit adoption.

Bind a new task ID before loading the service, then start through the coordinator:

```sh
npm run coord -- bind --task TASK_ID --repo /absolute/path/to/checkout \
  --policy /absolute/path/to/operator-policy.json
npm run coord -- start
npm run coord -- status
```

`coord start` uses `kickstart -k` for an already-loaded expected definition and
bootstrap for an unloaded definition. A changed trusted service definition is
replaced with explicit bootout/bootstrap. Success requires loopback process
attestation to match the desired generation, task ID, canonical-root digest, and
package version; HTTP `ok=true` by itself is not readiness. Use
`coord start --recover-stale` only after inspecting a stale server lock; ordinary
start never deletes stale lock state.

Launchd inspection is fail-closed. The only `launchctl print` result treated as
positively unloaded is exit 113, empty stdout, and the C-locale two-line error
`Bad request.` followed by
`Could not find service "local.repo-mcp.server" in domain for user gui: UID`.
Timeout, truncation, invalid UTF-8, signals, and every other nonzero result are
inspection failures. The deterministic classifier is regression-tested; this
Stage 1 repair did not execute that exact classification against the real macOS
user launchd domain, because doing so through the pilot would touch live service
state.

The old repository-specific plist is migrated only by the explicit
`npm run coord -- migrate-legacy` flow. With no safely bound new task it is backed
up and replaced as `prepared_unbound`, and the stable service remains unloaded;
a later bind/start performs the first task-bound generation verification. Stage 1
does not infer ownership for pre-hardening task IDs: use a new task ID rather than
synthesizing Stage 2 claims.

Finish is terminal for that task ID and stops the service before publishing the
completion marker. Stage 1 supports abandonment only:

```sh
npm run coord -- finish --abandon
```

`finish --commit` is intentionally rejected in Stage 1. It becomes eligible only
after Stage 3 supplies the durable candidate/staging/post-commit verification
handoff required by the hardening contract.

The separate tunnel service above keeps its private connection running. Mac sleep
and loss of internet can still interrupt connections; launchd does not keep the
Mac awake and no work can be served while the machine is sleeping/offline. After
wake or network return, evaluate local process attestation and tunnel freshness
separately, then perform a fresh `repo_info` route proof before another mutation.

Operator state and server logs default under
`~/Library/Application Support/repo-mcp/`; move the launchd plist out of
`~/Library/LaunchAgents` only for manual recovery. After changing code, rebuild
and use `coord start`; a running process does not reload source.

## 4. Connect ChatGPT and verify

Create a developer-mode MCP app in ChatGPT Plugins, choose Tunnel, and select the
same tunnel. Choose no MCP-layer authentication for this loopback-only pilot; the
private tunnel supplies remote authorization. Never expose the HTTP port publicly.

After adding/changing tool schemas, refresh tools in the plugin settings and start
a new chat. Expect eight tools (`repo_info`, `list_files`, `search`, `read`, `edit`,
`create_file`, `run_tests`, `git_diff`); a server built from `dist/` before milestone 2b
shows seven, without `list_files`. Ask for repo_info first;
verify the repository, HEAD, writable files and test suites before any edits.
Then run the baseline tests. A local ready flag alone is not end-to-end proof.

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
Oracle v0.21.1 interface at `/opt/homebrew/bin/oracle`. Profile mappings are exact:

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

Install the review skill for all Claude Code projects, or keep the project copy:

```sh
mkdir -p ~/.claude/skills/repo-mcp-review
cp .claude/skills/repo-mcp-review/SKILL.md ~/.claude/skills/repo-mcp-review/SKILL.md
```

Freeze the task with `npm run task -- phase ... --phase review`, then ask Claude
to use `$repo-mcp-review`. The skill refuses repository identity mismatches and
requires repository evidence to come only through Repo MCP. Coding, task phase,
service control, commits and pushes remain separate coordinator actions.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Local server unavailable | Check the HTTP server/service, repository and policy paths. |
| 401 / credential_rejected | Replace expired/revoked key using --rotate-key. Restarting cannot renew it. |
| 403 / access_denied | Check organization membership and Tunnels Read + Use. |
| Local ready but remote_unverified | Do not assume ChatGPT works; check tunnel lookup and perform repo_info. |
| create_file missing | Refresh plugin tools and start a new chat. |
| Wrong repository | Stop before edits; select the intended server policy and restart it. |
| Unknown suite | Only operator-configured suites are supported. No arbitrary shell fallback. |

## Before an open-source release

Do not publish this entire working directory. It includes private runtime state,
local repository clones, screenshots and account-specific evidence. Share only
reviewed source, tests, dependency lockfile, generic examples and setup docs.
MIT licensing and allowlisted packaging are included. An external-machine setup test,
a private security-reporting channel and platform support verification remain release
requirements. This documentation is not a claim of production or universal support.

Official references:
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://developers.openai.com/api/docs/guides/production-best-practices

## Instruction spelling and schema refresh gate

Allow the root instruction file using its actual disk spelling, for example `agents.md` in an exact policy. `repo_info.instructions_path` names that exposed file (or is null if none is exposed). Continue its instructions using `read(path: instructions_path, cursor: instructions_next_cursor)`. Permission matching stays exact; this does not expose differently spelled aliases. Expose only one root instruction-file spelling. No glob workaround is needed.

After rebuilding/restarting or enabling task mode, open **Plugins → Repo MCP → More actions → Manage → Refresh tools** (the path verified on this account on 2026-10-02). Other clients may label the action Refresh. Keep the existing connection and tunnel credential. Then start a new chat and attach the plugin. Refresh reloads tool schemas; a server version bump alone cannot invalidate an old chat's cached descriptors. Official reference: [connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt).

Before writes, inspect the offered tool schemas: eight tools; `read`, `search`, `git_diff`, `list_files` have `cursor`; `repo_info` has `status_cursor` and `files_cursor`; task-mode `edit` and `create_file` require `request_id`, while untracked compatibility mode omits that property. If repo_info advertises request IDs but the client cannot supply them, stop coding and refresh; do not silently use a weaker retry workflow. Run the local MCP discovery tests with `npm test`; this validates the server, while a fresh ChatGPT conversation validates the client cache. Tool-list verification must not mutate the real repository.

Codex's repeatable command/evidence role and coding/review prompts are in [WORKFLOW-SPEC.md](docs/WORKFLOW-SPEC.md#current-operating-procedure-chatgpt-owns-code-and-review). Real-project tests still run locally through Codex. Commit/push remain coordinator operations, separately authorized. Milestone 3 remains deferred.
