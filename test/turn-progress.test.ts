import { vi } from "vitest";

import { TurnProgressPresenter } from "../src/turn-progress.js";

describe("TurnProgressPresenter", () => {
  it("creates checkpoints for plan stage changes and completes the previous one", async () => {
    const sent: string[] = [];
    const edited: Array<{ messageId: number; text: string }> = [];
    const presenter = new TurnProgressPresenter({
      heartbeatMs: 120_000,
      now: () => 0,
      send: async (message) => {
        sent.push(message.html);
        return sent.length;
      },
      edit: async (messageId, message) => {
        edited.push({ messageId, text: message.html });
      },
    });

    await presenter.start();
    await presenter.updatePlan([
      { text: "Проверить данные", completed: false },
      { text: "Собрать отчёт", completed: false },
    ]);
    await presenter.updatePlan([
      { text: "Проверить данные", completed: true },
      { text: "Собрать отчёт", completed: false },
    ]);

    expect(sent).toEqual([
      expect.stringContaining("Выполняю запрос"),
      expect.stringContaining("Проверить данные"),
      expect.stringContaining("Собрать отчёт"),
    ]);
    expect(edited).toEqual([
      { messageId: 1, text: expect.stringContaining("✅") },
      { messageId: 2, text: expect.stringContaining("✅") },
    ]);

    await presenter.complete();
    expect(edited.at(-1)).toEqual({
      messageId: 3,
      text: expect.stringContaining("✅"),
    });
  });

  it("edits the current checkpoint on heartbeat with elapsed time and tool count", async () => {
    vi.useFakeTimers();
    let now = 0;
    const edited = vi.fn(async () => undefined);
    const presenter = new TurnProgressPresenter({
      heartbeatMs: 120_000,
      now: () => now,
      send: async () => 10,
      edit: edited,
    });

    await presenter.start();
    presenter.toolStarted();
    presenter.toolStarted();
    now = 120_000;
    await vi.advanceTimersByTimeAsync(120_000);

    expect(edited).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        html: expect.stringMatching(/2 мин.*инструменты: 2/s),
      }),
      true,
    );

    await presenter.complete();
    vi.useRealTimers();
  });

  it("marks the active checkpoint as failed", async () => {
    const edited = vi.fn(async () => undefined);
    const presenter = new TurnProgressPresenter({
      heartbeatMs: 120_000,
      now: () => 0,
      send: async () => 7,
      edit: edited,
    });

    await presenter.start();
    await presenter.fail("Codex turn failed");

    expect(edited).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ html: expect.stringContaining("⚠️") }),
      false,
    );
  });
});
