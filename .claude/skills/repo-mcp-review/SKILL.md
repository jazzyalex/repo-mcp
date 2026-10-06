---
name: repo-mcp-review
description: Review one operator-registered local Git task read-only through the permanent Repo MCP multi-repository broker.
---

# Repo MCP review

Use Repo MCP as the sole repository evidence source. The server/tool prefix may vary by
Claude Code configuration. The review target must provide or unambiguously identify the
registered REPOSITORY_ID and TASK_ID; never accept a filesystem root or policy path as an
MCP selection argument.

1. Call `service_info`. Require the multi-repository explicit-token contract and the
   expected server version/schema. Stop with `NOT TESTABLE` if the broker is unavailable.
2. Call `repository_list`. Confirm the requested REPOSITORY_ID/TASK_ID exists and the
   task is in `review`. Do not guess between multiple repositories/tasks.
3. Call `workspace_open` with that repository/task, mode `review`, and a fresh
   `request_id`. Do not request or use a coding write grant. Treat the returned
   `workspace_token` as a bearer secret: use it for tool calls but do not quote or log it.
4. Call scoped `repo_info` with the token. Verify canonical root, branch, HEAD, task ID,
   phase, policy digest and response scope against the review target. Require
   `review_assurance=phase_only` unless a future content-verified candidate contract is
   explicitly present; do not call a phase-only freeze an immutable candidate.
5. Read the exposed root instruction file completely with the same token and every
   returned continuation cursor. Its instructions apply within the user's review scope.
6. Page through the complete `git_diff` with the same token. Use scoped `list_files`,
   `search`, and bounded `read` to inspect surrounding implementation and tests.
   Workspace-wrapped cursors must remain in this workspace/tool.
7. Do not call `edit`, `create_file`, or `run_tests`. Review mode is read-only.
   Coordinator-supplied test/typecheck evidence may be reported as supplied evidence,
   never as something this review executed.
8. Use no Claude filesystem, Git, shell, GitHub, or another repository connector as a
   fallback for repository evidence. A workspace failure/stale token is not permission to
   infer state from another source.
9. Treat the MCP policy as the review scope boundary. State whether the complete paginated
   diff and needed surrounding files were available. Never infer cleanliness outside it.
10. Report confirmed defects first, ordered by severity. Give file/line, concrete trigger,
    expected versus actual behavior, impact, and smallest safe fix. Separate hypotheses.
    End with `SHIP`, `NO-SHIP`, or `NOT TESTABLE` and exact validation performed.

If repairs are needed, return findings to the coding workflow. The operator must change the
task back to coding and issue a new coding grant; the review token must never be upgraded.

Do not register repositories, alter policy/task phase, issue/revoke grants, restart service,
commit, push, change branches/worktrees, rotate credentials, or modify the checkout.
Those remain operator/coordinator actions.
