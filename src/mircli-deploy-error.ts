interface FailureOptions {
  base: string;
  token: string;
  projectId: number;
  jobId: number;
  failureReason?: unknown;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}
const TAIL_BYTES = 16_384;
const MAX_BYTES = 1_048_576;
const MAX_CACHE = 256;
const summaries = new Map<string, string>();
const SCRIPT_FAILURE = "Сбой скрипта деплоя";
const lintRules: Readonly<Record<string, string>> = {
  "react-hooks/exhaustive-deps": "Ошибка ESLint: зависимости React Hook (react-hooks/exhaustive-deps)",
  "react-hooks/rules-of-hooks": "Ошибка ESLint: нарушен порядок вызова React Hook (react-hooks/rules-of-hooks)",
  "@typescript-eslint/no-explicit-any": "Ошибка ESLint: запрещён тип any (@typescript-eslint/no-explicit-any)",
  "@typescript-eslint/no-unused-vars": "Ошибка ESLint: неиспользуемая переменная (@typescript-eslint/no-unused-vars)",
  "react/no-unescaped-entities": "Ошибка ESLint: неэкранированные символы в JSX (react/no-unescaped-entities)",
};
const reasons: Readonly<Record<string, string>> = {
  script_failure: SCRIPT_FAILURE,
  runner_system_failure: "Системная ошибка GitLab Runner",
  stuck_or_timeout_failure: "Задание зависло или превысило время выполнения",
  job_execution_timeout: "Превышено время выполнения задания",
  scheduler_failure: "Ошибка планировщика GitLab",
  missing_dependency_failure: "Отсутствует необходимая зависимость задания",
  api_failure: "Ошибка API GitLab",
  data_integrity_failure: "Ошибка целостности данных GitLab",
  unmet_prerequisites: "Не выполнены условия запуска задания",
};
function category(reason: unknown): string {
  return typeof reason === "string" && Object.hasOwn(reasons, reason) ? reasons[reason] : SCRIPT_FAILURE;
}

/** Return only fixed diagnostic classes and safe numeric codes, never raw CI text.
 * Shell traces may contain credentials even in ordinary-looking error messages.
 */
export function extractDeployFailure(trace: string): string | undefined {
  const lines = trace.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    if (!line || line.length > 4096 || /^[+$]/.test(line)
      || /^(?:section_(?:start|end)|Uploading artifacts|Cleaning up|ERROR: Job failed)/i.test(line)
      || /^(?:echo|printf|export|curl|wget|env|set|eval|bash|sh|werf|kubectl|docker|helm)\b/.test(line)) continue;
    if (/\b(?:ErrImagePull|ImagePullBackOff|failed to pull image)\b/i.test(line)) return "Не удалось загрузить образ контейнера";
    if (/\b(?:readiness|startup) probe failed\b/i.test(line)) {
      const code = line.match(/\bstatus(?:code| code)?[:= ]+(\d{3})\b/i)?.[1];
      return `Проверка готовности приложения не прошла${code ? ` (HTTP ${code})` : ""}`;
    }
    if (/\b(?:OOMKilled|out of memory)\b/i.test(line)) return "Контейнер завершён из-за нехватки памяти (OOMKilled)";
    if (/\bInsufficient cpu\b/i.test(line)) return "Недостаточно CPU для размещения контейнеров";
    if (/\bInsufficient memory\b/i.test(line)) return "Недостаточно памяти для размещения контейнеров";
    if (/\b(?:timed out waiting for|context deadline exceeded|ProgressDeadlineExceeded|rollout.*timed out)\b/i.test(line)) return "Превышено время ожидания готовности ресурсов Kubernetes";
    if (/\bError:/i.test(line)) {
      for (const rule of Object.keys(lintRules)) {
        if (line.endsWith(rule)) return lintRules[rule];
      }
    }
    if (/\b(?:Module not found|Cannot find module|MODULE_NOT_FOUND)\b/i.test(line)) return "Ошибка сборки: модуль не найден";
    if (/\b(?:SassError|CssSyntaxError)\b/i.test(line)) return "Ошибка сборки стилей приложения";
    const typeCode = line.match(/\berror (TS\d{3,5})\b/i)?.[1];
    if (typeCode) return `Ошибка компиляции TypeScript (${typeCode.toUpperCase()})`;
    if (/\b(?:compilation failed|failed to compile|syntax error|undefined:|cannot use .* as .* in)\b/i.test(line)) return "Ошибка компиляции приложения";
    if (/\bconnection refused\b/i.test(line)) return "Зависимость недоступна: соединение отклонено";
    if (/\b(?:no such host|Could not resolve host|temporary failure in name resolution)\b/i.test(line)) return "Зависимость недоступна: ошибка DNS";
    if (/\b(?:CrashLoopBackOff|Back-off restarting failed container)\b/i.test(line)) return "Контейнер приложения постоянно перезапускается";
    if (/\b(?:Forbidden|Unauthorized)\b.*\b(?:kubernetes|deployments|pods|resource|serviceaccount)\b/i.test(line)) return "Недостаточно прав для доступа к ресурсам Kubernetes";
  }
  return undefined;
}

async function readBounded(response: Response, signal: AbortSignal, limit: number, tail: boolean): Promise<string> {
  if (!response.body || signal.aborted) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("Unavailable body");
  }
  const reader = response.body.getReader();
  let total = 0;
  let buffer = new Uint8Array(0);
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new Error("Aborted");
      const part = await reader.read();
      if (signal.aborted) throw new Error("Aborted");
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) throw new Error("Body budget exceeded");
      const keep = tail ? TAIL_BYTES : limit;
      const chunk = part.value.subarray(Math.max(0, part.value.length - keep));
      const previous = buffer.subarray(Math.max(0, buffer.length - (keep - chunk.length)));
      const combined = new Uint8Array(previous.length + chunk.length);
      combined.set(previous); combined.set(chunk, previous.length); buffer = combined;
    }
    return new TextDecoder().decode(buffer);
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function collectDeployFailure(options: FailureOptions): Promise<string> {
  const fallback = category(options.failureReason);
  if (options.signal?.aborted) return fallback;
  const key = `${options.base}/${options.projectId}/${options.jobId}`;
  const cached = summaries.get(key);
  if (cached) return cached;
  let reason = options.failureReason;
  let retry = false;
  const request = async (trace: boolean): Promise<string | undefined> => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 10_000);
    try {
      // Race fetch as well as cancel body: injected transports may ignore AbortSignal.
      const canceled = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
      });
      const response = await Promise.race([(options.fetch ?? globalThis.fetch)(
        `${options.base}/api/v4/projects/${options.projectId}/jobs/${options.jobId}${trace ? "/trace" : ""}`,
        { headers: { "PRIVATE-TOKEN": options.token, ...(trace ? { Range: `bytes=-${TAIL_BYTES}` } : {}) },
          signal: controller.signal, redirect: "error" }).then((response) => {
            if (controller.signal.aborted) void response.body?.cancel().catch(() => undefined);
            return response;
          }), canceled]);
      if (response.status === 404) { void response.body?.cancel().catch(() => undefined); return undefined; }
      if (response.status !== 200 && !(trace && response.status === 206)) {
        void response.body?.cancel().catch(() => undefined); throw new Error("Unavailable response");
      }
      return await readBounded(response, controller.signal, trace ? MAX_BYTES : 65_536, trace);
    } catch { retry = true; return undefined; }
    finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
  };
  if (typeof reason !== "string" || !Object.hasOwn(reasons, reason)) {
    const body = await request(false);
    if (body !== undefined) {
      try {
        const job: unknown = JSON.parse(body);
        if (job && typeof job === "object" && "failure_reason" in job) reason = job.failure_reason;
        else retry = true;
      } catch { retry = true; }
    }
  }
  let summary = category(reason);
  if (summary === SCRIPT_FAILURE && !options.signal?.aborted) {
    const trace = await request(true);
    if (trace !== undefined) summary = extractDeployFailure(trace) ?? summary;
  }
  if (!retry && !options.signal?.aborted) {
    if (summaries.size >= MAX_CACHE) summaries.delete(summaries.keys().next().value!);
    summaries.set(key, summary);
  }
  return summary;
}
