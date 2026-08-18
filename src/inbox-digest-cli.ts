import path from "node:path";

import { loadConfig } from "./config.js";
import { InboxStore } from "./inbox.js";
import { renderInboxDigest, sendInboxDigest } from "./inbox-digest.js";
import { UsageStore } from "./usage-store.js";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const config = loadConfig();
  const stateDir = path.join(config.workspace, ".telecodex");
  const inbox = new InboxStore(path.join(stateDir, "inbox.json"));
  const usage = new UsageStore(path.join(stateDir, "token-usage.jsonl"));
  const digest = renderInboxDigest(inbox.listUnresolved(), usage.aggregate(7), {
    weeklyLimit: config.telegramWeeklyTokenLimit,
  });

  if (dryRun) {
    process.stdout.write(`${digest.plain}\n`);
    return;
  }

  const chatId = parseTelegramId("INBOX_DIGEST_CHAT_ID", process.env.INBOX_DIGEST_CHAT_ID, true);
  const topicId = parseTelegramId("INBOX_DIGEST_TOPIC_ID", process.env.INBOX_DIGEST_TOPIC_ID, false);
  await sendInboxDigest({
    token: config.telegramBotToken,
    chatId: chatId!,
    topicId,
    html: digest.html,
  });
}

function parseTelegramId(
  name: string,
  raw: string | undefined,
  required: boolean,
): number | undefined {
  if (!raw) {
    if (required) throw new Error(`${name} is required`);
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value === 0) {
    throw new Error(`${name} must be a non-zero safe integer`);
  }
  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
