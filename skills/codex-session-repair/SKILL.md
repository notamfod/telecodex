---
name: codex-session-repair
description: Use when an operator needs to inspect, diagnose, repair, restore, reopen, or unstick a Codex session across ChatGPT Remote, Telegram, or CLI, including when the session identifier is missing, partial, or ambiguous.
---

# Codex Session Repair

Use the bundled `scripts/codex-session-repair` wrapper. A complete session UUID is mandatory. Never infer or substitute `recent`, `latest`, or `current`.

## Workflow

1. Run `scripts/codex-session-repair inspect UUID` first.
2. Treat the CLI JSON outcome as evidence. If the request only asks to inspect, diagnose, check what happened, or report history, stop after inspection and report it without mutation.
3. Run `scripts/codex-session-repair repair UUID` only when the user explicitly asks to repair, restore, reopen, fix, `почини`, `восстанови`, or `перезагрузи` that same UUID.
4. After repair, always run `scripts/codex-session-repair inspect UUID` again. Claim success only when this post-inspection confirms it; otherwise report the observed state and blocker.

If the daemon is unavailable or times out, or reports observation-only or repair-disabled mode, report that blocker honestly. Do not bypass it.

## Quick Reference

| Request | Allowed action |
|---|---|
| Inspect, diagnose, or "what happened?" | `inspect UUID`, then report |
| Explicit repair verb for the same UUID | `inspect UUID`, `repair UUID`, `inspect UUID` |
| Missing or partial UUID | Ask for the full UUID |
| Daemon unavailable or repair disabled | Report the blocker; stop |

## Common Mistakes and Red Flags

- Running raw `codex resume` instead of the guardian wrapper.
- Restarting the guardian, TeleCodex, or app-server.
- Repairing another session as a workaround.
- Treating a repair command alone as proof of recovery.
- Repeating the observed RED failure: the baseline chose raw `codex resume`, then restarted shared TeleCodex without guardian inspect/repair.

Any of these means stop and return to the explicit UUID and guardian workflow.
