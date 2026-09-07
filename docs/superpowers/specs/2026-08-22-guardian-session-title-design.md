# Guardian Session Title Design

## Goal

Show a readable Codex session title in every Guardian Telegram message, including terminal states such as `Restored`, while retaining the full thread UUID for exact operations.

## Data source

The shared Codex app-server already returns the user-visible title as `thread.name`. Guardian must use only this field. It must not derive a title from conversation previews, prompts, responses, or tool output.

## Stored alert metadata

When the detector creates an alert, it passes the normalized `snapshot.name` to the store. The alert persists this value as nullable `thread_name` metadata. The title is not part of the stall fingerprint, so renaming a session does not reset detection or change the exact `threadId + turnId` repair target.

Guardian trims surrounding whitespace and accepts a non-empty title of at most 512 code points at the app-server boundary. An empty or missing title becomes `null`; a non-string or oversized value is rejected. Telegram rendering truncates the persisted title to 160 code points and HTML-escapes it. A missing title renders as `Untitled`.

## SQLite migration

Increase the Guardian schema version from 1 to 2. Upgrade an existing version 1 database in one immediate transaction by adding nullable `thread_name` to `alerts` and then setting `user_version = 2`.

Existing alerts retain all IDs, delivery locations, states, and repair attempts. Their title is `NULL`, so they render with the `Untitled` fallback. New databases are created directly at version 2. Schema validation continues to reject malformed or future versions.

## Telegram format

Use the same label and ordering for initial and terminal messages:

```text
Codex Guardian
Title: Guardian controlled Restore button test
Thread: 01a026e8-a44c-7ff3-bfe8-6129b34529d5
Status: Restored
Detail: Thread restored
```

The initial warning changes its existing `Name` label to `Title` and also shows `Untitled` when no name exists. The full UUID remains visible and formatted as code.

## Failure behavior

Title persistence is part of alert creation. If a supplied title violates the boundary, Guardian rejects the malformed app-server snapshot rather than storing unbounded data. A missing title never blocks alert creation, delivery, repair, or terminal status reconciliation.

## Tests

- app-server normalization accepts `null` or a bounded non-empty `name` and rejects invalid values;
- a version 1 database migrates to version 2 without losing alerts or repair attempts;
- new alerts persist their title across close and reopen;
- initial and terminal Telegram renderers show `Title`, escape HTML, truncate safely, and fall back to `Untitled`;
- changing a title does not change the stall fingerprint;
- focused Guardian tests, the full project test suite, TypeScript build, and live service status pass before completion.

## Deployment

Build the server, back up the Guardian SQLite file, and restart only `codex-session-guardian.service`. TeleCodex and the shared app-server remain running. After startup, verify schema version 2, `repairEnabled=true`, zero unexpected restarts, and one controlled rendered status.
