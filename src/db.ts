import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homeDir } from "./paths.js";

export type Db = Database.Database;

export const defaultDbPath = () =>
  process.env.CLAUDE_INBOX_DB ?? join(homeDir(), "inbox.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject     TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  ticket      TEXT,
  approval    TEXT NOT NULL DEFAULT 'none',
  approval_at TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id   INTEGER NOT NULL REFERENCES threads(id),
  from_agent  TEXT NOT NULL,
  to_agent    TEXT NOT NULL,
  body        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('task','question','reply','summary')),
  read_at     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_to_read ON messages(to_agent, read_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  agent         TEXT NOT NULL,
  cwd           TEXT,
  git_branch    TEXT,
  started_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  ended_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent);
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id   INTEGER NOT NULL,
  agent       TEXT NOT NULL,
  cwd         TEXT NOT NULL,
  log_path    TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  exit_code   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id);
CREATE TABLE IF NOT EXISTS session_seen (
  session_id  TEXT NOT NULL,
  message_id  INTEGER NOT NULL,
  seen_at     TEXT NOT NULL,
  PRIMARY KEY (session_id, message_id)
);
`;

function isBusy(e: unknown) {
  return typeof e === "object" && e !== null && String((e as { code?: string }).code).startsWith("SQLITE_BUSY");
}

/** Doplní stĺpce pridané po v1. */
function migrate(db: Db) {
  const cols = (db.prepare("PRAGMA table_info(threads)").all() as { name: string }[]).map((c) => c.name);
  const add = (name: string, ddl: string) => {
    if (cols.includes(name)) return;
    try {
      db.exec(`ALTER TABLE threads ADD COLUMN ${ddl}`);
    } catch (e) {
      if (!/duplicate column/i.test(String(e))) throw e;
    }
  };
  add("ticket", "ticket TEXT");
  add("approval", "approval TEXT NOT NULL DEFAULT 'none'");
  add("approval_at", "approval_at TEXT");
}

export function openDb(path = defaultDbPath()): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("busy_timeout = 5000");
  // Prepnutie na WAL a vytvorenie schémy môže pri štarte dvoch procesov naraz
  // vrátiť BUSY aj napriek busy_timeout, preto krátky retry.
  for (let attempt = 0; ; attempt++) {
    try {
      db.pragma("journal_mode = WAL");
      db.exec(SCHEMA);
      migrate(db);
      break;
    } catch (e) {
      if (!isBusy(e) || attempt >= 50) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  db.pragma("synchronous = NORMAL");
  return db;
}

/** Len na čítanie; null, ak DB neexistuje alebo sa nedá otvoriť. */
export function openDbReadonly(path = defaultDbPath()): Db | null {
  if (!existsSync(path)) return null;
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 500");
    return db;
  } catch {
    return null;
  }
}
