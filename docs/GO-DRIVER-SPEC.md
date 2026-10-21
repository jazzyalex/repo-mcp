# `chatgpt-run go` driver specification

Status: v1, 2026-10-21. This is step 1 of `docs/AUTONOMOUS-RUN-PLAN.md`. It covers the
architecture kind only. Review and code reuse this spec later.

The run journal (`src/chatgpt-run.ts`, `src/model-policy.ts`) stays the authority. `go`
is a trusted browser adapter. It performs the picker action, rereads the live control,
and records evidence itself. It adds no new run states.

## 1. Invocation identity

```
chatgpt-run go --request-id ID --repository ID --task ID --coordinator claude|codex
  --kind architecture [--profile architecture] --prompt-file FILE
  [--timeout-minutes 45] [--max-per-hour 4] [--state-dir PATH]
chatgpt-run go --resume --request-id ID [--state-dir PATH]
chatgpt-run go --release-admission --request-id ID [--state-dir PATH]
chatgpt-run relay
chatgpt-run probe
```

- **`request_id`** (`[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`): the caller's key for one logical
  pass.
- **`request_digest`:** `sha256` of a canonical JSON of repository, task, coordinator,
  kind, profile and prompt digest.
- **Same ID and same digest:** the call resumes the existing invocation. It never
  prepares a second run.
- **Same ID and a different digest:** the call fails with `REQUEST_CONFLICT`.
- **`session_id`:** `go-<first 16 hex of the request digest>-<random 8 hex>`. It is fixed
  at the first call, stored in the manifest, and used for every journal call. A
  conversation ID is never passed to the journal, because adding one later changes the
  bound context hash.
- **Output:** each call prints one JSON line to stdout:
  `{request_id, phase, run_id, run_state, conversation_url, output_file, cleanup, failure_code}`.
  - The exit code is 0 for `completed`.
  - The exit code is 3 for a held `uncertain` run.
  - The exit code is 1 for a terminal failure.

## 2. Driver manifest

The manifest lives in `StateStore` under `chatgpt-go/<sha256(request_id)>` with kind
`chatgpt-go-v1`, inside the owner state dir, mode 600, outside any served repo. Fields:

| Field | Set at |
|---|---|
| `request_id`, `request_digest`, `repository_id`, `task_id`, `coordinator`, `kind`, `profile`, `prompt_sha256`, `prompt_file`, `session_id`, `created_at` | creation |
| `phase` | every step (see 3) |
| `target_id` | tab opened |
| `run_id`, `selection_id` | prepared |
| `send_intent_at` | **written before the Send click** |
| `conversation_url` | first `/c/<uuid>` URL seen (placeholders such as `/c/local-chatgpt` are ignored) |
| `submission_event_id`, `submission_event_sha256` | submitted |
| `output_file`, `output_sha256` | completed |
| `cleanup` | `pending` / `archived` / `warning:<code>` |
| `failure_code`, `updated_at` | as needed |

The prompt text is not stored. `output_file` is written next to the manifest
(`chatgpt-go/<hash>.output.md`, mode 600). The saved journal output stays the
authoritative copy.

## 3. Driver phases

```
admitted → tab-ready → prepared → reserved → send-intent → submitted → completed → cleaned
                    ↘ failed (pre-submit, terminal)        ↘ uncertain (held)
```

| Phase | Meaning |
|---|---|
| `admitted` | The account admission is held for this request (section 5). |
| `tab-ready` | The tab is open, Repo MCP is attached, the prompt is pasted and read back equal. No run exists yet. |
| `prepared` | `prepareChatGptRun` returned. The 120 s selection window runs. |
| `reserved` | The observation is recorded and `reserveChatGptRun` returned `submission_authorized: true`. |
| `send-intent` | The intent is persisted. The click may or may not have happened. |
| `submitted` | `markChatGptRunSubmitted` succeeded. |
| `completed` | `completeChatGptRun` succeeded and `chatGptRunOutput` matches the capture. |
| `cleaned` | The chat is archived, or archiving failed and a warning is recorded. Terminal success either way. |
| `failed` | Terminal pre-submit failure. The run is `failed-pre-submit` or was never prepared. |
| `uncertain` | The run is `uncertain` and admission is held. |

## 4. Recovery table (`--resume`, or the same command again)

The action depends on the journal state first, then on the manifest phase.

| Journal run state | Manifest | Action |
|---|---|---|
| none | `admitted` / `tab-ready` | Restart the browser setup in a new tab, then continue. Nothing was prepared. |
| `prepared` | any | `fail-pre-submit DRIVER_INTERRUPTED`. Phase `failed`. A new pass needs a new `request_id`. |
| `verification-pending` | any | `fail-pre-submit DRIVER_INTERRUPTED`. Reserve did not finish, so no send was authorized. |
| `submission-reserved` | no `send_intent_at` | The click is ordered after the intent write, so no send happened. Run `uncertain DRIVER_INTERRUPTED`, then `recover not-submitted`. Phase `failed`. |
| `submission-reserved` | `send_intent_at` set | Reattach to `target_id` or `conversation_url`, and look for the expected user message (section 6). If found, `submitted`. If not found, or the tab is gone, run `uncertain SEND_UNCONFIRMED` and hold. **Never click Send again.** |
| `submitted` | any | Reattach, wait, capture, complete. |
| `uncertain` | URL known and user message found | `recover submitted`, then continue as `submitted`. |
| `uncertain` | otherwise | Report `uncertain`, exit 3, and hold admission. |
| `completed` | any | Check `chatGptRunOutput` against `output_sha256`, rewrite the output file atomically if it is missing or altered, then retry cleanup only. Every rerun of a finished request does the same file check. |
| `failed-pre-submit` | any | Report the terminal failure and release admission. |

A reserve result with `submission_authorized: false` means the run is already
`submission-reserved`, so the row above applies. `go` never prepares a replacement run
inside the same request.

## 5. Account admission and process lock

Before any journal transition during recovery, `go` calls `recoverChatGptRunLock`,
which removes a journal run lock only when its owner process is dead.

- **Process lock:** `acquireLock(store, 'chatgpt-go-<hash16>')` for the life of the
  process.
  - A second `go` for the same request fails with `REQUEST_BUSY`.
  - A lock whose owner PID is dead is recovered.
- **Account admission:** one record per machine, in
  `~/Library/Application Support/repo-mcp/chatgpt-account/account` (kind
  `chatgpt-go-account-v1`), because every state dir drives the same ChatGPT account.
  It holds `{active_request_id, since, sends: [ISO times, last 24 h]}`. The admission
  key is `<request_id>@<hash of state dir>`.
  - It is changed only under the `chatgpt-go-account` lock.
  - A lock left by a dead process is recovered, so a crash cannot block resume.
- **Acquire:**
  - The request manifest is written first, then admission is claimed. A crash between
    the two leaves a resumable request, never an orphaned admission. A request refused
    with `ACCOUNT_BUSY` resumes with the same command once the account is free.
  - The step runs before the browser is touched and before any grant or prepare.
  - It fails with `ACCOUNT_BUSY` if another request is active.
  - It fails with `RATE_LIMITED` if the number of sends in the last hour is at least
    `--max-per-hour` (default 4).
  - A request may re-acquire its own admission.
- **Release:** only when the request reaches `cleaned` or `failed`.
  - A timeout, a crash or a dead PID does **not** release it.
  - `uncertain` keeps it.
  - `--release-admission` is the explicit operator escape.
    - It takes the request lock first, so it cannot race a live `go`.
    - It refuses while the run is `submitted`, and it refuses if the journal cannot be read.
    - It always needs a reason.
- **History:** a send is added to the history at `send-intent`, so it is counted even
  if the run never resolves.

## 6. Browser contract (`src/chatgpt-browser.ts`, `src/cdp-relay.ts`)

- **Browser:** the owner's main, signed-in Chrome, with remote debugging switched on in
  `chrome://inspect/#remote-debugging`. Chrome asks for approval on every new DevTools
  connection, so a local relay (`chatgpt-run relay`, started on demand by `go`) holds
  one connection per Chrome start. It serves `go` runs over an owner-only Unix socket
  under `~/Library/Application Support/repo-mcp/relay/`. When Chrome restarts, the relay
  exits. The next `go` starts a new one, and Chrome asks for approval once.
- **Startup:** `go` never starts Chrome and never signs in. If the endpoint is missing,
  approval is not given in 5 minutes, or the page is signed out, it fails with
  `BROWSER_UNAVAILABLE` / `BROWSER_APPROVAL_TIMEOUT` / `CHATGPT_SIGNED_OUT` before any
  prepare.
- **Tabs:** each run opens its own window through `Target.createTarget` and closes
  nothing else. Plain Chrome under CDP has `navigator.webdriver` false, which avoided
  the Cloudflare check that blocked agent-browser.
- **Uniqueness:** every selector query must return exactly one visible match. Zero or
  several matches fail with `UI_AMBIGUOUS:<name>` or `UI_MISSING:<name>`.
- **Input:** clicks use `Input.dispatchMouseEvent` at the element center, and text uses
  `Input.insertText`. There is no clipboard.
- **Composer read-back:** whitespace-normalized composer text must equal the
  normalized prompt.
- **Fallback render:** a conversation can render in a fallback mode that shows only the
  running assistant turn. If the page shows no user message at all, `go` reloads the tab
  once. The running turn is not affected.
- **Expected user message:** the last user message in the conversation contains the
  first 300 normalized characters of the prompt. A length check is not used, because
  ChatGPT collapses long user messages ("Show more"). Each run starts a fresh
  conversation, so a head match identifies the run's own message.
- **Turn state:**
  - `busy` when a Stop control is present or the last `data-talvt-turn-state` is not
    `complete`.
  - `done` only when the turn marker is `complete`, no Stop control shows, and a visible
    assistant message after the expected user message has nonempty text. Hidden or inert
    fallback copies and the "ChatGPT said:" label do not count.
  - `unknown` otherwise.
  - Completion needs two `done` reads 15 s apart with equal text length.
  - `unknown` for more than 10 minutes in a row gives `uncertain`
    (`COMPLETION_UNOBSERVED`), and so does the overall timeout.
- **Capture:** `Runtime.evaluate` with `returnByValue` of the last assistant message's
  `innerText`.
- **Archive:** click the conversation "More" control, then the "Archive" menu item, then
  confirm that the URL leaves `/c/<id>`.

## 6a. Run marker and preparation

- **Run marker:** the text sent is `Run <16 hex of request hash>`, a blank line, then the
  prompt. The journal's `prompt_sha256` covers that exact text. Recovery matches the
  marker, so it cannot adopt another chat that starts with the same prompt.
- **Run ID:** it is preallocated (`pending_run_id`) and written before
  `prepareChatGptRun`. If prepare throws after publishing, or the process dies before
  `run_id` is saved, resume adopts the published run and recovers it. Such a run is not
  orphaned.
- **Prompt on resume:** a resume loads the prompt from the saved `prompt_file` and checks
  its digest. A missing file only blocks steps that need the browser. A completed run
  still finishes cleanup without it.

## 7. Receipts

- **Submission:** `browser_event_id` = `chatgpt-go-send-<conversation id>-<observed ISO>`.
- **Completion:** `chatgpt-go-complete-<conversation id>-<observed ISO>`.
- **Recovery:** `chatgpt-go-recover-<request hash16>-<observed ISO>`.
- **Session binding:** all receipts carry `sessionId = session_id` and no
  `conversationId`.
- **Freshness:** `observedAt` is taken right before the journal call. It stays within
  the journal's 60 s receipt freshness.

## 8. Tests (fault injection with a fake page, no live browser)

1. The happy path reaches `cleaned`, and admission is released.
2. A crash after prepare: resume gives `failed-pre-submit` and no send.
3. A crash after reserve, before the intent: resume gives `failed`
   (`CONFIRMED_NOT_SUBMITTED`) and the fake records zero clicks.
4. A crash after the intent, with the message present: resume gives `submitted` and
   then `cleaned`, with exactly one click.
5. A crash after the intent, with the message absent: resume gives `uncertain`, exit 3,
   admission held, and a second resume still makes no click.
6. A second request while one is active gives `ACCOUNT_BUSY`. Over the rate gives
   `RATE_LIMITED`.
7. The same `request_id` with a different prompt gives `REQUEST_CONFLICT`.
8. An archive failure gives `cleaned` with `warning`, and the output is kept.
9. An ambiguous selector before send gives `failed` before prepare, or
   `failed-pre-submit` after it.
10. A lost final output: rerunning the same command returns the stored result without
    browser actions.
