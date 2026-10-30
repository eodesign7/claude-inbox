import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findGitBranch, isCodeSession, linkProject, resolveAgent, resolveAgentInfo } from "../src/agent.js";
import {
  cardPath, editPaths, getSection, listCards, migrateLegacy, parseFront, readCard, setSection, splitFront,
} from "../src/cards.js";
import { contextWrite, mapOverview, projectGet, repoRead } from "../src/context.js";
import { openDb, type Db } from "../src/db.js";
import { localDate, parseLog, readLogText, recentEntries } from "../src/log.js";
import { desktopConfigPath } from "../src/paths.js";
import { Inbox } from "../src/core.js";
import { startSession } from "../src/sessions.js";

const CLEAN = ["CLAUDE_INBOX_AGENT", "CLAUDE_INBOX_HOME", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID"];
let dir: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "cards-")));
  saved = Object.fromEntries(CLEAN.map((k) => [k, process.env[k]]));
  for (const k of CLEAN) delete process.env[k];
  process.env.CLAUDE_INBOX_HOME = join(dir, "home");
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

const repo = (name: string) => {
  const p = join(dir, name);
  mkdirSync(join(p, ".git"), { recursive: true });
  mkdirSync(join(p, "src", "deep"), { recursive: true });
  return p;
};

describe("frontmatter", () => {
  it("parsuje zoznam, inline zoznam a úvodzovky", () => {
    const m = parseFront('name: demo\npaths:\n  - /a b\n  - "C:\\\\x"\nticket_prefix: DEMO');
    expect(m).toEqual({ name: "demo", paths: ["/a b", "C:\\x"], ticket_prefix: "DEMO" });
    expect(parseFront("paths: [/a, /b]").paths).toEqual(["/a", "/b"]);
    expect(parseFront(null).paths).toEqual([]);
  });
  it("editPaths mení len paths a zvyšok nechá bajt po bajte", () => {
    const front = "name: demo\ncustom: x # komentár\npaths:\n  - /a\nticket_prefix: T";
    expect(editPaths(front, ["/a", "/b"])).toBe("name: demo\ncustom: x # komentár\npaths:\n  - /a\n  - /b\nticket_prefix: T");
    expect(editPaths("name: d", ["/a"])).toBe("name: d\npaths:\n  - /a");
    expect(editPaths("name: d\npaths: []", ["/a"])).toBe("name: d\npaths:\n  - /a");
  });
  it("splitFront", () => {
    expect(splitFront("---\na: 1\n---\n# x\n")).toEqual({ front: "a: 1", body: "# x\n" });
    expect(splitFront("# x").front).toBeNull();
  });
});

describe("sekcie", () => {
  const body = "\n# t\n\n## Čo to je\n\nA\n\n## Aktuálny fokus\n\nB\nB2\n\n## Ďalší krok\n\nC\n";
  it("getSection / setSection prepíše len danú sekciu", () => {
    expect(getSection(body, "Aktuálny fokus")).toBe("B\nB2");
    const out = setSection(body, "Aktuálny fokus", "nový");
    expect(getSection(out, "Aktuálny fokus")).toBe("nový");
    expect(getSection(out, "Čo to je")).toBe("A");
    expect(getSection(out, "Ďalší krok")).toBe("C");
  });
  it("posledná sekcia a chýbajúca sekcia", () => {
    expect(getSection(setSection(body, "Ďalší krok", "D"), "Ďalší krok")).toBe("D");
    expect(getSection(setSection(body, "Rozhodnutia", "R"), "Rozhodnutia")).toBe("R");
  });
  it("odmietne nadpisy ## v texte", () => {
    expect(() => setSection(body, "Aktuálny fokus", "x\n## Zlý")).toThrow(/nadpisy/);
  });
});

describe("resolveAgent", () => {
  const CODE = { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "claude-desktop" };

  it("detekcia Claude Code podľa premenných, ktoré nastavuje Claude Code", () => {
    expect(isCodeSession({})).toBe(false);
    expect(isCodeSession({ CLAUDE_INBOX_AGENT: "chat" })).toBe(false);
    expect(isCodeSession({ CLAUDECODE: "1" })).toBe(true);
    expect(isCodeSession({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe(true);
    expect(isCodeSession({ CLAUDE_CODE_SESSION_ID: "x" })).toBe(true);
  });
  it("Code session s CLAUDE_INBOX_AGENT=orchestrator v repe s kartou worker dá worker", () => {
    const r = repo("whatever");
    linkProject(r, "worker");
    const env = { ...CODE, CLAUDE_INBOX_AGENT: "orchestrator" };
    expect(resolveAgentInfo(join(r, "src"), { env })).toMatchObject({ agent: "worker", source: "card" });
  });
  it("Code session v repe bez karty dá názov repa, nikdy orchestrator", () => {
    const r = repo("Moje-Repo");
    const env = { ...CODE, CLAUDE_INBOX_AGENT: "orchestrator" };
    expect(resolveAgentInfo(r, { env })).toMatchObject({ agent: "moje-repo", source: "git" });
    expect(resolveAgentInfo(join(r, "src", "deep"), { env }).agent).toBe("moje-repo");
  });
  it("Code session mimo repa dá názov priečinka, potom default; CLAUDE_INBOX_AGENT nikdy", () => {
    const env = { ...CODE, CLAUDE_INBOX_AGENT: "orchestrator" };
    const plain = join(dir, "Plain Dir");
    mkdirSync(plain);
    expect(resolveAgentInfo(plain, { env })).toMatchObject({ agent: "plain-dir", source: "dir" });
    expect(resolveAgentInfo("/", { env })).toMatchObject({ agent: "default", source: "default" });
  });
  it("chat: CLAUDE_INBOX_AGENT vyhráva aj v repe s kartou; bez neho platí rovnaké poradie", () => {
    const r = repo("proj");
    linkProject(r, "worker");
    expect(resolveAgentInfo(r, { env: { CLAUDE_INBOX_AGENT: "Orchestrator" } })).toMatchObject({ agent: "orchestrator", source: "env" });
    expect(resolveAgentInfo(r, { env: {} })).toMatchObject({ agent: "worker", source: "card" });
    expect(resolveAgentInfo(repo("other"), { env: {} })).toMatchObject({ agent: "other", source: "git" });
    expect(resolveAgentInfo(join(dir), { env: {} }).source).toBe("dir");
  });
  it("najdlhší prefix cez ručne zapísané paths", () => {
    const r = repo("mono2");
    linkProject(r, "outer");
    mkdirSync(join(dir, "home", "projects", "inner"), { recursive: true });
    writeFileSync(cardPath("inner"), `---\nname: inner\npaths:\n  - ${join(r, "src")}\n---\n`);
    expect(resolveAgent(r)).toBe("outer");
    expect(resolveAgent(join(r, "src", "deep"))).toBe("inner");
  });
  it("prefix na hranici adresára; strict verzia mimo repa vyhodí chybu", () => {
    const a = repo("app");
    const b = repo("app-extra");
    linkProject(a, "one");
    expect(resolveAgent(b)).toBe("app-extra");
    expect(() => resolveAgent(dir)).toThrow(/claude-inbox link/);
  });
  it("worktree sa mapuje na hlavný repo a vetva sa číta z HEAD", () => {
    const main = repo("Main");
    writeFileSync(join(main, ".git", "HEAD"), "ref: refs/heads/feat/x\n");
    expect(findGitBranch(main)).toBe("feat/x");
    const wt = join(dir, "wt");
    mkdirSync(wt);
    const gd = join(main, ".git", "worktrees", "wt");
    mkdirSync(gd, { recursive: true });
    writeFileSync(join(gd, "HEAD"), "ref: refs/heads/wt-branch\n");
    writeFileSync(join(wt, ".git"), `gitdir: ${gd}\n`);
    expect(resolveAgent(wt)).toBe("main");
    expect(findGitBranch(wt)).toBe("wt-branch");
  });
});

describe("link a migrácia", () => {
  it("link založí kartu zo šablóny a pridá cestu; opakovanie nič nezduplikuje", () => {
    const r = repo("proj");
    expect(linkProject(r, "Demo")).toEqual({ root: r, created: true });
    expect(linkProject(r, "demo").created).toBe(false);
    const c = readCard("demo")!;
    expect(c.meta).toEqual({ name: "demo", paths: [r], ticket_prefix: undefined });
    for (const s of ["Čo to je", "Aktuálny fokus", "Rozhodnutia", "Ďalší krok"]) expect(c.body).toContain(`## ${s}`);
    expect(existsSync(join(dir, "home", "projects", "demo", "notes"))).toBe(true);
  });
  it("preklopenie repa na iného agenta odoberie cestu z pôvodnej karty", () => {
    const r = repo("proj");
    linkProject(r, "old");
    linkProject(r, "new");
    expect(readCard("old")!.meta.paths).toEqual([]);
    expect(readCard("new")!.meta.paths).toEqual([r]);
    expect(resolveAgent(r)).toBe("new");
  });
  it("migrácia projects.json do kariet", () => {
    const r = repo("legacy");
    mkdirSync(process.env.CLAUDE_INBOX_HOME!, { recursive: true });
    writeFileSync(join(process.env.CLAUDE_INBOX_HOME!, "projects.json"), JSON.stringify({ [r]: "oldname", "/zle/meno": "Bad Name" }));
    expect(resolveAgent(r)).toBe("oldname"); // migruje sa pri prvom použití
    expect(readCard("oldname")!.meta.paths).toEqual([r]);
    expect(existsSync(join(process.env.CLAUDE_INBOX_HOME!, "projects.json"))).toBe(false);
    expect(existsSync(join(process.env.CLAUDE_INBOX_HOME!, "projects.json.migrated"))).toBe(true);
    expect(migrateLegacy()).toBe(0);
  });
});

describe("context_write", () => {
  const FRONT = "name: demo\ncustom: ponechať\npaths: []";
  beforeEach(() => {
    mkdirSync(join(dir, "home", "projects", "demo", "notes"), { recursive: true });
    writeFileSync(
      cardPath("demo"),
      `---\n${FRONT}\n---\n\n# demo\n\n## Čo to je\n\nA\n\n## Aktuálny fokus\n\nB\n\n## Ďalší krok\n\nC\n`,
    );
  });
  it("sekcia karty: prepíše len ju, frontmatter nedotknutý", () => {
    contextWrite("demo", "card", "nový fokus", "focus");
    const c = readCard("demo")!;
    expect(c.front).toBe(FRONT);
    expect(getSection(c.body, "Aktuálny fokus")).toBe("nový fokus");
    expect(getSection(c.body, "Čo to je")).toBe("A");
    expect(getSection(c.body, "Ďalší krok")).toBe("C");
  });
  it("celá karta: frontmatter ostáva aj keď ho text obsahuje", () => {
    const r = contextWrite("demo", "card", "---\nname: hacked\npaths:\n  - /etc\n---\n# nové\n\n## Čo to je\n\nX\n");
    expect(r).toMatchObject({ frontmatter_ignored: true });
    const c = readCard("demo")!;
    expect(c.front).toBe(FRONT);
    expect(c.body).toContain("# nové");
    expect(c.body).not.toContain("hacked");
  });
  it("neznáma sekcia a nadpis ## v texte sa odmietnu", () => {
    expect(() => contextWrite("demo", "card", "x", "Hocičo")).toThrow(/Neznáma sekcia/);
    expect(() => contextWrite("demo", "card", "x\n## Iné", "focus")).toThrow(/nadpisy/);
  });
  it("poznámky: zápis, sekcia, a ochrana názvu", () => {
    contextWrite("demo", "api-notes", "# Poznámky\n");
    expect(readFileSync(join(dir, "home", "projects", "demo", "notes", "api-notes.md"), "utf8")).toBe("# Poznámky\n");
    contextWrite("demo", "api-notes.md", "hotovo", "Stav");
    expect(readFileSync(join(dir, "home", "projects", "demo", "notes", "api-notes.md"), "utf8")).toContain("## Stav\n\nhotovo");
    expect(() => contextWrite("demo", "../card", "x")).toThrow(/Neplatný názov/);
    expect(() => contextWrite("demo", "a/b", "x")).toThrow(/Neplatný názov/);
  });
  it("karta sa pri prvom zápise založí zo šablóny", () => {
    contextWrite("fresh", "card", "obsah", "next");
    expect(getSection(readCard("fresh")!.body, "Ďalší krok")).toBe("obsah");
    expect(listCards()).toEqual(["demo", "fresh"]);
  });
});

describe("repo_read", () => {
  let r: string;
  beforeEach(() => {
    r = repo("rr");
    writeFileSync(join(r, "README.md"), "# ahoj");
    writeFileSync(join(r, "src", "doc.MD"), "doc");
    writeFileSync(join(r, "secret.txt"), "tajné");
    writeFileSync(join(dir, "outside.md"), "mimo");
    linkProject(r, "rr");
  });
  it("číta .md v rámci paths (relatívne aj absolútne)", () => {
    expect(repoRead("rr", "README.md")).toBe("# ahoj");
    expect(repoRead("rr", "src/doc.MD")).toBe("doc");
    expect(repoRead("rr", join(r, "README.md"))).toBe("# ahoj");
  });
  it("odmietne .., absolútne cesty mimo, iné prípony a symlinky von", () => {
    expect(() => repoRead("rr", "../outside.md")).toThrow(/\.\./);
    expect(() => repoRead("rr", "src/../../outside.md")).toThrow(/\.\./);
    expect(() => repoRead("rr", join(dir, "outside.md"))).toThrow(/mimo/);
    expect(() => repoRead("rr", "secret.txt")).toThrow(/\.md/);
    symlinkSync(join(dir, "outside.md"), join(r, "link.md"));
    expect(() => repoRead("rr", "link.md")).toThrow(/mimo/);
    symlinkSync(join(dir, "outside.md"), join(r, "src", "evil.md"));
    expect(() => repoRead("rr", "src/evil.md")).toThrow(/mimo/);
    expect(() => repoRead("rr", "chyba.md")).toThrow(/nenašiel/);
  });
  it("projekt bez ciest alebo cudzí projekt nič nečíta", () => {
    expect(() => repoRead("nikto", "README.md")).toThrow(/nemá žiadnu platnú cestu/);
  });
});

describe("close_thread, log, map, project_get", () => {
  let db: Db;
  let chat: Inbox;
  let api: Inbox;
  beforeEach(() => {
    db = openDb(join(dir, "inbox.db"));
    chat = new Inbox(db, "chat");
    api = new Inbox(db, "api");
    linkProject(repo("api-repo"), "api");
    contextWrite("api", "card", "starý fokus", "focus");
    contextWrite("api", "card", "starý krok", "next");
  });
  afterEach(() => db.close());

  it("zapíše log s tiketom a prepíše focus/next", () => {
    const t = chat.send("api", "Auth podľa plánu", "x", "task", "DEMO-12");
    const r = api.closeThread(t.thread_id, "Hotovo, commit abc", "nový fokus", "nový krok");
    expect(r.card_updated).toEqual(["Aktuálny fokus", "Ďalší krok"]);
    const card = readCard("api")!;
    expect(getSection(card.body, "Aktuálny fokus")).toBe("nový fokus");
    expect(getSection(card.body, "Ďalší krok")).toBe("nový krok");
    expect(card.meta.paths).toHaveLength(1); // frontmatter živý
    const text = readLogText(localDate())!;
    expect(text).toMatch(/^## \d\d:\d\d · api · #1 · Auth podľa plánu\n\nTicket: DEMO-12\n\nHotovo, commit abc\n$/);
    const [e] = parseLog(localDate(), text);
    expect(e).toMatchObject({ agent: "api", thread_id: 1, ticket: "DEMO-12", summary: "Hotovo, commit abc" });
    expect(chat.inbox()[0]).toMatchObject({ kind: "summary" });
  });
  it("bez focus/next karta ostane, viac záznamov sa pripíše", () => {
    const a = chat.send("api", "A", "x");
    const b = chat.send("api", "B", "x");
    expect(api.closeThread(a.thread_id, "s1").card_updated).toEqual([]);
    api.closeThread(b.thread_id, "s2");
    expect(getSection(readCard("api")!.body, "Aktuálny fokus")).toBe("starý fokus");
    expect(parseLog(localDate(), readLogText(localDate())!).map((e) => e.thread_id)).toEqual([1, 2]);
    expect(recentEntries("api", 1)[0]!.thread_id).toBe(2);
  });
  it("neplatný focus zruší zatvorenie ešte pred zmenou", () => {
    const t = chat.send("api", "A", "x");
    expect(() => api.closeThread(t.thread_id, "s", "## zle")).toThrow(/nadpisy/);
    expect(api.threads("open")).toHaveLength(1);
    expect(readLogText(localDate())).toBeNull();
  });
  it("map a project_get", () => {
    const t = chat.send("api", "Úloha", "x");
    startSession(db, { session_id: "s1", agent: "api", cwd: "/x", git_branch: "main" });
    api.closeThread(chat.send("api", "Hotová", "x").thread_id, "Záver prvý riadok\ndruhý");
    const m = mapOverview(db);
    const row = m.find((x) => x.agent === "api")!;
    expect(row).toMatchObject({ focus: "starý fokus", open_threads: 1, active_sessions: 1 });
    expect(row.last_summary).toMatchObject({ subject: "Hotová", summary: "Záver prvý riadok" });
    expect(m.map((x) => x.agent)).toContain("chat");
    const p = projectGet(db, "api");
    expect(p.card).toContain("## Čo to je");
    expect(p.open_threads[0]).toMatchObject({ id: t.thread_id, subject: "Úloha", state: "nové" });
    expect(p.sessions[0]).toMatchObject({ session_id: "s1", git_branch: "main" });
    expect(p.recent_summaries).toHaveLength(1);
  });
  it("threads(status, agent) filtruje podľa iného agenta", () => {
    chat.send("api", "A", "x");
    chat.send("web", "B", "x");
    expect(chat.threads("open", "web").map((t) => t.subject)).toEqual(["B"]);
    expect(chat.threads("open").map((t) => t.subject).sort()).toEqual(["A", "B"]);
  });
});

describe("paths podľa platformy", () => {
  it("macOS, Windows, Linux", () => {
    expect(desktopConfigPath("darwin", {}, "/Users/x")).toBe("/Users/x/Library/Application Support/Claude/claude_desktop_config.json");
    expect(desktopConfigPath("win32", { APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, "C:\\Users\\x")).toBe(
      "C:\\Users\\x\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
    );
    expect(desktopConfigPath("win32", {}, "C:\\Users\\x")).toBe("C:\\Users\\x\\AppData\\Roaming\\Claude\\claude_desktop_config.json");
    expect(desktopConfigPath("linux", {}, "/home/x")).toBe("/home/x/.config/Claude/claude_desktop_config.json");
    expect(desktopConfigPath("linux", { XDG_CONFIG_HOME: "/cfg" }, "/home/x")).toBe("/cfg/Claude/claude_desktop_config.json");
    expect(desktopConfigPath("linux", { CLAUDE_INBOX_DESKTOP_CONFIG: "/o.json" }, "/home/x")).toBe("/o.json");
  });
});
