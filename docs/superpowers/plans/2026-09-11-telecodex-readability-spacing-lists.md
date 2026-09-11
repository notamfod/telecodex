# TeleCodex Readability: Spacing and Lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ordinary Telegram prose and lists compact, predictable, and easy to scan without changing stored Codex results or durable delivery contracts.

**Architecture:** Add one fence-aware normalization pass to `src/format.ts`, then render bounded list indentation in the existing HTML formatter. The normalizer is pure and idempotent, never touches fence bodies, and is used before both rendering and chunk measurement.

**Tech Stack:** TypeScript 5.9, Vitest, existing Telegram HTML formatter and bounded Markdown splitter, SQLite durable outbox, grammY.

---

## Scope and gates

This plan contains two independently releasable checkpoints:

1. **07.2a:** section spacing, paragraph boundaries, and adjacent list rows.
2. **07.2b:** visual indentation capped at two levels.

Do not change `TelegramTurnResult`, response-plan selection, payload schemas, hashes, outbox, recovery, or historical rows. Do not infer headings, rewrite prose, renumber ordered lists, or normalize inside code fences. Code-fence byte preservation and prompt guidance belong to [the second 07.2 plan](2026-09-11-telecodex-code-fences-guidance.md).

The three 07.1 commits are live, but no post-rollout Telegram delivery appeared during planning. Before the first 07.2 restart, require organic user-initiated ordinary, advanced, and mixed evidence using only aggregate operation/state/kind counts. If organic traffic is absent, local commits may continue, but deployment stops before restart. Never send a synthetic smoke message.

Files:

- Modify `src/format.ts` for normalization and bounded list prefixes.
- Modify `test/format.test.ts` for Russian prose, long lists, nesting, Unicode, idempotence, and fence isolation.
- Modify this plan only to record checkpoint progress.
- Reuse `src/telegram-response-plan.ts`, `src/telegram-delivery-payload.ts`, `src/telegram-delivery-outbox.ts`, and `src/telegram-delivery-replan.ts` unchanged.

## Microrelease 07.2a: Section and list spacing

### Task 1: Add fence-aware presentation normalization

**Files:**
- Modify: `src/format.ts:1-82`
- Modify: `test/format.test.ts:1-216`

- [x] **Step 1: Add failing readability fixtures**

Import `normalizeTelegramPresentation`, then add:

```ts
it("normalizes Russian section spacing without expanding lists", () => {
  const input = [
    "# Что сделано", "Текст раздела.", "", "", "## Проверка",
    "- первый пункт", "", "- второй пункт",
  ].join("\n");

  expect(formatTelegramHTML(input)).toBe([
    "<b>Что сделано</b>", "", "Текст раздела.", "", "<b>Проверка</b>",
    "", "• первый пункт", "• второй пункт",
  ].join("\n"));
});

it("keeps authored paragraphs and collapses only excess outside-fence blanks", () => {
  expect(formatTelegramHTML("Первый.\n\n\n\nВторой.")).toBe("Первый.\n\nВторой.");
});

it("uses the same normalized source for sizing and rendering", () => {
  const chunks = splitTelegramMarkdown("# Раздел\nТекст\n\n\n- один\n\n- два", 4_096, 4_096);
  expect(chunks).toEqual([{
    sourceText: "# Раздел\n\nТекст\n\n- один\n- два",
    html: "<b>Раздел</b>\n\nТекст\n\n• один\n• два",
    plain: "# Раздел\n\nТекст\n\n- один\n- два",
  }]);
});
```

- [x] **Step 2: Run RED**

```bash
TMPDIR=/var/tmp npx vitest run test/format.test.ts
```

Expected: the new assertions fail because excess blanks, heading adjacency, and blank rows between list items are currently preserved.

- [x] **Step 3: Implement the pure normalizer**

Add above `formatTelegramHTML`:

```ts
type TelegramPresentationLineKind = "heading" | "list" | "fence" | "text";

export function normalizeTelegramPresentation(markdown: string): string {
  if (!markdown || markdown.trim() === "") return markdown;
  const output: string[] = [];
  let inFence = false;
  let pendingBlank = false;
  let previousKind: TelegramPresentationLineKind | undefined;
  const appendBlank = (): void => {
    if (output.length > 0 && output.at(-1) !== "") output.push("");
  };

  for (const sourceLine of markdown.split("\n")) {
    const fence = /^```([^`]*)$/.exec(sourceLine);
    if (inFence) {
      output.push(sourceLine);
      if (/^```[ \t]*$/.test(sourceLine)) { inFence = false; previousKind = "fence"; }
      continue;
    }
    if (fence) {
      appendBlank();
      output.push(sourceLine);
      inFence = true;
      pendingBlank = false;
      previousKind = "fence";
      continue;
    }
    if (sourceLine.trim() === "") { pendingBlank = true; continue; }

    const kind = presentationLineKind(sourceLine);
    const adjacentList = kind === "list" && previousKind === "list";
    if (kind === "heading" || previousKind === "heading" || previousKind === "fence"
      || (pendingBlank && !adjacentList)) appendBlank();
    output.push(sourceLine.trimEnd());
    pendingBlank = false;
    previousKind = kind;
  }
  return output.join("\n");
}

function presentationLineKind(line: string): TelegramPresentationLineKind {
  if (/^#{1,6}[ \t]+\S/.test(line)) return "heading";
  if (/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+\S/.test(line)) return "list";
  return "text";
}
```

In `formatTelegramHTML`, escape `normalizeTelegramPresentation(markdown)` instead of `markdown`. In `splitTelegramMarkdown`, normalize once and pass that value to `splitMarkdownBlocks`. Keep the stored turn result unchanged.

- [x] **Step 4: Add fence-isolation and idempotence tests**

```ts
it("does not normalize indentation or blank lines inside a fence", () => {
  const source = [
    "Перед кодом", "```text", "  first  ", "", "    second", "```", "После кода",
  ].join("\n");
  const normalized = normalizeTelegramPresentation(source);
  expect(normalized).toBe([
    "Перед кодом", "", "```text", "  first  ", "", "    second", "```", "", "После кода",
  ].join("\n"));
  expect(normalizeTelegramPresentation(normalized)).toBe(normalized);
});
```

- [x] **Step 5: Run focused compatibility**

```bash
TMPDIR=/var/tmp npx vitest run \
  test/format.test.ts \
  test/telegram-response-plan.test.ts \
  test/telegram-response-plan-budget.test.ts \
  test/telegram-delivery-payload.test.ts
npm run build:server
git diff --check
```

Expected: normalized source and HTML agree, fences retain their body bytes, response operation types remain unchanged, and all limits remain bounded.

- [x] **Step 6: Run the full gate and review**

```bash
TMPDIR=/var/tmp npm test -- --maxWorkers=1 --minWorkers=1
npm run check:web
npm run build
git diff --check
git diff --name-only
git status --short
```

Review for fence-local mutation, quadratic work, payload changes, or files outside `src/format.ts`, `test/format.test.ts`, and this plan. Correct findings and repeat affected tests.

- [x] **Step 7: Commit 07.2a**

```bash
git add src/format.ts test/format.test.ts \
  docs/superpowers/plans/2026-09-11-telecodex-readability-spacing-lists.md
git diff --cached --check
git commit -m "NO-TICKET fix: normalize telegram answer spacing"
```

- [x] **Step 8: Deploy 07.2a**

Require the inherited organic-smoke gate, build the exact commit, and run `npm run release:preflight`. Require `safeToRestart=true`, `queued=0`, `running=0`, `sending=0`, and `uncertain=0`. Create an online `better-sqlite3` backup under `.telecodex/release-state/readability-code-fences/`, mode `0600`; verify SHA-256 length 64, `quick_check=ok`, and FK=0.

Restart `telecodex.service` exactly once. Verify stable PID, `NRestarts=0`, health/readiness 200, Guardian ready, authenticated `getMe`, unchanged contained history, and zero fresh 429-loop, fatal, uncaught/unhandled, and background-error counts. Use only a later user-initiated prose/list response for visual acceptance.

## Microrelease 07.2b: Bounded nested lists

### Task 2: Cap visual indentation without flattening meaning

**Files:**
- Modify: `src/format.ts:84-90`
- Modify: `test/format.test.ts:96-216`
- Modify: this plan for progress

- [ ] **Step 1: Add failing nested-list fixtures**

```ts
it("caps visual list indentation at two levels", () => {
  const input = [
    "- root", "  - child", "    - deep", "      - deeper",
    "        1. ordered", "          - [x] checked",
  ].join("\n");
  expect(formatTelegramHTML(input)).toBe([
    "• root", "  • child", "    • deep", "    • • deeper",
    "    • • 1. ordered", "    • • • ☑ checked",
  ].join("\n"));
});

it("treats tabs as one bounded list level", () => {
  expect(formatTelegramHTML("- root\n\t- child\n\t\t\t- deep"))
    .toBe("• root\n  • child\n    • • deep");
});
```

- [ ] **Step 2: Run RED**

```bash
TMPDIR=/var/tmp npx vitest run test/format.test.ts
```

Expected: deep items retain unbounded spaces and tabs.

- [ ] **Step 3: Implement bounded list prefixes**

Replace the three list replacements in `formatBlockStructure` and add the ordered-list branch:

```ts
function formatBlockStructure(text: string): string {
  return text
    .replace(/^#{1,6}[ \t]+(.+)$/gm, "<b>$1</b>")
    .replace(/^([ \t]*)[-+*][ \t]+\[x\][ \t]+(.+)$/gim,
      (_match, indentation: string, content: string) => listLine(indentation, "☑", content))
    .replace(/^([ \t]*)[-+*][ \t]+\[[ ]\][ \t]+(.+)$/gm,
      (_match, indentation: string, content: string) => listLine(indentation, "☐", content))
    .replace(/^([ \t]*)[-+*][ \t]+(.+)$/gm,
      (_match, indentation: string, content: string) => listLine(indentation, "•", content))
    .replace(/^([ \t]*)(\d+[.)])[ \t]+(.+)$/gm,
      (_match, indentation: string, marker: string, content: string) =>
        listLine(indentation, marker, content));
}

function listLine(indentation: string, marker: string, content: string): string {
  const columns = [...indentation]
    .reduce((total, character) => total + (character === "\t" ? 2 : 1), 0);
  const level = Math.floor(columns / 2);
  const visibleLevel = Math.min(level, 2);
  const overflow = "• ".repeat(Math.max(0, level - visibleLevel));
  return `${"  ".repeat(visibleLevel)}${overflow}${marker} ${content}`;
}
```

Keep task-list replacements before the unordered replacement. Never renumber ordered items.

- [ ] **Step 4: Add a bounded long-list regression**

```ts
it("keeps a long Russian list compact and within Telegram limits", () => {
  const source = Array.from({ length: 300 }, (_, index) =>
    `${"  ".repeat(index % 6)}- пункт ${index + 1} 😀`).join("\n");
  const chunks = splitTelegramMarkdown(source, 3_000, 4_096);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every(({ html }) => Array.from(html).length <= 4_096)).toBe(true);
  expect(chunks.every(({ html }) => !/^ {6}/m.test(html))).toBe(true);
  expect(chunks.map(({ html }) => html).join("\n")).toContain("пункт 300 😀");
});
```

- [ ] **Step 5: Verify, review, and commit 07.2b**

```bash
TMPDIR=/var/tmp npx vitest run test/format.test.ts test/telegram-response-plan.test.ts
TMPDIR=/var/tmp npm test -- --maxWorkers=1 --minWorkers=1
npm run check:web
npm run build
git diff --check
git add src/format.ts test/format.test.ts \
  docs/superpowers/plans/2026-09-11-telecodex-readability-spacing-lists.md
git diff --cached --check
git commit -m "NO-TICKET fix: bound telegram list indentation"
```

Review regex ordering, list-content preservation, Unicode splitting, and scope before committing.

- [ ] **Step 6: Deploy 07.2b**

Repeat the exact-build, idle-preflight, verified online backup, one-restart, health/readiness, PID, SQLite, `getMe`, and fresh-log checks from 07.2a. Use a user-initiated nested-list answer for visual acceptance and inspect only aggregate delivery evidence.

## Rollback boundary

If a release fails before any new Telegram delivery, restore the preceding code commit, rebuild it, and restart once after the same preflight. Never overwrite the live database with a backup. If Telegram may have accepted a send, preserve the durable row and inspect it before any retry or rollback. Never replay warning recovery or alter historical quarantine.
