# Repo MCP agent entry point

When the user asks to install, configure, upgrade, connect, or operate Repo MCP, read and
follow `.codex/skills/repo-mcp/SKILL.md`. Run the setup for the user; do not turn the
normal path into a list of shell commands for them to copy.

For first-time setup, install the bundled global skills with
`python3 scripts/install-agent-skills.py --install`. Ask the user only for account-bound
steps that the agent cannot complete, such as creating the OpenAI tunnel/runtime
credential or connecting/refreshing the ChatGPT app.

For a ChatGPT web architecture pass through Repo MCP, use
`.codex/skills/repo-mcp-architect/SKILL.md`; Codex remains the local coordinator.
