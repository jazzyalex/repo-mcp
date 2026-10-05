---
name: repo-mcp-review
description: Review a local Git checkout only through its configured Repo MCP server when the user asks for an independent, policy-bounded code review.
---

# Repo MCP review

Use the configured Repo MCP server as the sole repository evidence source for this review. The MCP server name or tool prefix may vary by Claude Code configuration.

1. Call `repo_info` first. Verify the repository root, branch, HEAD, task ID, policy digest, and `review` phase against the user's review target. Stop with `NOT TESTABLE` if the server is unavailable, identity differs, or the task is not frozen for review.
2. Read the exposed root instruction file completely, following its cursor when present. Its instructions apply within the user's review scope.
3. Page through the complete `git_diff`. Use `list_files`, `search`, and bounded `read` calls to inspect surrounding code and tests. Do not use Claude Code filesystem, Git, shell, GitHub, or another repository connector as a fallback.
4. Do not call `edit` or `create_file`. Run only test suites explicitly exposed by `repo_info`; report runner limitations separately from code failures.
5. Treat the MCP policy as a scope boundary. State which files and suites were exposed and whether the full candidate diff was available. Never infer cleanliness outside that scope.
6. Report confirmed defects first, ordered by severity. For each finding give the file and line, concrete trigger, expected and actual behavior, impact, and smallest safe fix. Separate unconfirmed hypotheses. End with `SHIP`, `NO-SHIP`, or `NOT TESTABLE` and exact validation performed.

Do not commit, push, change branches, alter task phase, restart services, rotate credentials, or modify the checkout. Those remain coordinator actions.
