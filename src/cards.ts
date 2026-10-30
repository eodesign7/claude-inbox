import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InboxError, agentName } from "./base.js";
import { homeDir, projectsDir } from "./paths.js";

export const SECTIONS = ["Čo to je", "Aktuálny fokus", "Rozhodnutia", "Ďalší krok"] as const;
export type Section = (typeof SECTIONS)[number];
const ALIASES: Record<string, Section> = {
  what: "Čo to je",
  focus: "Aktuálny fokus",
  decisions: "Rozhodnutia",
  next: "Ďalší krok",
};

export function sectionName(raw: string): Section {
  const k = raw.trim().replace(/^##\s*/, "").toLowerCase();
  const hit = SECTIONS.find((s) => s.toLowerCase() === k) ?? ALIASES[k];
  if (!hit) throw new InboxError(`Neznáma sekcia "${raw}". Sekcie: ${SECTIONS.join(", ")}.`);
  return hit;
}

export function writeAtomic(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

// ---- frontmatter ----------------------------------------------------------

export function splitFront(text: string): { front: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? { front: m[1]!, body: text.slice(m[0].length) } : { front: null, body: text };
}

export const joinFront = (front: string | null, body: string) =>
  front === null ? body : `---\n${front}\n---\n${body}`;

function unq(v: string): string {
  v = v.trim();
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      /* ponechaj */
    }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

const yq = (v: string) => (/^[A-Za-z0-9_/.~][A-Za-z0-9_/.~ +@()-]*$/.test(v) && !/\s$/.test(v) ? v : JSON.stringify(v));

export interface Meta {
  name?: string;
  paths: string[];
  ticket_prefix?: string;
}

export function parseFront(front: string | null): Meta {
  const out: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const line of (front ?? "").split(/\r?\n/)) {
    const li = /^\s*-\s+(.*)$/.exec(line);
    if (li && listKey) {
      (out[listKey] as string[]).push(unq(li[1]!));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, k, v] = kv as unknown as [string, string, string];
    if (v === "") {
      out[k] = [];
      listKey = k;
    } else if (v.startsWith("[") && v.endsWith("]")) {
      out[k] = v.slice(1, -1).split(",").map((s) => unq(s)).filter(Boolean);
      listKey = null;
    } else {
      out[k] = unq(v);
      listKey = null;
    }
  }
  const s = (k: string) => (typeof out[k] === "string" ? (out[k] as string) : undefined);
  return {
    name: s("name"),
    paths: Array.isArray(out.paths) ? (out.paths as string[]) : s("paths") ? [s("paths")!] : [],
    ticket_prefix: s("ticket_prefix"),
  };
}

/** Prepíše iba kľúč `paths` v surovom frontmattere, zvyšok nechá bajt po bajte. */
export function editPaths(front: string, paths: string[]): string {
  const lines = front.split("\n");
  const block = paths.length ? ["paths:", ...paths.map((p) => `  - ${yq(p)}`)] : ["paths: []"];
  const i = lines.findIndex((l) => /^paths:/.test(l));
  if (i < 0) {
    while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
    return [...lines, ...block].join("\n");
  }
  let e = i + 1;
  while (e < lines.length && /^\s*-\s/.test(lines[e]!)) e++;
  lines.splice(i, e - i, ...block);
  return lines.join("\n");
}

// ---- karta ----------------------------------------------------------------

export const agentDir = (agent: string) => join(projectsDir(), agentName(agent));
export const cardPath = (agent: string) => join(agentDir(agent), "card.md");
export const notesDir = (agent: string) => join(agentDir(agent), "notes");

export function cardTemplate(agent: string, paths: string[] = []): string {
  const front = [`name: ${yq(agent)}`, ...(paths.length ? ["paths:", ...paths.map((p) => `  - ${yq(p)}`)] : ["paths: []"])];
  const body = `\n# ${agent}\n\n${SECTIONS.map((s) => `## ${s}\n`).join("\n")}`;
  return joinFront(front.join("\n"), body);
}

export interface Card {
  agent: string;
  raw: string;
  front: string | null;
  body: string;
  meta: Meta;
}

export function readCard(agent: string): Card | null {
  const p = cardPath(agent);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8");
  const { front, body } = splitFront(raw);
  return { agent, raw, front, body, meta: parseFront(front) };
}

export function listCards(): string[] {
  try {
    return readdirSync(projectsDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(projectsDir(), d.name, "card.md")))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** Založí kartu zo šablóny, ak neexistuje. Vráti true, ak ju vytvoril. */
export function ensureCard(agent: string, path?: string): boolean {
  const a = agentName(agent);
  if (existsSync(cardPath(a))) return false;
  mkdirSync(notesDir(a), { recursive: true });
  writeAtomic(cardPath(a), cardTemplate(a, path ? [path] : []));
  return true;
}

export function setCardPaths(agent: string, fn: (paths: string[]) => string[]): void {
  const c = readCard(agent);
  if (!c) return;
  const next = fn(c.meta.paths);
  if (next.join("\n") === c.meta.paths.join("\n")) return;
  const front = editPaths(c.front ?? `name: ${agent}`, next);
  writeAtomic(cardPath(agent), joinFront(front, c.body));
}

// ---- sekcie ---------------------------------------------------------------

export function assertSectionText(text: string) {
  if (/^## /m.test(text)) throw new InboxError("Text nesmie obsahovať nadpisy úrovne ## (sú vyhradené sekciám).");
}

export function getSection(body: string, name: string): string {
  const lines = body.split("\n");
  const i = lines.findIndex((l) => l.trimEnd() === `## ${name}`);
  if (i < 0) return "";
  let j = i + 1;
  while (j < lines.length && !/^## /.test(lines[j]!)) j++;
  return lines.slice(i + 1, j).join("\n").trim();
}

export function setSection(body: string, name: string, text: string): string {
  assertSectionText(text);
  const clean = text.trim();
  const lines = body.split("\n");
  const i = lines.findIndex((l) => l.trimEnd() === `## ${name}`);
  if (i < 0) return `${body.trimEnd()}\n\n## ${name}\n\n${clean}\n`;
  let j = i + 1;
  while (j < lines.length && !/^## /.test(lines[j]!)) j++;
  lines.splice(i + 1, j - i - 1, ...(clean ? ["", ...clean.split("\n"), ""] : [""]));
  return lines.join("\n");
}

/** Prepíše sekcie karty (frontmatter ostáva nedotknutý). Prázdny text sekciu nemení. */
export function updateSections(agent: string, values: Partial<Record<Section, string | undefined>>): Section[] {
  const done: Section[] = [];
  for (const v of Object.values(values)) if (v !== undefined) assertSectionText(v);
  if (!Object.values(values).some((v) => v !== undefined && v.trim())) return done; // nič na zápis: kartu nezakladaj
  ensureCard(agent);
  const c = readCard(agent)!;
  let body = c.body;
  for (const [name, text] of Object.entries(values) as [Section, string | undefined][]) {
    if (text === undefined || !text.trim()) continue;
    body = setSection(body, name, text);
    done.push(name);
  }
  if (done.length) writeAtomic(cardPath(agent), joinFront(c.front, body));
  return done;
}

// ---- migrácia projects.json (v1) --------------------------------------------

export function migrateLegacy(): number {
  const f = join(homeDir(), "projects.json");
  if (!existsSync(f)) return 0;
  let n = 0;
  try {
    const map = JSON.parse(readFileSync(f, "utf8")) as Record<string, string>;
    for (const [path, agent] of Object.entries(map)) {
      let a: string;
      try {
        a = agentName(String(agent));
      } catch {
        continue;
      }
      if (ensureCard(a, path)) {
        n++;
        continue;
      }
      setCardPaths(a, (ps) => (ps.includes(path) ? ps : [...ps, path]));
      n++;
    }
    renameSync(f, `${f}.migrated`);
  } catch {
    /* poškodený súbor nechaj na pokoji */
  }
  return n;
}
