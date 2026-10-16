import { createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { startGitlabReviewWebhook, type GitlabReviewWebhook } from "../src/gitlab-review-webhook.js";
import { DeployViewContextError } from "../src/mircli-deploy-topic.js";

let server: GitlabReviewWebhook;
afterEach(async () => { await server?.close(); });
const payload = { object_kind: "deployment", status: "running", environment: "develop", deployment_id: 123,
  project: { id: 42, path_with_namespace: "mircli/api" } };
const key = Buffer.alloc(32, 7);
it("authenticates deployment invalidation independently of the review push flow", async () => {
  const onDeployment = vi.fn();
  const enqueue = vi.fn(async () => "accepted" as const);
  server = await startGitlabReviewWebhook({ host: "127.0.0.1", port: 0, secret: "s".repeat(32),
    signingToken: `whsec_${key.toString("base64")}`, projects: ["mircli/api"], projectIds: { "mircli/api": 42 },
    enqueue, onDeployment });
  const send = async (value: unknown, validSignature = true) => {
    const body = JSON.stringify(value);
    const timestamp = String(Math.floor(Date.now() / 1000));
    return fetch(`http://127.0.0.1:${server.port}/hooks/gitlab/review`, { method: "POST", body,
      headers: { "content-type": "application/json", "x-gitlab-token": "s".repeat(32), "x-gitlab-event": "Deployment Hook",
        "webhook-id": "deploy-123", "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${validSignature ? createHmac("sha256", key).update(`deploy-123.${timestamp}.${body}`).digest("base64") : "bad"}` } });
  };
  expect((await send(payload, false)).status).toBe(401);
  expect(onDeployment).not.toHaveBeenCalled();
  expect((await send({ ...payload, project: { ...payload.project, id: 43 } })).status).toBe(403);
  expect((await send({ ...payload, environment: "stage" })).status).toBe(200);
  expect(onDeployment).not.toHaveBeenCalled();
  expect((await send(payload)).status).toBe(202);
  expect(onDeployment).toHaveBeenCalledWith("mircli/api");
  expect(enqueue).not.toHaveBeenCalled();
});

it("authorizes internal view switching and bounds its exact message context payload", async () => {
  const onDeployView = vi.fn(async () => undefined);
  server = await startGitlabReviewWebhook({ host: "127.0.0.1", port: 0, secret: "s".repeat(32),
    projects: ["mircli/api"], projectIds: { "mircli/api": 42 }, enqueue: async () => "accepted",
    launchSecret: "l".repeat(32), onLaunch: async () => "accepted", onDeployView });
  const body = { chatId: -1001, messageThreadId: 7, messageId: 41, ref: "production" };
  const send = (value: unknown, authorized = true) => fetch(`http://127.0.0.1:${server.port}/internal/gitlab/deploy-view`, {
    method: "POST", body: JSON.stringify(value), headers: { "content-type": "application/json",
      ...(authorized ? { "x-telecodex-review-token": "l".repeat(32) } : {}) },
  });
  expect((await send(body, false)).status).toBe(401);
  expect((await send({ ...body, extra: "bad" })).status).toBe(400);
  expect((await send({ ...body, ref: "feature" })).status).toBe(400);
  expect(onDeployView).not.toHaveBeenCalled();
  expect((await send(body)).status).toBe(202);
  expect(onDeployView).toHaveBeenCalledWith(body);
  onDeployView.mockRejectedValueOnce(new DeployViewContextError());
  expect((await send({ ...body, messageId: 99 })).status).toBe(403);
});
