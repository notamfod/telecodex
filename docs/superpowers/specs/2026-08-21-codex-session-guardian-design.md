# Codex Session Guardian Design

## Goal

Detect stalled user-visible Codex sessions across ChatGPT Remote, TeleCodex, and direct CLI usage, notify the user in Telegram, and recover only the exact stalled turn after explicit confirmation.

The guardian must preserve session history, avoid global app-server restarts, and never interrupt a turn merely because it is slow.

## Scope

The first version covers all non-archived root threads returned by the shared Codex app-server. It excludes internal subagent threads from separate alerts because they are not opened independently and their lifecycle belongs to the parent thread.

The work includes:

- a standalone `codex-session-guardian` process managed by systemd;
- persistent observation and alert state;
- Telegram notifications and confirmation callbacks through the existing TeleCodex bot;
- a local CLI for inspection and repair;
- a registered `codex-session-repair` skill that uses the CLI;
- tests for detection, recovery, restart safety, and authorization.

The first version does not automatically repair sessions, restart the shared app-server, monitor archived sessions, or repair subagent threads independently.

## Components

### Guardian daemon

The guardian is a separate TypeScript entrypoint in the TeleCodex repository and runs as its own systemd service. It reuses the existing app-server client and Telegram configuration but has an independent lifecycle from `telecodex.service`.

It connects to the existing app-server control socket, pages through `thread/list`, reads candidate threads with `thread/read`, records observation fingerprints, and sends deduplicated Telegram alerts.

### Persistent state

Guardian state is stored in a dedicated SQLite database with file mode `0600`. The database contains only operational metadata:

- thread and turn IDs;
- observation timestamps and fingerprints;
- alert IDs and Telegram message locations;
- repair attempts and outcomes;
- suppression and deduplication state.

Conversation text, tool output, prompts, credentials, and other secrets are not stored.

### TeleCodex adapter

TeleCodex remains the only process that consumes Telegram updates. The guardian may call Telegram `sendMessage` with the existing bot token, but it does not poll for updates.

Repair buttons contain a random opaque alert ID. TeleCodex validates the configured user and chat, then forwards the alert ID to the guardian through a local Unix socket. UUIDs and repair commands are not embedded in callback data.

### CLI and skill

The guardian package exposes these commands:

- `status` reports daemon and app-server connectivity;
- `scan` performs one observation cycle without repair;
- `inspect <UUID>` reports the current thread and turn state;
- `repair <UUID>` performs the guarded recovery algorithm after an explicit invocation.

The `codex-session-repair` skill is registered under `~/.codex/skills`. It triggers for requests to inspect, repair, reopen, or unstick a Codex session by UUID. It always runs `inspect` first and calls `repair` only when the user explicitly requested a state change.

## Detection

The guardian scans once per minute by default. A thread becomes a candidate only when:

- it is a non-archived root thread;
- its thread status is `active`;
- its last turn status is `inProgress`;
- its observation fingerprint has not changed for ten minutes.

The fingerprint contains the thread ID, turn ID, thread update time, item count, and last item type. After the ten-minute threshold, the guardian waits for the next scan and requires a second identical fingerprint before creating an alert.

Slow work can therefore produce a warning, but it is never interrupted automatically. A new item, changed turn ID, updated timestamp, completion, interruption, or idle status clears the candidate.

One alert is created for each `threadId + turnId` pair. Repeated scans update observation state without sending duplicate messages.

## Notification routing

If the thread is mapped to a TeleCodex context, the alert is posted in that Telegram topic. Otherwise it is posted in a configured `Codex Guardian` fallback topic.

The alert includes:

- the thread name when available;
- the full thread UUID;
- its source and working directory;
- how long the fingerprint has remained unchanged;
- the last item type;
- a single `Restore` button.

It does not include prompt or response content.

## Recovery algorithm

Pressing `Restore` does not immediately interrupt the saved turn. The guardian performs these steps:

1. Load the alert and reject unknown, completed, expired, or already-running requests.
2. Read the current thread and compare its live fingerprint with the alerted fingerprint.
3. If the thread progressed or became idle, perform no mutation and mark the alert as self-recovered.
4. If the same turn is still active with the same fingerprint, interrupt that exact `threadId + turnId`.
5. Poll with a bounded timeout until the thread becomes idle. Do not continue if it remains active.
6. Archive the exact thread to evict its in-memory app-server state.
7. Unarchive the thread. If any operation after a successful archive fails, still attempt unarchive before reporting failure.
8. Resume and read the thread again.
9. Report success only when the thread is idle, its turns are readable, and it can accept direct input.

The operation is idempotent. Concurrent or repeated requests for the same alert share one repair attempt. The guardian never restarts the app-server and never repairs a different thread as a fallback.

## Failure handling

App-server connection failures use bounded exponential backoff. They pause scanning and repair without changing thread state.

Telegram delivery failures remain recorded and are retried without creating a new alert. If TeleCodex is unavailable, monitoring continues, but button callbacks wait until the bot reconnects.

Every repair step has a timeout and a structured outcome. Telegram messages are edited to one of:

- checking;
- restored;
- self-recovered;
- no longer eligible;
- failed with a concise operational reason.

No failure path escalates to a bulk daemon restart.

## Configuration

Configuration is additive and environment-driven:

- scan interval, default 60 seconds;
- stale threshold, default 10 minutes;
- confirmation scans, default 2;
- app-server socket path;
- guardian Unix socket path;
- SQLite path;
- fallback Telegram chat and topic IDs;
- observation-only mode;
- repair-enabled flag.

The first deployment starts in observation-only mode. The guardian detects and reports candidates, while the button performs only a fresh state check. Repair is enabled after live alerts are reviewed for false positives.

## Security

- Telegram callbacks are accepted only from the configured user and chat.
- Callback payloads contain opaque random alert IDs.
- Thread IDs are validated as UUIDs at the CLI and service boundaries.
- The Unix socket is accessible only to the service user.
- State files use mode `0600`.
- Logs and alerts exclude conversation content and secrets.
- Repairs require an explicit button press or explicit CLI/skill request.

## Testing

Unit and integration tests use a fake app-server client and cover:

- candidate timing and two-scan confirmation;
- progress that clears a candidate;
- completed and idle threads;
- exclusion of subagent threads;
- alert deduplication across daemon restart;
- authorization and opaque callback IDs;
- state changes between alert and button press;
- interruption of only the recorded turn ID;
- bounded waiting for idle;
- unarchive compensation after partial failure;
- concurrent and repeated repair requests;
- final verification of history readability and direct input;
- observation-only behavior;
- app-server disconnect and reconnect.

A live smoke test first runs `scan` and `inspect` without mutation. A controlled test thread is repaired only after the observation-only alerts have been reviewed.

## Deployment

The implementation adds a separate systemd unit with restart-on-failure behavior. It does not change ownership of `telecodex.service` or the shared app-server daemon.

Deployment order:

1. build and run the focused and full test suites;
2. install the guardian unit and registered skill;
3. start in observation-only mode;
4. verify app-server connectivity, scanning, state persistence, and Telegram routing;
5. review real candidates;
6. enable repair callbacks;
7. perform one controlled end-to-end recovery and verify the exact thread afterward.
