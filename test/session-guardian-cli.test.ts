import { describe, expect, it, vi } from "vitest";

import { runSessionGuardianCli } from "../src/session-guardian-cli.js";

const THREAD_ID = "01a02451-2fc4-76c0-9f14-c75034c10017";

function fixture(overrides: Record<string, unknown> = {}) {
  const output: string[] = [];
  const errors: string[] = [];
  const client = {
    status: vi.fn(async () => ({ outcome: "ok", message: "Guardian is ready",
      status: { running: true, observationOnly: true, repairEnabled: false,
        appServerConnected: true, scanStale: false, scans: 2, lastScanAt: 10 } })),
    scan: vi.fn(async () => ({ outcome: "ok", message: "Guardian scan completed",
      scan: { scanned: 4, detectedAlerts: 1, deliveredAlerts: 1, failedDeliveries: 0 } })),
    inspectThread: vi.fn(async () => ({ outcome: "ok", message: "Guardian thread inspected",
      threadId: THREAD_ID, thread: { threadId: THREAD_ID, turnId: null, threadStatus: "idle",
        turnStatus: "completed", updatedAt: 10, itemCount: 2, lastItemType: "agentMessage",
        source: "remote", canAcceptDirectInput: true, root: true } })),
    repairThread: vi.fn(async () => ({ outcome: "restored", message: "Session restored",
      threadId: THREAD_ID })),
  };
  const connect = vi.fn(() => client);
  const run = (argv: string[]) => runSessionGuardianCli(argv, {
    connect,
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    ...overrides,
  });
  return { run, client, connect, output, errors };
}

describe("session guardian CLI", () => {
  it.each([
    ["status", ["status"], "status"],
    ["scan", ["scan"], "scan"],
    ["inspect", ["inspect", THREAD_ID], "inspectThread"],
    ["repair", ["repair", THREAD_ID], "repairThread"],
  ])("runs %s over daemon IPC and prints only one JSON document", async (_name, args, method) => {
    const subject = fixture();
    await expect(subject.run(args)).resolves.toBe(0);
    expect(subject.client[method as keyof typeof subject.client]).toHaveBeenCalledTimes(1);
    expect(subject.output).toHaveLength(1);
    expect(() => JSON.parse(subject.output[0]!)).not.toThrow();
    expect(subject.errors).toEqual([]);
  });

  it("prints help without connecting and documents stable exit codes", async () => {
    const subject = fixture();
    await expect(subject.run(["--help"])).resolves.toBe(0);
    expect(subject.connect).not.toHaveBeenCalled();
    expect(subject.output.join("\n")).toContain("status");
    expect(subject.output.join("\n")).toContain("scan");
    expect(subject.output.join("\n")).toContain("inspect <UUID>");
    expect(subject.output.join("\n")).toContain("repair <UUID>");
    expect(subject.output.join("\n")).toContain("0 success");
    expect(subject.output.join("\n")).toContain("2 usage");
    expect(subject.output.join("\n")).toContain("3 daemon unavailable");
  });

  it.each([
    [[], "usage"],
    [["unknown"], "usage"],
    [["status", "extra"], "usage"],
    [["inspect"], "usage"],
    [["inspect", `${THREAD_ID}?x=1`], "UUID"],
    [["repair", "recent"], "UUID"],
  ])("returns usage exit code without connecting for %j", async (args, message) => {
    const subject = fixture();
    await expect(subject.run(args)).resolves.toBe(2);
    expect(subject.connect).not.toHaveBeenCalled();
    expect(subject.output).toEqual([]);
    expect(subject.errors).toHaveLength(1);
    const error = JSON.parse(subject.errors[0]!) as { outcome: string; message: string };
    expect(error).toMatchObject({ outcome: "failed" });
    expect(error.message).toContain(message);
    expect(subject.errors[0]).not.toContain("recent");
  });

  it("maps unavailable and timeout failures to 3 without leaking raw detail", async () => {
    for (const raw of ["Guardian IPC unavailable /root/.env", "Guardian IPC request timed out token"]) {
      const subject = fixture();
      subject.client.status.mockRejectedValueOnce(new Error(raw));
      await expect(subject.run(["status"])).resolves.toBe(3);
      expect(subject.errors).toEqual([JSON.stringify({ outcome: "failed", message: "Guardian daemon unavailable" })]);
      expect(subject.errors[0]).not.toContain(".env");
      expect(subject.errors[0]).not.toContain("token");
    }
  });

  it("maps daemon operation failure to 1", async () => {
    const subject = fixture();
    subject.client.scan.mockResolvedValueOnce({ outcome: "failed", message: "Guardian scan failed" });
    await expect(subject.run(["scan"])).resolves.toBe(1);
    expect(JSON.parse(subject.output[0]!)).toEqual({ outcome: "failed", message: "Guardian scan failed" });
  });
});
