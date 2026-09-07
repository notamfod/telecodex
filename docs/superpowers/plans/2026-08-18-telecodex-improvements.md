# TeleCodex Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve TeleCodex ticket inboxes, integrations, reliability, observability, and maintainability without disrupting the running Telegram bridge.

**Architecture:** Deliver the work in independently deployable phases. Keep state migrations additive, put new logic in focused tested modules, and leave the large `src/bot.ts` extraction until behavior is covered and stable. Scheduled digest and backup jobs use systemd; the Sentry bridge runs inside TeleCodex so it shares the live `InboxStore` safely.

**Tech Stack:** TypeScript 5.9, Node.js, grammY, Vitest, Telegram Bot API, Jira REST API, Sentry REST API, systemd.

---

## Scope And Constraints

- Host: `79.132.137.200`
- Repository: `/root/Documents/Codex/2026-08-07-hermes/telecodex`
- Service: `telecodex.service`
- Current branch: `mircli-bridge`
- Work branch: `telecodex-improvements`
- Existing uncommitted customizations in `.env.example`, `recipes/recipes.example.json`, `src/bot-ui.ts`, and `src/bot.ts` must be preserved.
- Before feature work, snapshot the current dirty state in a clearly named baseline commit on the new branch. This avoids mixing pre-existing customizations into later feature commits.
- Never commit `.env`, realm tokens, Jira credentials, or Sentry credentials.
- Run tests and TypeScript build before every deployment checkpoint.
- Commit convention: `NO-TICKET <type>: <imperative subject>`.
- Edit using a local mirror if convenient, then transfer only intended files to the host and run verification on the host.

## Phase 0: Baseline

### Task 1: Preserve The Current Deployment State

**Files:**
- Existing working tree only

- [ ] Record status, diff, and recent history:

```bash
git status --short
git diff --stat
git log --oneline -10
```

- [ ] Create the implementation branch without discarding the dirty tree:

```bash
git switch -c telecodex-improvements
```

- [ ] Run the current baseline verification:

```bash
npm test
npm run build
systemctl is-active telecodex
```

- [ ] Commit the existing customization snapshot separately:

```bash
git add .env.example recipes/recipes.example.json src/bot-ui.ts src/bot.ts
git commit -m "NO-TICKET chore: snapshot local telecodex customizations"
```

- [ ] Back up current runtime state before changing schemas:

```bash
mkdir -p /root/backups/telecodex
tar -czf /root/backups/telecodex/state-before-improvements.tar.gz \
  -C /root/Documents/Codex/2026-08-07-hermes/telecodex .telecodex
```

## Phase 1: Reliability And Ticket Lifecycle

### Task 2: Drop Model Pickers Bound To Deleted Topics

**Files:**
- Modify: `src/bot.ts` in `bot.recoverPendingJobs`
- Modify: `src/projects.ts`
- Test: `test/projects.test.ts`

- [ ] Add an async helper in `src/projects.ts` that partitions jobs by topic liveness. General-chat jobs are always retained; failed probes count as dead.
- [ ] Test general-chat jobs, live topics, deleted topics, and probe failures.
- [ ] In `recoverPendingJobs`, run the helper before `sendPromptModelPicker`.
- [ ] Mark skipped jobs as `failed` through `jobStore.update` and log their context key once.
- [ ] Verify the startup log no longer contains `Failed to restore Telegram model picker: ... message thread not found`.

```bash
npx vitest run test/projects.test.ts
npm run build
sudo systemctl restart telecodex
journalctl -u telecodex -n 40 --no-pager
```

- [ ] Commit:

```bash
git add src/projects.ts src/bot.ts test/projects.test.ts
git commit -m "NO-TICKET fix: drop model pickers for deleted topics"
```

### Task 3: Add Persistent Ticket Resolution

**Files:**
- Modify: `src/inbox.ts`
- Modify: `src/bot.ts`
- Modify: `test/inbox.test.ts`
- Modify: `test/bot-jira.test.ts` or add `test/bot-commands.test.ts`

- [ ] Extend `Ticket` additively with `resolvedAt?: number`.
- [ ] Add `InboxStore.markResolved(id, now)`, `InboxStore.reopen(id)`, and `InboxStore.listUnresolved(inboxContextKey?)`.
- [ ] Test persistence across store restart, filtering, stable ordering, and idempotent resolution.
- [ ] Add `✅ Решён` to inbox-created ticket cards with callback `ticket_done:<id>`.
- [ ] Keep the resolve button after `ticket_start` removes the launch button.
- [ ] Implement `ticket_done` to mark the ticket resolved, remove callback buttons, notify the source inbox, and close the work topic.
- [ ] Add `/tickets` to the Telegram command menu and render unresolved tickets grouped by inbox workspace with topic links.
- [ ] Do not change `/done`; it remains the GitLab merge-request comment flow.

```bash
npx vitest run test/inbox.test.ts test/bot-commands.test.ts
npm run build
```

- [ ] Commit:

```bash
git add src/inbox.ts src/bot.ts test/inbox.test.ts test/bot-commands.test.ts
git commit -m "NO-TICKET feat: resolve tickets and list open work"
```

### Task 4: Improve Duplicate Handling For Deleted Topics

**Files:**
- Modify: `src/inbox.ts`
- Modify: `src/bot.ts`
- Modify: `test/inbox.test.ts`

- [ ] Add `InboxStore.listTicketsByKey(inboxContextKey, externalKey)` returning newest-first candidates.
- [ ] In ticket creation, probe matching candidates newest-first and append to the first live unresolved topic.
- [ ] If all matching unresolved topics are gone, present two buttons in the source inbox:
  - `♻️ Продолжить старый тикет` creates a new topic and reattaches the existing ticket id.
  - `🆕 Новый тикет` creates a new ticket and stores `supersedesId` pointing to the previous record.
- [ ] Add `supersedesId?: number` to `Ticket` and show the previous ticket reference on the new card.
- [ ] Ensure duplicate decisions expire after restart rather than silently choosing an option.
- [ ] Test key matching, resolved candidates, newest-first ordering, and `supersedesId` persistence.

```bash
npx vitest run test/inbox.test.ts
npm run build
```

- [ ] Commit:

```bash
git add src/inbox.ts src/bot.ts test/inbox.test.ts
git commit -m "NO-TICKET feat: reconnect duplicate tickets with missing topics"
```

## Phase 2: Inbox UX

### Task 5: Edit Inbox Templates From Telegram

**Files:**
- Modify: `src/inbox.ts`
- Modify: `src/bot.ts`
- Modify: `test/inbox.test.ts`

- [ ] Add `InboxStore.setTemplate(contextKey, template)` without changing other settings.
- [ ] Add pure template validation requiring `{message}` and allowing optional `{source}` and `{projectContext}`.
- [ ] Implement:
  - `/inbox template` to display the current template safely.
  - `/inbox template set <text>` to update it; translate literal `\n` sequences to newlines.
  - `/inbox template reset` to restore `DEFAULT_TICKET_TEMPLATE`.
- [ ] Reject empty templates and templates without `{message}`.
- [ ] Keep the existing `/inbox on|off|status` behavior unchanged.
- [ ] Test parsing, validation, and persistence.

```bash
npx vitest run test/inbox.test.ts
npm run build
```

- [ ] Commit:

```bash
git add src/inbox.ts src/bot.ts test/inbox.test.ts
git commit -m "NO-TICKET feat: manage inbox templates from telegram"
```

### Task 6: Generate Better Topic Names From The First Analysis

**Files:**
- Create: `src/topic-naming.ts`
- Create: `test/topic-naming.test.ts`
- Modify: `src/inbox.ts`
- Modify: `src/bot.ts`

- [ ] Add a deterministic instruction to every ticket prompt:

```text
Первой строкой ответа выведи:
TOPIC: <краткое название проблемы до 40 символов>
После пустой строки продолжи основной разбор.
```

- [ ] Implement `extractTopicRename(text)` to accept only a first-line `TOPIC:` marker, normalize whitespace, reject secrets, cap the title, and return the answer without that marker.
- [ ] Implement `renamedTicketTopic(ticket, title)` preserving the external key or internal ticket number and respecting Telegram's 128-character limit.
- [ ] Pass a final-text transformer through `PromptDispatchOptions` into `executeUserPrompt`.
- [ ] On the first completed ticket turn, strip the marker before delivery, call `editForumTopic`, and persist `topicTitle?: string` on the ticket.
- [ ] If the marker is absent or invalid, deliver the original answer unchanged.
- [ ] Add `/title <text>` in ticket topics as a manual fallback.
- [ ] Test Cyrillic titles, markdown answers, missing markers, overlong names, and secret rejection.

```bash
npx vitest run test/topic-naming.test.ts test/inbox.test.ts
npm run build
```

- [ ] Commit:

```bash
git add src/topic-naming.ts src/inbox.ts src/bot.ts test/topic-naming.test.ts test/inbox.test.ts
git commit -m "NO-TICKET feat: rename ticket topics from analysis titles"
```

### Task 7: Inject Project Context Without Hardcoded Templates

**Files:**
- Create: `src/project-context.ts`
- Create: `test/project-context.test.ts`
- Modify: `src/inbox.ts`
- Modify: `src/bot.ts`
- Runtime files: `<workspace>/.telecodex/context.md`

- [ ] Add optional `projectContext?: string` and `realm?: string` to `InboxSettings`.
- [ ] Add `InboxStore.setProjectContext` and `InboxStore.setRealm`.
- [ ] Make `buildTicketPrompt` replace `{projectContext}`; if the placeholder is absent, append a clearly delimited context block.
- [ ] Implement a safe dofbox realm renderer reading only allowlisted, non-secret fields:
  - realm name and description
  - repository names/paths
  - Jira server and project
  - GitLab URL/group
  - Sentry base URL, organization, and project
  - Kubernetes context/namespace names
- [ ] Never copy tokens, passwords, API keys, kubeconfig data, or Telegram bot tokens into prompts.
- [ ] Implement `/inbox realm <name|off>` and `/inbox context [set|reset]`.
- [ ] On `/inbox on`, load `<workspace>/.telecodex/context.md` if present and store it with the inbox.
- [ ] Test realm parsing with fixture JSON containing secrets and verify those values do not appear in output.

```bash
npx vitest run test/project-context.test.ts test/inbox.test.ts
npm run build
```

- [ ] Commit:

```bash
git add src/project-context.ts src/inbox.ts src/bot.ts test/project-context.test.ts test/inbox.test.ts
git commit -m "NO-TICKET feat: inject project context into ticket prompts"
```

## Phase 3: Usage And Digest

### Task 8: Track Token Usage Per Project

**Files:**
- Create: `src/usage-store.ts`
- Create: `test/usage-store.test.ts`
- Modify: `src/config.ts`
- Modify: `src/bot.ts`
- Modify: `test/config.test.ts`
- Modify: `test/bot-commands.test.ts`

- [ ] Persist one compact entry per completed turn in `.telecodex/token-usage.jsonl`:

```ts
interface UsageEntry {
  ts: number;
  contextKey: string;
  workspace: string;
  model?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}
```

- [ ] Record usage inside `onTurnComplete` without allowing ledger I/O failures to fail the turn.
- [ ] Aggregate by workspace for 7-day and 30-day windows.
- [ ] Add `/usage [7|30]` with input, cached input, output, total, and turn count per project.
- [ ] Parse optional `TELEGRAM_WEEKLY_TOKEN_LIMIT`; treat it as a soft warning, never as a hard block.
- [ ] Display 80% and 100% warnings in `/usage` and the morning digest.
- [ ] Keep at most 90 days of ledger data during compaction.
- [ ] Test recording, malformed-line tolerance, aggregation, retention, and budget thresholds.

```bash
npx vitest run test/usage-store.test.ts test/config.test.ts test/bot-commands.test.ts
npm run build
```

- [ ] Commit:

```bash
git add src/usage-store.ts src/config.ts src/bot.ts test/usage-store.test.ts test/config.test.ts test/bot-commands.test.ts
git commit -m "NO-TICKET feat: track token usage by project"
```

### Task 9: Send A Morning Inbox Digest

**Files:**
- Create: `src/inbox-digest.ts`
- Create: `src/inbox-digest-cli.ts`
- Create: `test/inbox-digest.test.ts`
- Create: `systemd/telecodex-inbox-digest.service`
- Create: `systemd/telecodex-inbox-digest.timer`
- Modify: `package.json`

- [ ] Render unresolved tickets grouped by inbox workspace with age, start state, and topic URL.
- [ ] Include current weekly token totals and budget warning from `UsageStore`.
- [ ] Read `INBOX_DIGEST_CHAT_ID` and optional `INBOX_DIGEST_TOPIC_ID`; omit `message_thread_id` when no topic is configured.
- [ ] Send through Telegram Bot API using `TELEGRAM_BOT_TOKEN` and HTML escaping.
- [ ] Do not mutate `inbox.json` from the digest process.
- [ ] Add an npm script for manual execution.
- [ ] Schedule weekdays at 09:00 Europe/Moscow with `Persistent=true`.
- [ ] Test empty state, grouping, links, resolved filtering, and usage warnings.

```bash
npx vitest run test/inbox-digest.test.ts
npm run build
node dist/inbox-digest-cli.js --dry-run
```

- [ ] Commit:

```bash
git add src/inbox-digest.ts src/inbox-digest-cli.ts test/inbox-digest.test.ts systemd package.json
git commit -m "NO-TICKET feat: send morning inbox digest"
```

## Phase 4: Jira And Sentry

### Task 10: Post Analysis Results To Jira

**Files:**
- Create: `src/jira-comment.ts`
- Create: `test/jira-comment.test.ts`
- Modify: `src/config.ts`
- Modify: `src/bot.ts`
- Modify: `test/config.test.ts`

- [ ] Add optional config requiring all three values together:
  - `JIRA_COMMENT_SERVER`
  - `JIRA_COMMENT_LOGIN`
  - `JIRA_COMMENT_TOKEN`
- [ ] Implement Jira Server REST `POST /rest/api/2/issue/{key}/comment` with Basic authentication and injectable `fetch`.
- [ ] Validate keys with the existing Jira-key rules and cap comment bodies at 30,000 characters.
- [ ] After a ticket turn completes, persist the cleaned final answer to `.telecodex/ticket-answers/<ticket-id>.md`.
- [ ] For Jira-key tickets, send a separate `📤 В Jira` confirmation button.
- [ ] On confirmation, read the saved answer, append the Telegram topic URL, post the comment, and remove the button.
- [ ] A Jira failure must be reported in the topic without changing ticket state or failing the Codex turn.
- [ ] Test request URL, authorization header, JSON body, invalid key, truncation, and HTTP failures.

```bash
npx vitest run test/jira-comment.test.ts test/config.test.ts
npm run build
```

- [ ] Commit:

```bash
git add src/jira-comment.ts src/config.ts src/bot.ts test/jira-comment.test.ts test/config.test.ts
git commit -m "NO-TICKET feat: post ticket analysis to jira"
```

### Task 11: Bridge New Sentry Issues Into Inboxes

**Files:**
- Create: `src/sentry-bridge.ts`
- Create: `test/sentry-bridge.test.ts`
- Modify: `src/config.ts`
- Modify: `src/bot.ts`
- Modify: `src/index.ts`
- Modify: `test/config.test.ts`

- [ ] Add optional Sentry bridge config:
  - `SENTRY_URL`
  - `SENTRY_TOKEN`
  - `SENTRY_ORG`
  - `SENTRY_BRIDGE_MAP_JSON`
  - `SENTRY_BRIDGE_INTERVAL_SECONDS`, minimum 300
- [ ] Map each Sentry project to an existing inbox context key and workspace.
- [ ] Poll unresolved issues sorted by frequency using the self-hosted Sentry API.
- [ ] Persist seen issue ids and timestamps in `.telecodex/sentry-bridge.json`, pruning entries older than 90 days.
- [ ] Create at most the configured per-run limit; default five.
- [ ] Use the live in-process `InboxStore` and the same topic/card creation helper as forwarded inbox messages.
- [ ] Set the ticket external key to the Sentry short id and include title, culprit, count, first/last seen, and permalink in the ticket text.
- [ ] Do not auto-run Codex; every Sentry-created ticket gets the same `▶️ Запустить разбор` and `✅ Решён` controls as other inbox tickets.
- [ ] Add `/sentry [hours]` for a manual run and status summary.
- [ ] Start and stop the bridge with the bot lifecycle in `src/index.ts`.
- [ ] Test config parsing, API failures, deduplication, pruning, mapping, and rendered ticket text.

```bash
npx vitest run test/sentry-bridge.test.ts test/config.test.ts
npm run build
```

- [ ] Commit:

```bash
git add src/sentry-bridge.ts src/config.ts src/bot.ts src/index.ts test/sentry-bridge.test.ts test/config.test.ts
git commit -m "NO-TICKET feat: create inbox tickets from sentry issues"
```

## Phase 5: Operations And Maintainability

### Task 12: Back Up Runtime State Daily

**Files:**
- Create: `scripts/backup-state.sh`
- Create: `systemd/telecodex-backup.service`
- Create: `systemd/telecodex-backup.timer`

- [ ] Back up `.telecodex/*.json`, `.telecodex/ticket-answers/`, and `recipes/recipes.json`.
- [ ] Write timestamped archives to `/root/backups/telecodex`.
- [ ] Copy the latest archive to `/root/Sync/telecodex-backups/latest.tar.gz` for Syncthing replication.
- [ ] Keep the newest 30 archives and remove older ones.
- [ ] Use `set -euo pipefail`, temporary output plus atomic rename, and restrictive permissions.
- [ ] Schedule daily at 03:30 Europe/Moscow with `Persistent=true`.
- [ ] Verify archive listing and extraction before enabling the timer.

```bash
bash scripts/backup-state.sh
tar -tzf /root/backups/telecodex/$(ls -1t /root/backups/telecodex | head -1) | head
```

- [ ] Commit:

```bash
git add scripts/backup-state.sh systemd/telecodex-backup.service systemd/telecodex-backup.timer
git commit -m "NO-TICKET chore: back up telecodex runtime state"
```

### Task 13: Extract Inbox Handlers From `bot.ts`

**Files:**
- Create: `src/bot-inbox.ts`
- Modify: `src/bot.ts`
- Modify or add: `test/bot-inbox.test.ts`

- [ ] Extract only the cohesive inbox/ticket block first:
  - `/inbox`, `/tickets`, `/title`, `/sentry`
  - inbox burst buffering and split callbacks
  - ticket creation, append, reattach, and notification helpers
  - `ticket_start`, `ticket_done`, duplicate-decision callbacks
  - Jira-post confirmation callback associated with tickets
- [ ] Export `registerInboxHandlers(deps)` with an explicit typed dependency object rather than importing mutable bot internals.
- [ ] Preserve middleware registration order: the inbox message interceptor must remain before normal session message handlers.
- [ ] Move code verbatim first; do not rewrite behavior during extraction.
- [ ] Keep public exports currently consumed by tests in `src/bot.ts` or re-export them from there.
- [ ] Add focused registration tests for commands and callback patterns.
- [ ] Run full tests and build immediately after extraction; if smoke checks fail, revert only this refactor commit while keeping completed features.

```bash
npm test
npm run build
sudo systemctl restart telecodex
journalctl -u telecodex -n 50 --no-pager
```

- [ ] Commit:

```bash
git add src/bot-inbox.ts src/bot.ts test/bot-inbox.test.ts
git commit -m "NO-TICKET refactor: extract inbox handlers from bot"
```

## Phase 6: Deployment

### Task 14: Configure, Deploy, And Verify

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Runtime only: `.env`, `.telecodex/inbox.json`, systemd units

- [ ] Document new commands and environment variables without values or secrets.
- [ ] Copy Jira credentials from the host dofbox realm into `.env` without printing them.
- [ ] Copy Sentry credentials from the local `mircli` dofbox realm into host `.env` through a temporary file transferred over SSH; delete the temporary file on both machines.
- [ ] Configure the bridge map for `mir-back` to inbox `-1003981282865:537` and workspace `/root/dev/Projects/mircli`.
- [ ] Configure digest chat `-1003981282865`; use the Dashboard topic id if known, otherwise intentionally send to General until configured.
- [ ] Migrate existing inbox records additively; preserve all tickets and prompts.
- [ ] Install and enable systemd timers:

```bash
install -m 0644 systemd/telecodex-inbox-digest.service /etc/systemd/system/
install -m 0644 systemd/telecodex-inbox-digest.timer /etc/systemd/system/
install -m 0644 systemd/telecodex-backup.service /etc/systemd/system/
install -m 0644 systemd/telecodex-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now telecodex-inbox-digest.timer telecodex-backup.timer
```

- [ ] Run final verification:

```bash
npm test
npm run build
sudo systemctl restart telecodex
systemctl is-active telecodex
systemctl list-timers --all | grep telecodex
journalctl -u telecodex -n 100 --no-pager
```

- [ ] Perform Telegram smoke tests:
  - `/tickets` renders the three inboxes and no resolved tickets.
  - `/usage 7` groups usage by project.
  - `/inbox template` shows the template without creating a ticket.
  - A forwarded message creates a ticket with identical launch/resolve controls.
  - The first analysis strips `TOPIC:` and renames the topic.
  - Resolve closes the topic and removes it from `/tickets` and digest.
  - Jira posting requires confirmation and posts exactly one comment.
  - `/sentry 24` creates only unseen issues in Mircli inbox.
  - Service restart produces no dead model-picker errors.

- [ ] Commit documentation:

```bash
git add .env.example README.md
git commit -m "NO-TICKET docs: document inbox and integration improvements"
```

## Rollback

- Feature rollback: revert the corresponding commit, rebuild, and restart.
- Runtime state rollback: stop TeleCodex, restore the newest known-good archive into `.telecodex`, then restart.
- Integration rollback: remove Jira/Sentry variables from `.env` and restart; core Telegram/Codex behavior remains available.
- Timer rollback: `systemctl disable --now telecodex-inbox-digest.timer telecodex-backup.timer`.
- Never use `git reset --hard` or overwrite runtime state without a backup.

## Final Acceptance Criteria

- All Vitest tests and TypeScript build pass on the host.
- TeleCodex starts without model-picker restoration errors for deleted topics.
- Mircli, Antwerp, and 2skymobile inboxes retain identical launch behavior.
- Tickets can be resolved, listed, deduplicated, titled, and included in the digest.
- Project context is injected without exposing realm secrets.
- Jira comments are confirmation-gated and Sentry tickets are deduplicated.
- Usage reporting persists across restarts and warns at the configured weekly limit.
- Runtime state is backed up daily and can be restored.
- `src/bot.ts` is smaller after inbox extraction with no behavior regression.
