import {
  closeSync,
  constants as fsConstants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type ReadStream,
} from "node:fs";
import path from "node:path";

import { TelegramDeliveryLocalError } from "./telegram-delivery-error.js";

export interface OpenTelegramAttachment<T> {
  readonly source: T;
  readonly fd: number;
  readonly descriptorTarget: string;
}

export function openContainedAttachments<T extends { readonly path: string }>(
  root: string,
  sources: readonly T[],
): OpenTelegramAttachment<T>[] {
  const files: OpenTelegramAttachment<T>[] = [];
  try {
    const canonicalRoot = realpathSync(root);
    if (!lstatSync(canonicalRoot).isDirectory()) throw new Error("unsafe");
    for (const source of sources) {
      const candidate = path.resolve(canonicalRoot, ...source.path.split("/"));
      if (!isContained(canonicalRoot, candidate)) throw new Error("unsafe");
      const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
      const fd = openSync(candidate, fsConstants.O_RDONLY | noFollow);
      files.push({ source, fd, descriptorTarget: "" });
      if (!fstatSync(fd).isFile()) throw new Error("unsafe");
      const descriptorTarget = realpathSync(`/proc/self/fd/${fd}`);
      if (!isContained(canonicalRoot, descriptorTarget)) throw new Error("unsafe");
      files[files.length - 1] = { source, fd, descriptorTarget };
    }
    return files;
  } catch {
    for (const file of files) closeDescriptor(file.fd);
    throw new TelegramDeliveryLocalError();
  }
}

export function attachmentReadStream(file: OpenTelegramAttachment<unknown>): ReadStream {
  return createReadStream(file.descriptorTarget, { fd: file.fd, autoClose: false });
}

export async function closeAttachmentFiles(
  files: readonly OpenTelegramAttachment<unknown>[],
  streams: readonly ReadStream[],
): Promise<void> {
  await Promise.all(streams.map(destroyReadStream));
  for (const file of files) closeDescriptor(file.fd);
}

function destroyReadStream(stream: ReadStream): Promise<void> {
  if (stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once("close", resolve);
    stream.once("error", () => undefined);
    stream.destroy();
  });
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function closeDescriptor(fd: number): void {
  try { closeSync(fd); }
  catch { /* A consumed ReadStream may already have closed the descriptor. */ }
}
