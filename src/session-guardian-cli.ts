import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import { loadSessionGuardianEnvironment, parseSessionGuardianConfig }
  from "./session-guardian-config.js";
import { SessionGuardianIpcClient, assertGuardianThreadId,
  type GuardianIpcResponse } from "./session-guardian-ipc-client.js";

const HELP = `Usage: guardian:cli <command>

Commands:
  status
  scan
  inspect <UUID>
  repair <UUID>

Exit codes:
  0 success
  1 daemon operation failed
  2 usage or invalid UUID
  3 daemon unavailable or timed out`;

interface GuardianCliClient {
  status(): Promise<GuardianIpcResponse>;
  scan(): Promise<GuardianIpcResponse>;
  inspectThread(threadId: string): Promise<GuardianIpcResponse>;
  repairThread(threadId: string): Promise<GuardianIpcResponse>;
}

export interface GuardianCliDependencies {
  readonly connect?: () => GuardianCliClient;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

export async function runSessionGuardianCli(
  argv: readonly string[],
  dependencies: GuardianCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const stderr = dependencies.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    stdout(HELP);
    return 0;
  }
  const parsed = parseCommand(argv);
  if (typeof parsed === "string") {
    stderr(failureJson(parsed));
    return 2;
  }

  let client: GuardianCliClient;
  try { client = (dependencies.connect ?? defaultConnect)(); }
  catch {
    stderr(failureJson("Guardian daemon unavailable"));
    return 3;
  }
  try {
    const response = parsed.command === "status" ? await client.status()
      : parsed.command === "scan" ? await client.scan()
        : parsed.command === "inspect" ? await client.inspectThread(parsed.threadId)
          : await client.repairThread(parsed.threadId);
    stdout(JSON.stringify(response));
    return response.outcome === "failed" ? 1 : 0;
  } catch (error) {
    const unavailable = error instanceof Error
      && (error.message.includes("unavailable") || error.message.includes("timed out"));
    stderr(failureJson(unavailable ? "Guardian daemon unavailable" : "Guardian operation failed"));
    return unavailable ? 3 : 1;
  }
}

type GuardianCliCommand =
  | { readonly command: "status" }
  | { readonly command: "scan" }
  | { readonly command: "inspect"; readonly threadId: string }
  | { readonly command: "repair"; readonly threadId: string };

function parseCommand(argv: readonly string[]): GuardianCliCommand | string {
  if (argv.length === 1 && (argv[0] === "status" || argv[0] === "scan")) {
    return { command: argv[0] };
  }
  if (argv.length === 2 && (argv[0] === "inspect" || argv[0] === "repair")) {
    try { assertGuardianThreadId(argv[1]!); }
    catch { return "Invalid UUID. Run with --help for usage."; }
    return { command: argv[0], threadId: argv[1]! };
  }
  return "Invalid usage. Run with --help for usage.";
}

function defaultConnect(): GuardianCliClient {
  const loaded = loadSessionGuardianEnvironment({ cwd: process.cwd(), env: process.env });
  const guardian = parseSessionGuardianConfig(loaded.env, {
    home: os.homedir(),
    workspace: loaded.workspace,
  });
  return new SessionGuardianIpcClient(guardian.socketPath);
}

function failureJson(message: string): string {
  return JSON.stringify({ outcome: "failed", message });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const exitCode = await runSessionGuardianCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
