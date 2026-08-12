import { describe, expect, it } from "vitest";

import { parseReopenCommand, runReopenCommand } from "../src/thread-reopen.js";

describe("parseReopenCommand", () => {
  it("splits a configured command line into a program and its arguments", () => {
    expect(parseReopenCommand("/usr/bin/python3 /opt/cts.py reopen")).toEqual({
      command: "/usr/bin/python3",
      args: ["/opt/cts.py", "reopen"],
    });
  });

  it("treats an unset or blank setting as no command at all", () => {
    expect(parseReopenCommand(undefined)).toBeUndefined();
    expect(parseReopenCommand("   ")).toBeUndefined();
  });
});

describe("runReopenCommand", () => {
  it("passes the thread id as the last argument", async () => {
    await expect(
      runReopenCommand(
        {
          command: process.execPath,
          args: ["-e", "if (process.argv[1] !== 'thread-1') process.exit(3)"],
        },
        "thread-1",
      ),
    ).resolves.toBeUndefined();
  });

  it("fails loudly when the command does, rather than pretending the thread reopened", async () => {
    await expect(
      runReopenCommand({ command: process.execPath, args: ["-e", "process.exit(4)"] }, "thread-1"),
    ).rejects.toThrow("4");
  });
});
