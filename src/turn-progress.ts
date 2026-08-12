import { escapeHTML } from "./format.js";

export interface ProgressMessage {
  html: string;
  plain: string;
}

export interface TurnProgressDependencies {
  heartbeatMs: number;
  send: (message: ProgressMessage) => Promise<number>;
  edit: (messageId: number, message: ProgressMessage, heartbeat: boolean) => Promise<void>;
  now?: () => number;
}

export class TurnProgressPresenter {
  private readonly now: () => number;
  private operation: Promise<unknown> = Promise.resolve();
  private startedAt = 0;
  private stage = "Выполняю запрос";
  private messageId?: number;
  private toolCount = 0;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly dependencies: TurnProgressDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  async start(): Promise<void> {
    this.startedAt = this.now();
    this.messageId = await this.dependencies.send(this.render("⏳"));
    this.timer = setInterval(() => {
      void this.refreshHeartbeat();
    }, this.dependencies.heartbeatMs);
  }

  toolStarted(): void {
    this.toolCount += 1;
  }

  updatePlan(items: Array<{ text: string; completed: boolean }>): Promise<void> {
    const nextStage = items.find((item) => !item.completed)?.text.trim() || "Финальная проверка";
    if (!nextStage || nextStage === this.stage || this.stopped) return Promise.resolve();

    return this.enqueue(async () => {
      if (this.stopped || nextStage === this.stage) return;
      if (this.messageId !== undefined) {
        await this.dependencies.edit(this.messageId, this.render("✅"), false);
      }
      this.stage = nextStage;
      this.messageId = await this.dependencies.send(this.render("⏳"));
    });
  }

  complete(): Promise<void> {
    return this.stopWith("✅");
  }

  fail(detail?: string): Promise<void> {
    return this.stopWith("⚠️", detail);
  }

  private refreshHeartbeat(): Promise<void> {
    if (this.stopped || this.messageId === undefined) return Promise.resolve();
    return this.enqueue(async () => {
      if (!this.stopped && this.messageId !== undefined) {
        await this.dependencies.edit(this.messageId, this.render("⏳"), true);
      }
    });
  }

  private stopWith(icon: "✅" | "⚠️", detail?: string): Promise<void> {
    if (this.stopped) return this.operation.then(() => undefined);
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    return this.enqueue(async () => {
      if (this.messageId !== undefined) {
        await this.dependencies.edit(this.messageId, this.render(icon, detail), false);
      }
    });
  }

  private render(icon: "⏳" | "✅" | "⚠️", detail?: string): ProgressMessage {
    const elapsed = Math.max(0, this.now() - this.startedAt);
    const meta = `${formatElapsed(elapsed)} · инструменты: ${this.toolCount}`;
    const detailLine = detail ? `\n<code>${escapeHTML(detail)}</code>` : "";
    return {
      html: `${icon} <b>${escapeHTML(this.stage)}</b>\n<code>${escapeHTML(meta)}</code>${detailLine}`,
      plain: `${icon} ${this.stage}\n${meta}${detail ? `\n${detail}` : ""}`,
    };
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.operation.then(action, action);
    this.operation = next.then(() => undefined, () => undefined);
    return next;
  }
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds} сек`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes} мин ${seconds} сек` : `${minutes} мин`;
}
