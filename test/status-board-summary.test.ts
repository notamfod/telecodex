import {
  renderMiniAppLauncher,
  renderStatusBoard,
  type StatusSnapshot,
} from "../src/status-board.js";

const CHAT_ID = -1001234567890;
const NOW = Date.UTC(2026, 7, 13, 6, 41, 0);
const minutes = (count: number): number => count * 60_000;

const emptySnapshot = (overrides: Partial<StatusSnapshot> = {}): StatusSnapshot => ({
  limit: 8,
  telegramActive: 0,
  running: [],
  queued: [],
  recent: [],
  recentThreads: [],
  recentThreadCount: 0,
  codexAvailable: true,
  failedJobs24h: 0,
  now: NOW,
  ...overrides,
});

const task = (overrides: Partial<StatusSnapshot["running"][number]> = {}) => ({
  threadId: "thread-running",
  label: "MIR-6319 оплата",
  workspace: "/srv/projects/mir-back",
  source: "телеграм",
  since: NOW - minutes(4),
  children: [],
  ...overrides,
});

const projectedJob = (index = 0) => {
  const jobId = `job-${index}`;
  return {
    label: `projected-${index}`,
    workspace: "/srv/projects/telecodex",
    projection: {
      schemaVersion: 1, jobId, shortJobId: jobId, expectedVersion: 7,
      phase: "queued", outcome: null, state: "queued", isDone: false,
      anchorKnownDelivered: false, health: "healthy", activity: null,
      queue: { position: index + 1, ageMs: 45_000 }, dispatch: null,
      guardian: { availability: "available", health: "healthy", reasonCode: null,
        threadStatus: null, lastObservedAt: null, ageMs: null, unchangedSince: null,
        staleForMs: null, alertId: null, repairState: null, repairOutcome: null },
      delivery: { total: 1, delivered: 0, pending: 1, sending: 0, uncertain: 0,
        failed: 0, anchorState: "pending", anchorMessageId: null, complete: false },
      timestamps: { acceptedAt: NOW - 45_000, updatedAt: NOW - 5_000,
        terminalAt: null, lastEventAt: NOW - 5_000, lastCodexEventAt: null,
        guardianLastObservedAt: null },
      attention: { kind: "none" }, reasonCodes: [],
      actions: [
        { kind: "details", jobId, expectedVersion: 7 },
        { kind: "abort", jobId, expectedVersion: 7 },
        { kind: "refresh", jobId, expectedVersion: 7 },
      ],
    },
  } as never;
};

describe("renderStatusBoard", () => {
  it("renders the compact summary in operational order", () => {
    const { body } = renderStatusBoard(emptySnapshot({
      running: [task({ waitingOn: "input" })],
      queued: [
        { label: "первый", workspace: "/srv/projects/mir-front", since: NOW },
        { label: "второй", workspace: "/srv/projects/billing", since: NOW },
      ],
      recent: [{
        label: "готово", workspace: "/srv/projects/mir-back", finishedAt: NOW, ok: true,
      }],
      recentThreads: [{
        threadId: "thread-recent", label: "недавняя сессия",
        workspace: "/srv/projects/mir-back", source: "vscode", updatedAt: NOW,
      }],
      recentThreadCount: 9,
      failedJobs24h: 3,
      jobs: [projectedJob()],
    }), CHAT_ID);

    expect(body).toContain(
      "📌 <b>TeleCodex</b> · активны 1 · ждёт 1 · в очереди 2 · ошибок 3",
    );
    expect(body.indexOf("<b>Требуют внимания</b>"))
      .toBeLessThan(body.indexOf("<b>Сейчас</b>"));
    expect(body.indexOf("<b>Сейчас</b>"))
      .toBeLessThan(body.indexOf("<b>Очередь</b>"));
    expect(body.indexOf("<b>Очередь</b>"))
      .toBeLessThan(body.indexOf("<b>Система</b>"));
    expect(body).not.toContain("Последние 24 часа");
    expect(body).not.toContain("Недавно");
    expect(body).not.toContain("Задачи TeleCodex");
    expect(body).not.toContain("health ");
    expect(body).not.toContain("delivery ");
  });

  it("caps active and queued rows with exact hidden counts", () => {
    const running = Array.from({ length: 7 }, (_, index) => task({
      threadId: `thread-${index}`,
      label: `active-${index}`,
    }));
    const queued = Array.from({ length: 5 }, (_, index) => ({
      label: `queued-${index}`,
      workspace: "/srv/projects/telecodex",
      since: NOW,
    }));

    const { body } = renderStatusBoard(emptySnapshot({ running, queued }), CHAT_ID);

    expect(body).toContain("5. mir-back · active-4");
    expect(body).not.toContain("active-5");
    expect(body).toContain("… ещё 2");
    expect(body).toContain("3. telecodex · queued-2");
    expect(body).not.toContain("queued-3");
    expect(body.match(/… ещё 2/g)).toHaveLength(2);
  });

  it("omits source and child detail while keeping one secret-safe root label", () => {
    const { body } = renderStatusBoard(emptySnapshot({
      running: [task({
        source: "vscode",
        label: "проверь 123456789:AAHfitzz-abcdefghijklmnopqrstuvwxyz012",
        children: [{ label: "Rawls · hidden child", since: NOW - minutes(3) }],
      })],
    }), CHAT_ID);

    expect(body).toContain("mir-back · (скрыто)");
    expect(body).not.toContain("AAHfitzz");
    expect(body).not.toContain("vscode");
    expect(body).not.toContain("Rawls");
  });

  it("bounds waiting attention rows and reports the exact hidden count", () => {
    const running = Array.from({ length: 9 }, (_, index) => task({
      threadId: `waiting-${index}`,
      label: `waiting-${index}`,
      waitingOn: index % 2 === 0 ? "input" : "approval",
    }));

    const { body } = renderStatusBoard(emptySnapshot({ running }), CHAT_ID);

    expect(body).toContain("7. mir-back · waiting-6");
    expect(body).not.toContain("8. mir-back · waiting-7");
    expect(body).toContain("… ещё 2");
  });

  it("keeps the bounded compact body within Telegram UTF-16 limits", () => {
    const running = Array.from({ length: 50 }, (_, index) => task({
      threadId: `thread-${index}`,
      label: `😀${index}${"x".repeat(100)}`,
      waitingOn: "input",
    }));
    const queued = Array.from({ length: 50 }, (_, index) => ({
      label: `😀${index}${"q".repeat(100)}`,
      workspace: "/srv/projects/telecodex",
      since: NOW,
    }));

    const rendered = renderStatusBoard(emptySnapshot({ running, queued }), CHAT_ID);

    expect(rendered.body.length).toBeLessThanOrEqual(4096);
    expect(renderStatusBoard(emptySnapshot({ running, queued }), CHAT_ID)).toEqual(rendered);
  });

  it("bounds HTML expansion without breaking escaped entities", () => {
    const hostile = "&".repeat(40);
    const workspace = `/srv/projects/${hostile}`;
    const running = Array.from({ length: 7 }, (_, index) => task({
      threadId: `hostile-${index}`,
      workspace,
      label: hostile,
      waitingOn: "input",
    }));
    const queued = Array.from({ length: 3 }, () => ({
      label: hostile,
      workspace,
      since: NOW,
    }));

    const { body } = renderStatusBoard(emptySnapshot({ running, queued }), CHAT_ID);

    expect(body.length).toBeLessThanOrEqual(4096);
    expect(body).toContain("&amp;");
    expect(body.replaceAll("&amp;", "")).not.toContain("&");
  });

  it("uses the delivery wording for healthy and failed systems", () => {
    expect(renderStatusBoard(emptySnapshot(), CHAT_ID).body)
      .toContain("🟢 Доставка без ошибок за 24ч");
    expect(renderStatusBoard(emptySnapshot({
      codexAvailable: false,
      failedJobs24h: 2,
    }), CHAT_ID).body).toContain("⚠️ Доставка · ошибок 2 за 24ч");
  });

  it("renders only the Mini App launcher even when projections expose actions", () => {
    const jobs = Array.from({ length: 9 }, (_, index) => projectedJob(index));
    const dashboardUrl = "https://example.test/dashboard";

    expect(renderStatusBoard(emptySnapshot({ jobs }), CHAT_ID, dashboardUrl).buttons)
      .toEqual([{ text: "Открыть Dashboard", url: dashboardUrl }]);
    expect(renderStatusBoard(emptySnapshot({ jobs }), CHAT_ID).buttons).toEqual([]);
  });
});

describe("renderMiniAppLauncher", () => {
  it("renders one stable Dashboard launcher button", () => {
    expect(renderMiniAppLauncher("https://t.me/telecodex_bot/dashboard?startapp=dashboard"))
      .toEqual({
        body: "📊 <b>TeleCodex Dashboard</b>\n\nСтатусы и действия теперь доступны в Mini App.",
        buttons: [{
          text: "Открыть Dashboard",
          url: "https://t.me/telecodex_bot/dashboard?startapp=dashboard",
        }],
      });
  });
});
