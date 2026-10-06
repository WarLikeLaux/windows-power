---
name: windows-power
description: Schedule Windows shutdown from WSL, including HAPI-aware night shutdown with a forced deadline and immediate volume 0%. Use for shutdown schedules, their status or cancellation, and muting Windows audio.
---

# Windows Power

Use the `windows-power` MCP tools as the authoritative interface. The named Windows scheduled task is the source of truth and continues independently of Codex and WSL.

## Night shutdown

Requests such as «выключи комп после 2, но не позже 5» mean: wait for HAPI agents on this computer after 02:00, force shutdown at 05:00, and immediately set Windows output volume to 0%.

- Use `schedule_night_shutdown` with `after` and `deadline` as RFC 3339 timestamps in the user's timezone. Omit `checkEveryMinutes` to use 15 minutes.
- For an overnight request, resolve the next relevant night window. If the earliest time has passed but the deadline is still ahead this night, use that window. The tool starts checking in about a minute. If both times have passed, use the next night. A window crossing midnight ends on the following date.
- The requested deadline authorizes forced shutdown at that time. Report the two local times, the 15-minute default and volume 0% when the result confirms them.
- The checker waits for agent turns, tracked background work, user questions or permissions, and scheduled messages due before the deadline. Two successful idle checks separated by the polling interval are needed for early shutdown. An API error resets confirmation and leaves the independent deadline armed.
- `get_shutdown_status` includes the night window and latest check with blocking sessions. `postpone_shutdown` shifts both ends of a night window and restarts idle confirmation. `cancel_shutdown` cancels both Windows tasks. A regular shutdown schedule replaces the night mode.
- If this already-open conversation has an older MCP tool list, use the installed one-shot CLI for night scheduling and subsequent management: `windows-power-mcp night --after <RFC3339> --deadline <RFC3339>`. Optional `--interval <minutes>` changes the interval. Use `windows-power-mcp status`, `postpone --minutes <signed minutes>`, `cancel` or `mute`. New conversations discover the updated MCP tools.

## Regular shutdown and audio

- Convert ordinary relative requests such as “in two hours” to `schedule_shutdown.afterMinutes`.
- For an absolute time, pass RFC 3339 with the user's timezone offset. If the requested time is ambiguous or already past, ask what they mean.
- Report the exact local shutdown time and a concise remaining duration from the tool result.
- `schedule_shutdown` replaces this plugin's existing schedule. Mention when the result says it replaced one.
- Use `postpone_shutdown` for signed adjustments and `cancel_shutdown` for cancellation.
- Never call `shutdown_now` unless the user explicitly requests immediate shutdown and has explicitly confirmed the exact destructive action. Its forced close can discard unsaved work.
- Do not claim a shutdown was scheduled, changed, or canceled unless the MCP result confirms it.
- Use `mute_audio` for volume 0%. Night scheduling already includes this action. Canceling a schedule does not restore volume.
