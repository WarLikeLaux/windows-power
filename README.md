# Windows Power MCP

Windows Power lets an MCP-compatible coding agent schedule Windows shutdowns from WSL, wait for HAPI agents to finish overnight, and set output volume to 0%.

The MCP server creates one named Windows Task Scheduler task. Windows owns the schedule after it is created, so the shutdown does not depend on the MCP server, Codex, or WSL staying open.

The task runs in the current Windows user's interactive session. Locking the computer is fine. Signing out before the scheduled time is not supported.

Missed shutdown times are skipped. If Windows is off at the scheduled time, starting it later does not run the old shutdown.

## Tools

| Tool | Purpose |
| --- | --- |
| `schedule_shutdown` | Schedule by relative minutes or an RFC 3339 timestamp and replace the existing managed schedule |
| `get_shutdown_status` | Return the exact local/UTC shutdown time and remaining seconds |
| `postpone_shutdown` | Move the active shutdown by a signed number of minutes |
| `cancel_shutdown` | Remove the managed shutdown task |
| `shutdown_now` | Force shutdown after five seconds, requiring `SHUTDOWN NOW` exactly |
| `schedule_night_shutdown` | Mute Windows immediately, check local HAPI work every 15 minutes, and force shutdown at the deadline |
| `mute_audio` | Set default console, multimedia and communications outputs to 0% and verify |

Scheduled and immediate forced shutdowns can close applications without saving their work.

Example requests in Codex:

- “Shut down Windows in two hours.”
- “How long is left before shutdown?”
- “Postpone shutdown by 30 minutes.”
- “Cancel the shutdown.”
- «Выключи комп после 2, но не позже 5»

## Night shutdown

The last example waits for HAPI work after 02:00 and shuts down no later than 05:00. Volume becomes 0% immediately when the plan is set up. Canceling a plan leaves the volume at 0%.

Windows owns two scheduled tasks: `WindowsPowerMcpHapiCheck` invokes the installed Node checker in WSL every 15 minutes, and `WindowsPowerMcpShutdown` independently enforces the forced deadline. They continue after the requesting conversation or MCP process closes. The checker requires two successful idle observations at least one polling interval apart and refreshes HAPI immediately before early shutdown. This adds at least 15 minutes of confirmation after the first idle observation.

The checker uses HAPI's API and the local machine identity. Working agents, tracked background tasks, pending user questions or approvals, and scheduled messages due by the deadline keep Windows on. Open idle conversations do not delay shutdown. An unavailable or incompatible HAPI response resets idle confirmation. The forced deadline remains independent of HAPI and WSL. Activity can still begin after the final API snapshot, so avoid scheduling new work once shutdown is imminent.

`get_shutdown_status` reports the window and latest check, including blockers. Postponing shifts both window times and resets confirmation. Cancellation removes both tasks. Setting a regular shutdown replaces the night plan. A passed earliest time with a future deadline starts checking in about a minute.

Early shutdown removes both tasks before requesting Windows shutdown. If cleanup fails, the checker does not request shutdown. A missed forced deadline is skipped, so a completed night plan cannot shut down Windows again after the next startup.

The checker requires a registered HAPI machine and access token. It reads `HAPI_HOME/settings.json` (default `~/.hapi/settings.json`) and honors `HAPI_API_URL`, `CLI_API_TOKEN` and `HAPI_EXTRA_HEADERS_JSON`. `WINDOWS_POWER_HAPI_URL` and `WINDOWS_POWER_HAPI_MACHINE_ID` can explicitly select the hub and local machine identity. The token's namespace determines session visibility, so use the namespace containing your local sessions.

For autonomous checks, connection credentials are persisted in `~/.local/state/windows-power/night.json`, or under `XDG_STATE_HOME`, with file permissions 0600 and directory permissions 0700. Latest check results are stored alongside it without credentials. Keep the installed checkout, Node executable, WSL distribution and Windows user session available until shutdown. Updating a plan reuses these files. Cancellation removes the tasks and leaves the private connection file for subsequent use.

The CLI also works in an existing conversation whose MCP tool list has not refreshed:

```bash
windows-power-mcp night --after 2026-10-05T02:00:00+06:00 --deadline 2026-10-05T05:00:00+06:00
windows-power-mcp status
windows-power-mcp postpone --minutes 30
windows-power-mcp cancel
windows-power-mcp mute
```

Use full dates with timezone offsets. Optional `--interval 5` changes the polling interval. Running the command with no arguments starts the MCP stdio server.

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

Automated tests build the executable, use a local HTTP server for HAPI, and mock Windows operations. On Windows or WSL with Windows PowerShell available, lifecycle tests execute the generated PowerShell scripts with real ScheduledTasks value constructors, replacing task storage and shutdown with test fixtures. They never schedule or trigger a real shutdown.
