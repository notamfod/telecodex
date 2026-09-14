import { escapeHTML } from "./format.js";
import type {
  TelegramJobStatusProjection,
  TelegramStatusAction,
} from "./telegram-status-projection.js";

const MAX_VISIBLE_REFRESH_INTERVAL_MS = 5_000;
const MAX_TRANSPORT_RETRY_AFTER_MS = 3_600_000;

export interface TurnProgressTransportClassification {
  disposition: "acceptance_unknown" | "retryable" | "permanent" | "message_missing";
  retryAfterMs?: number;
}

export class TurnProgressTransportError extends Error {
  constructor(message: string, readonly classification: TurnProgressTransportClassification) {
    super(message);
    this.name = "TurnProgressTransportError";
  }
}

export interface ProgressMessage {
  html: string;
  plain: string;
  /** The exact canonical DTO used to render this revision. */
  projection?: TelegramJobStatusProjection;
  actions?: readonly TelegramStatusAction[];
}

export type TurnProgressAnchorRevision = Readonly<Record<string, unknown>>;

export type TurnProgressAnchorPreparation =
  | { readonly kind: "stale" }
  | { readonly kind: "unchanged"; readonly messageId: number }
  | {
      readonly kind: "prepared";
      readonly revision: TurnProgressAnchorRevision;
      readonly operation: "send";
      readonly attempt: number;
    }
  | {
      readonly kind: "prepared";
      readonly revision: TurnProgressAnchorRevision;
      readonly operation: "edit";
      readonly attempt: number;
      readonly messageId: number;
    };

export type TurnProgressAnchorFinish =
  | {
      readonly revision: TurnProgressAnchorRevision;
      readonly state: "delivered";
      readonly messageId: number;
      readonly updatedAt: number;
    }
  | {
      readonly revision: TurnProgressAnchorRevision;
      readonly state: "uncertain";
      readonly errorCode: string;
      readonly updatedAt: number;
    }
  | {
      readonly revision: TurnProgressAnchorRevision;
      readonly state: "pending";
      readonly errorCode: string;
      readonly nextAttemptAt: number;
      readonly updatedAt: number;
    }
  | {
      readonly revision: TurnProgressAnchorRevision;
      readonly state: "failed";
      readonly errorCode: string;
      readonly updatedAt: number;
    };

/**
 * High-level adapter over the delivery ledger's status-anchor prepare/finish CAS.
 * The adapter owns job/state/attempt/content-hash mapping; the presenter only
 * executes the prepared send or known-message edit and returns its exact result.
 */
export interface TurnProgressAnchorPersistence {
  prepare(input: {
    readonly projection: TelegramJobStatusProjection;
    readonly message: ProgressMessage;
    readonly nextAttemptAt: number;
    readonly updatedAt: number;
  }): Promise<TurnProgressAnchorPreparation>;
  replaceMissingEdit?(input: {
    readonly revision: TurnProgressAnchorRevision;
    readonly projection: TelegramJobStatusProjection;
    readonly message: ProgressMessage;
    readonly updatedAt: number;
  }): Promise<void>;
  finish(input: TurnProgressAnchorFinish): Promise<void>;
}

interface TurnProgressBaseDependencies {
  heartbeatMs: number;
  send: (message: ProgressMessage) => Promise<number>;
  edit: (messageId: number, message: ProgressMessage, heartbeat: boolean) => Promise<void>;
  now?: () => number;
}

export type TurnProgressDependencies = TurnProgressBaseDependencies & (
  | { projection?: never; anchor?: never; classifyTransportError?: never }
  | {
      projection: () => TelegramJobStatusProjection | Promise<TelegramJobStatusProjection>;
      anchor: TurnProgressAnchorPersistence;
      /** Required durable boundary: raw library errors cannot be silently guessed. */
      classifyTransportError: (
        operation: "send" | "edit",
        error: unknown,
      ) => TurnProgressTransportClassification;
    }
);

export class TurnProgressPresenter {
  private readonly now: () => number;
  private operation: Promise<unknown> = Promise.resolve();
  private startedAt = 0;
  private stage = "Выполняю запрос";
  private messageId?: number;
  private toolCount = 0;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private transportBlocked = false;
  private completionRequested = false;

  constructor(private readonly dependencies: TurnProgressDependencies) {
    this.now = dependencies.now ?? Date.now;
    const durableCount = [dependencies.projection, dependencies.anchor,
      dependencies.classifyTransportError].filter(Boolean).length;
    if (durableCount !== 0 && durableCount !== 3) {
      throw new Error("Durable progress requires projection, anchor, and transport classifier dependencies");
    }
  }

  get isTransportBlocked(): boolean { return this.transportBlocked; }

  async start(): Promise<void> {
    this.startedAt = this.now();
    if (this.isDurable()) {
      await this.refreshStatus();
      return;
    }
    this.messageId = await this.dependencies.send(this.renderLegacy("⏳"));
    this.startTimer();
  }

  toolStarted(): void {
    if (!this.isDurable()) this.toolCount += 1;
  }

  updatePlan(items: Array<{ text: string; completed: boolean }>): Promise<void> {
    if (this.isDurable()) return this.refreshStatus();
    const nextStage = items.find((item) => !item.completed)?.text.trim() || "Финальная проверка";
    if (!nextStage || nextStage === this.stage || this.stopped) return Promise.resolve();
    return this.enqueue(async () => {
      if (this.stopped || nextStage === this.stage) return;
      if (this.messageId !== undefined) {
        await this.dependencies.edit(this.messageId, this.renderLegacy("✅"), false);
      }
      this.stage = nextStage;
      this.messageId = await this.dependencies.send(this.renderLegacy("⏳"));
    });
  }

  refreshStatus(): Promise<void> {
    if (this.stopped || this.transportBlocked) return this.operation.then(() => undefined);
    if (!this.isDurable()) return this.refreshHeartbeat();
    return this.enqueue(() => this.deliverProjection());
  }

  complete(): Promise<void> {
    if (!this.isDurable()) return this.stopLegacyWith("✅");
    if (this.stopped) return this.operation.then(() => undefined);
    this.stopTimer();
    if (this.transportBlocked) {
      this.stopped = true;
      return this.operation.then(() => undefined);
    }
    this.completionRequested = true;
    return this.enqueue(async () => {
      try {
        await this.deliverProjection();
      } finally {
        if (!this.stopped && !this.transportBlocked) this.startTimer();
      }
    });
  }

  fail(detail?: string): Promise<void> {
    return this.isDurable() ? this.complete() : this.stopLegacyWith("⚠️", detail);
  }

  dispose(): Promise<void> {
    this.stopped = true;
    this.stopTimer();
    return this.operation.then(() => undefined);
  }

  private async deliverProjection(allowMissingEditRecovery = true): Promise<void> {
    const projection = await this.dependencies.projection!();
    const anchor = this.dependencies.anchor!;
    const message = renderProjection(projection);
    const updatedAt = this.now();
    const nextAttemptAt = updatedAt + MAX_VISIBLE_REFRESH_INTERVAL_MS;
    const prepared = await anchor.prepare({ projection, message, nextAttemptAt, updatedAt });
    if (prepared.kind === "stale") return;
    if (prepared.kind === "unchanged") {
      this.messageId = prepared.messageId;
      this.settleProjection(projection);
      return;
    }
    if (prepared.operation === "send") {
      let messageId: number;
      try {
        messageId = await this.dependencies.send(message);
      } catch (error) {
        const classification = this.classifyTransportError("send", error);
        try {
          if (classification.disposition === "acceptance_unknown") {
            await anchor.finish({ revision: prepared.revision, state: "uncertain",
              errorCode: "telegram_status_send_uncertain", updatedAt: this.now() });
            this.blockTransport();
          } else if (classification.disposition === "retryable") {
            const failedAt = this.now();
            await anchor.finish({ revision: prepared.revision, state: "pending",
              errorCode: "telegram_status_send_retry",
              nextAttemptAt: failedAt + retryDelayMs(prepared.attempt, classification),
              updatedAt: failedAt });
          } else {
            await anchor.finish({ revision: prepared.revision, state: "failed",
              errorCode: "telegram_status_send_failed", updatedAt: this.now() });
            this.blockTransport();
          }
        } catch (persistenceError) {
          this.blockTransport();
          throw persistenceError;
        }
        throw error;
      }
      this.messageId = messageId;
      try {
        await anchor.finish({
          revision: prepared.revision, state: "delivered", messageId, updatedAt: this.now(),
        });
      } catch (error) {
        this.blockTransport();
        throw error;
      }
    } else {
      try {
        await this.dependencies.edit(prepared.messageId, message, false);
      } catch (error) {
        const classification = this.classifyTransportError("edit", error);
        if (isMessageNotModified(error)) {
          // Telegram confirms the intended content is already present.
        } else if (classification.disposition === "message_missing") {
          if (!allowMissingEditRecovery) {
            this.blockTransport();
            await anchor.finish({ revision: prepared.revision, state: "failed",
              errorCode: "telegram_status_edit_failed", updatedAt: this.now() });
            throw error;
          }
          if (!anchor.replaceMissingEdit) {
            throw new Error("Missing status anchor recovery persistence");
          }
          await anchor.replaceMissingEdit({
            revision: prepared.revision,
            projection,
            message,
            updatedAt: this.now(),
          });
          await this.deliverProjection(false);
          return;
        } else if (classification.disposition === "retryable") {
          const failedAt = this.now();
          await anchor.finish({
            revision: prepared.revision,
            state: "pending",
            errorCode: "telegram_status_edit_retry",
            nextAttemptAt: failedAt + retryDelayMs(prepared.attempt, classification),
            updatedAt: failedAt,
          });
          throw error;
        } else {
          await anchor.finish({ revision: prepared.revision, state: "failed",
            errorCode: "telegram_status_edit_failed", updatedAt: this.now() });
          this.blockTransport();
          throw error;
        }
      }
      this.messageId = prepared.messageId;
      try {
        await anchor.finish({
          revision: prepared.revision, state: "delivered",
          messageId: prepared.messageId, updatedAt: this.now(),
        });
      } catch (error) {
        this.blockTransport();
        throw error;
      }
    }
    this.settleProjection(projection);
  }

  private settleProjection(projection: TelegramJobStatusProjection): void {
    const finalFailure = projection.phase === "terminal"
      && projection.outcome !== null && projection.outcome !== "completed"
      && projection.delivery.complete;
    if (!projection.isDone && !finalFailure) return;
    this.stopTimer();
    if (this.completionRequested || projection.phase === "terminal") this.stopped = true;
  }

  private blockTransport(): void {
    this.transportBlocked = true;
    this.stopTimer();
  }

  private refreshHeartbeat(): Promise<void> {
    if (this.stopped || this.messageId === undefined) return Promise.resolve();
    return this.enqueue(async () => {
      if (!this.stopped && this.messageId !== undefined) {
        await this.dependencies.edit(this.messageId, this.renderLegacy("⏳"), true);
      }
    });
  }

  private stopLegacyWith(icon: "✅" | "⚠️", detail?: string): Promise<void> {
    if (this.stopped) return this.operation.then(() => undefined);
    this.stopped = true;
    this.stopTimer();
    return this.enqueue(async () => {
      if (this.messageId !== undefined) {
        await this.dependencies.edit(this.messageId, this.renderLegacy(icon, detail), false);
      }
    });
  }

  private renderLegacy(icon: "⏳" | "✅" | "⚠️", detail?: string): ProgressMessage {
    const elapsed = Math.max(0, this.now() - this.startedAt);
    const meta = `${formatElapsed(elapsed)} · инструменты: ${this.toolCount}`;
    const detailLine = detail ? `\n<code>${escapeHTML(detail)}</code>` : "";
    return {
      html: `${icon} <b>${escapeHTML(this.stage)}</b>\n<code>${escapeHTML(meta)}</code>${detailLine}`,
      plain: `${icon} ${this.stage}\n${meta}${detail ? `\n${detail}` : ""}`,
    };
  }

  private startTimer(): void {
    if (this.timer || this.stopped || this.transportBlocked || this.isDurable()) return;
    const interval = this.dependencies.heartbeatMs;
    this.timer = setInterval(() => {
      void this.refreshHeartbeat().catch(() => undefined);
    }, interval);
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private isDurable(): boolean {
    return this.dependencies.projection !== undefined && this.dependencies.anchor !== undefined
      && this.dependencies.classifyTransportError !== undefined;
  }

  private classifyTransportError(
    operation: "send" | "edit",
    error: unknown,
  ): TurnProgressTransportClassification {
    const classification = this.dependencies.classifyTransportError!(operation, error);
    if (typeof classification !== "object" || classification === null
      || (classification.disposition !== "acceptance_unknown"
        && classification.disposition !== "retryable"
        && classification.disposition !== "permanent"
        && classification.disposition !== "message_missing")
      || (classification.disposition === "message_missing" && operation !== "edit")
      || (classification.retryAfterMs !== undefined
        && (classification.disposition !== "retryable"
          || typeof classification.retryAfterMs !== "number"
          || !Number.isSafeInteger(classification.retryAfterMs)
          || classification.retryAfterMs <= 0
          || classification.retryAfterMs > MAX_TRANSPORT_RETRY_AFTER_MS))) {
      throw new Error("Invalid progress transport classification");
    }
    return classification;
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.operation.then(action, action);
    this.operation = next.then(() => undefined, () => undefined);
    return next;
  }
}

function renderProjection(projection: TelegramJobStatusProjection): ProgressMessage {
  const icon = projection.isDone && projection.state === "terminal_delivered" ? "✅"
    : projection.health === "stalled" || projection.health === "unavailable"
      || projection.state.includes("failed") || projection.state === "delivery_uncertain"
      || projection.attention.kind === "required" ? "⚠️" : "⏳";
  const states: Record<TelegramJobStatusProjection["state"], string> = {
    accepted: "Запрос принят", queued: "В очереди", dispatching_not_sent: "Готовлю запуск",
    dispatching_unknown: "Запуск не подтверждён", running: "Выполняю запрос",
    stalled: "Нет прогресса, нужна проверка", delivering: "Доставляю ответ",
    delivery_failed: "Не удалось доставить ответ", delivery_uncertain: "Доставка ответа не подтверждена",
    terminal_incomplete: "Запрос выполнен, доставка ещё не завершена",
    terminal_delivered: "Ответ доставлен", terminal_failed: "Запрос завершился ошибкой",
    terminal_aborted: "Запрос остановлен", terminal_recovery_interrupted: "Запрос прерван при восстановлении",
  };
  const health: Record<TelegramJobStatusProjection["health"], string> = {
    healthy: "Работает", quiet: "Нет новых событий", checking: "Проверяю состояние",
    stalled: "Нет прогресса", unavailable: "Состояние недоступно",
  };
  const activity = { model: "Модель", tool: "Инструмент", subagent: "Помощник",
    waiting: "Ожидание", unknown: "Нет данных об активности" };
  const facts = [
    health[projection.health],
    projection.activity
      ? `${activity[projection.activity.kind]} · ${formatElapsed(projection.activity.ageMs)} назад`
      : undefined,
    projection.guardian.availability === "unavailable" ? "Проверка сессии недоступна" : undefined,
    `Доставлено: ${projection.delivery.delivered}/${projection.delivery.total}`,
    projection.attention.kind === "required" ? "Требуется ваше внимание" : undefined,
    projection.state === "delivery_uncertain" || projection.state === "dispatching_unknown"
      ? "Повтор может создать дубль. Сначала проверьте подробности." : undefined,
  ].filter((value): value is string => value !== undefined);
  const title = `${icon} ${states[projection.state]}`;
  return {
    html: `<b>${escapeHTML(title)}</b>\n${escapeHTML(facts.join(" · "))}`,
    plain: `${title}\n${facts.join(" · ")}`,
    projection,
    actions: projection.actions,
  };
}

function isMessageNotModified(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /message is not modified/i.test(detail);
}

function retryDelayMs(
  attempt: number,
  classification: TurnProgressTransportClassification,
): number {
  if (classification.retryAfterMs !== undefined) return classification.retryAfterMs;
  return Math.min(5_000 * (2 ** (attempt - 1)), 60_000);
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds} сек`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes} мин ${seconds} сек` : `${minutes} мин`;
}
