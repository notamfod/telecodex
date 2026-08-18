import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SentryBridge,
  renderSentryTicketText,
  type SentryIssue,
} from "../src/sentry-bridge.js";

const issue: SentryIssue = {
  id: "1001",
  shortId: "MIR-BACK-2",
  title: "Checkout failed <again>",
  culprit: "OrderController::create",
  count: "42",
  firstSeen: "2026-08-17T00:00:00Z",
  lastSeen: "2026-08-18T00:00:00Z",
  permalink: "https://sentry.example.test/issues/1001/",
};

describe("SentryBridge", () => {
  let tempDir: string;
  let statePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telecodex-sentry-"));
    statePath = path.join(tempDir, "sentry-bridge.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("fetches unresolved issues by frequency and maps them to an inbox", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(Response.json([issue])));
    const createTicket = vi.fn().mockResolvedValue(undefined);
    const bridge = createBridge({ fetchImpl, createTicket });

    const result = await bridge.run(24);

    expect(fetchImpl.mock.calls[0]?.[0]).toContain(
      "/api/0/projects/mircli/mir-back/issues/?query=is%3Aunresolved&sort=freq&statsPeriod=24h",
    );
    expect(createTicket).toHaveBeenCalledWith(
      issue,
      { inboxContextKey: "-100123:537", workspace: "/work/mircli" },
      "mir-back",
    );
    expect(result).toEqual({ fetched: 1, created: 1, skipped: 0, failures: [] });
  });

  it("deduplicates seen issue ids across bridge instances", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(Response.json([issue])));
    const createTicket = vi.fn().mockResolvedValue(undefined);

    await createBridge({ fetchImpl, createTicket }).run();
    const second = await createBridge({ fetchImpl, createTicket }).run();

    expect(createTicket).toHaveBeenCalledTimes(1);
    expect(second.skipped).toBe(1);
  });

  it("serializes overlapping manual and scheduled runs", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(Response.json([issue])));
    const createTicket = vi.fn().mockResolvedValue(undefined);
    const bridge = createBridge({ fetchImpl, createTicket });

    const [first, second] = await Promise.all([bridge.run(), bridge.run()]);

    expect(first.created + second.created).toBe(1);
    expect(createTicket).toHaveBeenCalledTimes(1);
  });

  it("prunes seen ids older than 90 days", async () => {
    const now = Date.UTC(2026, 7, 18);
    writeFileSync(statePath, JSON.stringify({ seen: {
      expired: now - 91 * 86_400_000,
      recent: now - 89 * 86_400_000,
    } }));
    const bridge = createBridge({
      now: () => now,
      fetchImpl: vi.fn().mockResolvedValue(Response.json([])),
    });

    await bridge.run();

    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ seen: { recent: now - 89 * 86_400_000 } });
  });

  it("reports API failures without creating or marking tickets", async () => {
    const createTicket = vi.fn();
    const bridge = createBridge({
      fetchImpl: vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })),
      createTicket,
    });

    const result = await bridge.run();

    expect(result.created).toBe(0);
    expect(result.failures[0]).toContain("mir-back: Sentry issues failed: 503 unavailable");
    expect(createTicket).not.toHaveBeenCalled();
  });

  it("honors the configured per-run creation limit", async () => {
    const createTicket = vi.fn().mockResolvedValue(undefined);
    const bridge = createBridge({
      limit: 1,
      fetchImpl: vi.fn().mockResolvedValue(Response.json([
        issue,
        { ...issue, id: "1002", shortId: "MIR-BACK-3" },
      ])),
      createTicket,
    });

    const result = await bridge.run();

    expect(result.created).toBe(1);
    expect(createTicket).toHaveBeenCalledTimes(1);
  });

  function createBridge(overrides: Partial<ConstructorParameters<typeof SentryBridge>[0]> = {}) {
    return new SentryBridge({
      baseUrl: "https://sentry.example.test",
      token: "token",
      org: "mircli",
      mappings: {
        "mir-back": { inboxContextKey: "-100123:537", workspace: "/work/mircli" },
      },
      intervalMs: 300_000,
      limit: 5,
      statePath,
      createTicket: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    });
  }
});

describe("renderSentryTicketText", () => {
  it("includes the issue details used by an inbox ticket", () => {
    const text = renderSentryTicketText(issue);

    expect(text).toContain("MIR-BACK-2");
    expect(text).toContain("Checkout failed <again>");
    expect(text).toContain("OrderController::create");
    expect(text).toContain("42");
    expect(text).toContain("2026-08-17T00:00:00Z");
    expect(text).toContain("2026-08-18T00:00:00Z");
    expect(text).toContain("https://sentry.example.test/issues/1001/");
  });
});
