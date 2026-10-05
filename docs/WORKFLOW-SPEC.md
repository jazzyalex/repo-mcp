# ChatGPT local coding workflow

Status: proposed implementation contract, 2026-09-30; updated 2026-10-02. These capabilities are planned unless explicitly marked current.

**Current, accepted source (2026-10-02):** milestones 1, 2a and 2b are source-accepted (216 of 216 tests and `tsc` clean independently, final Oracle review CLEAN, SHIP). The MCP server has eight tools: `repo_info`, `list_files`, `search`, `read`, `edit`, `create_file`, `run_tests` (fixture suites only, synchronous, ten-second timeout, output unpaged up to 32 KiB) and `git_diff`. It has **no asynchronous checks**, no `check_status`, `read_check_output` or `cancel_check`, and no new tool is promised. **Deferred, not accepted and not required before the first pilot:** the real-project check runner and evidence (milestone 3; a partial unfinished checkpoint is archived at [evidence/checkpoints/m3-20261002/CHECKPOINT.md](../evidence/checkpoints/m3-20261002/CHECKPOINT.md)), the automatic handoff utility (milestone 4), and macOS sandbox profiles. Sections marked "planned, deferred" below are future direction, kept as the technical design. The first pilot is described under "First acceptance pilot".

## Current operating procedure: ChatGPT owns code and review

For the next real task, Codex coordinates execution without semantic code review. The first pilot included a substantive Codex finding; it proves the tools work, not zero Codex review or measured usage savings.

1. Record canonical root, branch, HEAD, baseline status, protected-file hashes, task-owned paths, fixed check commands and coding/review chat references. Use existing checkout; branch/worktree changes require separate authorization.
2. Confirm local MCP, tunnel health and a real ChatGPT `repo_info` call. Verify eight tools, `cursor` on paged tools and, in task mode, `request_id` on mutations. Read instructions at the returned `instructions_path`. If schemas differ, refresh the existing plugin before coding.
3. Codex runs prescribed baseline checks and records command, cwd, exit code, output and collected test names/counts. ChatGPT writes regressions through MCP; Codex runs them and returns the actual RED result.
4. ChatGPT implements through MCP. Codex runs the prescribed local checks and returns results. Codex verifies allowed changed paths, protected hashes and test-name/count changes mechanically; it does not decide whether logic or assertions are sufficient. Changed/removed tests and exact diffs go to the ChatGPT reviewer. Unexpected command failures or scope drift pause the handoff and go back to ChatGPT.
5. Freeze with `npm run task -- phase --task TASK_ID --state-dir STATE_DIR --phase review`. Capture full tracked/staged diff plus approved new-file contents, path/mode/content hashes, deletions, HEAD and validation results. A diff against HEAD alone does not identify new-file contents or separate pre-existing edits.
6. A separate ChatGPT conversation attaches Repo MCP, verifies frozen identity/hashes, reads the complete paginated diff and all new files, and performs semantic review. It reports confirmed findings with lines and reproduction, validation limits, and SHIP/NO-SHIP. It must distinguish coordinator-executed tests from tests it ran itself.
7. Route confirmed findings to the coding chat, reopen `coding`, repeat prescribed checks and freeze/review. Never duplicate a submitted browser request after a timeout; recover that chat/tab.
8. After explicit commit authorization, Codex confirms the index has no unrelated staged content, verifies frozen hashes, stages only owned paths, checks the staged diff, commits, then compares committed blobs/modes and remaining protected files. HEAD changes invalidate the task binding: rebind to the new HEAD while retaining review phase before any later mutation. Push is separate authorization with an exact remote/ref; no force push.

Coding prompt template:

> Use only Repo MCP for repository reads and writes. First verify TASK_ID, ROOT, BRANCH and HEAD with repo_info, then read instructions_path through all pages. Implement TASK within OWNED_PATHS; preserve PROTECTED_PATHS. Add meaningful regressions first and pause for coordinator execution; do not invent test results. Use fresh file hashes and request IDs. No commit, push, branch change, installs or alternate repository tools. After implementation read the complete diff and pause for local checks.

Review prompt template:

> Use only Repo MCP, read-only. Verify frozen TASK_ID, ROOT, HEAD and CANDIDATE_HASHES. Read the complete paginated candidate diff and approved new files. Review correctness, edge cases and regression quality; distinguish confirmed defects from hypotheses. Supplied CHECK_RESULTS were executed by the coordinator. Report actionable file/line findings, validation limits and SHIP/NO-SHIP. Do not edit, run other tools or approve an incomplete diff.

## Outcome and decisions

ChatGPT performs implementation and semantic code review using Repo MCP and, where useful, the connected GitHub tools. Codex coordinates the task, prepares local execution, checks evidence, and performs authorized Git operations. For the first pilot this is direct local Git coordination by Codex; a tested local handoff utility is planned and deferred. “Luna Max” means selecting the Luna model with Max reasoning effort for that coordinator; it is an optional user setting, not an MCP capability. The first workflow is sequential.

Use an existing checkout or a linked Git worktree. Neither a clone nor a worktree is mandatory. Prefer an existing checkout for a small task with exclusive ownership; prefer a linked worktree when the main checkout is busy or contains unrelated changes. Worktrees isolate working files and indexes but share Git metadata and are not security sandboxes.

MCP accepts an operator-selected checkout. It does not create worktrees, switch branches, or select arbitrary filesystem roots from chat arguments. Codex owns those operations, subject to repository instructions and user authorization. Parallel orchestration is deferred.

A browser ChatGPT conversation can reach local MCP through the existing private tunnel. Desktop ChatGPT is not required for this route. This design does not promise unlimited ChatGPT usage or free tunnel transport. The server does not make model inference API calls.

## Roles and source selection

| Participant | Responsibility |
| --- | --- |
| User | Task scope, repository choice, authorization for external actions |
| Codex coordinator, optionally Luna Max | Checkout setup, policy, connection health, fixed verification commands, evidence capture, Git and handoffs |
| ChatGPT coding conversation | Inspect actual source, implement, add tests, run approved checks, explain changes |
| Separate ChatGPT review conversation | Read-only review of exact candidate contents, tests and coverage limitations |
| Local MCP | Repository discovery, bounded reads/search/diffs, scoped edits, approved local execution |
| GitHub connector | Issues, PR discussion, CI and committed source at a specified revision, according to actual available capabilities |

Both connectors may be used in one conversation. Local MCP is authoritative for uncommitted files and local test execution. GitHub is authoritative for remote issue/PR metadata and remote commits. Never treat a GitHub branch result as proof of current local contents. Record repository identity and commit SHA for remote code citations. If the connector cannot retrieve the requested revision, say so and use local MCP for that code.

Review independence is procedural: coding and review conversations share the tunnel credential, so the server does not authenticate them as distinct reviewers. The operator-controlled global review freeze denies all MCP mutations; it cannot prove which model or person authored a verdict.

Version one uses GitHub for reads. Git writes stay with Codex, even if a connector exposes write operations. A remote-writing workflow requires a separate explicit handoff and local synchronization before editing resumes. Never allow concurrent local and remote writers on the task branch.

Oracle is an existing CLI/skill for submitting prompts to a second model, including through a browser. Its browser mode is an optional future transport, not a prerequisite. Do not assume an Oracle run automatically has both connectors or the right conversation settings. Manual prompt/result handoff is the initial supported transport; later browser automation must verify the selected model, attached tools, submitted request, and recover the same conversation after interruption rather than submit duplicates.

## Task identity and ownership

The coordinator records a task manifest outside chat-editable source:

- Task ID, canonical checkout root and repository identity.
- Git directory/common directory identity, branch or detached state, starting HEAD.
- Starting index, tracked modifications and untracked-file inventory; hashes for relevant content.
- Read/write/create scopes, excluded paths, policy version, configured check IDs.
- Coding/review conversation references when available.
- Exact push destination and ref only when authorized.

One MCP writer owns the task. Read-only access can coexist, but the review phase disables coding writes. A durable lock keyed by canonical checkout identity prevents two server instances from claiming the same checkout. Linked worktrees have separate checkout locks. Git mutations performed by the coordinator additionally acquire a short-lived common-directory lock, serializing cooperating Git operations across linked worktrees. Human commits in another worktree are allowed if they do not move this task’s branch or alter shared configuration, hooks or task inputs; verify these identities again before handoff. This is not a common-directory lock for the whole coding session. This lock cannot stop an editor or arbitrary shell process; exclusive ownership is also an operating rule.

Verify root, branch and HEAD before each mutation and check. Unexpected changes invalidate the active task binding; require coordinator reconciliation. File edits additionally require the latest full-file hash. Retain atomic writes and recheck immediately before replacement; do not claim this prevents every race with an uncooperative external writer.

Pre-existing modifications are preserved. If a task needs to edit a file already modified by someone else, settle ownership before writing. Version one does not automatically split mixed-ownership hunks into a commit. Task state is stored in an operator-owned user-local directory outside served repositories, keyed by repository and task IDs. Versioned records cover policy, binding, phase, lock owner, mutation intents/outcomes, cursor inventories, job metadata and review/check evidence. Use atomic replacement and durable writes for state transitions; reject unknown versions and fail closed on corrupt records. MCP HTTP sessions may remain stateless: application task state persists independently of transport sessions. No automatic stash, reset, clean, rebase or merge.

## Sequential lifecycle

1. **Prepare:** inspect repository instructions and status; select checkout; optionally create an authorized task branch/worktree; configure scope and check commands. Record baseline and connection health.
2. **Discover:** ChatGPT calls repo_info and verifies the manifest identity. Search and read locally. Read GitHub issue/PR context when relevant, with source attribution.
3. **Baseline:** run approved checks against the real checkout and dependencies. Record command configuration, source identity, exit status and test inventory. A pre-existing failure is reported explicitly. (In the first pilot Codex runs these checks locally with the existing dependencies and records the results; the current MCP cannot run real-project checks.)
4. **Implement:** ChatGPT edits through MCP, adds meaningful regression coverage and demonstrates the failing case when practical. Dependencies are not mocked merely to fit an MCP response/file-size limit.
5. **Verify:** run relevant checks and inspect the complete paginated diff. Codex compares test names/counts and forwards changed assertions to the ChatGPT reviewer; the reviewer assesses whether coverage was removed or weakened. Capture tracked, staged and approved untracked changes.
6. **Freeze:** disable mutations, wait for jobs to finish, capture candidate contents and a digest covering changed paths, modes, deletions and new files. Bind checks to input content, configuration and relevant dependency identity.
7. **Review:** a separate ChatGPT conversation reads the candidate through MCP and may consult GitHub at pinned revisions. Report confirmed defects separately from hypotheses, exact evidence, validation limits and a scoped verdict. A truncated/incomplete diff cannot justify a complete-review claim.
8. **Repair if needed:** return findings to the coding conversation, re-enable its scope, and invalidate previous review/check evidence for affected contents. Repeat deliberately; no unbounded automatic loop.
9. **Commit:** when authorized, Codex verifies current contents equal the reviewed candidate, checks the index, stages only owned changes, inspects the staged diff, and commits. Existing unrelated staged changes block this step. Hooks may change files; verify committed tree contents afterward and invalidate evidence if they differ.
10. **Push:** when authorized, verify remote URL, exact destination ref and expected history; push without force. Confirm the destination SHA equals the local commit. Divergence returns to reconciliation rather than automatic history rewriting.
11. **Finish:** record commit/ref, tests, review evidence and remaining changes. Preserve the checkout/worktree until cleanup is requested or otherwise explicitly authorized.

GitHub review of a pushed commit is a later review phase. Its verdict applies to that commit, not subsequent local edits. If CI or a reviewer finds a defect, resume coding and generate new evidence.

## MCP interface requirements

Keep responses small independently of source-file size. Initial proposed defaults: 200 lines and 32 KiB per response page; 8 MiB text-file edit limit configurable by the operator. These are separate settings. Initial request-body limit: 256 KiB; one create/patch payload is at most 128 KiB UTF-8 plus bounded metadata. Editing an 8 MiB file does not require uploading that file. Larger new files return an explicit limit error; chunked uploads are deferred. Maintain a 15-second HTTP request-receipt timeout, separately enforce a 10-second synchronous operation budget, and turn longer discovery work into resumable jobs. The HTTP request timeout alone is not a tool-execution deadline. Never silently truncate a long line or UTF-8 sequence: return explicit continuation or an actionable limit error.

- **repo_info:** compact identity, branch/HEAD, task phase, policy version, capabilities, check IDs, and paginated status. Do not repeat the entire AGENTS file in every response.
- **list_files/search/read:** discover permitted paths, literal search, bounded line reads, full-file byte hash and explicit continuation. Read a 300 KB module in relevant portions; do not upload it wholesale.
- **edit/create_file:** full-file hash preconditions, unique replacement or structured patch, exact write scopes, mode preservation, no overwrite on create. New directories require scoped support rather than arbitrary path creation. Rename/delete can remain deferred, reported as unsupported.
- **git_diff:** separate task delta from baseline changes; paginate by file/hunk; include approved new files and deletions. Cursor must bind to a stable content identity and reject stale continuation.
- **run_tests (current):** fixture suites only, run synchronously in a snapshot under a ten-second timeout; output is up to 32 KiB and unpaged (a documented exception to bounded responses).
- **check_status/read_check_output/cancel_check (planned, deferred; not in the current server):** named operator-configured checks, asynchronous jobs, bounded output pages and complete local logs with retention limits. Output paging must not kill an otherwise healthy process.
- **structured errors:** wrong repository, stale HEAD/hash/cursor, busy, scope denied, unsupported file type, missing runtime, timeout and connection failure must remain distinguishable.

Retrying a mutation after a lost response must not apply it twice. Current stale-hash checks and no-overwrite creation already prevent ordinary duplicate application; the missing behavior is returning a recoverable outcome after a lost reply. Add request IDs and durable intent/outcome records in the first milestone, bound to task, operation and argument digest. Reuse with different arguments is rejected. If current content equals a recorded post-write hash, return already_applied; otherwise return an explicit conflict or uncertain outcome, never replay blindly. After restart, reconcile recorded intent with observed file hashes before reporting success or allowing replay.

## Real local execution (planned, deferred; future direction)

**Not implemented in the accepted server and not required before the first pilot.** The rest of this section is the technical design for a trusted-local check runner, kept as future direction; it describes no current capability. A partial, unfinished and unaccepted implementation checkpoint is archived at [evidence/checkpoints/m3-20261002/CHECKPOINT.md](../evidence/checkpoints/m3-20261002/CHECKPOINT.md). Until something like it is built and accepted, Codex runs real local checks outside MCP.

Separate three policies: content the model may read, files it may edit, and resources approved test commands may use. The current readable-file snapshot cannot be the dependency boundary for realistic tests.

Version one real-project execution uses an explicitly configured trusted-local runner in the selected checkout. Commands have fixed executable/argv/cwd, controlled environment, timeout, output storage and declared artifact/cache locations. Chat arguments select check IDs; they do not supply shell commands or arbitrary environment variables. Existing interpreter/venv/package dependencies are reused. Installs and migrations are separate operations.

Editable tests and build scripts execute code with runner permissions. An argv allowlist is NOT a hostile-code sandbox. The operator must acknowledge trusted-local execution at setup. Preserve the restricted fixture runner for untrusted demonstrations; it must be clearly distinguished in repo_info. On macOS, offer a tested restricted runner profile as defense in depth: deny network and limit writes to the checkout and declared caches, with child-process rules appropriate to the check. Preserve the current snapshot profile. sandbox-exec is a platform/deprecation risk; setup must probe availability, and unsupported checks fail clearly rather than silently falling back to unrestricted execution. Explicitly selected trusted-local mode remains available with its actual permissions disclosed. No profile is advertised as complete hostile-code isolation.

Fingerprint source/configuration before and after checks, excluding declared build outputs. Base content identity on HEAD, index entries (including modes/stages), deleted paths and hashes of modified/untracked inputs in the configured execution scope. Cache immutable Git objects; hash selected content once per capture, not once per response page. Do not rely solely on Git stat-cache “clean” results: freshly hash relevant tracked check inputs at check/review boundaries, since a file can change without trustworthy stat changes. Capture before/after inventory metadata and reject inconsistent captures. External writes during execution invalidate evidence when detected; this is drift detection, not proof of an immutable filesystem snapshot. Changes during execution invalidate the result. Never let generated source changes disappear under an overly broad artifact exclusion. Record tool versions and lockfiles; do not claim that this captures every external runtime dependency.

## Policy and capture cost

Policy v2 is operator-owned and versioned. Define canonical root/task binding; read include/exclude globs; write include/exclude globs; creation directories and extensions; explicit dotfile rules; check definitions and execution-input scopes; runner permissions; limits; and state/log retention. Deny rules win. Paths use repository-relative normalized POSIX semantics; reject traversal before matching. Secrets and .git internals are always excluded from model reads. Operators may grant broader execution access without broader read access. Migrate v1 exact lists without widening access; unknown schema versions fail.

Discovery/search/diff pagination uses a retained inventory with per-file identity, not a full tree rehash per page. Before reading a selected file, validate its captured hash; invalidate stale cursors rather than combine generations. Large captures can run asynchronously. Begin with caps of 100,000 inventoried paths, 1 GiB retained output per task, 24-hour cursor lifetime and 7-day completed-job log retention, configurable locally. Exceeding a cap is explicit and never produces a complete-review claim. Preserve compact commit/review evidence until the task is archived.

## Connection, setup and recovery

Reuse the existing tunnel and stored credential across tasks. Do not rotate keys on every run; detect expiry/revocation and provide explicit rotation instructions. Private service logs and keys stay outside exposed roots and release packages.

Health has three distinct checks: local MCP responds, tunnel has a recent successful upstream poll, and the actual ChatGPT conversation successfully calls repo_info. Only the last verifies the full route. Server restarts recover task phase and job/outcome records; unexpected termination never becomes success. Sleep/network interruptions must produce resumable state rather than duplicate coding requests.

MCP never exposes .git internals or secrets as file contents. Explicitly configured project dotfiles such as .github workflows may be readable/editable; replace the current blanket dot-path restriction with a deliberate policy. Continue containment and symlink checks. Git operations can access validated metadata internally without making it model-readable.

When tool names, arguments or contracts change, schema refresh means refreshing the connected app/plugin’s cached tool list in ChatGPT settings, then verifying discovery in a new conversation. Changing policy alone does not necessarily change tool schemas.

## First acceptance pilot

There is no milestone 3 or 4 prerequisite. The first pilot runs on the accepted source (milestones 1, 2a, 2b) and the current eight-tool MCP server:

- **ChatGPT codes** through MCP, within the operator-written scopes.
- **An independent ChatGPT conversation reviews** the exact candidate through MCP, read-only.
- **Codex runs the real local tests** with the existing dependencies (the actual agent_watch dependency and appropriate existing integration tests, not the earlier dependency-stub-only pilot), and records command, source identity, exit status and test inventory itself. The current MCP has no asynchronous check runner and cannot do this for the model.
- **Codex coordinates the authorized Git steps** by hand: no MCP Git tools, no automatic handoff utility.

This document itself authorizes no particular repository, branch, commit or push. Before a real checkout is exposed, verify the selected repository's own instructions, its ownership, and the authorization the user has already given in the current session. Obtain further authorization only for an operation outside that granted scope; do not ask again for what is already authorized. The Agent Sessions baseline-rebuild backlog item (or any other task) is checked against the selected current revision and its ownership before implementing.

Prove coding plus separate read-only review, then, only when authorized, a commit/push to a local bare destination. This validates Git mechanics only. A later explicitly targeted GitHub branch proves authentication, connector revision visibility and CI. No publication is implied by preparing this specification. Advanced runner, evidence, sandbox profiles and automatic handoff are planned, deferred work; the pilot may show whether they are needed.

## Scope excluded from version one

Parallel task scheduling, automatic worktree creation/cleanup, MCP commit/push tools, arbitrary shell, guaranteed hostile-code isolation, automatic browser orchestration, universal OS certification, and subscription-limit claims. Also not in the accepted source and deferred: asynchronous MCP check jobs, evidence manifests, shared job storage, macOS sandbox profiles and the automatic handoff utility (see the status note at the top and the checkpoint it links).

Official transport reference: [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). Connector operations remain capability-checked in the actual conversation rather than inferred from a product name.
