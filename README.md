# Windows Power MCP

Windows Power lets an MCP-compatible coding agent schedule and manage shutdowns of the Windows host while the agent runs inside WSL.

The MCP server creates one named Windows Task Scheduler task. Windows owns the schedule after it is created, so the shutdown does not depend on the MCP server, Codex, or WSL staying open.

The task runs in the current Windows user's interactive session. Locking the computer is fine; signing out before the scheduled time is not supported.

## Tools

| Tool | Purpose |
| --- | --- |
| `schedule_shutdown` | Schedule by relative minutes or an RFC 3339 timestamp; replace the existing managed schedule |
| `get_shutdown_status` | Return the exact local/UTC shutdown time and remaining seconds |
| `postpone_shutdown` | Move the active shutdown by a signed number of minutes |
| `cancel_shutdown` | Remove the managed shutdown task |
| `shutdown_now` | Force shutdown after five seconds; requires `SHUTDOWN NOW` exactly |

Scheduled and immediate forced shutdowns can close applications without saving their work.

Example requests in Codex:

- “Shut down Windows in two hours.”
- “How long is left before shutdown?”
- “Postpone shutdown by 30 minutes.”
- “Cancel the shutdown.”

## Requirements

- Windows 10 or 11
- WSL with Windows interoperability enabled
- Windows PowerShell 5.1 and the ScheduledTasks module
- Node.js 20 or newer in WSL

The server uses `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` by default. Set `WINDOWS_POWER_POWERSHELL` when Windows is mounted somewhere else.

## Install

```bash
git clone https://github.com/WarLikeLaux/windows-power.git
cd windows-power
./scripts/install-local.sh
```

The included Codex plugin manifest starts the globally linked `windows-power-mcp` command. Add the plugin from your marketplace, then start a new Codex thread so its MCP tools and skill are discovered.

For another MCP client, configure the same stdio command:

```json
{
  "mcpServers": {
    "windows-power": {
      "command": "windows-power-mcp"
    }
  }
}
```

## Development

```bash
npm ci
npm test
npm run check
npm run build
```

Tests mock PowerShell and never schedule or trigger a real shutdown.
