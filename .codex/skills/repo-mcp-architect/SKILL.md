---
name: repo-mcp-architect
description: Coordinate a ChatGPT Sol Pro architecture pass over an approved local repository through Repo MCP.
---

# Repo MCP ChatGPT architect coordinator

Repo MCP architecture means **ChatGPT web performs the architecture work** using Repo
MCP as its repository evidence source. Codex prepares the local read-only workspace and
controls the browser. Do not replace the requested ChatGPT Pro pass with Codex analysis.

1. Resolve the current Git root and follow its instructions. Locate the Repo MCP control
   checkout from the installed service definition.
2. Resolve or register this exact checkout with a narrow read-only policy. Reuse a safe
   unfinished inspect task or bind a fresh internal task. Architecture does not require a
   coding grant or review freeze unless the user explicitly asks to analyze one frozen
   candidate.
3. Use host-native browser control with the user's signed-in ChatGPT conversation and
   require Repo MCP to be attached. Use model profile `architecture`, which requires Sol
   Pro. Prepare and reserve a durable `chatgpt-run` immediately before the one
   submission. Submit only when `submission_authorized` is `true`, then record
   submitted/completed state with fresh browser receipts. Do not invoke `model-policy run`
   or Oracle unless the user explicitly names Oracle.
4. Give ChatGPT the exact internal repository/task IDs. Require it to call
   `service_info`, `repository_list`, `workspace_open` in `inspect` mode, and `repo_info`;
   verify root/branch/HEAD/policy; read all instructions; inspect relevant source through
   bounded Repo MCP reads/search; state assumptions and evidence; and make no edits.
5. Recover the same submitted conversation after interruption. If model selection, Repo
   MCP attachment, repository identity, or completion cannot be verified, return
   `NOT TESTABLE` without substituting Codex or Oracle.

Report `Execution surface: ChatGPT web`, `Coordinator: Codex`, verified Sol Pro profile,
`Repository evidence: Repo MCP`, repository/task IDs for recovery, and exact scope and
limitations.
