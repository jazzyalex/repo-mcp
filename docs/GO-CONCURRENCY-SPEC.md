# `chatgpt-run go` concurrency specification

Status: v2, 2026-10-22. Owner decision; v1 draft reviewed by a ChatGPT Pro architecture
pass the same day (verdict: proceed with N>1 after the fixes folded in below). It
replaces the single machine-wide admission of `docs/GO-DRIVER-SPEC.md` section 5. The
run journal, the manifest phases and the per-request recovery table of that spec stay.

## 1. Problem and decision

`go` 0.3 allowed one unresolved ChatGPT run per OS user, across all repositories. A
second `go` failed with `ACCOUNT_BUSY` before it opened a tab. Before 0.3, coordinators
ran several chats at once in different repositories. The owner rejected the 0.3 rule:

- several coding runs at once, in different checkouts;
- several review and architecture runs at once, on one checkout.

Account-ban risk is the owner's call. `go` ships owner-set controls, not a refusal.

Unchanged rules: one coding run per checkout, one unfinished task per checkout, one
write owner. Review needs the review phase and coding the coding phase, so coding and
review never run on one checkout at once. Architecture (inspect) beside a coding run on
one checkout stays allowed and reads a moving tree.

## 2. Owner configuration

`config.json` in the account store (`~/Library/Application Support/repo-mcp/chatgpt-account`),
owner-only (mode 600). Every key is optional; a missing file or key means the default.

| Key | Default | Range | Meaning |
|---|---|---|---|
| `max_concurrent` | 10 | 1-50 | Requests admitted at once (slots), all repositories together. |
| `max_per_hour` | 25 | 1-500 | Send attempts in any rolling hour, all slots together. |
| `min_gap_seconds` | 30 | 0-3600 | Minimum time between two send attempts. |
| `latch_enabled` | true | true/false | A detected browser challenge stops new work (section 6). |

- `chatgpt-run account config` prints the effective values and the source of each.
- `chatgpt-run account config-set KEY=VALUE` validates and writes atomically.
- A per-call `go --max-per-hour N` may only lower the cap: effective cap is the minimum.
- An unreadable file, unknown key, wrong type or value out of range fails closed with
  `ACCOUNT_CONFIG_INVALID` naming the key. Lowering `max_concurrent` never evicts a slot.

## 3. Account record v2

Path `account-v2`, kind `chatgpt-go-account-v2`, changed only under the
`chatgpt-go-account` lock. The lock is held for milliseconds: never across a sleep, a
browser call, or another lock.

```text
slots:    [{ key, request_id, state_dir, kind, checkout, since, pid, host, started }]
waiting:  [{ key, token, seq, since, pid, host, started }]
next_seq: integer
attempts: [{ id, key, at, bound, confirmed_at? }]     // last 24 h
latch:    null | { code, at, key?, reason?, by: "driver"|"owner" }
audit:    [{ at, action, key, reason }]               // last 100 owner releases/latches
```

- `key` stays `request_id@sha256(stateDir)[0:12]`.
- `checkout` is the realpath of the registered repository root for `kind: code`, else
  null. If the realpath cannot be resolved, admission fails `REPOSITORY_UNAVAILABLE`. Coding exclusion compares `checkout`, not the catalog-local repository ID.
- `started` is the process start time (`ps -o lstart=`), so a reused PID is not mistaken
  for a live owner.
- Validation on every read: unique keys, slot and waiter keys disjoint, known slot kinds,
  a checkout on every code slot, owner identity fields, strictly increasing waiter
  sequence numbers, unique attempt IDs, valid times. Corrupt record:
  `ACCOUNT_STATE_CORRUPT`, fail closed.

## 4. Admission

`runGo` first loads or creates the manifest (unchanged), then **classifies**:

- **Recovery** (manifest has `run_id` or `pending_run_id`, or phase past `admitted`, or
  phase `cleaned`/`failed`): re-adopt the slot if it is missing (after a manual release),
  even above `max_concurrent`, and ignore the latch and the queue. Recovery never sends,
  so it must never wait for capacity. Terminal replay releases as today.
- **Fresh**: wait for admission:
  1. Latch set: fail `ACCOUNT_LATCHED` (exit 1, nothing sent).
  2. A slot with this key: re-enter.
  3. `kind: code` and another code slot (or a `legacy` slot) has the same `checkout`:
     fail `REPOSITORY_BUSY`. A `legacy` slot has unknown checkout and blocks every code
     admission until it is resolved.
  4. Drop waiters whose `pid`/`started` no longer match a live process on this host.
  5. Free slot and this caller is the oldest waiter (or none wait): add the slot, remove
     the waiter.
  6. Else add a waiter once (fresh `seq`, random `token`), release the lock, sleep 5 s,
     retry. `--no-wait` fails `ACCOUNT_BUSY` at once and adds no waiter. On SIGINT or
     SIGTERM the waiter removes its own entry by token.

A dead slot holder is **never** pruned. A slot means "this request may have an
unresolved turn". Only its own terminal finish or an owner release frees it.

While waiting, `go` prints one stderr line per minute: queue position and slots in use.

## 5. Setup lease and the send commit

Each run has its own window and its own CDP session, so the answer wait is safe in
parallel. Steps that activate a tab or send input run under one **setup lease**: the
record `setup-lease` in the account store, owned by PID plus process start time (so a
reused PID never holds it), polled every 1 s, and taken over in place under the account lock
when its owner is dead, so nobody else can start setup while the new owner waits 60 s for
any command the dead owner already sent to settle. The lease serializes command issuance; it never replays a dead owner's
command. `chatgpt-run probe` takes the same lease. A malformed lease record fails closed
(`ACCOUNT_STATE_CORRUPT`). A release that keeps failing before the answer wait raises
`LEASE_RELEASE_FAILED`, so the lease is never silently left behind a live process.

Lease sections (each acquired and released explicitly, never held during the answer
wait, checks, or a recursive recovery):

- fresh setup: open, clear composer, attach Repo MCP, grant, paste, prepare, select
  effort, reserve, commit, click, send confirmation;
- recovery: reattach plus send confirmation; reattach for a submitted run;
- cleanup: reattach, archive, close tab;
- every error-path `closeTab`.

**Gap before prepare.** Before taking the lease, wait until the gap allows the next
attempt, then take the lease and check again; if no longer allowed, release and wait
again. A reached hourly cap does not wait: the request fails `RATE_LIMITED` before any
tab opens, and the same command resumes later. So no wait sits between selection (120 s window, 10 s observation) and
reserve.

**Send commit.** After reserve, under the task share gate (the gate `task finish` holds):
the task is still unfinished, then under the account lock, atomically: own slot present,
latch clear, attempts in the last hour below the effective cap, newest attempt bound at
least `min_gap_seconds` ago. If allowed, append `{id, at, bound: at + 120 s}`, then write
`send_intent_at` before leaving the share gate, and click once. After the user message is seen, set `confirmed_at`.
The gap and the hourly count use `confirmed_at` (the observed time, never earlier) when
present, else `bound`. The click is made only within 45 s of the commit; a later click is
not made, the run is resolved `not-submitted` (`SEND_LATE`) and the attempt stays charged.
When the click returns, the bound moves to at least that time. A click command that
failed or timed out may still run in Chrome: the bound moves to 60 s past the failure,
and the driver keeps the setup lease while it confirms for those 60 s. A CDP command
still unexecuted 60 s after its client timeout is assumed never to run (a hung tab);
this is the one transport assumption. A verified
challenge right before the commit, on every send-confirmation poll and after a click
error latches the account; before the commit it also stops this send. If the
commit is denied (latch, cap, gap), nothing was clicked: mark the run uncertain, recover
it as `not-submitted`, finish `failed` with the denial code, release the slot (exit 1).
An already committed attempt may still click even if the latch is set after its commit.

**Live freshness.** After reserve, if more than 10 s passed since the effort observation,
treat it like a denied commit (not-submitted, `SELECTION_STALE`).

## 6. Stop latch

- Set by the driver (when `latch_enabled`) on `BROWSER_CHALLENGE`: at setup, at every
  reattach, and on every poll of the answer wait (`page.accountSignal()`, document title
  of the verified Cloudflare check; never a scan of page text).
- Set or cleared by the owner: `chatgpt-run account latch --reason TEXT`,
  `chatgpt-run account unlatch --reason TEXT`.
- The latch write is retried. If the record cannot be written, `latch-fallback.json` in
  the account store stops admission and the send commit the same way; if neither can be
  written, the run fails with `LATCH_WRITE_FAILED` and keeps its slot. `latch_enabled`
  is read under the account lock. `account unlatch` clears both.
- Effect: no fresh admission, no uncommitted send. Waiting for answers, recovery,
  output capture and cleanup continue.
- Usage-limit and "too many requests" detection is deferred until captured page fixtures
  exist; the prompt text itself can contain those words.

## 7. Release

- Terminal paths release in a `finally` that wraps all cleanup (participant close,
  seal, checks, archive, manifest writes), so a failed cleanup write cannot keep a slot.
- `go --release-admission --reason` keeps its refusals (request lock held, submitted or
  unreadable journal), records the reason in `audit`, and removes only that slot.
- `chatgpt-run account release-slot --key KEY --reason TEXT` removes any slot,
  including a `legacy` one, and records the reason.
- SIGINT or SIGTERM: the driver frees its slot only when no send intent exists and the
  journal shows no run or a terminal run; otherwise the slot stays for `--resume`. It
  never releases the setup lease: dead-owner recovery waits out in-flight input.
- A coding run frees its slot only when its workspace (or unused grant) is verified
  revoked and no exec command of its task still runs. Otherwise every release path
  (finish, cleanup error, signal) keeps the slot, and `--resume` retries the seal and the
  remaining checks.
- A challenge whose latch could not be persisted keeps the slot on every path, including
  a denied send and a cleanup warning, and is stored in the manifest (`latch_pending`);
  every later run of that request retries the latch first.
- Coding recovery refuses `REPOSITORY_BUSY` beside any other coding slot on the checkout
  or any legacy slot; a request's own legacy slot is upgraded to its real kind and
  checkout.
- `account unlatch` removes the fallback marker and the record latch under one lock.
  Recovery of a coding run fails `REPOSITORY_BUSY` while another coding slot owns the
  checkout.
- An error after the send commit with the lease held waits 60 s before releasing it.
- `task finish` ignores a request lock whose PID now belongs to a process started after
  the lock was taken (PID reuse).
- A waiter or lease owner without a recorded start time is trusted for at most 6 h.

## 8. Migration from v1

Under the account lock, restartable:

1. If `account-v2` is missing: read `account` (v1). Create `account-v2` with its sends as
   attempts (`bound = at`, `confirmed_at = at`) and, if `active_request_id` is set and
   not the sentinel, one `legacy` slot with that key.
2. If `account` (v1) is missing or not the sentinel, write it with
   `active_request_id: "migrated-to-v2"`, also on a fresh install. Any 0.3 binary then
   gets `ACCOUNT_BUSY`.
3. Every v2 access repeats step 2 if needed, so a crash between the writes is repaired.

The owner deploys by stopping old `go` processes first (`account status` shows a legacy
slot if one was imported). A legacy slot is freed when its request reaches terminal
finish under v2 (same key) or by `account release-slot`.

## 9. Task lifecycle

- A `go` manifest is durable before admission. `task finish` (multirepo) refuses with
  `TASK_IN_USE`, under the task share gate, while any `go` manifest for the task is
  non-terminal and either has a run (`run_id`/`pending_run_id`) or its request lock is
  held by a live process. An unreadable or malformed manifest also refuses (fail closed).
- The send commit rechecks the task under the same gate, so a run that loses the race
  fails `TASK_FINISHED` before its intent: nothing is sent.
- Catalog control-lock contention waits up to 30 s (only acquisition is retried; the
  mutation is never replayed). Stale, corrupt and foreign-host locks still fail
  explicitly.

## 10. Coordinator recipes

- Request and workspace IDs get a random suffix: `...-$(date +%Y%m%dT%H%M%S)-$RANDOM`.
- Architecture: reuse an unfinished task if one exists; bind one only when none does.
  `task finish` may answer `TASK_IN_USE`: leave the task, the last finisher closes it.
- Review: rebind only when the task binding is actually stale; join the shared review.
  For a mixed review and architecture batch, set the review phase first.
- Coding: one per checkout; different checkouts run in parallel.
- `ACCOUNT_BUSY` no longer appears without `--no-wait`. `ACCOUNT_LATCHED`: report and
  stop. `REPOSITORY_BUSY`: another coding run owns that checkout.

## 11. CLI

- `go` waits by default; `--no-wait` keeps fail-fast.
- `chatgpt-run account status|config|config-set|latch|unlatch|release-slot`: no request,
  prompt or browser. One JSON result on stdout.
- New codes: `ACCOUNT_LATCHED`, `REPOSITORY_BUSY`, `ACCOUNT_CONFIG_INVALID`,
  `ACCOUNT_STATE_CORRUPT`, `SELECTION_STALE`, `TASK_IN_USE`. `RATE_LIMITED` and the gap
  are checked at the send commit and after a denied commit end the run with exit 1.

## 12. Tests

- Separate processes: N slots, FIFO order, `--no-wait`, dead waiter pruned, dead slot
  kept, PID reuse, lowering `max_concurrent`.
- Code + code on one checkout: `REPOSITORY_BUSY`; on two checkouts: both admitted.
- Recovery bypasses latch and full capacity; manually released request re-adopts a slot.
- Cleanup failures (participant, seal, checks, archive, manifest write) still release.
- Setup lease: fake pages record lease intervals; no overlap; never held during the
  answer wait; dead owner recovered.
- Send commit: gap and cap denials exit 1 with zero clicks and a `not-submitted` run;
  a stale selection likewise; a committed attempt clicks even if latched after commit.
- Latch: challenge at setup, reattach and wait; owner latch/unlatch need a reason.
- Migration: v1 sends and active request imported; v1 poisoned; crash between writes.
- Task finish: refused while a live or prepared `go` request uses the task.
- Config: defaults, set, invalid values, lower-only `--max-per-hour`.
- Existing recovery tests pass.
