# TeleCodex Nondestructive Topic Liveness Design

## Problem

TeleCodex currently checks whether a Telegram forum topic exists by reopening it and then closing it. Telegram publishes both operations as service messages. A resolved work topic is closed once by the ticket flow, then the independent Status Board and Mini App Dashboard collectors can each run the probe on their ten-minute cadence. This produces the observed sequence of one legitimate close followed by two reopen/close pairs.

The deployed service has not restarted and the disabled missing-topic recovery runtime is not responsible for this behavior. The fix must remove state-changing liveness probes without weakening the safety rule that a replacement topic is created only after Telegram has definitively reported the old topic missing.

## Goals

- Background Status Board and Dashboard refreshes never call Telegram to validate work-topic bindings.
- Explicit user-driven operations and missing-topic recovery can check a topic without opening, closing, editing, or posting a durable message.
- Concurrent checks for the same topic share one Telegram request and briefly reuse its result.
- A closed topic counts as existing; only definitive missing-topic errors count as missing.
- Unknown, rate-limited, aborted, or timed-out requests never authorize topic creation.
- Legitimate lifecycle operations remain unchanged: resolving a ticket may close its work topic, and the Status Board may manage its own dedicated topic.

## Non-goals

- Adding an MTProto client solely to call `messages.getForumTopicsByID`.
- Changing ticket resolution semantics or removing the intentional close operation.
- Enabling the missing-topic recovery Dashboard action.
- Repairing historical deliveries or changing live database state as part of this hotfix.
- General Telegram rate-limit redesign beyond eliminating these unnecessary calls.

## Selected Approach

Use two policies, selected by caller intent:

1. Background rendering trusts the persisted registry binding. It performs no Telegram liveness request.
2. Explicit user actions and recovery use `sendChatAction` with `message_thread_id` and action `typing` as a nondestructive existence check.

Telegram Bot API has no read-only forum-topic lookup. `sendChatAction` is the least invasive Bot API request available: it creates no durable message and does not change topic state. A short typing indicator is acceptable only while an explicit action or recovery is already in progress. It must never be emitted by periodic background collectors.

Rejected alternatives:

- Keep reopen/close and suppress duplicates. This still changes user-visible state and cannot remove the service messages.
- Trust bindings everywhere and learn only from later delivery failures. This is safe for background rendering, but it cannot provide the definitive missing-topic evidence required before recovery creates a replacement.
- Add MTProto. It provides a true read API but adds a second Telegram protocol, authentication model, session store, and operational surface for one check.

## Components

### Nondestructive liveness probe

Add a focused module that owns topic-probe classification, request coalescing, and a bounded cache. Its input is a destination, an optional abort signal, and a narrow adapter that sends `typing` to the topic.

For each `(chatId, messageThreadId)` key:

- at most one request may be in flight;
- concurrent callers receive the same promise;
- a completed boolean result may be reused for five seconds;
- failures are not cached;
- the caller's abort signal and a three-second probe timeout are passed to Telegram.

The module returns:

- `true` when `sendChatAction` succeeds;
- `true` when Telegram definitively says the topic is closed (`TOPIC_CLOSED` or equivalent text);
- `false` for `TOPIC_DELETED`, `TOPIC_ID_INVALID`, or `message thread not found`;
- a rejected promise for 429, network failures, timeout, abort, and all unknown errors.

This preserves the recovery invariant: only `false`, never a transport failure, can lead to replacement-topic creation.

### Background topic binding

Replace the Status Board binding helper's live lookup behavior with a pure registry/cache projection:

- copy persisted bindings from the current snapshot into the display cache;
- retain cached bindings for rows still visible;
- remove cache entries for rows no longer visible;
- do not call Telegram, regardless of the Status Board or Dashboard refresh cadence.

The Dashboard collector no longer schedules ten-minute binding validation. Status Board health checks may still verify and maintain the Status Board's own topic and message; they must not probe work topics.

### Explicit consumers

The shared nondestructive probe is used by the existing operations that need an existence decision:

- the user action that opens or reuses a Codex task topic;
- Inbox duplicate-ticket routing triggered by a received message;
- Jira task-topic opening triggered by a user action;
- startup filtering of pending jobs, if invoked;
- the disabled missing-topic recovery adapter.

These call sites keep their existing business behavior. Only the Telegram primitive underneath the check changes.

### Scope of Telegram mutations

No liveness code may reference `reopenForumTopic` or `closeForumTopic`. Those methods remain available only to explicit lifecycle code, including ticket resolution and Status Board maintenance.

## Data Flow

Background refresh:

1. Load current jobs, Codex threads, and registry contexts.
2. Project saved work-topic bindings into the snapshot.
3. Render the Status Board or Dashboard payload.
4. Make no Telegram request for work-topic liveness.

Explicit probe:

1. Build the destination key and reuse a fresh cached result or in-flight request when available.
2. Send `typing` to the destination with `message_thread_id` and the bounded signal.
3. Classify only definitive Telegram responses into existing or missing.
4. Propagate all ambiguous failures to the caller.
5. Recovery may proceed to its existing creation reservation only after a definitive missing result.

## Error Handling and Privacy

- Probe errors retain their current typed/error flow; the hotfix does not add payload, message, user, chat, topic, thread, or job identifiers to logs.
- Rate limits remain retryable/ambiguous and are never converted to missing.
- A timed-out request may have reached Telegram, so it is never retried inside the probe and never authorizes creation.
- The five-second cache reduces duplicate calls but is not used as durable truth.
- General-topic destinations continue to bypass forum-topic probing where the existing caller already does so.

## Testing

Use RED-GREEN-REFACTOR with focused tests for:

- successful `sendChatAction` classification;
- closed-topic classification as existing;
- each definitive missing-topic error as missing;
- propagation of 429, network, timeout, abort, and unknown errors;
- single-flight behavior for concurrent callers;
- five-second result reuse and expiry;
- absence of `reopenForumTopic` and `closeForumTopic` from the liveness adapter;
- zero Telegram liveness calls during repeated Status Board and Dashboard refreshes;
- preserved explicit ticket-close and Status Board lifecycle behavior;
- recovery proceeding only after a definitive missing result.

Run focused tests first, then the complete Vitest suite, TypeScript build/typecheck, Svelte checks, and the repository's diff/format checks.

## Rollout

This is a separate hotfix gate before missing-topic recovery activation continues. Because the current branch already contains the 05.3 runtime code, the release artifact may contain that code, but recovery remains disabled by default, has no Dashboard action, and performs no recovery work.

1. Build and test a private release candidate outside the live `dist` directory.
2. Capture live PID, restart count, health/readiness, queue state, and the disabled recovery configuration.
3. Wait for the existing idle preflight and require two consecutive idle samples. The shell condition must use an explicit `if` block so `set -e` cannot terminate the deploy loop on a normal false check.
4. Preserve a rollback artifact, install the candidate, and restart once.
5. Verify health/readiness, unchanged disabled recovery state, queue safety, and no unexpected recovery records.
6. Trigger a bounded Dashboard/Status Board refresh and verify it does not create work-topic reopen/close events.
7. Observe at least one full ten-minute collector interval, then repeat the safe runtime checks.
8. Resume the staged missing-topic recovery roadmap only after the hotfix observation is clean.

No database repair, historical recovery, push, or missing-topic activation is part of this rollout.

## Acceptance Criteria

- Repeated background refreshes cannot generate work-topic reopen/close service messages.
- An explicit check of an open topic succeeds without a durable Telegram message.
- An explicit check of a closed topic reports that it exists and leaves it closed.
- A deleted topic is reported missing only from a definitive Telegram error.
- Concurrent explicit checks issue one Telegram call.
- Unknown or timed-out checks cannot create a replacement topic.
- All focused and full verification gates pass.
- The live service is healthy after one controlled restart and remains clean through a full collector interval.
