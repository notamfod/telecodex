# TeleCodex Failed Turn Recovery Design

## Status and scope

Approved for implementation on 2026-09-04 as part of the combined quarantine
repair and reliability maintenance cycle.

This change fixes Telegram jobs that remain `running` after Codex app-server
has already ended their exact turn with an error. It covers both text-only and
rich-content/image turns. It does not retry failed prompts or redeliver any
Telegram response.

## Confirmed failure

The app-server can emit an `error` notification and then become idle without
emitting the expected `turn/completed` notification. TeleCodex currently saves
the error text but keeps the active job, so queue draining stops and the durable
job remains `running`.

This was observed for an image turn ending in `server_overloaded` and for a
text-only turn ending in an HTTP 404. The defect is therefore in terminal-turn
lifecycle handling, not image decoding.

## Runtime design

An `error` notification alone is not treated as terminal because app-server may
recover or retry internally. TeleCodex stores only a bounded error summary and
waits for one of these terminal proofs:

1. the normal `turn/completed` notification for the exact turn;
2. app-server becoming idle after an error, followed by `thread/read` proving
   the exact turn is terminal;
3. restart reconciliation reading the exact persisted turn as terminal.

When error and idle have both been observed, in either order, the turn manager
performs one exact-turn read. A completed turn is replayed normally. A failed,
interrupted, or cancelled turn emits `onTurnOutcome`, rejects the active run,
releases the active job, and drains the next queued job. Unknown or ambiguous
state remains fail-closed and is not guessed.

## Correlation and races

All settlement is keyed by thread ID and exact turn ID. A small per-active-job
state machine records error, idle, reconciliation in flight, and settled state.
Only the first terminal proof wins. A late `turn/completed`, duplicate idle
status, or duplicate error cannot settle twice, emit two outcomes, or drain the
queue twice.

The read path never selects merely the newest turn. If the exact turn is absent
or its status is unknown, the job remains available to Guardian reconciliation
and attention handling.

## Restart recovery

The exact-turn inspector gains a terminal-failed result for recognized
app-server terminal statuses. The job reconciler routes that result through the
existing exact-turn recovery path. Recovery replays the exact turn, emits the
terminal outcome, and lets the coordinator persist the durable failed state.

This is required to settle jobs that became stuck before the new runtime was
installed. It does not synthesize a failure from old logs and does not mutate a
job unless app-server currently proves the exact turn outcome.

## Safety and observability

- Error messages remain bounded and sanitized by the existing error boundary.
- Rich content and attachment bodies are never logged by the new path.
- No automatic retry is added.
- Metrics distinguish normal completion, reconciled completion, reconciled
  failure, ambiguous exact-turn state, and reconciliation read failure.
- Queue progress after a reconciled failure is covered by a durable coordinator
  test.

## Tests

Add focused tests for:

- error then idle and idle then error;
- text and image input shapes;
- exact completed and exact failed reads;
- late completion racing with reconciliation;
- duplicate notifications and failed reads;
- restart reconciliation of a previously failed exact turn;
- unknown status remaining fail-closed;
- next queued job starting exactly once after failure settlement.

The production candidate must also pass the full repository test, web check,
TypeScript build, Vite build, and whitespace gate before maintenance begins.
