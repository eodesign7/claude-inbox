import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { InboxError, agentName } from "./base.js";
import {

  cardPath,
  ensureCard,
  getSection,
  joinFront,
  listCards,
  notesDir,
  readCard,
  sectionName,
  setSection,
  splitFront,
  writeAtomic,
} from "./cards.js";
import type { Db } from "./db.js";
import { recentEntries } from "./log.js";
import { Inbox, listAllThreads, listPending } from "./core.js";
import { activeSessions } from "./sessions.js";

const oneLine = (s: string, n = 160) => {
  const l = s.split("\n").find((x) => x.trim()) ?? "";
  return l.length > n ? l.slice(0, n - 1) + "…" : l;
};

function entrySummary(e: ReturnType<typeof recentEntries>[number]) {
  return { date: e.date, time: e.time, thread_id: e.thread_id, subject: e.subject, ticket: e.ticket, summary: oneLine(e.summary) };
}

export function mapOverview(db: Db) {
  const agents = new Set<string>(listCards());
  const open = listAllThreads(db, "open");
  const pending = listPending(db);
  for (const t of open) for (const p of t.participants) agents.add(p);
  for (const s of activeSessions(db)) agents.add(s.agent);
  return [...agents].sort().map((agent) => {
    const card = readCard(agent);
    const last = recentEntries(agent, 1)[0];
    return {
      agent,
      focus: card ? oneLine(getSection(card.body, "Aktuálny fokus")) || null : null,
      open_threads: open.filter((t) => t.participants.includes(agent) || t.created_by === agent).length,
      active_sessions: activeSessions(db, agent).length,
      wake: card?.meta.wake ?? "off",
      pending_approvals: pending.filter((p) => p.to === agent).map((p) => ({ id: p.id, subject: p.subject, from: p.from })),
      last_summary: last ? entrySummary(last) : null,
    };
  });
}

export function listNotes(agent: string): string[] {
  try {
    return readdirSync(notesDir(agent)).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  } catch {
    return [];
  }
}

export function projectGet(db: Db, agent: string) {
  const a = agentName(agent);
  const card = readCard(a);
  return {
    agent: a,
    card: card?.raw ?? null,
    wake: card?.meta.wake ?? "off",
    notes: listNotes(a),
    open_threads: new Inbox(db, a).threads("open").map((t) => ({
      id: t.id,
      subject: t.subject,
      ticket: t.ticket,
      approval: t.approval,
      state: t.state,
      participants: t.participants,
    })),
    sessions: activeSessions(db, a).map((s) => ({
      session_id: s.session_id,
      cwd: s.cwd,
      git_branch: s.git_branch,
      last_seen_at: s.last_seen_at,
    })),
    recent_summaries: recentEntries(a, 3).map((e) => ({ ...entrySummary(e), summary: e.summary })),
  };
}

function noteFile(agent: string, file: string): string {
  const n = file.trim().replace(/\.md$/i, "");
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u.test(n) || n.includes("..")) {
    throw new InboxError(`Neplatný názov poznámky "${file}".`);
  }
  return join(notesDir(agent), `${n}.md`);
}

/** Zápis kontextu. Frontmatter karty sa nikdy nemení. */
export function contextWrite(agentRaw: string, file: string, text: string, section?: string) {
  const agent = agentName(agentRaw);
  const isCard = file.trim().toLowerCase() === "card";
  if (isCard) {
    ensureCard(agent);
    const c = readCard(agent)!;
    if (section) {
      const name = sectionName(section);
      writeAtomic(cardPath(agent), joinFront(c.front, setSection(c.body, name, text)));
      return { file: "card", section: name };
    }
    // celý súbor: ak text sám začína frontmatterom, zahodí sa
    const stripped = splitFront(text);
    const body = stripped.body.replace(/^\n*/, "\n").replace(/\n*$/, "\n");
    writeAtomic(cardPath(agent), joinFront(c.front, body));
    return { file: "card", section: null, frontmatter_ignored: stripped.front !== null };
  }
  const path = noteFile(agent, file);
  if (section) {
    const old = existsSync(path) ? readFileSync(path, "utf8") : "";
    writeAtomic(path, setSection(old, section.replace(/^##\s*/, ""), text));
    return { file: path.slice(notesDir(agent).length + 1), section };
  }

  writeAtomic(path, text.endsWith("\n") ? text : text + "\n");
  return { file: path.slice(notesDir(agent).length + 1), section: null };
}

const MAX_READ = 200_000;

/** Iba čítanie .md súborov v rámci paths projektu. */
export function repoRead(agentRaw: string, path: string): string {
  const agent = agentName(agentRaw);
  const roots = (readCard(agent)?.meta.paths ?? []).map((p) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  });
  const valid = roots.filter((r): r is string => !!r);
  if (!valid.length) throw new InboxError(`Projekt ${agent} nemá žiadnu platnú cestu (paths v karte).`);
  if (!/\.md$/i.test(path)) throw new InboxError("Čítať sa dajú iba súbory .md.");
  if (path.includes("\0") || path.split(/[\\/]+/).includes("..")) throw new InboxError("Cesta s .. nie je povolená.");
  const candidates = isAbsolute(path) ? [path] : valid.map((r) => resolve(r, path));
  for (const c of candidates) {
    let rp: string;
    try {
      rp = realpathSync(c); // rozbalí symlinky, takže únik z koreňa nepôjde
    } catch {
      continue;
    }
    if (!valid.some((r) => rp === r || rp.startsWith(r + sep))) continue;
    if (!/\.md$/i.test(rp) || !statSync(rp).isFile()) continue;
    if (statSync(rp).size > MAX_READ) throw new InboxError("Súbor je príliš veľký (max 200 kB).");
    return readFileSync(rp, "utf8");
  }
  throw new InboxError(`Súbor "${path}" sa v projekte ${agent} nenašiel alebo je mimo jeho ciest.`);
}
