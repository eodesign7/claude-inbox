import { InboxError, agentName } from "./base.js";
import { assertSectionText, updateSections } from "./cards.js";
import type { Db } from "./db.js";
import { appendLog } from "./log.js";

export { InboxError, agentName };

export const KINDS = ["task", "question", "reply", "summary"] as const;
export type Kind = (typeof KINDS)[number];
export const STATUSES = ["open", "done", "cancelled"] as const;
export type Status = (typeof STATUSES)[number];

export interface ThreadRow {
  id: number;
  subject: string;
  created_by: string;
  ticket: string | null;
  status: Status;
  created_at: string;
  updated_at: string;
}
export interface MessageRow {
  id: number;
  thread_id: number;
  from_agent: string;
  to_agent: string;
  body: string;
  kind: Kind;
  read_at: string | null;
  created_at: string;
}

const now = () => new Date().toISOString();

function insertMessage(
  db: Db,
  threadId: number,
  from: string,
  to: string,
  body: string,
  kind: Kind,
): number {
  const t = now();
  const info = db
    .prepare(
      "INSERT INTO messages (thread_id, from_agent, to_agent, body, kind, created_at) VALUES (?,?,?,?,?,?)",
    )
    .run(threadId, from, to, body, kind, t);
  db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(t, threadId);
  return Number(info.lastInsertRowid);
}

function loadThread(db: Db, id: number): ThreadRow {
  const t = db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
  if (!t) throw new InboxError(`Vlákno ${id} neexistuje.`);
  return t;
}

function isParticipant(db: Db, t: ThreadRow, agent: string): boolean {
  if (t.created_by === agent) return true;
  return !!db
    .prepare("SELECT 1 FROM messages WHERE thread_id = ? AND (from_agent = ? OR to_agent = ?) LIMIT 1")
    .get(t.id, agent, agent);
}

function assertParticipant(db: Db, t: ThreadRow, agent: string) {
  if (!isParticipant(db, t, agent)) throw new InboxError(`${agent} nie je účastník vlákna ${t.id}.`);
}

/** Druhá strana vlákna z pohľadu `me`. */
function otherSide(db: Db, t: ThreadRow, me: string): string {
  const last = db
    .prepare("SELECT from_agent FROM messages WHERE thread_id = ? AND from_agent != ? ORDER BY id DESC LIMIT 1")
    .get(t.id, me) as { from_agent: string } | undefined;
  if (last) return last.from_agent;
  const first = db
    .prepare("SELECT to_agent FROM messages WHERE thread_id = ? AND to_agent != ? ORDER BY id ASC LIMIT 1")
    .get(t.id, me) as { to_agent: string } | undefined;
  if (first) return first.to_agent;
  throw new InboxError(`Vlákno ${t.id} nemá druhú stranu.`);
}

function participants(db: Db, threadId: number): string[] {
  const rows = db
    .prepare(
      "SELECT from_agent AS a FROM messages WHERE thread_id = ? UNION SELECT to_agent FROM messages WHERE thread_id = ?",
    )
    .all(threadId, threadId) as { a: string }[];
  return rows.map((r) => r.a).sort();
}

function requireBody(body: string) {
  if (!body || !body.trim()) throw new InboxError("Prázdna správa.");
}

export function sendMessage(
  db: Db,
  from: string,
  to: string,
  subject: string,
  body: string,
  kind: Kind,
  ticket?: string,
) {
  from = agentName(from, "odosielateľ");
  to = agentName(to, "adresát");
  if (from === to) throw new InboxError("Nemožno poslať správu sám sebe.");
  if (!subject || !subject.trim()) throw new InboxError("Prázdny subject.");
  requireBody(body);
  return db
    .transaction(() => {
      const t = now();
      const info = db
        .prepare(
          "INSERT INTO threads (subject, created_by, ticket, status, created_at, updated_at) VALUES (?,?,?, 'open', ?, ?)",
        )
        .run(subject.trim(), from, ticket?.trim() || null, t, t);
      const threadId = Number(info.lastInsertRowid);
      const messageId = insertMessage(db, threadId, from, to, body, kind);
      return { thread_id: threadId, message_id: messageId };
    })
    .immediate();
}

export function listAllThreads(db: Db, status: Status | "all" = "open") {
  const rows = (
    status === "all"
      ? db.prepare("SELECT * FROM threads ORDER BY updated_at DESC, id DESC").all()
      : db.prepare("SELECT * FROM threads WHERE status = ? ORDER BY updated_at DESC, id DESC").all(status)
  ) as ThreadRow[];
  return rows.map((t) => {
    const c = db
      .prepare("SELECT COUNT(*) AS n, SUM(read_at IS NULL) AS unread FROM messages WHERE thread_id = ?")
      .get(t.id) as { n: number; unread: number | null };
    return {
      id: t.id,
      subject: t.subject,
      status: t.status,
      created_by: t.created_by,
      ticket: t.ticket,
      participants: participants(db, t.id),
      messages: c.n,
      unread: c.unread ?? 0,
      updated_at: t.updated_at,
    };
  });
}

/** Celé vlákno bez vedľajších účinkov (bez označenia za prečítané). */
export function getThread(db: Db, id: number) {
  const thread = loadThread(db, id);
  const messages = db
    .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY id ASC")
    .all(id) as MessageRow[];
  return { thread, messages };
}

export class Inbox {
  constructor(
    readonly db: Db,
    readonly agent: string,
  ) {
    this.agent = agentName(agent, "CLAUDE_INBOX_AGENT");
  }

  send(to: string, subject: string, body: string, kind: Kind = "task", ticket?: string) {
    return sendMessage(this.db, this.agent, to, subject, body, kind, ticket);
  }

  reply(threadId: number, body: string, kind: Kind = "reply", to?: string) {
    requireBody(body);
    return this.db
      .transaction(() => {
        const t = loadThread(this.db, threadId);
        assertParticipant(this.db, t, this.agent);
        if (t.status !== "open") throw new InboxError(`Vlákno ${threadId} je ${t.status}.`);
        const target = to ? agentName(to, "adresát") : otherSide(this.db, t, this.agent);
        if (target === this.agent) throw new InboxError("Nemožno poslať správu sám sebe.");
        const messageId = insertMessage(this.db, threadId, this.agent, target, body, kind);
        return { thread_id: threadId, message_id: messageId, to: target };
      })
      .immediate();
  }

  inbox(unreadOnly = true, limit = 50) {
    const sql = `
      SELECT m.id AS message_id, m.thread_id, t.subject, m.from_agent AS "from", m.kind,
             substr(m.body, 1, 200) AS preview, m.read_at IS NULL AS unread, m.created_at
      FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE m.to_agent = ? ${unreadOnly ? "AND m.read_at IS NULL" : ""}
      ORDER BY m.id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(this.agent, limit) as Record<string, unknown>[];
    return rows.map((r) => ({ ...r, unread: !!r.unread }));
  }

  readThread(threadId: number) {
    return this.db
      .transaction(() => {
        const t = loadThread(this.db, threadId);
        assertParticipant(this.db, t, this.agent);
        this.db
          .prepare("UPDATE messages SET read_at = ? WHERE thread_id = ? AND to_agent = ? AND read_at IS NULL")
          .run(now(), threadId, this.agent);
        return getThread(this.db, threadId);
      })
      .immediate();
  }

  closeThread(threadId: number, summary: string, focus?: string, next?: string) {
    requireBody(summary);
    if (focus !== undefined) assertSectionText(focus);
    if (next !== undefined) assertSectionText(next);
    const r = this.db
      .transaction(() => {
        const t = loadThread(this.db, threadId);
        assertParticipant(this.db, t, this.agent);
        if (t.status !== "open") throw new InboxError(`Vlákno ${threadId} je už ${t.status}.`);
        const target = otherSide(this.db, t, this.agent);
        // kto vlákno uzatvára, správy v ňom vybavil
        this.db
          .prepare("UPDATE messages SET read_at = ? WHERE thread_id = ? AND to_agent = ? AND read_at IS NULL")
          .run(now(), threadId, this.agent);
        const messageId = insertMessage(this.db, threadId, this.agent, target, summary, "summary");
        this.db.prepare("UPDATE threads SET status = 'done' WHERE id = ?").run(threadId);
        return { t, target, messageId };
      })
      .immediate();
    // súbory až po commite DB; log a karta sú zdroj pravdy pre kontext
    const log = appendLog({
      agent: this.agent,
      thread_id: threadId,
      subject: r.t.subject,
      ticket: r.t.ticket,
      summary,
    });
    const card_updated = updateSections(this.agent, { "Aktuálny fokus": focus, "Ďalší krok": next });
    return {
      thread_id: threadId,
      status: "done" as const,
      message_id: r.messageId,
      to: r.target,
      log,
      card_updated,
    };
  }

  threads(status: Status | "all" = "open", agent?: string) {
    const who = agent ? agentName(agent) : this.agent;
    return listAllThreads(this.db, status)
      .filter((t) => t.participants.includes(who) || t.created_by === who)
      .map((t) => {
        const unread = (
          this.db
            .prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND to_agent = ? AND read_at IS NULL")
            .get(t.id, who) as { n: number }
        ).n;
        const lastFrom = (
          this.db
            .prepare("SELECT from_agent AS f FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1")
            .get(t.id) as { f: string }
        ).f;
        const state: ThreadState | null =
          unread > 0 ? "nové" : t.status !== "open" ? null : lastFrom !== who ? "na tebe" : "čaká";
        return { ...t, unread, state };
      });
  }
}

export type ThreadState = "nové" | "na tebe" | "čaká";

export interface Overview {
  nove: number;
  naTebe: number;
  caka: number;
  /** subject najnovšej správy pre agenta (neprečítanej alebo v otvorenom vlákne) */
  latestSubject: string | null;
}

/** Stavy vlákien pre agenta, odvodené bez nových stĺpcov. */
export function agentOverview(db: Db, agent: string): Overview {
  const nove = (
    db.prepare("SELECT COUNT(*) AS n FROM messages WHERE to_agent = ? AND read_at IS NULL").get(agent) as { n: number }
  ).n;
  const last = db
    .prepare(
      `SELECT l.from_agent AS f FROM threads t
       JOIN messages l ON l.id = (SELECT MAX(id) FROM messages WHERE thread_id = t.id)
       WHERE t.status = 'open'
         AND EXISTS (SELECT 1 FROM messages x WHERE x.thread_id = t.id AND (x.from_agent = ? OR x.to_agent = ?))`,
    )
    .all(agent, agent) as { f: string }[];
  const naTebe = last.filter((r) => r.f !== agent).length;
  const latest = db
    .prepare(
      `SELECT t.subject AS s FROM messages m JOIN threads t ON t.id = m.thread_id
       WHERE m.to_agent = ? AND (m.read_at IS NULL OR t.status = 'open')
       ORDER BY m.id DESC LIMIT 1`,
    )
    .get(agent) as { s: string } | undefined;
  return { nove, naTebe, caka: last.length - naTebe, latestSubject: latest?.s ?? null };
}

export function formatThread({ thread, messages }: ReturnType<typeof getThread>): string {
  const head = `# #${thread.id} ${thread.subject} [${thread.status}]${thread.ticket ? ` · ${thread.ticket}` : ""}`;
  const body = messages
    .map((m) => `## ${m.from_agent} → ${m.to_agent} · ${m.kind} · ${m.created_at}\n${m.body}`)
    .join("\n\n");
  return `${head}\n\n${body}`;
}
