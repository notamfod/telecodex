# TeleCodex UX-02 Implementation Plan

> Use `subagent-driven-development` and TDD. User authorized continuation on 2026-09-13. No commit, publication, live Telegram calls or restart.

**Goal:** Одна постоянная карточка задачи на рабочий топик, понятные состояния и сохранение ручного названия.

**Architecture:** Отдельный SQLite store `topic-tasks.sqlite` хранит identity, metadata, send intent и message ID карточки. Canonical runtime наблюдает только подключённые топики и передаёт проекцию отдельному сервису, не блокируя доставку ответов. Per-job anchors остаются независимыми.

**Tech Stack:** TypeScript, better-sqlite3, grammY, Vitest.

## Контракт

- Явное подключение выбранного топика через `/task`; повтор команды обновляет ту же карточку. `/task off` отключает обновления с сохранением данных. Никакого массового подключения при запуске. Только forum task contexts, исключая Inbox и служебные панели.
- `/task title <название>` задаёт ручное название; оно приоритетнее автоматического. Внешнее ручное переименование также сохраняется. Название нормализуется, проверяется на секреты и ограничивается 128 Unicode code points. Для автоматического имени используется ключ тикета или проект.
- SQLite новая таблица с version=1 и CAS, stable task ID по chat/topic. Отсутствующий файл создаётся только при первом подключении. Не меняет contexts/jobs и не переносит историю сообщений. Можно отключить UI без удаления DB.
- До send сохраняются state=sending и attempt ID. Неопределённый результат или рестарт в sending запрещает повторный send. Явное отклонение также требует повторного явного действия; неопределённый исход нельзя очистить кнопкой повтора.
- Существующая карточка редактируется только при отличии content hash. Новый job меняет состояние той же задачи, не сбрасывает card ID. Старый job/version не перезаписывает новый.
- Подтверждённый message missing допускает замену только после свежей проверки живого ТОГО ЖЕ топика. Closed/missing/unknown не создаёт сообщение. Нехватка прав pin сохраняет карточку и поясняет, что её нужно закрепить вручную.
- Все записи в Telegram проходят общий background write gate и имеют deadline. Обновления отделены от canonical work; ошибки карточки не ломают запуск/доставку агента.
- Карточка показывает название, проект, состояние, последнее подтверждённое событие и ссылку только на подтверждённо доставленный результат. Lifecycle задачи остаётся open после terminal_delivered; закрытие пользователем относится к UX-03. Ожидание input/approval имеет приоритет над stalled.
- `/start`, `/help`, подписи per-job и кнопок получают русское объяснение. Технические диагностические коды остаются в подробностях.

## Шаги

- [x] RED → GREEN store: restart, CAS двух соединений, corruption/invalid inputs, identity/card ID survives new job, sending survives restart.
- [x] RED → GREEN pure projection: все agent states, waiting vs stalled, escape/secret filtering, verified result link, safe bounded names.
- [x] RED → GREEN card service: send once, no-op hash, pin denial, unknown send/restart, missing edit with live/unknown/closed probe, old job, concurrent interaction.
- [x] RED → GREEN canonical observer: delivering/completed and outbox transitions, disabled contexts, no writes from dashboard, failure isolation.
- [x] Wire bot commands, lifecycle observations, title override, index observer and shutdown; focused integration checks use mocked Telegram only.
- [x] Spec review, quality review и исправление замечаний.
- [x] Итоговый полный Vitest, Svelte check/build/browser/diff check завершены.

## Проверки

```bash
TMPDIR=/var/tmp npx vitest run test/topic-task-store.test.ts test/topic-task-projection.test.ts test/topic-task-card.test.ts test/topic-task-runtime.test.ts test/bot-topic-tasks.test.ts --maxWorkers=1 --minWorkers=1
TMPDIR=/var/tmp npm test -- --maxWorkers=1 --minWorkers=1
npm run check:web
TMPDIR=/var/tmp npm run build
git diff --check
```

Локальное исполнение только в worktree `topic-interaction-ux01`, поверх проверенного UX-01. Пилот с реальным закреплением и restart остаётся отдельной операцией выпуска. Новая DB резервируется вместе с `.telecodex` перед rollout; локальный restart test проверяет сохранение ID, но не подменяет production backup.

## Реализованный контракт и проверка

- Новые файлы: `src/topic-task-store.ts`, `src/topic-task-projection.ts`, `src/topic-task-card.ts`, `src/bot-topic-tasks.ts`; каждый меньше 200 строк. При первом подключении создаётся новая SQLite DB schema version 1; существующие contexts/jobs не мигрируются.
- `latestJobOrder` берётся из глобального AUTOINCREMENT sequence события `update.accepted`, включая архив. Это отличает прогоны с одинаковым временем и сохраняет текущую карточку при запоздалом завершении старого прогона.
- Начальное и явное обновление карточки читает последний принятый прогон по фактическому target topic через `refreshTopicTask`. Запрос Dashboard не включает карточки и не пишет в Telegram.
- Input/approval показываются только при проверенном exact thread/turn и активном флаге app-server; недоступные/противоречивые данные не подменяются догадкой по общей activity=waiting.
- До pin сохраняется неопределённое состояние закрепления. До send сохраняется отдельное намерение. При 4xx/pre-admission rejection автоматические обновления отключаются до новой явной `/task`; timeout/unknown никогда не разблокируется повтором команды.
- Ручное и автоматическое переименование идут через одну очередь на топик. Ручное имя проверяется внутри очереди и после запроса; отложенное auto metadata не перезаписывает manual.
- `/task off` сохраняет DB и message ID. В canonical mode функция отключена до первой команды в каждом выбранном рабочем топике; в legacy JSON режиме недоступна. В Inbox, Dashboard, Jira panel и общем топике не подключается.

Проверки до полного финального прогона: store 20, projection 15, card service 15, bot adapter 10, runtime observer 13; интеграционные проверки authorization/commands/callbacks выполнены. Отдельно проверены невозможность повторного send после успешного Telegram и неудачной записи ID, pin intent, неизвестный send, явный отказ, удалённая карточка в live/closed/unknown топике, пропущенное reopen, отказ DB, ограничение ожидания gate, отключение, два варианта гонки ручного названия. Source-string assertions не заменяют эти поведенческие тесты.

Первый общий прогон обнаружил устаревшие English expectations в callback tests и смешанный снимок menu/source при параллельном изменении тестов. Ожидания исправлены по новым подписям, включая отдельную проверку /jira; 97 focused tests прошли. Добавлен regression edit timeout → Telegram 400 «message is not modified» → hash сохранён, повторных edit нет; отдельный пакет 16/16 прошёл. Итоговый полный прогон запущен после остановки правок исходников.

Svelte check: 0 ошибок и предупреждений. Server/web build: успешно. Browser UX-01 regression: 15/15. Spec и quality review: подтверждённые замечания закрыты.

Логи: `/var/tmp/telecodex-ux02-complete-tests.log`, `/var/tmp/telecodex-ux02-build.log`, `/var/tmp/telecodex-ux02-browser.log`.

Ограничения выпуска: live Telegram/реальный телефон и production backup/restore не выполнялись. Достоверность неизвестного send требует отдельного ручного разбора; unsafe кнопки повторного создания нет. Мутации lifecycle задачи и контекстные кнопки относятся к UX-03. Commit/push/deploy/restart не выполнялись.

**Итог:** `TMPDIR=/var/tmp npm test -- --maxWorkers=2 --minWorkers=1`: **3320/3320 tests, 197/197 files passed**, 135.83 s. Svelte 0 ошибок/предупреждений, server/web build успешен, browser regression 15/15, diff check чистый. UX-02 завершён локально; rollout не выполнялся.

## Выпуск 2026-09-14

По указанию пользователя «Обновляй телекодекс» UX-01 и UX-02 установлены в работающий сервис. Выпуск `20260914T034000Z-ux01-ux02`; сервис перезапущен, healthz/readyz возвращают `ok`, повторных запусков процесса нет. Исходники сверены с SHA256 manifest, dist и dist-web совпадают с проверенной сборкой. Перед выпуском повторно прошли build, Svelte check (0 ошибок/предупреждений) и 78 тестов в 6 файлах.

Резервная копия исходников, сборки, конфигурации и runtime-данных: `/var/backups/telecodex/20260914T034000Z-ux01-ux02`. SQLite backup проверен через quick_check. Preflight до и после выпуска: safeToRestart=true, guardian=ready; существующие счётчики доставки не изменились. Восстановление из копии не проводилось.

Карточки подключаются явно командой `/task` в выбранном рабочем топике. Массового подключения и тестовых отправок не было; живой пилот карточки и проверка на реальном телефоне остаются невыполненными. Commit/push не выполнялись. Эта запись обновляет прежний статус «не развёрнуто» в результатах локальной реализации.
