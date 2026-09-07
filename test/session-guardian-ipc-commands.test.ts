import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionGuardianIpcClient, SessionGuardianIpcServer } from "../src/session-guardian-ipc.js";
import { rawRequest, startRawServer } from "./session-guardian-ipc-fixtures.js";

const THREAD_ID = "01a02451-2fc4-76c0-9f14-c75034c10017";
const ALERT_ID = "abcdefghijklmnopqrstuv";

function legacyThreadProjection(thread: {
  readonly threadId: string; readonly turnId: string | null;
  readonly threadStatus: string; readonly turnStatus: string | null;
  readonly updatedAt: number; readonly itemCount: number; readonly lastItemType: string | null;
  readonly source: string; readonly canAcceptDirectInput: boolean; readonly root: boolean;
}): object {
  return { threadId: thread.threadId, turnId: thread.turnId, threadStatus: thread.threadStatus,
    turnStatus: thread.turnStatus, updatedAt: thread.updatedAt, itemCount: thread.itemCount,
    lastItemType: thread.lastItemType, source: thread.source,
    canAcceptDirectInput: thread.canAcceptDirectInput, root: thread.root };
}

describe("session guardian command IPC", () => {
  let directory = "";
  let socketPath = "";
  let server: SessionGuardianIpcServer | undefined;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "guardian-command-ipc-"));
    socketPath = path.join(directory, "guardian.sock");
  });
  afterEach(async () => {
    await server?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("serves scan, exact inspect, and exact manual repair with bounded schemas", async () => {
    server = new SessionGuardianIpcServer({
      socketPath,
      status: async () => ({ outcome: "ok", message: "ready", status: {
        running: true, observationOnly: true, repairEnabled: false,
        appServerConnected: true, scanStale: false, scans: 1, lastScanAt: 10,
        queueDepth: 2, activeOperation: "scan", scanPhase: "app-read",
        inspectionCount: 1, activeSince: 9,
      } }),
      checkAlert: async () => ({ outcome: "observation-only", threadId: THREAD_ID,
        detail: "Observation-only mode" }),
      repairAlert: async () => ({ outcome: "restored", threadId: THREAD_ID,
        detail: "Thread restored" }),
      scan: vi.fn(async () => ({ scanned: 3, detectedAlerts: 1,
        deliveredAlerts: 1, failedDeliveries: 0 })),
      inspectThread: vi.fn(async () => ({
        threadId: THREAD_ID, turnId: null, threadStatus: "idle", turnStatus: "completed",
        updatedAt: 10, itemCount: 3, lastItemType: "agentMessage", source: "remote",
        canAcceptDirectInput: true, root: true,
        observation: {
          guardianHealth: "healthy", lastObservedAt: 10, unchangedSince: 5, staleForMs: 5,
          alertId: null, repairState: "none", repairOutcome: null,
        },
      })),
      repairThread: vi.fn(async () => ({ outcome: "restored", threadId: THREAD_ID,
        detail: "secret internal detail" })),
    });
    await server.start();
    const client = new SessionGuardianIpcClient(socketPath);

    await expect(client.status()).resolves.toMatchObject({
      status: { observationOnly: true, scanStale: false, queueDepth: 2,
        activeOperation: "scan", scanPhase: "app-read", inspectionCount: 1,
        activeSince: 9 },
    });
    await expect(client.scan()).resolves.toMatchObject({ scan: { scanned: 3 } });
    const inspected = await client.inspectThread(THREAD_ID);
    expect(inspected).toMatchObject({
      threadId: THREAD_ID, thread: { source: "remote", itemCount: 3,
        observation: { guardianHealth: "healthy", repairState: "none" } },
    });
    expect(legacyThreadProjection(inspected.thread!)).toEqual({
      threadId: THREAD_ID, turnId: null, threadStatus: "idle", turnStatus: "completed",
      updatedAt: 10, itemCount: 3, lastItemType: "agentMessage", source: "remote",
      canAcceptDirectInput: true, root: true,
    });
    await expect(client.repairThread(THREAD_ID)).resolves.toEqual({
      outcome: "restored", message: "Session restored", threadId: THREAD_ID,
    });
  });

  it.each([
    ["POST", "/v1/scan?again=1"],
    ["GET", `/v1/threads/${THREAD_ID}%2Fextra`],
    ["GET", `/v1/threads/${THREAD_ID}?x=1`],
    ["POST", "/v1/threads/recent/repair"],
    ["POST", `/v1/threads/${THREAD_ID}/repair/extra`],
  ])("rejects ambiguous command route %s %s", async (method, route) => {
    server = new SessionGuardianIpcServer({
      socketPath, status: async () => ({ outcome: "ok", message: "ready" }),
      checkAlert: async () => ({ outcome: "expired", detail: "Alert not found" }),
      repairAlert: async () => ({ outcome: "expired", detail: "Alert not found" }),
    });
    await server.start();
    expect((await rawRequest(socketPath, method, route)).status).toBe(404);
  });

  it("rejects a valid base response that omits the command-specific schema", async () => {
    const raw = await startRawServer(socketPath, (_request, response) => {
      response.end(JSON.stringify({ outcome: "ok", message: "Guardian is ready" }));
    });
    const client = new SessionGuardianIpcClient(socketPath);
    await expect(client.scan()).rejects.toThrow("invalid response");
    await expect(client.inspectThread(THREAD_ID)).rejects.toThrow("invalid response");
    await new Promise<void>((resolve) => raw.close(() => resolve()));
  });

  it("requires operation observability fields at both Guardian status IPC boundaries", async () => {
    server = new SessionGuardianIpcServer({
      socketPath,
      status: async () => ({ outcome: "ok", message: "ready", status: {
        running: true, observationOnly: true, repairEnabled: false,
        appServerConnected: true, scanStale: false, scans: 1, lastScanAt: 10,
      } } as never),
      checkAlert: async () => ({ outcome: "expired", detail: "Alert not found" }),
      repairAlert: async () => ({ outcome: "expired", detail: "Alert not found" }),
    });
    await server.start();
    expect((await rawRequest(socketPath, "GET", "/v1/status")).status).toBe(503);
    await server.close();
    server = undefined;

    const raw = await startRawServer(socketPath, (_request, response) => {
      response.end(JSON.stringify({
        outcome: "ok", message: "Guardian is ready", status: {
          running: true, observationOnly: true, repairEnabled: false,
          appServerConnected: true, scanStale: false, scans: 1, lastScanAt: 10,
        },
      }));
    });
    await expect(new SessionGuardianIpcClient(socketPath).status())
      .rejects.toThrow("invalid response");
    await new Promise<void>((resolve) => raw.close(() => resolve()));
  });

  it("accepts the legacy inspection shape without the optional observation", async () => {
    const raw = await startRawServer(socketPath, (_request, response) => {
      response.end(JSON.stringify({
        outcome: "ok", message: "Guardian thread inspected", threadId: THREAD_ID,
        thread: {
          threadId: THREAD_ID, turnId: null, threadStatus: "idle", turnStatus: "completed",
          updatedAt: 10, itemCount: 1, lastItemType: "agentMessage", source: "remote",
          canAcceptDirectInput: true, root: true,
        },
      }));
    });

    await expect(new SessionGuardianIpcClient(socketPath).inspectThread(THREAD_ID))
      .resolves.toMatchObject({ thread: { threadId: THREAD_ID } });
    await new Promise<void>((resolve) => raw.close(() => resolve()));
  });

  it("requires successful inspect and repair responses to carry the exact requested UUID", async () => {
    const other = "01a02451-2fc4-76c0-9f14-c75034c10019";
    let responseBody: object = { outcome: "restored", message: "Session restored" };
    const raw = await startRawServer(socketPath, (_request, response) => {
      response.end(JSON.stringify(responseBody));
    });
    const client = new SessionGuardianIpcClient(socketPath);
    await expect(client.repairThread(THREAD_ID)).rejects.toThrow("invalid response");
    responseBody = { outcome: "restored", message: "Session restored", threadId: other };
    await expect(client.repairThread(THREAD_ID)).rejects.toThrow("invalid response");
    responseBody = { outcome: "ok", message: "Guardian thread inspected", threadId: other,
      thread: { threadId: other, turnId: null, threadStatus: "idle", turnStatus: "completed",
        updatedAt: 10, itemCount: 1, lastItemType: "agentMessage", source: "remote",
        canAcceptDirectInput: true, root: true } };
    await expect(client.inspectThread(THREAD_ID)).rejects.toThrow("invalid response");
    await new Promise<void>((resolve) => raw.close(() => resolve()));
  });

  it("preserves the exact unknown-thread IPC failure status and body", async () => {
    const inspectThread = vi.fn(async () => { throw new Error("unknown thread"); });
    const checkAlert = vi.fn(async () => ({ outcome: "expired" as const,
      detail: "Alert not found" }));
    const repairAlert = vi.fn(async () => ({ outcome: "expired" as const,
      detail: "Alert not found" }));
    server = new SessionGuardianIpcServer({
      socketPath, status: async () => ({ outcome: "ok", message: "ready" }),
      checkAlert, repairAlert, inspectThread,
    });
    await server.start();

    const response = await rawRequest(socketPath, "GET", `/v1/threads/${THREAD_ID}`);

    expect(response.status).toBe(503);
    expect(response.json).toEqual({ outcome: "failed", message: "Guardian operation failed" });
    expect(inspectThread).toHaveBeenCalledWith(THREAD_ID);
    expect(checkAlert).not.toHaveBeenCalled();
    expect(repairAlert).not.toHaveBeenCalled();
  });

  it("sanitizes daemon dependencies that return a missing or different thread UUID", async () => {
    const other = "01a02451-2fc4-76c0-9f14-c75034c10019";
    server = new SessionGuardianIpcServer({
      socketPath, status: async () => ({ outcome: "ok", message: "ready" }),
      checkAlert: async () => ({ outcome: "expired", detail: "Alert not found" }),
      repairAlert: async () => ({ outcome: "expired", detail: "Alert not found" }),
      repairThread: async () => ({ outcome: "restored", detail: "Thread restored" }),
      inspectThread: async () => ({ threadId: other, turnId: null, threadStatus: "idle",
        turnStatus: "completed", updatedAt: 10, itemCount: 1, lastItemType: "agentMessage",
        source: "remote", canAcceptDirectInput: true, root: true }),
    });
    await server.start();
    expect((await rawRequest(socketPath, "POST", `/v1/threads/${THREAD_ID}/repair`)).status)
      .toBe(503);
    expect((await rawRequest(socketPath, "GET", `/v1/threads/${THREAD_ID}`)).status).toBe(503);
  });

  it("rejects unknown fields in observation payloads at both IPC boundaries", async () => {
    const observation = {
      guardianHealth: "healthy", lastObservedAt: 10, unchangedSince: 5, staleForMs: 5,
      alertId: null, repairState: "none", repairOutcome: null, secret: "/root/.env",
    } as const;
    server = new SessionGuardianIpcServer({
      socketPath, status: async () => ({ outcome: "ok", message: "ready" }),
      checkAlert: async () => ({ outcome: "expired", detail: "Alert not found" }),
      repairAlert: async () => ({ outcome: "expired", detail: "Alert not found" }),
      inspectThread: async () => ({
        threadId: THREAD_ID, turnId: null, threadStatus: "idle", turnStatus: "completed",
        updatedAt: 10, itemCount: 1, lastItemType: "agentMessage", source: "remote",
        canAcceptDirectInput: true, root: true, observation,
      } as never),
    });
    await server.start();
    expect((await rawRequest(socketPath, "GET", `/v1/threads/${THREAD_ID}`)).status).toBe(503);
    await server.close();
    server = undefined;

    const raw = await startRawServer(socketPath, (_request, response) => {
      response.end(JSON.stringify({
        outcome: "ok", message: "Guardian thread inspected", threadId: THREAD_ID,
        thread: {
          threadId: THREAD_ID, turnId: null, threadStatus: "idle", turnStatus: "completed",
          updatedAt: 10, itemCount: 1, lastItemType: "agentMessage", source: "remote",
          canAcceptDirectInput: true, root: true, observation,
        },
      }));
    });
    await expect(new SessionGuardianIpcClient(socketPath).inspectThread(THREAD_ID))
      .rejects.toThrow("invalid response");
    await new Promise<void>((resolve) => raw.close(() => resolve()));
  });

  it("rejects incoherent observation repair state at both IPC boundaries", async () => {
    const thread = (observation: object) => ({
      threadId: THREAD_ID, turnId: null, threadStatus: "idle", turnStatus: "completed",
      updatedAt: 10, itemCount: 1, lastItemType: "agentMessage", source: "remote",
      canAcceptDirectInput: true, root: true, observation,
    });
    server = new SessionGuardianIpcServer({
      socketPath, status: async () => ({ outcome: "ok", message: "ready" }),
      checkAlert: async () => ({ outcome: "expired", detail: "Alert not found" }),
      repairAlert: async () => ({ outcome: "expired", detail: "Alert not found" }),
      inspectThread: async () => thread({
        guardianHealth: "stalled", lastObservedAt: 10, unchangedSince: 5, staleForMs: 5,
        alertId: ALERT_ID, repairState: "terminal", repairOutcome: null,
      }) as never,
    });
    await server.start();
    expect((await rawRequest(socketPath, "GET", `/v1/threads/${THREAD_ID}`)).status).toBe(503);
    await server.close();
    server = undefined;

    const raw = await startRawServer(socketPath, (_request, response) => {
      response.end(JSON.stringify({
        outcome: "ok", message: "Guardian thread inspected", threadId: THREAD_ID,
        thread: thread({
          guardianHealth: "healthy", lastObservedAt: 10, unchangedSince: 5, staleForMs: 5,
          alertId: ALERT_ID, repairState: "none", repairOutcome: null,
        }),
      }));
    });
    await expect(new SessionGuardianIpcClient(socketPath).inspectThread(THREAD_ID))
      .rejects.toThrow("invalid response");
    await new Promise<void>((resolve) => raw.close(() => resolve()));
  });

  it("rejects guardian health that contradicts repair state at both IPC boundaries", async () => {
    const thread = (observation: object) => ({
      threadId: THREAD_ID, turnId: null, threadStatus: "idle", turnStatus: "completed",
      updatedAt: 10, itemCount: 1, lastItemType: "agentMessage", source: "remote",
      canAcceptDirectInput: true, root: true, observation,
    });
    const mismatches = [
      { guardianHealth: "stalled", alertId: null, repairState: "none", repairOutcome: null },
      { guardianHealth: "healthy", alertId: ALERT_ID,
        repairState: "eligible", repairOutcome: null },
      { guardianHealth: "stalled", alertId: ALERT_ID,
        repairState: "in_progress", repairOutcome: null },
      { guardianHealth: "healthy", alertId: ALERT_ID,
        repairState: "terminal", repairOutcome: "failed" },
    ].map((value) => ({ ...value,
      lastObservedAt: 10, unchangedSince: 5, staleForMs: 5 }));
    let serverIndex = 0;
    server = new SessionGuardianIpcServer({
      socketPath, status: async () => ({ outcome: "ok", message: "ready" }),
      checkAlert: async () => ({ outcome: "expired", detail: "Alert not found" }),
      repairAlert: async () => ({ outcome: "expired", detail: "Alert not found" }),
      inspectThread: async () => thread(mismatches[serverIndex++]!) as never,
    });
    await server.start();
    for (const _mismatch of mismatches) {
      expect((await rawRequest(socketPath, "GET", `/v1/threads/${THREAD_ID}`)).status).toBe(503);
    }
    await server.close();
    server = undefined;

    let clientIndex = 0;
    const raw = await startRawServer(socketPath, (_request, response) => {
      response.end(JSON.stringify({
        outcome: "ok", message: "Guardian thread inspected", threadId: THREAD_ID,
        thread: thread(mismatches[clientIndex++]!),
      }));
    });
    const client = new SessionGuardianIpcClient(socketPath);
    for (const _mismatch of mismatches) {
      await expect(client.inspectThread(THREAD_ID)).rejects.toThrow("invalid response");
    }
    await new Promise<void>((resolve) => raw.close(() => resolve()));
  });
});
