import { readFileSync } from "node:fs";
import path from "node:path";

export interface GitlabReviewLaunchRequest {
  readonly requestId: string;
  readonly chatId: number;
  readonly messageThreadId: number;
  readonly messageId: number;
}

export type GitlabReviewLaunchOutcome = "accepted" | "duplicate";

export function loadGitlabReviewLaunchSecret(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const file = env.GITLAB_REVIEW_LAUNCH_SECRET_FILE?.trim()
    || "/etc/telecodex/gitlab-review-launch.secret";
  if (!path.isAbsolute(file) || path.normalize(file) !== file) {
    throw new Error("Invalid GitLab review launch secret file");
  }
  let secret: string;
  try { secret = readFileSync(file, "utf8").trim(); }
  catch { throw new Error("GitLab review launch secret unavailable"); }
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error("Invalid GitLab review launch secret");
  return secret;
}

export async function activateGitlabReview(
  request: GitlabReviewLaunchRequest,
  dependencies: { readonly fetch?: typeof fetch; readonly secret?: string; readonly port?: number } = {},
  pipeline = false,
): Promise<GitlabReviewLaunchOutcome> {
  if (!/^[a-f0-9]{32}$/.test(request.requestId)
    || !Number.isSafeInteger(request.chatId) || request.chatId === 0
    || !Number.isSafeInteger(request.messageThreadId) || request.messageThreadId <= 0
    || !Number.isSafeInteger(request.messageId) || request.messageId <= 0) {
    throw new Error("Invalid GitLab review launch request");
  }
  const port = dependencies.port ?? Number(process.env.GITLAB_REVIEW_WEBHOOK_PORT ?? "8790");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid GitLab review launch port");
  const secret = dependencies.secret ?? loadGitlabReviewLaunchSecret();
  const response = await (dependencies.fetch ?? fetch)(
    `http://127.0.0.1:${port}/internal/gitlab/${pipeline ? "review-pipeline" : "review-launch"}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-telecodex-review-token": secret },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (response.status !== 202) throw new Error("GitLab review launch failed");
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== "object" || body === null || !("outcome" in body)
    || (body.outcome !== "accepted" && body.outcome !== "duplicate")) throw new Error("GitLab review launch failed");
  return body.outcome;
}
