# TeleCodex UX-03 Implementation Plan

> Execute with `subagent-driven-development` and TDD. User authorized continuation after committing and pushing UX-01/UX-02 on 2026-09-14.

**Goal:** Дать одинаковые проверяемые действия в карточке топика и Mini App; завершать и продолжать задачу без потери топика, сессии и результата.

**Architecture:** Canonical job projection определяет действия прогона. Task store хранит намерение lifecycle отдельно от подтверждённого состояния Telegram. Закрытие проходит свежую проверку всех заданий контекста; Inbox получает состояние только после подтверждения Telegram. Версии и исходная привязка проверяются при каждом действии.

**Tech Stack:** TypeScript, SQLite, grammY, Svelte, Vitest.

## Проверенный baseline

UX-01/UX-02: `cba310b`, опубликован в `fork/telecodex-improvements`; 3320/3320 tests, build успешен, Svelte 0 ошибок/предупреждений. Рабочая ветка следующего этапа: `topic-interaction-ux03` в прежнем изолированном worktree.

В `ticket_done` обнаружен порядок markResolved → уведомление → closeForumTopic. Ошибка последнего шага оставляет ложное завершение. Текущий snapshot карточки обновляется асинхронно, поэтому не может служить разрешением закрытия.

## Последовательность

- [x] Store/action foundation: совместимая миграция v1, durable lifecycle intent, CAS, общая матрица действий с точными task/job версиями. Файлы: `src/topic-task-store.ts`, `src/topic-task-actions.ts`, `src/topic-task-lifecycle.ts` и соответствующие тесты.
- [x] Canonical guard: проверка всех активных заданий и недоставленных частей точного destination, включая старые задания и targetContext из Inbox. Согласовать закрытие с приёмом нового запроса. Файлы: `src/telegram-task-context-guard.ts`, `src/telegram-job-ledger.ts`, `src/telegram-reliability-runtime.ts`.
- [x] Lifecycle: intent → Telegram → подтверждённое состояние → Inbox reconciliation. При timeout сохранять неопределённость; восстановление проверяет тот же топик. Reopen не создаёт новую сессию, топик или прогон.
- [x] Bot: кнопки карточки используют общий исполнитель; старый неверсионированный ticket_done направляет к свежей /task без мутации. Проверить allowlist, chat/topic, task ID/version и точный job action; устаревшая кнопка обновляет состояние без подмены задания.
- [x] Mini App: передать те же разрешённые действия, обработать stale и двойной клик. Сохранить существующее открытие результата/запроса. DTO и маршруты валидируют envelope до мутации.
- [x] Spec review, quality review, focused + full tests, Svelte/build/browser и diff check. Обновить статус master plan только по реально завершённым пунктам.

## Обязательные регрессии

Миграция v1 сохраняет task/card/thread ID; CAS отвергает старую версию и чужую привязку. Два клика не закрывают дважды. Старое недоставленное задание и queued/running блокируют завершение, даже если последний прогон terminal. Timeout close не означает completed; restart после Telegram до Inbox допускает reconciliation. Отказ прав не даёт успешного уведомления. Продолжение сохраняет topic/thread ID и не вызывает prompt. Ожидание input/approval направляет к запросу; не превращается в неявный abort. Ручное закрытие топика не означает завершения задачи.

## Проверки

```bash
TMPDIR=/var/tmp npx vitest run test/topic-task-store.test.ts test/topic-task-actions.test.ts test/topic-task-lifecycle.test.ts test/telegram-task-context-guard.test.ts --maxWorkers=2 --minWorkers=1
TMPDIR=/var/tmp npm test -- --maxWorkers=2 --minWorkers=1
npm run check:web
TMPDIR=/var/tmp npm run build
git diff --check
```

Живые Telegram-мутации, новый выпуск и restart не входят в локальную проверку UX-03.

## Реализация и проверенные ограничения

- Task store schema v3 мигрирует v1/v2 с сохранением task/card/thread ID. CAS `version` защищает записи, `actionVersion` меняется только при изменении смысла действия. Запись хеша/закрепления не инвалидирует кнопку.
- Закрытие и приём сообщений/повторов используют общую очередь контекста. Проверяются все задания фактического destination, включая старые/quarantine; повреждённые данные не разрешают закрытие. Действия прогона также сериализованы с lifecycle.
- Завершение требует свежего `thread/read` связанной сессии с ограничением ожидания 2 секунды; недоступные данные не считаются отсутствием работы.
- Intent сохраняется до Telegram. Подтверждённый этап позволяет повторить сохранение Inbox после ошибки диска. Состояние в памяти откатывается при неудачной записи, а повтор не закрывает/открывает топик заново.
- После рестарта старый callback обновляет карточку, но не подменяет действие. Хранилище callback handles ограничено 2048 элементами.
- Карточка и Mini App показывают одинаковые действия и ссылки на подтверждённый результат/status anchor. При ожидании ссылка ведёт в существующую переписку: отдельный ID сообщения вопроса не сохраняется, точный переход к вопросу не обещается.
- Неверсионированный старый ticket_done больше не закрывает текущую задачу: пользователь получает указание открыть /task. Это необходимо, чтобы старое нажатие не выбрало новый прогон.
- Spec и quality review завершены; подтверждённые замечания исправлены и покрыты регрессиями. Браузерные сценарии: 16/16. Build успешен, Svelte: 0 ошибок/предупреждений.

Первый общий прогон выявил два теста с неверными допущениями о времени fixture и промежуточной фазе быстрого ответа; исправления проверены 85 runtime tests. Следующий полный прогон прервался native V8 `Check failed: (location_) != nullptr` на Node 22.22.1 без JS assertion failure. Финальный отдельный повтор с одним воркером прошёл: 3395/3395 tests, 201/201 files, 271.89 s.

Живой пилот, публикация UX-03 и перезапуск не выполнялись. UX-03 находится в ветке `topic-interaction-ux03`; работающий выпуск UX-01/UX-02 соответствует `cba310b`, опубликованному в `fork/telecodex-improvements`.

## Итог проверки

`TMPDIR=/var/tmp npm test -- --maxWorkers=1 --minWorkers=1`: **3395/3395 tests, 201/201 files passed**. Финальная browser regression: **16/16 passed** (27.1 s), включая обычное нажатие действия, один запрос и обновление устаревших controls. Финальные server/web build и Svelte check прошли; diff check чистый.

Логи: `/var/tmp/telecodex-ux03-final-serial-tests.log`, `/var/tmp/telecodex-ux03-final-browser.log`, `/var/tmp/telecodex-ux03-final-build.log`, `/var/tmp/telecodex-ux03-final-webcheck.log`.

UX-03 реализован и проверен локально. Следующий пакет программы: UX-04, поиск и возвращение к задаче.

## Интеграция в main

2026-09-14 пользователь поручил обновить main и основной локальный checkout. UX-03 включается вместе с UX-01/UX-02 в `fork/main`; перед интеграцией повторяются полный Vitest и server/web build. Обновление checkout не заменяет отдельный выпуск dist и перезапуск сервиса.
