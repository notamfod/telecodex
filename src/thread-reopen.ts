import { spawn } from "node:child_process";

export interface ReopenCommand {
  command: string;
  args: string[];
}

/**
 * The command that tells the sync tool a thread has been re-read from disk.
 * Split on whitespace, so a path containing spaces needs a wrapper script.
 */
export function parseReopenCommand(value: string | undefined): ReopenCommand | undefined {
  const parts = (value ?? "").trim().split(/\s+/).filter(Boolean);
  const [command, ...args] = parts;
  return command ? { command, args } : undefined;
}

export function runReopenCommand(reopen: ReopenCommand, threadId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(reopen.command, [...reopen.args, threadId], { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${reopen.command} exited with ${code ?? "no code"}`));
    });
  });
}
