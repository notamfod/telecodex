# TeleCodex Rich Messages Design

## Goal

Publish completed Codex answers in Telegram forum topics with Bot API rich messages. TeleCodex must preserve the current stage indicator, durable delivery guarantees, attachment order, and compatibility with jobs that already contain legacy Telegram payloads.

## Product behavior

While Codex works, the existing status anchor continues to show the current stage. TeleCodex does not stream partial answer text in this phase.

After `turn/completed`, TeleCodex publishes the final answer with Rich Markdown:

- headings, lists, tables, quotations, fenced code, links, footnotes, `details`, and formulas retain their structure;
- generated images appear inside the rich message at their output position;
- other files remain separate Telegram attachments;
- a single text-only answer replaces the status anchor;
- an answer with embedded images, files, or several delivery parts leaves `Response follows.` in the anchor and sends the parts in their original order.

## Scope

This work covers final Codex answers delivered by the durable Telegram response path:

- Rich Markdown sanitization and bounded splitting;
- generated-image embedding through `InputRichMessage.media`;
- typed `sendRichMessage` and rich `editMessageText` calls through grammY;
- durable `send_rich` and `edit_rich` payloads;
- deterministic HTML fallback after a proven rich-message rejection;
- backward compatibility with existing `send_text`, `edit_text`, and `send_media` rows.

## Non-goals

This phase does not:

- stream generated answer text;
- call `sendRichMessageDraft`;
- move TeleCodex from forum supergroups into private chats;
- combine status, tool activity, and final output into one live message;
- embed documents, video, audio, voice notes, collages, or slideshows;
- convert Markdown into explicit `InputRichBlock` trees;
- change Codex app-server turn execution or status projection semantics;
- deploy, restart systemd services, or send live Telegram smoke messages without separate approval.

`sendRichMessageDraft` is excluded because Bot API 10.2 limits it to private chats. TeleCodex topics currently use forum message threads, so the existing stage updates remain the only live progress surface.

## Selected approach

Upgrade grammY from 1.41.1 to 1.45.1, which uses `@grammyjs/types` 4.0.0 and exposes typed Bot API 10.2 rich-message methods.

The domain layer gains explicit rich delivery payloads. The response planner produces Rich Markdown and stable local media references. The grammY transport performs the final `InputFile` conversion. This keeps Telegram SDK types out of the durable plan and allows persisted payloads to survive a process restart.

Direct untyped `api.raw` calls are not used. Explicit rich block trees are deferred because Rich Markdown already covers the selected content and avoids introducing a second document model.

## Architecture

```text
Codex app-server deltas
        |
        v
Telegram turn observation
  accumulates final output
        |
        v
Rich message formatter
  sanitize + split + media IDs
        |
        v
Telegram response planner
  edit_rich | send_rich | send_media
        |
        v
SQLite delivery outbox
        |
        v
grammY transport
  InputRichMessage + InputFile
        |
        v
Telegram Bot API 10.2
```

### Turn observation

The current app-server path remains unchanged. `item/agentMessage/delta` notifications are accumulated in memory and committed as `TelegramTurnResult` only after the exact turn completes. Generated images remain durable attachment references under the materialization root.

The stage presenter continues to update the status anchor independently. A text delta does not trigger a Telegram API call.

### Rich message formatter

A focused formatter accepts ordered `TelegramTurnResult` content and returns normalized rich segments. It does not depend on grammY.

For text, the formatter preserves Telegram-supported Rich Markdown and applies an allowlist to raw HTML. Unsupported tags are escaped and shown as text. Links remain clickable only for `https`, `http`, `tg`, and `mailto` schemes. A local path or unsupported scheme is rendered as readable non-clickable text; the durable outbox remains responsible for delivering actual files.

For generated images, the formatter assigns deterministic IDs such as `generated_001`. It inserts `tg://photo?id=generated_001` at the attachment's position and stores the matching durable image reference beside the Markdown. IDs, ordering, and resulting content are identical when the same turn result is planned again.

An ordinary file closes the current rich segment. The planner emits the file through the existing media operation, then begins another rich segment for later text or images. This preserves the output order for sequences such as text, document, text.

### Response planner

`TelegramDeliveryPayload` gains two strict variants:

```text
edit_rich:
  chatId, messageId, markdown, media, fallbackParts

send_rich:
  chatId, messageThreadId, markdown, media, replyMarkup?, fallbackParts
```

Media entries contain a stable ID, kind, durable relative path, and optional bounded name. Only `image` is accepted in rich media for this phase. Absolute paths, parent traversal, control characters, unknown keys, unsupported media kinds, and unbounded strings are rejected before persistence.

`fallbackParts` are canonical legacy delivery payloads produced from the same source segment during initial planning. They are persisted with the primary rich payload, so fallback never has to reconstruct content from mutable runtime state. The primary content hash covers the complete normalized payload, including its fallback description.

If the result contains exactly one text-only rich segment and the status anchor has a known message ID, the planner emits `edit_rich`. Otherwise the anchor becomes `Response follows.` and the planner emits ordered `send_rich` and existing attachment parts.

Empty output and public failure notices retain their current deterministic behavior.

### grammY transport

The transport accepts domain payloads and maps them to the typed grammY API:

- `send_rich` calls `api.sendRichMessage(chatId, richMessage, options, signal)`;
- `edit_rich` calls `api.editMessageText(chatId, messageId, richMessage, options, signal)` using the exact signature supplied by grammY 1.45.1;
- `message_thread_id` is included for new messages in a forum topic;
- each rich image becomes an `InputRichMessage.media` entry containing an `InputMediaPhoto` with a contained local `InputFile`;
- Markdown references the same entry through `tg://photo?id=<stable-id>`.

The transport resolves every local file below the configured attachment root, rejects symlinks and escapes before any network write, and keeps the existing request deadline.

## Rich Markdown rules and limits

The formatter enforces Bot API 10.2 limits:

- at most 32,768 UTF-8 characters in one rich message;
- at most 500 blocks, including nested blocks and list or table items;
- at most 16 levels of nesting;
- at most 50 media attachments;
- at most 20 columns in a table.

It uses conservative local budgets and treats Telegram as the final parser. When a segment exceeds a limit, the formatter splits it at top-level Markdown boundaries. It does not split inside fenced code, a table, a `details` block, a quotation block, a formula, or a footnote definition. A fenced code block that cannot fit is divided into independently closed fences with the language marker repeated.

If a single indivisible construct cannot fit a rich message, that segment uses its precomputed legacy fallback instead of emitting invalid Rich Markdown.

## Durable delivery and error handling

Rich operations follow the existing outbox safety model.

### Safe edit behavior

`edit_rich` targets a known `message_id`. A timeout or restart may safely queue the same edit again. Telegram `message is not modified` confirms that the intended content is already present and is treated as delivered.

### Ambiguous send behavior

`send_rich` creates a new message. If the request times out or the connection fails after the write may have occurred, the delivery becomes `uncertain`. TeleCodex does not retry it automatically and exposes the existing warned resend or inspect actions.

After restart, an unfinished `edit_rich` returns to the pending queue. An unfinished `send_rich` becomes uncertain, matching the rules for current text and media sends.

### Rate limiting

Telegram `429` with a bounded `retry_after` schedules the same rich operation without consuming a delivery attempt. It does not switch to fallback.

### Proven rich rejection

Fallback is allowed only when Telegram proves that the rich operation was not accepted.

The error classifier distinguishes rich formatting or unsupported-method responses from unrelated permanent errors such as a missing topic or insufficient permission. It stores bounded internal codes and never persists or displays an unbounded raw Telegram error.

For a rejected `edit_rich`, the outbox replaces the operation with its canonical `edit_text` fallback for the same known message.

For a rejected `send_rich`, a new SQLite transaction:

1. verifies the exact job version, delivery state, attempt count, and content hash;
2. records a `delivery.replanned` event with a bounded reason;
3. removes the rejected undelivered rich part from the projected response plan;
4. inserts deterministic legacy fallback parts with their own keys and hashes;
5. updates the job projection and commits before any fallback Telegram call.

The fallback pump starts only after this transaction commits. A crash cannot leave an in-memory-only fallback or silently repeat the rejected rich request.

If Telegram reports that `sendRichMessage` is unavailable, the process marks rich delivery unavailable until restart. Pending rich parts that have not reached an ambiguous network state are replanned through the same transaction. Already delivered and uncertain parts are never rewritten.

### Local formatting failure

A sanitizer, limit, or local media validation failure before the Telegram request produces the legacy plan directly. It does not consume a rich delivery attempt. Missing or unsafe local media cannot be converted into a network ambiguity.

## Compatibility

Existing SQLite rows containing `send_text`, `edit_text`, and `send_media` remain valid and execute through their current code paths. Rich payloads are additive JSON variants; no existing payload is rewritten during startup.

The database schema needs only the new append-only replan event and transactional ledger operation if the current columns can store the new JSON payloads and part keys unchanged. If implementation proves a schema change is necessary, it must use the repository's existing transactional migration pattern and preserve every current job, delivery row, message ID, and attention state.

The planner remains deterministic. Rebuilding an already installed response plan must produce byte-for-byte identical part keys, payloads, ordering, and content hashes or fail with the existing plan-conflict behavior.

## Testing

### Formatter tests

- headings, nested lists, task lists, tables, quotations, fenced code, inline code, `details`, formulas, footnotes, and references;
- supported raw HTML and escaped unsupported tags;
- safe links and non-clickable local or unsupported links;
- Unicode-safe character limits and splitting;
- block, nesting, table-column, and media budgets;
- deterministic image IDs and image placement;
- no split inside protected Markdown structures;
- fallback for an oversized indivisible construct.

### Planner tests

- one text-only result becomes one stable `edit_rich` anchor operation;
- text with generated images becomes ordered `send_rich` content;
- documents remain separate existing media operations;
- text, file, text ordering is preserved;
- empty output and failure notices remain deterministic;
- equivalent input produces identical keys, payloads, and hashes;
- legacy payload normalization and hashes remain unchanged.

### Transport tests

- exact typed arguments for `sendRichMessage` and rich `editMessageText`;
- exact forum `message_thread_id` routing;
- matching Markdown media IDs and `InputRichMessage.media` entries;
- contained `InputFile` creation and symlink or traversal rejection before a Telegram call;
- bounded deadlines and error classification;
- `message is not modified` only succeeds for known edits.

### Outbox and ledger tests

- `429` retries the same operation after the requested delay;
- timed-out `send_rich` becomes uncertain and is not automatically retried;
- timed-out `edit_rich` remains safely retryable;
- explicit rich rejection atomically installs fallback rows;
- a failed fallback transaction leaves the original row and plan unchanged;
- two outbox instances cannot both replan or send the same part;
- restart recovery distinguishes rich sends from rich edits;
- unavailable-method mode replans only safe pending parts;
- existing SQLite fixtures and legacy delivery rows still reconcile and complete.

### Repository verification

Before implementation is reported complete, run:

```text
npm test
npm run check:web
npm run build
git diff --check
```

## Live verification boundary

Local implementation does not authorize Telegram messages, service restarts, or deployment.

With separate approval, live verification should use a designated test topic and cover:

- a short text answer that replaces the stage anchor;
- a table, `details` block, formula, quotation, and fenced code;
- a generated image embedded in the rich message;
- a document delivered separately in the correct position;
- a controlled malformed-rich case that proves HTML fallback without duplication.

After deployment, verify the exact running service PID, restart count, startup logs, delivery state, and rendered Telegram result. A merged or built change alone is not deployment proof.
