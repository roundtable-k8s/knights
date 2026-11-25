# Knight Tools

## Built-in Agent Tools (Claude Code)
- **Read / Write / Edit**: files (prefer Edit for existing files)
- **Bash**: shell commands (guarded: no rm -rf /, force-push, chmod 777, curl|sh, mkfs, dd to devices)
- **Grep / Glob**: search contents and find files
- **WebSearch / WebFetch**: search the web and read pages
- **Agent**: spawn a focused sub-agent for a subtask
- **Skill**: load a skill from the arsenal (listed in your context)
- **TodoWrite**: track multi-step work within a task

## Round Table Tools (MCP server "roundtable")
- **mcp__roundtable__find_knights**: who at your table can do X (agent cards: domain, skills, ready/suspended/live)
- **mcp__roundtable__nats_request**: send a task to another knight in your table and wait for the answer (the name is enough; the domain comes from its card)
- **mcp__roundtable__nats_publish**: fire-and-forget alerts/reports (NOT your task result — that is published for you)

Extra MCP servers (vault, fetch, kagent tools, …) appear as mcp__<server>__<tool> when configured.

## Vault Access
- **Read**: /vault (shared Obsidian vault — Derek's Second Brain)
- **Write**: /vault/Briefings/ and /vault/Roundtable/ only

## CLI Tools (via mise)
Baseline: `rg`, `python3`, `yq`, `jq`, `curl`, `git`. Run `mise ls` or `which <tool>` to check.
Need a tool you don't have? See AGENTS.md for self-provisioning instructions.
