import { describe, expect, it, vi } from "vitest";
import { collectDeployRow, isDeploySummaryRow } from "../src/mircli-deploy-data.js";

const options = { gitlabUrl: "https://gitlab.example.com", token: "secret", projectId: 12, projectPath: "mircli/api", ref: "main" as const };
function deployment(id: number, status: string, ref = "main") {
  return { id, ref, status, sha: "a".repeat(40), created_at: "2026-10-13T08:00:00Z", updated_at: "2026-10-13T09:00:00Z", environment: { name: "develop" }, deployable: { id: id + 100, name: "deploy:develop", finished_at: status === "success" ? "2026-10-13T09:00:00Z" : null, web_url: "javascript:evil", commit: { title: "fix <tag>" } } };
}
function response(data: unknown, next = "") {
  return new Response(JSON.stringify(data), { headers: { "x-next-page": next } });
}

describe("collectDeployRow", () => {
  it("reads actual job start time and validates optional failure fields on legacy rows", async () => {
    const raw = deployment(31, "running");
    const running = { ...raw, deployable: { ...raw.deployable, started_at: "2026-10-13T08:30:00Z" } };
    const row = await collectDeployRow({ ...options, fetch: async (input) => response(new URL(String(input)).searchParams.get("status") === "running" ? [running] : []) });
    expect(row.active[0].startedAt).toBe("2026-10-13T08:30:00Z");
    expect(isDeploySummaryRow(row)).toBe(true);
    expect(isDeploySummaryRow({ ...row, active: [{ ...row.active[0], startedAt: "invalid" }] })).toBe(false);
    expect(isDeploySummaryRow({ ...row, active: [{ ...row.active[0], failureSummary: "x".repeat(181) }] })).toBe(false);
    expect(isDeploySummaryRow({ ...row, active: [{ ...row.active[0], failureSummary: "private\nline" }] })).toBe(false);
    expect(isDeploySummaryRow({ ...row, active: [{ ...row.active[0], startedAt: undefined }] })).toBe(true);
  });
  it("enriches only latest failed job without erasing healthy deployment data on trace outage", async () => {
    const raw = deployment(35, "failed");
    const failed = { ...raw, deployable: { ...raw.deployable, failure_reason: "script_failure" } };
    const urls: string[] = [];
    const row = await collectDeployRow({ ...options, projectId: 39, fetch: async (input) => {
      const url = new URL(String(input)); urls.push(url.pathname);
      if (url.pathname.endsWith("/trace")) return new Response("secret response", { status: 503 });
      const status = url.searchParams.get("status");
      return response(status === "running" ? [deployment(36, "running")] : status === "success" ? [deployment(34, "success")] : status ? [] : [failed]);
    } });
    expect(row.error).toBeUndefined();
    expect(row.latest?.failureSummary).toBe("Сбой скрипта деплоя");
    expect(row.success?.id).toBe(34);
    expect(row.active[0].id).toBe(36);
    expect(urls.filter((url) => url.includes("/jobs/"))).toEqual(["/api/v4/projects/39/jobs/135/trace"]);
  });

  it.each([
    [{ name: "Job User" }, { name: "Pipeline User" }, "Job User"],
    [{ username: "job-user" }, { name: "Pipeline User" }, "job-user"],
    [null, { name: "Deployment User" }, "Deployment User"],
    [null, null, undefined],
  ])("uses the deploy initiator without substituting commit authors", async (jobUser, deploymentUser, expected) => {
    const raw = { ...deployment(5, "failed"), user: deploymentUser,
      deployable: { ...deployment(5, "failed").deployable, user: jobUser,
        commit: { author_name: "Commit Author", title: "fix" } } };
    const row = await collectDeployRow({ ...options, fetch: async (input) =>
      response(new URL(String(input)).searchParams.has("status") ? [] : [raw]) });
    expect(row.latest?.deployer).toBe(expected);
    expect(isDeploySummaryRow(row)).toBe(true);
  });
  it("bounds and normalizes initiator text, while keeping legacy records valid", async () => {
    const raw = { ...deployment(5, "failed"), user: { name: `  <Alex>\n${"x".repeat(200)}` } };
    const row = await collectDeployRow({ ...options, fetch: async (input) =>
      response(new URL(String(input)).searchParams.has("status") ? [] : [raw]) });
    expect(row.latest?.deployer?.length).toBeLessThanOrEqual(80);
    expect(row.latest?.deployer).toMatch(/^<Alex> /);
    expect(row.latest?.deployer).not.toContain("\n");
    expect(isDeploySummaryRow(row)).toBe(true);
    expect(isDeploySummaryRow({ ...row, latest: { ...row.latest, deployer: 42 } })).toBe(false);
    expect(isDeploySummaryRow({ ...row, latest: { ...row.latest, deployer: undefined } })).toBe(true);
  });
  it("filters MR refs, preserves concurrent active and independent last success", async () => {
    const mock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/jobs/")) return new Response("", { status: 404 });
      expect(url.searchParams.get("environment")).toBe("develop");
      expect(url.searchParams.has("ref")).toBe(false);
      const status = url.searchParams.get("status");
      if (status === "created") return response([deployment(9, "created"), deployment(8, "created", "MIR-1")]);
      if (status === "running") return url.searchParams.get("page") === "1" ? response([deployment(7, "running")], "2") : response([deployment(6, "running")]);
      if (status === "success") return response([deployment(4, "success")]);
      if (status === "blocked") return response([deployment(10, "blocked"), deployment(2, "blocked")]);
      return response([deployment(10, "blocked"), deployment(9, "created"), deployment(5, "failed"), deployment(4, "success")]);
    });
    const row = await collectDeployRow({ ...options, fetch: mock });
    expect(row.error).toBeUndefined();
    expect(row.active.map((item) => item.id)).toEqual([7, 6]);
    expect(row.waiting?.map((item) => item.id)).toEqual([10, 9]);
    expect(row.latest?.id).toBe(5);
    expect(row.success?.id).toBe(4);
    expect(row.success?.jobUrl).toBe("https://gitlab.example.com/mircli/api/-/jobs/104");
    expect(isDeploySummaryRow(row)).toBe(true);
  });
  it("reports caps and preserves collected active records", async () => {
    const row = await collectDeployRow({ ...options, fetch: async (input) => {
      const url = new URL(String(input));
      return response([deployment(Number(url.searchParams.get("page")), url.searchParams.get("status") ?? "blocked")], String(Number(url.searchParams.get("page")) + 1));
    } });
    expect(row.error).toMatch(/неполные/i);
    expect(row.active.length).toBeGreaterThan(1);
  });
  it("sanitizes HTTP/network errors and rejects invalid JSON records", async () => {
    const row = await collectDeployRow({ ...options, fetch: async () => new Response("secret private body", { status: 403 }) });
    expect(row.error).toContain("403");
    expect(row.error).not.toContain("secret");
    const invalid = await collectDeployRow({ ...options, fetch: async () => response([{ ...deployment(1, "success"), sha: "<bad>" }]) });
    expect(invalid.error).toMatch(/ответ/i);
    expect(invalid.success).toBeUndefined();
  });
  it("honors caller abort without fetching and validates persisted rows", async () => {
    const controller = new AbortController(); controller.abort();
    const mock = vi.fn();
    expect((await collectDeployRow({ ...options, signal: controller.signal, fetch: mock })).error).toMatch(/отмен/i);
    expect(mock).not.toHaveBeenCalled();
    expect(isDeploySummaryRow({ projectPath: "mircli/api", ref: "main", active: [] })).toBe(true);
    expect(isDeploySummaryRow({ projectPath: "../evil", ref: "main", active: [] })).toBe(false);
  });
  it("requires the exact production deployment job and ignores stop jobs", async () => {
    const prod = { ...deployment(3, "success", "production"), environment: { name: "production" }, deployable: { ...deployment(3, "success").deployable, name: "deploy:production" } };
    const row = await collectDeployRow({ ...options, ref: "production", fetch: async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("environment")).toBe("production");
      return response([{ ...prod, id: 4, deployable: { ...prod.deployable, name: "stop:production" } }, prod]);
    } });
    expect(row.latest?.id).toBe(3);
    expect(row.success?.id).toBe(3);
    expect(row.active).toEqual([]);
    expect(isDeploySummaryRow({ ...row, active: [row.success] })).toBe(false);
    expect(isDeploySummaryRow({ ...row, success: { ...row.success, jobUrl: "javascript:evil" } })).toBe(false);
  });
  it("rejects non-sequential pagination", async () => {
    const row = await collectDeployRow({ ...options, fetch: async () => response([], "999") });
    expect(row.error).toMatch(/пагинация/i);
  });
  it("paginates a full page when pagination headers are absent", async () => {
    const row = await collectDeployRow({ ...options, fetch: async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get("page") === "1") return new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => deployment(1000 - i, "success", "feature"))));
      return new Response(JSON.stringify([deployment(3, "success")]));
    } });
    expect(row.success?.id).toBe(3);
    expect(row.error).toBeUndefined();
  });
  it("times out requests at ten seconds without leaking fetch errors", async () => {
    vi.useFakeTimers();
    try {
      const request = collectDeployRow({ ...options, fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("secret token and private URL")), { once: true });
      }) });
      await vi.advanceTimersByTimeAsync(50_000);
      const row = await request;
      expect(row.error).toContain("превышено время");
      expect(row.error).not.toContain("secret");
    } finally { vi.useRealTimers(); }
  });
  it("bounds HTTP concurrency to one per row", async () => {
    let inFlight = 0;
    let maximum = 0;
    const row = await collectDeployRow({ ...options, fetch: async () => {
      inFlight++;
      maximum = Math.max(maximum, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return response([]);
    } });
    expect(row.error).toBeUndefined();
    expect(maximum).toBe(1);
  });
  it("does not start later queries after caller cancellation", async () => {
    const controller = new AbortController();
    const mock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("private abort error")), { once: true });
      controller.abort();
    }));
    const row = await collectDeployRow({ ...options, signal: controller.signal, fetch: mock });
    expect(row.error).toMatch(/отмен/i);
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it("keeps only the newest waiting deployment when no terminal attempt exists", async () => {
    const row = await collectDeployRow({ ...options, fetch: async (input) => {
      const status = new URL(String(input)).searchParams.get("status");
      return response(status === "blocked" ? [deployment(8, "blocked"), deployment(4, "blocked")] : []);
    } });
    expect(row.latest).toBeUndefined();
    expect(row.waiting?.map((record) => record.id)).toEqual([8]);
  });
});
