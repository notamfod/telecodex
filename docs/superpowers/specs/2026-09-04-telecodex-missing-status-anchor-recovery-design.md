# TeleCodex Missing Status Anchor Recovery Design

## Status and scope

The recovery behavior was selected in chat on 2026-09-04 and the detailed
design was approved for implementation planning. The microstep handles one
exact Telegram failure: an existing status message was deleted, so
`editMessageText` returns HTTP 400 with `message to edit not found`.

The change applies to future failures and to the one pre-existing blocked job.
It does not retry a Codex turn, rebuild response content, or treat other
Telegram 4xx responses as recoverable.

## Confirmed failure path

The durable status presenter edits the job's known status-anchor message.
Telegram definitively reports that the target message no longer exists. The
current classifier records the generic `telegram_status_edit_failed` state.

The response plan orders the status anchor before ordinary `final` and
`notice` parts. A failed anchor therefore blocks those parts. The existing
Retry action repeats the same edit against the deleted message ID, so it cannot
make progress.

## Selected behavior

TeleCodex will distinguish a missing edit target from other permanent errors.
Only an edit response with Telegram error code 400 and the bounded description
`message to edit not found` is eligible.

After that proof, TeleCodex atomically replaces the active edit lease with a
pending `send_text` anchor:

- the old Telegram message ID becomes null;
- the replacement uses the validated durable source for the exact chat and
  topic;
- a live progress replacement uses the current durable status projection and
  regenerates its actions;
- an installed response-plan replacement preserves the exact planned anchor
  text rather than replacing it with a status-card rendering;
- the attempt counter advances once for the failed edit;
- the row records `telegram_status_message_missing`;
- the next send is immediately eligible.

The replacement send follows the normal durable-delivery rules. A confirmed
send stores the new message ID and releases the following response parts. A
timeout or unknown acceptance becomes `uncertain` and stops automatically. A
429 keeps the row pending until Telegram's retry deadline. Other 4xx responses
remain failed.

## Components

### Telegram error classification

`src/telegram-grammy-transport.ts` recognizes the exact missing-message error
for edit operations. `src/turn-progress.ts` accepts a dedicated
`message_missing` disposition only for edits. Broad text matching is forbidden.

### Atomic anchor replacement

`src/telegram-status-anchor-ledger.ts` defines the replacement input and pure
validation. `src/telegram-delivery-ledger.ts` performs one compare-and-swap
transaction against the exact delivery state, attempt count, content hash,
lease deadline, and message ID. The replacement does not require an unchanged
job version because a concurrent Codex activity event may legitimately advance
the projection while the Telegram edit is in flight.

The transaction accepts only a `sending` status-anchor whose current payload
is an `edit_text` of the expected missing message. The replacement must be a
valid `send_text` payload for the same chat and text. Its topic comes from the
validated durable source context. When a response plan is installed, the same
transaction replaces the matching `status_anchor_plans` payload and hash,
because terminal delivery validation compares the physical anchor with that
durable plan. A live progress anchor has no installed plan row. Any mismatch
writes nothing.

### Runtime continuation

`TelegramDurableStatusService` owns live progress recovery because it can
combine the validated durable destination with the current canonical status
projection. The presenter uses the atomic replacement when a live status edit
proves the target missing, then immediately prepares the regenerated
projection as a replacement send.

After response-plan installation, `TelegramDeliveryOutbox` owns recovery. The
dashboard keeps its existing versioned `retry_delivery` action and retries the
exact planned edit once. If Telegram proves that target missing, the outbox
converts that planned payload to a topic-bound send through the same atomic
ledger operation. A confirmed replacement releases the existing `final` and
`notice` parts in order. Ordinary failed parts keep their existing retry path.
There is no second Codex turn and no regeneration of final response content.

## Existing blocked job

The live recovery runs only after the new candidate passes tests and is active.
TeleCodex selects the existing job through its normal dashboard action, not by
weakening the database state directly. The outbox retries the exact stored
planned edit once. If Telegram again proves the target missing, the new path
recreates the planned anchor in the original topic and continues the two
pending parts. Any different response stops the recovery.

Before the action, record a fresh SQLite backup and require exactly one matching
blocked plan, zero `sending` rows, and no active Codex turns. Do not print the
job ID, message ID, payload, or response text.

## Tests

- classify only code 400 plus the exact missing-message description;
- reject lookalike descriptions, other 400 errors, sends, and oversized text;
- replace the exact active edit lease and clear the missing message ID;
- replace the matching durable anchor plan in the same transaction;
- roll back on every stale identity or payload mismatch;
- automatically send a replacement anchor after a live missing edit;
- require an explicit Retry for a previously failed anchor;
- regenerate current status actions for live progress recovery;
- preserve the installed anchor-plan payload for historical recovery;
- route failed installed `status-anchor` recovery through the outbox;
- leave ordinary failed delivery retries on the existing outbox path;
- keep a replacement-send timeout uncertain and never resend it automatically;
- continue `final` and `notice` exactly once after confirmed replacement;
- preserve normal 429 and permanent-error behavior.

## Release and acceptance

Build outside the live `dist` trees. Run focused tests, the full suite,
Svelte checks, TypeScript checks, staged server and web builds, and
`git diff --check`.

Install only after the release gate proves no active turn and no `sending`
delivery. After restart, require healthy service and Guardian state, zero new
quarantine rows, and zero historical legacy status candidates.

The microstep is accepted when the old plan reaches terminal delivery with all
parts delivered, no duplicate or uncertain send appears, release preflight is
safe, and a ten-minute observation shows no 429 loop, restart, quarantine, or
new delivery failure.
