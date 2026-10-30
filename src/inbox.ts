import type { Db } from "./db.js";
import { getSection, readCard } from "./cards.js";
import { agentOverview } from "./core.js";
import { activeSessions, endSession, startSession, touchSession } from "./sessions.js";

const C = {
  hi: "\x1b[1;33m", // nové: zvýraznené
  dim: "\x1b[2m",
  off: "\x1b[0m",
};

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export type Seg = { t: string; s?: "hi" | "dim" };

export interface StatusModel {
  kind: "ok" | "offline" | "noidentity";
  agent: string | null;
  segments: Seg[];
  /** rovnaký riadok bez farieb */
  plain: string;
}

/** Zloží časti riadku oddelené " · ". */
function line(parts: Seg[]): Seg[] {
  const out: Seg[] = [{ t: "📬 " }];
  parts.forEach((p, i) => {
    if (i) out.push({ t: " · " });
    out.push(p);
  });
  return out;
}

/** Riadok status line ako segmenty so štýlom (spoločný základ pre ANSI aj pre mod). */
export function statusModel(db: Db | null, agent: string | null): StatusModel {
  const make = (kind: StatusModel["kind"], segments: Seg[]): StatusModel => ({
    kind,
    agent,
    segments,
    plain: segments.map((x) => x.t).join(""),
  });
  if (agent === null) return make("noidentity", [{ t: "📬 bez identity" }]);
  if (!db) return make("offline", [{ t: "📬 pošta offline" }]);
  let o;
  try {
    o = agentOverview(db, agent);
  } catch {
    return make("offline", [{ t: "📬 pošta offline" }]);
  }
  let sessions = 0;
  try {
    sessions = activeSessions(db, agent).length;
  } catch {
    /* stará DB bez tabuľky sessions */
  }
  const parts: Seg[] = [{ t: agent }];
  const hasMail = o.nove || o.naTebe || o.caka;
  if (o.nove) parts.push({ t: `${o.nove} nové`, s: "hi" });
  if (o.naTebe) parts.push({ t: `${o.naTebe} na tebe` });
  if (o.caka) parts.push({ t: `${o.caka} čaká`, s: "dim" });
  if (!hasMail) parts.push({ t: "čisto" });
  if (sessions) parts.push({ t: `${sessions} ${sessions === 1 ? "session" : "sessions"}` });
  if (hasMail && o.latestSubject) parts.push({ t: `„${cut(o.latestSubject, 40)}“`, s: "dim" });
  return make("ok", line(parts));
}

/** Segmenty ako text s jemnými ANSI farbami. */
export function renderSegments(segments: Seg[]): string {
  return segments
    .map((x) => (x.s === "hi" ? `${C.hi}${x.t}${C.off}` : x.s === "dim" ? `${C.dim}${x.t}${C.off}` : x.t))
    .join("");
}

/** Jeden riadok status line pre agenta. db === null znamená, že pošta neexistuje. */
export function renderStatus(db: Db | null, agent: string | null): string {
  return renderSegments(statusModel(db, agent).segments);
}

export interface HookInput {
  session_id?: string;
  hook_event_name?: string;
  cwd?: string;
  branch?: string | null;
}

const cap = (s: string, n = 500) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Krátky blok z karty: Aktuálny fokus a Ďalší krok. */
export function cardBlock(agent: string): string | null {
  const c = readCard(agent);
  if (!c) return null;
  const focus = getSection(c.body, "Aktuálny fokus");
  const next = getSection(c.body, "Ďalší krok");
  const lines = [];
  if (focus) lines.push(`Aktuálny fokus: ${cap(focus)}`);
  if (next) lines.push(`Ďalší krok: ${cap(next)}`);
  return lines.length ? `Projekt ${agent}\n${lines.join("\n")}` : null;
}

/** Nové správy, ktoré táto session ešte nevidela; zapíše ich do session_seen. */
function unseenMail(db: Db, agent: string, session: string): string | null {
  const rows = db
    .prepare(
      `SELECT m.id, m.thread_id, m.from_agent AS "from", t.subject
       FROM messages m JOIN threads t ON t.id = m.thread_id
       WHERE m.to_agent = ? AND m.read_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM session_seen s WHERE s.session_id = ? AND s.message_id = m.id)
       ORDER BY m.id ASC`,
    )
    .all(agent, session) as { id: number; thread_id: number; from: string; subject: string }[];
  if (!rows.length) return null;
  const now = new Date().toISOString();
  const ins = db.prepare("INSERT OR IGNORE INTO session_seen (session_id, message_id, seen_at) VALUES (?,?,?)");
  for (const r of rows) ins.run(session, r.id, now);
  db.prepare("DELETE FROM session_seen WHERE seen_at < ?").run(new Date(Date.now() - 30 * 86400_000).toISOString());
  const byThread = new Map<number, { from: string; subject: string }>();
  for (const r of rows) byThread.set(r.thread_id, { from: r.from, subject: r.subject });
  const list = [...byThread].map(([id, v]) => `- #${id} od ${v.from}: ${v.subject}`).join("\n");
  return `Pošta pre ${agent}:\n${list}\nMáš novú poštu, pri vhodnej chvíli zavolaj read_thread.`;
}

/**
 * Spracuje hook. SessionStart registruje session a vloží kartu + poštu,
 * UserPromptSubmit obnoví last_seen_at a vloží len nové správy, SessionEnd session ukončí.
 * Vráti JSON pre Claude Code, alebo null, keď nie je čo vypísať.
 */
export function runHook(db: Db, agent: string, input: HookInput, event?: string): string | null {
  const ev = event || input.hook_event_name || "UserPromptSubmit";
  const session = input.session_id || "unknown";
  const info = { session_id: session, agent, cwd: input.cwd ?? null, git_branch: input.branch ?? null };
  return db
    .transaction(() => {
      if (ev === "SessionEnd") {
        endSession(db, session);
        return null;
      }
      const parts: string[] = [];
      if (ev === "SessionStart") {
        startSession(db, info);
        const card = cardBlock(agent);
        if (card) parts.push(card);
      } else {
        touchSession(db, info);
      }
      const mail = unseenMail(db, agent, session);
      if (mail) parts.push(mail);
      if (!parts.length) return null;
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: ev, additionalContext: parts.join("\n\n") },
      });
    })
    .immediate();
}
