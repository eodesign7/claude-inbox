#!/usr/bin/env node
// Detached runner of one headless task: node run-task.js <run_id>
import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { openDb } from "./db.js";
import { findClaude } from "./find-claude.js";
import { runArgs, type RunRow } from "./runs.js";

const id = Number(process.argv[2]);
const db = openDb();
const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
if (!run) process.exit(1);

const log = openSync(run.log_path, "a");
const end = (code: number, note?: string) => {
  if (note) writeSync(log, `\n[claude-inbox] ${note}\n`);
  closeSync(log);
  db.prepare("UPDATE runs SET ended_at = ?, exit_code = ? WHERE id = ?").run(new Date().toISOString(), code, id);
  process.exit(0);
};

try {
  const bin = findClaude();
  if (!bin) end(-1, "claude executable not found");
  const { argv, cwd } = runArgs(run.agent, run.thread_id);
  const child = spawn(bin!, argv, { cwd, stdio: ["ignore", log, log], env: { ...process.env, CLAUDE_INBOX_RUN: String(id) } });
  child.on("error", (e) => end(-1, `could not start: ${e.message}`));
  child.on("exit", (code, signal) => end(code ?? -1, signal ? `killed by ${signal}` : undefined));
} catch (e) {
  end(-1, e instanceof Error ? e.message : String(e));
}
