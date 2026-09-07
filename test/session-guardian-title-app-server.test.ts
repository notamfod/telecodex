import { describe, expect, it, vi } from "vitest";

import { SessionGuardianAppServer } from "../src/session-guardian-app-server.js";

const THREAD_ID = "019ff4ea-8c36-7c5f-8f08-010101010101";
const TURN_ID = "019ff4ea-8c36-7c5f-8f08-020202020202";

function rawThread(overrides: Record<string, unknown> = {}) {
  return {
    id: THREAD_ID,
    status: { type: "active" },
    turns: [{
      id: TURN_ID,
      status: "inProgress",
      items: [{ type: "agentMessage" }],
    }],
    updatedAt: 1_723_000_000,
    source: "cli",
    cwd: "/srv/projects/telecodex",
    name: "Guardian design",
    canAcceptDirectInput: false,
    parentThreadId: null,
    ...overrides,
  };
}

function gatewayFor(thread: Record<string, unknown>): SessionGuardianAppServer {
  return new SessionGuardianAppServer({
    request: vi.fn(async (method: string) => {
      if (method !== "thread/read") throw new Error(`Unexpected method: ${method}`);
      return { thread };
    }),
    close: vi.fn(),
  });
}

describe("Guardian app-server session titles", () => {
  it.each([
    ["  Checkout recovery  ", "Checkout recovery"],
    [null, null],
    [undefined, null],
    [" \n\t ", null],
  ])("normalizes title %j", async (name, expected) => {
    await expect(gatewayFor(rawThread({ name })).readThread(THREAD_ID)).resolves.toMatchObject({
      name: expected,
    });
  });

  it.each([123, "x".repeat(513)])("rejects invalid title %j", async (name) => {
    await expect(gatewayFor(rawThread({ name })).readThread(THREAD_ID)).rejects.toThrow(
      "thread/read.thread.name",
    );
  });
});
