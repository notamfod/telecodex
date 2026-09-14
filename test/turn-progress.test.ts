import { vi } from "vitest";

import {
  TurnProgressTransportError,
  TurnProgressPresenter,
  type TurnProgressAnchorPersistence,
  type TurnProgressTransportClassification,
} from "../src/turn-progress.js";
import type { TelegramJobStatusProjection } from "../src/telegram-status-projection.js";

const NOW = 1_700_000_100_000;

function projected(
  overrides: Partial<TelegramJobStatusProjection> = {},
): TelegramJobStatusProjection {
  return {
    schemaVersion: 1,
    jobId: "job-progress",
    shortJobId: "job-prog",
    expectedVersion: 3,
    phase: "running",
    outcome: null,
    state: "running",
    isDone: false,
    anchorKnownDelivered: true,
    health: "healthy",
    activity: { kind: "tool", eventAt: NOW - 12_000, ageMs: 12_000 },
    queue: null,
    dispatch: null,
    guardian: {
      availability: "available", health: "healthy", reasonCode: null,
      threadStatus: "active", lastObservedAt: NOW - 5_000, ageMs: 5_000,
      unchangedSince: NOW - 12_000, staleForMs: 12_000, alertId: null,
      repairState: null, repairOutcome: null,
    },
    delivery: {
      total: 1, delivered: 1, pending: 0, sending: 0, uncertain: 0, failed: 0,
      anchorState: "delivered", anchorMessageId: 501, complete: false,
    },
    timestamps: {
      acceptedAt: NOW - 60_000, updatedAt: NOW - 1_000, terminalAt: null,
      lastEventAt: NOW - 1_000, lastCodexEventAt: NOW - 12_000,
      guardianLastObservedAt: NOW - 5_000, dispatchStartedAt: null,
      nextAttemptAt: null, abortRequestedAt: null, latestDeliveryAt: NOW - 1_000,
    },
    attention: { kind: "none" },
    reasonCodes: [],
    actions: [{ kind: "details", jobId: "job-progress", expectedVersion: 3 }],
    ...overrides,
  };
}

const revision = (key: string) => ({ key });

function durablePresenter(options: {
  projection?: () => TelegramJobStatusProjection | Promise<TelegramJobStatusProjection>;
  anchor: TurnProgressAnchorPersistence;
  send?: (message: { html: string }) => Promise<number>;
  edit?: (messageId: number, message: { html: string }) => Promise<void>;
  now?: () => number;
  classifyTransportError?: (
    operation: "send" | "edit", error: unknown,
  ) => TurnProgressTransportClassification;
}) {
  return new TurnProgressPresenter({
    heartbeatMs: 120_000,
    now: options.now ?? (() => NOW),
    projection: options.projection ?? (() => projected()),
    anchor: options.anchor,
    classifyTransportError: options.classifyTransportError ?? ((_operation, error) =>
      error instanceof TurnProgressTransportError
        ? error.classification
        : { disposition: "permanent" }),
    send: options.send ?? (async () => 502),
    edit: options.edit ?? (async () => undefined),
  });
}

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

  it.each([
    ["running", "Выполняю запрос"],
    ["dispatching_unknown", "Запуск не подтверждён"],
    ["delivery_failed", "Не удалось доставить ответ"],
    ["delivery_uncertain", "Доставка ответа не подтверждена"],
    ["terminal_incomplete", "Запрос выполнен, доставка ещё не завершена"],
    ["terminal_delivered", "Ответ доставлен"],
  ] as const)("renders %s in Russian and keeps technical details in the projection", async (state, label) => {
    const projection = projected({ state, reasonCodes: ["TECHNICAL_REASON"] });
    const send = vi.fn(async (_message: { html: string; plain: string }) => 501);
    const presenter = durablePresenter({
      projection: () => projection,
      anchor: {
        prepare: async () => ({ kind: "prepared", revision: revision("ru"), operation: "send", attempt: 1 }),
        finish: async () => undefined,
      },
      send,
    });
    await presenter.start();
    const message = send.mock.calls[0]![0];
    for (const text of [message.html, message.plain]) {
      expect(text).toContain(label);
      expect(text).toContain("Инструмент");
      expect(text).toContain("Доставлено: 1/1");
      expect(text).not.toContain(state);
      expect(text).not.toContain("TECHNICAL_REASON");
    }
    expect(message).toMatchObject({ projection, actions: projection.actions });
    await presenter.dispose();
  });

  it("reuses a persisted anchor message after presenter recreation", async () => {
    const projection = projected();
    const anchor: TurnProgressAnchorPersistence = {
      prepare: vi.fn(async () => ({
        kind: "prepared", revision: revision("edit-1"), operation: "edit", attempt: 1,
        messageId: 501,
      })),
      finish: vi.fn(async () => undefined),
    };
    const send = vi.fn(async () => 999);
    const edit = vi.fn(async () => undefined);
    const presenter = durablePresenter({ projection: () => projection, anchor, send, edit });

    await presenter.start();

    expect(send).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledWith(501, expect.objectContaining({
      html: expect.stringContaining("Выполняю запрос"), projection,
    }), false);
    expect(anchor.finish).toHaveBeenCalledWith({
      revision: revision("edit-1"), state: "delivered", messageId: 501, updatedAt: NOW,
    });
    await presenter.complete();
  });

  it("suppresses a byte-identical durable anchor revision", async () => {
    const anchor: TurnProgressAnchorPersistence = {
      prepare: vi.fn(async () => ({ kind: "unchanged", messageId: 501 })),
      finish: vi.fn(async () => undefined),
    };
    const send = vi.fn(async () => 999);
    const edit = vi.fn(async () => undefined);
    const presenter = durablePresenter({ anchor, send, edit });

    await presenter.start();
    await presenter.refreshStatus();

    expect(anchor.prepare).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    expect(anchor.finish).not.toHaveBeenCalled();
    await presenter.complete();
  });

  it("performs only one durable projection operation when its revision is stale", async () => {
    const projection = vi.fn(() => projected());
    const anchor: TurnProgressAnchorPersistence = {
      prepare: vi.fn(async () => ({ kind: "stale" })),
      finish: vi.fn(async () => undefined),
    };
    const presenter = durablePresenter({ projection, anchor });

    await presenter.start();

    expect(projection).toHaveBeenCalledOnce();
    expect(anchor.prepare).toHaveBeenCalledOnce();
  });

  it("treats message-not-modified as delivered for a known edit", async () => {
    const anchor: TurnProgressAnchorPersistence = {
      prepare: vi.fn(async () => ({
        kind: "prepared", revision: revision("edit-same"), operation: "edit", attempt: 1,
        messageId: 501,
      })),
      finish: vi.fn(async () => undefined),
    };
    const presenter = durablePresenter({
      anchor,
      edit: vi.fn(async () => { throw new Error("Bad Request: message is not modified"); }),
    });

    await expect(presenter.start()).resolves.toBeUndefined();
    expect(anchor.finish).toHaveBeenCalledWith({
      revision: revision("edit-same"), state: "delivered", messageId: 501, updatedAt: NOW,
    });
    await presenter.complete();
  });

  it("marks an ambiguous initial send uncertain and never retries it automatically", async () => {
    const anchor: TurnProgressAnchorPersistence = {
      prepare: vi.fn(async () => ({
        kind: "prepared", revision: revision("send-1"), operation: "send", attempt: 1,
      })),
      finish: vi.fn(async () => undefined),
    };
    const send = vi.fn(async () => {
      throw new TurnProgressTransportError(
        "telegram send timeout",
        { disposition: "acceptance_unknown" },
      );
    });
    const presenter = durablePresenter({ anchor, send });

    await expect(presenter.start()).rejects.toThrow("telegram send timeout");
    expect(anchor.finish).toHaveBeenCalledWith({
      revision: revision("send-1"), state: "uncertain",
      errorCode: "telegram_status_send_uncertain", updatedAt: NOW,
    });
    await presenter.refreshStatus();
    expect(anchor.prepare).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });

  it("keeps a failed known edit pending and safely retries it", async () => {
    const anchor: TurnProgressAnchorPersistence = {
      prepare: vi.fn()
        .mockResolvedValueOnce({
          kind: "prepared", revision: revision("edit-1"), operation: "edit", attempt: 1,
          messageId: 501,
        })
        .mockResolvedValueOnce({
          kind: "prepared", revision: revision("edit-2"), operation: "edit", attempt: 2,
          messageId: 501,
        })
        .mockResolvedValue({ kind: "unchanged", messageId: 501 }),
      finish: vi.fn(async () => undefined),
    };
    const edit = vi.fn()
      .mockRejectedValueOnce(new TurnProgressTransportError(
        "telegram edit timeout",
        { disposition: "retryable" },
      ))
      .mockResolvedValueOnce(undefined);
    const presenter = durablePresenter({ anchor, edit });

    await expect(presenter.start()).rejects.toThrow("telegram edit timeout");
    expect(anchor.finish).toHaveBeenNthCalledWith(1, {
      revision: revision("edit-1"), state: "pending",
      errorCode: "telegram_status_edit_retry", nextAttemptAt: NOW + 5_000, updatedAt: NOW,
    });
    await presenter.refreshStatus();
    expect(edit).toHaveBeenCalledTimes(2);
    expect(anchor.finish).toHaveBeenNthCalledWith(2, {
      revision: revision("edit-2"), state: "delivered", messageId: 501, updatedAt: NOW,
    });
    await presenter.complete();
  });

  it.each(["acceptance_unknown", "permanent"] as const)(
    "exposes a %s known-edit transport block without retrying it",
    async (disposition) => {
      const transportError = new Error(`telegram edit ${disposition}`);
      const anchor: TurnProgressAnchorPersistence = {
        prepare: vi.fn(async () => ({
          kind: "prepared", revision: revision(`edit-${disposition}`),
          operation: "edit", attempt: 1, messageId: 501,
        })),
        replaceMissingEdit: vi.fn(async () => undefined),
        finish: vi.fn(async () => undefined),
      };
      const presenter = durablePresenter({
        anchor,
        edit: vi.fn(async () => { throw transportError; }),
        classifyTransportError: () => ({ disposition }),
      });

      await expect(presenter.start()).rejects.toBe(transportError);

      expect(presenter.isTransportBlocked).toBe(true);
      expect(anchor.finish).toHaveBeenCalledWith({
        revision: revision(`edit-${disposition}`), state: "failed",
        errorCode: "telegram_status_edit_failed", updatedAt: NOW,
      });
      expect(anchor.replaceMissingEdit).not.toHaveBeenCalled();
      await presenter.refreshStatus();
      expect(anchor.prepare).toHaveBeenCalledOnce();
    },
  );

  it("rejects missing-edit recovery when persistence has no replacement boundary", async () => {
    const missing = new Error("missing edit");
    const anchor: TurnProgressAnchorPersistence = {
      prepare: vi.fn(async () => ({
        kind: "prepared", revision: revision("missing-edit"), operation: "edit",
        attempt: 1, messageId: 501,
      })),
      finish: vi.fn(async () => undefined),
    };
    const presenter = durablePresenter({
      anchor,
      edit: vi.fn(async () => { throw missing; }),
      classifyTransportError: () => ({ disposition: "message_missing" }),
    });

    await expect(presenter.start()).rejects.toThrow("Missing status anchor recovery persistence");

    expect(anchor.finish).not.toHaveBeenCalled();
  });

    it("replaces a missing known edit and delivers the current projection once", async () => {
    const transportError = new Error("Bad Request: message to edit not found");
    const projection = projected();
    const events: string[] = [];
    const anchor: TurnProgressAnchorPersistence = {
      prepare: vi.fn()
        .mockImplementationOnce(async () => {
          events.push("prepare-edit");
          return {
            kind: "prepared" as const, revision: revision("missing-edit"),
            operation: "edit" as const, attempt: 4, messageId: 501,
          };
        })
        .mockImplementationOnce(async () => {
          events.push("prepare-send");
          return {
            kind: "prepared" as const, revision: revision("replacement-send"),
            operation: "send" as const, attempt: 5,
          };
        }),
      replaceMissingEdit: vi.fn(async () => { events.push("replace"); }),
      finish: vi.fn(async (input) => { events.push(input.state); }),
    };
    const edit = vi.fn(async () => {
      events.push("edit");
      throw transportError;
    });
    const send = vi.fn(async () => {
      events.push("send");
      return 777;
    });
    const classifyTransportError = vi.fn(() => ({ disposition: "message_missing" as const }));
    const presenter = durablePresenter({
      projection: () => projection, anchor, send, edit, classifyTransportError,
    });

    await expect(presenter.start()).resolves.toBeUndefined();

    expect(classifyTransportError).toHaveBeenCalledWith("edit", transportError);
    expect(anchor.replaceMissingEdit).toHaveBeenCalledWith({
      revision: revision("missing-edit"),
      projection,
      message: expect.objectContaining({ projection, actions: projection.actions }),
      updatedAt: NOW,
    });
    expect(anchor.finish).toHaveBeenCalledOnce();
    expect(anchor.finish).toHaveBeenCalledWith({
      revision: revision("replacement-send"), state: "delivered",
      messageId: 777, updatedAt: NOW,
    });
    expect(events).toEqual([
      "prepare-edit", "edit", "replace", "prepare-send", "send", "delivered",
    ]);
    expect(anchor.prepare).toHaveBeenCalledTimes(2);
    expect(edit).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(presenter.isTransportBlocked).toBe(false);
  });

  it("fails and blocks when a replacement prepare unexpectedly returns another missing edit", async () => {
    const firstMissing = new Error("first missing edit");
    const secondMissing = new Error("second missing edit");
    const anchor: TurnProgressAnchorPersistence = {
      prepare: vi.fn()
        .mockResolvedValueOnce({
          kind: "prepared", revision: revision("missing-edit"), operation: "edit",
          attempt: 4, messageId: 501,
        })
        .mockResolvedValueOnce({
          kind: "prepared", revision: revision("unexpected-edit"), operation: "edit",
          attempt: 5, messageId: 502,
        }),
      replaceMissingEdit: vi.fn(async () => undefined),
      finish: vi.fn(async () => undefined),
    };
    const edit = vi.fn()
      .mockRejectedValueOnce(firstMissing)
      .mockRejectedValueOnce(secondMissing);
    const presenter = durablePresenter({
      anchor,
      edit,
      classifyTransportError: () => ({ disposition: "message_missing" }),
    });

    await expect(presenter.start()).rejects.toBe(secondMissing);

    expect(anchor.replaceMissingEdit).toHaveBeenCalledOnce();
    expect(anchor.prepare).toHaveBeenCalledTimes(2);
    expect(edit).toHaveBeenCalledTimes(2);
    expect(anchor.finish).toHaveBeenCalledOnce();
    expect(anchor.finish).toHaveBeenCalledWith({
      revision: revision("unexpected-edit"), state: "failed",
      errorCode: "telegram_status_edit_failed", updatedAt: NOW,
    });
    expect(presenter.isTransportBlocked).toBe(true);
    await presenter.refreshStatus();
    expect(anchor.prepare).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["acceptance_unknown", "uncertain", "telegram_status_send_uncertain", undefined],
    ["retryable", "pending", "telegram_status_send_retry", NOW + 23_000],
    ["permanent", "failed", "telegram_status_send_failed", undefined],
  ] as const)(
    "preserves %s handling for a missing-edit replacement send",
    async (disposition, state, errorCode, nextAttemptAt) => {
      const missing = new Error("missing edit");
      const sendFailure = new Error(`replacement send ${disposition}`);
      const anchor: TurnProgressAnchorPersistence = {
        prepare: vi.fn()
          .mockResolvedValueOnce({
            kind: "prepared", revision: revision("missing-edit"), operation: "edit",
            attempt: 4, messageId: 501,
          })
          .mockResolvedValueOnce({
            kind: "prepared", revision: revision("replacement-send"), operation: "send",
            attempt: 5,
          }),
        replaceMissingEdit: vi.fn(async () => undefined),
        finish: vi.fn(async () => undefined),
      };
      const send = vi.fn(async () => { throw sendFailure; });
      const presenter = durablePresenter({
        anchor,
        edit: vi.fn(async () => { throw missing; }),
        send,
        classifyTransportError: (operation, error) => {
          if (operation === "edit" && error === missing) return { disposition: "message_missing" };
          if (operation === "send" && error === sendFailure && disposition === "retryable") {
            return { disposition, retryAfterMs: 23_000 };
          }
          return { disposition };
        },
      });

      await expect(presenter.start()).rejects.toBe(sendFailure);

      expect(anchor.finish).toHaveBeenCalledOnce();
      expect(anchor.finish).toHaveBeenCalledWith({
        revision: revision("replacement-send"), state, errorCode, updatedAt: NOW,
        ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
      });
      expect(presenter.isTransportBlocked).toBe(disposition !== "retryable");
      expect(send).toHaveBeenCalledOnce();
      if (disposition !== "retryable") await presenter.refreshStatus();
      expect(send).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["acceptance_unknown", undefined],
    ["retryable", 23_000],
    ["permanent", undefined],
  ] as const)(
    "blocks when persisting a %s replacement-send failure itself fails",
    async (disposition, retryAfterMs) => {
      const missing = new Error("missing edit");
      const sendFailure = new Error(`replacement send ${disposition}`);
      const persistenceFailure = new Error(`persist ${disposition} failed`);
      const anchor: TurnProgressAnchorPersistence = {
        prepare: vi.fn()
          .mockResolvedValueOnce({
            kind: "prepared", revision: revision("missing-edit"), operation: "edit",
            attempt: 4, messageId: 501,
          })
          .mockResolvedValueOnce({
            kind: "prepared", revision: revision("replacement-send"), operation: "send",
            attempt: 5,
          }),
        replaceMissingEdit: vi.fn(async () => undefined),
        finish: vi.fn(async () => { throw persistenceFailure; }),
      };
      const send = vi.fn(async () => { throw sendFailure; });
      const classifyTransportError = vi.fn((operation: "send" | "edit", error: unknown) => {
        if (operation === "edit" && error === missing) return { disposition: "message_missing" as const };
        if (operation === "send" && error === sendFailure && retryAfterMs !== undefined) {
          return { disposition: "retryable" as const, retryAfterMs };
        }
        return { disposition };
      });
      const presenter = durablePresenter({
        anchor,
        edit: vi.fn(async () => { throw missing; }),
        send,
        classifyTransportError,
      });

      await expect(presenter.start()).rejects.toBe(persistenceFailure);

      expect(presenter.isTransportBlocked).toBe(true);
      expect(anchor.finish).toHaveBeenCalledOnce();
      expect(anchor.finish).toHaveBeenCalledWith({
        revision: revision("replacement-send"),
        state: disposition === "acceptance_unknown" ? "uncertain"
          : disposition === "retryable" ? "pending" : "failed",
        errorCode: disposition === "acceptance_unknown" ? "telegram_status_send_uncertain"
          : disposition === "retryable" ? "telegram_status_send_retry" : "telegram_status_send_failed",
        updatedAt: NOW,
        ...(retryAfterMs === undefined ? {} : { nextAttemptAt: NOW + retryAfterMs }),
      });
      expect(classifyTransportError).toHaveBeenCalledTimes(2);
      expect(anchor.prepare).toHaveBeenCalledTimes(2);
      expect(anchor.replaceMissingEdit).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledOnce();

      await presenter.refreshStatus();
      await presenter.complete();

      expect(anchor.prepare).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledOnce();
    },
  );

  it("rejects message-missing classification for a replacement send before finishing", async () => {
    const missingEdit = new Error("missing edit");
    const missingSend = new Error("invalid missing send");
    const anchor: TurnProgressAnchorPersistence = {
      prepare: vi.fn()
        .mockResolvedValueOnce({
          kind: "prepared", revision: revision("missing-edit"), operation: "edit",
          attempt: 4, messageId: 501,
        })
        .mockResolvedValueOnce({
          kind: "prepared", revision: revision("replacement-send"), operation: "send",
          attempt: 5,
        }),
      replaceMissingEdit: vi.fn(async () => undefined),
      finish: vi.fn(async () => undefined),
    };
    const send = vi.fn(async () => { throw missingSend; });
    const classifyTransportError = vi.fn(() => ({ disposition: "message_missing" as const }));
    const presenter = durablePresenter({
      anchor,
      edit: vi.fn(async () => { throw missingEdit; }),
      send,
      classifyTransportError,
    });

    await expect(presenter.start()).rejects.toThrow("Invalid progress transport classification");

    expect(anchor.finish).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(classifyTransportError.mock.calls.map(([operation]) => operation)).toEqual(["edit", "send"]);
  });

  it("does not send or reclassify when missing-edit replacement storage fails", async () => {
    const missing = new Error("missing edit");
    const storageFailure = new Error("sqlite busy");
    const classifyTransportError = vi.fn(() => ({ disposition: "message_missing" as const }));
    const anchor: TurnProgressAnchorPersistence = {
      prepare: vi.fn(async () => ({
        kind: "prepared", revision: revision("missing-edit"), operation: "edit",
        attempt: 4, messageId: 501,
      })),
      replaceMissingEdit: vi.fn(async () => { throw storageFailure; }),
      finish: vi.fn(async () => undefined),
    };
    const send = vi.fn(async () => 777);
    const presenter = durablePresenter({
      anchor, send, classifyTransportError,
      edit: vi.fn(async () => { throw missing; }),
    });

    await expect(presenter.start()).rejects.toBe(storageFailure);

    expect(classifyTransportError).toHaveBeenCalledOnce();
    expect(classifyTransportError).toHaveBeenCalledWith("edit", missing);
    expect(anchor.replaceMissingEdit).toHaveBeenCalledOnce();
    expect(anchor.finish).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("renders Done only from a terminal-delivered projection", async () => {
    let value = projected({
      phase: "terminal", outcome: "completed", state: "terminal_incomplete", isDone: false,
      delivery: { ...projected().delivery, complete: false },
    });
    const messages: string[] = [];
    const anchor: TurnProgressAnchorPersistence = {
      prepare: vi.fn(async () => ({
        kind: "prepared", revision: revision(`edit-${messages.length}`),
        operation: "edit", attempt: 1, messageId: 501,
      })),
      finish: vi.fn(async () => undefined),
    };
    const presenter = durablePresenter({
      projection: () => value,
      anchor,
      edit: async (_messageId, message) => { messages.push(message.html); },
    });

    await presenter.start();
    expect(messages.at(-1)).not.toContain("✅");
    await presenter.complete();
    expect(messages.at(-1)).not.toContain("✅");
    value = projected({
      phase: "terminal", outcome: "completed", state: "terminal_delivered", isDone: true,
      delivery: { ...projected().delivery, complete: true },
    });
    await presenter.refreshStatus();
    expect(messages.at(-1)).toContain("✅");
  });

  it("marks a definitive transport rejection failed instead of retrying forever", async () => {
    const anchor: TurnProgressAnchorPersistence = {
      prepare: vi.fn(async () => ({
        kind: "prepared", revision: revision("send-rejected"), operation: "send", attempt: 1,
      })),
      finish: vi.fn(async () => undefined),
    };
    const send = vi.fn(async () => {
      throw new TurnProgressTransportError("chat not found", { disposition: "permanent" });
    });
    const presenter = durablePresenter({ anchor, send });

    await expect(presenter.start()).rejects.toThrow("chat not found");
    expect(anchor.finish).toHaveBeenCalledWith({
      revision: revision("send-rejected"), state: "failed",
      errorCode: "telegram_status_send_failed", updatedAt: NOW,
    });
    await presenter.refreshStatus();
    expect(anchor.prepare).toHaveBeenCalledOnce();
  });

  it("uses the durable boundary classifier to keep a raw 429 send retryable", async () => {
    const rateLimit = { error_code: 429, description: "Too Many Requests" };
    const anchor: TurnProgressAnchorPersistence = {
      prepare: vi.fn(async () => ({
        kind: "prepared", revision: revision("send-rate-limit"), operation: "send", attempt: 1,
      })),
      finish: vi.fn(async () => undefined),
    };
    const classifyTransportError = vi.fn((_operation: "send" | "edit", error: unknown) =>
      error === rateLimit
        ? { disposition: "retryable" as const, retryAfterMs: 23_000 }
        : { disposition: "permanent" as const });
    const presenter = durablePresenter({
      anchor,
      send: vi.fn(async () => { throw rateLimit; }),
      classifyTransportError,
    });

    await expect(presenter.start()).rejects.toBe(rateLimit);
    expect(classifyTransportError).toHaveBeenCalledOnce();
    expect(classifyTransportError).toHaveBeenCalledWith("send", rateLimit);
    expect(anchor.finish).toHaveBeenCalledWith({
      revision: revision("send-rate-limit"), state: "pending",
      errorCode: "telegram_status_send_retry", nextAttemptAt: NOW + 23_000, updatedAt: NOW,
    });
  });

  it.each([
    ["permanent delay", { disposition: "permanent" as const, retryAfterMs: 1_000 }],
    ["acceptance-unknown delay", {
      disposition: "acceptance_unknown" as const, retryAfterMs: 1_000,
    }],
    ["message-missing send", { disposition: "message_missing" as const }],
    ["message-missing retry delay", {
      disposition: "message_missing" as const, retryAfterMs: 1_000,
    }],
    ["fractional retry delay", { disposition: "retryable" as const, retryAfterMs: 0.5 }],
    ["over-cap retry delay", {
      disposition: "retryable" as const, retryAfterMs: 3_600_001,
    }],
  ])("rejects an invalid transport classification with a %s", async (_label, classification) => {
    const failure = new Error("telegram send failed");
    const anchor: TurnProgressAnchorPersistence = {
      prepare: vi.fn(async () => ({
        kind: "prepared", revision: revision("send-invalid-classification"),
        operation: "send", attempt: 1,
      })),
      finish: vi.fn(async () => undefined),
    };
    const presenter = durablePresenter({
      anchor,
      send: vi.fn(async () => { throw failure; }),
      classifyTransportError: () => classification,
    });

    await expect(presenter.start()).rejects.toThrow("Invalid progress transport classification");
    expect(anchor.finish).not.toHaveBeenCalled();
  });

  it.each([
    [1, 5_000],
    [2, 10_000],
    [3, 20_000],
    [4, 40_000],
    [5, 60_000],
    [6, 60_000],
  ])("backs off retryable edit attempt %i by %i ms", async (attempt, delay) => {
    const failure = new Error(`edit attempt ${attempt} failed`);
    const anchor: TurnProgressAnchorPersistence = {
      prepare: vi.fn(async () => ({
        kind: "prepared", revision: revision(`edit-${attempt}`), operation: "edit",
        attempt, messageId: 501,
      })),
      finish: vi.fn(async () => undefined),
    };
    const classifyTransportError = vi.fn(() => ({ disposition: "retryable" as const }));
    const presenter = durablePresenter({
      anchor,
      edit: vi.fn(async () => { throw failure; }),
      classifyTransportError,
    });

    await expect(presenter.start()).rejects.toBe(failure);
    expect(classifyTransportError).toHaveBeenCalledOnce();
    expect(classifyTransportError).toHaveBeenCalledWith("edit", failure);
    expect(anchor.finish).toHaveBeenCalledWith({
      revision: revision(`edit-${attempt}`), state: "pending",
      errorCode: "telegram_status_edit_retry", nextAttemptAt: NOW + delay, updatedAt: NOW,
    });
  });

  it("marks a definitive known-edit failure failed instead of retrying forever", async () => {
    const anchor: TurnProgressAnchorPersistence = {
      prepare: vi.fn(async () => ({
        kind: "prepared", revision: revision("edit-rejected"),
        operation: "edit", attempt: 1, messageId: 501,
      })),
      finish: vi.fn(async () => undefined),
    };
    const edit = vi.fn(async () => {
      throw new TurnProgressTransportError(
        "message cannot be edited",
        { disposition: "permanent" },
      );
    });
    const presenter = durablePresenter({ anchor, edit });

    await expect(presenter.start()).rejects.toThrow("message cannot be edited");
    expect(anchor.finish).toHaveBeenCalledWith({
      revision: revision("edit-rejected"), state: "failed",
      errorCode: "telegram_status_edit_failed", updatedAt: NOW,
    });
    await presenter.refreshStatus();
    expect(anchor.prepare).toHaveBeenCalledOnce();
  });

  it("does not reclassify a durable-finish failure after a successful send", async () => {
    const anchor: TurnProgressAnchorPersistence = {
      prepare: vi.fn(async () => ({
        kind: "prepared", revision: revision("send-stored"), operation: "send", attempt: 1,
      })),
      finish: vi.fn(async () => { throw new Error("sqlite busy"); }),
    };
    const send = vi.fn(async () => 502);
    const presenter = durablePresenter({ anchor, send });

    await expect(presenter.start()).rejects.toThrow("sqlite busy");
    expect(send).toHaveBeenCalledOnce();
    expect(anchor.finish).toHaveBeenCalledOnce();
    expect(anchor.finish).toHaveBeenCalledWith({
      revision: revision("send-stored"), state: "delivered", messageId: 502, updatedAt: NOW,
    });
  });

  it("does not reclassify a durable-finish failure after a successful edit", async () => {
    const anchor: TurnProgressAnchorPersistence = {
      prepare: vi.fn(async () => ({
        kind: "prepared", revision: revision("edit-stored"),
        operation: "edit", attempt: 1, messageId: 501,
      })),
      finish: vi.fn(async () => { throw new Error("sqlite busy"); }),
    };
    const edit = vi.fn(async () => undefined);
    const presenter = durablePresenter({ anchor, edit });

    await expect(presenter.start()).rejects.toThrow("sqlite busy");
    expect(edit).toHaveBeenCalledOnce();
    expect(anchor.finish).toHaveBeenCalledOnce();
    expect(anchor.finish).toHaveBeenCalledWith({
      revision: revision("edit-stored"), state: "delivered", messageId: 501, updatedAt: NOW,
    });
  });

  it("leaves durable refresh cadence to the owning service", async () => {
    vi.useFakeTimers();
    let now = NOW;
    const eventAt = NOW - 12_000;
    const readProjection = vi.fn(() => projected({
      activity: { kind: "tool", eventAt, ageMs: now - eventAt },
    }));
    const anchor: TurnProgressAnchorPersistence = {
      prepare: vi.fn(async () => ({ kind: "unchanged", messageId: 501 })),
      finish: vi.fn(async () => undefined),
    };
    const presenter = durablePresenter({ projection: readProjection, anchor, now: () => now });

    try {
      await presenter.start();
      now += 120_000;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(readProjection).toHaveBeenCalledOnce();
      expect(readProjection.mock.results.map(({ value }) => value.activity?.eventAt))
        .toEqual([eventAt]);
    } finally {
      await presenter.complete();
      vi.useRealTimers();
    }
  });
});
