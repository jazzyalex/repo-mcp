# Shared Chat Review Operational Workflow

Status: accepted source behavior for Stage 1 and Stage 2 shared-review core. Source validation is green; the broker was deployed and a bounded commit-pinned Claude-to-ChatGPT smoke passed on 2026-10-14. This does not certify first install on a clean Mac. Large-diff manifest/per-path coverage remains deferred.

This is the detailed operator reference for the maintained Codex and Claude Repo MCP skills. Installed skills are copied as standalone `SKILL.md` files, so they must first discover the Repo MCP control checkout from the launchd service `WorkingDirectory`, then read this file from that checkout. Do not assume this file exists beside an installed skill.

## 1. User-facing contract and authority

The user may simply say:

> Use Repo MCP to code/review/plan this repository.

Do not ask the user for repository IDs, task IDs, policy paths, workspace tokens, write grants, request IDs, model-policy files, or browser-session IDs. Resolve the current Git root, discover the installed control checkout, and keep generated authority internal.

ChatGPT web Chat performs semantic review and architecture for both Codex- and Claude-coordinated routes. A Codex subagent, Claude-native review, Work, Oracle, or another backend is not an equivalent fallback. Coding/write coordination is Codex-only.

Repository/task registration, policy, task lifecycle, write grants, service control, Git operations, browser control, and local test/build execution remain trusted coordinator actions. One coding owner/workspace remains enforced.

## 2. Resolve the checkout and control installation

1. Resolve the user's current checkout with `git rev-parse --show-toplevel`; do not guess among sibling repositories or worktrees.
2. Read the checkout's root instructions.
3. Discover the permanent Repo MCP control checkout from `~/Library/LaunchAgents/local.repo-mcp.server.plist` `WorkingDirectory`. Verify its `package.json` and coordinator before running control commands there.
4. Run from that control checkout:

   ```sh
   npm run --silent coord -- repository resolve --repo CURRENT_ROOT
   ```

   Reuse the existing registration. If the checkout is not registered, create a narrow owner-only external policy and register that exact checkout. Generate a stable internal repository ID; do not ask the user to invent one.

Repository selection never requires `service start`. That command intentionally reloads launchd and is reserved for first load, authorized deployment, or recovery.

## 3. Select or prepare a review task without task theft

The lower-level `coord review prepare-or-join` CLI accepts an optional `--task`, but
the browser handoff MUST resolve the sole safe review task **before** final prompt
construction and then always pass that exact `--task TASK_ID` during preparation.

- Discover the current repository's unfinished task authority with owner-side repository/task status before building the prompt. Proceed only when exactly one safe review task is selected.
- Zero tasks, multiple/conflicting tasks, a coding-phase owner, stale authority, or another protected workflow fails closed without binding, freezing, rebinding, or stealing a task.
- The optional-task CLI form is a combined task-selection **and durable preparation** API for callers that intentionally delegate task selection; it still requires the final prompt, session ID, and workspace request ID. It is not a read-only discovery step and the browser handoff does not use it.
- Bind a new task only when the operator has established that no unfinished owner is displaced. One registered checkout still has at most one unfinished task.
- Moving an owned coding task to review is explicit owner lifecycle: first close the coding workspace and durably complete/reconcile the coding run, then request the phase change. Normal phase/rebind/finish operations refuse protected participants, active relevant workspaces/admitted operations, and currently authorized unresolved runs.
- Security disable/revoke may retire current authority without fabricating completion or deleting historical run/request evidence.

Compatible reviewers share the same task/generation/target while keeping distinct participants, Chat sessions, `workspace_open` request IDs, runs, workspaces, and results. Do not serialize all reviews merely because they address the same repository.

## 4. Profiles and execution surfaces

For ChatGPT web Chat:

- `code` -> Sol High
- `code-hard` -> Sol Extra High
- `review` -> Sol Extra High
- `review-critical` -> Sol Pro only for explicitly super-complex/critical Pro review
- `architecture` -> Sol Pro

Planning and brainstorming are user intentions mapped to the implemented
`--kind architecture --profile architecture --surface chat` route; they do not have
separate executable work kinds or profiles.

Chat model evidence accepts bare Sol/Sol Pro and supported dynamic numeric `GPT-VERSION Sol` / `GPT-VERSION Sol Pro` labels. Never silently downgrade.

Review sharing accepts only `review` or `review-critical` on Chat. Architecture,
planning, and brainstorming intentions use the generic
`chatgpt-run prepare --kind architecture --profile architecture --surface chat` path
with an `inspect` workspace. Do not route them through
`coord review prepare-or-join`, do not freeze a task merely for them, and do not issue
a coding grant.

## 5. Prepare immutable review inputs before prompt hashing

Before constructing the final review prompt:

1. Choose the target mode. For legacy working-tree review, resolve the intended Git base locally to an immutable commit. For commit-pinned review, choose explicit `base_ref` and `head_ref` (plus optional `scope_prefix`); `head_ref` without `base_ref` is invalid, and prepare-or-join will resolve both server-side.
2. Generate a unique logical `workspace_open` request ID.
3. Generate one stable logical browser session ID for this review attempt.
4. Preserve a private mapping from that session ID to the normal ChatGPT conversation URL/tab for recovery. Do not use Temporary Chat.
5. Attach Repo MCP in that normal Chat conversation through the tool picker and verify the visible Repo MCP chip before submission.
6. Select Chat and the exact required model/effort.

Now construct the **final** prompt. It must already contain the exact internal repository ID, task ID, preallocated workspace request ID, required `review` workspace mode, and the selected target. For commit-pinned review include the requested base/head/scope and the expected immutable base/head commits; tell ChatGPT to pass those same requested refs/scope to `workspace_open`. It must tell ChatGPT to call `service_info`, `repository_list`, then `workspace_open` and keep the returned token private. Do not append IDs, target instructions, or handoff text after this prompt is hashed/prepared.

Do not add a conversation ID after an initial session-only binding. Use the same browser-context identity for observe/submission/completion/recovery.

## 6. Shared review prepare-or-join

Persist the final prompt to an owner-only local file and run:

```sh
npm run --silent coord -- review prepare-or-join --repository REPOSITORY_ID --task TASK_ID --coordinator COORDINATOR --profile PROFILE --surface chat --session-id SESSION_ID --workspace-request-id WORKSPACE_OPEN_REQUEST_ID --prompt-file FINAL_PROMPT_FILE --base-ref BASE_REF [--head-ref HEAD_REF] [--scope-prefix PREFIX]
```

Use `COORDINATOR=codex` or `claude` and `PROFILE=review` or
`review-critical`. Browser handoff always passes the exact `--task TASK_ID` discovered
from owner-side repository/catalog status before final prompt construction. Omitting
`--head-ref` preserves legacy `phase_only` working-target review. Supplying
`--head-ref` requires explicit `--base-ref` and creates `commit_pinned` assurance
bound to resolved base/head, policy, scope, and format version; the returned
`candidate_digest` is coverage identity, not a whole-repository SHIP certificate.
Optional `--scope-prefix` and review `--ttl-seconds 60..3600` are supported. Callers
that intentionally omit `--task` are asking prepare-or-join to combine task selection
with durable participant/run preparation; that form is not the browser handoff discovery
path.

The result is nested:

```text
{ generation, participant, run, already_applied? }
```

Persist the exact `run` object separately, including its `selection`. Existing `chatgpt-run observe/reserve/submitted/complete/recover` commands operate on that run. **Never pass the entire `{generation, participant, run}` wrapper as the selection contract.**

Before observe/reserve/send, compare both `participant.task_id` and `run.task_id`
with the exact `TASK_ID` embedded in the final prompt, and compare
`participant.resolved_base_commit` / `run.resolved_base_commit` with the commit resolved
before prompt construction. For commit-pinned review, also require exact equality of
`participant.commit_binding` and `run.commit_binding`, including requested/resolved
base/head, scope and candidate digest. Stop on any mismatch; do not rewrite the
already-hashed prompt.

An exact retry reuses the same participant/run and never authorizes a second send.

## 7. Observe, reserve, submit exactly once

After the trusted browser controller re-reads the live Chat control, record the observation with the run's exact `selection.selection_id`:

```sh
npm run --silent chatgpt-run -- observe --selection-id SELECTION_ID --surface chat --control-label "Extra High" --model-label "Sol" --selected-at ISO_TIME --observed-at ISO_TIME --session-id SESSION_ID
```

The example is the default `review` profile. For `review-critical`, record the live
`Pro` / `Sol Pro` evidence instead. Supported dynamic numeric Chat labels such as
`5.6 Extra High` and `GPT-5.6 Sol` are recorded exactly and must match when both
picker and effort controls carry a version.

Persist the returned sanitized evidence. Immediately before the one browser submission:

```sh
npm run --silent chatgpt-run -- reserve   --run RUN_ID   --contract-file PREPARED_RUN_JSON   --evidence-file OBSERVED_EVIDENCE_JSON
```

`PREPARED_RUN_JSON` is the exact saved `prepared.run` object; the CLI extracts its `selection`. Submit the already-final prompt only when the response says `submission_authorized: true`. If it says recovery is required, do not resend.

After the browser adapter observes the actual send event, record `submitted` using the exact repository/task/prompt/base binding and the same session ID:

```sh
npm run --silent chatgpt-run -- submitted --run RUN_ID --repository REPOSITORY_ID --task TASK_ID --prompt-sha256 PROMPT_SHA256 --base-commit RESOLVED_BASE_COMMIT --browser-event-id SUBMISSION_EVENT_ID --observed-at ISO_TIME --session-id SESSION_ID
```

For commit-pinned runs, both `submitted` and later completion/recovery receipts must also pass `--head-commit RESOLVED_HEAD_COMMIT --candidate-digest CANDIDATE_DIGEST`; those values must match the durable run binding exactly. Legacy working-target runs omit them.

Keep the submission event hash returned by run status for completion.

## 8. Workspace reconciliation and review work

The prompt makes ChatGPT open its own review workspace with the preallocated request ID.
For commit-pinned review that `workspace_open` call also supplies the same requested
`base_ref`, `head_ref`, and `scope_prefix` used during preparation. The service
resolves them again and refuses nonmatching or moved targets through request/reconciliation
identity rather than silently changing the candidate. The authoritative owner-side request
ledger is the binding source.

After `workspace_open` has occurred:

```sh
npm run --silent coord -- review reconcile   --task TASK_ID   --participant PARTICIPANT_ID
```

Reconciliation accepts no caller workspace ID. It derives the immutable workspace ID from the authoritative `workspace_open` request ledger and validates repository/task/mode/epochs/policy.

ChatGPT then verifies `repo_info`, complete instructions, task/policy and the selected
target, and reads the complete bounded evidence needed for the requested review. Legacy
working review uses the prepared immutable base against the live working target. In a
commit-pinned workspace, `repo_info` reports `review_assurance: "commit_pinned"`,
`candidate_digest` and the immutable binding; instruction/context reads are committed
reads pinned to the bound head, and `git_diff` is pinned to bound base/head/scope.
Inconsistent `read.ref`, diff base/head/scope, and live list/search requests fail closed.
A clean working tree is irrelevant to commit-pinned evidence.

Commit-pinned `candidate_digest` covers format version, policy, immutable base/head and
scope; it does not certify unreviewed paths or turn binary/non-text identity into semantic
coverage. The retained commit diff returns a full-capture SHA-256 and binary/non-text
changes carry blob/mode/size identity with explicit review limits. Large-diff
manifest/per-path coverage remains deferred. Existing read/diff/output caps remain
authoritative; denied, unsafe, non-UTF-8, over-cap or capture-limit evidence can still
make a complete review impossible. Local tests/typecheck are coordinator-supplied evidence
outside the read-only review workspace; do not request `run_tests` there. Never return
SHIP from incomplete bounded coverage.

ChatGPT may close its workspace before the final assistant response; the durable `workspace_open` ledger still permits authoritative reconciliation.

## 9. Complete and close one participant

A participant must be reconciled `bound` before normal completion.

After the trusted browser adapter observes the finished response, save the exact response text to a bounded output file and compute its SHA-256. Record completion with a fresh completion browser event and the original submission event hash:

```sh
npm run --silent chatgpt-run -- complete --run RUN_ID --output-file OUTPUT_FILE --outcome OUTCOME --response-state completed --submission-event-sha256 SUBMISSION_EVENT_SHA256 --output-sha256 OUTPUT_SHA256 --repository REPOSITORY_ID --task TASK_ID --prompt-sha256 PROMPT_SHA256 --base-commit RESOLVED_BASE_COMMIT --browser-event-id COMPLETION_EVENT_ID --observed-at ISO_TIME --session-id SESSION_ID
```

For a commit-pinned run, add `--head-commit RESOLVED_HEAD_COMMIT --candidate-digest CANDIDATE_DIGEST` to this completion command as well.

Use `OUTCOME=ship`, `no-ship`, or `completed`.

The completion event must differ from submission and must describe the actually observed finished response.

Then close only that participant with a fresh request ID:

```sh
npm run --silent coord -- review close   --task TASK_ID   --participant PARTICIPANT_ID   --request-id FRESH_CLOSE_REQUEST_ID
```

Closing one participant must not close or invalidate compatible siblings.

## 10. Recovery and uncertainty

Never duplicate a possibly submitted prompt.

- Mark uncertain reservation/submission with `chatgpt-run uncertain --run RUN_ID --failure-code CODE`.
- Reattach to the **same** normal Chat conversation/session and use `chatgpt-run recover --run RUN_ID --resolution submitted|not-submitted ...` with fresh trusted browser evidence.
- A historical invalidated participant may recover the same immutable run/evidence without regaining current submission authority or mixing with a newer generation.
- Submitted or uncertain work remains protected even when workspace reconciliation is pending.
- `coord review recover-participant --task TASK_ID --participant PARTICIPANT_ID` may prove workspace absence for an actual terminal `failed-pre-submit` run, or for an orphan participant whose run was never created after its dead initializer claim is recovered. Both paths require the authoritative ledger to contain no `workspace_open` outcome. Existing or corrupt runs, live or foreign initializers, and any authoritative open outcome fail closed.
- `chatgpt-run recover-request` and `recover-lock` are explicit crash-recovery tools; they do not create replacement authority or fabricated completion.

Security disable/revoke preserves run/share/request evidence. GC cleans eligible local Repo MCP state only; it never removes ChatGPT history, invents completion, or discards protected pending/bound workspace evidence required for recovery.

## 11. Coding ownership and explicit review phase

Shared review never steals the coding owner.

Before an owner explicitly moves a coding task to review, its coding workspace must be closed and its ChatGPT coding run must be durably completed/reconciled. The owner then performs the explicit lifecycle transition. Normal resume/rebind/finish is refused while current protected participants, active relevant workspaces/admitted operations, or currently authorized unresolved runs remain.

After review is cleared, moving back to coding requires a fresh write grant and a new coding workspace. Old coding selections never revive.

## 12. Architecture, planning, and brainstorming intentions

All three intentions use the implemented
`chatgpt-run prepare --kind architecture --profile architecture --surface chat` path,
not shared-review prepare-or-join. Use an `inspect` workspace, Sol Pro, no write grant,
and no unsolicited phase freeze. There are no separate executable `plan` or
`brainstorm` work kinds/profiles. The coordinator still records
observe/reserve/submitted/complete evidence and recovers the same conversation after
interruption.

## 13. Setup, deployment, and schema refresh

- `service start` intentionally reloads launchd. Use it only for first load, authorized deployment, or recovery; never merely to select another repository/task.
- Reuse the installed tunnel ID and saved runtime key while healthy. Do not rotate per task.
- Install source skills only with the existing ownership-aware installer. It updates installer-owned matching copies; foreign/modified installed copies require explicit inspect-and-replace with backup.
- Refresh ChatGPT tools only **after a deployed MCP schema change**. Source edits, policy changes, repository selection, or task changes alone do not require tool refresh.
- A running pre-deployment broker may not expose newly accepted source commands/schema yet. Validate source first, deploy only when authorized, then refresh tools if the deployed schema changed and perform live smoke.

## 14. Deferred large-diff work

The accepted shared-review core still does not include the proposed large-diff
manifest/per-path feature or a `target_ref` synonym. Do not describe those APIs as
deployed or available. Bounded commit-pinned review uses the existing `read.ref`,
`git_diff.base_ref + head_ref`, and review-workspace base/head/scope binding described
above. Legacy working-tree review remains `phase_only`; commit-pinned assurance is
stronger only for the exact policy/scope and immutable commit pair and is not a blanket
whole-repository SHIP claim.
