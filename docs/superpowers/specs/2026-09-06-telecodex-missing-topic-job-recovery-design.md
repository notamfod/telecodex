# TeleCodex Missing Topic Job Recovery Design

## Status and scope

This design was approved in chat on 2026-09-06. It recovers one historical
Telegram response plan whose original forum topic was deleted after Codex had
already produced the response.

The recovery keeps the existing Codex thread and response content. It creates
one replacement Telegram topic, moves only that job's undelivered response
plan to the new topic, and schedules one versioned delivery retry. It does not
start another Codex turn, regenerate content, alter other jobs, or restore an
old database after Telegram may have accepted a request.

The implementation may support later jobs that satisfy the same strict
contract, but the live operation in this rollout targets only the single
historical job established by the bounded predicate.

## Confirmed live state

Read-only inspection established these facts without printing job, message,
user, chat, topic, thread, or payload identifiers:

- exactly one job matches the historical recovery predicate;
- the job is in `delivering` with version 541;
- its status anchor is failed and its two follower parts are pending;
- no part for the job is `sending` or `uncertain`;
- all primary and rich fallback payloads use the deleted source topic;
- the source has no `targetContext` or `targetProvision`;
- exactly one persisted Telegram context maps that topic to a Codex thread;
- the Codex thread exists, is not archived, has a title, and its workspace
  exists;
- a reversible Telegram probe confirmed that the old topic is missing rather
  than merely closed.

The failed anchor has already been converted from a missing edit to a
`send_text` operation. Repeating the current Retry would send to the same
deleted topic and cannot make progress.

## Selected behavior

The Dashboard exposes a distinct `recover_missing_topic` action only when the
server proves the exact recovery eligibility contract. The action carries the
job ID and expected job version. The runtime revalidates the complete contract
before every state change.

The action performs a durable recovery saga:

1. Reserve recovery in SQLite under the expected job version.
2. Probe the old topic again.
3. Create one new forum topic named from the existing Codex thread.
4. Atomically bind the job's response plan to the new destination and schedule
   the failed anchor for one retry.
5. Bind the new Telegram context to the existing Codex thread and remove the
   stale context binding.
6. Start the existing delivery outbox.

Telegram topic creation and a SQLite transaction cannot be one atomic unit.
The durable reservation and conservative unknown state close that gap without
pretending to provide distributed exactly-once semantics.

## Eligibility contract

The server may offer and execute `recover_missing_topic` only when all of the
following remain true:

- the supplied job ID exists at the supplied positive version;
- the job phase is `delivering` and an installed response plan exists;
- the job has a non-null Codex thread ID;
- that Codex thread exists, is not archived, and has a usable title and
  workspace;
- no recovery reservation already exists for the job;
- exactly one status anchor exists;
- the anchor is `failed`, has no Telegram message ID, and contains a valid
  topic-bound send payload;
- every ordinary response-plan part exists exactly once;
- all job deliveries are either the failed anchor or pending followers;
- no delivery is delivered, sending, or uncertain;
- every primary send payload and every rich fallback payload uses the same old
  chat and topic;
- the current durable source destination equals that old destination;
- no other row, plan, or payload mismatch is present.

The Dashboard action is a convenience, not authority. The runtime and ledger
repeat these checks. Any stale version or state mismatch writes nothing and
makes no Telegram request.

## Durable recovery state

A dedicated recovery record is keyed by job ID and stores bounded operational
metadata: the recovery state, expected and current job versions, old
destination, action token, timestamps, optional retry deadline, and the new
topic ID after it is known. It never stores message content or credentials.

The states are:

- `in_flight`: topic creation may be in progress;
- `retry_wait`: Telegram definitively returned 429 and supplied or implied a
  bounded retry deadline;
- `unknown`: topic creation may have succeeded, so automatic repetition is
  forbidden;
- `complete`: the response plan is bound to the replacement topic;
- `failed`: topic creation definitively failed and delivery was not retried.

The initial reservation is inserted in the same immediate transaction that
checks the job version and eligibility. That transaction advances the job
version and records attention appropriate to recovery. A duplicate action
cannot create a second reservation.

## Topic probing and creation

The runtime reuses the existing reversible topic probe. If the old topic is
alive, or can be opened and restored to its previous closed state, recovery
stops without creating a topic. The existing delivery remains failed for
inspection or ordinary retry.

When the topic is confirmed missing, the runtime builds the replacement name
with the existing `buildTopicName` contract and calls `createForumTopic` once
for the configured forum chat.

A definitive 429 moves the reservation to `retry_wait`. The scheduler may make
the next creation attempt only after the stored `retry_after` deadline. A
timeout, connection loss, cancellation after write, or process death while
creation is in flight moves or leaves the recovery in `unknown`. Neither the
scheduler nor the Dashboard may repeat creation from `unknown`.

Other definitive Telegram errors move the recovery to `failed`. They do not
change delivery payloads and do not schedule a delivery retry.

## Atomic destination rebind and retry

After Telegram returns a valid positive topic ID for the same chat, one
immediate SQLite transaction performs all local job changes:

- rechecks the recovery token, recovery state, job version, and full
  eligibility contract;
- writes the new destination as the job's `targetContext`;
- marks the recovery record `complete` with the new topic ID;
- rewrites `chatId` and `messageThreadId` in every undelivered primary send
  payload;
- recursively rewrites the same destination in every `send_rich` fallback;
- normalizes every changed payload and recalculates its SHA-256 content hash;
- updates the matching `status_anchor_plans` payload and hash;
- preserves response text, Markdown, media references, reply markup, part
  identity, ordering, and existing attempt counters;
- moves only the failed status anchor to `pending`, clears its old error and
  retry deadline, and leaves both followers pending;
- advances the job version and clears recovery attention.

Delivered parts are never redirected. This version handles only plans with no
delivered parts, which matches the historical job and avoids split-topic
responses.

After commit, the runtime asks the existing outbox to pump. The pending anchor
is sent first. Only confirmed anchor delivery releases the final and notice
parts. This is the single versioned Retry selected for the recovery.

## Session binding

The replacement topic continues the same Codex session. After the SQLite
commit, the registry binds the new Telegram context to the existing Codex
thread and removes the stale deleted-topic context in one registry update.
Registry persistence must use a replace-safe write so interruption cannot
truncate `contexts.json`.

If registry persistence fails, the committed delivery destination remains
authoritative and is not rolled back. Restart reconciliation repeats only the
local binding step from the completed recovery record and current Codex thread.
It never creates another topic.

The normal topic welcome is best-effort. Its failure is logged as a bounded
reason code and does not block the recovered response.

## Delivery outcomes

The existing outbox rules remain authoritative:

- confirmed anchor delivery stores its message ID and releases the followers;
- delivery 429 remains pending until the bounded retry deadline;
- an unknown send result becomes `uncertain` and is never resent
  automatically;
- a definitive permanent error returns the part to `failed`;
- no second automatic recovery action or delivery Retry is issued;
- final and notice are delivered exactly once according to their durable
  states after the anchor is confirmed.

## Dashboard and observability

The status action type gains `recover_missing_topic`. The action includes only
the existing job ID and expected version. The public Dashboard does not expose
payloads, chat IDs, topic IDs, thread IDs, recovery tokens, or Telegram error
descriptions.

Operational logs and status projections use bounded reason codes such as:

- `TOPIC_RECOVERY_IN_FLIGHT`;
- `TOPIC_RECOVERY_RATE_LIMITED`;
- `TOPIC_RECOVERY_UNKNOWN`;
- `TOPIC_RECOVERY_FAILED`;
- `TOPIC_RECOVERY_COMPLETE`.

The action disappears as soon as its version or eligibility becomes stale.
While recovery is `in_flight`, `retry_wait`, or `unknown`, the ordinary
`retry_delivery` action is suppressed for the affected anchor.

## Restart and reconciliation

On startup, reconciliation treats recovery state conservatively:

- `retry_wait` may return to `in_flight` only after its stored deadline;
- `in_flight` from a previous process becomes `unknown` and is not repeated;
- `unknown` remains blocked for manual inspection;
- `complete` may repair only the local session binding and pump already pending
  delivery;
- `failed` remains inspectable and performs no work.

If the process stops after the destination transaction but before the outbox
pump, the pending delivery is durable and the normal outbox resumes it. If the
process stops while a send is in flight, the existing outbox converts an
unknown send outcome to `uncertain` rather than resending.

## Tests

### Pure eligibility and payload tests

- accept the exact historical-shaped fixture;
- reject stale versions, missing threads, archived threads, active recovery,
  malformed plans, delivered parts, sending parts, uncertain parts, and mixed
  destinations;
- rewrite `send_text`, `send_media`, and `send_rich` destinations;
- rewrite every rich fallback destination;
- preserve content and media references byte-for-byte apart from normalized
  destination fields;
- produce matching normalized payload hashes.

### Ledger tests

- reserve once under an exact expected version;
- reject duplicate or stale reservations without partial writes;
- complete the destination rebind and anchor retry in one transaction;
- update the status anchor plan and all delivery hashes;
- roll back the whole transaction for every stale row, plan, hash, payload, or
  recovery-token mismatch;
- leave unrelated jobs byte-for-byte unchanged;
- preserve foreign-key integrity and quarantine count.

### Runtime tests

- stop when the old topic is alive or closed but recoverable;
- create one topic only after a confirmed missing probe;
- honor 429 retry deadlines without a tight loop;
- stop permanently on ambiguous creation;
- never expose ordinary Retry during active or unknown recovery;
- bind the replacement topic to the same Codex thread;
- reconcile a completed local binding after restart without creating a topic;
- pump the anchor once and release followers only after confirmed delivery;
- preserve existing 429, permanent-error, and uncertain-send behavior.

### Dashboard and integration tests

- expose the new action only for the exact eligible projection;
- reject tampered, stale, duplicate, or no-longer-legal actions;
- keep all identifiers and content out of public status and bounded logs;
- complete the three-part response plan in the replacement topic;
- retain the old database when any Telegram creation or send result is
  confirmed or uncertain.

## Microrelease rollout

Each code microrelease is built outside the live `dist` and `dist-web` trees.
It must pass focused tests, the full Vitest suite, strict TypeScript, Svelte
checks, staged server and web builds, and `git diff --check` before installation.
Installation requires no active Codex turn, no sending delivery, no uncertain
delivery, a ready Guardian, a private rollback tree, and the existing bounded
exception for the historical blocked pending followers.

### 05.1 Eligibility and rewriter

Add the pure eligibility predicate, destination rewriter, hashes, fixtures, and
tests. No runtime path calls them. Install, probe health and readiness, and
observe twenty snapshots over ten minutes.

### 05.2 Atomic ledger operations

Add the recovery schema plus reserve, rate-limit, unknown, failure, and complete
transactions. They remain unreachable from runtime. Install and repeat the
same observation.

### 05.3 Runtime behind a disabled flag

Add the saga, restart reconciliation, registry rebind, and scheduler integration
behind a default-off feature flag. Install with the flag off and repeat the
same observation.

### 05.4 Dashboard action and enablement

Add the versioned Dashboard action, runtime handler, and UI label. Enable the
feature only after a read-only check proves exactly one eligible historical
job. After installation, verify that one action is available, no action has run,
and the historical delivery state is unchanged. Repeat the ten-minute
observation.

### 05.5 Historical live recovery

Create and verify a fresh online SQLite backup. Reconfirm the exact bounded
predicate, service health, ready Guardian, zero active turns, zero sending,
zero uncertain, and zero quarantine rows. Invoke the authenticated versioned
action exactly once. If the request times out or returns an unclear result, do
not invoke it again.

Observe the target and service until completion or a conservative stop state.
Print only bounded aggregates and reason codes, never identifiers or content.

## Acceptance and rollback boundaries

The live recovery succeeds only when:

- all three target deliveries are `delivered`;
- the anchor has one confirmed message ID in the replacement topic;
- the job is `terminal/completed`;
- the new Telegram context maps to the original Codex thread;
- the stale deleted-topic context is absent;
- there are no target `pending`, `sending`, `uncertain`, or `failed` parts;
- database quick check and foreign-key check pass;
- quarantine remains zero;
- two release preflight reports agree and contain no pending-delivery reason;
- health, readiness, PID, restart count, Guardian, and bounded journal counts
  remain stable for twenty snapshots over ten minutes.

Code rollback is permitted before any topic-creation request. After Telegram
has confirmed or may have accepted topic creation or message sending, keep the
current live database. Never restore the pre-action backup, repeat an ambiguous
action, or release followers by hand.

## Non-goals

- recreating deleted topics automatically without an operator action;
- recovering plans that already delivered some parts to the old topic;
- merging or replaying Codex sessions;
- regenerating rich content or attachments;
- changing general topic creation, Inbox provisioning, or unrelated delivery
  retry policy;
- committing, pushing, or deploying outside the explicitly approved staged
  TeleCodex rollout.
