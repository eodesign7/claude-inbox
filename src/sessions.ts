import type { Db } from "./db.js";

export const ACTIVE_MS = 2 * 3600_000;

export interface SessionInfo {
  session_id: string;
  agent: string;
  cwd: string | null;
  git_branch: string | null;
}

const iso = (d = new Date()) => d.toISOString();

/** SessionStart (aj obnova): založí alebo oživí záznam. */
export function startSession(db: Db, s: SessionInfo, now = new Date()) {
  db.prepare(
    `INSERT INTO sessions (session_id, agent, cwd, git_branch, started_at, last_seen_at, ended_at)
     VALUES (?,?,?,?,?,?,NULL)
     ON CONFLICT(session_id) DO UPDATE SET agent = excluded.agent, cwd = excluded.cwd,
       git_branch = excluded.git_branch, last_seen_at = excluded.last_seen_at, ended_at = NULL`,
  ).run(s.session_id, s.agent, s.cwd, s.git_branch, iso(now), iso(now));
}

/** UserPromptSubmit: obnoví last_seen_at; ak SessionStart chýbal, session založí. */
export function touchSession(db: Db, s: SessionInfo, now = new Date()) {
  const r = db
    .prepare("UPDATE sessions SET last_seen_at = ?, git_branch = COALESCE(?, git_branch) WHERE session_id = ?")
    .run(iso(now), s.git_branch, s.session_id);
  if (!r.changes) startSession(db, s, now);
}

export function endSession(db: Db, sessionId: string, now = new Date()) {
  db.prepare("UPDATE sessions SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL").run(iso(now), sessionId);
}

export interface ActiveSession {
  session_id: string;
  agent: string;
  cwd: string | null;
  git_branch: string | null;
  started_at: string;
  last_seen_at: string;
}

/** Aktívna = bez ended_at a last_seen_at do 2 hodín. */
export function activeSessions(db: Db, agent?: string, now = new Date()): ActiveSession[] {
  const since = iso(new Date(now.getTime() - ACTIVE_MS));
  return db
    .prepare(
      `SELECT session_id, agent, cwd, git_branch, started_at, last_seen_at FROM sessions
       WHERE ended_at IS NULL AND last_seen_at >= ? ${agent ? "AND agent = ?" : ""}
       ORDER BY last_seen_at DESC`,
    )
    .all(...(agent ? [since, agent] : [since])) as ActiveSession[];
}
