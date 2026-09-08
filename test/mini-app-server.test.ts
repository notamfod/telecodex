import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  checkTelegramApiAvailability,
  createMiniAppProbeProvider,
  startMiniAppServer,
  type RunningMiniAppServer,
} from "../src/mini-app-server.js";
import type { JiraMiniAppController } from "../src/jira-mini-app.js";

const BOT_TOKEN = "123456:telegram-test-token";
const THREAD_ID = "019fef85-92e7-7841-a26a-dbb311b50e31";
const NOW_SECONDS = 1_787_200_000;

function signedInitData(): string {
  const params = new URLSearchParams({
    auth_date: String(NOW_SECONDS),
    user: JSON.stringify({ id: 123, first_name: "Ada" }),
  });
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(dataCheckString).digest("hex"));
  return params.toString();
}

describe("Mini App HTTP server", () => {
  let staticDir: string;
  let server: RunningMiniAppServer | undefined;

  beforeEach(() => {
    staticDir = mkdtempSync(path.join(tmpdir(), "telecodex-mini-app-"));
    writeFileSync(path.join(staticDir, "index.html"), "<main>TeleCodex Mini App</main>");
    writeFileSync(path.join(staticDir, "app.js"), "console.log('mini app')");
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    rmSync(staticDir, { recursive: true, force: true });
  });

  async function start() {
    const loadDashboard = vi.fn(async () => ({ generatedAt: NOW_SECONDS * 1000, sessions: [] }));
    const ensureTopic = vi.fn(async () => ({
      created: true,
      url: "https://t.me/c/123/42",
    }));
    const jira = {
      getMySprint: vi.fn(async () => ({ view: "my-sprint" } as never)),
      getSprint: vi.fn(async () => ({ view: "sprint" } as never)),
      getBacklog: vi.fn(async () => ({ view: "backlog" } as never)),
      getKanban: vi.fn(async () => ({ view: "kanban" } as never)),
      getFilters: vi.fn(async () => ({ view: "filters" } as never)),
      runFilter: vi.fn(async () => ({ view: "filter" } as never)),
      getIssue: vi.fn(async () => ({ key: "MIR-6886" } as never)),
      ensureThread: vi.fn(async () => ({ created: false, url: "https://t.me/c/123/99" })),
    } satisfies JiraMiniAppController;
    const runJobAction = vi.fn(async () => undefined);
    server = await startMiniAppServer({
      host: "127.0.0.1",
      port: 0,
      staticDir,
      botToken: BOT_TOKEN,
      allowedUserIds: new Set([123]),
      authMaxAgeSeconds: 300,
      nowSeconds: () => NOW_SECONDS,
      loadDashboard,
      ensureTopic,
      runJobAction,
      probes: {
        health: vi.fn(async () => ({ ok: true as const, reasonCodes: [] })),
        readiness: vi.fn(async () => ({
          ok: false as const,
          reasonCodes: ["RECONCILIATION_PENDING"],
        })),
      },
      jira,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    return { server, loadDashboard, ensureTopic, runJobAction, jira };
  }

  it("serves the built app and its assets", async () => {
    const { server } = await start();

    const page = await fetch(server.url);
    const asset = await fetch(`${server.url}/app.js`);

    expect(page.status).toBe(200);
    expect(await page.text()).toContain("TeleCodex Mini App");
    expect(asset.headers.get("content-type")).toContain("javascript");
  });

  it("requires Telegram initData before returning dashboard state", async () => {
    const { server } = await start();

    const unauthorized = await fetch(`${server.url}/api/dashboard`);
    const authorized = await fetch(`${server.url}/api/dashboard`, {
      headers: { "x-telegram-init-data": signedInitData() },
    });

    expect(unauthorized.status).toBe(401);
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({ generatedAt: NOW_SECONDS * 1000, sessions: [] });
  });

  it("passes a bounded Dashboard view and page to the controller", async () => {
    const { server, loadDashboard } = await start();

    const response = await fetch(
      `${server.url}/api/dashboard?view=attention&offset=30&limit=40`,
      { headers: { "x-telegram-init-data": signedInitData() } },
    );

    expect(response.status).toBe(200);
    expect(loadDashboard).toHaveBeenCalledWith({ view: "attention", offset: 30, limit: 40 });
  });

  it("rejects unknown Dashboard views and oversized pages", async () => {
    const { server } = await start();
    const headers = { "x-telegram-init-data": signedInitData() };

    const unknown = await fetch(`${server.url}/api/dashboard?view=all`, { headers });
    const oversized = await fetch(`${server.url}/api/dashboard?limit=101`, { headers });

    expect(unknown.status).toBe(400);
    expect(oversized.status).toBe(400);
  });

  it("serves bounded health and readiness probes without Telegram authentication", async () => {
    const { server } = await start();

    const health = await fetch(`${server.url}/healthz`);
    const readiness = await fetch(`${server.url}/readyz`);

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", reasons: [] });
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toEqual({
      status: "fail",
      reasons: ["RECONCILIATION_PENDING"],
    });
  });

  it("never leaks probe errors and bounds an unresponsive probe", async () => {
    server = await startMiniAppServer({
      host: "127.0.0.1",
      port: 0,
      staticDir,
      botToken: BOT_TOKEN,
      allowedUserIds: new Set([123]),
      authMaxAgeSeconds: 300,
      probeTimeoutMs: 10,
      loadDashboard: async () => ({}),
      ensureTopic: async () => ({ created: false, url: "https://t.me" }),
      probes: {
        health: async () => { throw new Error("token=/root/private/jobs.sqlite"); },
        readiness: async () => new Promise(() => undefined),
      },
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    const failed = await fetch(`${server.url}/healthz`);
    const timedOut = await fetch(`${server.url}/readyz`);
    const failedBody = JSON.stringify(await failed.json());
    const timedOutBody = JSON.stringify(await timedOut.json());

    expect(failed.status).toBe(503);
    expect(failedBody).toBe('{"status":"fail","reasons":["PROBE_FAILED"]}');
    expect(failedBody).not.toContain("token");
    expect(failedBody).not.toContain("/root");
    expect(timedOut.status).toBe(503);
    expect(timedOutBody).toBe('{"status":"fail","reasons":["PROBE_TIMEOUT"]}');
  });

  it("creates a Telegram topic for an authenticated canonical thread", async () => {
    const { server, ensureTopic } = await start();

    const response = await fetch(`${server.url}/api/dashboard/threads/${THREAD_ID}/topic`, {
      method: "POST",
      headers: { "x-telegram-init-data": signedInitData() },
    });

    expect(response.status).toBe(200);
    expect(ensureTopic).toHaveBeenCalledWith(THREAD_ID);
    expect(await response.json()).toEqual({ created: true, url: "https://t.me/c/123/42" });
  });

  it("runs only an authenticated, versioned canonical job action", async () => {
    const { server, runJobAction } = await start();
    const jobId = "11111111-1111-4111-8111-111111111111";

    const unauthorized = await fetch(
      `${server.url}/api/dashboard/jobs/${jobId}/actions/inspect`,
      { method: "POST" },
    );
    const response = await fetch(
      `${server.url}/api/dashboard/jobs/${jobId}/actions/inspect`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-init-data": signedInitData(),
        },
        body: JSON.stringify({ expectedVersion: 7 }),
      },
    );

    expect(unauthorized.status).toBe(401);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(runJobAction).toHaveBeenCalledWith({
      kind: "inspect",
      jobId,
      expectedVersion: 7,
    });
  });

  it("accepts missing-topic recovery without client-supplied destination data", async () => {
    const { server, runJobAction } = await start();
    const jobId = "11111111-1111-4111-8111-111111111111";
    const headers = {
      "content-type": "application/json",
      "x-telegram-init-data": signedInitData(),
    };

    const accepted = await fetch(
      `${server.url}/api/dashboard/jobs/${jobId}/actions/recover_missing_topic`,
      { method: "POST", headers, body: JSON.stringify({ expectedVersion: 541 }) },
    );
    const tampered = await fetch(
      `${server.url}/api/dashboard/jobs/${jobId}/actions/recover_missing_topic`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ expectedVersion: 541, messageThreadId: 99 }),
      },
    );

    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true });
    expect(runJobAction).toHaveBeenCalledOnce();
    expect(runJobAction).toHaveBeenCalledWith({
      kind: "recover_missing_topic",
      jobId,
      expectedVersion: 541,
    });
    expect(tampered.status).toBe(400);
  });

  it("rejects malformed thread ids without calling Telegram", async () => {
    const { server, ensureTopic } = await start();

    const response = await fetch(`${server.url}/api/dashboard/threads/not-a-thread/topic`, {
      method: "POST",
      headers: { "x-telegram-init-data": signedInitData() },
    });

    expect(response.status).toBe(404);
    expect(ensureTopic).not.toHaveBeenCalled();
  });

  it("authenticates and serves every Jira read-only view", async () => {
    const { server, jira } = await start();
    const headers = { "x-telegram-init-data": signedInitData() };

    expect((await fetch(`${server.url}/api/jira/my-sprint`)).status).toBe(401);
    expect((await fetch(`${server.url}/api/jira/my-sprint?refresh=1`, { headers })).status).toBe(200);
    expect((await fetch(`${server.url}/api/jira/sprint`, { headers })).status).toBe(200);
    expect((await fetch(`${server.url}/api/jira/backlog?startAt=50&limit=50`, { headers })).status).toBe(200);
    expect((await fetch(`${server.url}/api/jira/kanban`, { headers })).status).toBe(200);
    expect((await fetch(`${server.url}/api/jira/filters`, { headers })).status).toBe(200);
    expect((await fetch(`${server.url}/api/jira/filters/11525`, { headers })).status).toBe(200);
    expect((await fetch(`${server.url}/api/jira/issues/MIR-6886`, { headers })).status).toBe(200);

    expect(jira.getMySprint).toHaveBeenCalledWith(true);
    expect(jira.getSprint).toHaveBeenCalledWith(false);
    expect(jira.getBacklog).toHaveBeenCalledWith(50, 50, false);
    expect(jira.getKanban).toHaveBeenCalledWith(false);
    expect(jira.getFilters).toHaveBeenCalledWith(false);
    expect(jira.runFilter).toHaveBeenCalledWith("11525", false);
    expect(jira.getIssue).toHaveBeenCalledWith("MIR-6886", false);
  });

  it("rejects invalid Jira backlog page boundaries without invoking the controller", async () => {
    const { server, jira } = await start();
    const headers = { "x-telegram-init-data": signedInitData() };

    expect((await fetch(`${server.url}/api/jira/backlog?startAt=-1&limit=50`, { headers })).status)
      .toBe(400);
    expect((await fetch(`${server.url}/api/jira/backlog?startAt=0&limit=101`, { headers })).status)
      .toBe(400);
    expect(jira.getBacklog).not.toHaveBeenCalled();
  });

  it("creates or reuses a Jira task thread through an authenticated POST", async () => {
    const { server, jira } = await start();

    const response = await fetch(`${server.url}/api/jira/issues/MIR-6886/thread`, {
      method: "POST",
      headers: { "x-telegram-init-data": signedInitData() },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ created: false, url: "https://t.me/c/123/99" });
    expect(jira.ensureThread).toHaveBeenCalledWith("MIR-6886");
  });

  it("rejects malformed Jira identifiers without invoking the controller", async () => {
    const { server, jira } = await start();
    const headers = { "x-telegram-init-data": signedInitData() };

    expect((await fetch(`${server.url}/api/jira/filters/not-a-filter`, { headers })).status).toBe(404);
    expect((await fetch(`${server.url}/api/jira/issues/not-a-key`, { headers })).status).toBe(404);
    expect(jira.runFilter).not.toHaveBeenCalled();
    expect(jira.getIssue).not.toHaveBeenCalled();
  });
});

describe("Mini App probe provider", () => {
  it("checks store reads for health and every readiness gate without exposing errors", async () => {
    const readStore = vi.fn(async () => undefined);
    const writeStore = vi.fn(async () => { throw new Error("private sqlite path"); });
    const provider = createMiniAppProbeProvider({
      readStore,
      writeStore,
      migrationComplete: () => true,
      reconciliationComplete: () => false,
      pollingOwned: () => false,
      dependencies: [{
        unavailableCode: "APP_SERVER_UNAVAILABLE",
        check: async () => false,
      }],
    });

    await expect(provider.health()).resolves.toEqual({ ok: true, reasonCodes: [] });
    await expect(provider.readiness()).resolves.toEqual({
      ok: false,
      reasonCodes: [
        "RECONCILIATION_PENDING",
        "POLLING_NOT_OWNED",
        "STORE_READ_ONLY",
        "APP_SERVER_UNAVAILABLE",
      ],
    });
    expect(readStore).toHaveBeenCalledTimes(2);
    expect(writeStore).toHaveBeenCalledOnce();
  });

  it("aborts each timed-out Telegram readiness probe instead of accumulating requests", async () => {
    const probeStaticDir = mkdtempSync(path.join(tmpdir(), "telecodex-mini-app-probe-"));
    writeFileSync(path.join(probeStaticDir, "index.html"), "<main>probe</main>");
    let probeServer: RunningMiniAppServer | undefined;
    let active = 0;
    let maximumActive = 0;
    const observedSignals: AbortSignal[] = [];
    const api = {
      getMe: vi.fn((signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (!signal) throw new Error("missing abort signal");
        observedSignals.push(signal);
        signal.addEventListener("abort", () => {
          active -= 1;
          reject(signal.reason);
        }, { once: true });
      })),
    };
    const provider = createMiniAppProbeProvider({
      readStore: async () => undefined,
      writeStore: async () => undefined,
      migrationComplete: () => true,
      reconciliationComplete: () => true,
      pollingOwned: () => true,
      dependencies: [{
        unavailableCode: "TELEGRAM_UNAVAILABLE",
        check: (signal) => checkTelegramApiAvailability(api, signal),
      }],
    });
    try {
      probeServer = await startMiniAppServer({
        host: "127.0.0.1",
        port: 0,
        staticDir: probeStaticDir,
        botToken: BOT_TOKEN,
        allowedUserIds: new Set([123]),
        authMaxAgeSeconds: 300,
        probeTimeoutMs: 10,
        loadDashboard: async () => ({}),
        ensureTopic: async () => ({ created: false, url: "https://t.me" }),
        probes: provider,
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(`${probeServer.url}/readyz`);
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({
          status: "fail",
          reasons: ["PROBE_TIMEOUT"],
        });
        expect(active).toBe(0);
      }
      expect(maximumActive).toBe(1);
      expect(observedSignals).toHaveLength(2);
      expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      await probeServer?.close();
      rmSync(probeStaticDir, { recursive: true, force: true });
    }
  });
});
