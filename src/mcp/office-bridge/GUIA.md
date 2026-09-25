# Office Bridge MCP v1 — Quick Reference

## What it does

Lets ChatGPT / Codex submit work to Michael (the orchestrator), observe tasks,
add context, request cancellation, and inspect office state — all through the
standard MCP protocol over local stdio.

## 5 tools

| Tool | What it does | Returns |
|---|---|---|
| `compose_submit` | Send an instruction to Michael | task_id, message_id, status, receipt |
| `task_get` | Read task status + details | status, title, owner, blocked reason, receipts |
| `task_message` | Add context to a task thread | message_id, receipt |
| `task_cancel` | Request safe cancellation | cancellation_requested, receipt |
| `office_status` | Office health + roster + task counts | available, michael_state, roster, task_counts, breaker |

## How to connect

### Option A — Codex CLI (already configured)

Your `~/.codex/config.toml` now has:

```toml
[mcp_servers.office-bridge]
command = "node"
args = ["/ABS/PATH/munder-difflin/src/mcp/office-bridge/server.js"]
startup_timeout_sec = 10

[mcp_servers.office-bridge.env]
HIVE_ROOT = "/ABS/PATH/your-harness/hive"
AGENT_ID = "codex-bridge"
```

Restart Codex Desktop or run `codex mcp list` to verify it shows up.

### Option B — ChatGPT Desktop app

1. Open **Settings → MCP Servers**
2. Click **Add Server**
3. Choose **STDIO**
4. Fill in:
   - **Name:** office-bridge
   - **Command:** `node`
   - **Args:** `/ABS/PATH/munder-difflin/src/mcp/office-bridge/server.js`
   - **Env:** `HIVE_ROOT=/ABS/PATH/your-harness/hive`
5. Save → Restart

### Option C — Manual test (any MCP client)

```bash
HIVE_ROOT="/ABS/PATH/your-harness/hive" \
  node /ABS/PATH/munder-difflin/src/mcp/office-bridge/server.js
```

Then send JSON-RPC messages to stdin.

## Example: submit a compose

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "compose_submit",
    "arguments": {
      "compose": "Write a README for the project",
      "title": "Project README",
      "priority": 3
    }
  }
}
```

Response:
```json
{
  "protocol": "office-bridge@1",
  "task_id": "task-1758436800000-a1b2c3d4",
  "message_id": "2026-09-21T...",
  "status": "accepted",
  "receipt": { "id": "...", "timestamp": "...", "kind": "compose_submitted", "correlation_id": "..." }
}
```

## Where things go

- Message → `hive/agents/god/inbox/<message-id>.json`
- Task → `hive/tasks.json`
- Audit log → `hive/log.jsonl`

## Traps

- `HIVE_ROOT` must be set or the server refuses to start
- The server is stateless per connection — it reads/writes files each time
- `office-bridge` is `defaultEnabled: false` in the Munder catalog — you must
  enable it in AI Settings if using the Hive's MCP integration (separate from
  the Codex config above)
- ChatGPT web (browser) does NOT support local stdio servers — only the desktop
  app or Codex CLI
