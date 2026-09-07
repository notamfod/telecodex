import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionGuardianRouter } from "../src/session-guardian-routing.js";
import type { GuardianRoute } from "../src/session-guardian-types.js";

const THREAD_ID = "019ff4ea-8c36-7c5f-8f08-010101010101";
const FALLBACK: GuardianRoute = { chatId: -1_009_999_999_999, messageThreadId: 777 };

describe("SessionGuardianRouter", () => {
  let directory: string;
  let contextsPath: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-guardian-routing-"));
    contextsPath = path.join(directory, ".telecodex", "contexts.json");
    mkdirSync(path.dirname(contextsPath), { recursive: true });
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function write(value: unknown): void {
    writeFileSync(contextsPath, JSON.stringify(value), "utf8");
  }

  it("routes an exact persisted binding to its Telegram forum topic", () => {
    write([
      { contextKey: "-1001234567890:42", threadId: "other", workspace: "/tmp" },
      {
        contextKey: "-1001234567890:154",
        threadId: THREAD_ID,
        workspace: "/srv/projects/telecodex",
        updatedAt: 1_723_000_000,
      },
    ]);

    expect(new SessionGuardianRouter(contextsPath, FALLBACK).route(THREAD_ID)).toEqual({
      chatId: -1_001_234_567_890,
      messageThreadId: 154,
    });
  });

  it("uses fallback when the file or thread binding is missing", () => {
    const missingPath = path.join(directory, "missing.json");
    expect(new SessionGuardianRouter(missingPath, FALLBACK).route(THREAD_ID)).toEqual(FALLBACK);
    write([{ contextKey: "-1001234567890:154", threadId: "other" }]);
    expect(new SessionGuardianRouter(contextsPath, FALLBACK).route(THREAD_ID)).toEqual(FALLBACK);
  });

  it("uses fallback for malformed JSON, top-level shape, or entries", () => {
    writeFileSync(contextsPath, "{not-json", "utf8");
    expect(new SessionGuardianRouter(contextsPath, FALLBACK).route(THREAD_ID)).toEqual(FALLBACK);
    write({ contexts: [] });
    expect(new SessionGuardianRouter(contextsPath, FALLBACK).route(THREAD_ID)).toEqual(FALLBACK);
    write([{ contextKey: 42, threadId: THREAD_ID }]);
    expect(new SessionGuardianRouter(contextsPath, FALLBACK).route(THREAD_ID)).toEqual(FALLBACK);
  });

  it("uses fallback for an unbound null context", () => {
    write([{ contextKey: "-1001234567890:154", threadId: null }]);
    expect(new SessionGuardianRouter(contextsPath, FALLBACK).route(THREAD_ID)).toEqual(FALLBACK);
  });

  it.each([
    "0:154",
    "-1001234567890:0",
    "-1001234567890:-1",
    "-1001234567890:1:2",
    "-1001234567890.5:154",
    "4503599627370496:154",
    "-1001234567890:2147483648",
    "1:4503599627370496",
    "9007199254740992:154",
  ])("uses fallback for invalid matching context key %s", (contextKey) => {
    write([{ contextKey, threadId: THREAD_ID }]);
    expect(new SessionGuardianRouter(contextsPath, FALLBACK).route(THREAD_ID)).toEqual(FALLBACK);
  });

  it("accepts the signed int32 maximum topic ID", () => {
    write([{ contextKey: `-1001234567890:${2_147_483_647}`, threadId: THREAD_ID }]);

    expect(new SessionGuardianRouter(contextsPath, FALLBACK).route(THREAD_ID)).toEqual({
      chatId: -1_001_234_567_890,
      messageThreadId: 2_147_483_647,
    });
  });

  it("uses fallback for duplicate or ambiguous exact thread bindings", () => {
    write([
      { contextKey: "-1001234567890:154", threadId: THREAD_ID },
      { contextKey: "-1001234567890:155", threadId: THREAD_ID },
    ]);
    expect(new SessionGuardianRouter(contextsPath, FALLBACK).route(THREAD_ID)).toEqual(FALLBACK);
  });

  it("rejects invalid fallback configuration and thread identifiers", () => {
    expect(() => new SessionGuardianRouter(contextsPath, { chatId: 0 })).toThrow("fallback.chatId");
    expect(() => new SessionGuardianRouter(contextsPath, {
      chatId: -1_001_234_567_890,
      messageThreadId: -1,
    })).toThrow("fallback.messageThreadId");
    expect(() => new SessionGuardianRouter(contextsPath, {
      chatId: 4_503_599_627_370_496,
    })).toThrow("fallback.chatId");
    expect(() => new SessionGuardianRouter(contextsPath, {
      chatId: 1,
      messageThreadId: 2_147_483_648,
    })).toThrow("fallback.messageThreadId");
    const router = new SessionGuardianRouter(contextsPath, FALLBACK);
    expect(() => router.route("")).toThrow("threadId");
  });

  it("uses fallback when contexts path is not a regular file", () => {
    rmSync(contextsPath, { force: true });
    mkdirSync(contextsPath);

    expect(new SessionGuardianRouter(contextsPath, FALLBACK).route(THREAD_ID)).toEqual(FALLBACK);
  });

  it("rejects a symlink even when its target is a valid contexts file", () => {
    const target = path.join(directory, "real-contexts.json");
    writeFileSync(target, JSON.stringify([
      { contextKey: "-1001234567890:154", threadId: THREAD_ID },
    ]), "utf8");
    symlinkSync(target, contextsPath);

    expect(new SessionGuardianRouter(contextsPath, FALLBACK).route(THREAD_ID)).toEqual(FALLBACK);
  });

  it("uses fallback without parsing a contexts file larger than one MiB", () => {
    const binding = JSON.stringify([{ contextKey: "-1001234567890:154", threadId: THREAD_ID }]);
    writeFileSync(contextsPath, binding + " ".repeat(1024 * 1024), "utf8");

    expect(new SessionGuardianRouter(contextsPath, FALLBACK).route(THREAD_ID)).toEqual(FALLBACK);
  });
});
