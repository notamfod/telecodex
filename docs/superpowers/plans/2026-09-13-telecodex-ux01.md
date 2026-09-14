# TeleCodex UX-01 Implementation Plan

> Execute with `executing-plans` and TDD. User authorized implementation on 2026-09-13; commit, deployment and live Telegram operations are separate.

**Goal:** Устранить воспроизведённые дефекты списка Mini App и сохранить видимый исход ошибок Inbox.

**Architecture:** Авторитетное обновление заменяет загруженное окно; append используется только при догрузке. Версия запросов изолирует вкладки, а ID верхней видимой строки сохраняет положение прокрутки. Inbox сохраняет ограниченный журнал ошибок рядом с существующим состоянием без повторного создания топиков.

**Tech Stack:** Svelte, TypeScript, Vitest, Playwright, существующий InboxStore.

## Контракт выпуска

- Refresh последовательно загружает окно от offset 0 до прежнего числа загруженных строк страницами не более 100, затем атомарно заменяет список. Ошибка любой страницы сохраняет предыдущий снимок. Новый порядок берётся с сервера. Динамическая offset-пагинация не обещает транзакционный снимок между HTTP-запросами.
- UI сохраняет ID верхней видимой строки и её смещение; если строка исчезла, использует ближайшую сохранившуюся строку. При смене вкладки прокрутка сбрасывается.
- Все list-запросы принадлежат одному поколению; смена вкладки отменяет старые ответы и немедленно запускает новую загрузку. При loadMore polling переносится, не прекращается навсегда.
- После ошибки loadMore автоматическая догрузка остановлена до ручного повтора. Один клик создаёт один запрос, повторная ошибка не запускает цикл.
- Ответ 401 останавливает polling и показывает инструкцию переоткрытия Mini App. Ошибки сети не вызывают постоянную вибрацию фонового обновления.
- Нажатие названия открывает существующий топик через серверную проверку, либо явно предлагает создание. Свайп остаётся дополнительным действием. Завершение свайпа/вертикальной прокрутки не запускает click; кнопки имеют доступное имя и keyboard focus.
- Pending topic open сохраняется по ID задачи; смена вкладки или уничтожение компонента не вызывает поздний переход. Запрос создания не повторяется автоматически.
- Inbox сохраняет источник (ID сообщений), безопасную категорию ошибки и известный исход создания. `/inbox status` показывает последние ошибки, даже если уведомление отправить не удалось. Таймаут не доказывает отсутствие созданного топика.

## Шаги

- [x] Скопировать master plan в isolated worktree; проверить исходные focused tests (44 passed).
- [x] Добавить `@playwright/test`, локальный Vite test server и изолированные fixtures без реальных API. RED: исчезновение строки, retry, click и 401.
- [x] Исправить refresh/loadMore и изоляцию поколений в `web/src/App.svelte`; вынести HTTP-загрузку окна в `web/src/api.ts` и покрыть её unit tests.
- [x] Исправить retry и scroll anchoring в `web/src/SessionList.svelte`; подтвердить смену вкладки во время загрузки и сохранение позиции после refresh.
- [x] Добавить явное открытие в `web/src/ThreadRow.svelte`, стили в `web/src/app.css`; проверить mouse/touch/keyboard и отсутствие открытия после свайпа.
- [x] Добавить типизированную HTTP-ошибку и 401 UI; проверить ручной retry сети и прекращение polling после expiry.
- [x] Добавить RED на Inbox persistence/notice и реализовать ограниченное сохранение ошибок, single/batch и `/inbox status`.
- [x] Провести spec review, затем code review, исправить подтверждённые замечания.
- [x] Выполнить полные Vitest, Svelte check, build и браузерную матрицу; записать результаты.

## Проверки

```bash
TMPDIR=/var/tmp npx vitest run test/mini-app-ui.test.ts test/dashboard-api.test.ts test/dashboard-controller.test.ts test/bot-inbox.test.ts --maxWorkers=1 --minWorkers=1
TMPDIR=/var/tmp npm run test:browser
TMPDIR=/var/tmp npm test -- --maxWorkers=1 --minWorkers=1
npm run check:web
TMPDIR=/var/tmp npm run build
git diff --check
```

Перед первым запуском браузерных тестов: `TMPDIR=/var/tmp npx playwright install chromium`. Для уже установленного совместимого Chromium можно задать `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Test server использует отдельный порт и не переиспользует сервер работающего бота.

Матрица: 390x844, 320x640, desktop; light/dark; очередь/ожидание/ошибка; 200 строк; offline/503/401; stale success/error; один повтор; scroll anchor; double click; неопределённое создание. Реальный телефон и live Telegram rollout в этот локальный выпуск не входят.

## Результаты

Baseline: HEAD `e3e555e`, 44 focused tests passed. Реализовано в `/root/.config/superpowers/worktrees/telecodex/topic-interaction-ux01`, ветка `topic-interaction-ux01`.

- Browser RED: исходные дефекты refresh/retry/tab switch/open/401 воспроизведены до исправления. После добавления доступного имени кнопки уточнены heading locators.
- Browser GREEN: 15/15. Проверены 390x844, 320x640 и 1280x640; светлая/тёмная тема, длинные заголовки, waiting/stalled, список 200 строк, 503/offline/401, ручной повтор без цикла, устаревшая ошибка страницы, pending topic open после A→B→A, keyboard activation, подавление click после вертикального/отменённого pointer gesture, оба варианта scroll anchor.
- API unit tests: окно 230 строк с лимитом страницы 100, отказ второй страницы без частичного результата, статус 401 при не-JSON ответе.
- Inbox focused: 92/92; сохранение и повторное чтение безопасной ошибки, неопределённое создание, известный топик, ошибки карточки/вложений/callback, отказ записи на диск.
- Полный Vitest: **3238/3238 tests, 192/192 files passed**, 265.16 s.
- `npm run check:web`: 0 ошибок, 0 предупреждений.
- `npm run build`: server и web успешно собраны; `git diff --check`: чисто.
- Spec review и code-quality review завершены; три замечания исправлены и повторно проверены.

Ограничения: браузерные проверки используют изолированные API fixtures, реальный телефон и Telegram не проверялись. Native touch scrolling не заменяется синтетическими pointer events. Offset API не обеспечивает транзакционный снимок. История ошибок Inbox ограничена 100 записями, без acknowledgement/reconciliation; авария процесса до catch остаётся UX-05. Существующий общий Telegram auto-retry не менялся, новых повторов создания не добавлено. Commit/push/deploy/restart не выполнялись.

Логи локальной проверки: `/var/tmp/telecodex-ux01-tests.log`, `/var/tmp/telecodex-ux01-browser.log`, `/var/tmp/telecodex-ux01-build.log`.

## Выпуск 2026-09-14

По указанию пользователя «Обновляй телекодекс» UX-01 и UX-02 установлены в работающий сервис. Выпуск `20260914T034000Z-ux01-ux02`; сервис перезапущен, healthz/readyz возвращают `ok`, повторных запусков процесса нет. Исходники сверены с SHA256 manifest, dist и dist-web совпадают с проверенной сборкой. Перед выпуском повторно прошли build, Svelte check (0 ошибок/предупреждений) и 78 тестов в 6 файлах.

Резервная копия исходников, сборки, конфигурации и runtime-данных: `/var/backups/telecodex/20260914T034000Z-ux01-ux02`. SQLite backup проверен через quick_check. Preflight до и после выпуска: safeToRestart=true, guardian=ready; существующие счётчики доставки не изменились. Восстановление из копии не проводилось.

Карточки подключаются явно командой `/task` в выбранном рабочем топике. Массового подключения и тестовых отправок не было; живой пилот карточки и проверка на реальном телефоне остаются невыполненными. Commit/push не выполнялись. Эта запись обновляет прежний статус «не развёрнуто» в результатах локальной реализации.
