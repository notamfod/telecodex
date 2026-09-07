# Guardian Session Title Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the Codex `thread.name` in Guardian alerts and render it as `Title` in initial and terminal Telegram messages.

**Architecture:** Normalize a bounded title at the app-server boundary, store it as nullable alert metadata in SQLite schema version 2, and render only the persisted value so restart reconciliation produces the same message. The title remains outside the stall fingerprint and never affects the exact repair target.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, grammY Telegram API, systemd.

**Delivery constraint:** Do not commit or push. Preserve unrelated dirty worktree changes. Restart only `codex-session-guardian.service` after all tests and builds pass.

---

### Task 1: Normalize bounded app-server titles

**Files:**
- Create: `test/session-guardian-title-app-server.test.ts`
- Modify: `src/session-guardian-app-server.ts:240-300`
- Test: `test/session-guardian-title-app-server.test.ts`

- [ ] **Step 1: Write failing boundary tests**

Create a focused gateway test by copying the existing app-server test's `rawThread()` fixture and `gatewayFor()` fake transport helper into the new file. Keep their current valid defaults, then override only `thread.name`. Assert that `"  Checkout recovery  "` becomes `"Checkout recovery"`, `null` and whitespace-only names become `null`, and both a numeric name and a 513-code-point name reject with `thread/read.thread.name` in the error.

```ts
it("normalizes a bounded session title", async () => {
  const gateway = gatewayFor(rawThread({ name: "  Checkout recovery  " }));
  await expect(gateway.readThread(THREAD_ID)).resolves.toMatchObject({
    name: "Checkout recovery",
  });
});

it.each([123, "x".repeat(513)])("rejects invalid session title %j", async (name) => {
  const gateway = gatewayFor(rawThread({ name }));
  await expect(gateway.readThread(THREAD_ID)).rejects.toThrow(
    "thread/read.thread.name",
  );
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run test/session-guardian-title-app-server.test.ts
```

Expected: whitespace is not trimmed and malformed or oversized names are accepted.

- [ ] **Step 3: Add one normalization helper**

In `src/session-guardian-app-server.ts`, replace `readString(thread.name) ?? null` with a helper that treats absent, `null`, or trimmed-empty strings as missing and rejects other invalid values.

```ts
const MAX_THREAD_NAME_CODE_POINTS = 512;

function readThreadName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw invalidThreadField("name", "must be a string or null");
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if ([...normalized].length > MAX_THREAD_NAME_CODE_POINTS) {
    throw invalidThreadField("name", "must be at most 512 code points");
  }
  return normalized;
}
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
npx vitest run test/session-guardian-title-app-server.test.ts test/session-guardian-app-server.test.ts
```

Expected: both files pass.

### Task 2: Migrate and persist alert titles

**Files:**
- Create: `test/session-guardian-title-store.test.ts`
- Modify: `src/session-guardian-store-schema.ts`
- Modify: `src/session-guardian-store-codec.ts`
- Modify: `src/session-guardian-store.ts:115-150`
- Modify: `src/session-guardian-detector.ts:120-135`
- Test: `test/session-guardian-title-store.test.ts`
- Test: `test/session-guardian-detector.test.ts`

- [ ] **Step 1: Write failing migration and persistence tests**

The test creates a real version 1 database containing one delivered restored alert and one finished repair attempt, opens it with `SessionGuardianStore`, and asserts. Define an `openStore()` helper that constructs `SessionGuardianStore` for the test database path; after `store.close()`, call `openStore()` again for the reopen assertion.

```ts
expect(db.pragma("user_version", { simple: true })).toBe(2);
expect(store.getAlert(ALERT_ID)).toMatchObject({
  id: ALERT_ID,
  state: "restored",
});
expect(store.getAlert(ALERT_ID)).not.toHaveProperty("threadName");
```

Then create a new alert with a title, close and reopen the store, and assert exact persistence:

```ts
const alert = store.createAlert(fingerprint(), route, 61_000, "Checkout recovery");
expect(alert.threadName).toBe("Checkout recovery");
store.close();
const reopened = openStore();
expect(reopened.getAlert(alert.id)?.threadName).toBe("Checkout recovery");
reopened.close();
```

Also assert that empty and over-512-code-point store inputs are rejected. Add a detector assertion proving the title passed from `snapshot.name` is stored while `fingerprintOf()` remains unchanged when only the name changes.

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run test/session-guardian-title-store.test.ts test/session-guardian-detector.test.ts
```

Expected: schema remains version 1 and alert objects have no `threadName`.

- [ ] **Step 3: Implement schema version 2 migration**

Set `SCHEMA_VERSION = 2`, place this column after `created_at` and before table-level checks in the version 2 alert definition, and migrate before validation:

```sql
thread_name TEXT CHECK(
  thread_name IS NULL OR (length(thread_name) > 0 AND length(thread_name) <= 512)
)
```

```ts
if (version === 1) {
  const migrate = database.transaction(() => {
    database.exec(`ALTER TABLE alerts ADD COLUMN thread_name TEXT CHECK(
      thread_name IS NULL OR (length(thread_name) > 0 AND length(thread_name) <= 512)
    )`);
    database.pragma("user_version = 2");
  });
  migrate.immediate();
}
```

Keep version 0 initialization direct-to-v2 and validate the resulting SQL and index exactly.

- [ ] **Step 4: Extend the alert codec and store API**

Add optional persisted metadata:

```ts
export interface GuardianAlert {
  readonly id: string;
  readonly fingerprint: Readonly<GuardianFingerprint>;
  readonly route: Readonly<GuardianRoute>;
  readonly state: GuardianAlertState;
  readonly deliveryState: GuardianDeliveryState;
  readonly statusDeliveryState: GuardianStatusDeliveryState;
  readonly messageId?: number;
  readonly detail?: string;
  readonly createdAt: number;
  readonly threadName?: string;
}
```

Decode `thread_name`, validate a supplied title at the store boundary, add it to the `INSERT`, and preserve the first alert on duplicate `threadId + turnId` creation.

```ts
createAlertIfAbsent(
  fingerprint: GuardianFingerprint,
  route: GuardianRoute,
  createdAt: number,
  threadName?: string | null,
): GuardianAlertCreation
```

Pass `snapshot.name` from `SessionGuardianDetector.observe()`. Do not add the title to `GuardianFingerprint`.

- [ ] **Step 5: Run GREEN and regression tests**

Run:

```bash
npx vitest run \
  test/session-guardian-title-store.test.ts \
  test/session-guardian-store*.test.ts \
  test/session-guardian-detector.test.ts \
  test/session-guardian-recovery*.test.ts
```

Expected: all selected files pass and the legacy fixture is preserved.

### Task 3: Render Title in every Telegram state

**Files:**
- Create: `test/session-guardian-title-telegram.test.ts`
- Modify: `src/session-guardian-telegram.ts:137-165`
- Test: `test/session-guardian-title-telegram.test.ts`
- Test: `test/session-guardian-telegram.test.ts`
- Test: `test/session-guardian-telegram-safety.test.ts`

- [ ] **Step 1: Write failing renderer tests**

Use the public notifier with a capturing fake API. Assert both initial send and terminal edit contain a `Title` line before `Thread`, do not contain `Name:`, and use the persisted alert title rather than a changed live snapshot name.

```ts
expect(initialText).toContain("Title: Persisted &lt;title&gt;");
expect(terminalText).toContain("Title: Persisted &lt;title&gt;");
expect(terminalText.indexOf("Title:")).toBeLessThan(terminalText.indexOf("Thread:"));
```

Add cases for `threadName: undefined` rendering `Title: Untitled` and a title longer than 160 code points being Unicode-safely truncated without leaking HTML.

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run test/session-guardian-title-telegram.test.ts
```

Expected: terminal text has no title and initial text still uses `Name` from the snapshot.

- [ ] **Step 3: Render the persisted title consistently**

Change both renderer paths to use the alert metadata:

```ts
const title = alert.threadName ?? "Untitled";
```

Initial lines use `field("Title", title, 160)` instead of `Name`. Terminal lines place the same field between the heading and full UUID. Continue using the existing `field()` helper for HTML escaping, code-point truncation, and total Telegram message bounds.

- [ ] **Step 4: Run GREEN and Telegram regressions**

Run:

```bash
npx vitest run \
  test/session-guardian-title-telegram.test.ts \
  test/session-guardian-telegram.test.ts \
  test/session-guardian-telegram-safety.test.ts \
  test/session-guardian-telegram-api.test.ts
```

Expected: all selected files pass.

### Task 4: Verify and deploy the schema migration

**Files:**
- Runtime only: `.telecodex/session-guardian.sqlite`
- Runtime only: `.telecodex/session-guardian-title-v1-backup.sqlite`
- Runtime only: `dist/`

- [ ] **Step 1: Run focused and full verification**

Run:

```bash
npx vitest run test/session-guardian-*.test.ts test/guardian-bot-adapter.test.ts
npm test
npm run check:web
npm run build
git diff --check
```

Expected: zero test failures, zero Svelte errors, and successful server/web builds.

- [ ] **Step 2: Capture pre-deployment state and a consistent backup**

Verify Guardian is repair-enabled, then use the better-sqlite3 backup API so the WAL-backed database is copied consistently:

```bash
node dist/session-guardian-cli.js status
node --input-type=module -e '
  import Database from "better-sqlite3";
  const db = new Database(".telecodex/session-guardian.sqlite", { readonly: true });
  await db.backup(".telecodex/session-guardian-title-v1-backup.sqlite");
  db.close();
'
chmod 600 .telecodex/session-guardian-title-v1-backup.sqlite
```

Expected: status reports `repairEnabled=true`; backup exists with mode `0600` and `user_version=1`.

- [ ] **Step 3: Restart only Guardian**

Record TeleCodex and shared app-server timestamps, then run:

```bash
systemctl restart codex-session-guardian.service
```

Expected: Guardian becomes active; TeleCodex and `codex-remote-control.service` keep their prior timestamps.

- [ ] **Step 4: Verify migrated live state and rendering**

Read the live database and assert `user_version=2`, historical restored alert `3DP_hSwqSjjPz6rT3d_xqw` and its repair attempt remain present, and no open alerts were introduced. Run a capturing notifier smoke with `threadName: "Guardian title smoke"` and assert the terminal text includes `Title: Guardian title smoke` before the UUID.

Finally run:

```bash
node dist/session-guardian-cli.js status
systemctl show codex-session-guardian.service -p MainPID -p NRestarts -p Result
journalctl -u codex-session-guardian.service -n 40 --no-pager
```

Expected: `observationOnly=false`, `repairEnabled=true`, app-server connected, `NRestarts=0`, and no secret or conversation text in logs.

- [ ] **Step 5: Report without committing**

Report the migration version, preserved alert/repair counts, focused/full test counts, build results, service PID/restarts, and the exact rendered `Title` line. Do not commit or push.
