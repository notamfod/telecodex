import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ReviewPipelineStore } from "../src/review-pipeline-store.js";

let directory: string | undefined;

afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });

function externalWriter(file: string): Promise<{ close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import Database from "better-sqlite3";
      const db = new Database(process.argv[1]);
      db.pragma("journal_mode = WAL");
      process.stdout.write("ready\\n");
      process.stdin.once("data", () => { db.exec("CREATE TABLE IF NOT EXISTS external_lock_test (id INTEGER); INSERT INTO external_lock_test VALUES (1)"); db.close(); });
    `, file], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.stdout.once("data", (chunk) => {
      if (String(chunk).trim() !== "ready") return reject(new Error("external SQLite writer did not become ready"));
      resolve({ close: () => new Promise((done, failed) => {
        child.once("exit", (code) => code === 0 ? done() : failed(new Error(`external SQLite writer exited ${code}: ${stderr}`)));
        child.stdin.end("close");
      }) });
    });
  });
}

it("does not release a live SQLite WAL lock while opening another pipeline store", async () => {
  directory = mkdtempSync(path.join(tmpdir(), "pipeline-sqlite-lock-"));
  const file = path.join(directory, "pipeline.sqlite");
  const first = new ReviewPipelineStore(file);
  let second: ReviewPipelineStore | undefined;
  let external: { close(): Promise<void> } | undefined;
  try {
    const job = first.enqueue({ recipe: "daily", project: "mir-back", cwd: "/repo", headSha: "a".repeat(40), finding: { severity: "medium", file: "x.ts", category: "state", description: "lost" } });
    external = await externalWriter(file);
    second = new ReviewPipelineStore(file);
    await external.close(); external = undefined;
    expect(existsSync(`${file}-wal`)).toBe(true);
    expect(first.get(job.id)).toMatchObject({ id: job.id });
  } finally {
    await external?.close().catch(() => undefined);
    second?.close(); first.close();
  }
});
