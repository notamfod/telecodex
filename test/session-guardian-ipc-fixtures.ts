import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { createServer, request } from "node:http";
import { createConnection } from "node:net";
import path from "node:path";

import type { GuardianIpcResponse } from "../src/session-guardian-ipc.js";

export async function rawRequest(
  socketPath: string,
  method: string,
  route: string,
  body = "",
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; json: GuardianIpcResponse }> {
  return await new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path: route, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode ?? 0,
          text,
          json: JSON.parse(text) as GuardianIpcResponse,
        });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

export async function rawChunkedRequest(socketPath: string, route: string, chunks: string[]) {
  return await new Promise<{ status: number }>((resolve, reject) => {
    const req = request({
      socketPath,
      method: "POST",
      path: route,
      headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode ?? 0 }));
    });
    req.on("error", reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

export async function sendPartialRequest(socketPath: string, requestText: string): Promise<string> {
  return await collectPartialResponse(socketPath, (socket) => socket.write(requestText));
}

export async function sendDribblingRequest(socketPath: string, headers: string): Promise<string> {
  let interval: NodeJS.Timeout | undefined;
  return await collectPartialResponse(socketPath, (socket) => {
    socket.write(headers);
    interval = setInterval(() => socket.write("1\r\nx\r\n"), 10);
  }, () => {
    if (interval) clearInterval(interval);
  });
}

async function collectPartialResponse(
  socketPath: string,
  connected: (socket: ReturnType<typeof createConnection>) => void,
  cleanup = () => undefined,
): Promise<string> {
  const socket = createConnection({ path: socketPath });
  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("partial request stayed open"));
    }, 500);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("connect", () => connected(socket));
    socket.once("error", reject);
    socket.once("close", () => {
      cleanup();
      clearTimeout(deadline);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

export function makeStaleSocket(socketPath: string): void {
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(socketPath), 0o700);
  execFileSync("python3", [
    "-c",
    "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()",
    socketPath,
  ]);
}

export async function startRawServer(
  socketPath: string,
  handler: Parameters<typeof createServer>[0],
) {
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const raw = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    raw.once("error", reject);
    raw.listen(socketPath, resolve);
  });
  return raw;
}
