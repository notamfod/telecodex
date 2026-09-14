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

## Дополнительное обслуживание по указанию «делай»

- [x] Освободить общий /tmp без потери данных и настроить собственный TMPDIR/retention TeleCodex.
- [x] Проверить восстановление резервной копии в изолированном окружении.
- [x] Проверить реальный Telegram API на отдельном техническом топике.
- [x] Проверить назначения и причины исторических сбоев, выполнить доступные штатные действия.
- [x] Исправить восстановление отсутствующего rich anchor и повтор терминального статусного сообщения; проверить сохранность payload, CAS, неопределённых отправок и конечного результата задачи.
- [x] Добавить отдельную операторскую повторную попытку failed topic resume с сохранением прежней попытки, новым token/version и повторной проверкой source/binding/topology; не ослаблять обычный retry.
- [x] Провести review, tests/build, backup, merge/push и обновить работающий сервис.
- [x] Восстановить доступ к девяти сохранённым ответам: локальный проверенный архив передан отдельным документом в новый топик Telegram.
- [ ] Доставка по исходным topic ID невозможна: все шесть топиков удалены; старые outbox-записи сохранены без фиктивного delivered.
- [x] Записать конечные счётчики и ограничения.

/tmp: шесть неиспользуемых Go cache каталогов перенесены в /var/cache/codex-relocated-tmp, SHA256 каждого файла проверен, исходные пути сохранены symlink. Свободно 1,3 ГБ вместо полного tmpfs. Исходники других проектов и Snap private tmp не удалялись. Manifest: /var/cache/codex-relocated-tmp/relocation-20260914.json. В telecodex.service применён TMPDIR=/var/cache/telecodex/tmp (0700), tmpfiles retention 7d; глобальная политика /tmp не изменена. После gated restart PID 288479, healthz/readyz ok, Guardian active, NRestarts=0.

Restore drill: /var/tmp/telecodex-restore-drill-42xbgh0m/report.json. Начальный manifest 529/529, архив исходников 477/477 Git blobs, три SQLite integrity/FK проверки успешны. Текущие адаптеры прочитали 1026 jobs, 48422 events, 1217 deliveries; Guardian и миграция legacy guardian проверены. Синтетическая миграция topic task v1→v3 прошла; реальной task DB в резервной копии не было. unshare -n исключил сетевые эффекты, production не восстанавливался. installed-sha256.json относится к установленной новой сборке, а не к старой сборке внутри backup; с текущим runtime совпало 178/178 файлов.

Live API smoke: /var/tmp/telecodex-live-smoke-e3bz6x0f/report.json. Технический топик 5480, карточка 5481. Через текущие TopicTaskCardService и TopicTaskLifecycleService подтверждены 11/11 вызовов: create, send/edit/pin, close/reopen/close. Изолированная task DB целостна, итоговая карточка ready+pinned+current, топик closed, незавершённых intents нет. Это проверка Telegram API, не физического телефона или Mini App WebView.

Delivery audit: 13 failed anchors состоят из восьми сохранённых rich final answers, четырёх терминальных status updates и одного anchor с предыдущим failed resume, блокирующего два pending followers. Все привязки к исходным thread/topic сохранены; sendChatAction classifier вернул live для всех шести топиков. Позднее строгая проверка опровергла этот вывод: успешный typing не доказывает существование топика. У восьми rich anchors пустой responsePlan предусмотрен контрактом: final answer хранится в самом anchor и совпадает с turnResult. Штатный повтор подтвердил permanent failure; retry терминального status воспроизвёл 500 до сетевого вызова из-за отсутствующего terminal перехода в outbox ledger. Исторические состояния не очищаются вручную и не объявляются доставленными без подтверждения Telegram.

Maintenance design: missing edit_rich becomes send_rich only after definitive message_missing, with unchanged Markdown/media and rebound fallback. The existing hash/attempt/lease/message CAS updates delivery and anchor plan atomically. Terminal status retries retain outcome, attention and terminalAt; pending/sending continuation is gated by a durable explicit-retry event, so historical rows are not adopted automatically. Operator retryFailed creates a fresh failed-resume attempt only after exact evidence checks, archives the previous terminal snapshot, and retains the generic retry fences.

Jobs schema advances from v9 to v10 to retain topic_resume_attempt_history. Old v9 binaries cannot read v10; rollback must use compatible code. Restoring a pre-send database after confirmed external messages would discard their receipts and is not an acceptable rollback. Retention removes history only together with its eligible parent job.

Dry-run of the operator method on a current production DB copy completed the one blocked job with three mock-confirmed sends and a new token; this proves state transitions, not live delivery. A separate copy verified all twelve other anchor recoveries: eight final answers completed, four terminal outcomes preserved. No network transport was used for these database-copy exercises. Independent review passed; three new test files independently passed 30 tests. Rollback build directories formerly untracked in the main checkout were moved with hash verification to /var/backups/telecodex/20260914T034000Z-rollback-builds; main checkout is clean.

Maintenance validation: full Vitest suite passed 3484 tests in 212 files (294.84 s), /var/tmp/telecodex-maintenance-full.log. Independent review found no blocking issues. No frontend behavior changed; the earlier 23 browser scenarios remain the browser evidence for this UX release.
Final maintenance server/web build and Svelte check (0 errors, 0 warnings) passed; logs /var/tmp/telecodex-maintenance-build.log and /var/tmp/telecodex-maintenance-webcheck.log. No separate lint script exists. Diff check passed.


## Итог дополнительного обслуживания

Код `5705098` опубликован fast-forward в fork/main и подтянут в основной checkout. Сервис запущен с новой сборкой, PID 363506, NRestarts=0. Все 178 установленных файлов совпадают с manifest проверенной сборки. healthz/readyz ok, Guardian active/ready, fatal/uncaught/unhandled записей после старта не обнаружено. База jobs.sqlite успешно мигрирована в v10, quick_check/FK checks прошли.

Новая резервная копия перед миграцией: /var/backups/telecodex/20260914T080211Z-delivery-maintenance, 528 файлов в исходном manifest, четыре целостных SQLite snapshot. Операторская попытка последней задачи создана штатным новым методом: прежний failed snapshot с baseline32 сохранён в topic_resume_attempt_history, новый token использован; Telegram отклонил anchor permanent на попытке34, followers остались pending с attempts0. Повторные попытки не запускались.

Строгая проверка через reopenForumTopic вернула 400/missing_topic для 3601, 4465, 4555, 4113, 4546 и 4552. Ни один топик не был открыт или создан этим запросом. Более ранний успешный sendChatAction был ложноположительным свидетельством наличия топика. Отправку в удалённые топики прекращено; нельзя восстановить прежние Telegram topic ID или утверждать доставку по успешному typing.

Текущие счётчики: delivering=9, attention=13, pending deliveries=2, failed deliveries=13, sending=0, uncertain=0. Это НЕ закрытая доставка. Новая поддержка повторов исправляет воспроизведённые ошибки, но не восстанавливает удалённые назначения и не переносит старые задачи в новые топики автоматически. Массовые новые топики и новые прогоны Codex не создавались.

Содержимое девяти результатов (5686 символов) сохранено в /var/backups/telecodex/20260914T080211Z-delivery-maintenance/recovered-results/answers.md. Рядом private JSON каждой задачи с исходным source, deliveries и recovery/resume evidence; manifest содержит SHA256. Исходная база и её недоставленные состояния сохранены. Следующий отдельный сценарий для Telegram-доставки этих результатов: явно обозначенное восстановление в новые топики с сохраняемым соответствием старых и новых назначений; существующий retry не должен обходить эти проверки.

/tmp освобождён, собственный TMPDIR/7d retention применён, restore drill и live Telegram API pilot завершены. Реальный телефон/Telegram WebView по-прежнему не проверен: доступного физического устройства в окружении нет. API pilot не подменяет такую проверку.


### Передача восстановленного содержимого

Девять ответов переданы одним файлом answers.md в новый открытый топик «Восстановленные ответы · 14.09»: https://t.me/c/3981282865/5486 (топик 5485, документ 5486). Telegram подтвердил createForumTopic и sendDocument; повторов не было. Размер 9770 байт, SHA256 c1d5e0b3e3f8fd46403a9eb9c598ff64a68848b5c1e5a58f96540c32e0354322 сверён с локальным файлом. Receipt: /var/tmp/telecodex-recovered-answers-send-38c7pl23/receipt.json. Отправлен только файл ответов; private JSON и конфигурация остались локально.

Это отдельная подтверждённая передача восстановленного содержимого. Старые source/binding и 13 failed outbox-записей сохранены как история недоставки в удалённые назначения. Топик-архив не продолжает исходные сессии, новые прогоны не запускались. Неустранимое ограничение прежних topic ID отделено от восстановленного доступа к самим ответам.
