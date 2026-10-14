# Chat Review Handoff and Parallel Sharing Specification
Status: Proposed normative contract for implementation approval. Not implemented or deployed.
Date: 2026-10-13

## 1. Scope and invariants
Repo MCP remains the only repository-evidence route for ChatGPT semantic coding, review, and architecture.
1. ChatGPT Chat performs semantic coding/review/architecture. Codex coordinates coding and may coordinate review/architecture; Claude may coordinate review/architecture but never coding/write authority.
2. One unfinished task owns one registered checkout; one coding owner and one open coding workspace remain the maximum.
3. Independent reviewers may share one compatible review task, but each keeps a distinct participant, ChatGPT run, browser context, workspace request/token, prompt, diff base, scope, and result.
4. Existing exact-request deduplication, one-send reservation, uncertain-run recovery, bearer workspace authority, epoch/cursor checks, and task gates remain authoritative.
5. Sharing is bounded coordinator state around existing task/workspace/run controls, not a distributed execution platform.
6. Historical runs/tasks are never silently migrated, completed, rebound, resumed, or cleaned up.
Non-goals: no implementation during this docs phase; no implicit Oracle/host-model fallback; no automatic coding freeze/task theft/task-per-reviewer; no raised capture caps; no immutable-snapshot claim for live worktrees; no automatic cleanup of unknown/legacy/submitted/uncertain state.

## 2. Current-source constraints
Current source already supports multiple read-only workspaces on one task, exactly one coding workspace, registration/binding/phase epochs, workspace-bound cursors, shared task runtimes, admission draining, and fail-closed stale authority.
Current ChatGPT-run records bind repository/task epochs, policy, branch/HEAD, resolved base commit, prompt digest, hashed browser context, coordinator, work kind, and profile. Concurrent reserve authorizes exactly one submission; completion requires a distinct completed-response event plus exact output digest.
Current source git_diff supports base_ref and resolves it to an immutable base commit, although a client may expose a stale cached descriptor. Diagnose descriptor/build freshness; never add a base synonym.
Current diff is bounded, uses --no-renames, policy filtering, index/file-fingerprint stale checks, and safe UTF-8/file rules. Readable non-creatable untracked files can be absent from aggregate git_diff today.
Low-level task lifecycle and ChatGPT-run transition functions are directly callable, so share protection must live in common public primitives, not only a new wrapper.
Repository registrations already have registration_epoch/updated_at but no surface-policy field. Workspace-open request state already authoritatively maps its request ledger entry to workspace_id.

## 3. Chat surface policy
New defaults: code -> Chat/Sol High; code-hard -> Chat/Sol Extra High; review -> Chat/Sol Extra High; review-critical -> Chat/Sol Pro; architecture -> Chat/Sol Pro. The new coding default is an intentional behavior change; historical run surfaces are unchanged.
Use the existing repository catalog:
    npm run --silent coord -- repository surface-policy --repository REPOSITORY_ID --mode default|chat-only
RepositoryRegistration gains surface_policy: "default"|"chat-only"; missing legacy field normalizes to default.
An actual mode change uses the existing repository authorization-change/drain path, updates updated_at, increments registration_epoch once, and thereby stales older grants/workspaces and ChatGPT-run currentness checks. Same-mode is idempotent with no epoch bump.
chatgpt-run prepare and review prepare-or-join check surface_policy before creating model selection, request claim, participant, or run. chat-only fails Work with OWNER_SURFACE_POLICY even if an override is supplied.
For default repositories, Work requires explicit surface=work plus a bounded nonempty control-free surface-override reason stored only in owner-side metadata for that new run. No old run is rewritten/revived.
This project's durable policy is chat-only. This is an owner execution/accounting constraint, not a universal pricing/plan statement.

## 4. Dynamic Sol model evidence
VERSION grammar: COMPONENT [ "." COMPONENT [ "." COMPONENT ] ]; COMPONENT is 0 or a nonzero ASCII digit followed by at most two ASCII digits; one to three components and at most 11 ASCII characters. Reject signs, internal whitespace, leading zeros in multi-digit components, Unicode lookalike digits, extra components, control characters, and overlong labels.
Picker model label must be Sol, GPT-VERSION Sol, Sol Pro, or GPT-VERSION Sol Pro. Literal Sol/Sol Pro is mandatory model proof; version alone never proves family.
Chat control may be High, Extra High, Pro, VERSION High, VERSION Extra High, or VERSION Pro. Evidence retains normalized picker/control labels and both optional parsed versions through validation.
If both versions are present they must match exactly or MODEL_VERSION_MISMATCH. Picker-version + bare control is valid. Bare Sol/Sol Pro + versioned control is valid because picker proves family. Missing picker model evidence always MODEL_UNPROVEN.
Reject Astra, plain GPT-version without Sol, Light, localized/unknown labels, and control characters. Extra High never proves Sol Pro; Pro profile requires Sol Pro.
Required accept cases: GPT-6 Sol + 6 Extra High; GPT-6 Sol Pro + 6 Pro; GPT-5.6 Sol + 5.6 Extra High; future valid GPT-6.2 Sol + 6.2 Extra High; Sol + 5.6 Extra High; GPT-5.6 Sol + Extra High; Sol + Extra High; GPT-5.6 Sol Pro + 5.6 Pro; Sol Pro + 5.6 Pro; GPT-5.6 Sol Pro + Pro.
Required reject cases: GPT-5.6 Sol + 6.1 Extra High and GPT-5.6 Sol Pro + 6.1 Pro => MODEL_VERSION_MISMATCH; missing picker => MODEL_UNPROVEN; Astra/plain GPT/Light/localized/control-character labels; invalid VERSION grammar; family/profile target mismatch.
Existing 120-second selection TTL and 10-second observation age remain exact.

## 5. Review task resolution
Command:
    npm run --silent coord -- review prepare-or-join --repository REPOSITORY_ID [--task TASK_ID] --coordinator codex|claude --profile review|review-critical --surface chat --session-id SESSION_ID --prompt-file PROMPT_FILE --base-ref BASE_REF [--scope-prefix PREFIX] [--ttl-seconds N]
--task is optional. If supplied, it must be an unfinished task for the repository and is revalidated under its share gate.
If omitted: acquire a short repository review-selection gate; resolve unfinished repository tasks; require exactly one; zero => REVIEW_TASK_REQUIRED; multiple => REVIEW_TASK_AMBIGUOUS; capture its ID, acquire its task share gate, and re-read catalog/live task before participant publication.
A coding-phase candidate returns OWNER_ACTION_REQUIRED. prepare-or-join never binds a task or changes phase.
Safe zero-task path is explicit owner lifecycle preparation, then retry:
    npm run --silent coord -- task bind --repository REPOSITORY_ID --task FRESH_TASK_ID
    npm run --silent coord -- task phase --task FRESH_TASK_ID --phase review
No-task prepare-or-join never reports success. Concurrent taskless first preparations converge through repository-selection then task-share gating.

## 6. Target-only compatibility fingerprint
Basic sharing does not depend on the large-diff manifest or committed-target comparison.
TargetFingerprintV1 is independent of participant, prompt, base_ref/resolved base, scope/prefix, and diff pagination; two reviewers of the same live target with different bases/scopes get the same value.
Canonical inputs: bound branch/HEAD; existing bounded Git index digest (mode/object/stage/intent-to-add/skip-worktree/assume-unchanged); sorted policy-visible tracked changes/deletions; safe content SHA-256 for each policy-visible changed regular file; sorted policy-visible untracked regular files plus safe content SHA-256; safe replacement-race metadata; and an owner-keyed domain-separated opaque token over bounded denied/unsafe Git-status name/status/metadata without reading denied contents. Additionally, every policy-visible tracked index entry carrying assume-unchanged or skip-worktree is independently safe-statted and, when present as a safe bounded regular file, read/hashed from the worktree even when Git status/diff suppresses it; missing worktree state is included as a deletion/missing marker. Unsafe, changing, linked, unreadable, or over-cap flagged entries fail TARGET_FINGERPRINT_UNAVAILABLE.
Unchanged tracked bytes without assume-unchanged/skip-worktree are covered by HEAD plus index/object identity; no requirement is added to hash every tracked file. Flagged policy-visible tracked entries use the independent worktree check above, so with HEAD/index unchanged, changing their worktree bytes or making them missing changes the fingerprint. Policy-visible changed and untracked source bytes are content-hashed. Denied content is never opened and denied names/subdigests are never returned/logged; because denied bytes are not read, assurance remains phase_only rather than cryptographic candidate immutability.
Fingerprinting reuses existing bounded status/index/inventory/safe-file caps and operation budgets; no unbounded hidden-file scan and no raised capture limits. Incomplete/unsafe/over-cap capture => TARGET_FINGERPRINT_UNAVAILABLE, never partial publication.
Persisted fingerprint is not trusted alone after restart. Join and submission authorization recompute/revalidate current task identity/fingerprint. Missing/corrupt/partial fingerprint state fails closed.
Any policy-visible worktree byte change, index change, readable-untracked byte change, HEAD/branch change, or detectable denied/unsafe status-metadata change prevents mixing target versions.

## 7. Share compatibility and durable state
A generation is compatible only when repository/canonical checkout, registration epoch, task ownership, binding epoch, phase epoch, policy digest, phase=review, branch/HEAD, and TargetFingerprintV1 match.
Different bases/resolved bases/prompts/scopes/coordinators/browser contexts/results do not split a compatible generation.
Fingerprint change while protected participants exist => TARGET_CHANGED. New generation requires no protected participant/run/workspace and revalidated current task identity.
Owner-only strict/versioned share state stores no bearer token, write grant, raw prompt/output, raw browser ID, or unrelated private path. Minimum generation fields: schema_version, repository_id, task_id, generation, registration_epoch, binding_epoch, phase_epoch, policy_digest, branch, head, target_fingerprint, target_assurance="phase_only", coding_owner{status,coordinator,provenance,recorded_at}, participants.
Legacy coding-owner provenance is unknown; current caller/recency never invents ownership.

## 8. Participant/run/workspace binding
Each participant immutably binds share generation, participant_id, coordinator, run_id once published, requested/resolved base, scope digest, prompt digest, hashed browser context, workspace_request_id, and created_at.
New shared-review ChatGPT-run records also immutably bind share_generation + participant_id + workspace_request_id, and those fields participate in validation/exact-request identity. Legacy runs are not rewritten.
Workspace association is pending|bound|proven-absent. workspace_id starts absent and is write-once after authoritative reconciliation.
Mandatory command:
    npm run --silent coord -- review reconcile --task TASK_ID --participant PARTICIPANT_ID
It accepts no workspace ID/token. Under share gate it derives the existing workspace_open request-ledger key from immutable workspace_request_id, validates operation/args digest, reads its workspace_id, validates WorkspaceSelection repository/task/mode=review/epochs/policy, then writes workspace_id once. Arbitrary caller workspace IDs are never trusted.
Reserve/submitted/complete/uncertain/recover/fail-pre-submit/close validate the same generation+participant+workspace_request binding against run/participant state.
Before workspace creation, reserve/submitted may proceed with association=pending but protection remains. Completion and normal close require bound.
proven-absent is allowed only for a terminal pre-submit run when the authoritative ledger proves no workspace_open outcome. A submitted/uncertain participant with unresolved association remains protected/recovery-only; TTL never proves absence/completion.

## 9. Participant lifecycle
States: initializing, prepared, submission-reserved, submitted, completed, failed-pre-submit, uncertain, close-requested, closed, invalidated.
Closing one participant never closes/revokes a sibling, finishes/rebinds/resumes the task, or changes coding ownership.
Exact-request claims remain separate. Distinct participants normally get distinct runs; an exact duplicate request retains existing one-run/no-duplicate-submission behavior.

## 10. Browser and ChatGPT-run contract
Use normal signed-in ChatGPT Chat, never Temporary Chat for recovery. Select Chat; enforce chat-only; attach Repo MCP from composer/menu and visibly verify its chip; choose requested Sol High/Extra High/Pro; bind browser tab/session identity before first send; do not add conversation-id later without a separately implemented rebinding protocol.
Shared review uses review prepare-or-join. Non-shared preparation shape:
    chatgpt-run prepare --repository REPOSITORY_ID --task TASK_ID --coordinator codex|claude --kind code|review|architecture --profile PROFILE --surface chat --session-id SESSION_ID --prompt-file PROMPT_FILE --base-ref BASE_REF
Observe live picker/control:
    chatgpt-run observe --selection-id SELECTION_ID --surface chat --control-label CONTROL_LABEL --model-label MODEL_LABEL --selected-at SELECTED_AT --observed-at OBSERVED_AT --session-id SESSION_ID
Reserve:
    chatgpt-run reserve --run RUN_ID --contract-file CONTRACT_FILE --evidence-file EVIDENCE_FILE
Browser send occurs exactly once only when submission_authorized=true; recovery_required never authorizes another send.
Record send:
    chatgpt-run submitted --run RUN_ID --repository REPOSITORY_ID --task TASK_ID --prompt-sha256 PROMPT_SHA256 --base-commit BASE_COMMIT --browser-event-id SEND_EVENT --observed-at OBSERVED_AT --session-id SESSION_ID
After ChatGPT workspace_open, mandatory review reconcile occurs before accepting completion.
Complete with distinct event/exact digest:
    chatgpt-run complete --run RUN_ID --repository REPOSITORY_ID --task TASK_ID --prompt-sha256 PROMPT_SHA256 --base-commit BASE_COMMIT --browser-event-id COMPLETE_EVENT --observed-at OBSERVED_AT --session-id SESSION_ID --output-file OUTPUT_FILE --outcome ship|no-ship|completed --response-state completed --submission-event-sha256 SEND_EVENT_SHA256 --output-sha256 OUTPUT_SHA256
Recovery stays on same run/conversation:
    chatgpt-run uncertain --run RUN_ID --failure-code CODE
    chatgpt-run recover --run RUN_ID --resolution submitted|not-submitted [matching receipt flags]
    chatgpt-run recover-lock --run RUN_ID
    chatgpt-run recover-request --request-key REQUEST_KEY
No recovery invents completion or authorizes replacement for unresolved submitted work.

## 11. Guard placement and lock order
Share safety is enforced at lowest common public primitives so direct/legacy paths cannot bypass it.
Task lifecycle public primitives setTaskPhase, rebindTask, completeTask become share-aware. Modern coordinator wrappers and legacy scripts delegate to one guarded core and must not double-acquire the non-reentrant gate.
Shared-run public primitives prepare/reserve/submitted/complete/uncertain/recover/fail-pre-submit plus run/request recovery become participant-aware. Legacy non-shared run format and transition semantics remain legacy, but the same-task lifecycle guard must also inspect those journals so unresolved submission-reserved, submitted, or uncertain legacy runs cannot be bypassed by direct/legacy task paths.
Lock order: taskless selection = repository review-selection -> task share; shared prepare = share -> request; shared transitions = share -> run -> existing request lock for terminal claim cleanup; lifecycle = share -> task coordinator gate -> relevant workspace admission locks in stable workspace_id order -> control/catalog publication; reconciliation = share -> short control/auth read-publication.
No share/task/run/control lock spans browser/model execution, ChatGPT output wait, or semantic repository reading.
Before submission authorization revalidate generation and TargetFingerprintV1. If lifecycle invalidation won, reserve cannot authorize. If reservation won, normal lifecycle sees protected state and refuses.
Tests cover modern coordinator paths and direct/legacy exported/CLI paths.

## 12. Normal lifecycle vs security revocation
Normal cooperative lifecycle: review->coding resume, rebind, task finish, repository removal-as-cleanup. Refuse while protected participant states exist, while non-pre-submit-terminal workspace reconciliation is pending, while relevant workspace/read is active, or while same-task run/request evidence is unresolved. This explicitly includes legacy non-shared runs in submission-reserved, submitted, or uncertain state.
Security/authorization revocation has precedence: repository disable, explicit workspace revoke, surface-policy authorization change, or other explicit registration-epoch revocation. These use bounded existing drain/lock semantics, publish invalidation/epoch changes where specified, mark affected share state invalidated/recovery-only, and may invalidate current authority even when a same-task legacy non-shared run is submission-reserved/submitted/uncertain; all legacy/shared run/request/share evidence is preserved and completion is never fabricated.
Security revocation does not wait for reviewer completion. If a required lock cannot be safely obtained within its bounded contract, fail explicitly for operator recovery rather than wait forever.
Repository removal remains cleanup: current unfinished-task checks remain and recovery evidence is not destroyed merely to remove catalog state. Security cutoff uses disable/revoke.

## 13. Coordinator status and help
repository resolve adds per task: updated_at, age_seconds, coding-owner status/coordinator/provenance (legacy unknown), active/prepared/reserved/submitted/uncertain/stale participant counts, and conflict hints (owner action, active reviewers, unresolved submitted run, incompatible phase, stale identity). Never emit bearer/signing secrets, raw browser IDs, prompts/outputs, policy source paths, or unrelated private paths.
Both exit zero with complete static help and no state side effects:
    npm run --silent coord -- --help
    npm run --silent chatgpt-run -- --help
Help includes repository surface-policy; review prepare-or-join/reconcile/status/close/recover-participant; every chatgpt-run command/required flag. Invalid commands/flags stay nonzero.

## 14. Large-diff review coverage
Large-diff coverage is later-stage and not required for basic same-target sharing. base_ref remains the only diff-base selector; diagnose stale descriptor/deployed build before schema workaround.
Proposed git_diff V2 adds view?="aggregate"|"manifest"|"path" and path?=exact exposed path; omitted view preserves aggregate.
Manifest pagination and per-path patch pagination are independent. Manifest covers tracked modifications/deletions, staged additions/deletions/staged-only changes, readable creatable/non-creatable untracked, unreadable/unsafe/oversize, binary/non-UTF-8.
Denied/unsafe names are never exposed; only bounded hidden counts/opaque coverage state. Rename remains deletion+addition and cannot leak denied counterpart names.
Readable non-creatable untracked requires explicit read coverage; never widen write/create policy for review.
Whole-candidate SHIP requires manifest_complete plus every visible entry's path-patch or explicit-read requirement. manifest_complete != patch_complete; empty aggregate diff alone is insufficient.
Existing capture/page/file/index/inventory/time caps remain. Overflow/partial capture/hidden blocker/unreadable required content/stale cursor/index/HEAD/target-byte drift is explicit NOT TESTABLE/failure, never silent truncation.

## 15. Mutable-target limitation and deferred follow-up
Pinning base_ref freezes only the base. Live worktree/index remains mutable; current identity/index/file/cursor drift stays fail-closed. Parallel reviewers of distinct target versions or concurrent coding on one live checkout are unsupported.
Manual separate registered Git worktrees remain the optional operator isolation route for distinct targets.
A bounded committed base+target comparison is a deferred design follow-up, not a sharing prerequisite or minimal-rollout item, and must not weaken stale task/workspace checks.

## 16. Legacy, TTL, GC, and migration
Unknown/corrupt/partial share, participant, fingerprint, run, request, or authoritative workspace state fails closed. TTL means stale admission, never completed work.
GC/expiry never marks submitted/uncertain complete, fabricates receipts, releases unresolved exact-request claims, treats workspace expiry as completion, or deletes recovery evidence to unblock lifecycle.
Historical runs are not rewritten with participant/surface fields: legacy non-shared run format remains legacy. That does not exempt unresolved same-task legacy submission-reserved/submitted/uncertain runs from the lifecycle guard in §§11-12. Legacy ownership stays unknown.
Source skills are installed only after implementation/testing via the existing ownership-aware installer; foreign/modified copies require explicit replacement/backup.

## 17. Acceptance matrix
Model/surface: all Section 4 accept/reject cases, explicitly GPT-6 Sol + 6 Extra High and GPT-6 Sol Pro + 6 Pro accepted while plain GPT-6 remains rejected; 120s/10s; Chat defaults; default Work override reason; chat-only defeats override before state creation; same policy mode idempotent; actual change bumps registration_epoch/stales old authority; historical Work unchanged.
Task/share: omitted --task resolves exactly one; zero/multiple/coding-phase errors; explicit bind+review safe path; prepare-or-join never creates/freezes; concurrent taskless coordinators converge; different bases/scopes/prompts/results share; fingerprint stable across reviewers and changes on policy-visible bytes/index/readable-untracked changes; separate assume-unchanged and skip-worktree regressions prove that with HEAD/index unchanged, changing flagged worktree bytes changes the fingerprint and flagged missing/deletion is detected; unsafe/over-cap flagged state => TARGET_FINGERPRINT_UNAVAILABLE; denied names/content not exposed/read; restart revalidation; missing/partial state fails.
Participant/workspace: distinct participant/run/workspace_request/token; immutable generation+participant+workspace_request in run; reconcile derives workspace_id only from authoritative ledger; arbitrary workspace ID cannot bind; completion/normal close requires bound; only proven pre-submit terminal can use proven-absent; one closes while sibling continues.
Concurrency/lifecycle: exact reserve still one-send; bind/join/phase/rebind/finish/resume/submission races fail closed; direct scripts/task/run paths cannot bypass guard; lock order includes share->run->request and share->task->admission->control; no lock across browser work; a same-task legacy non-shared submission-reserved, submitted, or uncertain run blocks normal review->coding, rebind, and finish; explicit security disable/revoke may invalidate current authority while preserving that legacy evidence; TTL/GC never completes; sole coding owner/workspace unchanged.
Diff: base_ref descriptor mismatch diagnosed first; manifest/path pagination independent; staged-only and non-creatable untracked cannot be skipped; denied names do not leak; binary/non-UTF8/unsafe blockers explicit; rename delete+add; bounds preserved; empty aggregate cannot alone SHIP; live drift fail-closed.
CLI/skills: help exit 0/no state mutation; resolve adds age/provenance/counts/hints without secrets/private paths; Codex/Claude skills require signed-in normal Chat, Chat selected, Repo MCP chip, profile select, observe/reserve/one-send/submitted/reconcile/complete/recovery; no late conversation-id without rebind; no Temporary Chat, Oracle fallback, or host-model masquerade.
