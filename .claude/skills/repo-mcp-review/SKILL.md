---
name: repo-mcp-review
description: Review one operator-registered local Git task read-only through the permanent Repo MCP multi-repository broker.
---

# Repo MCP review

Use Repo MCP as the sole source-code evidence source. The server/tool prefix may vary by
Claude Code configuration. The user does not need to know or supply repository IDs, task
IDs, policies, grants, or workspace tokens. When the user says "review this repository",
the current Claude Code Git checkout is the unambiguous target. Resolve and prepare its
Repo MCP selection yourself, then keep the identifiers internal.

This skill performs the review in the current **Claude Code** process and therefore uses
the user's Claude allowance. Repo MCP supplies repository evidence; it does not launch
ChatGPT or choose a ChatGPT model. If the user explicitly asks for a ChatGPT web review
or for Codex-token savings through ChatGPT, stop and return that request to the local
operator workflow instead of claiming that this Claude review satisfies it. The final
report must say `Execution surface: Claude Code` and `Repository evidence: Repo MCP`.

## Resolve or prepare the current checkout

This bootstrap is local coordinator work, not review evidence. It may use the shell only
to identify the current Git root and operate Repo MCP; after the workspace opens, inspect
repository content only through MCP.

1. Resolve `git rev-parse --show-toplevel` in the current session. Do not search sibling
   repositories or infer another checkout from conversation history. If the user names a
   different repository, follow the host's repository-mismatch rule.
2. Locate the Repo MCP control checkout from the installed server plist as described by
   the global `repo-mcp` skill.
3. Run `npm run --silent coord -- repository resolve --repo CURRENT_ROOT` there. Reuse
   the returned registration. If none exists, copy the bundled read-only policy to an
   owner-only external policy file and register this exact checkout. Generate the internal
   repository ID from a sanitized/truncated checkout basename plus the first 12 hex digits
   of SHA-256(canonical root); generate a fresh bounded review task ID from that ID, UTC
   time, and random hex. Do not ask the user to invent an ID or paste a path.
4. Reuse the one unfinished task for that registration when it is already in `review`.
   Otherwise bind a fresh internal task ID and set it to `review`. Never freeze an
   unfinished `coding` task that may still have an active coding agent; if that is the
   only task, report the single concrete blocker instead of presenting IDs as user work.
5. Do not echo bearer tokens. Repository/task IDs may be included in the final report for
   recovery, but they are not inputs the user must manage.

1. Call `service_info`. Require the multi-repository explicit-token contract and the
   expected server version/schema. Stop with `NOT TESTABLE` if the broker is unavailable.
2. Call `repository_list`. Confirm the internally resolved REPOSITORY_ID/TASK_ID exists
   and the task is in `review`. Do not guess between unrelated registrations.
3. Call `workspace_open` with that repository/task, mode `review`, and a fresh
   `request_id`. Do not request or use a coding write grant. Treat the returned
   `workspace_token` as a bearer secret: use it for tool calls but do not quote or log it.
4. Call scoped `repo_info` with the token. Verify canonical root, branch, HEAD, task ID,
   phase, policy digest and response scope against the review target. Require
   `review_assurance=phase_only` unless a future content-verified candidate contract is
   explicitly present; do not call a phase-only freeze an immutable candidate.
5. Read the exposed root instruction file completely with the same token and every
   returned continuation cursor. Its instructions apply within the user's review scope.
6. Select and page through the complete `git_diff` with the same token:
   - For uncommitted changes, omit `base_ref`.
   - For the latest committed change, or when a request to review "my changes" finds an
     empty default diff, use `base_ref: "HEAD^"` and require the response to identify its
     resolved `base_commit`.
   - If the user names a base branch, tag, or commit, pass it as `base_ref`.
   - An empty default diff is valid only for an explicit whole-repository audit. Never
     return `SHIP` for a requested change review merely because the working tree is clean.
   Continue every page with the same `base_ref`. Use scoped `list_files`, `search`, and
   bounded `read` to inspect surrounding implementation and tests. Workspace-wrapped
   cursors must remain in this workspace/tool. Report the selected base and resolved commit.
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

Do not issue/revoke grants, restart service, commit, push, change branches/worktrees,
rotate credentials, or modify the checkout. Registration and creation/freezing of a new
review task are allowed only during the local bootstrap above; they never count as review
evidence.
