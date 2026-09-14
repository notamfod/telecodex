# TeleCodex UX-05–UX-07 and release

User instruction 2026-09-14: complete remaining work autonomously, including Git integration and updating the running service. This supersedes earlier per-step permission checkpoints. Existing master design remains in effect.

- [x] UX-05: shared durable provisioning and persisted Inbox grouping/duplicate decisions; source-visible outcomes, no repeated ambiguous creation.
- [x] UX-05/06: /newtask creates a separate topic after project/profile preview; /newchat retains explicit current-topic semantics and previous thread link; /extract replies to one message, previews bounded context and attachment, preserves source links, never starts a run implicitly.
- [x] UX-07: persisted all/selected-project/on-request policy, candidate preview, explicit apply, unchanged default, tombstone preservation.
- [x] Review specification and quality; fix findings; run full tests, browser tests, server/web build, Svelte check and diff check.
- [x] Commit UX-04–UX-07, fast-forward fork/main, pull main checkout.
- [x] Repeat release preflight; verified backup of runtime/config/state and SQLite; install exact tested build, restart and verify health/readiness/guardian plus no new startup errors. Keep rollback.
- [x] Record final results and remaining real-device validation limits in master plan.

Implementation: isolated existing worktree topic-interaction-ux04. Manual/extract uses the same operation service as Inbox, with deterministic source operation IDs and durable user/chat-bound preview drafts. Confirmation is an in-product UX action, not a request for operator permission. Selected project inherits its checked launch profile; topic creation does not start Codex. On uncertain external creation, preserve the operation for inspection and do not recreate. Existing historical delivery failures are outside this feature release and will not be mass-retried.


## Implementation and review

Shared SQLite provisioning covers manual tasks, Inbox and auto-sync. Durable Inbox decisions and message receipts survive restart; ambiguous create/copy outcomes are retained, never blindly replayed. Registry and Inbox binding now require successful durable persistence. Shutdown drains Inbox work and provisioning before closing the shared store/gate.

Manual commands: /newtask <title>, /extract as a reply, /newchat (the existing /new behavior remains available). Preview binds user, chat, topic, source message and selected project/profile. The previous conversation reference is persisted before switching. Profile changes cannot turn an uncertain old request into an invitation to create another topic.

Topic sync: /topicsync previews and explicitly applies all/selectedprojects/onrequest. Existing default is preserved. Removed bindings have durable tombstones. Unknown create outcomes remain blocked; only definitive 429 and pre-admission cancellation are safely retryable, with persisted cooldown.

Independent reviews completed and findings fixed. Browser: 23/23 passed in /var/tmp/telecodex-completion-browser.log. The first full run exposed five old Inbox fixture/expectation failures and a real loss of the sanitized error category. Fixtures were corrected, failureCategory is now persisted without raw errors. Final full suite: 3454/3454 tests in 209/209 files, 276.65 s; /var/tmp/telecodex-completion-full-final.log.

Private pre-release backup: /var/backups/telecodex/20260914T065000Z-ux04-ux07. Includes previous dist/dist-web, source archive, configuration, active non-SQLite state and three SQLite backup API snapshots. All snapshots quick_check/FK checks passed. Historical backup/release-state trees were left in place and excluded from the new active-state copy. No runtime state has been restored or repaired.

Rollback note: old deployed code only supports task schema v1, while current candidate supports v3. If a v3 task DB appears after release, preserve its task/card identities and use a compatible code rollback or forward fix; do not replace it with an old snapshot after external effects.

Final server/web build, Svelte check (0 errors, 0 warnings), and diff check passed. No separate lint script exists. Build/check logs: /var/tmp/telecodex-completion-build.log, /var/tmp/telecodex-completion-webcheck.log.


## Выпуск завершён

Код UX-04–UX-07 закоммичен как `fdc23edbad57ce446d902b2f7a9387737f8bad63`, опубликован обычным fast-forward в `fork/main`. Основной checkout на `main` подтянут. Установлен ровно проверенный dist/dist-web; SHA256 совпадает для всех 178 файлов.

TeleCodex перезапущен 2026-09-14 в 07:03:24 UTC. Новый PID 191765, NRestarts=0. Перед остановкой два preflight подтвердили safeToRestart=true, Guardian ready, queued/running=0 и sending/uncertain=0. После запуска healthz и readyz возвращают ok; Guardian остаётся ready. Новых error/fatal/uncaught/unhandled/failed записей в журнале запуска не найдено (19 записей проверено).

Защищённый Dashboard проверен локальными read-only HTTP-запросами с подписью: completed, серверный поиск, projects и namespace проверенного пользователя/чата; без подписи API возвращает 401. Токены, подпись и содержимое задач не выводились. Runtime jobs.sqlite, session-guardian.sqlite и новый task-provisioning.sqlite прошли quick_check/FK checks. topic-tasks.sqlite ещё не создан: новые карточки не включались массово.

Счётчики до/после выпуска одинаковы: delivering=9, attention=10, pending deliveries=2, failed deliveries=13, sending/uncertain=0. Это исторические записи; повтор и восстановление не запускались. Автосинхронизация остаётся выключенной (onrequest), как до выпуска.

Итоговые проверки: 3454 теста в 209 файлах, 23 браузерных сценария, server/web build, Svelte check (0/0), diff check. Реальный телефон/Telegram WebView не использовался как тестовый стенд; клики и мобильная вёрстка проверены через Playwright, работа установленного API проверена отдельно. Восстановление production из резервной копии не выполнялось.
