# TeleCodex Telegram Output Quality Cycle

## Goal

Make TeleCodex Telegram output safe, compact, and easy to scan without weakening durable delivery guarantees. The cycle covers four related problems:

- Telegram errors can expose a bot token when a library includes the request URL in an exception;
- ordinary Markdown answers are sent as native Rich Messages even when compact Telegram HTML would render them better;
- code, commands, configuration, and logs need predictable fenced formatting;
- the Dashboard topic repeats one `Details` button per job and duplicates too much session detail.

The work is split into independently releasable steps. Each step has focused tests, repository verification, a separate production gate, and post-release checks. A later step never has to wait for the whole cycle.

## Confirmed current behavior

The durable response planner currently routes final text through `formatTelegramRichResult`. Valid ordinary Markdown therefore becomes `send_rich` or `edit_rich`. Legacy Telegram HTML is used only when rich formatting is locally rejected or Telegram proves that the rich operation is unsupported.

The rich transport is active. The observed problem is presentation, not a blanket loss of rich delivery: native rich lists make routine answers visually large, while adjoining paragraphs remain dense.

The Dashboard renderer reserves a `Details` action for every displayed canonical job. `boardKeyboard` then ends every button with `row()`, so each action occupies a full row. The repeated buttons in Telegram are a direct result of this policy.

Error helpers currently bound string length but do not redact credentials embedded in URLs. Logging a raw grammY or fetch error can therefore disclose the bot token.

## Product principles

1. Preserve meaning, not a specific Telegram transport.
2. Use the lightest representation that renders the answer correctly.
3. Keep one clear visual hierarchy per message.
4. Never rewrite or summarize the model's answer merely to make it shorter.
5. Never split inside a code fence or another indivisible Markdown structure.
6. Never log credentials, message content, prompts, payloads, or Telegram identities in delivery diagnostics.
7. Keep existing durable outbox, replay, uncertainty, and duplicate-send rules unchanged unless a step explicitly says otherwise.

## Selected presentation model

TeleCodex uses a deterministic hybrid selector for every final text segment.

### Compact Telegram HTML

Use the existing HTML delivery path when the segment contains only constructs that Telegram HTML can represent clearly:

- paragraphs and headings;
- emphasis and links;
- ordered, unordered, and task lists;
- quotations;
- inline code;
- fenced code blocks.

This is the default for ordinary answers. Headings become compact bold section labels, lists use normal bullet characters, and code uses Telegram `pre` and `code` entities.

### Native Rich Message

Use a native Rich Message only when the segment needs at least one supported construct that the compact HTML path cannot preserve:

- a table;
- a formula;
- a `details` block;
- a footnote or reference definition;
- an image embedded at a specific position in the answer.

A rich segment keeps its current deterministic Markdown, media IDs, limits, durable payload, and precomputed HTML fallback.

### Separate attachment

Documents and non-embeddable media remain separate durable attachment parts in their original order. A file does not force adjacent ordinary text into a Rich Message.

### Determinism

The selector depends only on the normalized `TelegramTurnResult`. Equivalent input produces byte-identical operation types, part keys, payloads, fallback parts, ordering, and content hashes.

Existing persisted deliveries are not replanned during startup. The new selection policy applies only when a response plan is first installed. This prevents a deployment from changing the meaning of an already durable job.

## Readability rules

Formatting is applied only at the Telegram presentation boundary. The stored Codex result remains unchanged.

### Sections and spacing

- Render Markdown headings as bold labels without oversized typography.
- Keep one blank line between top-level sections.
- Keep list items adjacent, with no blank line inserted between ordinary items.
- Preserve authored paragraph boundaries.
- Do not invent headings, split prose sentence by sentence, or reorder content.
- Preserve nested lists, but cap visual indentation to two levels. Deeper source nesting remains readable through repeated bullet markers instead of growing horizontal indentation.

### Code policy

Short identifiers, paths, flags, and values can remain inline with single backticks when they are part of a sentence.

Every multiline code sample, command sequence, configuration fragment, structured payload, SQL statement, stack excerpt, or log excerpt must use a closed triple-backtick fence:

````text
```language
content with original indentation
```
````

Rules:

- add a language tag when it is known;
- use `text` when syntax is unknown or the block is output rather than executable code;
- preserve indentation and internal blank lines;
- put a blank line before and after the fence;
- never open or close a fence on the same line as prose;
- never split a Telegram chunk inside a fence;
- when one fenced block exceeds a Telegram limit, create independently valid fences and repeat the language tag in every part;
- escape source content for the chosen Telegram representation only after block boundaries are known.

The formatter does not attempt to infer a missing fence from arbitrary prose. Output policy and prompt guidance should encourage valid source Markdown, while the delivery layer guarantees that already fenced content remains valid.

### Message splitting

Prefer top-level paragraph and block boundaries. Preserve current Unicode-safe length accounting. Protected blocks include fenced code, tables, `details`, quotations, formulas, and footnote definitions.

When a protected rich construct cannot fit within a native Rich Message limit, use its deterministic compact fallback if that fallback can preserve the content. If neither representation can fit an indivisible source block, fail locally before a network write and expose a bounded operator action. Never silently truncate the answer.

## Dashboard topic

The Telegram Dashboard topic becomes a compact status summary and launcher, not a second copy of the Mini App.

### Message body

Render, in this order:

1. one summary line with active, waiting, queued, and failed counts;
2. `Требуют внимания`, only when an item needs user or operator action;
3. `Сейчас`, with a small bounded list of active root sessions;
4. `Очередь`, as a count and a small bounded list only when non-empty;
5. `Система`, with Codex availability and the 24-hour failure count;
6. the existing update timestamp managed by the status-board publisher.

Do not render the full `Последние 24 часа` session list in the topic. That list already belongs in the Mini App. Do not repeat a source label when it is equivalent to the displayed workspace label.

Example shape:

```text
📌 TeleCodex · активны 2 · ждёт 1 · в очереди 3

Требуют внимания
1. mir-back · ждёт ответа · 8м

Сейчас
1. mir-back · MIR-7067 · 10м
2. antwerp · PartnerDev · 4м

Система
🟢 Codex app-server
🟢 Доставка без ошибок за 24ч
```

### Buttons

- Keep exactly one `Открыть Dashboard` launcher when the Mini App URL is configured.
- Remove per-job `Details` buttons from the Telegram topic.
- Show Telegram callback buttons only for an action that is currently required, such as retry, abort, or refresh after a failure.
- Prefix an action with the matching visible item number or a short bounded label so the target is unambiguous.
- Keep one required action per row. Do not fill spare button capacity with informational actions.
- Keep the existing callback version checks, authorization, idempotency, and stale-action handling.

If there are no required actions, the launcher is the only button.

## Safe Telegram diagnostics

Introduce one shared sanitizer for operator-facing error logs. All Telegram polling, delivery, status, topic, and attachment-download log paths use it before interpolating or passing errors to `console`.

### Sanitization

The sanitizer must:

- replace Telegram API URL credentials in both `/bot<token>/` and `/file/bot<token>/` forms;
- redact URI user information and common credential query parameters;
- remove control characters and line breaks;
- bound the final string;
- survive hostile objects, getters, cyclic causes, and failed string conversion;
- never traverse arbitrary payload properties to build a log message.

Raw error objects are not passed as additional `console.warn` or `console.error` arguments on Telegram paths because Node can inspect fields that the sanitizer did not select.

### Structured classification

Diagnostics expose only bounded fields:

- operation family, such as polling, status edit, rich send, or attachment download;
- HTTP or Telegram numeric status when safely available;
- stable category;
- bounded `retry_after` when present;
- safe local reason code.

Stable categories are:

- `rate_limited`;
- `topic_closed`;
- `topic_missing`;
- `message_missing`;
- `forbidden`;
- `rich_rejected`;
- `bad_request_other`;
- `network_retryable`;
- `acceptance_unknown`;
- `internal_local`.

The persisted delivery error remains a bounded code. Telegram descriptions, request URLs, chat IDs, thread IDs, message IDs, job IDs, payloads, prompts, and response content are not persisted or logged by this diagnostic path.

### Exposed-token boundary

The bot token observed in a local service log must be treated as exposed. Code can prevent recurrence, but it cannot make that credential safe again. Rotation is a separate operator action and is a mandatory gate before the first production release from this cycle. The token value must never appear in a command transcript, test fixture copied from production, commit, plan, or release report.

## Releasable steps

### Step 07.0: Secret-safe logging

Deliverables:

- shared Telegram log sanitizer and structured diagnostic formatter;
- replacement of raw Telegram error logging at polling, delivery, status, topic, and attachment boundaries;
- tests with synthetic tokens in URLs, nested causes, hostile values, and raw-error console calls;
- an audit test that prevents new Telegram log sites from bypassing the sanitizer.

Acceptance:

- tests cannot find the synthetic token or message payload in captured logs;
- 429 still exposes only the status and bounded retry delay;
- error classification and delivery state transitions remain unchanged;
- no database migration is required.

Production gate:

1. rotate the Telegram bot token without printing it;
2. install the new secret through the existing protected environment mechanism;
3. restart TeleCodex once at an idle boundary;
4. verify one process, zero restart loop, successful polling, and no credential-shaped URL in new logs.

### Step 07.1: Hybrid rich selection

Deliverables:

- a pure representation selector;
- compact HTML plans for ordinary final Markdown;
- native Rich Message plans only for advanced constructs and positioned images;
- unchanged legacy compatibility and rich fallback behavior.

Acceptance:

- headings, lists, quotes, links, inline code, and fenced code plan as `edit_text` or `send_text`;
- tables, formulas, `details`, footnotes, and embedded images plan as rich operations;
- mixed text, image, file, and text ordering remains exact;
- old durable rich and legacy fixtures reconcile unchanged;
- equivalent input produces the same hashes and parts.

Production gate:

- deploy only after Step 07.0 is live;
- use one user-initiated ordinary answer and one user-initiated advanced answer as the smoke check;
- verify delivery ledger completion and absence of duplicate messages without logging content.

### Step 07.2: Readability and code fences

Deliverables:

- deterministic Telegram presentation normalization;
- compact section and list spacing;
- strict preservation and safe splitting of fenced blocks;
- regression fixtures for Russian prose, long lists, nested lists, commands, config, SQL, and logs.

Acceptance:

- no output chunk contains an unclosed fence;
- indentation and code content round-trip across chunk boundaries;
- ordinary list items no longer render as oversized native rich blocks;
- no content is truncated, summarized, reordered, or interpreted as HTML;
- source and rendered limits are respected in Unicode code points.

Production gate:

- use user-initiated messages containing prose, a short list, inline code, and a multiline fenced block;
- visually confirm section spacing and copy-paste correctness of the code block;
- verify no fallback, uncertainty, or duplicate delivery was introduced.

### Step 07.3: Dashboard topic cleanup

Deliverables:

- compact topic body;
- removal of per-job `Details` allocation;
- required-action-only buttons with clear target labels;
- unchanged Mini App launcher and callback safety.

Acceptance:

- a board with many jobs renders one launcher and no repeated `Details` rows;
- a board without required actions has no callback buttons;
- a board with required actions maps every button to a visible target;
- body and callback limits remain bounded;
- unchanged snapshots do not trigger an edit.

Production gate:

- update the running service at an idle boundary;
- verify one existing Dashboard topic message is edited in place;
- confirm the Mini App opens and required actions still target the correct job;
- confirm no topic close, reopen, or replacement event is produced.

## Verification for every step

Use test-driven changes. Run focused tests for the changed boundary first, then:

```text
npm test
npm run check:web
npm run build
git diff --check
```

Before a production update, also run the existing release preflight against the exact built revision. After restart, verify the running revision, process identity, restart count, readiness, SQLite health, delivery backlog, uncertain deliveries, and fresh sanitized logs.

An implementation commit, successful build, or merge is not production proof. Each step records local verification and live verification separately.

## Recovery and rollback

- Step 07.0 can roll back code, but the rotated token remains rotated.
- Steps 07.1 and 07.2 affect only newly installed response plans. Existing persisted plans keep their stored payloads.
- Step 07.3 edits the existing Dashboard status message and does not create a replacement topic.
- A rollback never retries an ambiguous send, rewrites a durable response plan, restores an old SQLite copy, or replays the previously contained existing-topic warning action.
- Any uncertain delivery, schema mismatch, failed preflight, or restart loop stops the release before the next step.

## Non-goals

This cycle does not:

- change Codex answer content or prompt semantics;
- stream partial final answers;
- replace the current durable outbox;
- repair or replay historical quarantined jobs;
- retry the contained existing-topic warning replay;
- redesign the Dashboard Mini App;
- add a general-purpose Markdown dependency in the first implementation pass;
- send automatic production smoke messages.

The existing custom formatter already covers the selected Telegram subset and its durability constraints. Current maintained packages such as `mdast-util-from-markdown`, `markdown-it`, and `@grammyjs/parse-mode` are available, but adopting a second parser would expand the trust and compatibility surface without solving the representation-policy problem. Reconsider a standards parser only if the selector cannot be implemented through the formatter's existing scanner and tests.

## Cycle completion

The cycle is complete only when all four steps are independently implemented, verified, released through their gates, and observed without duplicate delivery or credential leakage. Completion evidence must distinguish repository state from the exact revision running in TeleCodex.
