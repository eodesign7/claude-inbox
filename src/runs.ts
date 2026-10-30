import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InboxError } from "./base.js";
import { readCard } from "./cards.js";
import type { Db } from "./db.js";
import { findClaude } from "./find-claude.js";
import { homeDir } from "./paths.js";

export interface RunRow {
  id: number;
  thread_id: number;
  agent: string;
  cwd: string;
  log_path: string;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
}

const STALE_MS = 6 * 3600_000;

export function listRuns(db: Db, limit = 20): RunRow[] {
  return db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit) as RunRow[];
}

export function isRunning(db: Db, threadId: number): boolean {
  const r = db.prepare("SELECT started_at FROM runs WHERE thread_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1").get(threadId) as
    | { started_at: string }
    | undefined;
  return !!r && Date.now() - Date.parse(r.started_at) < STALE_MS;
}

/** The arguments of a headless run, computed from the project card at run time. */
export function runArgs(agent: string, threadId: number): { argv: string[]; cwd: string } {
  const card = readCard(agent);
  const cwd = (card?.meta.paths ?? []).find((p) => existsSync(p));
  if (!cwd) throw new InboxError(`Project ${agent} has no existing path in its card, cannot run headless.`);
  const prompt =
    `You are the Claude Code agent for the project "${agent}". The user approved task thread #${threadId} in claude-inbox. ` +
    `Call read_thread(${threadId}), do the work in this repository, and if something is unclear ask with ` +
    `reply(kind="question") and stop. When finished call close_thread(${threadId}, summary, focus, next). Do not start other threads.`;
  const mode = card?.meta.wake_permission_mode || "acceptEdits";
  const allowed = ["mcp__claude-inbox", ...(card?.meta.wake_allowed_tools?.split(",").map((t) => t.trim()).filter(Boolean) ?? [])];
  return { argv: ["-p", prompt, "--permission-mode", mode, "--allowedTools", allowed.join(",")], cwd };
}

/**
 * Starts a detached headless run for an approved task. Only called for projects whose card
 * says `wake: headless`; the run is a plain `claude -p` in the project's repo.
 */
export function startRun(db: Db, threadId: number, agent: string): { run_id: number; log: string } {
  if (isRunning(db, threadId)) throw new InboxError(`Thread #${threadId} already has a run in progress.`);
  const { cwd } = runArgs(agent, threadId); // validates before anything is written
  if (!findClaude()) throw new InboxError("Could not find the `claude` executable (set CLAUDE_INBOX_CLAUDE_BIN).");
  const dir = join(homeDir(), "runs");
  mkdirSync(dir, { recursive: true });
  const started = new Date().toISOString();
  const info = db
    .prepare("INSERT INTO runs (thread_id, agent, cwd, log_path, started_at) VALUES (?,?,?,?,?)")
    .run(threadId, agent, cwd, "", started);
  const id = Number(info.lastInsertRowid);
  const log = join(dir, `${id}.log`);
  db.prepare("UPDATE runs SET log_path = ? WHERE id = ?").run(log, id);
  // from the compiled package the runner sits next to this file; under ts runners (tests) it is in ../dist
  let runner = fileURLToPath(new URL("./run-task.js", import.meta.url));
  if (!existsSync(runner)) runner = fileURLToPath(new URL("../dist/run-task.js", import.meta.url));
  const child = spawn(process.execPath, [runner, String(id)], { detached: true, stdio: "ignore", env: { ...process.env, CLAUDE_INBOX_DB: db.name } });
  child.unref();
  return { run_id: id, log };
}
