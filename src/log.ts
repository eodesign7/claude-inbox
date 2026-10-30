import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { logDir } from "./paths.js";

export interface LogEntry {
  date: string;
  time: string;
  agent: string;
  thread_id: number;
  subject: string;
  ticket: string | null;
  summary: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function appendLog(
  e: { agent: string; thread_id: number; subject: string; ticket?: string | null; summary: string },
  now = new Date(),
): string {
  const file = join(logDir(), `${localDate(now)}.md`);
  mkdirSync(logDir(), { recursive: true });
  const head = `## ${localTime(now)} · ${e.agent} · #${e.thread_id} · ${e.subject.replace(/\s+/g, " ")}`;
  const ticket = e.ticket ? `Ticket: ${e.ticket}\n\n` : "";
  appendFileSync(file, `${existsSync(file) ? "\n" : ""}${head}\n\n${ticket}${e.summary.trim()}\n`);
  return file;
}

export function parseLog(date: string, text: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const chunk of text.split(/^## /m).slice(1)) {
    const nl = chunk.indexOf("\n");
    const head = (nl < 0 ? chunk : chunk.slice(0, nl)).split(" · ");
    if (head.length < 4) continue;
    let body = (nl < 0 ? "" : chunk.slice(nl + 1)).trim();
    let ticket: string | null = null;
    const t = /^Ticket: (.+)\n?/.exec(body);
    if (t) {
      ticket = t[1]!.trim();
      body = body.slice(t[0].length).trim();
    }
    out.push({
      date,
      time: head[0]!,
      agent: head[1]!,
      thread_id: Number(head[2]!.replace("#", "")),
      subject: head.slice(3).join(" · "),
      ticket,
      summary: body,
    });
  }
  return out;
}

export function readLogText(date: string): string | null {
  const f = join(logDir(), `${date}.md`);
  return existsSync(f) ? readFileSync(f, "utf8") : null;
}

/** Najnovšie záznamy (najnovší prvý), voliteľne len pre agenta. */
export function recentEntries(agent: string | null, n: number): LogEntry[] {
  let files: string[] = [];
  try {
    files = readdirSync(logDir()).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse();
  } catch {
    return [];
  }
  const out: LogEntry[] = [];
  for (const f of files) {
    const date = f.slice(0, -3);
    const entries = parseLog(date, readFileSync(join(logDir(), f), "utf8")).reverse();
    for (const e of entries) if (!agent || e.agent === agent) out.push(e);
    if (out.length >= n) break;
  }
  return out.slice(0, n);
}
