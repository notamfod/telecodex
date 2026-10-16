import { describe, expect, it, vi } from "vitest";
import { collectDeployFailure, extractDeployFailure } from "../src/mircli-deploy-error.js";

const options = { base: "https://gitlab.example.com", token: "private-token", projectId: 51, jobId: 600, failureReason: "script_failure" };
describe("deployment failure diagnostic", () => {
  it("finds the last meaningful failure behind ANSI, shell commands and GitLab wrappers", () => {
    expect(extractDeployFailure("$ echo 'readiness probe failed secret'\n+ password=hidden\n\u001b[31mReadiness probe failed: HTTP probe failed with statuscode: 503\u001b[0m\nError: converge failed\nERROR: Job failed: exit code 1"))
      .toBe("Проверка готовности приложения не прошла (HTTP 503)");
    expect(extractDeployFailure("Deployment app: timed out waiting for the condition\nUploading artifacts for failed job\nERROR: Job failed: exit code 1"))
      .toBe("Превышено время ожидания готовности ресурсов Kubernetes");
  });
  it("does not return credentials, URLs, headers, private error prose or commands", () => {
    const trace = "+ curl https://user:password@private.example --header 'Authorization: Bearer secret'\n$ echo 'ErrImagePull token=secret'\nERROR secret password=abc https://private.example?q=secret\nError: unable to connect https://user:pass@private.example?token=secret: connection refused Authorization: Bearer hidden";
    const summary = extractDeployFailure(trace);
    expect(summary).toBe("Зависимость недоступна: соединение отклонено");
    expect(summary).not.toMatch(/secret|pass|private|Authorization|hidden/);
    expect(extractDeployFailure("ERROR: database password is hunter2\nERROR: Job failed: exit code 1")).toBeUndefined();
  });
  it("extracts a known fatal lint rule without exposing lint prose, identifiers or file paths", () => {
    const trace = "Failed to compile.\n./src/private/secret.tsx\n22:14 Error: React Hook leakedFunction has missing dependency password. react-hooks/exhaustive-deps\n33:1 Warning: private text react-hooks/exhaustive-deps\ninfo - Need to disable some ESLint rules? https://nextjs.org/private\nERROR: Job failed: exit code 1";
    expect(extractDeployFailure(trace)).toBe("Ошибка ESLint: зависимости React Hook (react-hooks/exhaustive-deps)");
    expect(extractDeployFailure("Warning: private text react-hooks/exhaustive-deps")).toBeUndefined();
  });
  it.each([
    ["Failed to pull image https://u:p@registry: ErrImagePull", "Не удалось загрузить образ контейнера"],
    ["app.ts(1,1): error TS2322: private data", "Ошибка компиляции TypeScript (TS2322)"],
    ["Pod terminated: OOMKilled", "Контейнер завершён из-за нехватки памяти (OOMKilled)"],
    ["0/3 nodes are available: Insufficient cpu", "Недостаточно CPU для размещения контейнеров"],
  ])("maps safe diagnostic classes", (trace, expected) => expect(extractDeployFailure(trace)).toBe(expected));
  it("uses structured failure first and does not fetch trace for runner failures", async () => {
    const fetch = vi.fn();
    expect(await collectDeployFailure({ ...options, jobId: 601, failureReason: "runner_system_failure", fetch })).toBe("Системная ошибка GitLab Runner");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("looks up absent job reason then trace, using trusted authentication and Range", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("PRIVATE-TOKEN")).toBe("private-token");
      if (!String(url).endsWith("/trace")) return Response.json({ failure_reason: "script_failure" });
      expect(new Headers(init?.headers).get("Range")).toBe("bytes=-16384");
      return new Response("readiness probe failed", { status: 206 });
    });
    expect(await collectDeployFailure({ ...options, jobId: 602, failureReason: undefined, fetch })).toMatch(/готовности/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("caches immutable failures but retries transient trace errors", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("private", { status: 503 }))
      .mockResolvedValueOnce(new Response("ErrImagePull"));
    const request = { ...options, jobId: 603, fetch };
    expect(await collectDeployFailure(request)).toBe("Сбой скрипта деплоя");
    expect(await collectDeployFailure(request)).toBe("Не удалось загрузить образ контейнера");
    expect(await collectDeployFailure(request)).toBe("Не удалось загрузить образ контейнера");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("falls back on erased trace and unknown unsafe failures", async () => {
    const fetch = vi.fn(async () => new Response("password=secret", { status: 404 }));
    expect(await collectDeployFailure({ ...options, jobId: 604, fetch })).toBe("Сбой скрипта деплоя");
    expect(await collectDeployFailure({ ...options, jobId: 604, fetch })).toBe("Сбой скрипта деплоя");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps bounded tail when Range is ignored and cancels over-budget bodies", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`${"a".repeat(20_000)}\nErrImagePull\n`)); controller.close(); },
    });
    expect(await collectDeployFailure({ ...options, jobId: 605, fetch: async () => new Response(body) })).toMatch(/образ/);
    const huge = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(65536)); },
      cancel() { cancelled = true; },
    });
    expect(await collectDeployFailure({ ...options, jobId: 606, fetch: async () => new Response(huge) })).toBe("Сбой скрипта деплоя");
    expect(cancelled).toBe(true);
  });

  it("retries job metadata outages and does not cache across GitLab origins", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("private", { status: 503 }))
      .mockResolvedValueOnce(new Response("ERROR: Job failed: exit code 1"))
      .mockResolvedValueOnce(Response.json({ failure_reason: "runner_system_failure" }));
    const request = { ...options, jobId: 609, failureReason: undefined, fetch };
    expect(await collectDeployFailure(request)).toBe("Сбой скрипта деплоя");
    expect(await collectDeployFailure(request)).toBe("Системная ошибка GitLab Runner");
    expect(fetch).toHaveBeenCalledTimes(3);
    const other = vi.fn(async () => new Response("ErrImagePull"));
    expect(await collectDeployFailure({ ...options, base: "https://other.gitlab.example", jobId: 609, fetch: other })).toMatch(/образ/);
    expect(other).toHaveBeenCalledTimes(1);
  });
  it("evicts old entries from the bounded cache", async () => {
    const fetch = vi.fn(async () => new Response("ErrImagePull"));
    for (let jobId = 1000; jobId <= 1256; jobId++) await collectDeployFailure({ ...options, jobId, fetch });
    expect(fetch).toHaveBeenCalledTimes(257);
    await collectDeployFailure({ ...options, jobId: 1000, fetch });
    expect(fetch).toHaveBeenCalledTimes(258);
  });
  it("cancels stalled bodies when caller aborts and retries on a subsequent refresh", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      start() { queueMicrotask(() => controller.abort()); }, cancel() { cancelled = true; },
    })));
    expect(await collectDeployFailure({ ...options, jobId: 610, signal: controller.signal, fetch })).toBe("Сбой скрипта деплоя");
    // A response obtained during an abort must also have its body canceled.
    expect(cancelled).toBe(true);
    const retry = vi.fn(async () => new Response("ErrImagePull"));
    expect(await collectDeployFailure({ ...options, jobId: 610, fetch: retry })).toMatch(/образ/);
    expect(retry).toHaveBeenCalledTimes(1);
  });
  it("respects pre-abort and bounds fetch plus stalled body by ten seconds", async () => {
    const controller = new AbortController(); controller.abort();
    const fetch = vi.fn();
    expect(await collectDeployFailure({ ...options, jobId: 607, signal: controller.signal, fetch })).toBe("Сбой скрипта деплоя");
    expect(fetch).not.toHaveBeenCalled();
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const request = collectDeployFailure({ ...options, jobId: 608, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await request).toBe("Сбой скрипта деплоя");
      expect(cancelled).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
