import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TelegramBackgroundWriteGateAdmissionCancelledError } from "../src/telegram-background-write-gate.js";
import { afterEach, expect, it, vi } from "vitest";
import { TaskProvisioningService, TaskProvisioningStore } from "../src/task-provisioning.js";
import { provisionSyncedTopic } from "../src/topic-sync-provisioning.js";
afterEach(() => vi.useRealTimers());
const thread = { id: "one", cwd: "/srv/project", title: "title", firstUserMessage: "", createdAt: new Date(), updatedAt: new Date(), model: null };
it("does not recreate an uncertain creation after a new synchronizer or mode change", async () => {
 const service = new TaskProvisioningService(new TaskProvisioningStore(":memory:"));
 const create = vi.fn().mockRejectedValue(new Error("network timeout")); const bind = vi.fn();
 await expect(provisionSyncedTopic(service, 1, thread, create, bind)).rejects.toThrow("network timeout");
 expect(await provisionSyncedTopic(service, 1, {...thread, title: "renamed"}, create, bind)).toBe("skipped");
 expect(create).toHaveBeenCalledTimes(1); await service.dispose();
});
it("retains created topic identity when durable binding fails", async () => {
 const service = new TaskProvisioningService(new TaskProvisioningStore(":memory:"));
 const create = vi.fn().mockResolvedValue({message_thread_id: 42}); const bind = vi.fn().mockImplementation(() => {throw new Error("disk full");});
 await expect(provisionSyncedTopic(service, 1, thread, create, bind)).rejects.toThrow("disk full");
 expect(await provisionSyncedTopic(service, 1, thread, create, bind)).toBe("skipped");
 expect(service.store.get("sync:1:one")?.messageThreadId).toBe(42); expect(create).toHaveBeenCalledTimes(1); await service.dispose();
});
it("retries a definite rate-limit rejection without retrying ambiguous transport failures", async () => {
 const service = new TaskProvisioningService(new TaskProvisioningStore(":memory:"));
 vi.useFakeTimers();
 const error = {error_code: 429, parameters: {retry_after: 30}};
 const create = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({message_thread_id: 42});
 await expect(provisionSyncedTopic(service, 1, thread, create, vi.fn())).rejects.toEqual(error);
 expect(await provisionSyncedTopic(service, 1, thread, create, vi.fn())).toBe("skipped");
 await vi.advanceTimersByTimeAsync(30_001);
 expect(await provisionSyncedTopic(service, 1, thread, create, vi.fn())).toBe("created");
 expect(create).toHaveBeenCalledTimes(2); await service.dispose();
});

it("retries proven gate admission cancellation after a bounded pause", async () => {
 vi.useFakeTimers();
 const service = new TaskProvisioningService(new TaskProvisioningStore(":memory:"));
 const create = vi.fn().mockRejectedValueOnce(new TelegramBackgroundWriteGateAdmissionCancelledError()).mockResolvedValue({message_thread_id: 42});
 await expect(provisionSyncedTopic(service, 1, thread, create, vi.fn())).rejects.toThrow();
 await vi.advanceTimersByTimeAsync(1001);
 expect(await provisionSyncedTopic(service, 1, thread, create, vi.fn())).toBe("created");
 expect(create).toHaveBeenCalledTimes(2); await service.dispose();
});

it("retains unknown creation across closing and reopening the durable store", async () => {
 const dir = mkdtempSync(path.join(tmpdir(), "sync-restart-"));
 const file = path.join(dir, "provision.sqlite");
 let service = new TaskProvisioningService(new TaskProvisioningStore(file));
 const create = vi.fn().mockRejectedValue(new Error("timeout"));
 try {
  await expect(provisionSyncedTopic(service, 1, thread, create, vi.fn())).rejects.toThrow("timeout");
  await service.dispose();
  service = new TaskProvisioningService(new TaskProvisioningStore(file));
  expect(await provisionSyncedTopic(service, 1, thread, create, vi.fn())).toBe("skipped");
  expect(create).toHaveBeenCalledTimes(1);
 } finally { await service.dispose(); rmSync(dir, {recursive: true, force: true}); }
});
