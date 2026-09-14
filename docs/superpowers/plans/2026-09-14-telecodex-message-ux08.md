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
- [ ] Commit/push fast-forward fork/main, pull local main. Gate restart on preflight plus queued/running/sending/uncertain=0; verified private backup and compatible schema. Install exact tested build, verify hashes, health/readiness/Guardian and logs. No historical mass retry or source/receipt rewriting.
- [ ] Live Telegram smoke in dedicated technical topic with synthetic examples and persisted intent/receipts; check API acceptance and correct destination, preserve ambiguity fences. Record that actual phone/WebView testing cannot be performed without a device.

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
