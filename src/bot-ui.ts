import { escapeHTML } from "./format.js";

export interface DualText {
  html: string;
  plain: string;
}

/**
 * Grouped command reference for /help.
 */
export function renderHelpMessage(): DualText {
  const sections = [
    {
      title: "💬 Сессия",
      commands: [
        ["/new", "Новая сессия в этом топике"],
        ["/task", "Создать или обновить постоянную карточку задачи в этом топике"],
        ["/session", "Текущая сессия"],
        ["/sessions", "Выбрать сессию"],
        ["/projects", "Топики по проектам"],
        ["/jira", "Спринт Jira и фильтры"],
        ["/inbox", "Принимать тикеты в этом топике"],
        ["/mr", "Открытые MR для ревью"],
        ["/done", "Черновик комментария к MR; задачу не завершает"],
        ["/attach", "Привязать сессию Codex к топику"],
        ["/handback", "Передать сессию в Codex CLI"],
        ["/abort", "Остановить текущий запрос"],
        ["/retry", "Повторить последний запрос"],
      ],
    },
    {
      title: "🤖 Модель",
      commands: [
        ["/launch_profiles", "Выбрать профиль запуска"],
        ["/effort", "Выбрать глубину рассуждений"],
      ],
    },
    {
      title: "🔐 Авторизация",
      commands: [
        ["/auth", "Проверить вход в аккаунт"],
        ["/login", "Войти в аккаунт"],
        ["/logout", "Выйти из аккаунта"],
      ],
    },
    {
      title: "ℹ️ Справка",
      commands: [
        ["/start", "Начало работы и статус"],
        ["/help", "Список команд"],
        ["/voice", "Статус распознавания голоса"],
      ],
    },
  ];

  const intro = "Задача - ваша цель; топик - место работы; сессия - диалог с Codex.";
  const htmlLines: string[] = [escapeHTML(intro), ""];
  const plainLines: string[] = [intro, ""];

  for (const section of sections) {
    htmlLines.push(`<b>${escapeHTML(section.title)}</b>`);
    plainLines.push(section.title);
    for (const [cmd, desc] of section.commands) {
      htmlLines.push(`  ${cmd} - ${escapeHTML(desc)}`);
      plainLines.push(`  ${cmd} - ${desc}`);
    }
    htmlLines.push("");
    plainLines.push("");
  }

  const taskHelp = [
    "/task off - Остановить обновления, сохранив карточку",
    "/task title <название> - Задать название топика вручную",
  ];
  htmlLines.push(...taskHelp.map(escapeHTML));
  plainLines.push(...taskHelp);

  while (htmlLines.at(-1) === "") {
    htmlLines.pop();
  }
  while (plainLines.at(-1) === "") {
    plainLines.pop();
  }

  return {
    html: htmlLines.join("\n"),
    plain: plainLines.join("\n"),
  };
}

/**
 * Short /start message for first-time users (no prior interaction in this context).
 */
export function renderWelcomeFirstTime(authWarning?: string): DualText {
  const htmlLines = [
    "<b>👋 TeleCodex готов.</b>",
    "",
    "Опишите задачу сообщением, чтобы начать сессию с Codex.",
    "Можно отправлять голосовые сообщения, фотографии и документы.",
    "",
    "Все команды: /help.",
  ];
  const plainLines = [
    "👋 TeleCodex готов.",
    "",
    "Опишите задачу сообщением, чтобы начать сессию с Codex.",
    "Можно отправлять голосовые сообщения, фотографии и документы.",
    "",
    "Все команды: /help.",
  ];

  if (authWarning) {
    htmlLines.push("", `⚠️ ${escapeHTML(authWarning)}`);
    plainLines.push("", `⚠️ ${authWarning}`);
  }

  return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
}

/**
 * Concise /start message for returning users with session info.
 */
export function renderWelcomeReturning(
  sessionHtml: string,
  sessionPlain: string,
  isTopicSession: boolean,
  authWarning?: string,
): DualText {
  const label = isTopicSession ? "TeleCodex (сессия в топике)" : "TeleCodex";

  const htmlLines = [`<b>👋 ${escapeHTML(label)}</b>`, "", sessionHtml];
  const plainLines = [`👋 ${label}`, "", sessionPlain];

  if (authWarning) {
    htmlLines.push("", `⚠️ ${escapeHTML(authWarning)}`);
    plainLines.push("", `⚠️ ${authWarning}`);
  }

  return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
}

/**
 * Format a session button label for /sessions list.
 * Wider workspace name (12 chars), model tag, short thread snippet.
 */
export function formatSessionLabel(
  options: {
    workspace: string;
    title: string;
    relativeTime: string;
    model?: string;
    isActive: boolean;
  },
): string {
  const prefix = options.isActive ? "✅" : "📁";
  const workspaceName = trimLabel(getWorkspaceShortName(options.workspace), 12) || "(unknown)";
  const title = trimLabel(options.title || "(untitled)", 20) || "(untitled)";
  const time = options.relativeTime;

  let label = `${prefix} ${workspaceName} · ${title} · ${time}`;

  if (options.model) {
    const shortModel = trimLabel(options.model, 10);
    label += ` · ${shortModel}`;
  }

  return label;
}

export function renderModelSummaryPlain(info: {
  model?: string;
  modelProvider?: string;
  nextModel?: string;
  nextModelProvider?: string;
}): string[] {
  return [
    info.model ? `Model: ${info.modelProvider ?? "openai"}/${info.model}` : undefined,
    info.nextModel
      ? `Next model: ${info.nextModelProvider ?? "openai"}/${info.nextModel}`
      : undefined,
  ].filter((line): line is string => Boolean(line));
}

function trimLabel(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function getWorkspaceShortName(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
}
