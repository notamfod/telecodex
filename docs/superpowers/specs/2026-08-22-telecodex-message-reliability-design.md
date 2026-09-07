# TeleCodex Message Reliability Design

## Goal

Make every work-producing Telegram message durable, traceable, and visible from receipt through Codex execution and final Telegram delivery.

The system must never silently lose an accepted message, silently replay a prompt after an ambiguous failure, or show `Done` before Codex has completed and every required response part has been delivered.

Codex Session Guardian remains responsible for global session-health detection and explicit session recovery across TeleCodex, ChatGPT Remote, and CLI sessions. TeleCodex owns Telegram job intake, queueing, status, and delivery.

## Scope

The reliability path covers:

- text prompts;
- prompts with supported files or media;
- commands that create Codex work;
- confirmation callbacks that create Codex work;
- progress and terminal status messages;
- Codex response chunks and generated documents.

Navigation-only callbacks, pagination, and menu opening remain ephemeral. They must report failures to the user, but they do not create durable Codex jobs.

## Non-goals

This work does not:

- replace Codex Session Guardian;
- automatically repair a stalled session;
- automatically replay a prompt whose acceptance is ambiguous;
- introduce Redis, RabbitMQ, or another external broker;
- claim exactly-once delivery across SQLite and the Telegram Bot API;
- store conversation content in Guardian state.

## Current gaps

The current JSON job store persists a coarse job state and a list of sent part keys. It does not durably record the source Telegram update, state transitions, dispatch attempts, Codex event time, failure classification, recovery state, or Telegram message IDs for every delivery.

Current startup recovery calls the normal prompt handler for recoverable jobs. That can replay an input without first proving whether app-server accepted the previous `turn/start`.

The progress heartbeat edits Telegram independently of Codex events. It proves that the Node.js timer ran, but it does not prove that a Codex turn progressed.

Thread runtime, Telegram job state, delivery state, and Guardian health currently come from different sources without one correlation contract.

## Selected approach

Use a local SQLite database in WAL mode as the authoritative store for a durable inbox, append-only job event ledger, current job projections, and delivery outbox.

This keeps operation local and transactional without adding an external service. A bounded compatibility export supports rollback during migration, but JSON is no longer authoritative after cutover.

## Architecture

```text
Telegram update
      |
      v
Durable Inbox -> Job Coordinator -> Codex Adapter
      |               |                 |
      |               v                 v
      |          Job Event Ledger   app-server
      |               |                 |
      v               v                 v
Status Anchor <- Status Projection <- Guardian health
      |
      v
Delivery Outbox -> Telegram
```

### Durable Inbox

The inbox validates and normalizes a Telegram update, deduplicates it, and commits it before any Codex work starts. The unique source key is `botId + updateId`. Message and topic identifiers remain stored for correlation and replies.

Text is stored in the same transaction. For supported files, the inbox stores Telegram identifiers and metadata, then materializes the file locally before the job becomes dispatchable.

### Job Coordinator

The coordinator is the sole owner of the Telegram job lifecycle. It enforces FIFO ordering within a topic or Codex thread and the configured global concurrency limit.

It persists a transition before each external side effect and records the observed result afterward. It does not treat in-memory callback state as authoritative.

### Codex Adapter

The adapter owns app-server connection management, bounded RPC deadlines, transport error classification, and normalized Codex events. It reports facts to the coordinator and never decides whether an ambiguous prompt should be replayed.

Initial configurable deadline defaults are:

- connect and initialize: 10 seconds;
- control and read RPC: 15 seconds;
- `turn/start` acknowledgement: 30 seconds;
- Telegram send or edit: 30 seconds, except when Telegram supplies `retry_after`.

There is no total execution timeout for a Codex turn.

### Job Event Ledger

Every accepted job has append-only transition history. The current job row is a projection used for efficient queueing and status reads. A transition transaction updates both the event ledger and current projection.

### Delivery Outbox

Every status edit, response chunk, and document delivery is inserted before the Telegram API call. Each part has a stable part key, content hash, attempt count, delivery state, and Telegram message ID when known.

### Guardian Client

TeleCodex reads global session health and explicit recovery outcomes through Guardian IPC. It does not run a competing stale-session detector or perform archive, unarchive, resume, or cold reload as recovery.

### Status Projection

One projection combines job state, app-server facts, delivery state, and Guardian health. Telegram cards, `/status`, and Dashboard render this same projection.

## State model

State is split into independent dimensions to avoid a single misleading enum.

```text
phase:    accepted | queued | dispatching | running | delivering | terminal
health:   healthy | quiet | checking | stalled | unavailable
outcome:  completed | failed | aborted | recovery_interrupted | null
delivery: pending | sending | delivered | uncertain | failed
activity: model | tool | subagent | waiting | unknown
attention: none | required
```

`phase` describes the TeleCodex job. `health` is the public liveness view. Local event freshness may produce `healthy` or `quiet`, while Guardian is authoritative for `checking`, `stalled`, and recovery state. `delivery` describes Telegram output. `outcome` is set only after a terminal fact.

When `attention=required`, the job also carries a bounded `attentionCode` and the allowed operator actions. Attention does not invent a new runtime phase or outcome.

`quiet` means that no new Codex event has arrived recently. It does not mean stalled. Only Guardian may project `stalled`.

`Done` is rendered only for `outcome=completed` and `delivery=delivered`.

## Input flow and deduplication

For each work-producing Telegram update:

1. Validate the user, chat, topic, command, and payload boundaries.
2. Begin a SQLite transaction.
3. Insert the normalized inbox record using the unique source key.
4. Create the job and its first `accepted` transition.
5. Insert an outbox entry for the status anchor.
6. Commit the transaction.
7. Complete the Telegram update handler.
8. Materialize supported files and move the job to `queued`.

If the source key already exists, TeleCodex returns the existing job and does not create a second prompt.

If SQLite cannot commit, TeleCodex does not dispatch the prompt. The update handler fails closed so the failure is visible and can be retried without an untracked Codex turn.

## Queueing and dispatch

Before calling `turn/start`, the coordinator records:

- `phase=dispatching`;
- the exact `threadId`;
- the previous latest `turnId` for that thread;
- the dispatch attempt number;
- the attempt start time;
- whether the request has reached the transport write boundary.

The coordinator handles outcomes as follows:

| Evidence | Result |
| --- | --- |
| App-server returns a valid `turnId` | Bind the job and enter `running` |
| Request definitely failed before transport write | Return to `queued` with bounded backoff |
| App-server explicitly rejects the request | Enter terminal `failed` with a safe code |
| Connection fails after the write boundary | Keep `phase=dispatching`, set `attention=required` with `DISPATCH_UNKNOWN`, and do not replay |
| A new turn appears after the saved previous turn | Bind to that exact turn and continue |
| Acceptance cannot be proved | Keep the job visible with `attention=required`; offer Inspect and Retry as new turn |

Retry as new turn always creates a new job with `retryOf` pointing to the original job. The original history remains unchanged.

## Runtime activity

Codex notifications update `lastCodexEventAt` from the server emission time when available. Lifecycle events are persisted immediately. High-volume token deltas are coalesced so SQLite is not rewritten for every token.

Activity is derived only from observed app-server events and thread state. A TeleCodex timer may refresh elapsed time in the status card, but it must not update `lastCodexEventAt` or change session health.

The status projection exposes:

- short job ID;
- phase and outcome;
- queue position;
- thread and turn identifiers;
- thread status;
- current activity when known;
- elapsed time;
- age of the last Codex event;
- Guardian health and last scan age;
- delivery progress;
- a safe failure code and action when attention is required.

## Delivery flow

Each job has one anchor message. The anchor starts as a receipt and is edited as the job progresses. If the final answer fits, the anchor may become the final answer. Larger answers and documents use additional deterministic outbox parts.

Delivery states are:

```text
pending -> sending -> sent
                  -> failed
                  -> uncertain
```

Rules:

- An explicit pre-send failure may be retried automatically.
- Telegram `429` schedules the next attempt using `retry_after`.
- `message is not modified` for an edit is treated as success.
- A timeout after a new send may have reached Telegram, so it becomes `uncertain` and is not resent automatically.
- An uncertain edit of a known message may be retried because the target message is stable.
- A manual resend of an uncertain new message warns that it may create a duplicate.
- A job remains `delivering` until every required part is `sent`.
- Partial delivery displays the exact delivered and total part counts.

The system promises no silent loss and no silent replay. It does not promise exactly-once Telegram delivery when the Telegram API result is ambiguous.

## Guardian coordination

Guardian remains the authority for global session-health classification and explicit recovery. TeleCodex needs a read-only Guardian observation view containing:

- `guardianHealth`;
- `lastObservedAt`;
- `unchangedSince`;
- `staleForMs`;
- opaque `alertId` when present;
- repair state and terminal repair outcome.

TeleCodex may read app-server thread content needed to deliver its own result, but it does not independently classify a session as stalled.

Recovery outcomes map to jobs as follows:

- `self-recovered`: reconcile the exact turn and continue normal delivery;
- `restored`: mark the old job `recovery_interrupted`, never `completed`;
- `failed`: keep the job visible with `attention=required` and a bounded recovery error code;
- Guardian unavailable: show `health=unavailable`, keep ordinary work running, and disable recovery actions.

User Abort remains a normal exact-turn operation. Guardian observes the changed fingerprint and closes any stale alert as self-recovered or no longer eligible.

## Restart reconciliation

TeleCodex completes database migration and reconciliation before accepting new updates.

| Persisted state | Restart action |
| --- | --- |
| `accepted` or `queued` | Return to the queue |
| `dispatching`, request not written | Return to the queue |
| `dispatching`, write result ambiguous | Inspect the exact thread; never replay automatically |
| `running`, exact turn active | Reattach observation |
| `running`, exact turn completed | Read the result and create outbox parts |
| `running`, turn missing or mismatched | Keep `phase=running`, set `health=checking` and `attention=required` |
| `delivering` | Resume `pending` and safely retryable `failed` parts |
| delivery `uncertain` | Wait for an explicit user decision |

The current startup path that calls the ordinary prompt handler for every recoverable JSON job is removed. Startup recovery becomes state-specific reconciliation.

## Failure handling

- SQLite unavailable or schema invalid: stop accepting work and fail closed.
- Disk full: do not launch an unpersisted prompt.
- App-server unavailable: retain the job in the queue with the next retry time.
- Guardian unavailable: show unknown health, but do not block normal Codex operation.
- Telegram unavailable: retain status and result outbox entries until delivery resumes.
- Poison job: after five safe automatic attempts by default, set `attention=required` instead of looping forever.
- Status-board no-op edit: record success and suppress repeated identical work.

Safe automatic retries use bounded exponential backoff with jitter, a persisted next-attempt time, and a configurable attempt limit whose default is five. Telegram `retry_after` overrides the generic backoff and does not consume an attempt by itself.

## Storage and retention

The SQLite file and attachment directory use private permissions. Schema changes are versioned and transactional.

Default retention is:

- unfinished and attention-required jobs: retained until resolved or explicitly dismissed;
- prompts, responses, and local attachments: deleted seven days after terminal status delivery or explicit dismissal;
- identifiers, outcomes, transitions, error codes, and delivery metadata: retained for 90 days.

Retention intervals are configurable. Logs, metrics, Guardian state, and long-lived metadata must not contain prompt text, response text, tool output, credentials, or attachment content.

## Operational visibility

`/healthz` reports process and SQLite health. `/readyz` additionally reports whether the coordinator can accept and dispatch work.

Dashboard shows:

- app-server connectivity;
- Guardian connectivity, mode, and scan age;
- Telegram delivery health;
- active and queued jobs;
- oldest queue age;
- jobs requiring attention;
- delivery backlog and uncertain parts.

The global status board also lists jobs whose anchor message is not known to be delivered, so a missing per-job card cannot hide accepted work.

Structured logs contain correlation identifiers, transitions, durations, and bounded error codes. They exclude conversation content.

Telegram, `/status`, and Dashboard group jobs as `In progress`, `Needs attention`, and `Recent`. Job details show an event timeline without prompt or response content.

## Testing

### State and persistence tests

- legal and illegal transitions for every state dimension;
- atomic event-plus-projection updates;
- deduplication of the same Telegram update;
- SQLite reopen and WAL recovery;
- schema migration and malformed schema rejection;
- one-time JSON import and import-marker idempotency;
- retention that preserves unresolved jobs.

### Fault-injection tests

- crash after inbox commit and before status delivery;
- crash before and after the `turn/start` write boundary;
- missing RPC response and half-open transport;
- lost `turn/completed` notification;
- restart during queued, running, and delivering phases;
- active tool or subagent without assistant text events;
- Telegram `429 retry_after`;
- Telegram no-op edit;
- crash after Telegram accepts a send but before `messageId` persistence;
- partial multi-part delivery;
- unavailable Guardian;
- full disk and corrupted database.

### Required invariants

- One Telegram source update creates at most one job.
- Ambiguous dispatch never causes automatic prompt replay.
- `Done` is impossible without `completed + delivered`.
- A terminal job cannot return to `running`.
- Every unfinished job appears in StatusProjection.
- Retry prompt creates a new job linked through `retryOf`.
- Restart reconstructs state from SQLite, not process memory.

### Live verification

- one ordinary prompt;
- a controlled queue with four active jobs and one waiting job;
- restart while one job is running;
- restart while one job is queued;
- a multi-part response;
- a long turn with tool or subagent activity;
- Guardian visibility for TeleCodex, Remote, and CLI root sessions;
- consistent Telegram and Dashboard projections;
- no repeated `message is not modified` journal noise.

## Rollout

1. Back up `jobs.json` and the other TeleCodex runtime state files.
2. Deploy the SQLite schema and importer in shadow mode without changing job authority. Existing JSON mutations are mirrored best-effort into SQLite only for parity measurement.
3. Compare JSON and SQLite projections for current jobs.
4. Switch the authoritative store to SQLite after parity checks pass.
5. Keep a bounded compatibility exporter for rollback during the observation window. It must refuse to start the old binary while an ambiguous state cannot be represented safely.
6. Run focused fault tests, the full project suite, TypeScript checks, web checks, build, and diff validation.
7. Restart only `telecodex.service`; keep Guardian and the shared app-server running.
8. Run the controlled live verification scenarios.
9. Observe queue, delivery, Guardian, and journal health.
10. Remove the JSON compatibility layer in a later change after the observation window.

Rollback from the SQLite-authoritative version requires an explicit compatibility export before the old binary starts. The exporter maps only safely representable work and stops for operator resolution when an ambiguous dispatch or delivery cannot fit the old schema. The old binary must not start against post-cutover work without a successful export.

## Acceptance criteria

- Fault tests lose zero committed Telegram updates.
- Ambiguous dispatch tests create zero automatic duplicate turns.
- A local state transition appears in Telegram and Dashboard within five seconds when Telegram is available.
- Guardian health appears no later than the next configured Guardian scan.
- Every unfinished job after a controlled restart either continues or becomes visibly `attention=required`.
- Every final answer is either fully delivered or visibly incomplete or uncertain.
- Telegram and Dashboard render the same phase, outcome, health, and delivery state.
- No status heartbeat can advance Codex liveness.
- No recovery path bypasses Guardian for archive, unarchive, resume, or cold reload.
