import { loadGitlabReviewLaunchSecret } from "./gitlab-review-launch-client.js";

export interface MircliDeployViewRequest {
  readonly chatId: number;
  readonly messageThreadId: number;
  readonly messageId: number;
  readonly ref: "main" | "production";
}

function deployViewUrl(portOverride?: number): string {
  const configured = process.env.GITLAB_REVIEW_LAUNCH_URL?.trim();
  if (configured) {
    let url: URL;
    try { url = new URL(configured); } catch { throw new Error("Invalid MirCli deploy view URL"); }
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) throw new Error("Invalid MirCli deploy view URL");
    url.pathname = "/internal/gitlab/deploy-view";
    return url.href;
  }
  const port = portOverride ?? Number(process.env.GITLAB_REVIEW_WEBHOOK_PORT ?? "8790");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid MirCli deploy view port");
  return `http://127.0.0.1:${port}/internal/gitlab/deploy-view`;
}

export async function switchMircliDeployView(
  request: MircliDeployViewRequest,
  dependencies: { readonly fetch?: typeof fetch; readonly secret?: string; readonly port?: number } = {},
): Promise<void> {
  if (!Number.isSafeInteger(request.chatId) || request.chatId === 0
    || !Number.isSafeInteger(request.messageThreadId) || request.messageThreadId <= 0
    || !Number.isSafeInteger(request.messageId) || request.messageId <= 0
    || (request.ref !== "main" && request.ref !== "production")) throw new Error("Invalid MirCli deploy view request");
  const url = deployViewUrl(dependencies.port);
  const secret = dependencies.secret ?? loadGitlabReviewLaunchSecret();
  try {
    const response = await (dependencies.fetch ?? fetch)(url, {
      method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", "x-telecodex-review-token": secret },
      body: JSON.stringify({ chatId: request.chatId, messageThreadId: request.messageThreadId, messageId: request.messageId, ref: request.ref }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 202) throw new Error("MirCli deploy view failed");
  } catch { throw new Error("MirCli deploy view failed"); }
}
