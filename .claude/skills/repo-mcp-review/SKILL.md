---
name: repo-mcp-review
description: Coordinate an independent ChatGPT web review of one local Git task through the permanent Repo MCP broker.
---

# Repo MCP ChatGPT review coordinator

Repo MCP review means **ChatGPT web performs the semantic review** and Repo MCP is its
only source-code evidence source. Claude is the local coordinator. Do not review the
source in Claude and do not identify Claude as the execution surface.

The user does not need to know or supply repository IDs, task IDs, policies, grants,
workspace tokens, browser-tab references, or model-policy files. Resolve and prepare the
current checkout, use Claude's host-native browser controls to launch or recover the
signed-in ChatGPT conversation, and keep internal identifiers out of the user workflow.

## Prepare the current checkout

This bootstrap is local coordinator work, not review evidence.

1. Resolve `git rev-parse --show-toplevel` in the current session. Do not search sibling
   repositories or infer another checkout from conversation history.
2. Locate the Repo MCP control checkout from the installed server plist as described by
   the global `repo-mcp` skill.
3. Run `npm run --silent coord -- repository resolve --repo CURRENT_ROOT`. Reuse the
   registration. If none exists, create an owner-only external read-only policy and
   register this exact checkout. Do not ask the user to invent an ID.
4. Reuse one unfinished review task when it is safe. Otherwise bind a fresh internal task
   and set it to `review`. Never freeze an unfinished coding task owned by another agent.
5. Record repository ID, task ID, root, branch, HEAD, policy digest, and intended diff
   base for the ChatGPT prompt. No write grant is needed.

## Run ChatGPT web through Repo MCP

1. Use Claude's host-native browser controls with the user's existing signed-in ChatGPT
   session. The selected conversation must have Repo MCP attached.
2. Prepare a durable `chatgpt-run` for kind `review`. Profile `review` requires Sol Extra
   High. Use `review-critical` / Sol Pro only when the user explicitly requests Pro or a
   critical review. After selecting the live ChatGPT control, record the trusted browser
   observation, reserve the run immediately before the one prompt submission, submit only when
   `submission_authorized` is `true`, and record submitted/completed state. Do not invoke `model-policy run` or Oracle unless the user
   explicitly names Oracle.
3. Submit one prompt containing the exact internal repository/task IDs and requiring
   ChatGPT to:
   - call `service_info` and `repository_list`;
   - open a fresh `review` workspace and keep its token private;
   - call `repo_info` and verify root, branch, HEAD, task, phase, and policy;
   - read the complete root instructions;
   - read every page of the selected `git_diff` and needed surrounding files;
   - use the exact immutable resolved base commit recorded by `chatgpt-run`; never
     reinterpret a movable name or choose `HEAD^` after preparation;
   - make no edits and run no unapproved tools;
   - report confirmed findings first, validation limits, and `SHIP`, `NO-SHIP`, or
     `NOT TESTABLE`.
   Never return `SHIP` merely because the working tree is clean; use the requested
   committed diff base and verify the complete diff.
4. If the browser controller stalls after submission, recover the same conversation/run.
   Never submit a duplicate merely because the response is slow or the controller lost
   completion state.
5. If model selection, Repo MCP attachment, repository identity, complete diff, or final
   response cannot be verified, return `NOT TESTABLE`. Do not substitute Claude's own
   review or silently invoke Oracle.

For every work kind, completion must use a trusted finished-response receipt with
`kind: "completion"`, `responseState: "completed"`, the submitted event hash, and
the observed output digest. Never reuse the submission event or derive browser proof
from supplied output text. The `complete` CLI requires `--response-state completed`,
`--submission-event-sha256`, and `--output-sha256`.
After a crash during initialization or terminal cleanup, use explicit
`chatgpt-run recover-request --request-key REQUEST_KEY` as documented in `SETUP.md`;
unresolved runs must still be recovered by their existing run identity. Reclaim an
orphan only after the helper proves its initializer is dead on this host.

## Report contract

Every result must state:

- `Execution surface: ChatGPT web`
- `Coordinator: Claude Code`
- verified model/profile when available
- `Repository evidence: Repo MCP`
- repository/task IDs for recovery
- selected diff base and resolved commit
- exact validation limits

Repo MCP currently provides a task-wide phase freeze (`phase_only`), not a
content-verified candidate manifest. Do not claim stronger assurance.

If repairs are needed, return the findings to the Codex coding coordinator. Claude does
not issue coding grants, edit through Repo MCP, commit, push, restart services, or change
branches/worktrees in this review workflow.
