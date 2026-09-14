# TeleCodex message UX-08 implementation plan

> For agentic workers: use subagent-driven-development, review each implementation before integration.

Goal: make Telegram messages readable, reduce routine status noise, and provide truthful recovery/navigation without losing answers or weakening delivery fences.
Architecture: retain immutable answer content and durable outbox. Presentation changes happen before payload persistence; existing payloads are never reformatted in place. Compact status/card renderers distinguish work, waiting, task failure and delivery failure. Availability checks must treat typing success as insufficient evidence.
Tech stack: strict TypeScript, grammy, SQLite, Vitest, Svelte, Playwright.

User approved the proposed next stage and autonomous completion, Git integration and running-service update. Use existing isolated worktree, branch message-ux08. No extra approval checkpoints.

- [x] Status/card presentation: inspect turn-progress.ts, topic-task-projection.ts and tests. Add tests for compact normal progress, explicit required action, delivery failure versus task failure, absent placeholders, meaningful result links. Implement clear Russian headings and separated primary action; preserve all action handles/versions and diagnostic access. Quantize incidental timing so heartbeats do not rewrite a card every second. Run relevant tests.
- [x] Reliable topic availability: audit telegram-topic-liveness.ts and all callers; reproduce typing-success false positive. Implement truthful availability using confirmed evidence or unknown; no read-only check may reopen/create/send messages or imply missing from a timeout. Preserve error/rate-limit propagation and recovery fences; test unknown, known missing, confirmed successful operations, cancellation and recovery. Run relevant suites.
- [x] Answer presentation: inspect format.ts, telegram-response-plan.ts and rich formatter/tests. Preserve code, links and answer wording. Make long multipart answers understandable with bounded part labels, readable separation and Russian service text, respecting HTML/rich/fallback budgets and stable part identities. Do not generate invented summaries or append canned sections to short answers. Add tests for multi-part text/code/Unicode/escaping and localized notices; run delivery contract tests.
- [x] Returning to tasks: inspect shared task links/actions and card rendering. Surface confirmed result and pending question/approval action where evidence exists; retain existing context-bound controls. No fabricated exact question link. Include in review and browser validation.
- [x] Update master plan, independent specification/quality review, fix findings. Full Vitest suite with TMPDIR=/var/tmp and one worker, server/web build, Svelte check, browser tests; no lint script exists.
- [x] Commit/push fast-forward fork/main, pull local main. Gate restart on preflight plus queued/running/sending/uncertain=0; verified private backup and compatible schema. Install exact tested build, verify hashes, health/readiness/Guardian and logs. No historical mass retry or source/receipt rewriting.
- [x] Live Telegram smoke in dedicated technical topic with synthetic examples and persisted intent/receipts; check API acceptance and correct destination, preserve ambiguity fences. Record that actual phone/WebView testing cannot be performed without a device.

Acceptance examples: normal progress has a clear first-line state without counters for undelivered status anchors; waiting explains the next action; delivery failure does not say the task failed; terminal confirmation reflects actual delivery. Short answers remain short. Multipart labels do not split code fences or exceed send/edit limits. Deleted-topic evidence is not replaced by a successful typing probe.

## Implementation and review

Implemented compact progress, minute-bucket quiet status, neutral sleep, preserved health warnings, and separated delivery-failure guidance. Card state precedes title/project; absent-result placeholders are removed. Confirmed result and waiting-topic links survive failed inspection, while mutable actions fail closed.

Typing acknowledgements now mean unknown. Navigation reuses recorded bindings without claiming live availability; Inbox append and card creation use intended sends with persisted ambiguity fences. Definitively missing cards may be replaced once on unknown availability, but probe errors and known closed/missing topics block sends. Successful close/reopen still confirms directly. Resume on unconfirmed availability remains blocked; no speculative replacement topics.

Ordinary split messages and rich-message fallbacks receive bounded part labels. Primary rich Markdown stays unchanged; numbering is per text block. Existing persisted payloads and delivery identities are unchanged. Short answers retain their wording, code and links; no generated summaries. Normal heartbeat age alone no longer changes status text, but legitimate action-version changes may still update keyboards.

Independent review found and verified fixes for sleep falsely requesting user input, inspection failure hiding result links in actual consumers, and deleted-card regeneration. Added regression tests for those cases and probe-429 admission. Review approved the final inspected scope. Full validation and deployment evidence follows below.

## Validation before integration

- Full Vitest: 3515 tests in 213 files passed, including final card and consumer regressions (`TMPDIR=/var/tmp npm test -- --maxWorkers=1`).
- Server/web build passed; Svelte check: 0 errors, 0 warnings. No lint script exists; diff check passed.
- Browser suite: 23/23 passed. Initial invocation could not launch because Playwright expected Chromium headless shell revision 1243 while only 1237 was installed. Installed the matching shell with `npx playwright install chromium --only-shell`; rerun passed without application changes.
- Live-smoke operator script was rehearsed with an entirely mocked fetch and isolated store before any Telegram API calls. This rehearsal is not live evidence.
- Logs: `/var/tmp/telecodex-ux08-full.log`, `telecodex-ux08-build.log`, `telecodex-ux08-webcheck.log`, `telecodex-ux08-browser.log`.

## Release and live verification, 2026-09-14 08:34 UTC

Implementation commit `abed8a0a40b7346f5ab8258876ee8e9d7a8fc6a2` was fast-forward pushed to `fork/main`; main checkout pulled the same commit. Installed the exact tested dist/dist-web, verified all 178 files by SHA256 and exact file set. No config/schema change was required. Restart was gated twice on safeToRestart, guardian ready, and zero queued/running/sending/uncertain work.

Private rollback backup: `/var/backups/telecodex/20260914T083323Z-message-ux08`, 528 verified files, four SQLite copies passed quick_check and foreign_key_check; jobs schema 10. Contains pre-release build/config/state and source snapshot `74aed4f`. Restore was not exercised in this release. Never restore a pre-send database after confirmed external messages; rollback code only unless receipts are reconciled separately.

TeleCodex PID 474743 active, NRestarts=0; Guardian PID 2007728 active, NRestarts=0. Healthz and readyz returned 200/ok; authenticated Dashboard GET returned 200. Post-smoke preflight retained historical baseline: queued/running/sending/uncertain=0, delivering=9, attention=13, pending=2, failed=13, guardian ready. Fresh service log inspection: 16 info entries, no error/failure/exception patterns.

Live API pilot used a dedicated technical topic [5487](https://t.me/c/3981282865/5487), card 5488 and a sample response 5490–5492 with code, link and three part labels. All 18 API operations were confirmed, including typing classified unknown, intended card send, pin/edit, answer send, close/reopen/close. Final card ready/current/pinned, topic closed, no pending lifecycle intents. Runtime registry/Inbox were not used for the synthetic task; its task database is isolated. Receipt: `/var/tmp/telecodex-ux08-live-24ru_mp7/report.json`.

Remaining validation boundary: no physical phone or real Telegram WebView interaction was available. Browser tests use API fixtures; the live pilot proves Telegram API acceptance and destination, not visual rendering on a phone. Historical failed deliveries to six deleted source topics were not retried; their nine recovered answers remain in the previously delivered archive [5486](https://t.me/c/3981282865/5486).

## Follow-up: continue a Codex session in its own topic

User correction: `/attach` and the `/sessions` picker changed the invoking topic; the desired workflow creates a separate topic for a Codex ID. Continue autonomously under existing implementation/Git/deployment authorization.

- [x] Add `/topic ID` and route forum `/sessions ID`/picker to separate-topic navigation before touching the source session. Keep `/switch` as explicit in-place switching and retain private-chat selection behavior. Validate missing/unknown ID without writes.
- [x] Reuse existing dedicated destinations, excluding the invoking legacy binding. Persist a stable chat/thread creation intent using existing TaskProvisioningService; concurrent/repeated requests and unknown creation outcomes must never create duplicates. Bind only the created destination durably; do not start a Codex turn.
- [x] Update command/help/README wording, regression tests, independent review and required full tests/build/checks.
- [ ] Publish main, update local checkout, deploy exact tested build after safe preflight/backup, verify health and command registration.

Implementation: bot.ts routing and projects.ts topic resolution/provisioning; projects and bot-topic-liveness integration tests. Help and README explicitly distinguish separate-topic navigation from current-context switching. Existing dedicated-topic receipts may be reused even from that dedicated topic; no topic-per-click behavior.

Follow-up implementation/review: forum `/sessions` uses separate pagination state (`topicsess`) from `/switch`; generic Codex buttons also navigate to dedicated topics. Creation shares `sync:<chat>:<thread>` and the existing provisioning service with automatic sync. Confirmed receipts require a matching session binding; accepted 429 retries honor the persisted deadline; uncertain operations remain fenced. Dashboard callbacks refresh the launcher without posting extra messages. Menu entries are unique. Focused tests: 85/85, server build passed. Initial full suite overlapped the RED stage of two added regressions; final full suite is rerun against frozen implementation before release.

Final frozen-implementation Vitest run passed: 3541 tests / 213 files (`/var/tmp/telecodex-topic-open-final-full.log`). Both regressions that were still RED during the overlapping initial run now pass in the fresh full suite. No source changes were made during this final run. Physical Telegram creation was not triggered for an unspecified user session; route tests intercept Telegram calls and explicitly prove source preservation. Release verification will use real command-menu/health reads and compare the existing binding snapshot.

Final server/web build and Svelte check passed (0 errors, 0 warnings); diff check clean. Logs: `/var/tmp/telecodex-topic-open-build.log`, `/var/tmp/telecodex-topic-open-webcheck.log`.
