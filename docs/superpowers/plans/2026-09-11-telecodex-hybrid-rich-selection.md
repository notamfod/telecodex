# TeleCodex Hybrid Rich Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send ordinary final Markdown through compact Telegram HTML while retaining native Rich Messages only for advanced constructs and positioned images.

**Architecture:** Add a pure selector above the existing formatter and durable response planner. The selector classifies normalized text runs without changing their content; the planner keeps the existing Rich Message formatter, fallback rows, payload validation, hashes, outbox, and recovery paths. Activation is split into text-only and mixed-content releases so each change can be tested and deployed independently.

**Tech Stack:** TypeScript 5.9, Vitest, existing Telegram HTML formatter, existing Rich Message scanner and formatter, SQLite durable delivery ledger, grammY.

---

## Boundaries

- This plan implements Step 07.1 from `docs/superpowers/specs/2026-09-10-telecodex-telegram-output-quality-cycle-design.md` only.
- Do not implement the spacing and fence-normalization changes reserved for Step 07.2.
- Do not change the Dashboard topic reserved for Step 07.3.
- Do not change `TelegramDeliveryPayload`, response-plan persistence, SQLite schema, outbox transitions, rich fallback replacement, uncertainty handling, or retry policy.
- Existing persisted `send_rich`, `edit_rich`, `send_text`, and `edit_text` rows remain valid and are never replanned during startup.
- Files remain separate durable `send_media` parts. An image attachment may join surrounding text in a Rich Message because its position is meaningful.
- Invalid or over-limit rich input keeps the existing local legacy fallback behavior.
- Do not replay, release, delete, or repair the contained historical status-anchor or its two pending followers.
- Do not send an automatic Telegram smoke message. Live acceptance uses only messages initiated by the user after deployment.
- A commit, restart, push, merge, and historical repair are separate permissions. Stop for explicit approval at every microrelease checkpoint.
- New source and test files stay below 500 lines. Avoid a new Markdown dependency: the repository already has the exact scanner and sanitizer used by the Rich Message path.

## File map

- Create `src/telegram-representation-selector.ts`: pure compact-versus-rich classification for text and normalized turn results.
- Create `test/telegram-representation-selector.test.ts`: ordinary, advanced, literal, dependency, attachment, and determinism fixtures.
- Modify `src/telegram-response-plan.ts:13-18,80-130,258-297`: select compact text before creating durable parts and expose a compact editable anchor candidate.
- Modify `test/telegram-response-plan.test.ts:22-219,236-383`: assert text-only activation, advanced compatibility, mixed ordering, and stable hashes.
- Reuse without changing `src/format.ts`: Telegram HTML formatting and bounded Markdown splitting.
- Reuse without changing `src/telegram-rich-message.ts`: native rich formatting, positioned image IDs, limits, and rich-to-legacy fallback source.
- Reuse without changing `src/telegram-delivery-payload.ts`: strict payload validation and deterministic hashes.
- Reuse without changing `src/telegram-delivery-replan.ts` and `src/telegram-delivery-outbox.ts`: fallback replacement and delivery semantics.

## Microrelease 07.1a: Pure representation selector

### Task 1: Classify ordinary and advanced Telegram content without changing planning

**Files:**
- Create: `src/telegram-representation-selector.ts`
- Create: `test/telegram-representation-selector.test.ts`

- [ ] **Step 1: Write failing ordinary-content tests**

Create `test/telegram-representation-selector.test.ts` with typed helpers and a table proving that paragraphs, headings, emphasis, links, lists, quotes, inline code, and fenced code select compact HTML:

```ts
import {
  selectTelegramTextRepresentation,
  selectTelegramTurnRepresentation,
} from "../src/telegram-representation-selector.js";
import type { TelegramTurnResult } from "../src/telegram-turn-result.js";

const textResult = (text: string): TelegramTurnResult => ({
  schemaVersion: 1,
  content: [{ kind: "text", text }],
});

describe("Telegram representation selector", () => {
  it.each([
    ["paragraph", "Обычный абзац."],
    ["heading", "## Раздел\n\nТекст"],
    ["emphasis and link", "**важно** и [ссылка](https://example.com)"],
    ["link with query dollars", "[API](https://example.com/?$select=id&$filter=active)"],
    ["bare URL with query dollars", "API: https://example.com/?$select=id&$filter=active"],
    ["autolink with query dollars", "<https://example.com/?$select=id&$filter=active>"],
    ["list", "- первый\n- второй\n  - вложенный"],
    ["quote", "> цитата"],
    ["inline code", "Запусти `npm test`."],
    ["fenced code", "```ts\nconst answer = 42;\n```"],
  ])("selects compact HTML for %s", (_name, source) => {
    expect(selectTelegramTextRepresentation({ source, positionedImageCount: 0 }))
      .toBe("compact_html");
    expect(selectTelegramTurnRepresentation(textResult(source))).toBe("compact_html");
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
TMPDIR=/var/tmp npx vitest run test/telegram-representation-selector.test.ts
```

Expected: FAIL because `src/telegram-representation-selector.ts` does not exist.

- [ ] **Step 3: Add failing advanced-content and literal-safety tests**

Extend the same suite with supported advanced constructs and nearby literals:

```ts
it.each([
  ["Markdown table", "| A | B |\n|---|---|\n| 1 | 2 |"],
  ["HTML table", "<table><tr><td>1</td></tr></table>"],
  ["inline formula", "Площадь: $a^2$."],
  ["block formula", "$$\nE = mc^2\n$$"],
  ["details", "<details><summary>Ещё</summary>Текст</details>"],
  ["footnote", "Ответ[^n].\n\n[^n]: пояснение"],
  ["reference definition", "[документация][docs]\n\n[docs]: https://example.com/docs"],
  ["inline image", "![chart](https://example.com/chart.png)"],
  ["reference image", "![chart][img]\n\n[img]: https://example.com/chart.png"],
])("selects native rich for %s", (_name, source) => {
  expect(selectTelegramTextRepresentation({ source, positionedImageCount: 0 }))
    .toBe("native_rich");
});

it.each([
  ["inline literals", "`| A | B |`, `$x$`, `<details>` and `![x](url)`"],
  ["fenced literals", "```text\n| A | B |\n$x$\n<details>\n![x](url)\n```"],
    ["escaped formula", "Цена: \\$5, не формула."],
    ["escaped image", "\\![chart](https://example.com/chart.png)"],
    ["escaped HTML", "\\<details>literal\\</details> and \\<table>literal\\</table>"],
])("does not promote %s", (_name, source) => {
  expect(selectTelegramTextRepresentation({ source, positionedImageCount: 0 }))
    .toBe("compact_html");
});
```

Add attachment and cross-content dependency cases:

```ts
it("uses rich for a positioned image but not for a separate file", () => {
  const image: TelegramTurnResult = {
    schemaVersion: 1,
    content: [{ kind: "attachment", attachment: { kind: "image", path: "outputs/chart.png" } }],
  };
  const file: TelegramTurnResult = {
    schemaVersion: 1,
    content: [
      { kind: "text", text: "Отчёт" },
      { kind: "attachment", attachment: { kind: "file", path: "outputs/report.pdf" } },
    ],
  };
  expect(selectTelegramTurnRepresentation(image)).toBe("native_rich");
  expect(selectTelegramTurnRepresentation(file)).toBe("compact_html");
});

it("joins adjacent text while resolving an image reference", () => {
  const result: TelegramTurnResult = {
    schemaVersion: 1,
    content: [
      { kind: "text", text: "![chart][asset]" },
      { kind: "text", text: "[asset]: https://example.com/chart.png" },
    ],
  };
  expect(selectTelegramTurnRepresentation(result)).toBe("native_rich");
});

it("keeps invalid advanced input on the existing rich-to-legacy path", () => {
  expect(selectTelegramTextRepresentation({
    source: "<details><summary>broken</summary>",
    positionedImageCount: 0,
  })).toBe("native_rich");
});

it("keeps over-limit advanced input on the existing rich-to-legacy path", () => {
  const cells = Array.from({ length: 21 }, (_, index) => `c${index}`);
  const source = `| ${cells.join(" | ")} |\n| ${cells.map(() => "---").join(" | ")} |`;
  expect(selectTelegramTextRepresentation({ source, positionedImageCount: 0 }))
    .toBe("native_rich");
});
```

- [ ] **Step 4: Implement the pure selector**

Create `src/telegram-representation-selector.ts`. Keep the public contract limited to two string results and do not return source fragments, identities, or mutable parser state:

```ts
import {
  TELEGRAM_RICH_BLOCK_LIMIT,
  TELEGRAM_RICH_MEDIA_LIMIT,
  TELEGRAM_RICH_NESTING_LIMIT,
  TELEGRAM_RICH_TABLE_COLUMN_LIMIT,
} from "./telegram-rich-message.js";
import {
  scanTelegramRichMarkdown,
  telegramRichDependencyLabels,
  type TelegramRichMarkdownUnit,
} from "./telegram-rich-markdown.js";
import {
  buildDelimiterMaps,
  buildEscapeMap,
  tokenizeTelegramRichHtml,
} from "./telegram-rich-tokens.js";
import type { TelegramTurnResult } from "./telegram-turn-result.js";

export type TelegramTextRepresentation = "compact_html" | "native_rich";

export interface TelegramTextRepresentationInput {
  readonly source: string;
  readonly positionedImageCount: number;
}

const SCAN_LIMITS = {
  blocks: TELEGRAM_RICH_BLOCK_LIMIT,
  nesting: TELEGRAM_RICH_NESTING_LIMIT,
  media: TELEGRAM_RICH_MEDIA_LIMIT,
  tableColumns: TELEGRAM_RICH_TABLE_COLUMN_LIMIT,
} as const;
const MAX_ADJACENT_TEXT_BATCH_CHARACTERS = 1_000_000;

export function selectTelegramTextRepresentation(
  input: TelegramTextRepresentationInput,
): TelegramTextRepresentation {
  if (!Number.isSafeInteger(input.positionedImageCount) || input.positionedImageCount < 0) {
    throw new Error("Invalid positioned image count");
  }
  if (input.positionedImageCount > 0) return "native_rich";
  return scanTelegramRichMarkdown(maskEscapedAdvancedMarkers(input.source), SCAN_LIMITS)
    .some(requiresNativeRich)
    ? "native_rich"
    : "compact_html";
}

export function selectTelegramTurnRepresentation(
  result: TelegramTurnResult,
): TelegramTextRepresentation {
  let adjacentText: string[] = [];
  let adjacentTextLength = 0;
  const flush = (): boolean => {
    if (adjacentText.length === 0) return false;
    const source = adjacentText.join("\n\n");
    adjacentText = [];
    adjacentTextLength = 0;
    return selectTelegramTextRepresentation({ source, positionedImageCount: 0 }) === "native_rich";
  };
  for (const content of result.content) {
    if (content.kind === "text") {
      adjacentTextLength += (adjacentText.length === 0 ? 0 : 2) + content.text.length;
      if (adjacentTextLength > MAX_ADJACENT_TEXT_BATCH_CHARACTERS) return "native_rich";
      adjacentText.push(content.text);
      continue;
    }
    if (flush() || content.attachment.kind === "image") return "native_rich";
  }
  return flush() ? "native_rich" : "compact_html";
}

function requiresNativeRich(unit: TelegramRichMarkdownUnit): boolean {
  if (!unit.valid || unit.columns > 0 || unit.mediaCount > 0) return true;
  const dependencies = telegramRichDependencyLabels(unit.source, 1_024);
  if (dependencies.overflow || dependencies.definitions.size > 0 ||
    [...dependencies.usages].some((label) => label.startsWith("footnote:"))) return true;
  if (unit.fence) return false;
  const visible = withoutInlineCode(unit.source);
  if (hasFormula(withoutUrlText(withoutMarkdownLinkTargets(visible)))) return true;
  return tokenizeTelegramRichHtml(visible).some((token) => token.kind === "markup"
    && token.parsed !== undefined
    && ["details", "table", "tg-math", "tg-math-block"].includes(token.parsed.tag));
}

function withoutUrlText(source: string): string {
  const protocols = ["https://", "http://", "tg://", "mailto:"];
  const lower = source.toLowerCase();
  const characters = source.split("");
  for (let index = 0; index < source.length;) {
    const protocol = protocols.find((candidate) => lower.startsWith(candidate, index));
    if (!protocol) {
      index += 1;
      continue;
    }
    let end = index + protocol.length;
    while (end < source.length && source[end] !== ">" && source[end]!.trim() !== "") end += 1;
    characters.fill(" ", index, end);
    index = end;
  }
  return characters.join("");
}

function withoutMarkdownLinkTargets(source: string): string {
  const escaped = buildEscapeMap(source);
  const delimiters = buildDelimiterMaps(source, escaped);
  const characters = source.split("");
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "[" || escaped[index]) continue;
    const labelEnd = delimiters.brackets[index] ?? -1;
    if (labelEnd < 0 || source[labelEnd + 1] !== "(") continue;
    const targetEnd = delimiters.parentheses[labelEnd + 1] ?? -1;
    if (targetEnd < 0) continue;
    characters.fill(" ", labelEnd + 2, targetEnd);
    index = targetEnd;
  }
  return characters.join("");
}

function maskEscapedAdvancedMarkers(source: string): string {
  const escaped = buildEscapeMap(source);
  const characters = source.split("");
  for (let index = 0; index < characters.length; index += 1) {
    if (escaped[index] && ["!", "$", "<"].includes(characters[index]!)) characters[index] = " ";
  }
  return characters.join("");
}
```

Add these private helpers below `requiresNativeRich`. They make one bounded pass to index delimiters, never inspect a fenced unit, mask only closed same-line code spans, preserve newlines and UTF-16 offsets, and recognize paired inline delimiters plus closed multiline `$$` boundaries:

```ts
interface InlineDelimiterRun {
  readonly start: number;
  readonly end: number;
  readonly width: number;
  readonly line: number;
}

function withoutInlineCode(source: string): string {
  const escaped = buildEscapeMap(source);
  const runs: InlineDelimiterRun[] = [];
  let line = 0;
  for (let index = 0; index < source.length;) {
    if (source[index] === "\n") {
      line += 1;
      index += 1;
      continue;
    }
    if (source[index] !== "`" || escaped[index]) {
      index += 1;
      continue;
    }
    const start = index;
    while (source[index] === "`") index += 1;
    runs.push({ start, end: index, width: index - start, line });
  }

  const nextMatching = new Int32Array(runs.length).fill(-1);
  const nextByLineAndWidth = new Map<string, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    const key = `${run.line}:${run.width}`;
    nextMatching[index] = nextByLineAndWidth.get(key) ?? -1;
    nextByLineAndWidth.set(key, index);
  }

  let output = "";
  let cursor = 0;
  for (let index = 0; index < runs.length; index += 1) {
    const opening = runs[index]!;
    if (opening.start < cursor) continue;
    const closingIndex = nextMatching[index]!;
    if (closingIndex < 0) continue;
    const closing = runs[closingIndex]!;
    output += source.slice(cursor, opening.start);
    output += " ".repeat(closing.end - opening.start);
    cursor = closing.end;
    index = closingIndex;
  }
  return `${output}${source.slice(cursor)}`;
}

function hasFormula(source: string): boolean {
  const escaped = buildEscapeMap(source);
  const pendingInlineWidths = new Set<number>();
  let blockBoundarySeen = false;
  let lineStart = 0;

  for (let index = 0; index <= source.length;) {
    if (index === source.length || source[index] === "\n") {
      if (isFormulaBoundaryLine(source.slice(lineStart, index))) {
        if (blockBoundarySeen) return true;
        blockBoundarySeen = true;
      }
      pendingInlineWidths.clear();
      lineStart = index + 1;
      index += 1;
      continue;
    }
    if (source[index] !== "$" || escaped[index]) {
      index += 1;
      continue;
    }
    const start = index;
    while (source[index] === "$" && !escaped[index]) index += 1;
    const runWidth = index - start;
    const candidateWidths = runWidth === 1 ? [1] : runWidth === 2 ? [2] : [1, 2];
    for (const width of candidateWidths) {
      if (pendingInlineWidths.has(width)) return true;
      pendingInlineWidths.add(width);
    }
  }
  return false;
}

function isFormulaBoundaryLine(line: string): boolean {
  let index = 0;
  while (index < 3 && line[index] === " ") index += 1;
  if (!line.startsWith("$$", index)) return false;
  index += 2;
  while (line[index] === " " || line[index] === "\t") index += 1;
  return index === line.length;
}
```

The selector deliberately returns `native_rich` for invalid or over-limit advanced units. That preserves the current `formatTelegramRichResult` decision to emit a local `legacy` fallback instead of bypassing its validation path.

- [ ] **Step 5: Add determinism and bounded-work regression tests**

```ts
it("is deterministic and does not mutate the result", () => {
  const input = textResult("## Report\n\n- one\n- two");
  const before = JSON.stringify(input);
  expect(selectTelegramTurnRepresentation(input))
    .toBe(selectTelegramTurnRepresentation(structuredClone(input)));
  expect(JSON.stringify(input)).toBe(before);
});

it("classifies one million ordinary characters without constructing rich payloads", () => {
  expect(selectTelegramTextRepresentation({
    source: "x".repeat(1_000_000),
    positionedImageCount: 0,
  })).toBe("compact_html");
});

it("bounds adjacent text runs before joining them", () => {
  const result: TelegramTurnResult = {
    schemaVersion: 1,
    content: [
      { kind: "text", text: "a".repeat(800_000) },
      { kind: "text", text: "b".repeat(800_000) },
    ],
  };
  expect(selectTelegramTurnRepresentation(result)).toBe("native_rich");
});
```

- [ ] **Step 6: Run focused verification**

```bash
TMPDIR=/var/tmp npx vitest run test/telegram-representation-selector.test.ts \
  test/telegram-rich-markdown.test.ts test/telegram-rich-message.test.ts
npx tsc --noEmit
git diff --check
```

Expected: all focused tests pass, TypeScript succeeds, and Git reports no whitespace errors.

- [ ] **Step 7: Run the complete repository gate**

```bash
TMPDIR=/var/tmp npm test
npm run check:web
npm run build
git diff --check
git status --short
```

Expected: all tests pass, Svelte reports zero errors and zero warnings, both builds succeed, and the change set contains only the selector, its tests, and this plan.

- [ ] **Step 8: Review and checkpoint 07.1a**

Confirm that the selector is not imported by `src/telegram-response-plan.ts`, no delivery behavior changed, and no new dependency or configuration was added. Stop for user review. Commit only after explicit authorization:

```bash
git add docs/superpowers/plans/2026-09-11-telecodex-hybrid-rich-selection.md \
  src/telegram-representation-selector.ts test/telegram-representation-selector.test.ts
git diff --cached --check
git commit -m "NO-TICKET feat: classify telegram response representation"
```

After separate live approval, rebuild the exact commit, run `npm run release:preflight`, create the verified mode-`0600` SQLite backup, restart `telecodex.service` exactly once, and verify stable PID, `NRestarts=0`, Guardian readiness, `quick_check=ok`, zero foreign-key violations, `sending=0`, `uncertain=0`, authenticated `getMe`, and secret-free fresh logs. Do not send a smoke message because 07.1a has no runtime consumer.

## Microrelease 07.1b: Compact HTML for text-only final answers

### Task 2: Activate the selector for text-only results and editable anchors

**Files:**
- Modify: `src/telegram-response-plan.ts:13-18,80-130,258-297`
- Modify: `test/telegram-response-plan.test.ts:22-74,139-156,203-303`

- [ ] **Step 1: Write failing compact-anchor tests**

Change the current `# Hello` expectation and add ordinary Markdown fixtures. A single ordinary result with an anchor must become one `edit_text` anchor and no response rows:

```ts
it("edits the status anchor with compact HTML for one ordinary final answer", () => {
  const plan = buildTelegramResponsePlan({
    result: result([{ kind: "text", text: "# Hello\n\n- one\n- two" }]),
    destination,
  });
  expect(plan.anchor).toMatchObject({
    partKey: "status-anchor",
    payload: {
      operation: "edit_text",
      chatId: -1001,
      messageId: 501,
      text: "<b>Hello</b>\n\n• one\n• two",
    },
  });
  expect(plan.responsePlan).toEqual([]);
  expect(plan.parts).toEqual([]);
});

it("uses compact send_text after commentary or without an editable anchor", () => {
  const withCommentary = buildTelegramResponsePlan({
    result: result([
      { kind: "text", phase: "commentary", text: "Checking." },
      { kind: "text", phase: "final_answer", text: "## Done" },
    ]),
    destination,
  });
  expect(withCommentary.parts.map((part) => part.payload.operation))
    .toEqual(["send_text", "send_text"]);
  const withoutAnchor = buildTelegramResponsePlan({
    result: result([{ kind: "text", text: "hello" }]),
    destination: { chatId: -1001, messageThreadId: 77, anchorMessageId: null },
  });
  expect(withoutAnchor.parts[0]?.payload.operation).toBe("send_text");
});
```

- [ ] **Step 2: Run the response-plan test and verify RED**

```bash
TMPDIR=/var/tmp npx vitest run test/telegram-response-plan.test.ts
```

Expected: FAIL because ordinary final text still produces `edit_rich` or `send_rich`.

- [ ] **Step 3: Add rich-compatibility fixtures before changing production code**

Pin the existing table and positioned-image behavior to their current payload hashes:

```ts
it("keeps an advanced table on the existing rich anchor contract", () => {
  const plan = buildTelegramResponsePlan({
    result: result([{ kind: "text", text: "| A | B |\n|---|---|\n| 1 | 2 |" }]),
    destination,
  });
  expect(plan.anchor.payload.operation).toBe("edit_rich");
  expect(plan.anchor.contentHash)
    .toBe("ba6271b979233e17ff6008c3a1c836639587e0cb5b536b490cb0ae3a6c815fbb");
});
```

Keep the generated-image fixture for 07.1c unchanged at this checkpoint. This ensures 07.1b does not alter mixed-content planning.

- [ ] **Step 4: Add a compact editable candidate to the content plan**

Import `selectTelegramTurnRepresentation`. Replace `TelegramRichContentPlan` with a neutral internal plan:

```ts
type TelegramEditableFinal =
  | { readonly kind: "compact"; readonly html: string }
  | { readonly kind: "rich"; readonly formatted: Extract<TelegramFormattedRichPart, { kind: "rich" }> };

interface TelegramContentPlan {
  readonly parts: readonly TelegramPlannedResponsePart[];
  readonly singleText?: TelegramEditableFinal;
}
```

Add a text-only compact builder that reuses `buildLegacyContentParts` and accepts an editable candidate only when exactly one `send_text` row was produced:

```ts
function buildCompactTextContentParts(
  result: TelegramTurnResult,
  destination: TelegramResponseDestination,
): TelegramContentPlan {
  const parts = buildLegacyContentParts(result, destination);
  const only = parts.length === 1 && parts[0]?.payload.operation === "send_text"
    ? { kind: "compact" as const, html: parts[0].payload.text }
    : undefined;
  return { parts, ...(only === undefined ? {} : { singleText: only }) };
}

function buildSelectedContentParts(
  result: TelegramTurnResult,
  destination: TelegramResponseDestination,
): TelegramContentPlan {
  const textOnly = result.content.every((content) => content.kind === "text");
  return textOnly && selectTelegramTurnRepresentation(result) === "compact_html"
    ? buildCompactTextContentParts(result, destination)
    : buildRichContentParts(result, destination);
}
```

Return `{ kind: "rich", formatted }` from the existing single-rich candidate instead of returning the formatter part directly.

```ts
const singleText = formatted.length === 1 && formatted[0]?.kind === "rich"
  && formatted[0].media.length === 0 && result.content.every((content) => content.kind === "text")
  && hasSingleEditFallback(formatted[0], destination)
  ? { kind: "rich" as const, formatted: formatted[0] }
  : undefined;
return { parts, ...(singleText === undefined ? {} : { singleText }) };
```

- [ ] **Step 5: Wire compact and rich editable anchors without changing durable payload types**

Replace `editableRich` with one eligibility gate and a tagged candidate:

```ts
const editable = failure === undefined
  && summaries.length === 0
  && Array.isArray(input.supplementalParts ?? [])
  && (input.supplementalParts ?? []).length === 0
  && destination.anchorMessageId !== null
  ? generated.singleText
  : undefined;
const anchor = editable?.kind === "compact"
  ? part(TELEGRAM_STATUS_ANCHOR_PART_KEY, 0, "status-anchor", {
      operation: "edit_text",
      chatId: destination.chatId,
      messageId: destination.anchorMessageId!,
      text: editable.html,
    })
  : editable?.kind === "rich"
    ? richAnchorPart(destination, editable.formatted)
    : part(
        TELEGRAM_STATUS_ANCHOR_PART_KEY,
        0,
        "status-anchor",
        anchorPayload(destination, generated.parts.length === 0
          ? failure === undefined ? "Completed." : failureText(failure)
          : "Response follows."),
      );
const content = [...summaries, ...(editable === undefined ? generated.parts : [])];
```

Call `buildSelectedContentParts(finalResult, destination)` at the current generation seam. Do not modify the payload normalizer or hash function.

- [ ] **Step 6: Update affected text-only expectations and add split coverage**

Update only fixtures whose final content is ordinary text. Keep tables, formulas, details, footnotes, embedded images, positioned images, invalid rich fallback, attachments, and hand-built durable rich rows unchanged.

Add a long ordinary answer assertion:

```ts
it("splits oversized ordinary text into bounded compact rows", () => {
  const plan = buildTelegramResponsePlan({
    result: result([{ kind: "text", text: "word ".repeat(2_000) }]),
    destination,
  });
  expect(plan.anchor.payload).toMatchObject({ operation: "edit_text", text: "Response follows." });
  expect(plan.parts.length).toBeGreaterThan(1);
  expect(plan.parts.every((part) => part.payload.operation === "send_text")).toBe(true);
  expect(plan.parts.every((part) => part.payload.operation !== "send_text"
    || [...part.payload.text].length <= 4_096)).toBe(true);
});
```

- [ ] **Step 7: Run focused compatibility tests**

```bash
TMPDIR=/var/tmp npx vitest run \
  test/telegram-representation-selector.test.ts \
  test/telegram-response-plan.test.ts \
  test/telegram-response-plan-budget.test.ts \
  test/telegram-delivery-payload.test.ts \
  test/telegram-delivery-replan.test.ts \
  test/telegram-topic-resume-rich-lineage.test.ts
npm run build:server
git diff --check
```

Expected: ordinary text-only plans use text operations, advanced and mixed fixtures retain their prior rich operations and hashes, all durable compatibility suites pass, and TypeScript builds.

- [ ] **Step 8: Run complete verification and review scope**

```bash
TMPDIR=/var/tmp npm test
npm run check:web
npm run build
git diff --check
git diff --name-only
git status --short
```

Expected: the full gate is green and the change set contains only the selector files plus response-plan source/tests.

- [ ] **Step 9: Review and checkpoint 07.1b**

Stop for user review. Commit only after explicit authorization:

```bash
git add src/telegram-response-plan.ts test/telegram-response-plan.test.ts
git commit -m "NO-TICKET feat: use compact html for ordinary telegram answers"
```

After separate live approval, rebuild the exact commit, require a safe preflight, create a verified private SQLite backup, and restart once. Ask the user for one ordinary answer containing a heading, list, link, inline code, and fenced code, plus one advanced answer containing a small table or formula. Verify only operation/state counts and durable completion: ordinary uses `edit_text` or `send_text`, advanced uses `edit_rich` or `send_rich`, every expected row reaches `delivered`, no duplicate part is created, and no content or identities are printed in logs.

## Microrelease 07.1c: Mixed text, image, and file selection

### Task 3: Select representation per formatted segment while preserving order

**Files:**
- Modify: `src/telegram-response-plan.ts:258-297`
- Modify: `test/telegram-response-plan.test.ts:75-201,368-383`

- [ ] **Step 1: Write failing mixed-content expectations**

Ordinary text separated by a file must use compact text rows around the existing media row:

```ts
it("keeps compact text around a separate file in exact order", () => {
  const plan = buildTelegramResponsePlan({
    result: result([
      { kind: "text", text: "before" },
      { kind: "attachment", attachment: { kind: "file", path: "outputs/report.pdf" } },
      { kind: "text", text: "after" },
    ]),
    destination,
  });
  expect(plan.parts.map((part) => [part.partKey, part.payload.operation])).toEqual([
    ["final:0000", "send_text"],
    ["attachment:0000", "send_media"],
    ["final:0001", "send_text"],
  ]);
  expect(plan.parts.map((part) => part.ordinal)).toEqual([0, 1, 2]);
});
```

Add a mixed advanced run proving only that run remains rich:

```ts
it("uses rich only for the advanced segment in a mixed result", () => {
  const plan = buildTelegramResponsePlan({
    result: result([
      { kind: "text", text: "ordinary before" },
      { kind: "attachment", attachment: { kind: "file", path: "outputs/report.pdf" } },
      { kind: "text", text: "| A | B |\n|---|---|\n| 1 | 2 |" },
    ]),
    destination,
  });
  expect(plan.parts.map((part) => part.payload.operation))
    .toEqual(["send_text", "send_media", "send_rich"]);
});
```

- [ ] **Step 2: Run the response-plan test and verify RED**

```bash
TMPDIR=/var/tmp npx vitest run test/telegram-response-plan.test.ts
```

Expected: FAIL because ordinary formatter segments in mixed results still use `send_rich`.

- [ ] **Step 3: Pin positioned-image compatibility before changing the loop**

Retain the current positioned-image payload and hash exactly:

```ts
it("keeps positioned image planning byte-identical", () => {
  const plan = buildTelegramResponsePlan({
    result: result([
      { kind: "text", text: "before" },
      { kind: "attachment", attachment: { kind: "image", path: "outputs/chart.png" } },
      { kind: "text", text: "after" },
    ]),
    destination,
  });
  expect(plan.parts).toHaveLength(1);
  expect(plan.parts[0]).toMatchObject({
    partKey: "final:0000",
    payload: { operation: "send_rich" },
    contentHash: "edb5ddce182732363bbbb181fe60ab16630e4e18da2babf2aab0766525350529",
  });
});
```

- [ ] **Step 4: Downgrade only ordinary formatted segments**

Extract the existing legacy append block so both formatter-local legacy segments and selector-approved compact segments use the same part-key allocation:

```ts
const appendLegacy = (source: string): void => {
  const legacy = buildLegacyContentParts(textResult(source), destination);
  for (const legacyPart of legacy) {
    parts.push({ ...legacyPart, partKey: `final:${pad(finalIndex++)}` });
    assertPartBudget(parts.length);
  }
};
```

Inside `buildRichContentParts`, keep file and legacy branches first. Before creating `send_rich`, select the already formatted segment using its source plus positioned media count:

```ts
if (formattedPart.kind === "legacy") {
  appendLegacy(formattedPart.source);
  continue;
}
if (selectTelegramTextRepresentation({
  source: formattedPart.source,
  positionedImageCount: formattedPart.media.length,
}) === "compact_html") {
  appendLegacy(formattedPart.source);
  continue;
}
```

Do not alter the native rich payload, media IDs, fallback parts, or `primaryIndex` allocation that follows this branch.

- [ ] **Step 5: Add ordering and determinism regressions**

Cover these exact sequences:

- ordinary text, file, ordinary text;
- ordinary text, file, table;
- ordinary text, positioned image, ordinary text, file;
- external Markdown image followed by a file;
- two equivalent cloned inputs.

For every sequence, assert operation order, `partKey`, ordinal, media path order, and byte-identical `JSON.stringify(plan)` for the cloned input. Assert that no fallback part contains a generated `tg://photo` marker.

- [ ] **Step 6: Verify old durable rich and legacy contracts**

```bash
TMPDIR=/var/tmp npx vitest run \
  test/telegram-representation-selector.test.ts \
  test/telegram-response-plan.test.ts \
  test/telegram-delivery-payload.test.ts \
  test/telegram-delivery-replan.test.ts \
  test/telegram-delivery-outbox-rich.test.ts \
  test/telegram-delivery-outbox-rich-media.test.ts \
  test/telegram-topic-resume-rich-lineage.test.ts \
  test/telegram-job-migration.test.ts \
  test/telegram-job-migration-resume.test.ts
```

Expected: mixed new plans follow the selector, while all persisted rich, legacy, fallback, migration, resume, and media fixtures remain green without modification to their payload schema.

- [ ] **Step 7: Run complete verification and manual scope review**

```bash
TMPDIR=/var/tmp npm test
npm run check:web
npm run build
git diff --check
git diff --name-only
git status --short
```

Also inspect the final diff and verify:

- no source file other than the selector and response planner changed;
- no `.env`, database, generated `dist`, release-state, or payload schema file is staged;
- compact selection contains no logging side effect;
- the existing Rich Message fallback still owns all `:fallback:` keys;
- `formatTelegramRichResult` remains the only producer of positioned image IDs.

- [ ] **Step 8: Review and checkpoint 07.1c**

Stop for user review. Commit only after explicit authorization:

```bash
git add src/telegram-response-plan.ts test/telegram-response-plan.test.ts
git commit -m "NO-TICKET feat: preserve hybrid telegram content ordering"
```

After separate live approval, rebuild the exact revision, require the idle preflight, create the verified mode-`0600` backup, and restart exactly once. Use only a user-initiated mixed answer for acceptance. Verify stable PID, `NRestarts=0`, SQLite health, zero sending or uncertain deliveries, exact delivery-row completion, no duplicate part keys, and fresh secret-safe logs. Do not print message content, Telegram identities, job IDs, or payloads.

## Step 07.1 completion gate

Step 07.1 is complete only when:

- ordinary headings, lists, quotes, links, inline code, and fenced code plan as compact `edit_text` or `send_text` operations;
- supported tables, formulas, details, footnotes, embedded images, and positioned images plan as native rich operations;
- files do not promote neighboring ordinary text to rich;
- mixed text, image, file, and text order, part keys, ordinals, media paths, and hashes are deterministic;
- existing durable rich, legacy, fallback, migration, resume, and uncertainty fixtures remain unchanged and green;
- every microrelease passes focused tests, the full repository gate, review, idle preflight, one-restart rollout, SQLite checks, and fresh-log checks;
- user-initiated ordinary, advanced, and mixed acceptance messages complete without fallback, uncertainty, or duplicates;
- the contained historical status-anchor and two pending followers remain untouched.

Only after this gate passes, write the separate implementation plan for Step 07.2 readability and code fences.
