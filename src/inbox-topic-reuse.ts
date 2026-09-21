import type { Ticket } from "./inbox.js";
import type { TaskProvisioningInput, TaskProvisioningStore } from "./task-provisioning.js";
import { ForumTopicAvailabilityUnknownError } from "./telegram-topic-liveness.js";

export async function reuseInboxTopic(options: {
  candidates: Ticket[];
  input: TaskProvisioningInput;
  store: TaskProvisioningStore;
  topicIsAlive(topicId: number): Promise<boolean>;
  append(ticket: Ticket): Promise<boolean>;
  onDestination(ticket: Ticket): void;
}): Promise<{ appended: boolean; continueTicketId?: number }> {
  let missing: Ticket | undefined;
  for (const candidate of options.candidates) {
    if (!candidate.workTopicId) continue;
    let reusable: boolean;
    let availabilityUnknown = false;
    try { reusable = await options.topicIsAlive(candidate.workTopicId); }
    catch (error) {
      if (!(error instanceof ForumTopicAvailabilityUnknownError)) throw error;
      reusable = true;
      availabilityUnknown = true;
    }
    if (!reusable) { missing ??= candidate; continue; }
    if (candidate.resolvedAt !== undefined && !availabilityUnknown) continue;
    options.onDestination(candidate);
    options.store.accept({ ...options.input, metadata: { ticketId: candidate.id } });
    options.store.patch(options.input.operationId, { state: "bound", messageThreadId: candidate.workTopicId });
    try {
      if (await options.append(candidate)) {
        options.store.patch(options.input.operationId, { state: "ready" });
        return { appended: true };
      }
    } catch (error) {
      options.store.patch(options.input.operationId, { state: "unknown", failureStage: "ready" });
      throw error;
    }
    // A rejected destination is definitive; persist continuation before creating a topic.
    options.store.patch(options.input.operationId, {
      state: "accepted", messageThreadId: undefined,
      metadata: { ticketId: candidate.id, continueTicketId: candidate.id, previousWorkTopicId: candidate.workTopicId },
    });
    return { appended: false, continueTicketId: candidate.id };
  }
  return { appended: false, continueTicketId: missing?.id };
}
