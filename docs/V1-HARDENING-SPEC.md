# Repo MCP v1 Hardening and Release Specification

Status: forward hardening specification for the eventual v1.0 scope, 2026-10-02.

**v0.2 lifecycle note (2026-10-05):** [MULTI-REPO-SPEC.md](MULTI-REPO-SPEC.md) is normative for the production multi-repository broker, explicit workspace tokens, registry/task catalog, and no-restart repository selection. Any single-active-service or sequential-repository requirement below describes the older v0.1 baseline/roadmap and is superseded for v0.2 where it conflicts. The candidate-manifest, verified commit, and other stronger future-hardening requirements below remain future work unless separately implemented.

Repo MCP v0.1.0 was intentionally narrower: trusted single-user macOS operation,
repository/task switching, bounded policy-controlled tools, durable tunnel state and
coordinator-run local validation. The acceptance criteria in sections 23-26 are the
roadmap gate for a future v1.0 release; they are not claims made by v0.2.x. Current
public support and behavior are stated in README.md, SETUP.md, SECURITY.md and MULTI-REPO-SPEC.md.

This document is normative for the future v1.0 hardening work described here. “MUST”, “MUST NOT”, “SHOULD”, and “MAY” are used in their usual requirements sense. Requirement IDs are stable and should be referenced from implementation PRs and tests.

## 1. Baseline and evidence status

The target is the current accepted eight-tool Repo MCP design, not a revival of the deferred milestone 3 work.

Coordinator-provided evidence for the source at the time this specification was requested is **217 passing tests and `tsc --noEmit` clean**. That is supplied evidence, not a test result produced while writing this document. Some existing planning prose still contains the older 216-test count; v1 release work must reconcile stale status prose before publication instead of treating a hard-coded historical count as a release gate.

The current source establishes these useful foundations:

- task-mode binding to canonical checkout identity, branch/HEAD and policy digest;
- a durable operator-owned state directory outside served repositories;
- cooperative per-checkout ownership and a task mutation/phase gate;
- explicit `coding` and read-only `review` phases;
- request-ID mutation reconciliation and crash-aware `create_file` recovery;
- ordinary checkout and linked-worktree support;
- bounded/paged read, search, discovery, status and diff behavior;
- a loopback-only MCP server, separate private tunnel process, stored runtime credential, and tunnel freshness check;
- coordinator-only `status`, `phase`, and `rebind` primitives;
- deterministic allowlisted source packaging that excludes runtime state by construction.

The main v1 operational gap is not semantic coding capability. It is repeatable control of the already-working pieces: selecting a repository/task, reliably reloading the launchd server with that selection, proving all three connection layers, freezing an exact candidate, recovering after ordinary failures, and packaging/documenting the result for a second user.

The current launchd server installer hard-codes repository/policy environment variables into a single `local.repo-mcp.server` plist, is not task-mode aware, and refuses an existing service file. The current task CLI already supplies durable status/phase/rebind. V1 therefore hardens the **coordinator control plane and service lifecycle**, rather than adding broader MCP privileges.

## 2. Product goal

**PROD-001 — Goal.** V1 MUST let a trusted single user repeatedly use ordinary ChatGPT to inspect and modify an explicitly selected local checkout through Repo MCP, obtain a separate ChatGPT semantic review of the frozen candidate, and let a local coordinator run real project checks and authorized Git operations without manual launchd/plist surgery between tasks.

**PROD-002 — Default workflow.** The default MUST be one existing checkout, one active Repo MCP server, one stable private tunnel, one coding conversation, one later independent review conversation, and sequential execution.

**PROD-003 — Operator ownership.** Repository selection, policy selection, task ID, real local check commands, Git operations, and any branch/worktree creation remain operator/coordinator decisions. Chat-facing tools MUST NOT select arbitrary roots, widen policy, commit, push, install dependencies, or switch branches.

**PROD-004 — Server ownership.** The running MCP server, not the coordinator CLI, MUST retain the durable checkout-writer lock while a task is active. Every coordinator Git mutation that can change the selected checkout, its index, refs, shared Git metadata, or an authorized remote MUST run under the existing short cooperative lock keyed by the canonical common Git directory; task state transitions use the task mutation gate where specified. These coordinator locks MUST NOT replace server-side checkout ownership.

**PROD-005 — Dependability over autonomy.** V1 prioritizes deterministic restart/rebind/freeze/recovery and explicit evidence over background autonomy or broader tool power.

**PROD-006 — Public usability.** A second user on a supported clean machine MUST be able to install from the public source release, create their own tunnel credential, bind their own checkout/policy, and complete the documented connection verification without author-specific paths or private `evidence/` files.

## 3. Supported workflow

The supported v1 lifecycle is:

1. **Bind** an operator-selected existing checkout, task ID, and policy.
2. **Start** or reload the single launchd-backed server for that binding.
3. **Verify health** locally, at the tunnel, and from the actual ChatGPT conversation.
4. **Code** in a ChatGPT conversation through MCP; the coordinator executes prescribed real-project tests locally.
5. **Freeze** by draining in-flight mutations, entering `review`, and capturing a candidate manifest.
6. **Review** in a separate ChatGPT conversation through the same MCP route, read-only.
7. If repair is required, **resume** coding, which invalidates the previous frozen candidate/review evidence, then freeze and review again.
8. After explicit authorization, the coordinator verifies commit evidence and performs Git commit/push outside MCP.
9. **Finish** by recording the outcome and unloading the task server. The tunnel and durable credential may remain for the next task.

**WF-001.** V1 MUST support an existing ordinary checkout and an existing linked worktree.

**WF-002.** Creating a clone, branch, or worktree automatically is outside v1. Operators may create/select them separately.

**WF-003.** One active writable task per checkout remains the rule. Parallel scheduling is outside v1.

**WF-004.** A different repository or checkout requires finishing/unloading the current active server and a new bind. `rebind` MUST NOT silently change the canonical checkout root/git-dir/common-dir.

**WF-005.** A branch/HEAD or approved policy change within the same checkout is handled by explicit `rebind`, never by implicit acceptance.

**WF-006.** Every task has an explicit, persisted authoritative set of exact repository-relative **task-owned path claims**. Policy writability is only a permission ceiling; it never establishes ownership.

**WF-007.** In task mode, `edit` and `create_file` MUST require both policy permission and an active task-owned path claim. A writable-but-unclaimed path is denied.

**WF-008.** External changes to unclaimed paths remain external/unowned regardless of whether those paths were clean at bind time. They are not silently absorbed into the candidate. Unowned staged entries block commit; unowned unstaged changes are reported as context but do not become task-owned evidence.

## 4. Trust model

V1 is for a trusted single-user local machine and trusted project code.

**TRUST-001.** Local users, unrelated local processes, editors, Git hooks, and test code are not contained by a hostile-code security boundary. The system detects many forms of drift; it does not claim to prevent an uncooperative writer from racing it.

**TRUST-002.** The loopback MCP HTTP listener has no separate authentication and MUST remain bound to loopback. Remote access MUST use the private authenticated tunnel.

**TRUST-003.** Operator policy, audit files, task state, service-control state, credentials, and tunnel health files MUST remain outside model-writable repository scope and MUST be treated as server/operator-owned paths.

**TRUST-004.** Policy v2 built-in secret and VCS-metadata denials remain non-liftable. V1 MUST NOT weaken current path containment, no-symlink/hardlink checks, hash preconditions, creation no-overwrite behavior, request-ID reconciliation, or review-phase mutation denial.

**TRUST-005.** The independent review is procedural independence: it is a separate ChatGPT conversation operating after a global review freeze. The server does not cryptographically authenticate “coder” versus “reviewer”.

**TRUST-006.** Real-project tests executed by Codex/coordinator remain trusted local execution outside MCP. V1 MUST NOT describe those checks as sandboxed merely because the fixture runners have restricted behavior.

## 5. Explicit non-goals

The following remain deferred unless a later design separately justifies them. They are not v1 blockers:

- asynchronous real-project MCP check jobs, job polling, retained job logs, or cancellation tools;
- MCP commit or push;
- automatic worktree/branch creation or cleanup;
- parallel task scheduling/orchestration;
- arbitrary shell exposed to ChatGPT;
- browser automation or automatic conversation submission/recovery;
- hostile-code sandbox guarantees;
- automatic dependency installation or environment migration;
- automatic stash/reset/clean/rebase/merge;
- universal Windows/Linux support;
- a claim that “milestone 3” is required before release.

**NG-001.** Existing checkout plus sequential work is the v1 default.

**NG-002.** Worktrees remain an operator choice, not a coordinator-created prerequisite.

## 6. Billing and usage statement

The public documentation MUST use this precise distinction:

> The Repo MCP server itself makes no model inference API call, so it creates no OpenAI API inference charge itself. Model inference for this workflow occurs in ChatGPT and is governed by the user’s ChatGPT plan and its applicable limits. The secure tunnel is a separate service path and its availability, limits, and service terms still apply. Repo MCP does not promise unlimited usage or that ChatGPT/tunnel usage is free.

**BILL-001.** No documentation may collapse “no inference API call by this server” into “free”, “unlimited”, or “no OpenAI usage”.

**BILL-002.** Tunnel credentials MUST be described as transport/control-plane credentials, not as evidence that the MCP server is purchasing model inference.

## 7. Responsibility boundary

| Actor | V1 responsibility |
| --- | --- |
| User/operator | Chooses task/repository, explicitly claims task-owned paths, approves scope, supplies policy, and authorizes external Git actions |
| Codex/coordinator | Bind/start/status/claim/freeze/resume/rebind/finish, local real-project tests, mechanical evidence capture, common-directory Git locking, verified staging/commit, and authorized push |
| ChatGPT coding conversation | Reads repository through MCP, writes only claimed/scoped regressions/code, supplies required request IDs, and inspects the complete MCP diff |
| Separate ChatGPT review conversation | Read-only semantic review of the exact frozen candidate after comparing coordinator/server candidate digests |
| Repo MCP server | Scoped repository access, server-side checkout ownership, task-owned-claim enforcement, task phase enforcement, durable mutation outcomes, and process-verified frozen-candidate status |
| Tunnel client | Private transport between ChatGPT and loopback MCP |
| GitHub connector, if used | Remote issues/PR/committed revision context only according to actual capabilities |

**ROLE-001.** Codex/coordinator MUST NOT manufacture semantic review evidence on behalf of the separate ChatGPT reviewer.

**ROLE-002.** ChatGPT MUST NOT invent results for tests that were run only by the coordinator.

**ROLE-003.** GitHub/remote source MUST NOT be treated as proof of current uncommitted local contents.

**GIT-001.** Every coordinator Git mutation MUST acquire the existing short cooperative lock keyed by canonical `common_dir`. This includes staging, commit/ref updates, coordinator branch/worktree mutations if separately authorized, and any coordinator push path that updates local/shared Git metadata or an authorized remote. Read-only Git inspection does not require this lock.

**GIT-002.** The final staging/equality/commit sequence in section 14.6 MUST execute in one common-directory-lock critical section. The lock is released only after the commit result and post-commit tree verification are known.

**GIT-003.** The common-directory lock is cooperative and does not block unrelated shells/editors. Therefore content/index identity checks remain mandatory before and after coordinator Git operations.

## 8. Coordinator CLI

### 8.1 Canonical entry point

V1 adds one source-install coordinator entry point:

```sh
npm run coord -- <command> [options]
```

The implementation SHOULD be `scripts/coordinator.ts` plus testable modules under `src/`. A future installed binary alias is allowed, but the source release documentation uses the command above.

Required lifecycle commands:

- `bind`
- `start`
- `status`
- `freeze`
- `resume`
- `rebind`
- `finish`

Required ownership auxiliary:

- `claim --add|--remove`

The existing `npm run task -- status|phase|rebind` interface remains supported for one release as a lower-level compatibility/recovery surface.

### 8.2 Bind, ownership claims, and coherent baseline capture

Example:

```sh
npm run coord -- bind \
  --task agent-sessions-20261002 \
  --repo /path/to/existing-checkout \
  --policy /path/to/policy.json \
  --owned AgentSessions/Services/PresenceEngine.swift \
  --owned AgentSessionsTests/HeadlessAgentPresenceTests.swift
```

**COORD-001.** `bind` MUST canonicalize and validate the checkout using the same repository identity rules as the server: Git root must equal the selected root, bare repositories are rejected, and detached HEAD requires explicit `--allow-detached`.

**COORD-002.** `bind` MUST load/compile the operator-supplied policy and record its digest, but MUST NOT modify, synthesize, widen, or copy the policy into the served repository.

**COORD-003.** `bind` MUST create/update only coordinator state outside the served checkout. It MUST NOT acquire the long-lived server checkout lock and MUST NOT modify repository contents.

**COORD-004.** If a different task/server is currently active, `bind` MUST fail with an actionable message requiring `finish`; it MUST NOT silently retarget a live launchd service.

**COORD-005.** `bind` is idempotent only for an **active, not-completed** task whose canonical root, policy digest, detached-head setting, and authoritative claim set are identical. If `completion.json` exists for that task ID, bind MUST reject reuse even when every argument matches.

**COORD-006.** `bind` MUST publish a baseline record only after the coherent-generation capture rules below succeed. A path already modified before it is explicitly claimed is not automatically task-owned.

**OWN-001.** The authoritative claim set consists only of exact normalized repository-relative paths explicitly supplied by the operator/coordinator. Globs are not ownership claims.

**OWN-002.** Every claimed existing path MUST be permitted by current policy write scope. A claimed missing path MUST be permitted by current policy creation scope. Built-in denials still win.

**OWN-003.** The server MUST enforce the persisted claim set on task-mode `edit` and `create_file` after normal path/policy validation. Policy-writable but unclaimed paths MUST fail with a distinct “not task-owned” error.

**OWN-004.** Claim ownership MUST NOT be inferred from policy writability, test configuration, a clean bind-time file, a mutation outcome, or a ChatGPT prompt. Only explicit claim state is authoritative.

**OWN-005.** `claim --add PATH` is allowed only for the active task while it is not completed and is in `coding` (or bound but not yet started). It MUST drain/serialize against the task mutation gate when the server is running, validate policy permission, coherently capture the path’s current claim baseline, increment the claim-set version/digest, and invalidate any frozen candidate.

**OWN-006.** Adding a claim explicitly accepts the path’s **current** state as that claim’s baseline. A missing creatable path has an explicit absent baseline. This explicit operator action is the only way an already-modified formerly-unowned path can become task-owned.

**OWN-007.** `claim --remove PATH` is allowed only outside review and only when the path still equals its recorded claim baseline and has no task mutation outcome or task-owned delta. Otherwise removal MUST fail and require operator reconciliation; v1 does not silently abandon changed owned work.

**OWN-008.** External changes to unclaimed paths remain unowned. They MAY appear in status/unowned-context metadata, but MUST NOT enter the owned candidate path array or become eligible for staging. Any unowned staged entry blocks the commit gate.

**OWN-009.** `claim_set_digest` is lowercase SHA-256 over the UTF-8 bytes of the no-whitespace JSON string `{"schema_version":1,"paths":[...]}`, where `paths` contains the exact claimed path strings sorted by raw UTF-8 byte order. No timestamps participate.

**BASE-001.** Bind-time baseline capture MUST represent one coherent repository generation. Before capture, record canonical root identity, branch/HEAD, the full semantic index signature defined in section 14.2.2, claim-set digest, and `status_digest`, where `status_digest` is lowercase SHA-256 of the exact bytes from one complete `git status --porcelain=v2 -z --untracked-files=all` capture. Capture every initially claimed path’s presence, mode, and SHA-256 plus the status bytes needed for baseline metadata. Then recompute root/branch/HEAD, the same full semantic index signature, claim-set digest, a fresh complete `status_digest`, and claimed-path fingerprints.

**BASE-002.** A baseline attempt succeeds only when every pre/post invariant in `BASE-001` matches. No partially captured baseline is published.

**BASE-003.** Baseline capture MUST retry from scratch at most three times under one monotonic 10-second default coordinator budget. Persistent drift fails `bind` explicitly; no active-service generation may be published for that failed bind.

**BASE-004.** Claim additions use the same pre/post identity/index/path recheck discipline for the newly claimed baseline and retry at most three times. Persistent drift fails the claim update without changing the authoritative claim set.

**BASE-005.** Regression coverage MUST force a repository/index/path change between baseline capture and its post-capture recheck and prove that no mixed-generation baseline is accepted.

### 8.3 Start

Example:

```sh
npm run coord -- start
```

**COORD-007.** `start` MUST ensure the stable server launchd service is loaded and force a fresh server process to read the current active-service generation. A successful command MUST NOT mean “an old process is still serving a previous repository”.

**COORD-008.** On first start of an active task, the server remains responsible for creating/acquiring the durable task binding and checkout lock. If `completion.json` exists for the task ID, server startup and coordinator start MUST reject the task as completed.

**COORD-009.** `start` MUST wait for local MCP health and compare the **process-originated attestation** in section 10.3 to desired generation/task/root/server version. It MUST NOT report success when a surviving old process answers health.

**COORD-010.** If an existing task binding disagrees with current branch/HEAD/policy/claim-set expectations, `start` MUST fail closed and direct the operator to reconcile/rebind/claim as appropriate. It MUST NOT auto-accept drift.

**COORD-011.** Stale-lock recovery is never implicit. `start --recover-stale` MAY perform the explicit recovery flow in section 11 only after validating the stale owner and same active task/checkout. Completed task IDs are never recovered for reuse.

### 8.4 Status

Examples:

```sh
npm run coord -- status
npm run coord -- status --json
```

**COORD-012.** `status` MUST be read-only and report at least: active task ID; completion state; configured root/root digest; current root identity; configured/bound/current HEAD and branch; task phase; policy path/digest; claim-set digest/count; desired service generation; process-attested generation/task/root digest/server version; launchd state; local MCP health; tunnel health/freshness; frozen `candidate_digest` and `candidate_state`; unowned staged blockers; and whether an actual ChatGPT route probe is still required.

**COORD-013.** Text status MUST use distinct labels for `ready`, `degraded`, `stale`, `blocked`, and `unverified`. A green process plus mismatched generation, stale tunnel poll, or unverified ChatGPT route MUST NOT be summarized as “connected”.

**COORD-014.** `--json` output is a stable machine-readable v1 contract. Additive fields are allowed in v1; removal/renaming requires a version bump.

### 8.5 Freeze

Example:

```sh
npm run coord -- freeze
```

**COORD-015.** `freeze` MUST use the existing task mutation gate to wait for in-flight mutations, durably set phase to `review`, then capture the candidate manifest described in section 14.

**COORD-016.** `freeze` MUST return success only after review phase and a coherent candidate manifest are durable and the stored `candidate_digest` has been recomputed from its normative preimage.

**COORD-017.** Candidate capture uses the same three-attempt/pre-post-recheck principle as the baseline: HEAD, branch, policy digest, claim-set digest, the full semantic index signature defined in section 14.2.2, and every claimed path’s presence/mode/SHA-256 MUST match before and after capture. Persistent drift leaves the task in `review`, publishes no candidate manifest, and therefore `repo_info` reports `candidate_state=missing` until a coherent freeze succeeds.

**COORD-018.** After freeze, MCP edit/create mutations and claim changes remain denied. Review `repo_info` and `git_diff` apply the process-side candidate verification in section 13; a stored manifest alone is not sufficient.

### 8.6 Resume

Example:

```sh
npm run coord -- resume
```

**COORD-019.** `resume` MUST reject a completed task ID. Otherwise it durably returns the active task to `coding`.

**COORD-020.** `resume` MUST invalidate the current frozen candidate and any review-ready/commit-ready status. Historical candidate/review records MAY be retained as superseded evidence but MUST NOT be treated as current.

### 8.7 Rebind

Examples:

```sh
npm run coord -- rebind
npm run coord -- rebind --policy /path/to/new-policy.json
```

**COORD-021.** `rebind` MUST reject a completed task ID and accepts only the same canonical root, git-dir, and common-dir already associated with the active task. A different checkout requires a new task ID and finish/bind.

**COORD-022.** `rebind` MUST explicitly accept the checkout’s current branch/HEAD and, when supplied, the new validated policy digest. It MUST NOT change authoritative path claims implicitly.

**COORD-023.** Rebinding to a changed policy MUST restart the server before reporting success because the running server intentionally rejects tools after policy-digest drift until it has loaded the new policy.

**COORD-024.** V1 SHOULD restart the server after every successful rebind, including HEAD-only rebinds, and MUST verify the new process attestation before success.

**COORD-025.** Rebind invalidates frozen candidate/review evidence whose HEAD, policy digest, claim-set digest, index identity, or owned-path identities no longer match.

### 8.8 Finish and one-shot task IDs

Examples:

```sh
npm run coord -- finish --commit <commit-sha>
npm run coord -- finish --abandon
```

**COORD-026.** `finish` MUST stop/unload the server launchd service and verify the checkout writer lock is no longer live before publishing final completion.

**COORD-027.** After service shutdown/reconciliation, `finish` atomically creates `completion.json` as a one-shot terminal marker. It preserves task binding, claims, mutation outcomes, baseline/candidate/review metadata, and credentials unless cleanup is separately requested.

**COORD-028.** The private tunnel MAY remain running across tasks; it is not repository-specific.

**COORD-029.** `finish --commit SHA` records the commit only after the coordinator has completed the section 14.6 machine gate and post-commit verification for the reviewed candidate. `finish` does not itself invent or repair a commit.

**COORD-030.** `finish --abandon` records abandonment without cleaning/resetting the checkout.

**LIFE-001.** Once a valid `completion.json` exists, that task ID is permanently completed for v1. `bind`, `start`, `resume`, `rebind`, claim mutation, and server task opening MUST reject reuse.

**LIFE-002.** A later run against the same checkout or same logical issue requires a new task ID. No “reopen completed task” command exists in v1.

**LIFE-003.** Re-running `finish` MAY be idempotent only to complete service-cleanup/reporting for the same already-recorded outcome; it MUST NOT make the task writable again.

## 9. Coordinator state machine

The coordinator lifecycle is:

```text
UNBOUND
  -> BOUND
  -> RUNNING_CODING
  -> FROZEN_REVIEW
  -> RUNNING_CODING        (resume/repair; prior candidate superseded)
  -> FROZEN_REVIEW         (new candidate)
  -> COMMIT_PREP           (after completed review + authorization)
  -> COMPLETED
```

The underlying server task phase remains only `coding | review`; `COMMIT_PREP` is a coordinator-only transient state and does not add an MCP mutation phase.

**STATE-001.** `BOUND` means active coordinator configuration/baseline/claims exist; it does not claim the server owns the checkout yet.

**STATE-002.** `RUNNING_CODING` requires a live server holding the checkout lock, matching process attestation, no completion marker, and task phase `coding`.

**STATE-003.** `FROZEN_REVIEW` requires task phase `review`, a stored candidate manifest, and process-side `candidate_state=current` before review evidence is accepted.

**STATE-004.** Arbitrary edits, creates, claim updates, rebinds, HEAD changes, policy changes, index changes, or claimed-path content/mode changes after freeze make the live candidate non-current. The server MUST expose this as stale/invalid and review `git_diff` MUST refuse it.

**STATE-005.** `COMMIT_PREP` may begin only after a separate reviewer has accepted the same candidate digest and the coordinator verifies the candidate is still current. The controlled staging operation then intentionally changes the index; from that point the server may report the frozen candidate stale due to index mismatch and no further review evidence may be collected. Commit may continue only through the exact staged-tree equality gate in section 14.6. Any mismatch aborts and requires reconciliation/refreeze.

**STATE-006.** A successful commit changes HEAD and makes the running server’s old task binding stale by design. The task is then finished/completed; no later mutation under that task ID is permitted.

**STATE-007.** `COMPLETED` is terminal and one-shot. Only read-only status/history and idempotent finish cleanup are allowed.

## 10. Stable launchd service and repository switching

### 10.1 Design

V1 keeps one launchd server label: `local.repo-mcp.server`. The plist becomes stable and repository-agnostic. It launches a small server-service entry point that reads one operator-owned **active service record** on every process start.

This replaces repository/policy-specific environment variables embedded in the plist as the normal v1 path.

Recommended implementation:

- add `src/service-main.ts` (compiled with the server) that loads the active service record, validates completion/binding/policy/claims, and calls `startServer`;
- update `scripts/install-server-service.py` to install/refresh the stable service definition rather than encode one repository task;
- have `scripts/coordinator.ts` write the active service record and control `launchctl` through fixed argv, never a shell string.

**OPS-001.** The active service record MUST live in the operator state directory, outside every served repository, mode 0600 inside a mode-0700 directory.

**OPS-002.** The stable launchd plist MUST contain no tunnel credential, repository secret, or task-specific repository/policy path.

**OPS-003.** Switching repositories is `finish` old task -> `bind` new task ID -> `start`; no manual plist editing/deletion is required.

**OPS-004.** `start`/rebind reload MUST use `launchctl kickstart -k` when the expected service is already loaded and `bootstrap` when unloaded. If the installed plist itself changed during upgrade, the coordinator MUST use explicit bootout/bootstrap replacement and verify the installed definition before continuing.

**OPS-005.** The coordinator MUST detect an unexpected pre-existing plist/service it did not install, or whose ProgramArguments do not match the recorded/current Repo MCP install definition, and fail instead of overwriting it silently.

**OPS-006.** One configured loopback port is active at a time. Port collision is a hard failure; v1 MUST NOT auto-select a different/public listening interface.

### 10.2 Active service record

Use the existing versioned `StateStore` envelope. Suggested record:

```json
{
  "version": 1,
  "kind": "active-service",
  "data": {
    "task_id": "repo-mcp-v1-spec-20261002",
    "root": "/path/to/canonical-root",
    "root_digest": "<sha256>",
    "policy_path": "/path/to/policy.json",
    "policy_digest": "<sha256>",
    "claim_set_digest": "<sha256>",
    "state_dir": "/path/to/operator-state",
    "audit_path": "/path/to/private-audit.jsonl",
    "port": 8787,
    "allow_detached": false,
    "generation": 12,
    "expected_server_version": "<semver>",
    "configured_at": "2026-10-02T22:00:00.000Z"
  }
}
```

**DATA-001.** The service entry point MUST re-read this record at every process start and fail closed on corrupt/unknown versions, completed task ID, invalid root, changed policy/claim digest, or state-directory overlap with the repository.

**DATA-002.** `generation` MUST monotonically increase whenever desired service configuration changes and MUST be independently attested by the loaded process.

### 10.3 Process-originated generation attestation

The loopback `GET /` health response is extended to contain values produced from the configuration actually loaded by that server process:

```json
{
  "ok": true,
  "name": "repo-mcp",
  "server_version": "<canonical release version>",
  "service_generation": 12,
  "task_id": "repo-mcp-v1-spec-20261002",
  "root_digest": "<sha256>"
}
```

`root_digest` is lowercase SHA-256 of the UTF-8 bytes of the canonical checkout root string, with no trailing newline. Manual/untracked startup MAY report null task/generation values, but the public coordinator path requires non-null matching values.

**ATTEST-001.** Attestation values MUST originate inside the running process after it loads and validates the active-service record; coordinator status MUST NOT simply echo desired state as process state.

**ATTEST-002.** `start` and `status` MUST compare desired generation, task ID, root digest, and expected server version to the process response. Any mismatch is `wrong_generation`, `wrong_task`, `wrong_root`, or `wrong_version`, not ready.

**ATTEST-003.** A surviving old process answering the port with a prior generation MUST make start/status fail even if HTTP `ok=true`.

**ATTEST-004.** Regression tests MUST simulate an old surviving process after a requested reload and prove that its old generation cannot satisfy start success.

### 10.4 One-time migration of the legacy server service and pre-hardening task bindings

V1 MUST provide an explicit one-time migration for the currently documented repository-specific `local.repo-mcp.server` launchd service and, separately, for an existing pre-hardening durable task binding. Migration is never implicit during ordinary `start`.

Recommended coordinator surface:

```sh
npm run coord -- migrate-legacy \
  --task EXISTING_TASK_ID \
  --owned src/file-one.ts \
  --owned test/file-one.test.ts
```

If safe adoption of `EXISTING_TASK_ID` cannot satisfy the rules below, the command MUST refuse adoption and instruct the operator to bind a **new task ID**. It MUST NOT synthesize ownership.

#### 10.4.1 Exact recognition of the current legacy server plist

**SERVERMIG-001.** A legacy plist is recognized only when its parsed property-list key/value structure matches the exact template produced by the inspected pre-hardening `scripts/install-server-service.py`. Let `BASE` be the canonical project base from `Path(__file__).resolve().parents[1]`, `NODE` be the exact absolute path string returned by the migration environment's `shutil.which("node")`, `REPO` and `POLICY` be the canonical `Path(...).resolve(strict=True)` strings corresponding to the plist's existing `REPO_ROOT` and `REPO_MCP_POLICY`, and `PORT` its decimal-string port. The recognized plist MUST have exactly:

- `Label = "local.repo-mcp.server"`;
- `ProgramArguments = [NODE, BASE + "/dist/src/main.js"]` with no additional arguments;
- `WorkingDirectory = BASE`;
- `EnvironmentVariables` with exactly four keys: `REPO_ROOT=REPO`, `REPO_MCP_POLICY=POLICY`, `REPO_MCP_AUDIT=BASE + "/.trial/service-audit.jsonl"`, and `PORT=PORT`;
- `RunAtLoad = true`, `KeepAlive = true`, `ThrottleInterval = 10`;
- `StandardOutPath = BASE + "/.trial/service-stdout.log"`;
- `StandardErrorPath = BASE + "/.trial/service-stderr.log"`;
- no additional top-level launchd keys.

`NODE` MUST be an absolute executable path and must equal the current `shutil.which("node")` result byte-for-byte; if PATH/Node installation moved, migration safely refuses rather than guessing the old executable. `BASE/dist/src/main.js`, `REPO`, and `POLICY` MUST exist at recognition time. This intentionally prefers a safe false-negative over adopting a modified service.

**SERVERMIG-002.** Any difference from `SERVERMIG-001`—including an added ProgramArgument/environment key, different executable, different log/audit path, changed KeepAlive/RunAtLoad behavior, or a foreign plist under the same label—MUST be treated as modified/foreign. Migration MUST leave it unchanged and stop with manual recovery/new-install instructions.

#### 10.4.2 Service migration transaction

**SERVERMIG-003.** Before changing a recognized legacy service, migration MUST stop new coordinator work, verify the loopback process corresponds to the recognized service when one is running, then `bootout` that service and verify no process still owns the configured server port.

**SERVERMIG-004.** Migration MUST copy the recognized plist bytes into the user-local Application Support migration area as an owner-only backup, record its SHA-256 plus original path in durable `control/install.json`, and fsync/publish that prepared install record before replacing the installed plist.

**SERVERMIG-005.** Migration then installs the stable repository-agnostic server plist described in section 10 and preserves the legacy backup until the stable service is proven. When a safe adopted/new task already exists, migration MAY publish the corresponding task-bound active-service record/generation and record `migration_state:"prepared"` before bootstrap. The `prepared_unbound` path in `TASKMIG-008` is an explicit exception: with no safely adopted/new task, migration MUST NOT publish or advance any task-bound active-service generation/record merely to verify installation; it records `migration_state:"prepared_unbound"`, leaves the stable service unloaded/unverified, and waits for a later safe task bind/adoption to publish the first task-bound generation.

**SERVERMIG-006.** Bootstrap success alone is insufficient. Migration completes only after loopback process attestation exactly matches the newly desired `service_generation`, task ID when adopting one, root digest, and canonical server version. Only then may `control/install.json` become `migration_state:"verified"`. On any prior failure, preserve the backup and prepared record, do not claim migration success, and do not delete/overwrite foreign state.

#### 10.4.3 Safe adoption of a pre-hardening task binding

A legacy service plist contains no task ID; task adoption is therefore a separate explicit decision.

**TASKMIG-001.** Task adoption may run only while the server service is stopped and there is no live checkout-writer lock for the binding. A stale lock must first go through the explicit recovery rules in section 11; migration MUST NOT erase it implicitly.

**TASKMIG-002.** Load the existing pre-hardening binding and resolve the live checkout named by that binding. Adoption requires exact equality of canonical `root`, `git_dir`, `common_dir`, attached branch name or detached-null state, and HEAD object ID. The supplied/current policy MUST load successfully and its existing server `policy_digest` MUST exactly equal the old binding's policy digest. Detached state must still satisfy the old binding's detached-head approval.

**TASKMIG-003.** If any `TASKMIG-002` invariant differs, or the task has a completion marker, migration MUST NOT rewrite/rebind the old task. The operator must use a new task ID after reconciling the checkout.

**TASKMIG-004.** Authoritative claims for an adopted task may be created **only** from explicit operator `--owned PATH` arguments supplied to the migration command. They MUST pass `OWN-001..009`. Migration MUST NOT infer claims from the old policy's writable paths, current Git changes, “clean at bind”, configured tests, or historical prompt text.

**TASKMIG-005.** Every path referenced by an existing non-failed mutation outcome for the old task MUST be present in the explicit `--owned` set; otherwise adoption fails and requires either corrected explicit input or a new task ID. This preserves request-outcome meaning without inferring additional ownership.

**TASKMIG-006.** After claim validation, migration MUST coherently capture the new baseline using `BASE-001..005`. The old task binding remains unchanged until the claims and baseline are durably published. No mixed-generation adoption is allowed.

**TASKMIG-007.** Existing old review evidence is not portable because it predates the candidate-digest contract. Adoption invalidates any pre-hardening review/candidate readiness. If the persisted phase is `review`, the adopted task remains read-only with `candidate_state=missing`; the operator must explicitly `resume` and later perform a new freeze/review before commit.

**TASKMIG-008.** The stable service may bootstrap for migration verification only after there is a safe active task: either `TASKMIG-001..007` adopted the old task, or the operator explicitly bound a new task ID under the normal bind/claim/baseline rules. If old-task adoption is refused and no new task is bound yet, migration MAY install the stable plist and preserve the legacy backup as `migration_state:"prepared_unbound"`, but it MUST remain unloaded and MUST NOT report migration verified. Verification completes only after a later new-task bind/start yields matching process-generation/task/root/version attestation.

## 11. Crash, stale-lock, sleep, and network recovery

### 11.1 launchd crash/restart

A normal graceful stop releases the server checkout lock. A SIGKILL/crash can leave a lock record whose PID is dead. Current state logic deliberately reports this as stale and requires explicit recovery.

**REC-001.** launchd KeepAlive MAY attempt restart after a crash, but a stale lock MUST block ownership until explicit recovery; repeated launchd attempts MUST NOT silently delete state.

**REC-002.** `coord status` MUST surface the stale lock owner PID, purpose, acquisition time, task, and checkout without exposing secrets.

**REC-003.** `coord start --recover-stale` MUST:
1. verify the lock belongs to the same host, active non-completed task binding and canonical checkout;
2. verify the owner PID is dead;
3. use the existing serialized stale-lock recovery primitive (or narrowly factored equivalent);
4. recover the stale task mutation gate if present under the same explicit action;
5. release the temporary recovery claim and start the server normally.

It MUST NOT recover a lock whose owner appears live, whose record is corrupt, whose hostname differs, whose binding does not match, or whose task is completed.

**REC-004.** A stale recovery marker remains a manual-inspection failure, matching current fail-closed behavior.

### 11.2 Lost mutation response

**REC-005.** Task-mode `edit` and `create_file` MUST require a valid `request_id` in the server tool schema. Missing IDs are rejected before mutation.

**REC-006.** A retry after a transport interruption MUST reuse the identical request ID and identical arguments. A different logical mutation uses a new ID.

**REC-007.** `already_applied` means the recorded resulting contents are already present. It is not proof that the retrying call performed the write.

**REC-008.** Conflict/uncertain outcomes remain hard stops requiring a new read/operator inspection; the coordinator MUST NOT auto-replay them.

### 11.3 Sleep and network interruption

**REC-009.** Public docs MUST state that launchd does not keep the Mac awake and no work can be served while the machine is sleeping/offline.

**REC-010.** After wake/network return, status MUST evaluate local server/process attestation and tunnel freshness independently. A healthy local server with stale/missing tunnel poll remains degraded.

**REC-011.** Ordinary reconnection MUST reuse the existing tunnel ID and saved runtime key. It MUST NOT rotate credentials merely because the network dropped.

**REC-012.** After a tunnel restart, extended outage, server reload, repository rebind, or tool-schema upgrade, the actual ChatGPT conversation MUST perform a fresh `repo_info` route proof before the next mutation or semantic review.

**REC-013.** V1 MUST NOT automatically resubmit a coding/review browser request after a timeout. Resume/retry happens in the existing conversation under user/coordinator control.

## 12. Credentials and tunnel durability

The stored-key design is retained, but v1 makes user-local Application Support the canonical location so credentials and tunnel runtime state survive source upgrades/re-clones and cannot be packaged accidentally.

Recommended macOS root:

```text
~/Library/Application Support/repo-mcp/
  state/
  credentials/
    runtime.key
    tunnel-id
  tunnel/
    install.json
    health.url
    stdout.log
    stderr.log
```

**CRED-001.** Runtime key files MUST be regular owner-only files (0600); their parent directories MUST be 0700.

**CRED-002.** The key MUST be passed to the official tunnel client by file reference, never as a command-line literal or MCP response.

**CRED-003.** Rotation MUST write a new key to an owner-only temporary file, fsync/close it, atomically rename it over the credential, restart the tunnel process, verify a recent successful control-plane poll, and then require ChatGPT `repo_info` for end-to-end proof.

**CRED-004.** Rotation MUST reuse the same tunnel ID unless the operator explicitly chooses a new tunnel.

**CRED-005.** 401/expired/revoked and 403/permission failures remain distinct actionable states. Restart is not credential renewal.

### 12.1 Legacy project-local migration

The legacy state may contain `.trial/runtime.key`, `.trial/tunnel-id`, `.trial/standalone-tunnel`, project-local tunnel logs/health files, and an installed `local.repo-mcp.tunnel` plist whose ProgramArguments reference those paths.

**CRED-006.** Migration is explicit (for example `python3 scripts/install-tunnel-service.py --migrate --install`); ordinary start MUST NOT silently search arbitrary checkouts for credentials.

**CRED-007.** Before migration, inspect the installed `local.repo-mcp.tunnel` plist. It is recognized as migratable only when it matches the recorded/current Repo MCP install definition or the documented legacy Repo MCP tunnel template (expected label, official tunnel-client `run`, loopback MCP URL, and legacy project-local key/health/log paths). Any unknown/foreign service under that label MUST be refused and left unchanged.

**CRED-008.** Migration MUST copy the validated tunnel ID and runtime key into Application Support using owner-only temporary files plus atomic publish, without deleting the legacy credential until the new service has been verified.

**CRED-009.** Migration MUST bootout the known Repo MCP tunnel service, replace/reinstall its plist so ProgramArguments, key file, health URL file, stdout, and stderr paths all point to Application Support, then bootstrap a fresh process. The new plist MUST not depend on the source checkout’s `.trial` directory.

**CRED-010.** The legacy `.trial/standalone-tunnel` marker state MUST migrate into durable user-local `tunnel/install.json`. After successful migration the public runtime MUST use the install record, not the source-tree marker.

**CRED-011.** Migration success requires a control-plane `last_success` later than the new tunnel process/reinstall start time and zero consecutive failures. A stale pre-migration poll cannot satisfy success.

**CRED-012.** Only after `CRED-011` succeeds may migration remove the legacy marker/key/tunnel-id copies. If removal fails, status MUST warn that a legacy secret copy remains. On any earlier failure, preserve the old files/plist backup for explicit recovery and do not claim migration success.

**CRED-013.** Private tunnel stdout/stderr, health URL files, install state, and upstream errors remain outside release packages and normal status output.

## 13. Health model and frozen-candidate server proof

There are three distinct health layers. They MUST NOT be collapsed.

### Layer 1 — Local MCP/process

`coord status` verifies:

- launchd service loaded/running;
- loopback `GET /` returns expected Repo MCP health;
- process-originated generation/task/root digest/server version match desired state;
- task state is readable and expected server lock is held when running;
- task ID is not completed.

A local SDK handshake/list-tools probe MAY be added, but it is not the remote ChatGPT proof.

**HEALTH-001.** Layer 1 result is one of `ready | stopped | wrong_generation | wrong_task | wrong_root | wrong_version | unhealthy | blocked`.

### Layer 2 — Tunnel freshness

Reuse the current control-plane health interpretation.

**HEALTH-002.** Layer 2 is `ready` only when the tunnel process is live/ready and a successful control-plane poll is recent (the current implementation uses a 90-second freshness window) with zero consecutive failures.

**HEALTH-003.** `credential_rejected`, `access_denied`, `tunnel_error`, `not_ready`, `remote_unverified`, and `poll_unverified` remain distinguishable.

### Layer 3 — Actual ChatGPT route

The only accepted proof of the full user path is a `repo_info` call made from the actual ChatGPT conversation that will code or review.

**HEALTH-004.** The coding conversation’s first repository call MUST be `repo_info`.

**HEALTH-005.** Before coding, that response MUST match expected task ID, canonical root, branch/HEAD, phase `coding`, policy digest, claim-set digest/count, and capabilities. The conversation must then read `instructions_path` through every continuation if present.

**HEALTH-006.** Before independent review, the review conversation’s first repository call MUST be `repo_info` and MUST match the frozen task/root/HEAD, phase `review`, policy digest, claim-set digest, and the coordinator-supplied candidate digest.

**HEALTH-007.** No local CLI can honestly mark Layer 3 green on its own. `coord status` reports `chatgpt_route: unverified` or `probe_required` unless an operator/coordinator separately records the result of the actual conversation. A synthetic local MCP call is not a substitute.

**HEALTH-008.** After a task-mode schema upgrade, a valid Layer 3 probe must confirm the expected eight tools and that task-mode `edit`/`create_file` schemas mark `request_id` as required. A stale tool schema requires Refresh tools and a new conversation before writes.

### 13.1 Process-verified candidate fields in repo_info

In task mode, `repo_info` adds top-level fields:

```json
{
  "candidate_digest": "<sha256-or-null>",
  "candidate_state": "not_frozen|current|stale|missing|invalid",
  "candidate_reason": "<sanitized optional reason>"
}
```

**CAND-001.** In coding phase after bind/resume, `candidate_state` is `not_frozen` and `candidate_digest` is null.

**CAND-002.** In review phase, the server MUST load the persisted candidate manifest, recompute its digest from the exact section 14.2 preimage, and reject malformed/digest-mismatched records as `invalid`.

**CAND-003.** Before returning `candidate_state=current`, the server process MUST verify current canonical root digest, branch/HEAD, policy digest, claim-set digest, the full semantic index signature defined in section 14.2.2, and every claimed path’s current presence/mode/SHA-256 against the frozen manifest. Missing/refused/ambiguous claimed paths fail verification.

**CAND-004.** If the manifest is structurally valid but any current HEAD/index/owned-path invariant differs, `repo_info` MUST return the stored/recomputed `candidate_digest` with `candidate_state=stale` and a sanitized reason. If no manifest exists in review, state is `missing`.

**CAND-005.** Review-phase `git_diff` MUST refuse unless `candidate_state=current`. Its evidence is scoped to the candidate’s authoritative owned-path set and candidate-vs-HEAD states; unowned paths are not silently added.

**CAND-006.** Every review-phase `git_diff` page MUST include `candidate_digest` and `candidate_state:"current"`. The retained diff capture/cursor metadata MUST bind to that digest. Each continuation re-verifies that the same candidate remains current; otherwise continuation fails stale.

**CAND-007.** The reviewer MUST compare three values before semantic approval: coordinator-provided candidate digest, process-verified `repo_info.candidate_digest`, and `git_diff.candidate_digest` on every page. Any mismatch or non-current state stops review.

**CAND-008.** Coding-phase `git_diff` keeps its existing live-worktree semantics. The stricter digest binding above is review-phase behavior.

## 14. Candidate freeze and commit evidence

V1 adds compact coordinator-side baseline/candidate/commit evidence. It does not add asynchronous real-project MCP check jobs.

### 14.1 Baseline and claim evidence

The bind baseline records:

- task ID and canonical checkout/root digest;
- branch/detached state and starting HEAD;
- policy path/digest;
- authoritative claim-set version/digest;
- full semantic index signature defined in section 14.2.2;
- full Git status snapshot plus the exact `status_digest` defined by `BASE-001`;
- initial claimed-path baselines: exact path, present/absent, mode, SHA-256;
- unowned changed/staged path names as context;
- protected path hashes supplied by the task workflow;
- coordinator version and captured timestamp.

**EVID-001.** Baseline evidence is private operator state, published only after `BASE-001..005` succeed, and never stored in the served repository.

### 14.2 Frozen candidate manifest and exact candidate_digest

At freeze, persist a manifest with this logical shape:

```json
{
  "schema_version": 1,
  "task_id": "example",
  "root": "/path/to/canonical-root",
  "root_digest": "<sha256>",
  "branch": "main",
  "head": "<full-head-object-id>",
  "policy_digest": "<sha256>",
  "claim_set_digest": "<sha256>",
  "freeze_index_digest": "<semantic-index-sha256>",
  "owned_paths": [
    {
      "path": "src/example.ts",
      "claim_baseline_mode": "100644",
      "claim_baseline_sha256": "<sha256-or-null>",
      "head_mode": "100644",
      "head_sha256": "<sha256-or-null>",
      "candidate_mode": "100644",
      "candidate_sha256": "<sha256-or-null>",
      "delta": "unchanged|modified|added|deleted"
    }
  ],
  "unowned_status_names": ["path/not/owned"],
  "captured_at": "<iso8601>",
  "candidate_digest": "<sha256>"
}
```

For a detached HEAD, `branch` is JSON `null`, not the string `"HEAD"` or an empty string.

#### 14.2.1 Normative field definitions

Every field that participates in `candidate_digest` has one normative representation:

- `schema_version`: JSON integer `1`.
- `task_id`: the exact persisted task ID string after normal task-ID validation; no case folding or normalization is applied for digesting.
- `root_digest`: the exact lowercase SHA-256 defined by section 10.3: UTF-8 bytes of the canonical checkout-root string, no trailing newline.
- `branch`: the exact attached branch name returned by repository identity as a JSON string; when detached it is JSON `null`.
- `head`: the complete object ID returned by `git rev-parse --verify HEAD`, lowercase hexadecimal as emitted by Git, with surrounding whitespace removed. V1 does not assume a fixed SHA-1 length.
- `policy_digest`: the existing server `policyDigest(loadPolicy(...))` value. Its canonical policy JSON recursively sorts each object's keys using ECMAScript default `Array.prototype.sort()` lexicographic UTF-16 code-unit order, omits object properties whose value is `undefined`, preserves array order, JSON-encodes scalar values, emits no whitespace, then hashes the UTF-8 bytes with SHA-256.
- `claim_set_digest`: exactly the digest defined by `OWN-009`.
- `freeze_index_digest`: exactly the full semantic index signature defined in section 14.2.2; it is not an index-file hash and does not include stat-cache-only data.
- `owned_paths[].path`: the authoritative claim path string exactly as stored in `claims.json`, repository-relative normalized POSIX spelling, sorted by raw UTF-8 byte order for the digest preimage.
- every `*_mode`: JSON `null` for absence, otherwise a six-character Git tree/index mode string. V1 accepts exactly `"100644"`, `"100755"`, `"120000"`, or `"160000"`; any other mode makes candidate capture fail as unsupported. Current Repo MCP writable-file rules still reject symlink/gitlink mutation, but their Git modes remain unambiguous when encountered in HEAD/baseline evidence.
- `claim_baseline_sha256`, `head_sha256`, and `candidate_sha256`: JSON `null` for absence. For mode `100644` or `100755`, use lowercase SHA-256 of the exact raw file/blob bytes. For mode `120000`, use lowercase SHA-256 of the exact symlink blob bytes (the link target bytes stored by Git), without following the link. For mode `160000`, use lowercase SHA-256 of the ASCII bytes of the full lowercase gitlink object ID referenced by that entry; the referenced commit/tree contents are not read. No newline normalization, text decoding, or Git object header participates. Current writable-path policy still rejects symlink/gitlink mutation, so unsupported claimed working paths fail before candidate publication.
- `delta`: exactly `"unchanged"`, `"modified"`, `"added"`, or `"deleted"`. It is derived only from the HEAD pair `(head_mode, head_sha256)` versus candidate pair `(candidate_mode, candidate_sha256)`: equal pairs = unchanged; HEAD absent/candidate present = added; HEAD present/candidate absent = deleted; otherwise = modified.

For a present regular working-tree file accepted by v1, filesystem-to-Git mode derivation MUST match Git's regular-file executable-bit semantics, equivalent to `ce_mode_from_stat` for the cases v1 supports:

1. Read the repository/worktree's effective `core.fileMode` through Git configuration semantics: if `core.fileMode` is explicitly configured, use Git's boolean value; if it is absent, use Git's default `true` (`trust_executable_bit` enabled). Do not substitute a coordinator/platform guess.
2. For a tracked regular path with a stage-0 regular index entry (`100644` or `100755`) when `core.fileMode=false`, preserve that existing index executable mode exactly; filesystem execute-bit changes are ignored for candidate mode, matching Git's decision to retain the cache-entry mode.
3. Otherwise—including `core.fileMode=true`, or a present regular path with no regular stage-0 index entry—derive the Git regular-file mode from the filesystem **owner-execute** bit only: `(stat.mode & 0o100) !== 0 ? "100755" : "100644"`. Group/other execute bits (`0o010`/`0o001`) MUST NOT make a file executable in Git mode when owner-execute is clear.
4. A tracked regular path with an unmerged/non-stage-0 index state is not eligible for candidate publication; freeze fails closed rather than guessing which mode to preserve.
5. The resulting candidate mode is the normative mode later used by staging/equality. Controlled staging MUST reproduce that exact `candidate_mode` or the equality gate fails.

The mode-derivation routine MUST be factored/shared wherever baseline, candidate currentness, stopped-server verification, and commit equality derive a working-tree regular-file Git mode; no coordinator-specific executable-bit override is permitted.

#### 14.2.2 Full semantic index signature

`freeze_index_digest` MUST reuse/factor the semantic index-signature implementation already used to bind retained Git captures; v1 MUST NOT introduce a second weaker index identity.

The normative v1 algorithm is:

1. Run `git ls-files --stage --debug -z` in the selected checkout, using Git's worktree-specific index.
2. Parse every index entry in Git-emitted order. Each entry begins with the exact header `<mode> <object> <stage>\t<path>\0`, followed by the fixed `--debug` stat block whose final field is hexadecimal `flags`. Any malformed/truncated/undecodable listing fails closed.
3. From the debug flags retain only the three status/diff-significant bits already used by the server: `0x00008000` (assume-unchanged / CE_VALID), `0x20000000` (intent-to-add), and `0x40000000` (skip-worktree). Compute `masked_flags = (flags & 0x60008000) >>> 0` and serialize it as an unsigned decimal integer.
4. Discard ctime, mtime, device, uid/gid/inode/size and all other stat-cache-only/debug data.
5. For each entry form the UTF-8 string `<mode> <object> <stage>\t<path>\t<masked_flags_decimal>`, preserving the mode/object/stage/path exactly as emitted by Git.
6. For the **full** signature used by freeze/baseline/currentness, include every index entry and every stage regardless of model policy or candidate ownership, preserving Git emission order. Join entry strings with one NUL byte and no trailing NUL.
7. `freeze_index_digest` is lowercase SHA-256 of those joined UTF-8 bytes. An empty index therefore hashes the empty byte string.

This is the same semantic identity as the existing capture algorithm: mode, object ID, stage, intent-to-add, skip-worktree, and assume-unchanged affect the digest; a pure stat refresh or index-file-format rewrite that preserves those semantics does not.

#### 14.2.3 Candidate digest preimage

The **candidate digest preimage** is exactly the following object, with `owned_paths` sorted by raw UTF-8 byte order of `path`:

```json
{
  "schema_version": 1,
  "task_id": "example",
  "root_digest": "<sha256>",
  "branch": "main",
  "head": "<full-head-object-id>",
  "policy_digest": "<sha256>",
  "claim_set_digest": "<sha256>",
  "freeze_index_digest": "<semantic-index-sha256>",
  "owned_paths": [
    {
      "path": "src/example.ts",
      "claim_baseline_mode": "100644",
      "claim_baseline_sha256": "<sha256-or-null>",
      "head_mode": "100644",
      "head_sha256": "<sha256-or-null>",
      "candidate_mode": "100644",
      "candidate_sha256": "<sha256-or-null>",
      "delta": "unchanged|modified|added|deleted"
    }
  ]
}
```

For the detached case the same preimage uses `"branch":null`.

Canonical encoding for v1:

1. object keys are emitted **exactly in the order shown above**; each owned-path object uses the exact key order shown;
2. `owned_paths` is sorted by raw UTF-8 bytes of `path`;
3. strings/null/number values use ECMAScript `JSON.stringify` JSON escaping/encoding, with no replacer and no whitespace;
4. there is no BOM and no trailing newline;
5. encode that JSON string as UTF-8;
6. `candidate_digest` is lowercase hexadecimal SHA-256 of those bytes.

`candidate_digest` itself, `root`, `unowned_status_names`, `captured_at`, coordinator version, check evidence, and review evidence are **excluded** from the preimage. Therefore recapturing identical bound content/configuration at a different time produces the same digest.

**DIGEST-001.** The index-signature parser/canonicalizer MUST be factored so retained-capture binding and candidate freeze/currentness call the same implementation for the full semantic signature rather than copying the algorithm.

**DIGEST-002.** Tests MUST include hand-authored golden vectors with literal canonical input bytes and literal expected 64-hex SHA-256 values checked into the test source/fixture. Expected values MUST NOT be produced at test runtime by a second implementation of the same algorithm.

**DIGEST-003.** Candidate-digest/mode golden vectors MUST separately cover: attached branch string; detached `branch:null`; non-executable `100644`; executable `100755`; an addition; and a deletion. Mode-derivation fixtures MUST include owner-execute only (`0o100`) => `100755`, group-execute only (`0o010`) => `100644`, other-execute only (`0o001`) => `100644`, group+other execute with owner clear (`0o011`) => `100644`, and `core.fileMode=false` for an already tracked regular file preserving both an indexed `100644` and an indexed `100755` despite contradictory filesystem owner-execute state. At least one digest vector must combine more than one owned path to lock down UTF-8 path ordering and object-key order; fixed expected digests MUST reflect the canonical Git mode produced by these rules.

**DIGEST-004.** Semantic-index golden vectors MUST lock down mode/object/stage serialization and each significant flag bit independently: assume-unchanged, intent-to-add, and skip-worktree. A vector changing only discarded stat-cache fields MUST retain the same expected signature; toggling any retained flag MUST have a different fixed expected signature.

**EVID-002.** The candidate contains every authoritative claimed path, including unchanged/absent claims, so post-freeze changes to any owned path can be detected. Added/deleted states are explicit; diff text alone is insufficient.

**EVID-003.** `delta` is derived from HEAD presence/mode/content versus candidate presence/mode/content. It is not inferred from “clean at bind”.

**EVID-004.** `unowned_status_names` is informational context only and is excluded from ownership and candidate digest. Unowned staged entries are a commit blocker, not candidate-owned content.

**EVID-005.** Candidate capture uses the coherent pre/post recheck in `COORD-017`; no mixed-generation manifest is published.

**EVID-006.** Candidate manifests contain hashes/metadata only, not source contents, credentials, or test stdout.

### 14.3 Coordinator real-test evidence

Real-project checks stay outside MCP. Before review/commit, coordinator evidence records at minimum:

- exact fixed executable/argv or named local procedure;
- cwd;
- start/end or duration;
- exit code;
- candidate digest/source identity the run applies to;
- test names/counts when exposed;
- whether output was complete and where private local output was retained.

**EVID-007.** A real check result is valid only for the candidate identity it was run against. Any owned candidate content/config change requires rerunning affected checks.

**EVID-008.** The ChatGPT reviewer must be told which results were coordinator-executed; it must not imply it ran them.

### 14.4 Review evidence

Before commit the coordinator records:

- review conversation reference when available;
- reviewer `repo_info` identity/phase confirmation;
- coordinator digest, process-verified `repo_info` digest/state, and every review `git_diff` digest;
- reviewer outcome and confirmed findings;
- evidence each blocking finding was repaired/re-reviewed or explicitly accepted by the user within scope.

**EVID-009.** A review is valid only when all digest values in `CAND-007` are identical and the reviewer observed `candidate_state=current` through the complete diff.

### 14.5 Pre-commit currentness gate

Immediately before controlled commit preparation, and **before any new staging mutation**, the coordinator MUST recompute/check the frozen root/HEAD/policy/claim set/full index/owned-path invariants and confirm they still equal the reviewed candidate. If not, commit preparation stops and the task returns to reconciliation/refreeze.

**EVID-010.** At the pre-staging boundary, the reviewed candidate MUST be verified against the live checkout by the single shared candidate-verification routine used for `repo_info` currentness. If the server is running, its review-phase `repo_info` invokes that routine and must report the reviewed digest as `current`. If the server is intentionally stopped for commit preparation, the coordinator MUST invoke that **same factored verification routine** directly against the persisted candidate plus the live checkout/index/policy/claims; it MUST recompute HEAD, semantic index signature, and every owned path mode/hash. A stopped server never permits trusting stored candidate hashes without live verification.

### 14.6 Mandatory staged-tree equality and hook-safe commit

After explicit user commit authorization, the coordinator performs one fixed commit critical section while holding the common-directory lock required by `GIT-001..003`.

1. Verify `EVID-010` and that no unowned staged entries exist.
2. Run all prescribed project checks and any repository-required hook-equivalent checks **before** the final staging/equality gate. If those checks mutate HEAD, index, or any owned path, abort and refreeze/re-review.
3. Stage only the candidate’s expected task-owned delta using literal path arguments. Do not use `git commit -a`.
4. Immediately after staging, run the mandatory machine equality check below.
5. Run **no command capable of changing the index/tree** between equality success and commit.
6. Commit with Git hooks disabled using a verified empty operator-owned hook directory (for example `git -c core.hooksPath=<verified-empty-dir> commit ...`) so no pre-commit/prepare-commit-msg/commit-msg/post-commit hook can alter or replace the verified staged tree. Repositories that require hooks MUST map those checks to explicit coordinator procedures in step 2; if that cannot be done, the automated verified commit path is unavailable and v1 MUST refuse rather than silently run mutating hooks after equality.
7. Verify the resulting commit tree/parent and remaining working/index state before releasing the common-directory lock.

The mandatory equality check is exact:

**EVID-011.** Derive the expected staged delta path set from candidate-vs-HEAD `delta != unchanged`. The complete `git diff --cached --name-status -z --no-renames HEAD` path set MUST equal that expected set exactly. Rename/copy similarity detection is therefore disabled at this identity boundary: a candidate delete plus add remains two deterministic path identities even when contents are identical or highly similar. Any extra staged path, including an unowned/pre-existing path, fails.

**EVID-012.** Unmerged index stages (stage 1/2/3) fail. For every expected non-deleted path, the stage-0 mode MUST equal `candidate_mode`, and SHA-256 of the exact staged blob bytes MUST equal `candidate_sha256`. For expected deletions, no stage-0 entry may exist and the staged delta must report deletion.

**EVID-013.** HEAD MUST still equal candidate `head`, and every owned working-tree path MUST still match candidate presence/mode/SHA-256 immediately before commit. A racing external writer therefore fails the gate even if the staged blob happened to remain correct.

**EVID-014.** `EVID-011..013` MUST be the last tree/index verification before the hook-disabled commit; equality is not a human visual check.

**EVID-015.** Controlled staging intentionally changes the frozen `freeze_index_digest`, so a subsequent review `repo_info` would correctly report `candidate_state=stale` and review `git_diff` would refuse. This expected COMMIT_PREP transition does not invalidate the already-recorded semantic review only if `EVID-010` was current immediately before staging and `EVID-011..014` all pass. No new reviewer verdict may be collected after staging without refreeze.

**EVID-016.** Post-commit verification is defense in depth, not a substitute for the pre-commit equality gate: the commit parent MUST be the candidate HEAD (for the normal non-merge v1 path), committed task-owned blobs/modes/deletions MUST equal the candidate, no unexpected path may have entered the commit, and any remaining worktree/index drift is reported.

**EVID-017.** If commit fails, any retry must remain under/reacquire the common-directory lock and rerun the complete equality gate. If equality no longer passes, abort/refreeze.

**EVID-018.** Push remains separately authorized and outside MCP. The coordinator MUST hold the common-directory lock for its push workflow, resolve the exact configured remote URL and full destination ref, and identify the verified local commit SHA. Before push it MUST read the destination ref SHA (or explicit absence) and compare it with the coordinator's expected remote base; unexpected movement/divergence is a hard stop. It MUST push the explicit refspec `<verified-commit-sha>:<full-destination-ref>` without `--force`, `--force-with-lease`, rebase, or history rewriting. After success it MUST query the destination ref again and require its SHA to equal the verified local commit. Any precheck mismatch, Git non-fast-forward/divergence refusal, push failure, or post-push SHA mismatch is failure and MUST NOT trigger an automatic retry with force.

## 15. Coding and independent-review prompt contracts

### 15.1 Coding prompt

The coordinator supplies `TASK_ID`, `ROOT`, `BRANCH/HEAD`, policy digest, claim-set digest, exact owned paths, protected paths, and the test handoff.

Minimum contract:

> Use only Repo MCP for repository access. First call repo_info and verify TASK_ID, ROOT, BRANCH, HEAD, phase=coding, expected policy digest and claim-set identity; if any differs, stop without edits. Read instructions_path through all continuation pages. Inspect source/tests with list_files/search/read. Task-mode edit/create_file require request_id: use a fresh request_id for every new logical mutation and the latest file SHA; after a lost reply retry the identical mutation with the same request_id. Edit/create only paths explicitly listed as task-owned; policy writability alone is not ownership and the server must reject unclaimed paths. Preserve protected/pre-existing/unowned work. Add meaningful regressions first when required and pause for coordinator execution of real-project checks; do not invent test results. Implement only within scope, read the complete paginated diff, and report what the coordinator must test. Do not commit, push, switch branches, install dependencies, or use another repository interface.

**PROMPT-001.** The first repository call is always `repo_info`; no mutation precedes identity/instruction validation.

**PROMPT-002.** Task-mode `request_id` is required server-side. If the client schema marks it optional/missing, or task state is advertised but the mutation schema is not the expected v1 schema, stop and refresh tools/start a new conversation.

**PROMPT-003.** Pagination is part of the contract: `complete=false` is never treated as complete inspection.

### 15.2 Review prompt

Minimum contract:

> Use only Repo MCP, read-only. First call repo_info and verify frozen TASK_ID, ROOT, HEAD, phase=review, policy digest, claim-set digest, candidate_state=current, and candidate_digest exactly equals COORDINATOR_CANDIDATE_DIGEST. Read instructions_path completely. Read the complete review-phase git_diff through every continuation and verify every page reports candidate_state=current and the same candidate_digest. Inspect all owned changed tests/source needed for review. Supplied CHECK_RESULTS were executed by the coordinator unless Repo MCP explicitly shows otherwise. Report actionable findings with file/line and concrete reproduction, distinguish confirmed defects from hypotheses, state validation limits, and give the scoped verdict. Do not edit, rebind, commit, push, or approve an incomplete/stale/digest-mismatched candidate.

**PROMPT-004.** The reviewer MUST stop if phase is not `review`, identity differs, `candidate_state` is not `current`, coordinator/server/diff digests differ, or the complete diff cannot be read.

**PROMPT-005.** A repair returns control to coding only after coordinator `resume`; the old candidate digest and verdict are superseded after any repair/claim/rebind change.

## 16. Data/state additions

Use the current `StateStore` durability pattern and versioned envelopes. New records stay outside served roots.

Recommended v1 records:

```text
<state>/
  control/
    active-service.json
    install.json
  tasks/<task-id>/
    binding.json          # existing identity/policy binding
    phase.json            # existing coding|review
    claims.json           # authoritative exact owned paths + per-path claim baselines
    outcomes/...          # existing mutation request outcomes
    baseline.json         # coherent bind generation
    candidate.json        # current/superseded frozen candidate metadata
    review.json           # optional compact digest/verdict metadata, not chat contents
    completion.json       # terminal one-shot marker
  locks/...               # existing checkout/task/common-dir locks
```

Tunnel credential/runtime state is separate under user-local Application Support.

**DATA-003.** New records use atomic replacement + durable directory sync, owner-only files, and fail closed on corrupt/unknown record versions.

**DATA-004.** No migration may silently discard old mutation outcomes, infer claims from policy/status, alter a policy digest, or clear completion.

**DATA-005.** Baseline/candidate/review records are hashes/metadata only. They MUST NOT become a second repository or store source/test-log contents.

**DATA-006.** `claims.json` contains a monotonically increasing claim-set version, exact paths, and each path’s explicit claim baseline. Its path-set digest follows `OWN-009`.

**DATA-007.** `candidate.json` stores the complete manifest and digest defined in section 14.2 plus a superseded/current marker controlled by freeze/resume/rebind/claim transitions.

**DATA-008.** `completion.json` includes `finished_at`, result (`committed|abandoned`), final candidate digest when applicable, and verified commit SHA when committed. Its existence is the one-shot reuse guard in `LIFE-001`.

**DATA-009.** Startup/server TaskContext MUST check completion before acquiring writable task ownership. A completed task may be inspected by coordinator status but cannot be reopened by the server.

## 17. Failure modes and required behavior

| ID | Failure | Required v1 behavior |
| --- | --- | --- |
| FAIL-001 | Wrong repository/task loaded | Block coding; show expected vs actual identity; require finish/new bind or rebind as appropriate |
| FAIL-002 | Branch/HEAD drift | Mutations/checks stay blocked; explicit reconciliation/rebind |
| FAIL-003 | Policy digest drift | Server tools remain blocked until validated rebind + restart |
| FAIL-004 | Claim-set drift/unclaimed mutation | Reject mutation; never infer/expand ownership |
| FAIL-005 | Bind/claim baseline changes during capture | Retry whole capture at most three times; persistent drift fails with no mixed baseline |
| FAIL-006 | Live checkout lock owner | Fail; never recover a live owner |
| FAIL-007 | Dead/stale lock | Report details; recover only through explicit same-task recovery |
| FAIL-008 | Corrupt lock/state | Fail closed; manual inspection, no deletion |
| FAIL-009 | Completed task ID reused | Reject bind/start/resume/rebind/claim/server open; require new task ID |
| FAIL-010 | Port occupied or old process survives | Process attestation mismatch; do not accept old generation |
| FAIL-011 | Local server down | Layer 1 red; tunnel may be separately reported but not “connected” |
| FAIL-012 | Tunnel poll stale/missing | Layer 2 degraded; no coding until restored and ChatGPT probe succeeds |
| FAIL-013 | 401 credential rejection | Explicit rotation required; restart is not renewal |
| FAIL-014 | 403 tunnel access denied | Correct organization/principal permissions |
| FAIL-015 | Foreign/unknown tunnel launchd service during migration | Refuse replacement; preserve it |
| FAIL-016 | Tool schema stale in ChatGPT | Refresh tools and start a new conversation before mutation |
| FAIL-017 | Missing task-mode request_id | Server schema/tool call rejection before mutation |
| FAIL-018 | Lost edit/create reply | Retry identical request ID/args; never duplicate blindly |
| FAIL-019 | Request outcome uncertain | Stop and inspect; no automatic replay |
| FAIL-020 | Candidate manifest malformed/digest mismatch | repo_info reports invalid; review git_diff refuses |
| FAIL-021 | HEAD/index/owned path changed after freeze | repo_info reports stale; review git_diff refuses |
| FAIL-022 | Coordinator/server/diff candidate digest mismatch | Reviewer stops; no verdict/commit readiness |
| FAIL-023 | Unowned staged content | Block commit preparation |
| FAIL-024 | Staged tree differs from candidate or contains extras | Block commit; do not rely on visual diff |
| FAIL-025 | Required hooks cannot be moved before final equality | Refuse automated verified commit path |
| FAIL-026 | Commit/post-commit tree differs | Invalidate completion; inspect/reconcile, no push |
| FAIL-027 | Sleep/offline | No false success; recover tunnel without automatic key rotation |
| FAIL-028 | Public package private-path/secret marker | Packaging fails before release |

## 18. Security constraints

**SEC-001.** HTTP remains loopback-only with current Host/Origin validation.

**SEC-002.** No v1 MCP feature may accept an argument that selects an arbitrary local repository, policy file, command, environment variable, Git destination, or ownership claim.

**SEC-003.** launchd/service records, claims, task state, policy, audit, candidate evidence, and credentials are server/operator-owned paths and SHOULD live outside all served repositories.

**SEC-004.** Status output is sanitized. It may print local repository identity and hashes needed for operation but MUST NOT print runtime keys, raw tunnel errors, source contents, private test logs, or credential-bearing diagnostics.

**SEC-005.** Credential values never enter audit, task/claim/candidate manifests, release archives, command-line literals, or MCP responses.

**SEC-006.** Existing request/payload/file/page/capture limits remain unless separately changed with regression coverage; v1 hardening does not relax bounds.

**SEC-007.** Snapshot runners and optional macOS restrictions remain defense in depth, not complete hostile-code isolation.

**SEC-008.** Before public release, `SECURITY.md` MUST provide a private vulnerability-reporting channel.

**SEC-009.** Task-owned claims are a narrower authorization layer inside policy write/create scope. They do not widen policy and MUST be checked server-side for task-mode mutations.

**SEC-010.** The verified commit path uses an operator-owned empty hooks directory that is outside the repository, non-symlinked, mode 0700, and checked empty immediately before use. Repository-required hook logic must run before final equality as explicit checks; no hook executes after the staged tree is verified.

## 19. Backward compatibility and intentional v1 tightenings

**COMPAT-001.** Existing v1 exact-list and v2 path policies continue under current narrowing/secret rules; claims only narrow task-mode writes further.

**COMPAT-002.** The eight MCP tool names remain. V1 intentionally tightens the **task-mode** `edit` and `create_file` input schemas: `request_id` changes from optional to required. This is a deliberate schema-breaking tightening for tracked tasks, not an accidental compatibility promise.

**COMPAT-003.** Untracked/manual mode keeps current compatibility: it does not advertise `request_id` and rejects a stray one. Required request IDs apply only when task state/request outcome durability is enabled.

**COMPAT-004.** Because task-mode tool descriptors change, upgrade requires ChatGPT Refresh tools and a new coding/review conversation before mutation. A server version bump alone is insufficient.

**COMPAT-005.** Review-phase `repo_info` and `git_diff` add candidate digest/state response fields without adding new tool names. Review consumers must honor them.

**COMPAT-006.** Direct environment-based startup through the current manual entry point MAY remain for tests/advanced untracked compatibility; the public v1 workflow uses active-service generation attestation.

**COMPAT-007.** Existing `npm run task -- status|phase|rebind` remains for one release as low-level recovery/debugging, but it MUST honor completion and claim/candidate safety where relevant after hardening.

**COMPAT-008.** Legacy project-local tunnel state is supported only through the explicit migration in section 12.1; it is not silently rediscovered after migration.

**COMPAT-009.** Existing state records remain readable, but a pre-hardening task is not writable merely because its old binding parses. It must either pass the explicit adoption transaction `TASKMIG-001..008` with operator-supplied `--owned` claims and a coherent new baseline, or be left read-only/retired and replaced by a new task ID. Claims MUST NOT be synthesized from writable policy or current changed files.

**COMPAT-010.** Completed task IDs are intentionally one-shot in v1. No backward-compatibility path may clear/ignore `completion.json`.

## 20. Upgrade and schema-refresh behavior

Supported source upgrade:

1. freeze/finish or otherwise stop active coding safely;
2. unload the server service;
3. replace/update source installation;
4. `npm ci`, build, complete test/typecheck release validation;
5. if the installed server plist is the exact documented legacy template, run the explicit server migration in section 10.4; modified/foreign services are refused and require manual/new installation;
6. for any pre-hardening task to be continued, either adopt it with `TASKMIG-001..008` plus explicit `--owned` claims and coherent baseline, or bind a new task ID;
7. explicitly migrate legacy tunnel state if still project-local using section 12.1;
8. start the adopted/new active task;
9. require matching process generation/task/root/version attestation and tunnel freshness;
10. because v1 tightens task-mode request IDs, Refresh tools and start a new ChatGPT conversation on upgrade from the older schema;
11. perform actual ChatGPT `repo_info` before writes/review.

**UPG-001.** Binary/server version change alone is not proof that ChatGPT refreshed cached tool descriptors.

**UPG-002.** A policy-only change requires validated rebind + server restart. Tool-schema refresh is needed only when tool descriptors changed, but the post-rebind ChatGPT `repo_info` proof is always required.

**UPG-003.** Unknown newer state versions fail closed. Any future state migration must be explicit, versioned, backed up, and tested; it MUST preserve completion, claims, and request outcomes.

**UPG-004.** After upgrade, missing task-mode `request_id` in the client tool schema is a hard stop, not a reason to fall back to weaker retry behavior.

## 21. Open-source MIT release

V1 is a source release for supported macOS pilots. npm-registry publication is not required.

### 21.1 Supported platform statement

**REL-001.** Public v1 support is macOS, Node 26+, Git, npm, and the official OpenAI tunnel client. Optional Python/pytest runner support keeps its documented macOS-specific limitations.

**REL-002.** Linux and Windows remain unverified/not certified until tested. No portability wording may imply support merely because TypeScript compiles there.

**REL-003.** Public docs distinguish full workflow support (launchd/tunnel/service/coordinator) from portable library components.

### 21.2 Release contents

The deterministic allowlisted release archive MUST contain only reviewed public material. At minimum:

- public `README.md`;
- `SETUP.md`;
- `SECURITY.md`;
- `LICENSE` (MIT);
- `package.json`, `package-lock.json`, `tsconfig.json`;
- required `src/**`;
- required `scripts/**`;
- `test/**`;
- reviewed `examples/**`;
- `docs/V1-HARDENING-SPEC.md`;
- deterministic `SOURCE-MANIFEST.json`.

It MUST exclude:

- `.git/**`;
- `.trial/**`;
- `evidence/**`;
- Application Support task/credential/tunnel state;
- runtime keys/tunnel IDs/health files;
- logs/screenshots/private conversation artifacts;
- local repository clones/worktrees;
- build caches and `__pycache__`;
- generated release output from inside itself.

**REL-004.** Public docs MUST NOT require, link to, or rely on private/generated `evidence/` files for setup, security, operation, or acceptance.

**REL-005.** The packaging private-path/secret sentinel remains strict. Public examples use neutral placeholders such as `/path/to/project`; do not weaken private user-home absolute-path detection merely to package docs.

**REL-006.** Packaging itself MUST have automated tests; current absence of a `package-release` regression is a v1 gap.

### 21.3 Version consistency

The inspected tree has a package version and separately hard-coded MCP server version that differ.

**REL-007.** V1 MUST have one canonical release version source. MCP serverInfo, process attestation, and archive naming derive from it or are mechanically checked against it.

**REL-008.** The exact first public semantic version is a maintainer decision, but release is blocked while package/server/archive versions disagree.

### 21.4 Clean-machine acceptance

Before publication, run on a supported macOS account with no existing Repo MCP state:

1. obtain only public archive/checksum;
2. verify checksum/manifest;
3. install supported prerequisites and official tunnel client;
4. `npm ci`, build, run complete release test/typecheck;
5. create/save a new user-owned tunnel ID/runtime key into Application Support;
6. install tunnel + stable server launchd services;
7. prepare/bind public disposable fixture with a public policy and explicit owned paths;
8. verify process generation attestation and fresh tunnel poll;
9. connect ChatGPT, refresh tools, confirm task-mode request_id is required, and perform actual `repo_info`;
10. complete one bounded claimed-path fixture edit/test/diff cycle;
11. freeze, confirm process `candidate_state=current`, compare coordinator/repo_info/git_diff digests, and prove review-phase writes are denied;
12. demonstrate missing request_id and unclaimed writable-path mutations are rejected;
13. finish without leaving credentials in source tree.

**REL-009.** No clean-machine step may require author-specific paths, pre-existing `.trial`, private screenshots/evidence, or copied credentials.

**REL-010.** Clean-machine results are retained outside the release archive; public docs remain sufficient without them.

### 21.5 Release readiness

**REL-011.** Release validation runs the complete current source test suite and TypeScript no-emit/typecheck gate; do not encode a fixed test count as the permanent criterion. The release report records the actual count.

**REL-012.** A private security reporting channel is mandatory before publication.

**REL-013.** Public README/SETUP/SECURITY wording must match final coordinator commands, claim semantics, App Support credential paths, request-id tightening, candidate digest proof, billing language, and deferred features.

**REL-014.** `package.json` may remain `private: true` for a source/GitHub-style release; npm publication is a separate decision.

## 22. CLI UX examples

### New task on an existing checkout

```sh
npm run coord -- bind \
  --task headless-presence-20261002 \
  --repo /path/to/project \
  --policy /path/to/project-policy.json \
  --owned AgentSessions/Services/PresenceEngine.swift \
  --owned AgentSessionsTests/HeadlessAgentPresenceTests.swift

npm run coord -- start
npm run coord -- status
```

Expected high-level status:

```text
task:                 headless-presence-20261002
checkout:             /path/to/project
phase:                coding
claim_set:            <digest> (2 paths)
desired_generation:   4
process_generation:   4
process_task:         headless-presence-20261002
process_root_digest:  <matching digest>
server_version:       <matching version>
local_mcp:            ready
tunnel:               ready (fresh poll)
chatgpt_route:        probe_required
candidate_state:      not_frozen
candidate_digest:     null
```

The coding conversation then calls matching `repo_info`, confirms the refreshed task-mode schema requires `request_id`, and reads repository instructions.

### Explicitly add an owned path discovered during coding

```sh
npm run coord -- claim --add docs/CHANGELOG.md
```

This is an explicit ownership decision, captures the path’s current baseline, changes the claim-set digest, and invalidates any prior candidate.

### Freeze for independent review

```sh
npm run coord -- freeze
npm run coord -- status
```

Expected:

```text
phase:                review
candidate_state:      current
candidate_digest:     <digest-D>
mutations:            denied
chatgpt_route:        review_probe_required
```

The review conversation must observe `candidate_state=current`, `repo_info.candidate_digest=D`, and the same `candidate_digest=D` on every `git_diff` page.

### Repair after a reviewer finding

```sh
npm run coord -- resume
# ChatGPT coding conversation repairs claimed paths; coordinator reruns checks.
npm run coord -- freeze
```

The second freeze creates a new digest if candidate content/config changed; the old review does not carry forward.

### Verified commit handoff

The commit itself remains coordinator/Codex-owned, not an MCP tool. After explicit authorization the coordinator implementation:

1. verifies reviewed candidate D is current;
2. acquires the common-directory Git lock;
3. stages only D’s expected owned delta;
4. machine-compares the entire staged delta/blob/mode set to D with no extras;
5. commits immediately with the verified empty hooks directory;
6. post-verifies the commit tree while the lock remains held;
7. returns the verified commit SHA.

Then:

```sh
npm run coord -- finish --commit <verified-commit-sha>
```

### Switch repository/task

```sh
npm run coord -- finish --abandon   # or --commit for a completed task
npm run coord -- bind --task next-task --repo /path/to/other-project --policy /path/to/other-policy.json --owned src/file.ts
npm run coord -- start
```

The old task ID cannot be reused; no plist edit or tunnel recreation is required.

### Explicit stale-lock recovery

```sh
npm run coord -- status
npm run coord -- start --recover-stale
```

Recovery is refused unless the owner is dead and lock/binding match the active non-completed task/checkout.

## 23. Test requirements

All new behavior requires regression coverage. Existing accepted tests stay unless an intentional v1 contract tightening changes an assertion.

### 23.1 Claims, baseline, completion, and coordinator state

**TEST-001.** Bind validates root, policy digest, detached-head opt-in, state-outside-repo rules, and explicit owned paths.

**TEST-002.** Writable-but-unclaimed edit/create is rejected server-side; policy writability alone never grants task ownership.

**TEST-003.** `claim --add` captures current baseline and changes claim digest; `claim --remove` refuses a changed/mutated path.

**TEST-004.** An external change to a writable but unowned path remains excluded from owned candidate evidence and cannot be staged by the task. An unowned staged path blocks commit.

**TEST-005.** Bind baseline capture is one coherent generation: inject HEAD/index/path/status drift between capture and post-check, prove full retry, and prove persistent drift fails without publishing baseline.

**TEST-006.** Claim-add baseline capture has the same race/retry behavior.

**TEST-007.** Bind is idempotent only for an active identical non-completed binding.

**TEST-008.** Once `completion.json` exists, bind/start/resume/rebind/claim mutation/server task opening all reject the task ID; a new task ID succeeds.

### 23.2 launchd service and process attestation

Unit tests factor/mock service control so ordinary tests never alter the developer launchd domain.

**TEST-009.** Stable server plist contains no repo/policy/key and points only to installed service entry/config path.

**TEST-010.** Active-service generation increments deterministically and record is atomic/owner-only/versioned.

**TEST-011.** Start with mocked service control accepts only a process health attestation matching desired generation/task/root digest/server version.

**TEST-012.** An old surviving process returning `ok=true` with previous generation is rejected.

**TEST-013.** Service replacement uses bootout/bootstrap only when install definition changes; normal task reload uses generation update + kickstart/bootstrap as appropriate.

**TEST-014.** Unexpected foreign server plist/service and occupied port are refused.

### 23.3 Freeze, digest, and review binding

**TEST-015.** Freeze waits for an in-flight mutation before review and coherent candidate capture.

**TEST-016.** Golden-vector tests check literal canonical input bytes and literal expected SHA-256 strings committed in fixtures/source; expected hashes are not computed at test runtime by a second implementation. Candidate vectors cover attached branch, detached `branch:null`, `100644`, `100755`, addition, deletion, multi-path UTF-8 ordering, and `captured_at` exclusion. Fixed mode-derivation cases cover owner-execute only => `100755`; group-only, other-only, and group+other execute with owner clear => `100644`; and `core.fileMode=false` preserving tracked index `100644` and `100755` despite opposite filesystem owner-execute state. Semantic-index vectors separately cover mode/object/stage serialization, assume-unchanged, intent-to-add, skip-worktree, and a stat-cache-only change that leaves the expected digest unchanged.

**TEST-017.** repo_info in review recomputes candidate digest and returns `current` only when HEAD, index, policy/claims, and every owned path match.

**TEST-018.** HEAD drift, index drift, owned content/mode drift, deletion/addition drift, malformed manifest, or stored-digest corruption yields stale/invalid state as specified.

**TEST-019.** Review-phase git_diff refuses stale/missing/invalid candidates and every successful page/cursor is bound to the same candidate digest.

**TEST-020.** Coordinator/repo_info/git_diff digest mismatch causes review contract failure.

**TEST-021.** Resume/claim/rebind invalidates current candidate readiness.

### 23.4 Request-ID and crash recovery

**TEST-022.** Task-mode `edit` and `create_file` schemas require `request_id`; missing-ID calls fail before mutation.

**TEST-023.** Untracked mode still omits/rejects `request_id` as before.

**TEST-024.** Existing retry/idempotency/create-crash-publication regressions continue to pass.

**TEST-025.** Dead stale checkout lock is not recovered by ordinary start.

**TEST-026.** Explicit stale recovery succeeds only for same-host dead owner/matching active task; live owner, corrupt lock, hostname mismatch, changed binding, completion, and stale recovery marker fail closed.

### 23.5 Commit equality and common Git lock

**TEST-027.** Every coordinator local Git mutation path uses the common-directory short lock; tests prove two cooperating mutations cannot overlap.

**TEST-028.** Staging gate accepts exact candidate delta and rejects: extra staged path, missing expected path, wrong staged blob bytes, wrong mode, unmerged stages, wrong deletion, or changed HEAD. It MUST invoke the `EVID-011` cached-diff command with `--no-renames`; regression coverage stages a deletion plus a highly similar/identical-content addition that Git rename similarity could otherwise pair, and proves the gate still observes deterministic separate delete/add path identities.

**TEST-029.** External owned-path change after staging but before equality fails the working-tree candidate check.

**TEST-030.** Verified commit uses the empty hooks directory; a synthetic repository hook that would alter/stage content is not run after equality.

**TEST-031.** If required hook-equivalent checks mutate candidate/index before equality, commit path aborts/refreeze is required.

**TEST-032.** Post-commit verification catches wrong parent, blob/mode/deletion mismatch, unexpected commit path, and remaining drift.

### 23.6 Tunnel/credential migration

**TEST-033.** Existing saved key is reused without prompting/exposure; 401, 403, generic error, not-ready, remote-unverified and stale-poll classifications remain distinct.

**TEST-034.** Rotation atomically replaces key, keeps 0600, restarts tunnel, and requires a fresh successful poll.

**TEST-035.** Legacy migration recognizes only the expected Repo MCP tunnel plist; foreign/modified service is refused unchanged.

**TEST-036.** Migration rewrites ProgramArguments/key/log/health paths to Application Support, migrates marker state to install.json, bootout/bootstrap starts the new service, and success requires a post-restart fresh poll.

**TEST-037.** Failed migration preserves legacy credential/plist recovery material and never claims success.

**TEST-038.** Sleep/network simulation can make tunnel health red while local MCP remains green; reconnect reuses key.

### 23.7 Packaging/release

**TEST-039.** Release archive exact allowlist includes this spec and excludes `.trial`, `evidence`, App Support state, credentials/logs/caches.

**TEST-040.** Two package runs from identical source produce byte-identical archive/digest.

**TEST-041.** Private user-home-path and credential sentinels fail packaging; spec/public examples use only neutral `/path/to/...` placeholders.

**TEST-042.** SOURCE-MANIFEST hashes every included file correctly.

**TEST-043.** package/server/process-attestation/archive versions are consistent from one canonical source.

### 23.8 Legacy server/task migration and push

**TEST-044.** Recognized legacy server migration builds a plist exactly matching `SERVERMIG-001`, proves recognition, bootout + backup/install-record preparation, stable-plist replacement, and—when a safe task already exists—bootstrap/success only after matching new process-generation/task/root/version attestation. A separate no-safe-task case MUST end in `prepared_unbound`: stable plist installed, legacy backup retained, no task-bound active-service generation published/advanced, service unloaded, and migration not verified until a later safe bind/adoption publishes a generation and attestation succeeds.

**TEST-045.** Modified/foreign legacy server refusal changes each recognized field class independently (ProgramArguments executable/extra arg, environment key/value, WorkingDirectory, logs/audit, KeepAlive/RunAtLoad/ThrottleInterval, extra top-level key) and proves migration leaves the installed service/plist unchanged.

**TEST-046.** Pre-hardening task adoption tests the preferred explicit-claim path: stopped server, no live writer lock, exact old binding identity/policy, explicit `--owned`, existing outcome paths included, coherent new baseline, and old review invalidation. Separate cases prove missing explicit claims, binding/policy drift, live/stale lock without explicit recovery, completed task, or omitted historical outcome path refuse adoption and require corrected input or a new task ID.

**TEST-047.** Candidate verification while the server is stopped calls the same factored live-verification routine used by `repo_info`. Mutating HEAD, semantic index flags, or an owned path after server shutdown MUST make `EVID-010` fail; a test that merely rereads persisted hashes is insufficient.

**TEST-048.** Push regression uses only local repositories and a temporary local **bare remote**. Under the common-directory lock, push an explicit verified commit SHA to an exact full ref, verify the destination SHA, then create remote divergence from a second clone/worktree and prove the coordinator refuses at the pre-push expected-base check or Git non-fast-forward without force/rebase. Instrument the lock so the entire precheck/push/postcheck sequence is proven inside one cooperative lock critical section.

### 23.9 End-to-end acceptance pilots

**ACC-001 — Repeated local coding pilot.** Bind an existing real checkout with explicit claims, prove all health layers, ChatGPT mutates only claimed paths with required request IDs, Codex runs real checks, freeze, separate ChatGPT review compares all candidate digests, repair if needed, and complete an authorized machine-verified commit.

**ACC-002 — Repository switch pilot.** Finish first task, bind a different checkout under a **new task ID** with same installed services/tunnel, start it, and obtain matching process attestation + ChatGPT `repo_info`. Old checkout is unlocked and stale identity is impossible.

**ACC-003 — Crash recovery pilot.** Kill server ungracefully, show stale-lock failure, explicitly recover active non-completed task, restart with matching process generation, and demonstrate request-ID safety.

**ACC-004 — Network interruption pilot.** Interrupt tunnel/network long enough for freshness failure, restore without key rotation, verify fresh poll + actual ChatGPT `repo_info`, continue without duplicate mutation.

**ACC-005 — Legacy tunnel migration pilot.** Migrate a known legacy project-local tunnel service to Application Support; verify new plist paths, marker/install state, fresh poll, and no dependency on source `.trial`.

**ACC-006 — Clean-machine release pilot.** Perform section 21.4 from the public archive.

**ACC-007 — Legacy server/task adoption pilot.** Starting from the exact currently documented legacy `local.repo-mcp.server` plist and a pre-hardening task binding, stop the service, migrate the recognized plist with backup/install record, explicitly adopt the old task only with operator `--owned` claims and coherent baseline, bootstrap the stable service, and require matching process attestation. Repeat with a one-field-modified legacy plist and prove refusal/no overwrite. Repeat with unsafe task adoption input and no replacement task: migration may reach only `prepared_unbound`, publishes no task-bound generation and keeps the service unloaded/unverified; then bind a new task ID and prove that only that later safe bind/start publishes the generation and completes attestation.

**ACC-008 — Local bare-remote push pilot.** After a verified local commit, push under the common-directory lock to a temporary local bare repository using an exact full ref and explicit commit SHA, verify destination SHA, then create divergent remote history and prove the next push refuses without force/rebase and leaves the destination ref unchanged.

## 24. Measurable v1 acceptance criteria

V1 is release-ready only when all are true:

1. **No manual service surgery:** two task/repository switches use coordinator commands only; process-originated generation/task/root/version proves the fresh process.
2. **No false green:** local process attestation, tunnel freshness, and actual ChatGPT route remain distinct.
3. **Explicit ownership:** every task mutation is both policy-permitted and explicitly claimed; external writable-but-unowned changes never become owned implicitly.
4. **Coherent baseline:** bind/claim capture survives injected races only by full retry and fails on persistent drift.
5. **Correct freeze:** process-side repo_info returns `candidate_state=current` only after HEAD/index/owned-path verification, and review git_diff pages bind to the same exact candidate digest.
6. **Digest determinism:** candidate digest uses the section 14.2 preimage/encoding; `captured_at` and digest field are excluded.
7. **Review equality:** independent reviewer confirms coordinator = repo_info = every git_diff candidate digest before verdict.
8. **One-shot tasks:** completed task IDs cannot be bound, started, resumed, rebound, or claimed again; a new run needs a new ID.
9. **Safe recovery:** stale locks are never implicitly removed and completed tasks are never recovered for reuse.
10. **Credential durability:** restart/task switch reuses tunnel ID/key; migration moves known service paths/state to Application Support, refuses foreign services, and verifies a fresh poll.
11. **Required mutation IDs:** task-mode schemas require request_id and missing IDs are rejected; untracked mode remains compatible; upgrade docs require tool refresh/new conversation.
12. **Locked Git mutations:** coordinator Git mutations use the common-directory lock.
13. **Pre-commit machine equality:** immediately after staging and before commit, `git diff --cached --name-status -z --no-renames HEAD` yields deterministic add/delete path identities, staged path set/blob bytes/modes/deletions equal candidate with zero extras, rename-similarity cannot collapse expected identities, and owned working paths still match.
14. **Hook-safe tree:** no Git hook can mutate the verified tree after equality; required hook logic ran before the gate or automated commit was refused.
15. **Post-commit defense:** committed parent/tree/modes equal the candidate and unexpected paths fail.
16. **Release cleanliness:** deterministic archive contains only public allowlist, strict private-path sentinel remains enabled, and public examples use neutral `/path/to/...` placeholders.
17. **Clean machine:** supported macOS environment completes install, route proof, required-ID mutation, claim enforcement, freeze/digest review proof, and teardown using public docs only.
18. **Regression gate:** complete current suite and TypeScript no-emit/typecheck pass after implementation; report actual counts rather than hard-code the historical 217.
19. **Scope discipline:** no asynchronous real-project MCP jobs, MCP commit/push, automatic worktrees, parallel scheduler, arbitrary shell, browser automation, or hostile-code sandbox claim becomes a v1 prerequisite.
20. **Billing accuracy:** public docs retain section 6 wording and make no unlimited/free-use promise.
21. **Digest field completeness:** every candidate-digest input has one normative representation; full semantic index signature reuses the existing mode/object/stage + significant-flags algorithm, attached branch is a JSON string, detached branch is null, modes use exact Git mode strings/null, regular-file Git mode uses owner-execute only and preserves tracked index mode when `core.fileMode=false`, and fixed golden vectors cover owner/group/other execute distinctions, `core.fileMode=false`, branch state, add/delete, ordering, and index flags.
22. **Safe legacy server/task migration:** only the exact documented legacy server plist is migrated, its bytes are backed up, modified/foreign services are untouched, adoption of an old task requires stopped service/no live lock/exact binding-policy match/explicit claims/coherent baseline, and unsafe adoption requires a new task ID.
23. **Stopped-server freshness:** pre-commit verification with the server stopped invokes the same live candidate-verification routine against the checkout; persisted hashes alone never satisfy `EVID-010`.
24. **Push integrity:** local bare-remote regression and acceptance prove exact-ref explicit-SHA push, common-directory locking, divergence/non-fast-forward refusal without force/rebase, and post-push destination-SHA equality.

## 25. Staged implementation order

### Stage 1 — Service control, legacy server/task migration, process attestation, one-shot/task schema safety

Implement the stable active-service record/service entry point, process-originated health attestation, idempotent launchd install/reload, exact legacy-server recognition/backup/replacement, pre-hardening task adoption-or-new-ID flow, completion guard, and task-mode required `request_id`. Wire `bind/start/status/finish/migrate-legacy` around these contracts and canonical version reporting.

Why first: the pilot blocker is reliable repository/task switching, and stale/legacy client-process identity is unsafe to build on.

Exit gate: fixture A -> fixture B under new task ID uses no plist edits; the exact legacy server migrates with backup + attested stable process when a safe task exists; a no-task migration remains `prepared_unbound` with no task-bound generation and unloaded service until later safe bind/adoption; a one-field-modified legacy plist is refused; unsafe old-task adoption requires a new ID; an old surviving process, completed ID reuse, and missing task-mode request IDs are rejected.

### Stage 2 — Authoritative claims, coherent baseline, exact digest semantics/server review proof

Implement `claims.json`, claim enforcement/update rules, coherent baseline capture/retries, the factored full semantic index-signature routine, fully specified candidate manifest/digest canonicalization, fixed golden vectors, process-side live candidate verification, and review-phase `git_diff` digest binding.

Why second: these are semantic provenance boundaries. Commit automation is not trustworthy until ownership, index identity, and review identity are machine-defined.

Exit gate: external unowned change remains unowned; race-injected baseline never mixes generations; attached/detached/add-delete/index-flag golden vectors plus owner/group/other execute and `core.fileMode=false` mode cases match fixed expected Git modes/digests; coordinator/repo_info/git_diff digest equality is demonstrable and stale review is refused.

### Stage 3 — Locked verified commit and push gate

Implement coordinator common-directory Git lock use for mutation paths, exact staging/equality checks, stopped-server reuse of the shared live candidate-verification routine, verified empty-hooks strategy, post-commit verification, and the separately authorized exact-ref push workflow from `EVID-018`. Keep commit/push local/coordinator-only; do not expose them through MCP.

Exit gate: every staged-tree mismatch/extra/hook-race test fails closed, rename-similarity cannot collapse deterministic add/delete identities because the gate uses `--no-renames`, stopped-server freshness detects live drift, an exact candidate commits under one lock, and a local bare-remote push verifies exact destination SHA while divergent history is refused without force/rebase.

### Stage 4 — Durable tunnel migration and interruption recovery

Move canonical tunnel credential/log/health/install state to Application Support, implement strict legacy-service recognition/reinstall/migration, fresh-poll proof, explicit rotation, and wake/network recovery diagnostics.

Exit gate: known legacy service migrates without source-tree runtime dependency; foreign service is untouched; restart/task switch never asks for a new key.

### Stage 5 — Public release hardening and external acceptance

Update public README/SETUP/SECURITY, add private security contact, unify version source, expand/test deterministic package allowlist, keep private-path sentinel strict, and run repeated real checkout, repository switch, crash, network, migration, and clean-machine pilots.

Exit gate: all section 24 criteria pass. Fix only v1 blockers found by acceptance; do not pull deferred asynchronous jobs/MCP Git/worktree/browser/sandbox work into scope.

## 26. Unresolved release decisions

These do not prevent implementation of the corrected v1 contracts above but must be resolved before public release:

1. **Exact semantic release version.** Current package and MCP server versions differ. Choose the first public version and derive/check package, serverInfo, process attestation, and archive naming from one canonical value.
2. **Public distribution channel.** This specification assumes a source/GitHub-style MIT release and does not require npm publication. npm publication would need a separate package/provenance/install decision.
3. **Supported macOS hardware matrix.** Public support must name architectures actually clean-machine tested.
4. **Security reporting destination.** The inspected SECURITY.md has no private vulnerability-reporting address/channel; publication is blocked until one exists.
5. **Review conversation reference storage.** It may remain optional compact coordinator metadata; it is not reviewer authentication and must not store private chat contents.

These decisions do not reopen the deferred scope: asynchronous real-project MCP jobs, MCP commit/push, automatic worktrees, parallel scheduling, arbitrary shell, browser automation, and hostile-code sandbox claims remain outside v1.
