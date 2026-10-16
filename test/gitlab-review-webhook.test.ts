import { createHmac } from "node:crypto";
import { request } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startGitlabReviewWebhook,
  type GitlabReviewWebhook,
} from "../src/gitlab-review-webhook.js";

const SECRET = "s".repeat(32);
const SIGNING_KEY = Buffer.alloc(32, 7);
const SIGNING_TOKEN = `whsec_${SIGNING_KEY.toString("base64")}`;
const VALID_PAYLOAD = {
  object_kind: "push",
  ref: "refs/heads/main",
  after: "a".repeat(40),
  project: { id: 42, path_with_namespace: "group/project" },
};

describe("GitLab review webhook", () => {
  let webhook: GitlabReviewWebhook | undefined;

  afterEach(async () => {
    await webhook?.close();
    webhook = undefined;
  });

  async function start(overrides: Record<string, unknown> = {}) {
    const enqueue = vi.fn(async () => "accepted" as const);
    webhook = await startGitlabReviewWebhook({
      host: "127.0.0.1",
      port: 0,
      secret: SECRET,
      projects: ["group/project"],
      enqueue,
      bodyReadTimeoutMs: 100,
      ...overrides,
    });
    return { enqueue, port: webhook.port };
  }

  it("offers a verified push and exposes an authenticated loopback-only launch endpoint", async () => {
    const offer = vi.fn(async () => ({ outcome: "accepted" as const, requestId: "1".repeat(32) }));
    const onLaunch = vi.fn(async () => "accepted" as const);
    const started = await start({ offer, onLaunch, launchSecret: "l".repeat(32) });
    const payload = {
      ...VALID_PAYLOAD,
      total_commits_count: 2,
      user_name: "A <B>",
      commits: [
        { id: "b".repeat(40), title: "older" },
        { id: "a".repeat(40), title: "fix <unsafe>", url: "https://untrusted.invalid/commit" },
      ],
    };
    expect(await send(started.port, payload, {
      "x-gitlab-token": SECRET,
      "x-gitlab-event": "Push Hook",
    })).toMatchObject({ status: 202, json: { outcome: "accepted" } });
    expect(started.enqueue).not.toHaveBeenCalled();
    expect(offer).toHaveBeenCalledWith(expect.objectContaining({ projectPath: "group/project" }), {
      author: "A <B>",
      commitCount: 2,
      commitTitle: "fix <unsafe>",
    });

    const activation = { requestId: "1".repeat(32), chatId: -1001, messageThreadId: 7, messageId: 9 };
    expect(await rawSend(started.port, JSON.stringify(activation), {
      "content-type": "application/json",
      "x-telecodex-review-token": "l".repeat(32),
    }, "POST", "/internal/gitlab/review-launch")).toEqual({
      status: 202,
      json: { outcome: "accepted" },
    });
    expect(onLaunch).toHaveBeenCalledWith(activation);
  });

  it("rejects unauthenticated and malformed internal launch requests", async () => {
    const onLaunch = vi.fn(async () => "accepted" as const);
    const started = await start({ onLaunch, launchSecret: "l".repeat(32) });
    const valid = { requestId: "1".repeat(32), chatId: -1001, messageThreadId: 7, messageId: 9 };
    for (const [body, headers, status] of [
      [JSON.stringify(valid), { "content-type": "application/json" }, 401],
      [JSON.stringify({ ...valid, extra: true }), { "content-type": "application/json", "x-telecodex-review-token": "l".repeat(32) }, 400],
      [JSON.stringify({ ...valid, requestId: "../bad" }), { "content-type": "application/json", "x-telecodex-review-token": "l".repeat(32) }, 400],
    ] as const) {
      expect(await rawSend(started.port, body, headers, "POST", "/internal/gitlab/review-launch"))
        .toMatchObject({ status });
    }
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("authenticates and durably enqueues a normalized push before returning 202", async () => {
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => { release = resolve; });
    const enqueue = vi.fn(async () => { await persisted; return "accepted" as const; });
    const started = await start({ enqueue, projectIds: { "group/project": 42 } });
    const pending = send(started.port, VALID_PAYLOAD, {
      "x-gitlab-token": SECRET,
      "x-gitlab-event": "Push Hook",
      "x-gitlab-event-uuid": "01234567-89ab-4cde-8fab-0123456789ab",
    });
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
    release();

    await expect(pending).resolves.toMatchObject({ status: 202, json: { outcome: "accepted" } });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      dedupId: "01234567-89ab-4cde-8fab-0123456789ab",
      projectId: 42,
      projectPath: "group/project",
      ref: "refs/heads/main",
      after: "a".repeat(40),
    }));
  });

  it("requires a fresh Standard Webhooks signature when configured", async () => {
    const nowSeconds = 2_000_000_000;
    const started = await start({ signingToken: SIGNING_TOKEN, now: () => nowSeconds * 1000 });
    const body = JSON.stringify(VALID_PAYLOAD);
    const signedHeaders = signatureHeaders(body, nowSeconds);

    expect(await rawSend(started.port, body, {
      "content-type": "application/json",
      "x-gitlab-token": SECRET,
      "x-gitlab-event": "Push Hook",
      ...signedHeaders,
    })).toMatchObject({ status: 202 });

    for (const headers of [
      { "x-gitlab-token": SECRET, "x-gitlab-event": "Push Hook" },
      { "x-gitlab-token": SECRET, "x-gitlab-event": "Push Hook", ...signatureHeaders(`${body} `, nowSeconds) },
      { "x-gitlab-token": SECRET, "x-gitlab-event": "Push Hook", ...signatureHeaders(body, nowSeconds - 301) },
    ]) {
      expect(await rawSend(started.port, body, { "content-type": "application/json", ...headers }))
        .toMatchObject({ status: 401 });
    }
    expect(started.enqueue).toHaveBeenCalledTimes(1);
    expect(started.enqueue).toHaveBeenCalledWith(expect.objectContaining({ dedupId: "msg_123" }));
  });

  it.each([
    ["missing token", {}, VALID_PAYLOAD, 401],
    ["wrong token", { "x-gitlab-token": `${SECRET}x` }, VALID_PAYLOAD, 401],
    ["unknown project", { "x-gitlab-token": SECRET, "x-gitlab-event": "Push Hook" }, { ...VALID_PAYLOAD, project: { id: 42, path_with_namespace: "other/project" } }, 403],
    ["wrong pinned id", { "x-gitlab-token": SECRET, "x-gitlab-event": "Push Hook" }, { ...VALID_PAYLOAD, project: { id: 99, path_with_namespace: "group/project" } }, 403],
    ["bad uuid", { "x-gitlab-token": SECRET, "x-gitlab-event": "Push Hook", "x-gitlab-event-uuid": "../../runner" }, VALID_PAYLOAD, 400],
  ])("rejects %s without enqueue", async (_name, headers, payload, status) => {
    const started = await start({ projectIds: { "group/project": 42 } });
    const response = await send(started.port, payload, headers as Record<string, string>);
    expect(response.status).toBe(status);
    expect(started.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong GitLab event", { "x-gitlab-event": "Merge Request Hook" }, VALID_PAYLOAD],
    ["wrong object kind", { "x-gitlab-event": "Push Hook" }, { ...VALID_PAYLOAD, object_kind: "tag_push" }],
    ["wrong branch", { "x-gitlab-event": "Push Hook" }, { ...VALID_PAYLOAD, ref: "refs/heads/develop" }],
    ["deleted branch", { "x-gitlab-event": "Push Hook" }, { ...VALID_PAYLOAD, after: "0".repeat(40) }],
  ])("ignores %s successfully", async (_name, headers, payload) => {
    const started = await start();
    const response = await send(started.port, payload, {
      "x-gitlab-token": SECRET,
      ...(headers as Record<string, string>),
    });
    expect(response).toMatchObject({ status: 200, json: { outcome: "ignored" } });
    expect(started.enqueue).not.toHaveBeenCalled();
  });

  it("uses a stable fallback dedup id and reports duplicates without another run", async () => {
    const enqueue = vi.fn()
      .mockResolvedValueOnce("accepted")
      .mockResolvedValueOnce("duplicate");
    const started = await start({ enqueue });
    const headers = { "x-gitlab-token": SECRET, "x-gitlab-event": "Push Hook" };
    expect((await send(started.port, VALID_PAYLOAD, headers)).status).toBe(202);
    expect(await send(started.port, VALID_PAYLOAD, headers)).toMatchObject({
      status: 202,
      json: { outcome: "duplicate" },
    });
    expect(enqueue.mock.calls[0]?.[0].dedupId).toBe(enqueue.mock.calls[1]?.[0].dedupId);
  });

  it("bounds and validates JSON requests and exposes safe health", async () => {
    const started = await start();
    expect(await rawSend(started.port, "{", {
      "content-type": "application/json",
      "x-gitlab-token": SECRET,
      "x-gitlab-event": "Push Hook",
    })).toMatchObject({ status: 400 });
    expect(await rawSend(started.port, JSON.stringify(VALID_PAYLOAD), {
      "content-type": "text/plain",
      "x-gitlab-token": SECRET,
      "x-gitlab-event": "Push Hook",
    })).toMatchObject({ status: 415 });
    expect(await rawSend(started.port, "x".repeat(1024 * 1024 + 1), {
      "content-type": "application/json",
      "x-gitlab-token": SECRET,
      "x-gitlab-event": "Push Hook",
    })).toMatchObject({ status: 413 });
    expect(await rawSend(started.port, "", {}, "GET", "/healthz")).toEqual({
      status: 200,
      json: { outcome: "ok" },
    });
    expect(started.enqueue).not.toHaveBeenCalled();
  });

  it("sanitizes enqueue failures", async () => {
    const started = await start({ enqueue: vi.fn(async () => { throw new Error("token payload secret"); }) });
    const response = await send(started.port, VALID_PAYLOAD, {
      "x-gitlab-token": SECRET,
      "x-gitlab-event": "Push Hook",
    });
    expect(response).toEqual({ status: 500, json: { outcome: "failed" } });
  });
});

function send(port: number, payload: unknown, headers: Record<string, string>) {
  return rawSend(port, JSON.stringify(payload), {
    "content-type": "application/json",
    ...headers,
  });
}

function signatureHeaders(body: string, timestamp: number): Record<string, string> {
  const id = "msg_123";
  const digest = createHmac("sha256", SIGNING_KEY)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v1,${digest}`,
  };
}

function rawSend(
  port: number,
  body: string,
  headers: Record<string, string>,
  method = "POST",
  route = "/hooks/gitlab/review",
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: route, method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode ?? 0, json: JSON.parse(text) as Record<string, unknown> });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}
