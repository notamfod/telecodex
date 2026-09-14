export type TeleCodexCleanupStep =
  | "begin-shutdown"
  | "topic-synchronizer"
  | "status-board"
  | "mini-app"
  | "runner"
  | "retention-runtime"
  | "reliability-runtime"
  | "background-write-gate"
  | "task-cards"
  | "sqlite-job-store"
  | "session-registry";

export interface TeleCodexLifecycleResources {
  topicSynchronizer?: { stop(): void };
  statusBoard?: { stop(): void };
  miniAppServer?: { close(): Promise<void> };
  runner?: { stop(): Promise<void> };
  retentionRuntime?: { dispose(): Promise<void> };
  reliabilityRuntime?: { dispose(): Promise<void> };
  backgroundWriteGate?: { dispose(): void };
  taskCards?: { dispose(): Promise<void> };
  sqliteJobStore?: { close(): void };
  registry?: { disposeAll(): void };
}

export interface TeleCodexTerminationOptions {
  exitCode: number;
  runner: "stop" | "inactive";
}

export interface TeleCodexLifecycle {
  cleanup(options: TeleCodexTerminationOptions): Promise<void>;
  terminate(options: TeleCodexTerminationOptions): Promise<void>;
}

export interface CreateTeleCodexLifecycleOptions {
  onBegin(): void;
  resources(): TeleCodexLifecycleResources;
  exit(code: number): void;
  onCleanupError?(step: TeleCodexCleanupStep, error: unknown): void;
  onRunnerStopIncomplete?(): void;
}

const RUNNER_STOP_TIMEOUT_MS = 5_000;

export function runTeleCodexShutdownSafely(
  shutdown: () => Promise<void>,
  onError: (error: unknown) => void,
): void {
  let termination: Promise<void>;
  try {
    termination = shutdown();
  } catch (error) {
    reportShutdownError(onError, error);
    return;
  }
  void termination.catch((error) => {
    reportShutdownError(onError, error);
  });
}

export function createTeleCodexLifecycle(
  options: CreateTeleCodexLifecycleOptions,
): TeleCodexLifecycle {
  let cleanupPromise: Promise<void> | undefined;
  let terminationPromise: Promise<void> | undefined;

  const reportFailure = (step: TeleCodexCleanupStep, error: unknown): void => {
    try {
      options.onCleanupError?.(step, error);
    } catch {
      // Cleanup diagnostics must not interrupt the remaining cleanup steps.
    }
  };

  const runSync = (step: TeleCodexCleanupStep, operation: (() => void) | undefined): void => {
    if (!operation) return;
    try {
      operation();
    } catch (error) {
      reportFailure(step, error);
    }
  };

  const runAsync = async (
    step: TeleCodexCleanupStep,
    operation: (() => Promise<void>) | undefined,
  ): Promise<void> => {
    if (!operation) return;
    try {
      await operation();
    } catch (error) {
      reportFailure(step, error);
    }
  };

  const runCleanup = async (termination: TeleCodexTerminationOptions): Promise<void> => {
    runSync("begin-shutdown", options.onBegin);

    let resources: TeleCodexLifecycleResources = {};
    try {
      resources = options.resources();
    } catch (error) {
      reportFailure("begin-shutdown", error);
    }

    runSync("topic-synchronizer", resources.topicSynchronizer?.stop.bind(resources.topicSynchronizer));
    runSync("status-board", resources.statusBoard?.stop.bind(resources.statusBoard));
    await runAsync("mini-app", resources.miniAppServer?.close.bind(resources.miniAppServer));

    let runnerStoppedCleanly = true;
    if (termination.runner === "stop" && resources.runner) {
      runnerStoppedCleanly = await stopRunnerWithin(resources.runner, RUNNER_STOP_TIMEOUT_MS);
      if (!runnerStoppedCleanly) {
        try {
          options.onRunnerStopIncomplete?.();
        } catch (error) {
          reportFailure("runner", error);
        }
      }
    }

    await runAsync(
      "retention-runtime",
      resources.retentionRuntime?.dispose.bind(resources.retentionRuntime),
    );

    let reliabilityDrain: Promise<void> | undefined;
    if (resources.reliabilityRuntime) {
      try {
        reliabilityDrain = resources.reliabilityRuntime.dispose();
      } catch (error) {
        reportFailure("reliability-runtime", error);
      }
    }
    runSync(
      "background-write-gate",
      resources.backgroundWriteGate?.dispose.bind(resources.backgroundWriteGate),
    );
    if (reliabilityDrain) {
      await reliabilityDrain.catch((error) => {
        reportFailure("reliability-runtime", error);
      });
    }

    await runAsync("task-cards", resources.taskCards?.dispose.bind(resources.taskCards));
    if (runnerStoppedCleanly) {
      runSync("sqlite-job-store", resources.sqliteJobStore?.close.bind(resources.sqliteJobStore));
      runSync("session-registry", resources.registry?.disposeAll.bind(resources.registry));
    }
  };

  const cleanup = (termination: TeleCodexTerminationOptions): Promise<void> => {
    if (!cleanupPromise) {
      let resolveCleanup!: () => void;
      let rejectCleanup!: (error: unknown) => void;
      cleanupPromise = new Promise<void>((resolve, reject) => {
        resolveCleanup = resolve;
        rejectCleanup = reject;
      });
      void runCleanup(termination).then(resolveCleanup, rejectCleanup);
    }
    return cleanupPromise;
  };

  const terminate = (termination: TeleCodexTerminationOptions): Promise<void> => {
    if (!terminationPromise) {
      let resolveTermination!: () => void;
      let rejectTermination!: (error: unknown) => void;
      terminationPromise = new Promise<void>((resolve, reject) => {
        resolveTermination = resolve;
        rejectTermination = reject;
      });
      void cleanup(termination).then(
        () => {
          try {
            options.exit(termination.exitCode);
            resolveTermination();
          } catch (error) {
            rejectTermination(error);
          }
        },
        rejectTermination,
      );
    }
    return terminationPromise;
  };

  return Object.freeze({ cleanup, terminate });
}

async function stopRunnerWithin(
  runner: { stop(): Promise<void> },
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    const stopResult = Promise.resolve()
      .then(() => runner.stop())
      .then(() => true as const, () => false as const);
    return await Promise.race([stopResult, timeoutResult]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function reportShutdownError(onError: (error: unknown) => void, error: unknown): void {
  try {
    onError(error);
  } catch {
    // A terminal signal handler must not create another unhandled failure.
  }
}
