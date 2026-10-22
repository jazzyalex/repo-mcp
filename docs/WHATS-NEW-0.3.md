# What's new in Repo MCP 0.3

Status: v0.3.0 is unreleased `main` after the v0.2.3 tag. macOS only.

Repo MCP 0.3 lets a coding agent (Codex or Claude Code) hand a whole ChatGPT job to
ChatGPT web and get the result back, with no human pasting prompts. ChatGPT does the
coding, review or architecture work through Repo MCP. The agent only starts the job and
reads the result.

## You ask in plain words

- "Use Repo MCP to code this task."
- "Use Repo MCP Extra High to review this change."
- "Use Repo MCP Pro to design an architecture for this feature."

Codex or Claude handles repository registration, task IDs, grants, the browser,
recovery, the saved output, checks and cleanup.

## `chatgpt-run go`: one command runs one ChatGPT job

The agent runs `npm run chatgpt-run -- go` in the background. `go` then:

1. Opens a normal ChatGPT Chat in your own signed-in Chrome.
2. Attaches Repo MCP.
3. Selects the requested effort:

   | Job | Profile | ChatGPT effort |
   |---|---|---|
   | Coding | `code` | High |
   | Hard coding | `code-hard` | Extra High |
   | Review | `review` | Extra High |
   | Critical review | `review-critical` | Pro |
   | Architecture | `architecture` | Pro |
   | Architecture, when you ask for it | `architecture-xhigh` | Extra High |

   It selects effort labels, not model names, so a model rename does not break it.
4. Sends the prompt exactly once. The send intent is saved before the click, and
   recovery never sends again.
5. Waits for ChatGPT to finish, in code. The agent does not poll the page, so waiting
   costs it no tokens.
6. Saves the complete answer locally and records it in the run journal.
7. Cleans up for the job kind:
   - **Review:** releases the shared review participant.
   - **Code:** revokes the coding workspace ("seal"), so no edit can land after the
     answer is saved. Then it runs your `--check` commands (tests, typecheck, lint) and
     reports whether they changed the checkout.
8. Archives the finished ChatGPT conversation, so finished chats do not pile up. The
   answer is saved before the archive.

For coding, `go` creates the single-use write grant itself and adds it to the message it
sends. The grant never sits in a prompt file. `go` never commits; you or your agent
review and commit.

The result is one JSON line. Exit 0 means done. Exit 3 means the prompt may have been
sent, so the agent may only resume. Exit 1 means nothing was sent, or the run failed.

### Related commands

| Command | What it does |
|---|---|
| `go --resume` | Continues the same interrupted job. It never sends the prompt again. |
| `go --status` | Shows the saved state and output of a job. |
| `go --release-admission --reason TEXT` | Frees a stuck account reservation. It needs a reason and refuses unsafe cases. |
| `relay` | Keeps one approved Chrome DevTools connection open. Chrome asks you once per Chrome start. |
| `probe` | Checks the ChatGPT controls and sign-in. It never sends anything. |

### Guard rails

- Several ChatGPT jobs run at once (unreleased, after 0.3.0): coding in different checkouts, and reviews
  and architecture passes on one checkout. Owner limits: `max_concurrent` (10),
  `max_per_hour` (25), `min_gap_seconds` (30) and a stop latch, set with
  `chatgpt-run account config-set`. A job with no free slot waits in code.
- Each workspace request ID can be used only once, so an old workspace or report can
  never attach to a new job.
- A review completes only with a workspace that ChatGPT opened after this job's send.
  A coding answer without a coding workspace is held, not reported as done.

## New tools for ChatGPT

| Tool | What it does |
|---|---|
| `finish` | ChatGPT sends its complete final report to the coordinator, once, before it closes the workspace. `go` saves that report as the answer. If ChatGPT does not call it, `go` saves the page text instead. `finish` does not finish the repository task. |
| `exec` | Runs a build, tests, lint or a typecheck in a coding workspace. |
| `exec_poll` | Pages through the output of a long-running command. |
| `exec_cancel` | Stops the command's process group. |

`exec` is restricted on purpose:

- The coordinator must turn it on for that one coding grant
  (`coord workspace grant --exec` or `go --exec`).
- Review and architecture workspaces can never use it.
- It runs as your macOS user, with no sandbox.
- One command runs per task. The default limit is 10 minutes, the maximum 30 minutes.
- Output is capped at 4 MiB. Known token formats are redacted.
- Git commit and push stay outside MCP.
- Use it only with repositories and prompts you trust. See
  [EXEC-TOOL.md](EXEC-TOOL.md) and [../SECURITY.md](../SECURITY.md).

## Other improvements

- **Parallel reviews.** Several read-only reviewers can share one repository target.
  Each keeps its own workspace, result and ChatGPT conversation.
- **One coding owner.** Only one coding workspace controls a task at a time.
- **Chat-only repositories.** `coord repository surface-policy --mode chat-only` rejects
  ChatGPT Work for a repository.
- **Garbage collection.** `coord gc` removes expired grants, workspaces, captures and
  finished runtime records. It keeps evidence that an unresolved run still needs.
- **Safer task finishing.** Expired workspaces no longer block finishing a task. Live
  protected workspaces still do.
- **Claude as coordinator.** Claude Code can now coordinate ChatGPT coding, review and
  architecture jobs, as Codex can. ChatGPT web still does the repository work through
  Repo MCP.
- **Patched MCP SDK.** The server and client SDKs moved to 2.3.1 for four published
  advisories. `npm audit` is clean.

## What it saves

On one measured review of about 2,000 changed lines, the coordinating agent (Claude
Sonnet) used 68,576 tokens with `go`. The same agent reviewing the diff directly used
141,710 tokens. That is about 52% less. The direct review was also shallower than
ChatGPT at Extra High, so 52% is a lower bound for equal depth. Most of the remaining
cost is fixed overhead, so larger jobs should save more and trivial ones less. This is
one task, not a benchmark. Details: [AUTONOMOUS-RUN-PLAN.md](AUTONOMOUS-RUN-PLAN.md).

## Requirements and limits

- macOS, with Repo MCP installed and connected to ChatGPT (see [../SETUP.md](../SETUP.md)).
- Your main Chrome, signed in to ChatGPT, with remote debugging turned on in
  `chrome://inspect/#remote-debugging`.
- After an upgrade that adds tools: run `npm run build`, restart with
  `npm run coord -- service start`, then click "Refresh tools" for Repo MCP in ChatGPT
  Settings > Plugins. Older conversations can keep the old tool list, so start a new one.
- `go` depends on the ChatGPT page layout. When the layout changes, `go` fails before it
  sends (`UI_*` codes), and `probe` shows which control is missing. Manual recipes remain
  as a fallback: [ARCHITECT-MANUAL-RECIPE.md](ARCHITECT-MANUAL-RECIPE.md),
  [REVIEW-MANUAL-RECIPE.md](REVIEW-MANUAL-RECIPE.md),
  [CODING-MANUAL-RECIPE.md](CODING-MANUAL-RECIPE.md).
- You are responsible for following the terms of every service you connect to Repo MCP.

Reference: [GO-DRIVER-SPEC.md](GO-DRIVER-SPEC.md), [EXEC-TOOL.md](EXEC-TOOL.md),
[HOW-IT-WORKS.md](HOW-IT-WORKS.md).
