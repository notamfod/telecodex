# TeleCodex Rich Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver completed TeleCodex answers as durable Telegram Rich Markdown messages with embedded generated images and deterministic HTML fallback.

**Architecture:** Keep app-server deltas and the existing stage anchor unchanged until turn completion. Add a formatter that produces SDK-independent rich segments, persist strict `send_rich` and `edit_rich` payloads in the SQLite outbox, map them to typed grammY Bot API 10.2 calls, and atomically replace only proven-rejected rich parts with precomputed legacy parts.

**Tech Stack:** TypeScript 5.9, Node.js 20+, Vitest 3, grammY 1.45.1, `@grammyjs/types` 4.0.0, better-sqlite3.

---

## Execution constraints

- Work in `/root/Documents/Codex/2026-08-07-hermes/telecodex` on the existing `telecodex-improvements` branch.
- The feature depends on substantial uncommitted reliability work in this checkout. Preserve it; do not create a worktree from the stale `HEAD`.
- Read each file and inspect its existing diff before editing. Never reset, overwrite, or reformat unrelated work.
- Follow RED-GREEN-REFACTOR. Run each focused test before and after its implementation step.
- Do not commit, push, deploy, restart services, send Telegram messages, or modify live SQLite state without separate authorization.
- The generic Superpowers commit steps are replaced with non-mutating diff checkpoints:

```bash
git status --short -- <task-files>
git diff --check -- <task-files>
git diff -- <task-files>
```

## File map

Create focused modules:

- `src/telegram-rich-message.ts`: Rich Markdown sanitization, structural budgets, splitting, grouping, and deterministic generated-image IDs.
- `src/telegram-delivery-payload.ts`: strict legacy and rich payload types, canonical normalization, fallback normalization, and hashes.
- `src/telegram-delivery-replan.ts`: one SQLite transaction that replaces a proven-rejected rich row with canonical fallback rows.
- `test/telegram-rich-message.test.ts`: formatter and limit coverage.
- `test/telegram-delivery-replan.test.ts`: replan transaction, rollback, and race coverage.

Modify integration points:

- `src/telegram-response-plan.ts`: build rich primary parts and persisted legacy fallback parts.
- `src/telegram-grammy-transport.ts`: typed rich API mapping and bounded rich-rejection classification.
- `src/telegram-delivery-outbox.ts`: rich send/edit recovery semantics and safe fallback dispatch.
- `src/telegram-delivery-ledger.ts`: delegate rich replacement to the focused replan module.
- `src/telegram-job-store.ts`: expose the transactional replan operation.
- `src/telegram-job-types.ts`, `src/telegram-job-runtime.ts`, `src/telegram-job-transition.ts`, `src/telegram-job-ledger.ts`: append-only `delivery.replanned` event support.
- `package.json`, `package-lock.json`: grammY 1.45.1 and types 4.0.0.
- Existing focused test files for planner, transport, outbox, transition, and ledger behavior.

---

### Task 1: Format bounded Rich Markdown without Telegram SDK types

**Files:**
- Create: `src/telegram-rich-message.ts`
- Create: `test/telegram-rich-message.test.ts`
- Read: `src/format.ts`
- Read: `src/telegram-turn-result.ts`

- [ ] **Step 1: Write failing sanitizer and grouping tests**

Create `test/telegram-rich-message.test.ts` with a local `result()` helper and these exact behavioral assertions:

```ts
import { formatTelegramRichResult } from "../src/telegram-rich-message.js";

it("preserves supported Rich Markdown and neutralizes unsafe links and tags", () => {
  const parts = formatTelegramRichResult(result([
    { kind: "text", text: "# Title\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<details><summary>More</summary>$x^2$</details>\n\n[x](javascript:alert(1))<script>x</script>" },
  ]));
  expect(parts).toEqual([{ kind: "rich", markdown: expect.stringContaining("<details>"), media: [], source: expect.any(Array) }]);
  expect(parts[0]).not.toEqual(expect.objectContaining({ markdown: expect.stringContaining("javascript:") }));
  expect(parts[0]).not.toEqual(expect.objectContaining({ markdown: expect.stringContaining("<script>") }));
});

it("embeds generated images with deterministic IDs and separates files", () => {
  const parts = formatTelegramRichResult(result([
    { kind: "text", text: "before" },
    { kind: "attachment", attachment: { kind: "image", path: "outputs/chart.png" } },
    { kind: "attachment", attachment: { kind: "file", path: "outputs/report.pdf", name: "report.pdf" } },
    { kind: "text", text: "after" },
  ]));
  expect(parts.map((part) => part.kind)).toEqual(["rich", "file", "rich"]);
  expect(parts[0]).toMatchObject({
    markdown: expect.stringContaining("tg://photo?id=generated_0001"),
    media: [{ id: "generated_0001", path: "outputs/chart.png" }],
  });
});
```

Add cases for Unicode-safe 32,768-character boundaries, 50 images, 20 table columns, 16 nesting levels, 500 structural blocks, protected fenced code, protected tables, protected `details`, and an oversized fenced block reopened with its language on every chunk.

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run test/telegram-rich-message.test.ts
```

Expected: FAIL because `telegram-rich-message.ts` does not exist.

- [ ] **Step 3: Add the formatter contract and bounded scanner**

Create the module with these public types and constants:

```ts
import type { TelegramTurnResult, TelegramTurnResultContent } from "./telegram-turn-result.js";

export const TELEGRAM_RICH_CHARACTER_LIMIT = 32_768;
export const TELEGRAM_RICH_BLOCK_LIMIT = 500;
export const TELEGRAM_RICH_NESTING_LIMIT = 16;
export const TELEGRAM_RICH_MEDIA_LIMIT = 50;
export const TELEGRAM_RICH_TABLE_COLUMN_LIMIT = 20;

export interface TelegramRichImage {
  readonly id: string;
  readonly path: string;
  readonly name?: string;
}

export type TelegramFormattedRichPart =
  | { readonly kind: "rich"; readonly markdown: string; readonly media: readonly TelegramRichImage[]; readonly source: readonly TelegramTurnResultContent[] }
  | { readonly kind: "file"; readonly attachment: Extract<TelegramTurnResultContent, { kind: "attachment" }>["attachment"] }
  | { readonly kind: "legacy"; readonly source: readonly TelegramTurnResultContent[] };

export function formatTelegramRichResult(result: TelegramTurnResult): readonly TelegramFormattedRichPart[];
```

Implement one line scanner with explicit state for fenced code, inline code, table rows, block quotations, footnote definitions, and `<details>` depth. Protect code spans before tag and link sanitization. Permit only Bot API rich tags; escape every other `<...>` token. For `<a href>` and media `src`, retain only `http`, `https`, `tg`, and `mailto`; render every other target as non-clickable code text.

Group adjacent text and image content. Insert each image as its own Markdown media block using `![](tg://photo?id=<id>)`. Derive IDs from the one-based image ordinal with `generated_${String(ordinal).padStart(4, "0")}`. Flush before and after a `file` attachment.

Split only at scanner-recorded top-level boundaries. Count Unicode code points with `[...value].length`. When a fenced block alone exceeds the character budget, divide its body at newline boundaries and wrap every chunk with the original opening fence and a closing fence. Return a legacy-required result for any indivisible table, `details`, formula, or footnote definition that cannot fit or violates a structural budget.

- [ ] **Step 4: Run GREEN and checkpoint**

Run:

```bash
npx vitest run test/telegram-rich-message.test.ts test/format.test.ts
git diff --check -- src/telegram-rich-message.ts test/telegram-rich-message.test.ts
```

Expected: both test files pass and diff check prints nothing.

### Task 2: Persist strict rich payloads and build deterministic response plans

**Files:**
- Create: `src/telegram-delivery-payload.ts`
- Modify: `src/telegram-response-plan.ts`
- Modify: `src/telegram-delivery-outbox.ts`
- Modify: `src/telegram-delivery-ledger.ts`
- Modify: `src/telegram-status-anchor-ledger.ts`
- Modify: imports in tests that currently read payload helpers from `telegram-response-plan.ts`
- Test: `test/telegram-response-plan.test.ts`

- [ ] **Step 1: Write failing payload and planner tests**

Extend `test/telegram-response-plan.test.ts`:

```ts
it("turns one text result into a stable rich anchor edit", () => {
  const plan = buildTelegramResponsePlan({ result: result([{ kind: "text", text: "# Hello" }]), destination });
  expect(plan.anchor.payload).toMatchObject({
    operation: "edit_rich", chatId: -1001, messageId: 501,
    markdown: "# Hello", media: [], fallbackParts: [expect.objectContaining({ payload: expect.objectContaining({ operation: "edit_text" }) })],
  });
  expect(plan.responsePlan).toEqual([]);
});

it("builds one rich image send and keeps documents ordered", () => {
  const plan = buildTelegramResponsePlan({
    result: result([
      { kind: "text", text: "chart" },
      { kind: "attachment", attachment: { kind: "image", path: "outputs/chart.png" } },
      { kind: "attachment", attachment: { kind: "file", path: "outputs/report.pdf" } },
    ]), destination,
  });
  expect(plan.parts.map((part) => part.payload.operation)).toEqual(["send_rich", "send_media"]);
  expect(plan.parts.map((part) => part.partKey)).toEqual(["final:0000", "attachment:0000"]);
});
```

Add normalization tests that reject recursive fallback, absolute media paths, duplicate media IDs, unknown keys, more than 50 media entries, empty Markdown, and fallback part-key collisions. Retain the existing byte-for-byte legacy hash assertions.

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run test/telegram-response-plan.test.ts test/telegram-status-anchor-ledger.test.ts
```

Expected: FAIL because rich operations are not valid payloads.

- [ ] **Step 3: Extract and extend canonical payload normalization**

Move payload types, `normalizeTelegramDeliveryPayload`, `hashTelegramDeliveryPayload`, and inline-keyboard normalization into `src/telegram-delivery-payload.ts`. Re-export them from `telegram-response-plan.ts` temporarily so existing imports remain source-compatible.

Define non-recursive fallback parts and rich variants exactly once:

```ts
export type TelegramLegacyDeliveryPayload =
  | { readonly operation: "edit_text"; readonly chatId: number; readonly messageId: number; readonly text: string }
  | { readonly operation: "send_text"; readonly chatId: number; readonly messageThreadId: number | null; readonly text: string; readonly replyMarkup?: TelegramInlineKeyboard }
  | { readonly operation: "send_media"; readonly chatId: number; readonly messageThreadId: number | null; readonly mediaKind: "image" | "file"; readonly path: string; readonly name?: string; readonly caption?: string };

export interface TelegramFallbackPart {
  readonly partKey: string;
  readonly kind: "final" | "summary" | "attachment" | "notice";
  readonly payload: TelegramLegacyDeliveryPayload;
}

export type TelegramDeliveryPayload = TelegramLegacyDeliveryPayload
  | { readonly operation: "edit_rich"; readonly chatId: number; readonly messageId: number; readonly markdown: string; readonly media: readonly TelegramRichImage[]; readonly fallbackParts: readonly TelegramFallbackPart[] }
  | { readonly operation: "send_rich"; readonly chatId: number; readonly messageThreadId: number | null; readonly markdown: string; readonly media: readonly TelegramRichImage[]; readonly replyMarkup?: TelegramInlineKeyboard; readonly fallbackParts: readonly TelegramFallbackPart[] };
```

Canonicalize key order, arrays, path boundaries, IDs, Markdown length, and fallback part keys before hashing. Rich fallback payloads must be legacy variants only.

- [ ] **Step 4: Replace the planner's content builder**

Keep the existing legacy builder as `buildLegacyContentParts()`. Add `buildRichContentParts()` around `formatTelegramRichResult()`.

For every rich segment, precompute legacy fallback parts from its retained `source`. Use `final:<ordinal>:fallback:<ordinal>` keys inside `fallbackParts`; use stable top-level `final:0000` keys for the rich primary parts. If the formatter returns a local legacy-required segment, emit its legacy parts directly.

Emit `edit_rich` only for one text-only segment and a known anchor ID. For media, files, multiple rich segments, supplemental parts, or partial failure, retain the current `Response follows.` anchor and ordered ordinary parts.

- [ ] **Step 5: Run GREEN and compatibility tests**

Run:

```bash
npx vitest run test/telegram-response-plan.test.ts test/telegram-status-anchor-ledger.test.ts test/telegram-status-anchor-plan.test.ts test/telegram-job-retention.test.ts
git diff --check -- src/telegram-delivery-payload.ts src/telegram-response-plan.ts src/telegram-delivery-outbox.ts src/telegram-delivery-ledger.ts src/telegram-status-anchor-ledger.ts test
```

Expected: focused tests pass; existing legacy fixtures and hashes remain valid.

### Task 3: Upgrade grammY and map rich payloads to Bot API 10.2

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/telegram-grammy-transport.ts`
- Test: `test/telegram-grammy-transport.test.ts`

- [ ] **Step 1: Upgrade the typed Telegram dependency**

Run:

```bash
npm install grammy@1.45.1
```

Expected: `package.json` resolves grammY 1.45.1 and `package-lock.json` resolves `@grammyjs/types` 4.0.0. Do not run a broad package update.

- [ ] **Step 2: Write failing transport tests**

Extend the API fake with `sendRichMessage`. Assert:

```ts
await transport.deliver({
  operation: "send_rich", chatId: -1001, messageThreadId: 7,
  markdown: "chart\n\n![](tg://photo?id=generated_0001)",
  media: [{ id: "generated_0001", path: "answer.png" }],
  fallbackParts: [{ partKey: "final:0000:fallback:0000", kind: "final", payload: { operation: "send_text", chatId: -1001, messageThreadId: 7, text: "chart" } }],
}, signal);
expect(api.sendRichMessage).toHaveBeenCalledWith(
  -1001,
  expect.objectContaining({ markdown: expect.stringContaining("generated_0001"), media: [expect.objectContaining({ id: "generated_0001" })] }),
  { message_thread_id: 7 },
  signal,
);
```

Assert `edit_rich` calls `editMessageText(chatId, messageId, richMessage, {}, signal)`. Add a real contained file, symlink escape, missing file, duplicate media-ID, and pre-aborted signal case.

Add classifier cases for `429`, `message is not modified`, rich parse rejection, unavailable rich method, unrelated `400`, `403`, and network timeout.

- [ ] **Step 3: Run RED**

Run:

```bash
npx vitest run test/telegram-grammy-transport.test.ts
```

Expected: rich calls are not implemented.

- [ ] **Step 4: Implement typed rich transport and bounded classification**

Extend the API pick to include `sendRichMessage`. Build `InputRichMessage` with exactly one `markdown` field plus optional `media`. Convert every durable image to `{ id, media: { type: "photo", media: new InputFile(absolutePath) } }` after the existing contained-file check.

Extend `TelegramDeliveryApiError` with:

```ts
readonly code: "not_sent" | "retry_after" | "message_not_modified" | "rich_rejected" | "permanent";
readonly richReason?: "format" | "method_unavailable";
```

Classify `rich_rejected` only for HTTP 400 descriptions that match a bounded allowlist for rich parsing or a missing `sendRichMessage` method. Do not classify missing topics, rights, chat IDs, or generic `400` as fallback-safe. Keep raw descriptions out of the exception message and persisted state.

- [ ] **Step 5: Run GREEN and typecheck**

Run:

```bash
npx vitest run test/telegram-grammy-transport.test.ts
npm run build:server
git diff --check -- package.json package-lock.json src/telegram-grammy-transport.ts test/telegram-grammy-transport.test.ts
```

Expected: transport tests and TypeScript build pass.

### Task 4: Atomically replace a rejected rich delivery with fallback rows

**Files:**
- Create: `src/telegram-delivery-replan.ts`
- Create: `test/telegram-delivery-replan.test.ts`
- Modify: `src/telegram-job-types.ts`
- Modify: `src/telegram-job-runtime.ts`
- Modify: `src/telegram-job-transition.ts`
- Modify: `src/telegram-job-ledger.ts`
- Modify: `src/telegram-delivery-ledger.ts`
- Modify: `src/telegram-job-store.ts`
- Test: `test/telegram-job-transition.test.ts`
- Test: `test/telegram-job-ledger-acceptance.test.ts`

- [ ] **Step 1: Write failing event and transaction tests**

Add a transition test for:

```ts
const replanned = apply(deliveringJob, {
  schemaVersion: 1,
  type: "delivery.replanned",
  phase: "delivering",
  reasonCode: "rich_format_rejected",
  responsePlan: [{ partId: "final:0000:fallback:0000", kind: "final" }],
  deliveries: [{ partId: "final:0000:fallback:0000", state: "pending", attempts: 0, messageId: null, deliveredAt: null }],
  eventAt,
});
expect(replanned.responsePlan?.[0]?.partId).toBe("final:0000:fallback:0000");
```

In `test/telegram-delivery-replan.test.ts`, create a real SQLite job with a `sending` rich row. Assert that exact expected job version, part state, attempt count, and hash replace it with ordered pending fallback rows in one event. Add rollback on duplicate key, stale version, stale attempt, delivered/uncertain primary, malformed fallback, and two-store race cases. Add a status-anchor case that replaces `edit_rich` with `edit_text` while preserving its known message ID and planned-anchor record.

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run test/telegram-job-transition.test.ts test/telegram-delivery-replan.test.ts
```

Expected: `delivery.replanned` and the store operation do not exist.

- [ ] **Step 3: Add the append-only event contract**

Add:

```ts
export interface DeliveryReplannedEvent extends TelegramJobEventBase {
  readonly type: "delivery.replanned";
  readonly phase?: "delivering";
  readonly reasonCode: "rich_format_rejected" | "rich_method_unavailable" | "rich_local_fallback";
  readonly responsePlan: readonly TelegramResponsePlanPart[];
  readonly deliveries: readonly TelegramDeliveryPart[];
}
```

Include it in `TelegramJobEvent`, both persisted event allowlists, event key validation, phase resolution, parsing, clone/replay, and delivery metadata validation. It changes only `responsePlan`, `deliveries`, `updatedAt`, and `version`; it cannot change outcome, identifiers, health, or terminal state.

- [ ] **Step 4: Implement the focused replan transaction**

Define `ReplanRichDeliveryInput` with job ID, part key, expected job version/state/attempt/hash, event ID/time, and bounded reason. `TelegramDeliveryReplan.replace()` must:

1. load and normalize the exact rich primary row;
2. reject delivered, uncertain, legacy, stale, or hash-mismatched rows;
3. derive fallback rows only from the persisted `fallbackParts`;
4. replace the ordinary response-plan entry and shift later ordinals, or update the status anchor and `status_anchor_plans` together;
5. apply `delivery.replanned` through the host transition;
6. commit with `transaction(...).immediate()`.

Expose it as `replaceRejectedRichDelivery()` on `SqliteTelegramJobStore`, then through the narrow outbox store type. Keep SQL and row projection inside `telegram-delivery-replan.ts`; `telegram-delivery-ledger.ts` should only construct and delegate to it.

- [ ] **Step 5: Run GREEN and ledger regressions**

Run:

```bash
npx vitest run test/telegram-job-transition.test.ts test/telegram-job-ledger-acceptance.test.ts test/telegram-delivery-replan.test.ts test/telegram-delivery-outbox.test.ts
git diff --check -- src/telegram-delivery-replan.ts src/telegram-job-types.ts src/telegram-job-runtime.ts src/telegram-job-transition.ts src/telegram-job-ledger.ts src/telegram-delivery-ledger.ts src/telegram-job-store.ts test
```

Expected: event replay, replan transaction, and existing ledger/outbox tests pass.

### Task 5: Apply fallback and recovery rules in the outbox

**Files:**
- Modify: `src/telegram-delivery-outbox.ts`
- Modify: `src/telegram-reliability-runtime.ts` only if the store port needs the new method
- Test: `test/telegram-delivery-outbox.test.ts`
- Test: `test/telegram-reliability-faults.test.ts`

- [ ] **Step 1: Write failing fallback and recovery tests**

Add cases proving:

- explicit `rich_rejected/format` causes zero automatic retry of the rich request and installs fallback rows;
- `rich_rejected/method_unavailable` replans subsequent untouched rich parts without an API call during that process lifetime;
- a timeout from `send_rich` becomes uncertain and never falls back;
- a timeout from `edit_rich` queues a safe retry;
- restart turns `sending send_rich` into uncertain and `sending edit_rich` into pending;
- fallback transaction failure leaves attention required and does not send either representation;
- `message is not modified` succeeds only for `edit_text` and `edit_rich`.

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run test/telegram-delivery-outbox.test.ts test/telegram-reliability-faults.test.ts
```

Expected: rich edits are treated as ambiguous sends and rich rejection becomes permanent failure.

- [ ] **Step 3: Extend outbox operation classification**

Add one helper and use it everywhere the outbox distinguishes edits from sends:

```ts
function isKnownEdit(payload: TelegramDeliveryPayload): payload is Extract<TelegramDeliveryPayload, { operation: "edit_text" | "edit_rich" }> {
  return payload.operation === "edit_text" || payload.operation === "edit_rich";
}
```

On `rich_rejected`, call `replaceRejectedRichDelivery()` with the exact sending-row evidence and return `true` so the pump continues with newly committed fallback rows. Set an in-memory `richUnavailable` flag only for `method_unavailable`; when set, replan a pending rich row before moving it to `sending`.

If replan conflicts, reload and continue only when another worker already installed the exact fallback plan. Any other failure sets bounded attention and performs no network call.

Extend `safePayload()` to validate every rich media path before `pending -> sending`. A missing or unsafe path becomes bounded `delivery_media_unavailable` attention with no Telegram call; it is never classified as ambiguous.

- [ ] **Step 4: Run GREEN and race tests**

Run:

```bash
npx vitest run test/telegram-delivery-outbox.test.ts test/telegram-delivery-replan.test.ts test/telegram-reliability-faults.test.ts
git diff --check -- src/telegram-delivery-outbox.ts src/telegram-reliability-runtime.ts test/telegram-delivery-outbox.test.ts test/telegram-delivery-replan.test.ts test/telegram-reliability-faults.test.ts
```

Expected: focused suites pass with no duplicate rich or fallback send.

### Task 6: Run the full regression and review the final diff

**Files:**
- Review every file changed in Tasks 1-5
- Do not modify deployment or runtime state

- [ ] **Step 1: Run focused rich-message suites together**

Run:

```bash
npx vitest run test/telegram-rich-message.test.ts test/telegram-response-plan.test.ts test/telegram-grammy-transport.test.ts test/telegram-delivery-replan.test.ts test/telegram-delivery-outbox.test.ts test/telegram-job-transition.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run repository verification**

Invoke `verification-before-completion`, then run:

```bash
npm test
npm run check:web
npm run build
git diff --check
```

Expected: Vitest reports zero failures, Svelte check reports zero errors, TypeScript and Vite builds succeed, and diff check prints nothing.

- [ ] **Step 3: Perform the required code review**

Invoke `requesting-code-review`. Review specifically for unsafe Markdown or URL handling, local path escape, payload recursion, nondeterministic hashes, one-to-many fallback races, invalid status-anchor replacement, automatic retry after ambiguous send, legacy-row compatibility, and accidental edits to unrelated WIP.

Apply review findings with RED-GREEN tests, then rerun the commands from Steps 1 and 2.

- [ ] **Step 4: Report the local boundary accurately**

Report changed files, exact passing command results, and remaining unverified live behavior. State explicitly that no commit, push, Telegram smoke message, systemd restart, SQLite migration, or deployment occurred.

Do not claim Telegram rendering is live-verified until the user separately authorizes a designated topic smoke test and service rollout.
