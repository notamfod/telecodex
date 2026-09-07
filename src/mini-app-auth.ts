import { createHmac, timingSafeEqual } from "node:crypto";

export interface TelegramMiniAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramMiniAppSession {
  user: TelegramMiniAppUser;
  authDate: number;
}

export interface TelegramInitDataOptions {
  botToken: string;
  allowedUserIds: ReadonlySet<number>;
  maxAgeSeconds: number;
  nowSeconds?: number;
}

export function validateTelegramInitData(
  initData: string,
  options: TelegramInitDataOptions,
): TelegramMiniAppSession {
  const params = new URLSearchParams(initData);
  const suppliedHash = params.get("hash");
  if (!suppliedHash || !/^[0-9a-f]{64}$/i.test(suppliedHash)) {
    throw new Error("Invalid Telegram Mini App signature");
  }
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(options.botToken).digest();
  const expectedHash = createHmac("sha256", secret).update(dataCheckString).digest();
  const actualHash = Buffer.from(suppliedHash, "hex");
  if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) {
    throw new Error("Invalid Telegram Mini App signature");
  }

  const authDate = Number(params.get("auth_date"));
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(authDate) || authDate <= 0 || nowSeconds - authDate > options.maxAgeSeconds) {
    throw new Error("Telegram Mini App session expired");
  }
  if (authDate > nowSeconds + 30) {
    throw new Error("Telegram Mini App session is not active yet");
  }

  const user = parseUser(params.get("user"));
  if (!options.allowedUserIds.has(user.id)) {
    throw new Error("Telegram user is not allowed");
  }
  return { user, authDate };
}

function parseUser(raw: string | null): TelegramMiniAppUser {
  try {
    const user = JSON.parse(raw ?? "null") as Partial<TelegramMiniAppUser> | null;
    if (
      !user
      || !Number.isSafeInteger(user.id)
      || Number(user.id) <= 0
      || typeof user.first_name !== "string"
    ) {
      throw new Error("invalid user");
    }
    return user as TelegramMiniAppUser;
  } catch {
    throw new Error("Invalid Telegram Mini App user");
  }
}
