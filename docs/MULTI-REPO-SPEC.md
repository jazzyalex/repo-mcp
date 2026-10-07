# Repo MCP Multi-Repository Service Specification

Status: normative architecture for the v0.2 multi-repository service, 2026-10-05.

This document defines the production contract that replaces the single-active-repository service. Existing path-policy, task outcome, containment, tunnel, and trusted-local-machine constraints continue to apply unless this document explicitly changes the lifecycle.

“MUST”, “MUST NOT”, “SHOULD”, and “MAY” are requirements terms.

## 1. Product goal

One installed Repo MCP service MUST serve multiple operator-approved Git checkouts concurrently without restart. Different ChatGPT or Claude conversations MAY select different approved repositories at the same time. Repository selection MUST be explicit, immutable for the lifetime of a workspace selection, and authenticated by server-issued capability tokens.

Repository registration, policy selection, task lifecycle changes, write-grant issuance, service control, Git commit/push, and arbitrary shell execution remain outside MCP.

The service MUST start with an empty repository catalog. Registering, selecting, switching, disabling, or finishing a repository/task MUST NOT require a service restart.

## 2. Trust and threat model

Repo MCP remains a trusted-single-user local tool, not a hostile-code sandbox or multi-tenant isolation boundary.

The security boundary assumes:
- the local OS account, approved repository code, operator-written policies, and approved fixture tests are trusted;
- the loopback HTTP endpoint is not exposed directly to untrusted networks;
- remote access uses the private authenticated tunnel;
- cooperative file/task locks do not stop unrelated local editors, shells, or malicious processes running as the same user;
- Node/macOS path verification detects many races but does not make hostile filesystem races impossible.

A workspace token is a bearer capability. Possession authorizes only the persisted selection it authenticates. It is not proof of a human identity, ChatGPT conversation identity, or independent reviewer identity.

Transport/session identifiers, MCP request IDs, SDK protocol-era identifiers, and optional client metadata MUST NOT select a repository or grant write authority. Conversation metadata MAY be used for diagnostics or an additional correlation check only after its delivery/provenance contract is independently verified.

## 3. Authority model

Production authority has four layers:

1. Permanent service — fixed MCP schemas, registry, runtime manager, audit, and service-level health.
2. Repository registration — operator-approved canonical checkout plus immutable policy snapshot and maximum access ceiling.
3. Task registration — one lifecycle binding to a registered checkout, with durable branch/HEAD/policy state, phase epoch, binding epoch, request outcomes, and checkout ownership.
4. Workspace selection — immutable, server-issued access to one registered task in one mode.

No repository tool has ambient authority. Every production repository tool call MUST carry a valid workspace_token.

The effective permission is the intersection of repository enabled state and registration epoch; task completion, binding epoch, phase epoch, and current live binding; workspace mode and persisted capabilities; repository path policy and limits; and current task phase. Any mismatch fails closed.

## 4. Repository registry

A registration contains at least stable operator-chosen repository_id, display name, canonical checkout root, canonical git_dir/common_dir, root digest, immutable operator-state policy_ref, canonical policy_digest, monotonically increasing registration_epoch, enabled state, and timestamps.

The model MUST NOT supply filesystem roots or policy paths through MCP.

Registration is a coordinator operation. It MUST:
- canonicalize and verify the Git checkout with the existing repository identity rules;
- reject bare repositories and detached HEAD where task binding has not explicitly allowed it;
- require operator state and the supplied policy source to remain outside the target checkout;
- reject policy sources inside any already registered checkout;
- reject overlapping or nested registered checkout roots;
- reject duplicate aliases for the same physical checkout;
- allow distinct linked worktrees when their checkout roots/git dirs differ even when they share a common Git directory;
- compile the policy before publishing registry state;
- copy the normalized policy into owner-only, content-addressed operator state;
- never make later source-policy file edits an implicit live policy change.

Disabling or changing a registration increments its registration epoch and invalidates existing selections. If the registration has an unfinished task, the authorization change is acknowledged only after the task mutation/check gate drains, so no previously admitted write/check can publish after the new registration epoch is reported.

## 5. Tasks and checkout ownership

One unfinished task is permitted per registered checkout in v0.2. Independent concurrent coding work against the same underlying project requires separately registered Git worktrees.

Task state retains the existing canonical checkout root/git/common directory, branch and HEAD binding, policy digest, coding/review phase, durable mutation request outcomes, interrupted create_file publication evidence, cooperative long-lived checkout writer lock, and task mutation/phase gate.

The binding record additionally exposes binding_epoch, defaulting old records to 1. Each successful rebind increments it. The phase record additionally exposes phase_epoch, defaulting old records to 1. Each actual coding-to-review or review-to-coding transition increments it.

A workspace stores both epochs. Therefore a coding workspace made before review cannot silently become writable after a later resume.

All mutations and approved test/check execution MUST pass through the task gate. The broker MUST repeat workspace/catalog authorization inside that same task-gated critical section immediately before a mutation/check begins; an authorization check performed only before waiting for the gate is insufficient. A repository registration/policy change, disable, rebind, finish, or review transition that wins the gate therefore makes a delayed older mutation/check fail before execution. A transition to review is acknowledged only after admitted mutations/checks have drained and the new phase epoch is durable.

Read-only repository operations remain live views of the current checkout. A review phase is a write freeze, not a cryptographically immutable candidate. Until candidate-manifest support is implemented, review responses MUST state review_assurance="phase_only" and candidate_digest=null.

## 6. Workspace selections and tokens

Supported modes:

| Mode | Capabilities | Preconditions |
| --- | --- | --- |
| inspect | read | enabled registered task |
| code | read, write, check | task in coding phase plus one operator-issued write grant |
| review | read | task in review phase |

Workspace opening is MCP-visible but may select only a previously registered repository_id and task_id. It never accepts a filesystem root, policy path, shell command, branch, or Git remote.

A coding workspace additionally consumes a short-lived single-use write_grant issued by the coordinator. The grant is authenticated and bound to the repository registration epoch, policy digest, task binding epoch, and task phase epoch, so repository disable/re-enable, policy change, rebind, or phase change invalidates older grants. Only one open, unexpired coding workspace with current authorization is allowed per task.

Selections are immutable. Switching repositories means opening a second workspace and using its token; no global current repository is changed.

Workspace tokens use an authenticated opaque format: ws1.<key-id>.<workspace-id>.<HMAC>. The HMAC covers immutable selection fields. Signing keys are owner-only operator state outside every served checkout. Current implementation uses one durable signing key; rotation is a future operator-controlled action.

Default selection TTL is eight hours, bounded to at most 24 hours. Expiration blocks new admitted work. Explicit close/revoke also blocks new admitted work.

workspace_close and coordinator revocation serialize with a per-workspace admission lock so acknowledgement occurs only after operations already admitted through that workspace have left the admission critical section.

## 7. MCP tool contract

The production service exposes twelve fixed tools.

Bootstrap tools:
- service_info {}
- repository_list {}
- workspace_open { repository_id, task_id, mode, request_id, write_grant? }
- workspace_close { workspace_token, request_id }

Repository tools:
- repo_info
- list_files
- read
- search
- git_diff { workspace_token, prefix?, base_ref?, cursor? }
- edit
- create_file
- run_tests

Every repository tool schema MUST require workspace_token.

`git_diff.base_ref` is optional. When present, the service MUST accept only a bounded,
conservative revision expression, resolve it to a commit before capture, return the
resolved `base_commit`, and bind both the requested and resolved base into continuation
authority. This permits review of committed changes from a clean checkout without making
a branch or tag movement silently change later pages.

Old unscoped production calls MUST fail closed. The service MUST NOT choose the sole registered repository, most-recent repository, active task, or another ambient default.

Bootstrap discovery returns stable repository/task identifiers and policy digests, but MUST NOT reveal arbitrary filesystem roots, policy source paths, workspace tokens belonging to other selections, or service credentials.

Successful repository responses SHOULD include a scope envelope with workspace_id, repository_id, task_id, registration_epoch, binding_epoch, phase_epoch, policy_digest, live phase, and selection mode.

## 8. Runtime ownership and concurrency

The permanent service lazily creates one shared RepoWorkspace runtime per task, not one runtime per conversation.

This preserves one long-lived checkout lock per active task, one shared inventory and capture manager per task, protected-test startup hashes, and durable mutation outcome semantics.

Concurrent open attempts for one runtime MUST coalesce to one runtime creation. Runtime create/lease/close/replacement decisions for one task MUST be serialized. A use lease increments its active count before the slot is exposed outside that serialization boundary. Closing is marked before awaiting physical runtime close, and a completed close removes the slot only if the task map still points to that exact slot.

Different checkout runtimes MAY operate independently. A busy mutation/check in repository A MUST NOT use the RepoWorkspace busy flag of repository B.

When a task is completed, repository is disabled, binding changes, root changes, or policy digest changes, an inactive stale runtime is closed and its checkout lock released. RepoWorkspace/TaskContext close operations MUST be single-flight/idempotent so a repeated close of an old runtime cannot remove a replacement checkout lock. The service process remains running.

Service-level control locks MUST NOT be held while waiting for repository operations.

## 9. Request IDs and mutation recovery

Public request_id values are selection-local.

Before invoking the existing task outcome engine, the broker derives an internal request identifier from the workspace ID and public request ID. Therefore two workspaces/tasks MAY use the same public request ID without colliding; reusing one request ID with different arguments in the same workspace is rejected; a lost mutation reply can be retried with the same workspace token, request ID, and arguments; and existing before/after hash reconciliation and create_file publication recovery remain authoritative.

Revoking or expiring a workspace does not erase durable task outcomes. Operator recovery, not blind replay under a new request ID, is required for an unresolved uncertain mutation.

## 10. Cursor and capture isolation

Existing repository cursors/captures retain their content, repository, policy, task, index, and expiry validation.

The broker additionally wraps every continuation cursor in an authenticated workspace envelope: wc1.<key-id>.<workspace-id>.<tool-kind>.<inner-cursor>.<HMAC>.

A cursor from one workspace or tool MUST be rejected by another workspace/tool before the inner cursor is used. The wrapper is not authorization by itself: every continuation still requires a current valid workspace token.

Task capture storage remains one shared manager per task runtime so two conversations cannot maintain independent in-memory reservations over the same capture directory.

## 11. Audit and secrets

Audit records MAY contain timestamp, tool name and protocol era, success/failure, workspace/repository/task IDs, binding/phase epochs, mutation path and before/after hashes, and bounded test summary fields.

Audit records MUST NOT contain workspace or write-grant tokens, token signing keys, raw source contents, arbitrary tool argument payloads, tunnel/API credentials, or raw test/subprocess output.

Policy snapshots, token keys, catalog/auth state, captures, audit files, and tunnel credentials remain outside every registered checkout and are protected paths if they could otherwise overlap a served root. This version does not claim that the installed/source runtime binaries themselves are physically outside a checkout that the operator chooses to register.

## 12. Service lifecycle

service-main.ts is a permanent broker entry point. It MUST start when the catalog is empty only for a truly unused multi-repository installation or after the explicit pre-use active-service migration rollback has removed the multi-repository initialization marker. Once catalog/auth authority has been initialized, a missing catalog MUST fail closed rather than synthesize a fresh revision/registration epoch. Retained grant/workspace/request history, the workspace token key, or the durable initialization marker is sufficient evidence that a missing catalog is not a fresh install.

Repository/task selection never changes launchd configuration and never restarts the daemon. Process health is service-level rather than repository-level.

The stable launchd definition remains repository-agnostic: it contains the installed Node/runtime path and owner state directory, not a repository, task, policy, tunnel key, or workspace token.

Coordinator service commands are service configure, service start, service status, service stop, service recover-stale-control, and legacy plist migration where required. Starting/stopping/rebuilding the service is an operator action and is not exposed through MCP.

## 13. Coordinator contract

Coordinator command groups are:
- repository add|list|enable|disable|remove
- task bind|status|phase|rebind|recover-stale|finish
- workspace grant|revoke|recover-stale
- migration active-service|rollback-active-service
- service commands from section 12.

Commands validate command-specific options and reject irrelevant known flags.

Crash-stale multi-repository lock recovery is explicit. `service recover-stale-control` may recover only the fixed `multirepo-control-v1` lock. `workspace recover-stale --workspace <ID>` may recover only that persisted workspace's admission lock. Recovery MUST verify same-host ownership, a dead owner PID, a recognized operation purpose, workspace status/capability consistency where applicable, and the exact stale lock token again before replacement. A live lock, different-host lock, unexpected-purpose lock, or lock whose token changed during recovery MUST fail closed. Recovery changes only cooperative lock state, never repository/task/workspace authorization. A stale recovery-marker record remains a manual-inspection case rather than an implicit second-level recovery.

Git commit, push, branch/worktree creation, dependency installation, unrestricted shell, and verified commit completion remain outside MCP.

task finish in v0.2 supports abandonment only. It marks catalog authority draining/completed so the permanent broker releases an inactive runtime, waits for the cooperative checkout lock to disappear, then publishes the existing terminal task completion. A stale or unreleased lock fails closed.

## 14. Migration from single-active service

Migration is explicit.

migration active-service --repository <ID>:
1. reads the exact existing active-service record;
2. verifies canonical root/root digest, policy digest, live task root/git/common/branch/HEAD, and non-completion;
3. refuses unsafe policy placement and overlapping catalog entries;
4. copies the normalized policy into owner-only content-addressed state;
5. publishes one repository registration, one task registration, and a migration marker.

It does not delete the legacy active-service record. This allows recovery inspection and narrowly bounded state rollback.

migration rollback-active-service removes only the new multi-repository catalog and initialization marker and is allowed only before any write grant, workspace selection/request, additional repository/task catalog state, or incompatible change to the legacy active-service/task binding.

It does not roll back binaries, launchd definitions, tunnel state, repository contents, or task mutation outcomes.

After migration, the production broker requires workspace_token; old unscoped production schemas are not given an ambient fallback. Clients must refresh tool schemas.

## 15. Backwards compatibility

The single-repository startServer(...) remains an explicit test/demo adapter and retains its historical eight-tool contract. It is not the production service entry point.

Legacy task binding/phase records without epochs normalize to epoch 1.

One read-only coord status compatibility alias MAY remain for one release because it does not change repository authority. Old writable single-active coordinator flows MUST NOT be the documented production workflow.

Existing path-policy formats remain accepted subject to their documented built-in denials and migration narrowing.

## 16. Security invariants

The implementation MUST maintain all of these:

1. No ambient repository authority.
2. Model-supplied roots/policy paths never enter MCP schemas.
3. Workspace tokens cannot change repository/task/mode after issuance.
4. A registration, binding, or phase epoch mismatch invalidates old selections.
5. Exactly one coding workspace may exist per task.
6. Exactly one runtime/checkout writer lock is owned per active task.
7. Different checkouts are independent.
8. Review transition drains admitted mutations/checks before acknowledgement.
9. Resume never reactivates pre-review coding authority.
10. Cursors and public request IDs cannot cross workspace authority.
11. Revocation/close/expiry never deletes uncertain mutation evidence.
12. Policy/state/token/audit material stays outside all served roots.
13. Existing symlink/hard-link/traversal/secret/VCS protections remain in force.
14. Git commit/push and arbitrary shell remain outside MCP.
15. Phase freeze is not described as content-verified candidate evidence.
16. Workspace tokens are described as bearer capabilities, not authenticated conversation identity.

## 17. Resource and retention limits

Existing policy limits continue to cap response pages, source/edit payloads, inventory size, cursor lifetime, retained capture bytes, and fixture snapshot size.

The authorization ledger is additionally bounded. Current implementation refuses new grants/selections when grants + workspaces + request records reach 4096 rather than silently evicting authority/recovery evidence.

Future production scaling MAY add global/per-checkout admission quotas, but MUST NOT evict active selections, mutation outcomes, or active capture state merely to satisfy cache pressure.

## 18. Acceptance criteria

The release gate requires deterministic tests for:
- empty-catalog startup;
- fixed twelve-tool production schema;
- required workspace_token on all eight repository tools;
- two interleaved registered repositories with identical relative paths;
- missing and forged tokens;
- expired, closed, and revoked selections;
- one coding workspace per task;
- simultaneous coding work in different registered checkouts;
- immutable selection during repository switching;
- phase freeze invalidating all old selections for that task while another repository remains usable;
- resume not reviving old coding tokens;
- workspace-bound read/search/list/diff/status cursors;
- public request-ID reuse across workspaces without collision and same-workspace argument mismatch rejection;
- constant broker PID while workspaces are opened/switched;
- safe active-service migration and pre-use rollback;
- fail-closed corrupt catalog/auth/token state;
- policy/state material excluded from served roots and release packages;
- existing path/race/request-outcome regressions.

Local typecheck/test execution is a separate validation step. Source implementation alone is not evidence that these acceptance criteria passed.

## 19. Client limitations

The current product contract does not promise cryptographically non-transferable ChatGPT conversation identity. A bearer token copied to another authorized caller remains a bearer token.

The server therefore does not infer repository from conversation metadata, infer repository from MCP transport/session IDs, silently choose a sole/default repository, rely on a conversation-close event for revocation, or claim reviewer identity cryptographically differs from coder identity.

If a future client supplies authenticated, mandatory, stable conversation identity through the complete tunnel path, it may be bound as an additional restriction. It must not replace explicit workspace authority without a separately reviewed protocol change.
