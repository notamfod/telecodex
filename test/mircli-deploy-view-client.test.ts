import { afterEach, describe, expect, it, vi } from "vitest";
import { switchMircliDeployView } from "../src/mircli-deploy-view-client.js";
const request = { chatId: -1001, messageThreadId: 3861, messageId: 91, ref: "main" as const };
afterEach(() => vi.unstubAllEnvs());
describe("MirCli deploy view client", () => {
  it("posts exact coordinates and view to loopback with token and timeout", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }));
    await switchMircliDeployView(request, { fetch: fetcher, secret: "s".repeat(64) });
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:8790/internal/gitlab/deploy-view", expect.objectContaining({
      method: "POST", body: JSON.stringify(request), signal: expect.any(AbortSignal), redirect: "error",
      headers: { "Content-Type": "application/json", "x-telecodex-review-token": "s".repeat(64) },
    }));
  });
  it.each([403, 409, 500])("sanitizes HTTP %s errors", async status => {
    await expect(switchMircliDeployView(request, { secret: "s".repeat(64), fetch: async () => new Response("private token", { status }) }))
      .rejects.toThrow("MirCli deploy view failed");
  });
  it("sanitizes network errors", async () => {
    await expect(switchMircliDeployView(request, { secret: "s".repeat(64), fetch: async () => { throw new Error("private token"); } }))
      .rejects.toThrow("MirCli deploy view failed");
  });
  it.each([{ messageId: 0 }, { messageThreadId: 0 }, { chatId: 0 }, { ref: "staging" }])("rejects malformed request %j before fetching", async invalid => {
    const fetcher = vi.fn();
    await expect(switchMircliDeployView({ ...request, ...invalid } as never, { fetch: fetcher, secret: "s".repeat(64) })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects remote configured launch URLs before exposing the token", async () => {
    vi.stubEnv("GITLAB_REVIEW_LAUNCH_URL", "https://example.com/internal/gitlab/review-launch");
    const fetcher = vi.fn();
    await expect(switchMircliDeployView(request, { fetch: fetcher, secret: "s".repeat(64) })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
