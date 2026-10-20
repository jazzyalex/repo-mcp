# ChatGPT local coding workflow

Status: current operational overlay plus historical workflow/design context; updated 2026-10-14.

**Current contract:** [MULTI-REPO-SPEC.md](MULTI-REPO-SPEC.md) is normative for the permanent broker and [SHARED-REVIEW-WORKFLOW.md](SHARED-REVIEW-WORKFLOW.md) is the executable Codex/Claude browser handoff. The accepted source includes explicit workspace authority, durable ChatGPT run/model evidence, target-only review fingerprinting, shared review generations/participants, authoritative workspace reconciliation, lifecycle protection, and recovery/GC evidence preservation. The running broker/dist may still be pre-deployment until an authorized deployment/live smoke.

The single-active/sequential workflow later in this file records the v0.1 pilot and older future-design context; follow it only where it does not conflict with the current contracts above. Large-diff manifest/per-path review coverage, asynchronous real-project check jobs/evidence, and sandbox hardening remain deferred.

**Historical accepted baseline (2026-10-02):** milestones 1, 2a and 2b were source-accepted (216 of 216 tests and `tsc` clean independently, final Oracle review CLEAN, SHIP). That v0.1 MCP server had eight repository tools. The current permanent broker retains those repository operations behind explicit workspaces and adds four bootstrap tools.

## Current operating procedure: ChatGPT owns code and review

Codex coordinates coding execution, local checks, Git, and browser control without replacing the requested ChatGPT semantic review. Claude may coordinate Chat review/architecture only; coding/write coordination remains Codex-only.

“ChatGPT review through Repo MCP” names two independent facts: ChatGPT web Chat is the
execution surface, and Repo MCP is the repository evidence source. A Codex subagent,
Claude-native review, Work, Oracle, or another backend is not an equivalent fallback.

1. Resolve the user's exact Git root and root instructions, then discover the installed Repo MCP control checkout from launchd `WorkingDirectory`. Resolve/register only that authorized checkout. Do not ask the user for repository/task/policy/token/request/session IDs.
2. For coding, preserve one unfinished task and one coding owner/workspace. ChatGPT performs semantic edits through Repo MCP; Codex runs the prescribed local checks and records actual command/status/test inventory. Close the coding workspace and durably complete/reconcile its run before any explicit owner transition to review.
3. For review, discover and record the exact sole safe existing review `TASK_ID` from owner-side repository/catalog status before final prompt construction. Zero/multiple/coding/stale/conflicting task state requires owner action; never auto-bind a second unfinished task or freeze/rebind another coding owner. Omitting `--task` is a different combined selection+durable-preparation API for callers intentionally delegating task selection; it is not the browser handoff discovery step.
4. Before final prompt construction, choose the target. Legacy working review resolves the requested Git base to an immutable commit. Commit-pinned review chooses explicit `base_ref` + `head_ref` and optional scope; `head_ref` is invalid without `base_ref`. Generate a unique `workspace_open` request ID and one stable logical normal-Chat session ID. Preserve its private conversation URL/tab mapping. No Temporary Chat and no late conversation-ID addition after a session-only binding.
5. Construct the **final** review prompt with exact repository/task IDs, preallocated request ID, `review` workspace mode, and selected target already present. Run `coord review prepare-or-join --task TASK_ID` with Chat surface and profile `review` (Extra High) or explicit super-complex `review-critical` (Pro), adding `--base-ref ... --head-ref ... [--scope-prefix ...]` for commit-pinned review. Before observe/reserve/send, compare `participant.task_id` and `run.task_id` to the exact embedded task; compare the resolved base; and for commit-pinned review require matching participant/run commit bindings, including head, scope and candidate digest. Stop on any mismatch and never rewrite the hashed prompt.
6. Persist exact nested `prepared.run` separately. In the normal Chat conversation verify Repo MCP attachment/visible chip and the exact required live effort evidence, then observe and reserve that run. Record the optional visible model label as informational evidence. Submit the final prompt exactly once only when `submission_authorized: true`; record the actual submission event.
7. ChatGPT calls `service_info`, `repository_list`, opens the preallocated `review` workspace, verifies `repo_info` and instructions, and reads the complete bounded evidence required for the selected target. Commit-pinned workspace open uses the same requested base/head/scope; `repo_info` must report `commit_pinned`, committed context/read defaults to the bound head, and diff defaults to the bound base/head/scope while inconsistent overrides fail closed. Read-only review does not request `run_tests`; local checks remain coordinator evidence. Reconcile by task+participant only from the authoritative `workspace_open` ledger; no caller workspace ID. A participant must be bound before normal completion.
8. Record completion only from a trusted finished-response receipt matching the submission hash and observed output digest, then close only that participant with a fresh request ID. Compatible reviewers may share one target generation while retaining distinct participants/sessions/workspace requests/runs/workspaces/results.
9. If submission or completion becomes uncertain, recover the **same** run and normal Chat conversation. Do not resend or fabricate completion. Pending submitted/uncertain work remains protected; pre-submit absence recovery applies only to actual failed-pre-submit state.
10. Route confirmed findings to the coding owner. Normal resume/rebind/finish remains blocked by current protected participants, active relevant workspaces/admitted operations, and current unresolved runs. Security disable/revoke may retire current authority while preserving evidence.
11. After explicit commit/push authorization, Codex performs the existing Git verification and publication steps. Git operations remain outside MCP.

Legacy working-target review reports `phase_only`. Commit-pinned review reports `commit_pinned` only for its exact policy, scope, immutable base, and immutable head. Its candidate digest is bounded coverage identity rather than whole-repository coverage. Large-diff manifest/per-path support remains deferred, and incomplete bounded evidence cannot justify a complete SHIP verdict.

Coding prompt template:

> Use only Repo MCP for repository reads and writes. First verify TASK_ID, ROOT, BRANCH and HEAD with repo_info, then read instructions_path through all pages. Implement TASK within OWNED_PATHS; preserve PROTECTED_PATHS. Add meaningful regressions first and pause for coordinator execution; do not invent test results. Use fresh file hashes and request IDs. No commit, push, branch change, installs or alternate repository tools. After implementation read the complete diff and pause for local checks.

Review prompt template (construct fully before shared preparation/hashing):

> Use only Repo MCP, read-only. First call service_info and repository_list, then open REPOSITORY_ID / TASK_ID in review mode using the exact preallocated WORKSPACE_REQUEST_ID and keep the returned token private. Verify repo_info, ROOT, BRANCH, HEAD, task/policy identity, and the exact immutable BASE_COMMIT. Read the complete root instructions and every required bounded git_diff page using BASE_COMMIT plus needed surrounding files. Supplied CHECK_RESULTS were executed by the coordinator. Review correctness, edge cases and regression quality; distinguish confirmed defects from hypotheses. Report actionable file/line findings, exact validation limits and SHIP/NO-SHIP/NOT TESTABLE. Do not edit or approve incomplete evidence.

## Outcome and decisions

ChatGPT performs implementation and semantic code review using Repo MCP and, where useful, connected remote read context. Codex coordinates coding/write authority, local checks, browser handoff, and authorized Git operations; Claude may coordinate Chat review/architecture. The durable shared-review handoff is implemented in accepted source through the review coordinator plus the existing `chatgpt-run` journal. Compatible parallel reviews are supported on one target generation with distinct participants/runs/workspaces/results; parallel coding still requires separate registered worktrees and coding owners. Large-diff manifest/per-path review coverage remains deferred.

Use an existing checkout or a linked Git worktree. Neither a clone nor a worktree is mandatory. Prefer an existing checkout for a small task with exclusive ownership; prefer a linked worktree when the main checkout is busy or contains unrelated changes. Worktrees isolate working files and indexes but share Git metadata and are not security sandboxes.

MCP accepts an operator-selected checkout. It does not create worktrees, switch branches, or select arbitrary filesystem roots from chat arguments. Codex owns those operations, subject to repository instructions and user authorization. Compatible parallel review participants are implemented; parallel coding against the same project still uses separately registered worktrees and independent coding owners.

A browser ChatGPT conversation can reach local MCP through the existing private tunnel. Desktop ChatGPT is not required for this route. This design does not promise unlimited ChatGPT usage or free tunnel transport. The server does not make model inference API calls.

## Roles and source selection

| Participant | Responsibility |
| --- | --- |
| User | Task scope, repository choice, authorization for external actions |
| Codex coordinator | Checkout/task/policy ownership, coding grants, local checks, browser handoffs, evidence capture, Git and deployment actions |
| Claude coordinator | Read-only Chat review/architecture preparation and browser handoff; no coding/write grants |
| ChatGPT coding conversation | Inspect actual source, implement and add tests through Repo MCP; do not invent local check results |
| ChatGPT review/architecture conversation | Read-only semantic review/architecture through Repo MCP with exact bounded evidence and verified model/profile |
| Local MCP | Repository discovery, bounded reads/search/diffs, scoped edits, approved fixture checks, durable workspace/review/run authority |
| Remote read connector, when explicitly useful | Issues, PR discussion, CI and committed source at a specified revision, according to actual available capabilities |

Local Repo MCP is authoritative for the current checkout and uncommitted source. Codex is authoritative for the real local build/integration checks it executes outside MCP. A remote read connector, when explicitly used, is authoritative only for the remote issue/PR/CI/commit data it actually returns. Never treat a remote branch result as proof of current local contents.

Review independence is procedural rather than cryptographic. Coding and review conversations share the tunnel credential, and workspace tokens remain bearer capabilities. Shared review records distinct participants, browser-context hashes, runs, workspace requests and results, while the target fingerprint prevents incompatible live targets from sharing a generation; none of this proves a human/model identity cryptographically.

Git writes remain with Codex. A remote-writing workflow requires separate explicit authorization and local synchronization before editing resumes. Never allow concurrent local and remote writers on the task branch.

The Codex and Claude coordinator skills use host-native browser control plus Repo MCP's
provider-neutral `chatgpt-run` journal. ChatGPT web performs every Repo MCP review and
architecture pass using the Chat surface; only Codex coordinates coding/write access. A run uses a stable
normal-Chat session from the start, an operator-selected conversation with Repo MCP
attached and visible, exact live model/profile evidence, durable reservation immediately
before one submission, and recovery of the same run/conversation after interruption.
Temporary Chat is not a recovery surface. Shared review/architecture never silently
falls back to Work, Oracle, or a host-model semantic review. Oracle remains a separate
explicit legacy compatibility command only when the user specifically requests Oracle;
it is not part of this workflow.

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

## Historical sequential lifecycle (non-normative)

The following v0.1/future-design sequence is retained for context only. The current shared-review handoff above and the normative multi-repository contract override any freeze/candidate/job language that is not implemented today.

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

Refresh the connected ChatGPT tool list only after a **deployed MCP schema change**, then verify discovery in a compatible new conversation. Source edits, repository/task selection, and policy changes that do not alter the deployed tool schema do not require Refresh tools.

## Historical first acceptance pilot

The first pilot predates the accepted shared-review coordinator and is retained only as historical evidence:

- **ChatGPT coded** through MCP within operator-written scopes.
- **An independent ChatGPT conversation reviewed** the candidate through MCP, read-only.
- **Codex ran real local tests** with the existing dependencies and recorded command/source/exit/test inventory.
- **Codex coordinated authorized Git steps** outside MCP.

The current workflow replaces the pilot's manual review handoff with the durable shared-review participant/run/request protocol documented above. This document still authorizes no particular repository, branch, commit or push; verify selected repository instructions/ownership and obtain authorization only for operations outside the user's already granted scope.

## Scope excluded from current accepted source

Automatic worktree creation/cleanup, MCP commit/push tools, arbitrary shell, guaranteed hostile-code isolation, automatic browser/account setup, universal OS certification, and subscription-limit claims remain out of scope. Also deferred are asynchronous MCP real-project check jobs/evidence, shared job storage, macOS sandbox profiles, and the large-diff manifest/per-path review feature. Shared review handoff itself is implemented; do not list it as deferred.

Host-native browser control must use a normal signed-in ChatGPT conversation with Repo MCP attached through the client tool picker and a visible chip before submission. The Repo MCP service itself does not create a Chat conversation or attach the plugin, and Temporary Chat is not a recovery surface.

Official transport reference: [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). Connector operations remain capability-checked in the actual conversation rather than inferred from a product name.
