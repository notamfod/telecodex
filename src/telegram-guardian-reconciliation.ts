import {
  GuardianIpcTimeoutError,
  type GuardianIpcResponse,
} from "./session-guardian-ipc-client.js";

export type TelegramGuardianReconciliationInspection =
  | { readonly availability: "unavailable"; readonly reasonCode: "guardian_timeout" | "guardian_unavailable" }
  | {
      readonly availability: "available";
      readonly state: "in_progress" | "restored" | "failed" | "none";
      readonly reasonCode?: string;
    }
  | {
      readonly availability: "available";
      readonly state: "self_recovered";
      readonly threadId: string;
      readonly turnId: string;
    };

export interface TelegramGuardianInspector {
  inspectThread(threadId: string): Promise<GuardianIpcResponse>;
}

export interface TelegramGuardianOperationalClient extends TelegramGuardianInspector {
  repairAlert(alertId: string): Promise<GuardianIpcResponse>;
}

export interface TelegramGuardianProbeClient {
  status(): Promise<GuardianIpcResponse>;
}

export function createTelegramGuardianRuntimeFacade(clients: {
  readonly operational: TelegramGuardianOperationalClient;
  readonly probe: TelegramGuardianProbeClient;
}): TelegramGuardianOperationalClient & TelegramGuardianProbeClient {
  return {
    inspectThread: (threadId) => clients.operational.inspectThread(threadId),
    repairAlert: (alertId) => clients.operational.repairAlert(alertId),
    status: () => clients.probe.status(),
  };
}

/** Read-only Guardian coordination. TeleCodex never repairs a session here. */
export async function inspectTelegramGuardian(
  guardian: TelegramGuardianInspector,
  input: { readonly threadId: string; readonly turnId: string },
): Promise<TelegramGuardianReconciliationInspection> {
  try {
    const response = await guardian.inspectThread(input.threadId);
    const thread = response.thread;
    if (!thread || response.threadId !== input.threadId || thread.threadId !== input.threadId) {
      return { availability: "available", state: "failed", reasonCode: "guardian_identity_mismatch" };
    }
    const observation = thread.observation;
    if (!observation || observation.repairState === "none" || observation.repairState === "eligible") {
      return { availability: "available", state: "none" };
    }
    if (observation.repairState === "in_progress") {
      return { availability: "available", state: "in_progress" };
    }
    if (observation.repairOutcome === "restored") {
      return { availability: "available", state: "restored" };
    }
    if (observation.repairOutcome === "self-recovered" && thread.turnId !== null) {
      return {
        availability: "available", state: "self_recovered",
        threadId: thread.threadId, turnId: thread.turnId,
      };
    }
    return { availability: "available", state: "failed", reasonCode: "guardian_repair_failed" };
  } catch (error) {
    return { availability: "unavailable", reasonCode: error instanceof GuardianIpcTimeoutError
      ? "guardian_timeout" : "guardian_unavailable" };
  }
}
