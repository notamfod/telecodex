# TeleCodex Existing Topic Resume Design

## Status and scope

This design was approved in chat on 2026-09-08. It handles a Telegram response
plan whose destination topic still exists, but whose status anchor has failed
and blocked two pending follower deliveries.

The earlier replacement-topic action stopped safely. It made one authenticated
request, completed in 90 ms, stored `TOPIC_RECOVERY_FAILED`, recorded no new
topic, and left the original topic binding intact. The stored anchor error is
only `telegram_permanent`, so it does not distinguish a live topic from a closed
topic or another definitive Telegram rejection.

The selected behavior preserves the original topic. If it is live, TeleCodex
retries the failed anchor. If it is closed, TeleCodex reopens it once and then
retries the anchor. It does not create a replacement topic, remove the failed
replacement-recovery record, start another Codex turn, regenerate content, or
release follower parts by hand.

## Why this is a separate operation

`recover_missing_topic` and `resume_existing_topic` have different external
effects and stop rules. Missing-topic recovery creates and binds a new topic.
Existing-topic resume keeps the destination, may reopen that topic, and hands
the failed anchor back to the existing delivery outbox.

The failed `topic_recoveries` row remains immutable operational history. A new
`topic_resume_attempts` ledger owns the second operation. Reusing or deleting
the old row would hide the first result and weaken duplicate-action protection.

## Liveness classification

The liveness primitive returns one of three confirmed states:

- `live`: `sendChatAction` succeeded in the target topic;
- `closed`: Telegram returned `TOPIC_CLOSED` or its bounded textual equivalent;
- `missing`: Telegram returned `TOPIC_DELETED`, `TOPIC_ID_INVALID`, or
  `message thread not found`.

Timeouts, connection failures, unrecognized responses, and other errors are not
states. They remain typed failures for the caller to classify. A 429 retains its
bounded retry deadline. The probe stays nondestructive, uses no automatic API
retry transformer, and keeps the existing deadline, single-flight, and short
cache behavior.

Existing callers that need only existence may adapt `live` and `closed` to
`true`, and `missing` to `false`. New resume code consumes the full result so it
does not discard the live-versus-closed distinction.

## Eligibility contract

The server may expose and execute `resume_existing_topic` only when all of the
following are true at the same job version:

- the job exists in `delivering` and has an installed response plan;
- the job has a valid Codex thread and durable source;
- exactly one failed `topic_recoveries` row exists for the job;
- that recovery has no new topic ID and still names the current destination;
- no `topic_resume_attempts` row exists for the job;
- exactly one status anchor exists and is `failed` with no Telegram message ID;
- the anchor payload and installed anchor plan are canonical and identical;
- every ordinary response-plan part exists exactly once and remains `pending`;
- no target delivery is `delivered`, `sending`, or `uncertain`;
- every primary and rich fallback payload uses the same current destination;
- the persisted Telegram context still maps that destination to the same Codex
  thread;
- the configured forum chat matches the destination;
- no quarantine row or source, plan, hash, ordering, or identity mismatch is
  present.

The Dashboard action is not authority. The runtime and ledger recompute this
contract before every reservation or delivery handoff. A stale or tampered
action writes nothing and makes no Telegram request.

## Durable state

Schema version 8 adds `topic_resume_attempts` with one row per job. The row
stores only bounded operational metadata:

- job ID and unique action token;
- original destination;
- reserved and current job versions;
- state and reason code;
- optional retry deadline;
- start and update timestamps.

It stores no message content, Telegram token, user data, thread title, payload,
or new destination.

The states are:

- `probe_in_flight`: a nondestructive liveness request is active;
- `probe_retry_wait`: Telegram returned 429 for a probe;
- `reopen_in_flight`: one reopen request may be active;
- `reopen_retry_wait`: Telegram definitively rejected reopen with 429;
- `reopen_unknown`: reopen may have succeeded, so repeating it is forbidden;
- `delivery_handoff`: the topic is confirmed live and anchor retry is being
  handed to the durable outbox;
- `complete`: the anchor and both followers are confirmed delivered and the job
  is terminal/completed;
- `failed`: a definitive condition prevents this operation from proceeding.

Reservation uses one immediate SQLite transaction. It rechecks the full
eligibility contract, inserts the row, advances the job version, and records a
bounded attention code. Duplicate or raced actions cannot reserve a second
attempt.

## Runtime flow

### Confirmed live topic

The runtime moves the attempt to `delivery_handoff` under compare-and-swap and
calls `TelegramDeliveryOutbox.retryFailed` for the status anchor at the current
job version. The outbox changes the anchor to `sending` before the Telegram
request. On confirmed anchor delivery it pumps the two pending followers.

The resume runtime does not send any follower itself and does not bypass anchor
ordering.

### Confirmed closed topic

The runtime moves the attempt to `reopen_in_flight` and calls
`reopenForumTopic` once through a dedicated API with no automatic retries.

On confirmed success, it continues through the same `delivery_handoff` path.
A 429 moves the attempt to `reopen_retry_wait`, and the scheduler may retry only
after Telegram's stored deadline. Other definitive Telegram rejections move the
attempt to `failed` without touching delivery rows.

### Missing topic

A confirmed `missing` result moves the attempt to `failed` with
`TOPIC_RESUME_SOURCE_MISSING`. Existing-topic resume never creates another
topic. Any later replacement design requires a separate operator decision.

### Ambiguous reopen result

A timeout, connection loss, unreadable response, cancellation after request
dispatch, or process death in `reopen_in_flight` moves the attempt to
`reopen_unknown`. The runtime never repeats `reopenForumTopic` from that state.

Reconciliation may run the nondestructive liveness probe:

- confirmed `live` continues to `delivery_handoff`;
- confirmed `closed` or `missing` remains stopped because repeating reopen is
  forbidden;
- 429 waits until the bounded deadline before another probe;
- another ambiguous probe leaves the attempt `reopen_unknown` without a loop.

This probe is the only automatic action allowed after an ambiguous reopen.

## Delivery outcomes and completion

The existing outbox remains the only Telegram message delivery owner:

- a confirmed send stores the anchor message ID and releases followers;
- delivery 429 follows the existing pending deadline;
- an unknown send result becomes `uncertain` and is not resent automatically;
- a definitive permanent send failure returns the anchor to `failed`;
- the two followers retain their original content, media references, order,
  hashes, and attempt counters.

The resume row becomes `complete` only after reconciliation proves three
delivered rows, a known anchor message ID, and a terminal/completed job. It does
not claim completion merely because reopen succeeded or delivery was handed to
the outbox.

## Dashboard and privacy

The status action type gains `resume_existing_topic`. Telegram callback data
uses code `u` and the bounded label `Resume topic`. The HTTP body contains only:

```json
{"expectedVersion":541}
```

The client cannot supply a destination, message thread, Codex thread, recovery
token, action token, or delivery part. Server-side code derives all of them from
the canonical stores.

Public status, callbacks, and logs expose no job, message, user, chat, topic,
thread, payload, title, or token values. Operational output uses aggregate
counts and bounded reason codes.

The action disappears as soon as the version or eligibility changes. While a
resume attempt is active, waiting, unknown, or in delivery handoff, the ordinary
anchor `retry_delivery` action is suppressed. Details and unrelated safe
actions remain available.

## Restart reconciliation

Startup applies these rules:

- `probe_in_flight` may repeat the nondestructive probe;
- `probe_retry_wait` resumes only after its stored deadline;
- inherited `reopen_in_flight` becomes `reopen_unknown` before any external
  call;
- `reopen_retry_wait` may retry reopen only after its 429 deadline;
- `reopen_unknown` may probe liveness but never reopen;
- `delivery_handoff` inspects the durable delivery row and asks the existing
  outbox to resume only work already represented by that row;
- `complete` and `failed` perform no external work.

Reconciliation is idempotent under the attempt token, job version, delivery
state, and outbox ledger.

## Tests

Pure liveness tests distinguish live, closed, and missing results. They retain
deadline, caller abort, single-flight, negative-cache, no-cache-on-error, and
one-request-on-429 coverage.

Eligibility tests accept the exact historical shape and reject stale versions,
missing or completed recovery history, absent bindings, existing resume rows,
malformed plans, mixed destinations, and any delivered, sending, or uncertain
part.

Ledger tests cover schema migration, reserve races, every legal transition,
illegal transition rollback, action-token mismatch, version conflict, bounded
deadlines, unrelated-job isolation, retention, quick check, and foreign keys.

Runtime tests cover live, closed, missing, probe 429, reopen 429, definitive
reopen failure, ambiguous reopen, process death in every in-flight state,
reconciliation without repeated reopen, delivery handoff, permanent delivery
failure, uncertain delivery, and confirmed three-part completion.

Dashboard tests cover exact action projection, callback length, parser routing,
HTTP key allowlisting, stale action rejection, duplicate-action rejection, and
suppression of the ordinary anchor retry.

Every code microrelease runs focused tests, the full Vitest suite, strict
TypeScript, Svelte checks, private server and web builds, `git diff --check`,
and a source review before installation.

## Microrelease rollout

### 06.1 Liveness classification

Introduce the typed liveness result and compatibility adapters. Runtime behavior
outside classification remains unchanged. Build privately, install at an idle
boundary, and observe twenty snapshots over ten minutes.

### 06.2 Resume ledger with runtime disabled

Migrate SQLite from v7 to v8 and add the resume ledger and runtime behind a
default-off flag. Before installation, create a private online backup and
rehearse v8-to-v7 rollback on a copy. After acceptance, v8 becomes the rollback
floor. Observe twenty snapshots with zero resume rows.

### 06.3 Dashboard action

Wire and enable the versioned action. Before installation, a read-only scan must
prove exactly one action and zero active turns, sending deliveries, uncertain
deliveries, resume attempts, and quarantine rows. Verify the installed action
without invoking it, then observe twenty snapshots.

### 06.4 Historical resume

Reconfirm the exact action version and bounded predicate, create and verify a
fresh online SQLite backup, and submit one authenticated action. On timeout,
disconnect, or unreadable output, stop without repeating the POST.

Observe until `complete`, `failed`, or `reopen_unknown`. Success requires three
delivered parts, a known anchor message ID, terminal/completed job, unchanged
topic binding, database integrity, stable service state, and twenty clean
snapshots.

## Rollback and stop boundaries

Code rollback is allowed before a resume attempt exists. Schema v8 may roll back
to v7 only while `topic_resume_attempts` is empty and integrity checks pass.

After a reopen or delivery request is confirmed or ambiguous, keep the live
database. Never restore an older SQLite backup, delete either operation ledger,
repeat an ambiguous reopen, repeat an uncertain delivery, or release followers
manually.

Stop on any candidate-count mismatch, active turn at the action boundary,
sending or uncertain delivery before the action, Guardian failure, quarantine
growth, schema mismatch, version conflict, unstable PID, restart, failed probe,
unexpected journal error, or unclassified external result.

## Non-goals

- replacing or recreating the existing topic;
- clearing or rewriting the failed replacement-recovery history;
- automatic resume without a versioned operator action;
- recovering plans with partially delivered followers;
- replaying the Codex turn or regenerating rich content;
- changing Inbox provisioning or general topic synchronization;
- broad delivery retry policy changes;
- push, merge, or deployment outside the approved TeleCodex microreleases.
