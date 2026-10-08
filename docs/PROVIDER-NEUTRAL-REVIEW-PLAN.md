# Provider-neutral review execution plan

Status: explicit Oracle backend, hardened generic ChatGPT run journal, and one real
ChatGPT Extra High review implemented; final host-adapter acceptance and candidate
manifests remain in progress, 2026-10-07.

## Goal

Repo MCP owns repository authority and review evidence. ChatGPT web performs Repo MCP
review, architecture, and coding work. Codex and Claude are local coordinators that use
their own browser controls; they do not substitute their own semantic work. Oracle is
optional compatibility code, never the implicit way to obtain a ChatGPT review.

For Codex, the established user-facing default remains token-saving: `Use Repo MCP
review` means an independent ChatGPT web review at the `review` profile (Sol Extra High),
or `review-critical` (Sol Pro) when explicitly requested. It does not mean a Codex
subagent. Claude coordinates the same ChatGPT web execution route with its own browser
controls and labels Claude Code only as the coordinator.

## Verified starting state

- The production `git_diff` schema, built service, and live broker all accept
  `base_ref: "HEAD^"`. A live call against task
  `repo-mcp-oracle-replacement-20261007` resolved it to commit `c91cfc2`. A client that
  rejects the argument has stale tools or sent the wrong argument shape; the server
  contract must not be widened or weakened to work around that.
- Generic profile resolution, short-lived browser-context binding, trusted observation,
  atomic one-use verification, and sanitized evidence already exist in
  `src/model-policy.ts`.
- The public `model-policy run` command was Oracle-specific and could invoke Oracle
  without an explicit backend selector. Oracle version, metadata, journaling, recovery,
  and output validation are interleaved in the same module.
- No shipped host-native adapter currently calls `recordTrustedBrowserObservation`.
  Documentation must not imply that generic `resolve`/`verify` alone launches a model.

## Invariants

1. Repo MCP never accepts arbitrary repository roots from a remote model.
2. Backend selection is explicit. No adapter silently falls back to Oracle or another
   model host.
3. A Codex, Claude, or ChatGPT review is named by its real execution surface.
4. Profile requests never silently downgrade: review is XHigh; critical review is Pro.
5. A submitted run is recovered by the same durable run identity. Uncertainty never
   permits duplicate submission.
6. Receipts contain hashes and bounded metadata, never prompts, credentials, raw browser
   identifiers, workspace tokens, or full model output.
7. Review evidence binds repository registration, task, phase/policy epochs, HEAD,
   requested and resolved diff base, and eventually a candidate digest.

## Delivery sequence

### 1. Explicit compatibility backend

Require `model-policy run --backend oracle`. Calls without a backend fail before prompt
reading, Oracle preflight, journal creation, or submission. Keep `resolve` and `verify`
provider-neutral. Update skills so ordinary Repo MCP review never invokes Oracle.

### 2. Generic run records — implemented

An owner-only, versioned ChatGPT-run store lives outside repositories. It reserves a
run ID before submission and binds it to coordinator, execution surface, profile, browser-context hashes,
repository/task epochs, HEAD, diff base, prompt hash, and creation time. Define explicit
prepared, submitted, completed, failed-pre-submit, and uncertain states. Recovery reads
the same record; it never creates a replacement run automatically.

`chatgpt-run prepare/observe/reserve/submitted/complete` implements this state machine.
Claude is refused for `code`; both coordinators support `review` and `architecture`.

### 3. Candidate and prompt preparation — partial

The CLI validates bounded regular prompt files without following links, resolves the
repository and immutable diff base, and re-checks task epochs, policy, branch and HEAD
before submission and completion. A content manifest for uncommitted working-tree bytes
is still absent, so current assurance remains `phase_only` and must be reported as such.

### 4. Host adapters

- Codex/ChatGPT web: the Codex operator skill uses available native computer control,
  the generic model-selection contract, a preattached Repo MCP tab, and the generic run
  journal. This is the default token-saving Codex route.
- Claude Code: Claude uses its own host-native browser controls to coordinate ChatGPT web
  XHigh/Pro review or architecture. ChatGPT opens the Repo MCP workspace and performs the
  work; Claude remains the local coordinator.
- Codex: Codex uses host-native browser control to coordinate ChatGPT web review,
  architecture, or coding. ChatGPT performs the repository work.

Coding/write access is maintained through the Codex coordinator path. Claude's supported
Repo MCP workflows are review and architecture, both executed by ChatGPT web.

An adapter that cannot prove a requested model or recover a submitted conversation
returns `NOT TESTABLE`; it does not substitute a backend.

### 5. Generic completion receipts — implemented

The journal requires bounded nonempty output and fresh trusted browser receipts for
submission, recovery, and completion. Receipts bind repository/task, prompt hash, immutable
base commit, hashed browser context, event identity, and observation time. Submission and
completion event hashes must differ. A completion-specific receipt asserts an observed
finished response and binds the submitted event hash and observed output digest.
Tampered, stale, cross-task, cross-context, and mismatched receipts fail closed. Every
transition is validated before publication or claim release; reserved uncertainty forbids
submission evidence. Reservation replay is recovery-only and exact unresolved requests
are deduplicated. Initialization records process ownership; explicit `recover-request`
reclaims only validated terminal claims or orphan claims after proving a same-host
initializer is dead. Cleanup is serialized and idempotently recoverable. Movable base refs
are re-resolved, and explicit stale-lock recovery recognizes its own crashed replacement
lock while refusing live, corrupt, foreign-host, changed-token, and unrelated locks.
Contract/evidence JSON use the shared bounded nonblocking regular-file reader with fatal
UTF-8; Oracle prompt limits and protections remain unchanged.

### 6. Oracle extraction

Move Oracle-only version checks, argv, metadata parsing, and compatibility tests behind
an Oracle adapter module. Audit a newer Oracle release separately before changing its
pinned compatibility version. The provider-neutral core must build and test without an
Oracle installation.

### 7. End-to-end acceptance

Test model/profile mismatch, stale workspace, candidate drift, prompt symlinks/FIFOs,
secret leakage, concurrent reservations, crashes before and after submission, output
limits, receipt tampering, browser-context mismatch, exact same-run recovery, and
explicit legacy Oracle compatibility. Run one real ChatGPT XHigh review and one Claude
review against the same frozen candidate, with each result naming its actual host.

## Release gates

- The live client accepts `base_ref: "HEAD^"` after tool refresh and returns the resolved
  immutable commit.
- Ordinary Codex and Claude skill paths contain no implicit Oracle invocation.
- `model-policy run` cannot launch anything without an explicit backend.
- Provider-neutral run records and receipts pass crash/concurrency/tamper tests.
- Public documentation distinguishes repository access, execution surface, model
  profile, and optional compatibility backend.
