import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SessionGuardianIpcClient,
  SessionGuardianIpcServer,
} from "../src/session-guardian-ipc.js";
import {
  makeStaleSocket,
  rawChunkedRequest,
  rawRequest,
  sendDribblingRequest,
  sendPartialRequest,
  startRawServer,
} from "./session-guardian-ipc-fixtures.js";

const ALERT_ID = "abcdefghijklmnopqrstuv";
const THREAD_ID = "01a02451-2fc4-76c0-9f14-c75034c10017";

describe("session guardian IPC", () => {
  let directory: string;
  let socketPath: string;
  let server: SessionGuardianIpcServer | undefined;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-guardian-ipc-"));
    socketPath = path.join(directory, "run", "guardian.sock");
  });

  afterEach(async () => {
    await server?.close();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createServer(overrides: Partial<ConstructorParameters<typeof SessionGuardianIpcServer>[0]> = {}) {
    server = new SessionGuardianIpcServer({
      socketPath,
      status: vi.fn(async () => ({ outcome: "ok", message: "Guardian is ready" })),
      checkAlert: vi.fn(async () => ({
        outcome: "observation-only",
        threadId: THREAD_ID,
        detail: "ignored internal detail",
      })),
      repairAlert: vi.fn(async () => ({
        outcome: "restored",
        threadId: THREAD_ID,
        detail: "ignored internal detail",
      })),
      ...overrides,
    });
    return server;
  }

  it("serves status, check, and repair over the exact Unix socket routes", async () => {
    const subject = createServer();
    await subject.start();
    const client = new SessionGuardianIpcClient(socketPath);

    await expect(client.status()).resolves.toEqual({
      outcome: "ok",
      message: "Guardian is ready",
    });
    await expect(client.checkAlert(ALERT_ID)).resolves.toEqual({
      outcome: "observation-only",
      message: "Observation-only check completed",
      threadId: THREAD_ID,
    });
    await expect(client.repairAlert(ALERT_ID)).resolves.toEqual({
      outcome: "restored",
      message: "Session restored",
      threadId: THREAD_ID,
    });
    expect(subject.dependencies.checkAlert).toHaveBeenCalledWith(ALERT_ID);
    expect(subject.dependencies.repairAlert).toHaveBeenCalledWith(ALERT_ID);
  });

  it.each([
    ["GET", `/v1/alerts/${ALERT_ID}/repair`, 405],
    ["POST", "/v1/status", 405],
    ["POST", "/v1/alerts/short/repair", 404],
    ["POST", `/v1/alerts/${ALERT_ID}%2Fextra/repair`, 404],
    ["POST", `/v1/alerts/${ALERT_ID}/repair?again=1`, 404],
    ["DELETE", "/other", 404],
  ])("rejects %s %s", async (method, route, expectedStatus) => {
    await createServer().start();
    const response = await rawRequest(socketPath, method, route);
    expect(response.status).toBe(expectedStatus);
    expect(response.json).toMatchObject({ outcome: "failed" });
  });

  it("accepts empty or small JSON object POST bodies and rejects malformed bodies", async () => {
    const subject = createServer();
    await subject.start();

    expect((await rawRequest(socketPath, "POST", `/v1/alerts/${ALERT_ID}/check`)).status).toBe(200);
    expect((await rawRequest(
      socketPath,
      "POST",
      `/v1/alerts/${ALERT_ID}/check`,
      "{}",
      { "content-type": "application/json" },
    )).status).toBe(200);
    expect((await rawRequest(
      socketPath,
      "POST",
      `/v1/alerts/${ALERT_ID}/check`,
      "{",
      { "content-type": "application/json" },
    )).status).toBe(400);
    expect((await rawRequest(
      socketPath,
      "POST",
      `/v1/alerts/${ALERT_ID}/check`,
      "[]",
      { "content-type": "application/json" },
    )).status).toBe(400);
    expect((await rawRequest(
      socketPath,
      "POST",
      `/v1/alerts/${ALERT_ID}/check`,
      "{}",
      { "content-type": "text/plain" },
    )).status).toBe(415);
    expect(subject.dependencies.checkAlert).toHaveBeenCalledTimes(2);
  });

  it("caps declared and chunked request bodies at 4 KiB", async () => {
    await createServer().start();
    const oversized = JSON.stringify({ data: "x".repeat(4097) });

    const declared = await rawRequest(
      socketPath,
      "POST",
      `/v1/alerts/${ALERT_ID}/repair`,
      oversized,
      { "content-type": "application/json" },
    );
    expect(declared.status).toBe(413);

    const chunked = await rawChunkedRequest(
      socketPath,
      `/v1/alerts/${ALERT_ID}/repair`,
      ["{\"data\":\"", "x".repeat(4097), "\"}"],
    );
    expect(chunked.status).toBe(413);
  });

  it("rejects chunked overflow immediately without waiting for EOF", async () => {
    await createServer().start();
    const response = await sendPartialRequest(socketPath,
      `POST /v1/alerts/${ALERT_ID}/repair HTTP/1.1\r\n`
      + "Host: localhost\r\nContent-Type: application/json\r\n"
      + "Transfer-Encoding: chunked\r\n\r\n"
      + `1001\r\n${"x".repeat(4097)}\r\n`,
    );

    expect(response).toContain("413 Payload Too Large");
    expect(response).toContain("Guardian IPC request body is too large");
  });

  it("applies a hard request-body deadline despite slow incoming chunks", async () => {
    await createServer({ bodyReadTimeoutMs: 45 }).start();
    const response = await sendDribblingRequest(socketPath,
      `POST /v1/alerts/${ALERT_ID}/repair HTTP/1.1\r\n`
      + "Host: localhost\r\nContent-Type: application/json\r\n"
      + "Transfer-Encoding: chunked\r\n\r\n",
    );

    expect(response).toContain("408 Request Timeout");
    expect(response).toContain("Guardian IPC request body timed out");
    await expect(Promise.race([
      server!.close().then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 250)),
    ])).resolves.toBe("closed");
  });

  it("sanitizes dependency failures and never returns raw error text", async () => {
    await createServer({
      repairAlert: vi.fn(async () => {
        throw new Error("secret prompt and stack /root/.env");
      }),
    }).start();

    const response = await rawRequest(socketPath, "POST", `/v1/alerts/${ALERT_ID}/repair`);
    expect(response.status).toBe(503);
    expect(response.text).not.toContain("secret prompt");
    expect(response.text).not.toContain(".env");
    expect(response.json).toEqual({ outcome: "failed", message: "Guardian operation failed" });
  });

  it("does not forward arbitrary status detail across the IPC boundary", async () => {
    await createServer({
      status: vi.fn(async () => ({
        outcome: "degraded",
        message: "secret prompt /root/.env raw status detail",
      })),
    }).start();

    const response = await rawRequest(socketPath, "GET", "/v1/status");

    expect(response.json).toEqual({ outcome: "degraded", message: "Guardian is degraded" });
    expect(response.text).not.toContain("secret prompt");
  });

  it("bounds client timeouts and response bodies with stable errors", async () => {
    const hanging = await startRawServer(socketPath, () => undefined);
    const timed = new SessionGuardianIpcClient(socketPath, { requestTimeoutMs: 20 });
    await expect(timed.status()).rejects.toThrow("Guardian IPC request timed out");
    await new Promise<void>((resolve) => hanging.close(() => resolve()));

    const hugeSocketPath = `${socketPath}.huge`;
    const hugeServer = await startRawServer(hugeSocketPath, (_req, response) => {
      response.end(JSON.stringify({ outcome: "ok", message: "x".repeat(5000) }));
    });
    const capped = new SessionGuardianIpcClient(hugeSocketPath, { maxResponseBytes: 1024 });
    await expect(capped.status()).rejects.toThrow("Guardian IPC response is too large");
    await new Promise<void>((resolve) => hugeServer.close(() => resolve()));
  });

  it("uses a wall-clock deadline even while response bytes keep arriving", async () => {
    let stoppedResolve!: () => void;
    const stopped = new Promise<void>((resolve) => { stoppedResolve = resolve; });
    const dribbling = await startRawServer(socketPath, (_req, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      const interval = setInterval(() => response.write(" "), 10);
      response.once("close", () => {
        clearInterval(interval);
        stoppedResolve();
      });
    });
    const client = new SessionGuardianIpcClient(socketPath, { requestTimeoutMs: 45 });
    const startedAt = Date.now();

    await expect(client.status()).rejects.toThrow("Guardian IPC request timed out");

    expect(Date.now() - startedAt).toBeLessThan(250);
    await expect(Promise.race([
      stopped.then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 250)),
    ])).resolves.toBe("closed");
    await new Promise<void>((resolve) => dribbling.close(() => resolve()));
  });

  it("rejects malformed and non-successful responses stably", async () => {
    const fake = await startRawServer(socketPath, (_req, response) => {
      response.statusCode = 200;
      response.end("not-json secret");
    });
    const client = new SessionGuardianIpcClient(socketPath);
    await expect(client.status()).rejects.toThrow("Guardian IPC returned an invalid response");
    await new Promise<void>((resolve) => fake.close(() => resolve()));

    const invalidSocketPath = `${socketPath}.invalid`;
    const invalid = await startRawServer(invalidSocketPath, (_req, response) => {
      response.end(JSON.stringify({ outcome: "ok" }));
    });
    const invalidClient = new SessionGuardianIpcClient(invalidSocketPath, { requestTimeoutMs: 100 });
    await expect(Promise.race([
      invalidClient.status(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("client stayed pending")), 250)),
    ])).rejects.toThrow("Guardian IPC returned an invalid response");
    await new Promise<void>((resolve) => invalid.close(() => resolve()));

    const failedSocketPath = `${socketPath}.failed`;
    const failed = await startRawServer(failedSocketPath, (_req, response) => {
      response.statusCode = 503;
      response.end(JSON.stringify({ outcome: "failed", message: "internal secret" }));
    });
    const failedClient = new SessionGuardianIpcClient(failedSocketPath);
    await expect(failedClient.status()).rejects.toThrow("Guardian IPC request failed with status 503");
    await new Promise<void>((resolve) => failed.close(() => resolve()));
  });

  it("rejects non-string outcomes without invoking coercion", async () => {
    const coercion = vi.fn(() => "ok");
    await createServer({
      status: vi.fn(async () => ({
        outcome: { toString: coercion },
        message: "hostile",
      } as never)),
      repairAlert: vi.fn(async () => ({
        outcome: { toString: coercion },
        detail: "hostile",
      } as never)),
    }).start();

    expect((await rawRequest(socketPath, "GET", "/v1/status")).status).toBe(503);
    expect((await rawRequest(
      socketPath,
      "POST",
      `/v1/alerts/${ALERT_ID}/repair`,
    )).status).toBe(503);
    expect(coercion).not.toHaveBeenCalled();

    await server!.close();
    const rawSocket = `${socketPath}.hostile`;
    const raw = await startRawServer(rawSocket, (_req, res) => {
      res.end(JSON.stringify({ outcome: ["ok"], message: "hostile" }));
    });
    await expect(new SessionGuardianIpcClient(rawSocket).status()).rejects.toThrow(
      "Guardian IPC returned an invalid response",
    );
    await new Promise<void>((resolve) => raw.close(() => resolve()));
  });

  it("creates a private socket parent, sets mode 0600, cleans up, and closes idempotently", async () => {
    const originalUmask = process.umask(0o002);
    const subject = createServer();
    try {
      await subject.start();
      expect(lstatSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
      expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
      expect(process.umask()).toBe(0o002);

      await subject.close();
      await subject.close();
      expect(() => lstatSync(socketPath)).toThrow();
    } finally {
      process.umask(originalUmask);
    }
  });

  it("rejects an existing non-private socket parent", async () => {
    mkdirSync(path.dirname(socketPath), { recursive: true });
    chmodSync(path.dirname(socketPath), 0o755);

    await expect(createServer().start()).rejects.toThrow(
      "Guardian IPC parent is not a safe directory",
    );
    expect(() => lstatSync(socketPath)).toThrow();
  });

  it("recovers an owned stale socket but rejects regular files and symlinks", async () => {
    makeStaleSocket(socketPath);
    await createServer().start();
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    await server!.close();

    writeFileSync(socketPath, "keep");
    await expect(createServer().start()).rejects.toThrow("Guardian IPC path is not a safe stale socket");
    expect(readFileSync(socketPath, "utf8")).toBe("keep");
    rmSync(socketPath);

    writeFileSync(path.join(directory, "target"), "keep");
    execFileSync("ln", ["-s", path.join(directory, "target"), socketPath]);
    await expect(createServer().start()).rejects.toThrow("Guardian IPC path is not a safe stale socket");
    expect(lstatSync(socketPath).isSymbolicLink()).toBe(true);
  });

  it("rejects and preserves an active existing Unix socket", async () => {
    const active = await startRawServer(socketPath, (_req, response) => {
      const body = JSON.stringify({ outcome: "ok", message: "existing listener" });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    });
    try {
      await expect(createServer().start()).rejects.toThrow(
        "Guardian IPC socket is already active",
      );
      expect(lstatSync(socketPath).isSocket()).toBe(true);
      const response = await rawRequest(socketPath, "GET", "/still-live");
      expect(response.status).toBe(200);
      expect(response.json.outcome).toBe("ok");
    } finally {
      await new Promise<void>((resolve) => active.close(() => resolve()));
    }
  });

  it("forces partial active connections closed during bounded shutdown", async () => {
    const subject = createServer();
    await subject.start();
    const client = createConnection({ path: socketPath });
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    const disconnected = new Promise<void>((resolve) => client.once("close", () => resolve()));
    client.write(
      `POST /v1/alerts/${ALERT_ID}/repair HTTP/1.1\r\n`
      + "Host: localhost\r\nContent-Type: application/json\r\n"
      + "Transfer-Encoding: chunked\r\n\r\n5\r\n{",
    );

    await expect(Promise.race([
      subject.close().then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 250)),
    ])).resolves.toBe("closed");
    await expect(disconnected).resolves.toBeUndefined();
    expect(client.destroyed).toBe(true);
    expect(() => lstatSync(socketPath)).toThrow();
    await expect(subject.close()).resolves.toBeUndefined();
  });

  it("drains active guardian operations before close resolves", async () => {
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    let repairResolve!: (value: {
      outcome: "restored";
      threadId: string;
      detail: string;
    }) => void;
    const repair = new Promise<{
      outcome: "restored";
      threadId: string;
      detail: string;
    }>((resolve) => { repairResolve = resolve; });
    const subject = createServer({
      repairAlert: vi.fn(async () => {
        enteredResolve();
        return await repair;
      }),
    });
    await subject.start();
    const requestResult = new SessionGuardianIpcClient(socketPath)
      .repairAlert(ALERT_ID)
      .catch(() => undefined);
    await entered;

    const closing = subject.close();
    await expect(Promise.race([
      closing.then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 30)),
    ])).resolves.toBe("pending");
    repairResolve({ outcome: "restored", threadId: THREAD_ID, detail: "done" });

    await expect(closing).resolves.toBeUndefined();
    await requestResult;
    expect(() => lstatSync(socketPath)).toThrow();
  });

  it("treats close as terminal across cached and concurrent starts", async () => {
    const subject = createServer();
    const starting = subject.start();
    const closing = subject.close();
    await starting;
    await closing;

    await expect(subject.start()).rejects.toThrow("Guardian IPC server is closed");
  });

  it("cleans a failed start and leaves the server terminal", async () => {
    mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    writeFileSync(socketPath, "preserve");
    const subject = createServer();

    await expect(subject.start()).rejects.toThrow(
      "Guardian IPC path is not a safe stale socket",
    );
    await expect(subject.close()).resolves.toBeUndefined();
    expect(readFileSync(socketPath, "utf8")).toBe("preserve");
    await expect(subject.start()).rejects.toThrow("Guardian IPC server is closed");

    rmSync(socketPath);
    const successor = createServer();
    await expect(successor.start()).resolves.toBeUndefined();
    await successor.close();
  });

  it("does not remove a replacement placed at the socket path during shutdown", async () => {
    const subject = createServer();
    await subject.start();
    const moved = `${socketPath}.original`;
    execFileSync("mv", [socketPath, moved]);
    writeFileSync(socketPath, "replacement");
    chmodSync(socketPath, 0o600);

    await subject.close();

    expect(readFileSync(socketPath, "utf8")).toBe("replacement");
  });

  it.each(["relative.sock", "", "/tmp/bad\0socket"])("rejects an invalid socket path %j", (value) => {
    expect(() => new SessionGuardianIpcClient(value)).toThrow("Guardian IPC socket path must be absolute");
  });
});
