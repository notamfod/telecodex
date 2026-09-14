import type Database from "better-sqlite3";
import { transitionJob } from "./telegram-job-transition.js";
import type { TelegramJob } from "./telegram-job-types.js";

export interface TaskGuardContext { botId: string; chatId: number; messageThreadId: number }
export interface TaskContextGuard {
  safe: boolean;
  activeJobs: number;
  unresolvedDeliveries: number;
  unconfirmedPlans: number;
}

/** All jobs at the effective destination, including quarantine and older jobs. */
export function readTaskContextGuard(database: Database.Database, context: TaskGuardContext): TaskContextGuard {
  if (typeof context.botId !== "string" || !context.botId.trim() || context.botId.length > 128
    || !Number.isSafeInteger(context.chatId) || context.chatId === 0
    || !Number.isSafeInteger(context.messageThreadId) || context.messageThreadId <= 0) {
    throw new Error("Invalid task guard context");
  }
  return database.transaction(() => {
    const result: TaskContextGuard = { safe: true, activeJobs: 0, unresolvedDeliveries: 0, unconfirmedPlans: 0 };
    const rows = database.prepare(`SELECT jobs.id, jobs.projection_json FROM jobs
      JOIN inbox_updates ON inbox_updates.job_id = jobs.id
      WHERE inbox_updates.bot_id = @botId AND CASE WHEN json_valid(inbox_updates.source_json) THEN CASE
        WHEN json_type(inbox_updates.source_json, '$.chatId') IS NOT 'integer'
          OR json_extract(inbox_updates.source_json, '$.chatId') = 0
          OR (json_type(inbox_updates.source_json, '$.messageThreadId') IS NOT 'integer'
            AND json_type(inbox_updates.source_json, '$.messageThreadId') IS NOT 'null')
          OR json_extract(inbox_updates.source_json, '$.messageThreadId') <= 0
          OR (json_type(inbox_updates.source_json, '$.targetContext') IS NOT NULL AND (
            json_type(inbox_updates.source_json, '$.targetContext') IS NOT 'object'
            OR json_type(inbox_updates.source_json, '$.targetContext.chatId') IS NOT 'integer'
            OR json_extract(inbox_updates.source_json, '$.targetContext.chatId') = 0
            OR json_type(inbox_updates.source_json, '$.targetContext.messageThreadId') IS NOT 'integer'
            OR json_extract(inbox_updates.source_json, '$.targetContext.messageThreadId') <= 0)) THEN 1
        ELSE COALESCE(json_extract(inbox_updates.source_json, '$.targetContext.chatId'),
          json_extract(inbox_updates.source_json, '$.chatId')) = @chatId
        AND COALESCE(json_extract(inbox_updates.source_json, '$.targetContext.messageThreadId'),
          json_extract(inbox_updates.source_json, '$.messageThreadId')) = @messageThreadId
        END ELSE 1 END`).all(context) as { id: string; projection_json: string }[];
    const deliveries = database.prepare("SELECT part_key, state, telegram_message_id FROM deliveries WHERE job_id = ?");
    for (const row of rows) {
      let job: TelegramJob;
      try {
        job = JSON.parse(row.projection_json);
        if (transitionJob(job, { schemaVersion: 1, type: "activity.observed", eventAt: job.updatedAt }).kind === "conflict") {
          result.activeJobs++; continue;
        }
      }
      catch { result.activeJobs++; continue; }
      if (!job || job.phase !== "terminal" || !["completed", "failed", "aborted", "recovery_interrupted"].includes(job.outcome ?? "")) result.activeJobs++;
      const parts = deliveries.all(row.id) as { part_key: string; state: string; telegram_message_id: number | null }[];
      result.unresolvedDeliveries += parts.filter(part => part.state !== "delivered" || part.telegram_message_id === null).length;
      if (job?.phase === "terminal" && job.outcome === "completed") {
        if (!Array.isArray(job.responsePlan)) result.unconfirmedPlans++;
        else for (const planned of job.responsePlan) {
          if (!planned || typeof planned.partId !== "string" || !parts.some(part => part.part_key === planned.partId
            && part.state === "delivered" && part.telegram_message_id !== null)) result.unconfirmedPlans++;
        }
      }
    }
    result.safe = result.activeJobs === 0 && result.unresolvedDeliveries === 0 && result.unconfirmedPlans === 0;
    return result;
  })();
}
