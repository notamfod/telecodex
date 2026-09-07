# TeleCodex Missing Status Anchor Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover a deleted Telegram status message exactly once, then unblock already persisted response parts without rerunning the Codex turn.

**Architecture:** Recognize only Telegram 400 `Bad Request: message to edit not found`, atomically replace the exact leased `edit_text` anchor with a topic-bound `send_text`, and preserve the existing unknown-send and 429 rules. Live progress recovery uses the current durable status projection; recovery after response-plan installation uses the outbox's stored canonical anchor payload so `status_anchor_plans` and physical delivery remain identical.

**Tech Stack:** TypeScript 5.9, Node.js, grammY, better-sqlite3, Vitest, systemd.

---

## Source of truth and boundaries

- Approved behavior is in `docs/superpowers/specs/2026-09-04-telecodex-missing-status-anchor-recovery-design.md`; work only in this checkout on existing branch `telecodex-improvements`.
- Preserve unrelated dirty/untracked work; never clean, reset, stash, or rewrite it, and do not commit, push, merge, or open a PR without separate authorization.
- Use `apply_patch` for source edits and `TMPDIR=/var/tmp` because `/tmp` is full; never print live identifiers, payloads, prompts, responses, tokens, or attachment paths.
- Never retry an unknown send; it becomes `uncertain`. Keep 429 pending until its bounded deadline and every other 4xx failed.
- Each task is a separate microrelease. Install, verify, and observe it for ten minutes before starting the next task.

## File map

- Modify `src/turn-progress.ts` and `src/telegram-durable-status.ts`: classify and recover live presenter edits using the validated durable destination.
- Modify `src/telegram-grammy-transport.ts` and `src/telegram-delivery-error.ts`: classify exact bounded status and delivery API errors.
- Modify `src/telegram-status-anchor-ledger.ts` and `src/telegram-delivery-ledger.ts`: validate identity and atomically replace delivery plus optional installed anchor plan.
- Modify `src/telegram-job-ledger.ts` and `src/telegram-job-store.ts`: expose and type the canonical store operation.
- Modify `src/telegram-delivery-outbox.ts` and `src/telegram-reliability-runtime.ts`: recover an installed-plan anchor using its durable topic and continue followers.
- Modify `test/telegram-grammy-transport.test.ts` and `test/turn-progress.test.ts`: exact classification and live replacement-send safety.
- Modify `test/telegram-status-anchor-ledger.test.ts` and `test/telegram-durable-status.test.ts`: CAS rollback, plan consistency, destination, actions, and identity.
- Modify `test/telegram-delivery-outbox.test.ts` and `test/telegram-reliability-runtime.test.ts`: installed-plan recovery and versioned Dashboard Retry without a new Codex turn.

## Release checkpoints

After every task, execute the exact test, install, rollback, and observation procedure in `docs/superpowers/plans/2026-09-04-telecodex-missing-status-anchor-rollout.md`; do not start the next task until accepted.

### Task 1: Exact live-status classification

**Microrelease tag:** `01-classifier`

**Files:**
- Modify: `src/turn-progress.ts:10-13,345-360`
- Modify: `src/telegram-grammy-transport.ts:219-236,397-421`
- Modify: `test/telegram-grammy-transport.test.ts:214-252`
- Modify: `test/turn-progress.test.ts:330-372`

- [ ] **Step 1: Write the failing status-classifier matrix**

Add to the existing transport classification test:

```ts
expect(classifyTelegramStatusError("edit", {
  error_code: 400,
  description: "Bad Request: message to edit not found",
})).toEqual({ disposition: "message_missing" });
expect(classifyTelegramStatusError("send", {
  error_code: 400,
  description: "Bad Request: message to edit not found",
})).toEqual({ disposition: "permanent" });
expect(classifyTelegramStatusError("edit", {
  error_code: 400,
  description: "Bad Request: message to edit not found now",
})).toEqual({ disposition: "permanent" });
expect(classifyTelegramStatusError("edit", {
  error_code: 400,
  description: "x".repeat(513),
})).toEqual({ disposition: "permanent" });
expect(classifyTelegramStatusError("edit", {
  error_code: 403,
  description: "Bad Request: message to edit not found",
})).toEqual({ disposition: "permanent" });
```

- [ ] **Step 2: Verify RED**

Run:

```bash
TMPDIR=/var/tmp npm test -- --run test/telegram-grammy-transport.test.ts test/turn-progress.test.ts
```

Expected: FAIL because `message_missing` is not in the status classification union.

- [ ] **Step 3: Extend and validate the status result**

Use:

```ts
export interface TurnProgressTransportClassification {
  disposition: "acceptance_unknown" | "retryable" | "permanent" | "message_missing";
  retryAfterMs?: number;
}
```

Permit `message_missing` in `classifyTransportError()`, preserve the rule that only `retryable` may contain `retryAfterMs`, and reject it for sends with `classification.disposition === "message_missing" && operation !== "edit"`.

- [ ] **Step 4: Add the bounded exact matcher**

Insert before the generic 4xx branch:

```ts
const code = telegramErrorCode(error);
if (operation === "edit" && code === 400 && isMessageToEditMissing(error)) {
  return { disposition: "message_missing" };
}
```

Add:

```ts
function isMessageToEditMissing(error: unknown): boolean {
  return telegramErrorDescription(error)?.toLowerCase()
    === "bad request: message to edit not found";
}
```

- [ ] **Step 5: Prove this microrelease preserves failure behavior**

Add a presenter test where the classifier returns `message_missing`. Until Task 3 is wired, require the existing result:

`anchor.finish` must receive `{ revision: revision("edit-missing"), state:
"failed", errorCode: "telegram_status_edit_failed", updatedAt: NOW }` exactly.

- [ ] **Step 6: Verify, review, install, and observe**

Run the focused tests and common gate. Review specifically for broad substring matching and accidental send recovery. Run `export TELECODEX_RELEASE_TAG=01-classifier`, install, and observe ten minutes.

### Task 2: Atomic status-anchor edit-to-send primitive

**Microrelease tag:** `02-ledger`

**Files:**
- Modify: `src/telegram-status-anchor-ledger.ts:20-145`
- Modify: `src/telegram-delivery-ledger.ts:15-205`
- Modify: `src/telegram-job-ledger.ts:600-612`
- Modify: `src/telegram-job-store.ts:20-35`
- Modify: `test/telegram-status-anchor-ledger.test.ts:18-480`

- [ ] **Step 1: Write the failing no-plan replacement test**

Prepare an active `edit_text` lease for a job without an installed response plan, then call:

```ts
const replaced = store.replaceMissingStatusAnchorEdit({
  jobId: job.id,
  expectedAttemptCount: sending.attemptCount,
  expectedContentHash: sending.contentHash,
  expectedLeaseUntil: sending.nextAttemptAt!,
  expectedMessageId: 501,
  replacementPayload: {
    operation: "send_text",
    chatId: -1001,
    messageThreadId: 7,
    text: "Current status",
  },
  updatedAt: START + 42,
});
expect(replaced).toMatchObject({
  state: "pending",
  attemptCount: sending.attemptCount + 1,
  telegramMessageId: null,
  nextAttemptAt: START + 42,
  lastErrorCode: "telegram_status_message_missing",
  payload: {
    operation: "send_text",
    chatId: -1001,
    messageThreadId: 7,
    text: "Current status",
  },
});
```

- [ ] **Step 2: Write the failing installed-plan replacement test**

Install a response plan whose anchor is the active `edit_text`. Replace it with the matching topic-bound `send_text`, then claim/deliver the new anchor and all ordinary parts. Require `finalizeDeliveredPlan()` to reach terminal completed. This proves both `deliveries` and `status_anchor_plans` contain the same new payload/hash.

For state, attempt, hash, lease, message ID, chat, text, send operation, malformed plan, and mismatched stored plan, assert an exception and identical pre/post delivery state. Any mismatch must roll back both tables.

- [ ] **Step 3: Verify RED**

Run:

```bash
TMPDIR=/var/tmp npm test -- --run test/telegram-status-anchor-ledger.test.ts
```

Expected: FAIL because the replacement operation does not exist.

- [ ] **Step 4: Define the exact input and pure validation**

Add and export:

```ts
export interface ReplaceMissingStatusAnchorEditInput {
  readonly jobId: string;
  readonly expectedAttemptCount: number;
  readonly expectedContentHash: string;
  readonly expectedLeaseUntil: number;
  readonly expectedMessageId: number;
  readonly replacementPayload: unknown;
  readonly updatedAt: number;
}
```

The pure helper must require an exact active `sending` status anchor, matching attempt/hash/lease/message identity, normalized current `edit_text`, normalized replacement `send_text`, identical chat and text, a validated nullable topic, and a monotonic timestamp. Return the replacement payload, its canonical hash, and `expectedAttemptCount + 1`.

- [ ] **Step 5: Implement the immediate SQLite transaction**

Inside `TelegramDeliveryLedger.replaceMissingStatusAnchorEdit()`:

1. Load the canonical job and status anchor.
2. Run the pure validation.
3. If `job.responsePlan` is undefined, require no `status_anchor_plans` row.
4. If `job.responsePlan` exists, require its stored anchor payload/hash to equal the active edit and update that plan in the same transaction.
5. Guard-update the delivery using exact state, attempt, hash, lease, and message ID.
6. Require exactly one delivery update and, when installed, exactly one plan update.

Use this delivery assignment:

```sql
SET state = 'pending', payload_json = ?, content_hash = ?, telegram_message_id = NULL,
  attempt_count = ?, next_attempt_at_ms = ?,
  last_error_code = 'telegram_status_message_missing', updated_at_ms = ?
```

The `WHERE` clause must include `part_key='status-anchor'`, `kind='status-anchor'`, `ordinal=0`, `state='sending'`, expected attempt/hash/lease, and expected message ID.

- [ ] **Step 6: Expose the canonical store method**

Add:

```ts
replaceMissingStatusAnchorEdit(input: ReplaceMissingStatusAnchorEditInput): DeliveryPart {
  this.assertOpen();
  return this.deliveryLedger.replaceMissingStatusAnchorEdit(input);
}
```

Re-export `ReplaceMissingStatusAnchorEditInput` from `telegram-job-ledger.ts` and `telegram-job-store.ts`.

- [ ] **Step 7: Verify, review, install, and observe**

Run the focused ledger and SQLite store tests, then the common gate. Review every transaction predicate and rollback assertion. Run `export TELECODEX_RELEASE_TAG=02-ledger`, install, and observe ten minutes. The new method is unused in this microrelease.

### Task 3: Automatic recovery for live progress edits

**Microrelease tag:** `03-live-recovery`

**Files:**
- Modify: `src/turn-progress.ts:40-110,190-280`
- Modify: `src/telegram-durable-status.ts:1-410`
- Modify: `test/turn-progress.test.ts:250-390`
- Modify: `test/telegram-durable-status.test.ts:180-340,820-860`

- [ ] **Step 1: Write the failing presenter sequence test**

Use a persistence double that prepares an edit, accepts replacement, then prepares a send:

```ts
const anchor: TurnProgressAnchorPersistence = {
  prepare: vi.fn()
    .mockResolvedValueOnce({
      kind: "prepared", revision: revision("missing-edit"), operation: "edit",
      attempt: 4, messageId: 501,
    })
    .mockResolvedValueOnce({
      kind: "prepared", revision: revision("replacement-send"), operation: "send",
      attempt: 5,
    }),
  replaceMissingEdit: vi.fn(async () => undefined),
  finish: vi.fn(async () => undefined),
};
```

Make edit reject with `message_missing`. Require `edit -> replaceMissingEdit -> send -> delivered`, one new send, message ID 777, and the current projection/actions passed to replacement.

- [ ] **Step 2: Add replacement-send safety cases**

Assert all of the following with exact finish calls:

- unknown replacement send becomes `telegram_status_send_uncertain` and is never repeated;
- 429 replacement send remains pending until its exact retry deadline;
- permanent replacement send becomes `telegram_status_send_failed`;
- `message_missing` returned for a send throws `Invalid progress transport classification` before finish;
- replacement storage failure performs no send and is not reclassified;
- another edit 4xx stays failed and does not call replacement.

- [ ] **Step 3: Verify RED**

Run:

```bash
TMPDIR=/var/tmp npm test -- --run test/turn-progress.test.ts test/telegram-durable-status.test.ts
```

Expected: FAIL because presenter persistence has no replacement boundary.

- [ ] **Step 4: Extend presenter persistence and branch once**

Add:

```ts
replaceMissingEdit?(input: {
  readonly revision: TurnProgressAnchorRevision;
  readonly projection: TelegramJobStatusProjection;
  readonly message: ProgressMessage;
  readonly updatedAt: number;
}): Promise<void>;
```

In the edit catch branch, before retryable/permanent handling:

```ts
} else if (classification.disposition === "message_missing") {
  if (!anchor.replaceMissingEdit) {
    throw new Error("Missing status anchor recovery persistence");
  }
  await anchor.replaceMissingEdit({
    revision: prepared.revision,
    projection,
    message,
    updatedAt: this.now(),
  });
  await this.deliverProjection();
  return;
} else if (classification.disposition === "retryable") {
```

Reject `message_missing` for a send in classification validation. The recursion is bounded because ledger replacement clears the message ID and the next preparation must be a send.

- [ ] **Step 5: Adapt durable persistence**

Extend `DurableStatusStore` with `replaceMissingStatusAnchorEdit` and implement:

```ts
replaceMissingEdit: async ({ revision: raw, projection, message, updatedAt }) => {
  const revision = parseRevision(raw, jobId);
  if (projection.jobId !== jobId) throw new Error("Telegram status projection mismatch");
  if (revision.expectedMessageId === null) {
    throw new Error("Telegram status anchor message target changed");
  }
  store.replaceMissingStatusAnchorEdit({
    jobId,
    expectedAttemptCount: revision.expectedAttemptCount,
    expectedContentHash: revision.expectedContentHash,
    expectedLeaseUntil: revision.expectedLeaseUntil,
    expectedMessageId: revision.expectedMessageId,
    replacementPayload: {
      operation: "send_text",
      chatId: destination.chatId,
      messageThreadId: destination.messageThreadId,
      text: message.html,
    },
    updatedAt,
  });
},
```

The durable source supplies exact chat/topic. `ProgressMessage.actions` remains in memory and `statusOptions()` regenerates the buttons on the replacement send.

- [ ] **Step 6: Add durable service integration coverage**

Start from delivered message 501, reject the next edit with exact missing classification, and require one replacement send with the persisted destination and current actions, a new stored message ID, attempts consumed for edit and send, no duplicate, and the next refresh editing the new ID.

- [ ] **Step 7: Verify, review, install, and observe**

Run focused presenter, durable-status, transport, and ledger tests, then the common gate. Invoke `requesting-code-review` and resolve every actionable finding. Run `export TELECODEX_RELEASE_TAG=03-live-recovery`, install, and observe ten minutes. Do not retry the historical failed response plan yet.

### Task 4: Recover installed response plans through the outbox

**Microrelease tag:** `04-outbox-recovery`

**Files:**
- Modify: `src/telegram-delivery-error.ts:1-24`
- Modify: `src/telegram-grammy-transport.ts:231-260`
- Modify: `src/telegram-delivery-outbox.ts:25-190,280-370`
- Modify: `src/telegram-reliability-runtime.ts:210-235`
- Modify: `test/telegram-grammy-transport.test.ts:214-270`
- Modify: `test/telegram-delivery-outbox.test.ts:590-750`
- Modify: `test/telegram-reliability-runtime.test.ts:1010-1170`

- [ ] **Step 1: Write the failing delivery-classifier matrix**

Require only exact `edit_text` to produce the new typed error:

```ts
expect(classifyTelegramDeliveryError({
  error_code: 400,
  description: "Bad Request: message to edit not found",
}, "edit_text")).toMatchObject({ code: "message_missing" });
expect(classifyTelegramDeliveryError({
  error_code: 400,
  description: "Bad Request: message to edit not found",
}, "send_text")).toMatchObject({ code: "permanent" });
expect(classifyTelegramDeliveryError({
  error_code: 400,
  description: "Bad Request: message to edit not found now",
}, "edit_text")).toMatchObject({ code: "permanent" });
```

Add `message_missing` to `TelegramDeliveryApiError.code` without retry delay or rich reason.

- [ ] **Step 2: Write the failing outbox recovery test**

Seed an installed response plan with failed `status-anchor`, pending `final`, and pending `notice`. The anchor must be `edit_text` and equal its `status_anchor_plans` row. Make the explicit Retry edit throw `TelegramDeliveryApiError("message_missing")`, then make the replacement send and followers succeed.

Require:

```ts
expect(telegram.calls.map((payload) => payload.operation)).toEqual([
  "edit_text", "send_text", "send_rich", "send_text",
]);
expect(store.get(job.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
expect(store.listDeliveries(job.id)).toEqual(expect.arrayContaining([
  expect.objectContaining({ partKey: "status-anchor", state: "delivered" }),
  expect.objectContaining({ kind: "final", state: "delivered" }),
  expect.objectContaining({ kind: "notice", state: "delivered" }),
]));
```

Prove replacement send timeout becomes uncertain with no follower calls, replacement send 429 stays pending, non-anchor missing edit fails permanently, an unavailable destination resolver fails without a send, a null root-topic destination remains valid, and other 4xx behavior is unchanged.

- [ ] **Step 3: Verify RED**

Run:

```bash
TMPDIR=/var/tmp npm test -- --run test/telegram-grammy-transport.test.ts test/telegram-delivery-outbox.test.ts test/telegram-reliability-runtime.test.ts
```

Expected: FAIL because delivery-side missing classification and outbox replacement are absent.

- [ ] **Step 4: Classify exact delivery errors**

In `classifyTelegramDeliveryError()`, place this before generic 4xx handling:

```ts
if (code === 400 && operation === "edit_text" && isMessageToEditMissing(error)) {
  return new TelegramDeliveryApiError("message_missing");
}
```

Do not classify `edit_rich`, sends, substring lookalikes, oversized descriptions, or other codes as recoverable.

- [ ] **Step 5: Inject only the canonical destination resolver**

Add to outbox options:

```ts
readonly statusDestination?: (jobId: string) => {
  readonly chatId: number;
  readonly messageThreadId: number | null;
};
```

In runtime construction, supply:

```ts
statusDestination: (jobId) => {
  const destination = responseDestination(store, requireJob(store, jobId));
  return { chatId: destination.chatId, messageThreadId: destination.messageThreadId };
},
```

This reuses the validated durable source and never trusts Telegram error text for routing.

- [ ] **Step 6: Replace and resend only the installed status anchor**

In `deliver()`, when the error is `message_missing`, require `partKey === "status-anchor"`, kind `status-anchor`, and `payload.operation === "edit_text"`. Resolve the destination, require the same chat, and construct:

```ts
const replacementPayload: TelegramDeliveryPayload = {
  operation: "send_text",
  chatId: payload.chatId,
  messageThreadId: destination.messageThreadId,
  text: payload.text,
};
```

Call `replaceMissingStatusAnchorEdit()` with the exact sending row identity. Then claim the returned pending row through the normal projected transition and recursively deliver only that `send_text`. Because the recursive payload is a send, it cannot enter missing-edit recovery.

If `message_missing` belongs to any other part, transition it to failed with a bounded permanent error and do not send a replacement.

- [ ] **Step 7: Continue followers after confirmed replacement**

In `retryFailed()`, capture the boolean result of `deliver()`. If the exact status-anchor retry reaches delivered, call `await this.pump()` before scheduling the next wakeup. Do not pump after pending, failed, or uncertain replacement outcomes.

- [ ] **Step 8: Prove canonical Dashboard routing**

In the runtime test, obtain the current `retry_delivery/status-anchor` action from `loadDashboardReliability()` and call `runDashboardAction(action)`. Require the outbox sequence above, terminal completion, zero `session.prompt` and `session.recoverPrompt` calls, and rejection of a stale expected version before any Telegram call.

- [ ] **Step 9: Verify, review, install, and observe before Retry**

Run focused classifier, outbox, runtime, projection, bot callback, and mini-app action tests, then the common gate. Invoke `requesting-code-review`, resolve findings, and rerun the full gate. Run `export TELECODEX_RELEASE_TAG=04-outbox-recovery`, install, and observe ten minutes without touching the historical Retry action.

## Historical recovery handoff

After Task 4's observation passes, execute the historical backup, one-shot
Dashboard Retry, aggregate verification, and final observation in the companion
rollout plan. Its uncertainty and rollback boundaries are mandatory.
