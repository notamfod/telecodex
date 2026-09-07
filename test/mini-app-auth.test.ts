import { createHmac } from "node:crypto";

import { validateTelegramInitData } from "../src/mini-app-auth.js";

const BOT_TOKEN = "123456:telegram-test-token";
const NOW_SECONDS = 1_787_200_000;

function signedInitData(
  values: Record<string, string>,
  botToken = BOT_TOKEN,
): string {
  const params = new URLSearchParams(values);
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", createHmac("sha256", secret).update(dataCheckString).digest("hex"));
  return params.toString();
}

function validInitData(overrides: Record<string, string> = {}): string {
  return signedInitData({
    auth_date: String(NOW_SECONDS - 30),
    query_id: "AAEAAAE",
    user: JSON.stringify({ id: 123, first_name: "Ada", username: "ada" }),
    ...overrides,
  });
}

describe("validateTelegramInitData", () => {
  it("returns the signed Telegram user when the request is fresh and allowed", () => {
    const result = validateTelegramInitData(validInitData(), {
      botToken: BOT_TOKEN,
      allowedUserIds: new Set([123]),
      nowSeconds: NOW_SECONDS,
      maxAgeSeconds: 300,
    });

    expect(result.user).toEqual({ id: 123, first_name: "Ada", username: "ada" });
    expect(result.authDate).toBe(NOW_SECONDS - 30);
  });

  it("rejects initData whose signed values were changed", () => {
    const initData = validInitData().replace("Ada", "Grace");

    expect(() => validateTelegramInitData(initData, {
      botToken: BOT_TOKEN,
      allowedUserIds: new Set([123]),
      nowSeconds: NOW_SECONDS,
      maxAgeSeconds: 300,
    })).toThrow("Invalid Telegram Mini App signature");
  });

  it("rejects expired initData", () => {
    const initData = validInitData({ auth_date: String(NOW_SECONDS - 301) });

    expect(() => validateTelegramInitData(initData, {
      botToken: BOT_TOKEN,
      allowedUserIds: new Set([123]),
      nowSeconds: NOW_SECONDS,
      maxAgeSeconds: 300,
    })).toThrow("Telegram Mini App session expired");
  });

  it("rejects a valid Telegram user outside the TeleCodex allowlist", () => {
    expect(() => validateTelegramInitData(validInitData(), {
      botToken: BOT_TOKEN,
      allowedUserIds: new Set([456]),
      nowSeconds: NOW_SECONDS,
      maxAgeSeconds: 300,
    })).toThrow("Telegram user is not allowed");
  });
});
