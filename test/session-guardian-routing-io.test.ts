import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  closeSync: vi.fn(),
  fstatSync: vi.fn(),
  openSync: vi.fn(),
  readSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  closeSync: io.closeSync,
  fstatSync: io.fstatSync,
  openSync: io.openSync,
  readSync: io.readSync,
}));

import { SessionGuardianRouter } from "../src/session-guardian-routing.js";

const MAX_CONTEXTS_FILE_BYTES = 1024 * 1024;
const FALLBACK = { chatId: -1_009_999_999_999, messageThreadId: 777 };

describe("SessionGuardianRouter bounded descriptor IO", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    io.openSync.mockReturnValue(91);
    io.fstatSync.mockReturnValue({ isFile: () => true, size: 64 });
  });

  it("caps accumulated reads at max plus one when the file grows after fstat", () => {
    io.readSync
      .mockReturnValueOnce(700_000)
      .mockReturnValueOnce(MAX_CONTEXTS_FILE_BYTES + 1 - 700_000);

    expect(new SessionGuardianRouter("/state/contexts.json", FALLBACK).route("thread-1"))
      .toEqual(FALLBACK);

    const requested = io.readSync.mock.calls.map((call) => call[3] as number);
    expect(requested).toEqual([MAX_CONTEXTS_FILE_BYTES + 1, 348_577]);
    expect(io.readSync.mock.calls.map((call) => (call[2] as number) + (call[3] as number)))
      .toEqual([MAX_CONTEXTS_FILE_BYTES + 1, MAX_CONTEXTS_FILE_BYTES + 1]);
    expect(io.readSync.mock.results.reduce(
      (total, result) => total + (result.value as number),
      0,
    )).toBe(MAX_CONTEXTS_FILE_BYTES + 1);
    expect(io.closeSync).toHaveBeenCalledExactlyOnceWith(91);
  });

  it("closes the opened descriptor when bounded reading fails", () => {
    io.readSync.mockImplementation(() => {
      throw new Error("concurrent read failure");
    });

    expect(new SessionGuardianRouter("/state/contexts.json", FALLBACK).route("thread-1"))
      .toEqual(FALLBACK);
    expect(io.closeSync).toHaveBeenCalledExactlyOnceWith(91);
  });
});
