# TeleCodex UX-04 Implementation Plan

> Execute with `subagent-driven-development` and TDD. User authorized continuing after updating main and the local checkout on 2026-09-14.

**Goal:** Найти задачу за пределами первой страницы и вернуться к её подтверждённому контексту без потери фильтров и места в списке.

**Architecture:** Объединить известные задачи и host sessions до классификации, поиска и пагинации. Task ID и Codex thread ID остаются отдельными идентификаторами. Сохранять только параметры просмотра и scroll anchor; namespace выдаётся сервером из проверенного пользователя и настроенного чата.

**Tech Stack:** TypeScript, existing SQLite task metadata, Svelte, Carbon, Vitest, Playwright.

## Baseline

`fork/main` и основной checkout на `main`: `d12bc881456f073427eac5c44e2dd64ac40fb111`, включая UX-01–UX-03. Проверки перед интеграцией: 3395 tests / 201 files, server/web build, Svelte check. Рабочая ветка UX-04: `topic-interaction-ux04` в существующем изолированном worktree. Обновление main не было новым выпуском dist или перезапуском.

## Контракт

- Запрос: `view=active|attention|recent|completed`, `search` до 160 символов, `project` как непрозрачный ID проекта, offset/limit. Поиск по названию, ключу тикета и проекту выполняется до пагинации; counts отражают отфильтрованный набор, список проектов доступен независимо от выбранного проекта.
- Представление задач объединяется до пагинации. Завершённая задача не исчезает при отсутствии host session; task-only row не получает выдуманный Codex URL и не вызывает ensureThreadTopic с taskId. Несколько привязок одной сессии не схлопываются произвольно.
- Категории: «В работе», «Нужно моё действие», «Недавние», «Завершённые». Queued показывается отдельно внутри «В работе». Успешный ответ не означает завершения пользовательской задачи.
- Контекст показывает только подтверждённое состояние, дату `lastEventAt` и ссылку на реально доставленный результат. Старый результат при новом прогоне обозначается как последний подтверждённый. Отсутствие результата отличается от текущей незавершённой доставки. Текст ожидаемого вопроса не выдумывается.
- Namespace локального состояния использует проверенный user ID и настроенный forum chat ID. Не использовать initDataUnsafe, raw initData, токены или сохранённое содержимое ответов. Ошибки/повреждение localStorage не ломают список.
- Сохранять вкладку, поиск, проект, видимый anchor и размер загруженного окна с ограничением. При восстановлении отсутствующего anchor выбрать ближайшее доступное место. Все запросы refresh/pagination используют полный набор фильтров.
- Быстрый ввод немедленно инвалидирует старые запросы; отправка поиска с debounce. Старые ответы и отложенное открытие топика не меняют новый набор фильтров.

## Шаги

- [x] RED/GREEN server projection: 201+ строк, поиск по ticket/project за первой страницей, совпадающие названия, task-only completed, неоднозначные привязки, пустой результат, pending при старом результате.
- [x] DTO/controller/HTTP: validate query, metadata before pagination, project facets, authenticated namespace, task actions по точному контексту. GET не пишет в Telegram.
- [x] RED/GREEN UI: поля поиска/проекта, четвёртая категория, подтверждённый контекст, propagation filters во все запросы, stale search/pagination.
- [x] Preferences: bounded schema, namespace isolation, сохранение при scroll/pagehide/navigation, восстановление фильтров и окна/anchor после ответа с проверенным namespace.
- [x] Browser: обычные нажатия и ввод, 200+ задач, быстрый поиск, возврат из Telegram, clear filters, сохранение/изоляция namespace, narrow viewport.
- [x] Spec/quality review, focused + full tests, Svelte/build/browser/diff check; записать реальные результаты и ограничения.

## Проверки

```bash
TMPDIR=/var/tmp npx vitest run test/dashboard-api.test.ts test/dashboard-controller.test.ts test/mini-app-server.test.ts
TMPDIR=/var/tmp npm test -- --maxWorkers=1 --minWorkers=1
npm run check:web
TMPDIR=/var/tmp npm run build
TMPDIR=/var/tmp PLAYWRIGHT_CHROMIUM_EXECUTABLE=/root/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome npm run test:browser
git diff --check
```

UX-04 разрабатывается локально. Живые Telegram-мутации и выпуск сервиса не входят в тестовые сценарии.

## Результаты реализации

- Задачи объединяются с host sessions до поиска, counts и пагинации. Сохраняются отдельные привязки, завершённые задачи и карточки с отключённым обновлением. Текущий запуск/ожидание из CLI не скрывается за старым состоянием карточки; завершение задачи и очередь имеют отдельные правила.
- Поиск по названию, ключу тикета и проекту; проект имеет непрозрачный ID, полный список проектов не исчезает при пустом результате.
- Интерфейс показывает четыре категории, подтверждённое событие и отсутствие/ожидание результата. Ссылка на прошлый результат подписана явно. Для task-only карточки открывается сохранённый Telegram URL.
- Настройки хранят только фильтры, окно до 1000 строк, до 32 соседних IDs и запасной индекс. Namespace выдаётся после проверки Telegram initData. Быстрый ввод инвалидирует старые запросы до debounce; свежий ввод имеет приоритет над сохранёнными фильтрами.
- Ревью исправило потерю окна после сетевой ошибки восстановления и перезапись сохранённой позиции при выходе с ошибкой. Scroll сохраняется после обновления виртуального списка.

Браузер: 23/23 сценария прошли, включая семь новых сценариев UX-04 и прежние проверки 320/1280 px, светлой/тёмной темы, клавиатуры, stale requests и действий. Лог: `/var/tmp/ux04-browser-final2.log`. Svelte check: 0 ошибок, 0 предупреждений.

Финальные проверки: Vitest 3408/3408 тестов в 203/203 файлах (270.36 s), server/web build, Svelte check (0 ошибок и 0 предупреждений), git diff --check прошли. Логи: `/var/tmp/ux04-full-tests-final.log`, `/var/tmp/ux04-build-final.log`, `/var/tmp/ux04-webcheck-final.log`. Повторное frontend/backend ревью не оставило блокирующих замечаний. Отдельного lint script в проекте нет.

Ограничения: браузерные проверки используют подменённые API; реальный Telegram WebView и мобильный возврат не проверены. Текст ожидаемого вопроса в текущей модели отсутствует, поэтому показывается подтверждённый вид ожидания и ссылка в переписку. UX-04 включён в общий commit fdc23ed и установлен 2026-09-14 вместе с UX-05–UX-07. Итог выпуска записан в [completion work packet](2026-09-14-telecodex-completion.md).
