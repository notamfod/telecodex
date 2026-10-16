import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { GitlabReviewLaunchRequest } from "./gitlab-review-launch-client.js";

/** A selection belongs to a user in a topic, rather than to the last tapped message. */
export class GitlabReviewSelection {
  private readonly db: Database.Database;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file);
    chmodSync(file, 0o600);
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS review_selection (
      user INTEGER NOT NULL, chat INTEGER NOT NULL, topic INTEGER NOT NULL,
      request TEXT NOT NULL, message INTEGER NOT NULL,
      PRIMARY KEY (user, chat, topic, request)
    )`);
  }

  close(): void { this.db.close(); }

  toggle(user: number, message: GitlabReviewLaunchRequest): boolean {
    validate(user, message);
    return this.db.transaction(() => {
      const removed = this.db.prepare("DELETE FROM review_selection WHERE user=? AND chat=? AND topic=? AND request=?")
        .run(user, message.chatId, message.messageThreadId, message.requestId);
      if (removed.changes) return false;
      if (this.list(user, message.chatId, message.messageThreadId).length >= 30) {
        throw new Error("Selection limit reached");
      }
      this.db.prepare("INSERT INTO review_selection VALUES (?, ?, ?, ?, ?)")
        .run(user, message.chatId, message.messageThreadId, message.requestId, message.messageId);
      return true;
    })();
  }

  list(user: number, chatId: number, messageThreadId: number): GitlabReviewLaunchRequest[] {
    const rows = this.db.prepare("SELECT request, message FROM review_selection WHERE user=? AND chat=? AND topic=? ORDER BY message")
      .all(user, chatId, messageThreadId) as Array<{ request: string; message: number }>;
    return rows.map((row) => ({ requestId: row.request, messageId: row.message, chatId, messageThreadId }));
  }

  remove(user: number, message: GitlabReviewLaunchRequest): void {
    validate(user, message);
    this.db.prepare("DELETE FROM review_selection WHERE user=? AND chat=? AND topic=? AND request=? AND message=?")
      .run(user, message.chatId, message.messageThreadId, message.requestId, message.messageId);
  }
}

function validate(user: number, message: GitlabReviewLaunchRequest): void {
  if (!Number.isSafeInteger(user) || user <= 0 || !Number.isSafeInteger(message.chatId) || message.chatId === 0
    || !Number.isSafeInteger(message.messageThreadId) || message.messageThreadId <= 0
    || !Number.isSafeInteger(message.messageId) || message.messageId <= 0
    || !/^[a-f0-9]{32}$/.test(message.requestId)) throw new Error("Invalid review selection");
}
