import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkProject } from "../src/agent.js";
import { contextWrite } from "../src/context.js";
import { openDb, openDbReadonly, type Db } from "../src/db.js";
import { cardBlock, renderStatus, runHook } from "../src/inbox.js";
import { Inbox, agentOverview } from "../src/core.js";
import { activeSessions, endSession, startSession, touchSession } from "../src/sessions.js";

const root = resolve(import.meta.dirname, "..");
let dir: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "inbox-")));
  saved = { CLAUDE_INBOX_AGENT: process.env.CLAUDE_INBOX_AGENT, CLAUDE_INBOX_HOME: process.env.CLAUDE_INBOX_HOME, CLAUDE_INBOX_DB: process.env.CLAUDE_INBOX_DB };
  delete process.env.CLAUDE_INBOX_AGENT;
  delete process.env.CLAUDE_INBOX_DB;
  process.env.CLAUDE_INBOX_HOME = join(dir, "home");
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

const repo = (name: string) => {
  const p = join(dir, name);
  mkdirSync(join(p, ".git"), { recursive: true });
  return p;
};

describe("stavy vlákien", () => {
  let db: Db;
  let chat: Inbox;
  let api: Inbox;
  beforeEach(() => {
    db = openDb(join(dir, "inbox.db"));
    chat = new Inbox(db, "chat");
    api = new Inbox(db, "api");
  });
  afterEach(() => db.close());

  it("nové / na tebe / čaká", () => {
    expect(agentOverview(db, "api")).toEqual({ nove: 0, naTebe: 0, caka: 0, latestSubject: null });
    const t1 = chat.send("api", "Auth podľa plánu", "x");
    const t2 = chat.send("api", "Druhé", "x");
    api.readThread(t2.thread_id);
    api.reply(t2.thread_id, "ok", "question");
    expect(agentOverview(db, "api")).toEqual({ nove: 1, naTebe: 1, caka: 1, latestSubject: "Druhé" });
    expect(agentOverview(db, "chat")).toEqual({ nove: 1, naTebe: 1, caka: 1, latestSubject: "Druhé" });
    api.closeThread(t1.thread_id, "hotovo");
    expect(agentOverview(db, "api")).toMatchObject({ nove: 0, naTebe: 0, caka: 1 });
  });
  it("threads() nesie state", () => {
    const t = chat.send("api", "A", "x");
    expect(api.threads()[0]!.state).toBe("nové");
    api.readThread(t.thread_id);
    expect(api.threads()[0]!.state).toBe("na tebe");
    api.reply(t.thread_id, "q", "question");
    expect(api.threads()[0]!.state).toBe("čaká");
  });
});

describe("sessions", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(join(dir, "inbox.db"));
  });
  afterEach(() => db.close());
  const s = (id: string, agent = "api") => ({ session_id: id, agent, cwd: "/x", git_branch: "main" });

  it("start, touch, end", () => {
    const t0 = new Date("2026-01-01T10:00:00Z");
    startSession(db, s("a"), t0);
    expect(activeSessions(db, "api", t0)).toHaveLength(1);
    touchSession(db, { ...s("a"), git_branch: "dev" }, new Date("2026-01-01T10:30:00Z"));
    const row = activeSessions(db, "api", new Date("2026-01-01T10:31:00Z"))[0]!;
    expect(row).toMatchObject({ git_branch: "dev", started_at: t0.toISOString(), last_seen_at: "2026-01-01T10:30:00.000Z" });
    endSession(db, "a", new Date("2026-01-01T11:00:00Z"));
    expect(activeSessions(db, "api", new Date("2026-01-01T11:01:00Z"))).toEqual([]);
  });
  it("aktívna je len do 2 hodín od last_seen_at", () => {
    startSession(db, s("a"), new Date("2026-01-01T10:00:00Z"));
    expect(activeSessions(db, "api", new Date("2026-01-01T11:59:00Z"))).toHaveLength(1);
    expect(activeSessions(db, "api", new Date("2026-01-01T12:01:00Z"))).toHaveLength(0);
  });
  it("touch bez SessionStart session založí; filter podľa agenta", () => {
    touchSession(db, s("b"));
    startSession(db, s("c", "web"));
    expect(activeSessions(db, "api").map((x) => x.session_id)).toEqual(["b"]);
    expect(activeSessions(db)).toHaveLength(2);
  });
  it("opätovný start oživí ukončenú session", () => {
    startSession(db, s("a"));
    endSession(db, "a");
    expect(activeSessions(db, "api")).toHaveLength(0);
    startSession(db, s("a"));
    expect(activeSessions(db, "api")).toHaveLength(1);
  });
});

describe("renderStatus (snapshot)", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(join(dir, "inbox.db"));
  });
  afterEach(() => db.close());

  it("offline, bez identity, čisto", () => {
    expect(renderStatus(null, "api")).toMatchInlineSnapshot(`"📬 pošta offline"`);
    expect(renderStatus(db, null)).toMatchInlineSnapshot(`"📬 bez identity"`);
    expect(renderStatus(db, "api")).toMatchInlineSnapshot(`"📬 api · čisto"`);
  });
  it("nové, na tebe, čaká, sessions a subject", () => {
    const chat = new Inbox(db, "chat");
    const api = new Inbox(db, "api");
    chat.send("api", "Auth podľa plánu", "x");
    const t2 = chat.send("api", "Druhé", "x");
    api.readThread(t2.thread_id);
    api.reply(t2.thread_id, "q", "question");
    startSession(db, { session_id: "a", agent: "api", cwd: null, git_branch: null });
    startSession(db, { session_id: "b", agent: "api", cwd: null, git_branch: null });
    expect(renderStatus(db, "api")).toMatchInlineSnapshot(
      `"📬 api · \x1b[1;33m1 nové\x1b[0m · 1 na tebe · \x1b[2m1 čaká\x1b[0m · 2 sessions · \x1b[2m„Druhé“\x1b[0m"`,
    );
  });
  it("čisto so session a skracovanie subjectu", () => {
    startSession(db, { session_id: "a", agent: "api", cwd: null, git_branch: null });
    expect(renderStatus(db, "api")).toMatchInlineSnapshot(`"📬 api · čisto · 1 session"`);
    new Inbox(db, "chat").send("api", "x".repeat(60), "b");
    expect(renderStatus(db, "api")).toContain(`„${"x".repeat(39)}…“`);
  });
  it("DB len na čítanie; chýbajúca DB dá null", () => {
    const ro = openDbReadonly(join(dir, "inbox.db"))!;
    expect(() => ro.exec("DELETE FROM messages")).toThrow();
    ro.close();
    expect(openDbReadonly(join(dir, "nie-je.db"))).toBeNull();
  });
});

describe("hooky", () => {
  let db: Db;
  let chat: Inbox;
  beforeEach(() => {
    db = openDb(join(dir, "inbox.db"));
    chat = new Inbox(db, "chat");
  });
  afterEach(() => db.close());
  const ctx = (out: string | null) => JSON.parse(out!).hookSpecificOutput;
  const input = (id: string) => ({ session_id: id, cwd: "/x", branch: "main" });

  it("nič, keď nie je nič nové a karta chýba", () => {
    expect(runHook(db, "api", input("s1"), "SessionStart")).toBeNull();
    expect(runHook(db, "api", input("s1"), "UserPromptSubmit")).toBeNull();
  });
  it("SessionStart vloží fokus, ďalší krok a poštu a zaregistruje session", () => {
    linkProject(repo("r"), "api");
    contextWrite("api", "card", "Auth podľa plánu", "focus");
    contextWrite("api", "card", "Napísať testy", "next");
    const t = chat.send("api", "Úloha", "x");
    const h = ctx(runHook(db, "api", input("s1"), "SessionStart"));
    expect(h.hookEventName).toBe("SessionStart");
    expect(h.additionalContext).toContain("Aktuálny fokus: Auth podľa plánu");
    expect(h.additionalContext).toContain("Ďalší krok: Napísať testy");
    expect(h.additionalContext).toContain(`#${t.thread_id} od chat: Úloha`);
    expect(h.additionalContext).toContain("Máš novú poštu, pri vhodnej chvíli zavolaj read_thread.");
    expect(activeSessions(db, "api")[0]).toMatchObject({ session_id: "s1", cwd: "/x", git_branch: "main" });
  });
  it("karta sa vkladá len pri SessionStart; UserPromptSubmit iba nové správy bez opakovania", () => {
    linkProject(repo("r"), "api");
    contextWrite("api", "card", "fokus", "focus");
    expect(cardBlock("api")).toContain("fokus");
    chat.send("api", "Prvé", "x");
    runHook(db, "api", input("s1"), "SessionStart");
    expect(runHook(db, "api", input("s1"), "UserPromptSubmit")).toBeNull();
    chat.send("api", "Druhé", "x");
    const h = ctx(runHook(db, "api", input("s1"), "UserPromptSubmit"));
    expect(h.additionalContext).toContain("Druhé");
    expect(h.additionalContext).not.toContain("Prvé");
    expect(h.additionalContext).not.toContain("Aktuálny fokus");
    expect(runHook(db, "api", input("s1"), "UserPromptSubmit")).toBeNull();
  });
  it("iná session ohlási správu znova; prečítané sa neohlasujú", () => {
    const t = chat.send("api", "A", "x");
    expect(runHook(db, "api", input("s1"), "UserPromptSubmit")).not.toBeNull();
    expect(runHook(db, "api", input("s2"), "UserPromptSubmit")).not.toBeNull();
    new Inbox(db, "api").readThread(t.thread_id);
    expect(runHook(db, "api", input("s3"), "UserPromptSubmit")).toBeNull();
  });
  it("UserPromptSubmit obnoví last_seen_at, SessionEnd ukončí a nič nevypíše", () => {
    runHook(db, "api", input("s1"), "SessionStart");
    const before = activeSessions(db, "api")[0]!.last_seen_at;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    runHook(db, "api", input("s1"), "UserPromptSubmit");
    expect(activeSessions(db, "api")[0]!.last_seen_at > before).toBe(true);
    chat.send("api", "A", "x");
    expect(runHook(db, "api", input("s1"), "SessionEnd")).toBeNull();
    expect(activeSessions(db, "api")).toHaveLength(0);
  });
  it("udalosť sa berie z hook_event_name, ak nie je zadaná", () => {
    chat.send("api", "A", "x");
    const h = ctx(runHook(db, "api", { ...input("s1"), hook_event_name: "SessionStart" }));
    expect(h.hookEventName).toBe("SessionStart");
  });
});

describe("claude-inbox bin", () => {
  const bin = join(root, "dist", "claude-inbox.js");
  const run = (args: string[], stdin: object) =>
    execFileSync(process.execPath, [bin, ...args], {
      input: JSON.stringify(stdin),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_INBOX_HOME: process.env.CLAUDE_INBOX_HOME! },
    });

  it("status line podľa workspace.current_dir a offline bez DB", () => {
    const r = repo("Api");
    const input = { workspace: { current_dir: r } };
    expect(run([], input)).toBe("📬 pošta offline\n");
    const db = openDb(join(process.env.CLAUDE_INBOX_HOME!, "inbox.db"));
    new Inbox(db, "chat").send("api", "Úloha", "x");
    db.close();
    expect(run([], input)).toContain("1 nové");
  });
  it("status --json: ten istý model ako status line, so segmentmi", () => {
    const r = repo("Api");
    linkProject(r, "api");
    const db = openDb(join(process.env.CLAUDE_INBOX_HOME!, "inbox.db"));
    new Inbox(db, "chat").send("api", "Test pošty", "x");
    db.close();
    const m = JSON.parse(run(["status", "--json"], { workspace: { current_dir: r } }));
    expect(m).toMatchObject({ kind: "ok", agent: "api" });
    expect(m.plain).toBe("📬 api · 1 nové · 1 na tebe · „Test pošty“");
    expect(m.segments).toContainEqual({ t: "1 nové", s: "hi" });
    expect(m.segments).toContainEqual({ t: "„Test pošty“", s: "dim" });
    expect(run(["status", "--plain"], { workspace: { current_dir: r } })).toBe(m.plain + "\n");
    expect(JSON.parse(run(["status", "--json"], { workspace: { current_dir: dir } }))).toMatchObject({ kind: "noidentity" });
  });
  it("životný cyklus hookov cez stdin", () => {
    const r = repo("Api");
    const base = { session_id: "abc", cwd: r };
    expect(run(["hook", "UserPromptSubmit"], base)).toBe(""); // bez DB nič
    linkProject(r, "api");
    contextWrite("api", "card", "Fokus X", "focus");
    const start = JSON.parse(run(["hook", "SessionStart"], base)).hookSpecificOutput;
    expect(start.additionalContext).toContain("Fokus X");
    expect(run([], { workspace: { current_dir: r } })).toContain("1 session");
    const db = openDb(join(process.env.CLAUDE_INBOX_HOME!, "inbox.db"));
    new Inbox(db, "chat").send("api", "Úloha", "x");
    db.close();
    expect(JSON.parse(run(["hook", "UserPromptSubmit"], base)).hookSpecificOutput.additionalContext).toContain("Úloha");
    expect(run(["hook", "UserPromptSubmit"], base)).toBe("");
    expect(run(["hook", "SessionEnd"], base)).toBe("");
    expect(run([], { workspace: { current_dir: r } })).not.toContain("session");
  });
});

describe("claude-inbox link / whoami / log", () => {
  it("link založí kartu, whoami ju nájde", () => {
    const r = repo("proj");
    mkdirSync(join(r, "src"));
    const cli = (...a: string[]) =>
      execFileSync(process.execPath, [join(root, "dist", "claude-inbox.js"), ...a], {
        cwd: join(r, "src"),
        encoding: "utf8",
        env: { ...process.env, CLAUDE_INBOX_HOME: process.env.CLAUDE_INBOX_HOME!, CLAUDE_INBOX_AGENT: "" },
      });
    expect(cli("whoami")).toMatch(/^proj \(zdroj: git, /);
    expect(cli("link", "Demo")).toContain("nová karta");
    expect(cli("whoami")).toMatch(/^demo \(zdroj: karta, /);
    expect(cli("log")).toContain("prázdny");
    expect(() => cli("log", "včera")).toThrow();
  });
});

describe("setup", () => {
  it("settings.json: statusLine + 3 hooky, zachová zvyšok, idempotentný, so zálohou", () => {
    const settings = join(dir, "settings.json");
    
    writeFileSync(
      settings,
      JSON.stringify({ model: "x", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo moj" }] }] } }),
    );
    const run = () =>
      execFileSync(process.execPath, [join(root, "scripts", "setup.mjs"), "--no-build", "--no-link", "--no-claude-mcp"], {
        env: { ...process.env, CLAUDE_INBOX_DESKTOP_CONFIG: join(dir, "desktop.json"), CLAUDE_INBOX_SETTINGS: settings },
        encoding: "utf8",
      });
    run();
    run();
    const c = JSON.parse(readFileSync(settings, "utf8"));
    expect(c.model).toBe("x");
    expect(c.statusLine.command).toMatch(/claude-inbox\.js"$/);
    expect(c.hooks.SessionStart).toHaveLength(2);
    expect(c.hooks.SessionStart[0].hooks[0].command).toBe("echo moj");
    for (const ev of ["SessionStart", "UserPromptSubmit", "SessionEnd"]) {
      const ours = c.hooks[ev].filter((g: any) => g.hooks[0].command.includes("claude-inbox"));
      expect(ours).toHaveLength(1);
      expect(ours[0].hooks[0].command).toMatch(new RegExp(`claude-inbox\\.js" hook ${ev}$`));
    }
    expect(readdirSync(dir).filter((f) => f.startsWith("settings.json.bak-")).length).toBeGreaterThan(0);
    const desktop = JSON.parse(readFileSync(join(dir, "desktop.json"), "utf8"));
    expect(desktop.mcpServers["claude-inbox"].env).toEqual({ CLAUDE_INBOX_AGENT: "chat" });
  });
  it("zachová existujúcu identitu chatu z desktop configu", () => {
    
    const desktop = join(dir, "d2.json");
    writeFileSync(desktop, JSON.stringify({ mcpServers: { "claude-inbox": { env: { CLAUDE_INBOX_AGENT: "orchestrator" } }, x: { command: "y" } } }));
    execFileSync(process.execPath, [join(root, "scripts", "setup.mjs"), "--no-build", "--no-link", "--no-claude-mcp"], {
      env: { ...process.env, CLAUDE_INBOX_DESKTOP_CONFIG: desktop, CLAUDE_INBOX_SETTINGS: join(dir, "s2.json") },
      encoding: "utf8",
    });
    const c = JSON.parse(readFileSync(desktop, "utf8"));
    expect(c.mcpServers["claude-inbox"].env.CLAUDE_INBOX_AGENT).toBe("orchestrator");
    expect(c.mcpServers.x).toEqual({ command: "y" });
  });
});
