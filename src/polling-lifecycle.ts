export interface RestartPollingAfterDelayOptions {
  delayMs: number;
  isShuttingDown(): boolean;
  restart(): Promise<void>;
  wait?(delayMs: number): Promise<void>;
}

export async function restartPollingAfterDelay(
  options: RestartPollingAfterDelayOptions,
): Promise<void> {
  await (options.wait ?? wait)(options.delayMs);
  if (options.isShuttingDown()) return;
  await options.restart();
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
