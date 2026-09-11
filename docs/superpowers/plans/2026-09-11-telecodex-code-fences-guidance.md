# TeleCodex Readability: Code Fences and Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make valid multiline code, commands, configuration, SQL, and logs copy-safe in Telegram and encourage Codex to emit the required closed fences.

**Architecture:** Tighten the existing fence parser and splitter without introducing a new Markdown dependency. Code chunks keep exact body bytes and receive independent triple-backtick wrappers; a later adapter-only change appends bounded presentation guidance after the user's text.

**Tech Stack:** TypeScript 5.9, Vitest, existing HTML formatter and splitter, Codex app-server adapter, SQLite durable outbox, grammY.

---

## Scope and prerequisites

This plan follows [07.2 spacing and lists](2026-09-11-telecodex-readability-spacing-lists.md) and has two independent releases:

1. **07.2c:** strict, whitespace-preserving fenced rendering and splitting.
2. **07.2d:** deterministic output-format guidance at the app-server prompt boundary.

Do not infer fences around arbitrary prose. Do not alter user text, stored results, payload schemas, hashes, response selection, retry behavior, or existing durable rows. Do not add a Markdown parser or send synthetic Telegram smoke messages.

Files:

- Modify `src/format.ts` and `test/format.test.ts` for strict fences and exact splitting.
- Modify `src/telegram-session-codex-adapter.ts` and its test for output guidance.
- Modify this plan only to record progress.

## Microrelease 07.2c: Copy-safe fenced blocks

### Task 1: Preserve code bytes across independently valid chunks

**Files:**
- Modify: `src/format.ts:122-199,260-269`
- Modify: `test/format.test.ts:19-37,103-216`

- [ ] **Step 1: Add failing language and strict-fence tests**

```ts
it("uses text for a fenced block without a known language", () => {
  expect(formatTelegramHTML("```\nkey=value\n```")).toBe(
    '<pre><code class="language-text">key=value\n</code></pre>',
  );
});

it("leaves an unclosed fence literal instead of inventing code structure", () => {
  expect(formatTelegramHTML("before\n```sql\nSELECT 1;"))
    .toBe("before\n```sql\nSELECT 1;");
});
```

Update the existing overlong-language test to expect a `text` fence and `language-text` HTML.

- [ ] **Step 2: Add a failing exact round-trip split fixture**

```ts
it("round-trips indentation trailing spaces and blank lines across fenced chunks", () => {
  const body = `${Array.from({ length: 80 }, (_, index) =>
    `  line ${index + 1}  `).join("\n")}\n\n  tail`;
  const chunks = splitTelegramMarkdown(`\`\`\`\n${body}\n\`\`\``, 120, 180);
  const restored = chunks.map(({ sourceText }) => sourceText
    .replace(/^```text\n/, "")
    .replace(/\n```$/, ""))
    .join("");

  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every(({ sourceText }) => /^```text\n[\s\S]*\n```$/.test(sourceText))).toBe(true);
  expect(chunks.every(({ html }) => html.startsWith('<pre><code class="language-text">')
    && html.endsWith("</code></pre>"))).toBe(true);
  expect(restored).toBe(body);
});
```

- [ ] **Step 3: Run RED**

```bash
TMPDIR=/var/tmp npx vitest run test/format.test.ts
```

Expected: bare fences lack `language-text`, and the splitter trims or moves code whitespace.

- [ ] **Step 4: Use line-bounded fences and a safe language default**

```ts
function fenceLanguage(rawLanguage: string): string {
  return sanitizeLanguage(rawLanguage) || "text";
}

function extractCodeBlocks(text: string, codeBlocks: string[]): string {
  return text.replace(/^```([^\n`]*)\n([\s\S]*?)\n```$/gm,
    (_match, rawLanguage: string, rawCode: string) => {
      const language = fenceLanguage(rawLanguage);
      const code = `<pre><code class="language-${language}">${rawCode}\n</code></pre>`;
      const index = codeBlocks.push(code) - 1;
      return `${CODE_BLOCK_PREFIX}${index}${CODE_BLOCK_SUFFIX}`;
    });
}
```

Keep escaping before extraction. A closing delimiter must be exactly three backticks on its own line; inline prose never closes a block.

Use the same boundary in `splitMarkdownBlocks`: outside a fence, only `^```([^`]*)$` opens it; inside a fence, only `^```[ \t]*$` closes it. In `splitOversizedBlock`, replace the current optional closing newline expression with:

```ts
const fenced = block.match(/^```([^\n`]*)\n([\s\S]*?)\n```[ \t]*$/);
```

- [ ] **Step 5: Preserve whitespace in the bounded splitter**

```ts
function fencedSource(language: string, value: string): string {
  const separator = value.endsWith("\n") ? "" : "\n";
  return `\`\`\`${language}\n${value}${separator}\`\`\``;
}

function splitFencedCode(
  rawLanguage: string,
  code: string,
  targetLength: number,
  maxHtmlLength: number,
  maximumPieces: number,
): string[] {
  const language = fenceLanguage(rawLanguage);
  const wrap = (value: string): string => fencedSource(language, value);
  const sourceOverhead = codePointLength(wrap(""));
  const htmlOverhead = codePointLength(formatTelegramHTML(wrap("")));
  if (sourceOverhead >= targetLength || htmlOverhead >= maxHtmlLength) {
    throw new Error("Telegram markdown limits cannot fit fenced block");
  }
  return splitBoundedSource(
    code, targetLength - sourceOverhead, maxHtmlLength,
    (value) => formatTelegramHTML(wrap(value)), false, maximumPieces,
  ).map(wrap);
}
```

Inside `splitBoundedSource`, replace unconditional trimming and the code-newline skip:

```ts
const sourceChunk = window.slice(0, cut);
const chunk = trimAllLeadingWhitespace ? sourceChunk.trimEnd() : sourceChunk;
if (chunk.length > 0) {
  if (result.length >= maximumPieces) throw new Error(CHUNK_BUDGET_ERROR);
  result.push(chunk);
}
offset += cut;
if (trimAllLeadingWhitespace) {
  while (offset < source.length && source[offset]!.trim() === "") offset += 1;
}
```

Do not skip a newline after a code chunk. A selected newline belongs to the code body.

- [ ] **Step 6: Add command, config, SQL, and log fixtures**

```ts
it.each([
  ["bash", "npm test\nnpm run build"],
  ["yaml", "service:\n  replicas: 2\n  enabled: true"],
  ["sql", "SELECT id, status\nFROM jobs\nWHERE status = 'pending';"],
  ["text", "2026-09-11 INFO started\n2026-09-11 WARN retry"],
])("preserves %s fenced content", (language, body) => {
  const html = formatTelegramHTML(`\`\`\`${language}\n${body}\n\`\`\``);
  expect(html).toContain(`<pre><code class="language-${language}">`);
  expect(html).toContain(escapeHTML(body));
  expect(html.endsWith("</code></pre>")).toBe(true);
});
```

- [ ] **Step 7: Run focused durability and budget compatibility**

```bash
TMPDIR=/var/tmp npx vitest run \
  test/format.test.ts \
  test/telegram-response-plan.test.ts \
  test/telegram-response-plan-budget.test.ts \
  test/telegram-delivery-payload.test.ts \
  test/telegram-delivery-replan.test.ts \
  test/telegram-delivery-outbox-rich.test.ts \
  test/telegram-topic-resume-rich-lineage.test.ts
npm run build:server
git diff --check
```

Expected: every generated fence is closed, body bytes round-trip, Unicode limits hold, fallback stays deterministic, and old durable rows remain compatible.

- [ ] **Step 8: Full gate, review, and commit 07.2c**

```bash
TMPDIR=/var/tmp npm test -- --maxWorkers=1 --minWorkers=1
npm run check:web
npm run build
git diff --check
git diff --name-only
git add src/format.ts test/format.test.ts \
  docs/superpowers/plans/2026-09-11-telecodex-code-fences-guidance.md
git diff --cached --check
git commit -m "NO-TICKET fix: preserve telegram fenced code"
```

Review trimming, regex bounds, generated closures, rich hashes, and payload scope before committing.

- [ ] **Step 9: Deploy 07.2c**

Build the exact commit, require idle safe preflight, make and verify a mode-`0600` online SQLite backup, and restart once. Verify stable PID, `NRestarts=0`, health/readiness, Guardian, SQLite, `getMe`, contained history, and fresh sanitized logs. Use only a user-initiated answer with inline code plus fenced commands or logs for visual and aggregate-ledger acceptance.

## Microrelease 07.2d: Deterministic output guidance

### Task 2: Encourage valid source fences without altering user text

**Files:**
- Modify: `src/telegram-session-codex-adapter.ts:158-175`
- Modify: `test/telegram-session-codex-adapter.test.ts:95-129`
- Modify: this plan for progress

- [ ] **Step 1: Add a failing prompt-order test**

```ts
it("keeps user text first and appends bounded Telegram code-format guidance", async () => {
  const harness = createHarness(THREAD);
  const adapter = createTelegramSessionCodexAdapter(harness.options);
  await adapter.startTurn({
    jobId: "job-1", threadId: THREAD,
    prompt: { text: "show commands", attachments: [] },
    callbacks: coordinatorCallbacks([]),
  });

  const input = harness.session.prompt.mock.calls[0]![0];
  if (typeof input === "string") throw new Error("expected structured prompt");
  expect(input.text).toBe("show commands");
  expect(input.stagedFileInstructions).toContain(
    "For Telegram readability, wrap every multiline code, command, configuration, SQL, or log excerpt",
  );
  expect(input.stagedFileInstructions).toContain(
    "Use a language tag when known, otherwise use text. Preserve indentation and internal blank lines.",
  );
  expect(input.stagedFileInstructions).toMatch(/Files elsewhere are not delivered\.$/);
});
```

- [ ] **Step 2: Run RED**

```bash
TMPDIR=/var/tmp npx vitest run test/telegram-session-codex-adapter.test.ts
```

Expected: the structured prompt lacks the new guidance.

- [ ] **Step 3: Add one deterministic instruction**

```ts
const TELEGRAM_PRESENTATION_INSTRUCTION = [
  "For Telegram readability, wrap every multiline code, command, configuration, SQL, or log excerpt",
  "in a closed triple-backtick fence on separate lines, with a blank line before and after.",
  "Use a language tag when known, otherwise use text. Preserve indentation and internal blank lines.",
].join(" ");
```

Append it after staged attachment paths and before the durable outbox instruction:

```ts
const instructions = [
  ...(files.length ? [stagedFileInstructions(files)] : []),
  TELEGRAM_PRESENTATION_INSTRUCTION,
  `If you create a file for the user, save or copy it directly into ${JSON.stringify(outbox.absolutePath)}. Files elsewhere are not delivered.`,
].join("\n\n");
```

Keep `prompt.text` as the separate leading field. Do not add Telegram identifiers or change recovery.

- [ ] **Step 4: Add attachment-order and determinism checks**

In the existing materialized-attachment test:

```ts
const promptInput = harness.session.prompt.mock.calls[0]![0];
if (typeof promptInput === "string") throw new Error("expected structured prompt");
expect(promptInput.stagedFileInstructions?.indexOf("report.txt")).toBeLessThan(
  promptInput.stagedFileInstructions?.indexOf("For Telegram readability") ?? -1,
);
expect(promptInput.stagedFileInstructions).not.toContain("-1001");
```

Add an exact determinism test:

```ts
it("builds byte-identical presentation instructions for equivalent prompts", async () => {
  const first = createHarness(THREAD);
  const second = createHarness(THREAD);
  const turn = {
    jobId: "job-1", threadId: THREAD,
    prompt: { text: "inspect", attachments: [] },
    callbacks: coordinatorCallbacks([]),
  };
  await createTelegramSessionCodexAdapter(first.options).startTurn(turn);
  await createTelegramSessionCodexAdapter(second.options).startTurn(turn);

  const firstInput = first.session.prompt.mock.calls[0]![0];
  const secondInput = second.session.prompt.mock.calls[0]![0];
  if (typeof firstInput === "string" || typeof secondInput === "string") {
    throw new Error("expected structured prompts");
  }
  expect(firstInput.stagedFileInstructions).toBe(secondInput.stagedFileInstructions);
});
```

- [ ] **Step 5: Focused compatibility**

```bash
TMPDIR=/var/tmp npx vitest run \
  test/telegram-session-codex-adapter.test.ts \
  test/codex-session-app-server.test.ts \
  test/telegram-reliability-runtime.test.ts \
  test/telegram-response-plan.test.ts \
  test/format.test.ts
npm run build:server
git diff --check
```

Expected: user text stays first, staged files and images are unchanged, instructions are deterministic, and completed text reaches the same planner.

- [ ] **Step 6: Full gate, review, and commit 07.2d**

```bash
TMPDIR=/var/tmp npm test -- --maxWorkers=1 --minWorkers=1
npm run check:web
npm run build
git diff --check
git diff --name-only
git add src/telegram-session-codex-adapter.ts test/telegram-session-codex-adapter.test.ts \
  docs/superpowers/plans/2026-09-11-telecodex-code-fences-guidance.md
git diff --cached --check
git commit -m "NO-TICKET fix: guide telegram code formatting"
```

Review prompt-title order, duplicate guidance, identifier leakage, recovery divergence, and scope before committing.

- [ ] **Step 7: Deploy 07.2d and close 07.2**

Repeat exact-build, idle-preflight, verified backup, one restart, runtime, SQLite, `getMe`, and fresh-log checks. Use an organic request that naturally calls for commands, config, SQL, or logs. Require a closed fence with the expected language or `text`, copy-paste indentation, no fallback, no uncertainty, and no duplicate part keys.

07.2 is complete only when all four commits are green and live, organic acceptance evidence exists, the service is stable, and contained history is unchanged. Only then write the separate 07.3 Dashboard-topic cleanup plan.

## Rollback boundary

If a release fails before any new Telegram delivery, restore the preceding code commit, rebuild it, and restart once after the same preflight. Never overwrite the live database with a backup. If Telegram may have accepted a send, preserve the durable row and inspect it before any retry or rollback. Never replay warning recovery or alter historical quarantine.
