---
name: windows-power
description: Schedule, inspect, postpone, cancel, or explicitly trigger Windows shutdown from Codex running in WSL. Use for requests about turning off the Windows host later or checking an existing Windows Power shutdown; do not use for restarting services or shutting down only WSL.
---

# Windows Power

Use the `windows-power` MCP tools as the authoritative interface. The named Windows scheduled task is the source of truth and continues independently of Codex and WSL.

- Convert ordinary relative requests such as “in two hours” to `schedule_shutdown.afterMinutes`.
- For an absolute time, pass RFC 3339 with the user's timezone offset. If the requested time is ambiguous or already past, ask what they mean.
- Report the exact local shutdown time and a concise remaining duration from the tool result.
- `schedule_shutdown` replaces this plugin's existing schedule. Mention when the result says it replaced one.
- Use `postpone_shutdown` for signed adjustments and `cancel_shutdown` for cancellation.
- Never call `shutdown_now` unless the user explicitly requests immediate shutdown and has explicitly confirmed the exact destructive action. Its forced close can discard unsaved work.
- Do not claim a shutdown was scheduled, changed, or canceled unless the MCP result confirms it.
