# Chat Review Handoff and Parallel Sharing Implementation Plan
Status: Stages 1-2 shared-review core deployed and bounded commit-pinned Claude-to-ChatGPT smoke passed on 2026-10-14. Clean-Mac first install remains unproven; large-diff manifest/per-path work remains deferred.
Date: 2026-10-13
Normative contract: docs/CHAT-REVIEW-SHARING-SPEC.md. This plan references that contract instead of restating it.

## 1. Execution discipline
- ChatGPT Chat performs semantic coding and independent semantic review through Repo MCP. Codex is the coding coordinator and runs approved local builds/tests/Git. Claude may coordinate Chat review/architecture only.
- Never use Work for this project; never fall back implicitly to Oracle or a host-model review.
- Preserve all pre-existing source/test drafts and unresolved legacy evidence until an approved implementation stage explicitly changes the intended source files.
- No commit, push, service restart, deployment, cleanup, task finish/rebind/resume, or other-repository access is part of this docs revision.
- Every coding stage is regression-first: add failing tests for the specified contract, make the smallest source change in Chat, run targeted local gates in Codex, then obtain independent Chat Extra High review before expanding scope.

## 2. Stage 0 — Approval and implementation preflight
Goal: freeze the design, not the repository.
Targets: SPEC §§1-17; current AGENTS/CLAUDE/README/SETUP/MULTI-REPO-SPEC; protected model-policy draft files; relevant task/run/diff/coordinator source.
Gate:
1. Owner approves the revised spec and plan.
2. Reverify branch/HEAD/task epochs/policy and protected-file hashes before implementation.
3. Run repository resolve/status and inspect unresolved run/share conflicts; do not clean them automatically.
4. Diagnose git_diff.base_ref freshness: source schema, built/deployed broker schema, then cached Chat descriptor. Refresh descriptors if broker is current; rebuild/restart only if the deployed build is actually stale.
5. If implementation preflight identity differs from the approved target, stop and re-review scope.

## 3. Stage 1 — Chat model, surface policy, and CLI unblock
Implements SPEC §§3-4 and §13 first so real Chat handoff is usable before sharing work.

### 3.1 Dynamic Sol evidence
Source: src/model-policy.ts.
Tests: test/model-policy.test.ts.
Red gate: add the complete SPEC §4 accept/reject matrix, explicitly accepting GPT-6 Sol + 6 Extra High and GPT-6 Sol Pro + 6 Pro while still rejecting plain GPT-6; also cover future valid versions, bare-Sol/versioned-control, version mismatch, MODEL_UNPROVEN, Astra/Light/localized/control chars, invalid grammar, and evidence retaining both versions.
Expected current red: the existing draft cannot satisfy future-version acceptance plus cross-version agreement.
Green: replace finite hard-coded Chat prefix stripping with strict dynamic parsing; preserve actual observed picker/control/version fields through validation.
Targeted gate: model-policy tests + npx tsc --noEmit; independent Chat Extra High review of this delta.

### 3.2 Durable Chat-only/default surface policy
Source: src/multirepo-state.ts, scripts/coordinator.ts, src/chatgpt-run.ts; optionally isolate parsing/decision logic in a small src/execution-surface-policy.ts.
Tests: test/multirepo.test.ts, test/chatgpt-run.test.ts, focused surface-policy tests if isolated.
Red/green requirements: exact SPEC §3 command; missing legacy field=>default; same-mode idempotence; actual change uses existing repository drain/control publication and increments registration_epoch; old grants/workspaces/runs become stale; chat-only refuses Work before selection/request/participant/run creation; default Work requires explicit bounded reason; historical runs unchanged.
After green, configure this repository chat-only only during approved deployment, not in source-coding tests.

### 3.3 Side-effect-free CLI help
Source: scripts/chatgpt-run.ts, scripts/coordinator.ts.
Tests: CLI tests using a nonexistent temporary state root.
Red/green: coord --help and chatgpt-run --help exit 0, list all current/new command flags including surface-policy, create no state/locks, and invalid commands remain nonzero.
Docs after Stage 1 green: README.md, SETUP.md, and docs/MULTI-REPO-SPEC.md must describe only implemented surface/model/CLI behavior. Stage 1 gate: targeted tests + typecheck, then full npm test if targeted green; no test claims without Codex runner receipts.

## 4. Stage 2 — Minimal same-target shared reviews
Implements SPEC §§5-13. This stage does not wait for large-diff manifest work and does not add target_ref.

### 4.1 Target-only fingerprint
Prefer isolated source: src/review-target.ts; integrate only needed safe Git/inventory helpers from src/repo.ts/identity/task state.
Tests: new test/review-target.test.ts plus focused path/index tests.
Red cases from SPEC §6: stable across two reviewers with different base/scope/prompt; changes on policy-visible worktree bytes, index, readable untracked, HEAD/branch; separate assume-unchanged and skip-worktree regressions where HEAD/index stay unchanged but flagged worktree bytes change and the fingerprint must change; for each flag also cover missing/deletion, and unsafe/unreadable/over-cap flagged state => TARGET_FINGERPRINT_UNAVAILABLE; denied names/content never exposed/read; bounded opaque denied metadata; incomplete/corrupt state fails; restart requires recomputation.
Green must reuse existing bounds and keep assurance phase_only.

### 4.2 Share/participant journal and optional task selection
Source: new src/review-share.ts; src/chatgpt-run.ts; scripts/coordinator.ts.
Tests: new test/review-share.test.ts plus test/chatgpt-run.test.ts.
Implement SPEC §§5,7-9:
- review prepare-or-join with optional --task;
- repository selection gate -> task share gate -> revalidation;
- zero/multiple/coding-phase errors and explicit existing task bind+phase safe path;
- no auto task creation/freeze;
- generation compatibility uses TargetFingerprintV1, not diff/base/scope/prompt;
- new shared-run immutable generation+participant+workspace_request fields;
- distinct participants/runs for independent reviewers while exact duplicate request dedupe stays intact.

Required two-coordinator tests: concurrent Codex+Claude taskless joins converge on one task/generation; distinct participant/run/browser/workspace_request; different bases/scopes share; distinct results remain distinct.

### 4.3 Mandatory authoritative workspace reconciliation
Source: src/review-share.ts, src/multirepo-state.ts, scripts/coordinator.ts.
Tests: review-share + multirepo.
Implement SPEC §8 reconcile with no workspace-id input. Derive workspace_id from existing workspace_open request ledger and validate selection identity/epochs/mode before write-once binding.
Red/green: arbitrary workspace ID cannot bind; completion/normal close requires bound; a terminal pre-submit run or a never-created run with a recovered dead initializer claim can become proven-absent only when authoritative workspace-open evidence is absent; submitted/uncertain pending association remains protected; one participant closes while sibling continues.

### 4.4 Lowest-common lifecycle/run guards
Source: src/task.ts, src/multirepo-state.ts, src/chatgpt-run.ts, scripts/task.ts compatibility path, scripts/chatgpt-run.ts, src/coordinator.ts, src/gc.ts as needed.
Tests: test/task.test.ts, test/multirepo.test.ts, test/chatgpt-run.test.ts, review-share tests, GC tests.
Refactor to one share-aware guarded core per public lifecycle operation so modern wrappers and direct/legacy paths cannot bypass SPEC §§11-12. Avoid double-acquiring non-reentrant gates.
Required deterministic races/regressions: bind/join; join/join; review->coding/join; rebind/join; finish/active participant; reserve vs lifecycle invalidation; completion vs close; close vs admitted read; GC/TTL vs submitted run; direct scripts/task and direct chatgpt-run transition paths; plus a legacy non-shared same-task run in each submission-reserved, submitted, and uncertain state, proving normal review->coding/rebind/finish is blocked while explicit security disable/revoke may invalidate current authority and preserves the legacy run/request evidence.
Assert lock order: selection->share for taskless join; share->request for prepare; share->run->request for transitions/terminal claim cleanup; share->task->sorted workspace admission->control for lifecycle. No lock across browser/model execution.
Security tests: disable/revoke can invalidate without waiting for reviewer completion, preserve recovery evidence, and fail explicitly rather than wait forever on unsafe/stale locks. Repository removal remains normal cleanup.

### 4.5 Resolve/status and ownership provenance
Source: src/multirepo-state.ts, src/review-share.ts, scripts/coordinator.ts.
Tests: multirepo/coordinator/onboarding.
Implement SPEC §13: updated_at/age, legacy-unknown coding ownership, participant counts/staleness/conflict hints; never expose bearer secrets, raw browser IDs, prompts/outputs, policy source paths, or unrelated private paths.
Reviewer join/close never changes coding owner. Existing exactly-one coding workspace enforcement remains unchanged.

### 4.6 Codex and Claude source skills
Source: .codex/skills/repo-mcp/SKILL.md, .codex/skills/repo-mcp-architect/SKILL.md, .claude/skills/repo-mcp/SKILL.md, .claude/skills/repo-mcp-review/SKILL.md, .claude/skills/repo-mcp-architect/SKILL.md.
Tests: test/agent-skills.test.ts, test/onboarding.test.ts, test/package-release.test.ts.
Skills must implement SPEC §10 exactly: signed-in normal Chat, Chat selected, Repo MCP attach+visible chip, profile selection, stable session identity from start, observe/reserve/one send only on submission_authorized/submitted/reconcile/complete/recovery; no late conversation-id, Temporary Chat recovery, Oracle fallback, or coordinator-model masquerade.
Install globally only after source/tests are green, using existing ownership-aware installer; foreign/modified installed copies require explicit backed-up replacement.
Docs after Stage 2 green: README.md, SETUP.md, docs/MULTI-REPO-SPEC.md, and the Codex/Claude source skills must match implemented sharing/lifecycle/status behavior. Stage 2 gate: all targeted share/run/task/multirepo/GC/skill tests + typecheck + full npm test; independent Extra High review of authorization/concurrency diff.

## 5. Stage 3 — Large-diff manifest and per-path coverage
Implements SPEC §14 after minimal sharing is green.
Source: src/repo.ts, src/multirepo-server.ts, bounded helper module if needed.
Tests: test/diff-scope.test.ts, test/multirepo.test.ts, focused manifest tests.
Schema: add view=aggregate|manifest|path and exact path; keep base_ref canonical; do not add target_ref in this stage.
Red/green cases: independent manifest/patch pagination; large candidate under existing caps; tracked deletion; staged add/delete/staged-only patch content; readable creatable and non-creatable untracked (explicit read for latter); denied/unsafe hidden counts without names; binary/non-UTF-8 blockers; rename delete+add/no denied counterpart leak; no manifest_complete=>patch_complete shortcut; empty aggregate cannot SHIP; file/index/HEAD/cursor drift stale; capture overflow explicit.
Do not widen read/write/create policy or raise capture/time/index/inventory limits.
Docs after Stage 3 green: README.md, SETUP.md, and docs/MULTI-REPO-SPEC.md must document the actual manifest/path schema and limits. Gate: targeted diff/multirepo tests + typecheck + full suite; Extra High review focused on name leakage, completeness, and stale-target behavior.

## 6. Stage 4 — Full validation, deployment, and smoke
Coordinator-provided prior runner evidence from the handoff (not rerun in this docs revision): prerequisites passed; npm ci exit 0 with 0 vulnerabilities; npm test reported 404 total / 403 passed / 0 failed / 1 optional Python skip; npx tsc --noEmit passed. Treat it only as baseline evidence.
Before deployment Codex reruns approved current gates and records exact commands/status/counts. Minimum: npm ci, npx tsc --noEmit, npm test; build/release checks only if required by the approved deployment path.
Independent review gate: at least one Chat Extra High full-candidate review; for sharing release, a second independent reviewer uses the same compatible task with a distinct participant/run/workspace. NO-SHIP returns to the owning stage.

Deployment order:
1. Inspect source vs built/deployed broker schema. Restart/redeploy only when deployed bytes/schema changed.
2. After tool-schema change, Refresh tools and start a compatible new Chat; never invent a base_ref alias for stale descriptors.
3. Apply repository surface-policy chat-only through the implemented command.
4. Install owned skills only after checks; do not silently replace foreign/modified copies.
5. Do not clean or resolve historical/other-project state as part of deployment.

Smoke matrix:
- Codex-coordinated Chat coding: Chat-only enforced, Repo MCP chip verified, dynamic Sol evidence, exactly one send/completion.
- Parallel review: explicit owner review phase; Codex and Claude prepare-or-join one task; distinct participants/runs/workspaces; different base/scope allowed; close one while other continues; explicit coding-owner resume only after protected state clears.
- Recovery: disconnect after submission, mark uncertain, recover same normal Chat/run, no duplicate send.
- Lifecycle security: normal resume/rebind/finish blocked by active participants; explicit disable/revoke invalidates promptly with evidence preserved.
- Large-diff fixture: manifest/per-path coverage, staged-only, non-creatable untracked explicit read, denied-name nonleakage, bounded overflow.
- Stale target fixture: target fingerprint/cursor becomes invalid on live target change.

## 7. Deferred follow-up and rollback
Bounded committed base+head comparison is implemented through base_ref/head_ref and committed read.ref. The target_ref synonym and large-diff manifest/per-path coverage remain deferred. Separate registered worktrees remain the manual isolation path for distinct targets.
Rollback preserves evidence: disable automatic sharing routing, revert/deploy prior code/schema through normal Git/service workflow, refresh client descriptors, reinstall only owned skill versions. Never rollback by deleting uncertain/submitted runs, fabricating completion, resetting epochs to revive stale tokens, or switching to Work/Oracle.

## 8. Final implementation acceptance gate
Implementation is ready to ship only when every SPEC §17 group is green, source/test docs match actual CLI/schema behavior, local runner evidence is recorded, independent Chat review is SHIP, real two-reviewer smoke proves one task with distinct tokens/results, and no protected legacy/source state was altered outside the approved stage.
