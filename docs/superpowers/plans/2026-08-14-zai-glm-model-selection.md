# Z.AI GLM Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить в TeleCodex выбор OpenAI или Z.AI GLM при создании нового треда, сохранив OpenAI по умолчанию и не меняя провайдера существующих тредов.

**Architecture:** Один общий Codex App Server содержит определения обоих провайдеров. TeleCodex хранит выбранную пару `modelProvider + model` и передаёт её только в `thread/start`; `turn/start` и обычный `thread/resume` не меняют провайдера. `/new` и первое сообщение в пустом Telegram-контексте показывают model picker до создания Codex-треда.

**Tech Stack:** TypeScript 5.9, Node.js 20+, grammY, Codex App Server JSON-RPC, Vitest, better-sqlite3, systemd user services.

---

## Границы и решения

- OpenAI остаётся default provider.
- Начальный список для production: `openai/gpt-5.6-sol` и `zai/glm-5.3`.
- Провайдер нельзя менять внутри активного треда. `/model` выбирает модель следующего нового треда.
- `thread/resume` вызывается без `model` и `modelProvider`, чтобы App Server восстановил записанный провайдер.
- Для старых `contexts.json` без `modelProvider` используется совместимый fallback `openai`; ответ `thread/resume` остаётся источником истины.
- Первый интерактивный prompt сохраняется в `jobs.json` со статусом `awaiting-model`. После выбора модель создаёт тред, а сохранённый prompt выполняется автоматически.
- Входные фото перед ожиданием переносятся из временного файла в `.telecodex/inbox/<turnId>`, чтобы выбор модели и перезапуск TeleCodex не оставляли битую ссылку.
- Для GLM в первой версии `supportsImages=false` и `webSearch="disabled"`. Документы остаются доступны через локальные Codex tools.
- Фоновые recovery jobs старого формата, у которых нет `modelChoiceId`, продолжаются с OpenAI default.
- API-ключ Z.AI не хранится в репозитории, `.env.example` или `config.toml`.
- Рабочее дерево TeleCodex уже содержит несвязанные изменения. При реализации сначала использовать `using-git-worktrees`; коммиты создавать только после отдельной команды пользователя.

## Карта файлов

**Создать:**

- `src/codex-model.ts` - тип модели, JSON parser, default resolution, capability flags.
- `src/model-picker.ts` - чистые callback/capability helpers без grammY state.
- `test/codex-model.test.ts` - unit-тесты конфигурации моделей.
- `test/model-picker.test.ts` - тесты model picker callback и input capabilities.

**Изменить:**

- `.env.example` - пример списка OpenAI и GLM без секретов.
- `src/config.ts` - загрузка `CODEX_MODEL_CHOICES_JSON` и `CODEX_DEFAULT_MODEL_CHOICE`.
- `src/codex-state.ts` - чтение `model_provider` из SQLite.
- `src/codex-session.ts` - раздельное состояние active/next model choice и `modelProvider` в `thread/start`.
- `src/session-registry.ts` - сохранение provider и next choice в `contexts.json`.
- `src/telegram-job-store.ts` - состояние `awaiting-model`, selection token и cleanup metadata.
- `src/bot.ts` - picker для `/new`, первого prompt и `/model`; provider-aware auth; staging фото.
- `src/index.ts` - безопасный startup log с default model choice без ключей.
- `test/config.test.ts` - env parsing и ошибки конфигурации.
- `test/codex-state.test.ts` - mapping `model_provider`.
- `test/codex-session.test.ts` - start/resume/turn provider semantics.
- `test/codex-session-app-server.test.ts` - JSON-RPC payloads.
- `test/session-registry.test.ts` - backward-compatible metadata.
- `test/telegram-job-store.test.ts` - ожидание выбора и recovery.
- `test/attachments.test.ts` - долговечность inbox-файлов до завершения job.

**Не менять:**

- `src/app-server-turn-manager.ts` - `turn/start` не поддерживает `modelProvider`; текущий resume без override правильный.
- Codex SQLite schema - колонка `threads.model_provider` уже существует.
- Старые записи в `.telecodex/contexts.json` - миграция выполняется при чтении, без массовой перезаписи.

### Task 1: Тип и конфигурация model choice

**Files:**

- Create: `src/codex-model.ts`
- Create: `test/codex-model.test.ts`
- Modify: `src/config.ts:24-81`
- Modify: `test/config.test.ts:12-38,61-170,436-552`
- Modify: `.env.example:18-25`

- [ ] **Step 1: Написать failing unit-тесты parser-а**

Проверить:

```ts
expect(parseModelChoicesJson(JSON.stringify([
  {
    id: "openai-default",
    label: "OpenAI GPT-5.6 Sol",
    provider: "openai",
    model: "gpt-5.6-sol",
    supportsImages: true,
  },
  {
    id: "glm-53",
    label: "Z.AI GLM-5.3",
    provider: "zai",
    model: "glm-5.3",
    supportsImages: false,
    webSearch: "disabled",
  },
]))).toHaveLength(2);

expect(() => parseModelChoicesJson("{")).toThrow("Invalid CODEX_MODEL_CHOICES_JSON");
expect(() => parseModelChoicesJson(JSON.stringify([
  { id: "same", label: "A", provider: "openai", model: "a" },
  { id: "same", label: "B", provider: "zai", model: "b" },
]))).toThrow("Duplicate model choice id: same");
```

Также проверить пустые `label`, `provider`, `model`, id вне `/^[a-z0-9][a-z0-9_-]{0,31}$/`, неподдерживаемое значение `webSearch` и default id, которого нет в списке.

- [ ] **Step 2: Запустить тест и подтвердить RED**

Run:

```bash
npx vitest run test/codex-model.test.ts
```

Expected: FAIL, потому что `src/codex-model.ts` ещё не существует.

- [ ] **Step 3: Создать типы и parser**

Реализовать публичный контракт:

```ts
export type CodexWebSearchMode = "disabled" | "cached" | "live";

export interface CodexModelChoice {
  id: string;
  label: string;
  provider: string;
  model: string;
  supportsImages: boolean;
  webSearch?: CodexWebSearchMode;
}

export function parseModelChoicesJson(raw: string | undefined): CodexModelChoice[];

export function resolveDefaultModelChoice(
  choices: CodexModelChoice[],
  defaultChoiceId: string | undefined,
  legacyModel: string | undefined,
): CodexModelChoice | undefined;

export function findModelChoice(
  choices: CodexModelChoice[],
  choiceId: string | undefined,
): CodexModelChoice | undefined;
```

Правила parser-а:

```ts
const MODEL_CHOICE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const WEB_SEARCH_MODES = new Set(["disabled", "cached", "live"]);

// supportsImages по умолчанию true только для provider === "openai".
// Неизвестные поля игнорируются, неизвестные значения capability отклоняются.
// Пустой или отсутствующий env возвращает [], сохраняя старое поведение.
```

- [ ] **Step 4: Подключить parser к config**

Добавить в `TeleCodexConfig`:

```ts
modelChoices: CodexModelChoice[];
defaultModelChoiceId?: string;
```

В `loadConfig()`:

```ts
const modelChoices = parseModelChoicesJson(
  optionalString(process.env.CODEX_MODEL_CHOICES_JSON),
);
const defaultModelChoiceId = parseDefaultModelChoiceId(
  optionalString(process.env.CODEX_DEFAULT_MODEL_CHOICE),
  modelChoices,
);
```

Если список не задан, `defaultModelChoiceId` должен быть `undefined`; дальнейший код использует legacy `CODEX_MODEL` и OpenAI cache.

- [ ] **Step 5: Добавить production-safe пример env**

```dotenv
# Optional model/provider choices shown by /new and /model. No API keys here.
CODEX_MODEL_CHOICES_JSON=[{"id":"openai-default","label":"OpenAI GPT-5.6 Sol","provider":"openai","model":"gpt-5.6-sol","supportsImages":true},{"id":"glm-53","label":"Z.AI GLM-5.3","provider":"zai","model":"glm-5.3","supportsImages":false,"webSearch":"disabled"}]
CODEX_DEFAULT_MODEL_CHOICE=openai-default
```

- [ ] **Step 6: Запустить focused tests**

```bash
npx vitest run test/codex-model.test.ts test/config.test.ts
```

Expected: PASS.

### Task 2: Provider в Codex state и session lifecycle

**Files:**

- Modify: `src/codex-state.ts:4-35,77-161,204-232`
- Modify: `test/codex-state.test.ts`
- Modify: `src/codex-session.ts:28-157,182-299,344-350`
- Modify: `test/codex-session.test.ts`
- Modify: `test/codex-session-app-server.test.ts`

- [ ] **Step 1: Написать failing SQLite mapping test**

Добавить `model_provider: "zai"` в fixture и ожидать:

```ts
expect(state.getThread("thread-glm")).toEqual(expect.objectContaining({
  model: "glm-5.3",
  modelProvider: "zai",
}));
```

- [ ] **Step 2: Написать failing session tests**

Покрыть четыре инварианта:

```ts
await service.newThread("/workspace", "glm-53");
expect(client.request).toHaveBeenCalledWith("thread/start", expect.objectContaining({
  model: "glm-5.3",
  modelProvider: "zai",
  config: expect.objectContaining({ web_search: "disabled" }),
}));

await service.resumeThread("old-openai-thread");
expect(client.request).toHaveBeenCalledWith("thread/resume", {
  threadId: "old-openai-thread",
});

service.setModelChoice("glm-53");
expect(service.getInfo()).toEqual(expect.objectContaining({
  modelProvider: "openai",
  nextModelProvider: "zai",
  nextModel: "glm-5.3",
}));

await service.prompt("continue", callbacks);
expect(turnManager.runTurn).toHaveBeenCalledWith(
  expect.objectContaining({ model: "gpt-5.6-sol" }),
);
```

Последняя проверка доказывает, что `/model` не переключает активный тред.

- [ ] **Step 3: Запустить tests и подтвердить RED**

```bash
npx vitest run test/codex-state.test.ts test/codex-session.test.ts test/codex-session-app-server.test.ts
```

Expected: FAIL на отсутствующем `modelProvider` и методе `setModelChoice`.

- [ ] **Step 4: Добавить provider в SQLite record**

Расширить record и row:

```ts
export interface CodexThreadRecord {
  id: string;
  title: string;
  cwd: string;
  model: string | null;
  modelProvider: string | null;
  createdAt: Date;
  updatedAt: Date;
  firstUserMessage: string;
}
```

Во всех `SELECT ... FROM threads` добавить `model_provider`; в `mapThreadRow` использовать строку или `null`.

- [ ] **Step 5: Разделить active и next model state**

В `CodexSessionInfo` добавить:

```ts
modelProvider?: string;
modelChoiceId?: string;
modelLabel?: string;
supportsImages?: boolean;
nextModel?: string;
nextModelProvider?: string;
nextModelChoiceId?: string;
nextModelLabel?: string;
nextSupportsImages?: boolean;
```

В `CreateOptions` добавить `modelProvider?: string` и `modelChoiceId?: string`.

В `CodexSessionService` хранить:

```ts
private activeModelChoice: CodexModelChoice | null = null;
private selectedModelChoice: CodexModelChoice | undefined;
```

`listModelChoices()` возвращает configured choices, а при пустом env преобразует legacy `listModels()` в choices с provider `openai` и стабильным id, равным model slug. `getModelChoice(choiceId)` ищет только в этом allowlist. `setModelChoice(choiceId)` меняет только `selectedModelChoice`. `applyThreadResponse` собирает active choice из `response.model`, `response.modelProvider` и configured choice, если пара совпадает.

- [ ] **Step 6: Передавать provider только при старте**

Сигнатура:

```ts
async newThread(workspace?: string, modelChoiceId?: string): Promise<CodexSessionInfo>
```

Payload:

```ts
const choice = this.resolveSelectedModelChoice(modelChoiceId);
const threadConfig = {
  ...(this.currentReasoningEffort
    ? { model_reasoning_effort: this.currentReasoningEffort }
    : {}),
  ...(choice?.webSearch ? { web_search: choice.webSearch } : {}),
};

await client.request("thread/start", {
  cwd: effectiveWorkspace,
  model: choice?.model ?? this.currentModel,
  modelProvider: choice?.provider ?? "openai",
  approvalPolicy: this.currentLaunchProfile.approvalPolicy,
  sandbox: this.currentLaunchProfile.sandboxMode,
  serviceName: "telecodex",
  ...(Object.keys(threadConfig).length ? { config: threadConfig } : {}),
});
```

`resumeThread` оставить строго с `{ threadId }`. `prompt` передаёт active model в turn manager, но не provider.

- [ ] **Step 7: Запустить focused tests**

```bash
npx vitest run test/codex-state.test.ts test/codex-session.test.ts test/codex-session-app-server.test.ts
```

Expected: PASS, включая отсутствие `modelProvider` в `turn/start` и `thread/resume`.

### Task 3: Backward-compatible metadata

**Files:**

- Modify: `src/session-registry.ts:14-23,44-70,83-98,125-155,218-235`
- Modify: `test/session-registry.test.ts`

- [ ] **Step 1: Написать failing metadata tests**

Покрыть:

```ts
expect(registry.listContexts()[0]).toEqual(expect.objectContaining({
  model: "glm-5.3",
  modelProvider: "zai",
  modelChoiceId: "glm-53",
}));
```

И старую запись:

```json
{
  "contextKey": "123:42",
  "threadId": "old-thread",
  "workspace": "/workspace",
  "model": "gpt-5.6-sol",
  "updatedAt": 1
}
```

Ожидание: registry загружается без ошибки, а `CodexSessionService.create` получает `modelProvider: "openai"` только как legacy hint; `thread/resume` всё равно не получает override.

- [ ] **Step 2: Запустить test и подтвердить RED**

```bash
npx vitest run test/session-registry.test.ts
```

Expected: FAIL на отсутствующих metadata fields.

- [ ] **Step 3: Расширить ContextMetadata**

```ts
export interface ContextMetadata {
  contextKey: TelegramContextKey;
  threadId: string | null;
  workspace: string;
  model?: string;
  modelProvider?: string;
  modelChoiceId?: string;
  reasoningEffort?: string;
  launchProfileId?: string;
  topicName?: string;
  updatedAt: number;
}
```

`updateMetadata` сохраняет active provider/model и `nextModelChoiceId ?? modelChoiceId`. `bindThread` использует `thread.modelProvider ?? "openai"`.

- [ ] **Step 4: Не переписывать старые файлы при чтении**

В `getOrCreate` вычислять hints локально:

```ts
const modelProvider = meta?.modelProvider ?? (meta?.model ? "openai" : undefined);
```

Не вызывать `persistMetadata()` из `loadPersistedMetadata()`. Файл обновится только после нормального изменения session state.

- [ ] **Step 5: Запустить focused test**

```bash
npx vitest run test/session-registry.test.ts
```

Expected: PASS.

### Task 4: Durable ожидание model picker для первого prompt

**Files:**

- Modify: `src/telegram-job-store.ts:8-83`
- Modify: `test/telegram-job-store.test.ts`
- Modify: `src/attachments.ts:5-104`
- Modify: `test/attachments.test.ts`
- Modify: `src/bot.ts:293-375,443-462,894-955,2068-2098,3064-3339`
- Create: `src/model-picker.ts`
- Create: `test/model-picker.test.ts`

- [ ] **Step 1: Написать failing job-store tests**

Новый state и контракт:

```ts
const waiting = store.create({
  contextKey: "-100:42",
  chatId: -100,
  messageThreadId: 42,
  threadId: null,
  input: "inspect this",
});

const awaiting = store.awaitModelSelection(waiting.id);
expect(awaiting.state).toBe("awaiting-model");
expect(awaiting.selectionToken).toMatch(/^[a-f0-9]{12}$/);
expect(store.listRecoverable()).toEqual([]);
expect(store.listAwaitingModel()).toHaveLength(1);

const released = store.selectModel(
  awaiting.selectionToken!,
  "-100:42",
  "glm-53",
  "thread-glm",
);
expect(released).toEqual(expect.objectContaining({
  state: "waiting",
  modelChoiceId: "glm-53",
  threadId: "thread-glm",
}));
```

Проверить, что token нельзя применить из другого `contextKey` и нельзя использовать повторно.

- [ ] **Step 2: Запустить test и подтвердить RED**

```bash
npx vitest run test/telegram-job-store.test.ts
```

Expected: FAIL на отсутствующих методах и state.

- [ ] **Step 3: Расширить PersistentTelegramJob**

```ts
export type TelegramJobState =
  | "awaiting-model"
  | "waiting"
  | "active"
  | "delivering"
  | "completed"
  | "failed"
  | "aborted";

export interface PersistentTelegramJob {
  // existing fields
  selectionToken?: string;
  modelChoiceId?: string;
  cleanupInbox?: { workspace: string; turnId: string };
}
```

Добавить методы `awaitModelSelection`, `findAwaitingModel`, `listAwaitingModel`, `selectModel`. `findAwaitingModel` и `selectModel` принимают `contextKey` и отклоняют token из другого Telegram-контекста. `listRecoverable` не включает `awaiting-model`.

- [ ] **Step 4: Перенести lifecycle inbox cleanup в job lifecycle**

`handleUserPrompt` принимает typed options и сохраняет cleanup metadata в job:

```ts
interface PromptDispatchOptions {
  cleanupInbox?: { workspace: string; turnId: string };
  requireModelSelection?: boolean;
}

type HandleUserPrompt = (
  ctx: Context,
  contextKey: TelegramContextKey,
  chatId: TelegramChatId,
  session: CodexSessionService,
  userInput: CodexPromptInput,
  recoveredJob?: PersistentTelegramJob,
  options?: PromptDispatchOptions,
) => Promise<void>;
```

`cleanupInbox` вызывается после `completed`, `failed` или `aborted`, но не после перехода в `awaiting-model`.

Для photo handler заменить прямой `imagePaths: [tempFilePath]` на `stageFile`:

```ts
const turnId = randomUUID().slice(0, 12);
const imageBuffer = await readFile(tempFilePath);
const stagedImage = await stageFile(imageBuffer, "telegram-photo.jpg", "image/jpeg", {
  workspace: session.getCurrentWorkspace(),
  turnId,
  maxFileSize: config.maxFileSize,
});

await handleUserPrompt(
  ctx,
  contextKey,
  chatId,
  session,
  { text: caption, imagePaths: [stagedImage.localPath] },
  undefined,
  { cleanupInbox: { workspace: session.getCurrentWorkspace(), turnId } },
);
```

Document handler передаёт существующие `workspace` и `turnId` тем же способом и удаляет свой unconditional `cleanupInbox`.

- [ ] **Step 5: Создать helper model picker**

В `src/model-picker.ts` реализовать callback format и проверку input capabilities:

```ts
export function promptModelCallback(token: string, choiceId: string): string {
  return `jobmodel:${token}:${choiceId}`;
}

export function parsePromptModelCallback(value: string): {
  token: string;
  choiceId: string;
} | null;
```

Максимальная длина при token 12 и choice id 32 равна 54 bytes, меньше лимита Telegram 64 bytes.

- [ ] **Step 6: Написать tests callback validation и image capability**

```ts
expect(promptModelCallback("0123456789ab", "glm-53")).toBe(
  "jobmodel:0123456789ab:glm-53",
);
expect(parsePromptModelCallback("jobmodel:bad:GLM 5.3")).toBeNull();
expect(canUseChoiceForInput(glmChoice, { imagePaths: ["/tmp/a.jpg"] })).toBe(false);
expect(canUseChoiceForInput(openAiChoice, { imagePaths: ["/tmp/a.jpg"] })).toBe(true);
```

- [ ] **Step 7: Остановить автоматический thread start в message handlers**

Для `ticket_start`, text, voice, photo и document использовать:

```ts
const contextSession = await getContextSession(ctx, { deferThreadStart: true });
```

В `handleUserPrompt`, до постановки turn в `promptTails`:

```ts
if (!session.hasActiveThread() && !recoveredJob?.modelChoiceId) {
  const awaiting = jobStore.awaitModelSelection(persistentJob.id);
  await sendPromptModelPicker(awaiting, session.listModelChoices());
  return;
}
```

`sendPromptModelPicker` отправляет сообщение через `bot.api.sendMessage(job.chatId, ...)` с `message_thread_id: job.messageThreadId`, а не через исходный `ctx`. Это обязательно для MR review, где prompt запускается в новом topic.

- [ ] **Step 8: Добавить callback продолжения prompt**

Handler `jobmodel:<token>:<choiceId>`:

1. Находит job по token и текущему context key.
2. Проверяет choice через `session.getModelChoice(choiceId)`, то есть по configured или legacy OpenAI allowlist.
3. Если input содержит image и `supportsImages=false`, оставляет job в `awaiting-model` и просит выбрать OpenAI.
4. Вызывает `session.setModelChoice(choiceId)` и `session.newThread(undefined, choiceId)`.
5. Обновляет metadata.
6. Переводит job в `waiting` через `selectModel`.
7. Вызывает `handleUserPrompt(..., recoveredJob, { requireModelSelection: false })`.

- [ ] **Step 9: Восстанавливать picker после рестарта**

В `recoverPendingJobs` сначала пройти `jobStore.listAwaitingModel()` и заново отправить picker в правильный topic. Такие jobs нельзя передавать в обычный turn recovery до выбора модели.

- [ ] **Step 10: Запустить focused tests**

```bash
npx vitest run test/telegram-job-store.test.ts test/attachments.test.ts test/model-picker.test.ts
```

Expected: PASS.

### Task 5: Picker для `/new` и provider-aware `/model`

**Files:**

- Modify: `src/bot.ts:319-375,1255-1304,2383-2426,2460-2472,2739-2795,2974-3029,3521-3551`
- Modify: `src/bot-ui.ts:14-36,83-109`
- Modify: `test/bot-ui.test.ts`

- [ ] **Step 1: Написать failing UI tests**

Проверить вывод active и next provider/model:

```ts
expect(renderModelSummaryPlain({
  model: "gpt-5.6-sol",
  modelProvider: "openai",
  nextModel: "glm-5.3",
  nextModelProvider: "zai",
})).toContain("Next model: zai/glm-5.3");
```

Welcome text должен говорить: `Send a message, then choose a model to start a thread.`

- [ ] **Step 2: Запустить test и подтвердить RED**

```bash
npx vitest run test/bot-ui.test.ts test/model-picker.test.ts
```

Expected: FAIL на отсутствующем render helper.

- [ ] **Step 3: Добавить pending `/new` intent**

```ts
interface PendingNewThread {
  workspace: string;
}

const pendingNewThreads = new Map<TelegramContextKey, PendingNewThread>();
```

Если workspace один, `/new` сразу сохраняет intent и показывает model picker. Если workspace несколько, `ws_<index>` сохраняет выбранный workspace и показывает picker вместо вызова `session.newThread(workspace)`.

- [ ] **Step 4: Добавить `startmodel:<choiceId>` callback**

Callback:

```ts
const intent = pendingNewThreads.get(contextKey);
const choice = findModelChoice(config.modelChoices, choiceId);
if (!intent || !choice) {
  await ctx.answerCallbackQuery({ text: "Expired, run /new again" });
  return;
}
const info = await session.newThread(intent.workspace, choice.id);
pendingNewThreads.delete(contextKey);
updateSessionMetadata(contextKey, session);
```

На кнопке default choice показывать `✓`. Создание треда происходит только после нажатия.

- [ ] **Step 5: Переделать `/model` на configured choices**

`session.listModelChoices()` возвращает `config.modelChoices`. Если env не задан, он преобразует legacy `listModels()` в OpenAI choices, сохраняя текущее поведение. `/new`, `/model` и pending prompt picker используют только этот метод, а не `config.modelChoices` напрямую.

Callback должен вызывать:

```ts
const choice = session.setModelChoice(choiceId);
updateSessionMetadata(contextKey, session);
```

Ответ:

```text
Next model set to Z.AI GLM-5.3 (zai/glm-5.3).
The active thread was not changed.
```

- [ ] **Step 6: Показывать provider в `/session` и списках**

Формат active model: `openai/gpt-5.6-sol` или `zai/glm-5.3`. Если selected choice отличается, добавить отдельную строку `Next model`.

- [ ] **Step 7: Сделать auth check provider-aware**

В `executeUserPrompt` перенести auth check после создания/восстановления active thread и проверять OpenAI login только для active provider `openai`:

```ts
if ((session.getInfo().modelProvider ?? "openai") === "openai") {
  const authStatus = await checkAuthStatus(config.codexApiKey);
  if (!authStatus.authenticated) {
    // existing OpenAI warning path
    return;
  }
}
```

Для `zai` не читать и не логировать ключ. Ошибку provider auth возвращает App Server.

- [ ] **Step 8: Запустить focused tests**

```bash
npx vitest run test/bot-ui.test.ts test/model-picker.test.ts test/codex-session.test.ts
```

Expected: PASS.

### Task 6: Startup diagnostics без секретов

**Files:**

- Modify: `src/index.ts:16-41`
- Modify: `test/config.test.ts`

- [ ] **Step 1: Добавить безопасный startup summary**

После загрузки config вывести только ids и provider/model:

```ts
console.log(
  `Model choices: ${config.modelChoices
    .map((choice) => `${choice.id}=${choice.provider}/${choice.model}`)
    .join(", ")}`,
);
console.log(`Default model choice: ${config.defaultModelChoiceId ?? "legacy-openai"}`);
```

Не выводить env values, заголовки авторизации или путь к secret command output.

- [ ] **Step 2: Проверить отсутствие секретов в diff**

```bash
git diff -- .env.example src/config.ts src/index.ts | rg -n "sk-|ZAI_API_KEY=.+|Authorization: Bearer"
```

Expected: no output, exit code 1 from `rg` is acceptable.

### Task 7: Полная локальная проверка

**Files:** Все изменённые source/test files.

- [ ] **Step 1: Запустить полный test suite**

```bash
npm test
```

Expected: все Vitest tests PASS, 0 failed.

- [ ] **Step 2: Собрать TypeScript**

```bash
npm run build
```

Expected: `tsc` завершился с exit code 0.

- [ ] **Step 3: Проверить provider boundary статически**

```bash
rg -n "modelProvider" src test
rg -n -U 'turn/start[\s\S]{0,300}modelProvider' src
```

Expected: первый поиск показывает config, session, registry и tests; второй не находит `modelProvider` внутри payload `turn/start`.

- [ ] **Step 4: Проверить размер Telegram callbacks**

```bash
npx vitest run test/model-picker.test.ts
```

Expected: тест проверяет `Buffer.byteLength(callbackData, "utf8") <= 64` для самого длинного допустимого choice id.

- [ ] **Step 5: Просмотреть diff на несвязанные изменения**

Работать только в отдельном worktree. Проверить:

```bash
git status --short
git diff --stat
git diff --check
```

Expected: только файлы из карты плана; `git diff --check` без ошибок.

### Task 8: Настройка Z.AI в Codex App Server

**Files:**

- Modify outside repo after separate approval: `~/.codex/config.toml`
- Create outside repo after separate approval: root-only Z.AI key file
- Modify runtime-only after separate approval: `/root/Documents/Codex/2026-08-07-hermes/telecodex/.env`

- [ ] **Step 1: Дождаться отдельного разрешения на host configuration**

Изменение `~/.codex/config.toml`, установка ключа и restart App Server влияют на все клиенты общего socket. Не выполнять этот task автоматически вслед за code changes.

- [ ] **Step 2: Прочитать текущий config и сохранить существующие настройки**

```bash
sed -n '1,240p' ~/.codex/config.toml
```

Не заменять файл целиком. Добавить provider table поверх существующей конфигурации.

- [ ] **Step 3: Подключить Z.AI Responses provider**

Предпочтительный вариант с command-backed token:

```toml
[model_providers.zai]
name = "Z.AI"
base_url = "https://api.z.ai/api/v1"
wire_api = "responses"
supports_standalone_web_search = false

[model_providers.zai.auth]
command = "/usr/bin/cat"
args = ["/root/.config/telecodex/zai-api-key"]
refresh_interval_ms = 0
```

Secret file должен принадлежать root и иметь mode `0600`. Не сочетать `[model_providers.zai.auth]` с `env_key`.

- [ ] **Step 4: Включить choices в runtime `.env`**

Добавить те же `CODEX_MODEL_CHOICES_JSON` и `CODEX_DEFAULT_MODEL_CHOICE=openai-default`, что указаны в `.env.example`. Не добавлять туда `ZAI_API_KEY`: ключ читает App Server через command-backed auth.

- [ ] **Step 5: Проверить config без отправки prompt**

В отдельном временном `CODEX_HOME` или после согласованного restart вызвать `thread/start` с:

```json
{
  "model": "glm-5.3",
  "modelProvider": "zai",
  "cwd": "/tmp",
  "approvalPolicy": "never",
  "sandbox": "read-only",
  "serviceName": "telecodex-provider-probe"
}
```

Expected: response содержит `modelProvider: "zai"`. Не запускать `turn/start` на рабочем репозитории.

### Task 9: Rollout и live acceptance

**Files/Services:**

- Build output: `dist/`
- Runtime: `telecodex.service`
- Shared runtime: Codex App Server control socket

- [ ] **Step 1: Проверить отсутствие активных turn перед restart**

Использовать status board и process inspection. Не перезапускать общий App Server во время выполняющегося prompt.

- [ ] **Step 2: Собрать production bundle**

```bash
npm run build
```

Expected: exit code 0.

- [ ] **Step 3: Перезапустить App Server и TeleCodex по отдельности**

```bash
codex app-server daemon restart
systemctl --user restart telecodex.service
```

Если user bus недоступен из текущей shell, выполнить restart из той login session, где запущен user service. Не подменять это kill по широкому process pattern.

- [ ] **Step 4: Проверить runtime**

```bash
pgrep -af 'codex app-server|telecodex/dist/index.js'
ss -xl | rg 'app-server-control.sock'
journalctl --user -u telecodex.service -n 100 --no-pager
```

Expected: оба процесса живы, socket слушает, в журнале нет startup/auth/config errors.

- [ ] **Step 5: Проверить старый OpenAI-тред**

Открыть существующий Telegram topic, выполнить `/session`, отправить короткий read-only prompt.

Expected:

- provider/model показывает `openai/...`;
- `thread/resume` не меняет provider;
- ответ приходит в тот же topic.

- [ ] **Step 6: Проверить новый OpenAI-тред**

Вызвать `/new`, выбрать workspace, выбрать OpenAI.

Expected: новый thread создаётся только после выбора; `/session` показывает `openai/gpt-5.6-sol`.

- [ ] **Step 7: Проверить новый GLM-тред**

Вызвать `/new`, выбрать Z.AI GLM-5.3, затем в disposable workspace выполнить:

1. обычный текстовый prompt;
2. read-only tool call `pwd` и `rg --files`;
3. создание небольшого файла через `apply_patch`;
4. второй turn в том же topic;
5. restart TeleCodex и продолжение того же GLM-треда.

Expected: streaming, tool calls, file edit и resume проходят через `zai/glm-5.3`; OpenAI-тред из предыдущего шага остаётся OpenAI.

- [ ] **Step 8: Проверить первый prompt до thread creation**

Создать новый пустой Telegram topic и отправить текст без `/new`.

Expected: бот показывает picker, не создаёт thread до нажатия, а после выбора автоматически выполняет сохранённый текст ровно один раз.

- [ ] **Step 9: Проверить media guard**

Отправить фото первым сообщением, выбрать GLM.

Expected: бот сообщает, что GLM choice не поддерживает image input, сохраняет ожидающий job и позволяет выбрать OpenAI. После выбора OpenAI фото обрабатывается, затем inbox очищается.

- [ ] **Step 10: Зафиксировать непроверенные границы**

Если не были проверены MCP, web search или четыре параллельных GLM-треда, перечислить их как непроверенные. Успешный unit test или restart не называть production acceptance без Telegram smoke-test.

## Acceptance checklist

- [ ] OpenAI является default choice.
- [ ] Все существующие треды сохраняют записанный provider.
- [ ] `/new` всегда спрашивает модель до `thread/start`.
- [ ] Первый prompt в пустом topic сохраняется и выполняется после выбора.
- [ ] `/model` меняет только next choice.
- [ ] `thread/start` содержит `modelProvider`; `thread/resume` и `turn/start` его не содержат.
- [ ] GLM получает `web_search=disabled` и не принимает image input в первой версии.
- [ ] Z.AI key отсутствует в git diff, environment examples и logs.
- [ ] Full Vitest suite и TypeScript build проходят.
- [ ] Старый OpenAI, новый OpenAI и новый GLM проверены в Telegram.
