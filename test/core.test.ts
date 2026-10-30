import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDb, type Db } from "../src/db.js";
import { PassThrough } from "node:stream";
import { linkProject, resolveAgentOrFallback } from "../src/agent.js";
import { Inbox, InboxError, formatThread, getThread, listAllThreads } from "../src/core.js";

const root = resolve(import.meta.dirname, "..");
let dir: string;
let dbPath: string;
let db: Db;
let chat: Inbox;
let api: Inbox;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inbox-"));
  process.env.CLAUDE_INBOX_HOME = join(dir, "home");
  dbPath = join(dir, "sub", "inbox.db"); // priečinok sa musí vytvoriť sám
  db = openDb(dbPath);
  chat = new Inbox(db, "chat");
  api = new Inbox(db, "api");
});
afterEach(() => db.close());

describe("db", () => {
  it("vytvorí priečinok, WAL a busy_timeout", () => {
    expect(existsSync(dbPath)).toBe(true);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
  });
});

describe("send", () => {
  it("založí vlákno a prvú správu", () => {
    const r = chat.send("api", "Build", "Zbuilduj to", "task");
    expect(r.thread_id).toBe(1);
    const { thread, messages } = getThread(db, r.thread_id);
    expect(thread).toMatchObject({ subject: "Build", created_by: "chat", status: "open" });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ from_agent: "chat", to_agent: "api", kind: "task", read_at: null });
  });
  it("odmietne neplatné mená, sebe samému a prázdne vstupy", () => {
    expect(() => chat.send("Api X", "s", "b")).toThrow(InboxError);
    expect(() => chat.send("chat", "s", "b")).toThrow(/sám sebe/);
    expect(() => chat.send("api", " ", "b")).toThrow(InboxError);
    expect(() => chat.send("api", "s", " ")).toThrow(InboxError);
    expect(() => new Inbox(db, "Bad Name")).toThrow(InboxError);
  });
  it("normalizuje adresáta na malé písmená", () => {
    const r = chat.send("API", "s", "b");
    expect(getThread(db, r.thread_id).messages[0]!.to_agent).toBe("api");
  });
});

describe("reply", () => {
  it("ide druhej strane z oboch smerov", () => {
    const { thread_id } = chat.send("api", "s", "úloha");
    expect(api.reply(thread_id, "otázka?", "question").to).toBe("chat");
    expect(chat.reply(thread_id, "odpoveď").to).toBe("api");
    expect(chat.reply(thread_id, "ešte jedna").to).toBe("api");
    const kinds = getThread(db, thread_id).messages.map((m) => m.kind);
    expect(kinds).toEqual(["task", "question", "reply", "reply"]);
  });
  it("podporuje explicitné `to`", () => {
    const { thread_id } = chat.send("api", "s", "b");
    expect(api.reply(thread_id, "pozri aj ty", "reply", "web").to).toBe("web");
    expect(new Inbox(db, "web").inbox()).toHaveLength(1);
  });
  it("odmietne cudzie, neexistujúce a uzavreté vlákno", () => {
    const { thread_id } = chat.send("api", "s", "b");
    expect(() => new Inbox(db, "web").reply(thread_id, "x")).toThrow(/nie je účastník/);
    expect(() => chat.reply(999, "x")).toThrow(/neexistuje/);
    api.closeThread(thread_id, "hotovo");
    expect(() => chat.reply(thread_id, "x")).toThrow(/done/);
  });
});

describe("inbox", () => {
  it("vracia len moje, najnovšie hore, s náhľadom 200 znakov", () => {
    const a = chat.send("api", "prvé", "x".repeat(500));
    const b = chat.send("api", "druhé", "krátke");
    chat.send("web", "cudzie", "nie pre stellu");
    const box = api.inbox();
    expect(box.map((m) => m.thread_id)).toEqual([b.thread_id, a.thread_id]);
    expect(box[1]).toMatchObject({ from: "chat", subject: "prvé", kind: "task" });
    expect((box[1]!.preview as string).length).toBe(200);
    expect(chat.inbox()).toEqual([]);
  });
  it("unread_only filtruje po prečítaní", () => {
    const { thread_id } = chat.send("api", "s", "b");
    expect(api.inbox(true)).toHaveLength(1);
    api.readThread(thread_id);
    expect(api.inbox(true)).toHaveLength(0);
    expect(api.inbox(false)).toHaveLength(1);
  });
});

describe("read_thread", () => {
  it("vráti chronologicky a označí len správy pre volajúceho", () => {
    const { thread_id } = chat.send("api", "s", "prvá");
    api.reply(thread_id, "druhá", "question");
    const t = api.readThread(thread_id);
    expect(t.messages.map((m) => m.body)).toEqual(["prvá", "druhá"]);
    const after = getThread(db, thread_id).messages;
    expect(after[0]!.read_at).not.toBeNull(); // pre stellu
    expect(after[1]!.read_at).toBeNull(); // pre chata
    expect(chat.inbox()).toHaveLength(1);
  });
  it("odmietne nečlena", () => {
    const { thread_id } = chat.send("api", "s", "b");
    expect(() => new Inbox(db, "web").readThread(thread_id)).toThrow(InboxError);
  });
  it("formatThread obsahuje subject a správy", () => {
    const { thread_id } = chat.send("api", "Predmet", "telo");
    const out = formatThread(getThread(db, thread_id));
    expect(out).toContain("#1 Predmet [open]");
    expect(out).toContain("chat → api · task");
  });
});

describe("close_thread", () => {
  it("uzavrie ako done a pošle summary druhej strane", () => {
    const { thread_id } = chat.send("api", "s", "b");
    const r = api.closeThread(thread_id, "Hotovo, commit abc123");
    expect(r).toMatchObject({ status: "done", to: "chat" });
    expect(getThread(db, thread_id).thread.status).toBe("done");
    const box = chat.inbox();
    expect(box).toHaveLength(1);
    expect(box[0]).toMatchObject({ kind: "summary", from: "api" });
  });
  it("nejde zavrieť dvakrát ani ako nečlen", () => {
    const { thread_id } = chat.send("api", "s", "b");
    expect(() => new Inbox(db, "web").closeThread(thread_id, "x")).toThrow(InboxError);
    chat.closeThread(thread_id, "x");
    expect(() => chat.closeThread(thread_id, "y")).toThrow(/už done/);
    expect(() => api.closeThread(thread_id, " ")).toThrow(InboxError);
  });
});

describe("threads", () => {
  it("zoznam len mojich vlákien podľa stavu", () => {
    const a = chat.send("api", "A", "b");
    chat.send("web", "B", "b");
    api.send("chat", "C", "b");
    expect(api.threads().map((t) => t.subject).sort()).toEqual(["A", "C"]);
    expect(api.threads()[0]).toHaveProperty("unread");
    api.closeThread(a.thread_id, "ok");
    expect(api.threads("open").map((t) => t.subject)).toEqual(["C"]);
    expect(api.threads("done").map((t) => t.subject)).toEqual(["A"]);
    expect(api.threads("all")).toHaveLength(2);
    expect(api.threads("cancelled")).toEqual([]);
  });
  it("listAllThreads (CLI) vidí všetky otvorené", () => {
    chat.send("api", "A", "b");
    new Inbox(db, "web").send("api", "B", "b");
    const all = listAllThreads(db, "open");
    expect(all).toHaveLength(2);
    expect(all.find((t) => t.subject === "A")).toMatchObject({ participants: ["api", "chat"], unread: 1 });
  });
});

describe("súbežný zápis", () => {
  it("dva procesy píšu naraz bez chyby", async () => {
    const worker = join(root, "test", "worker.mjs");
    const N = 150;
    const run = (agent: string, to: string) =>
      new Promise<{ code: number | null; err: string }>((res) => {
        const p = spawn(process.execPath, [worker, dbPath, agent, to, String(N)]);
        let err = "";
        p.stderr.on("data", (d) => (err += d));
        p.on("close", (code) => res({ code, err }));
      });
    const [r1, r2] = await Promise.all([run("chat", "api"), run("api", "chat")]);
    expect(r1).toEqual({ code: 0, err: "" });
    expect(r2).toEqual({ code: 0, err: "" });
    const n = db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
    expect(n.n).toBe(N * 2 * 2);
    const t = db.prepare("SELECT COUNT(*) AS n FROM threads").get() as { n: number };
    expect(t.n).toBe(N * 2);
  });
});

describe("MCP server cez stdio", () => {
  async function connect(agent: string) {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(root, "dist", "server.js")],
        env: { ...process.env, CLAUDECODE: "", CLAUDE_CODE_ENTRYPOINT: "", CLAUDE_CODE_SESSION_ID: "", CLAUDE_INBOX_AGENT: agent, CLAUDE_INBOX_DB: dbPath } as Record<string, string>,
      }),
    );
    return client;
  }
  const textOf = (r: any) => r.content[0].text as string;

  it("zoznam nástrojov a celý scenár Chat ↔ Api", async () => {
    const a = await connect("chat");
    const s = await connect("api");
    try {
      const names = (await a.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "close_thread", "context_write", "inbox", "map", "project_get", "read_thread", "reply", "repo_read", "send", "threads",
      ]);

      const sent = JSON.parse(textOf(await a.callTool({ name: "send", arguments: { to: "api", subject: "Úloha", body: "Urob X" } })));
      const id = sent.thread_id;

      const inbox = JSON.parse(textOf(await s.callTool({ name: "inbox", arguments: {} })));
      expect(inbox[0]).toMatchObject({ thread_id: id, from: "chat", subject: "Úloha" });

      expect(textOf(await s.callTool({ name: "read_thread", arguments: { thread_id: id } }))).toContain("Urob X");
      await s.callTool({ name: "reply", arguments: { thread_id: id, body: "Ktorá verzia?", kind: "question" } });
      await a.callTool({ name: "reply", arguments: { thread_id: id, body: "Posledná." } });
      await s.callTool({ name: "close_thread", arguments: { thread_id: id, summary: "Hotovo, commit abc" } });

      const summaries = JSON.parse(textOf(await a.callTool({ name: "inbox", arguments: { unread_only: true } })));
      expect(summaries.some((m: any) => m.kind === "summary" && m.thread_id === id)).toBe(true);
      const done = JSON.parse(textOf(await a.callTool({ name: "threads", arguments: { status: "done" } })));
      expect(done).toHaveLength(1);
    } finally {
      await a.close();
      await s.close();
    }
  });

  it("chyba sa vráti ako isError", async () => {
    const a = await connect("chat");
    try {
      const r: any = await a.callTool({ name: "reply", arguments: { thread_id: 42, body: "x" } });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/neexistuje/);
    } finally {
      await a.close();
    }
  });

  it("bez identity server nepadá: agent = názov priečinka, upozornenie na stderr", async () => {
    const cwd = join(dir, "Moj Projekt 2");
    mkdirSync(cwd);
    const env = { ...process.env, CLAUDE_INBOX_DB: dbPath, CLAUDE_INBOX_HOME: join(dir, "home") } as Record<string, string | undefined>;
    delete env.CLAUDE_INBOX_AGENT;
    const stderr = new PassThrough();
    let err = "";
    stderr.on("data", (d) => (err += d));
    const client = new Client({ name: "test", version: "0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "dist", "server.js")],
      env: env as Record<string, string>,
      cwd,
      stderr: "pipe",
    });
    await client.connect(transport);
    transport.stderr?.on("data", (d) => (err += d));
    try {
      const sent: any = await client.callTool({ name: "send", arguments: { to: "api", subject: "s", body: "b" } });
      expect(sent.isError).toBeFalsy();
      const msgs = db.prepare("SELECT from_agent FROM messages").all();
      expect(msgs).toEqual([{ from_agent: "moj-projekt-2" }]);
      expect(resolveAgentOrFallback(cwd)).toMatchObject({ agent: "moj-projekt-2", source: "dir" });
      await new Promise((r) => setTimeout(r, 100));
      expect(err).toMatch(/claude-inbox link <agent>/);
      expect(err).toMatch(/moj-projekt-2/);
    } finally {
      await client.close();
    }
  });

  it("neplatné CLAUDE_INBOX_AGENT sa nahradí priečinkom s upozornením", () => {
    const cwd = join(dir, "Plain Dir");
    mkdirSync(cwd);
    const r = resolveAgentOrFallback(cwd, { CLAUDE_INBOX_AGENT: "Bad Name" });
    expect(r).toMatchObject({ agent: "plain-dir", source: "dir" });
    expect(r.warning).toMatch(/Neplatný CLAUDE_INBOX_AGENT/);
    expect(r.warning).toMatch(/claude-inbox link <agent>/);
  });

  describe("identita servera podľa prostredia", () => {
    const repoWithCard = () => {
      const r = join(dir, "worker-repo");
      mkdirSync(join(r, ".git"), { recursive: true });
      linkProject(r, "worker");
      return r;
    };
    async function run(cwd: string, extra: Record<string, string>) {
      const env = { ...process.env, CLAUDE_INBOX_DB: dbPath, CLAUDE_INBOX_HOME: join(dir, "home"), ...extra } as Record<string, string | undefined>;
      for (const k of ["CLAUDE_INBOX_AGENT", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID"]) {
        if (!(k in extra)) delete env[k];
      }
      const client = new Client({ name: "test", version: "0" });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(root, "dist", "server.js")],
        env: env as Record<string, string>,
        cwd,
        stderr: "pipe",
      });
      let err = "";
      await client.connect(transport);
      transport.stderr?.on("data", (d) => (err += d));
      await client.callTool({ name: "send", arguments: { to: "someone", subject: "s", body: "b" } });
      await new Promise((r) => setTimeout(r, 150));
      await client.close();
      return err;
    }
    const sender = () => (db.prepare("SELECT from_agent FROM messages ORDER BY id DESC LIMIT 1").get() as { from_agent: string }).from_agent;

    it("Code session s CLAUDE_INBOX_AGENT=orchestrator v repe s kartou worker píše ako worker", async () => {
      const err = await run(repoWithCard(), { CLAUDE_INBOX_AGENT: "orchestrator", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "claude-desktop" });
      expect(sender()).toBe("worker");
      expect(err).toMatch(/agent=worker zdroj=card/);
      expect(err).toMatch(/prostredie=claude-code/);
      expect(err).toMatch(/cwd=/);
      expect(err).toMatch(/klient=test\/0/);
    });
    it("Code session v repe bez karty píše ako názov repa, nikdy ako orchestrator", async () => {
      const r = join(dir, "No-Card");
      mkdirSync(join(r, ".git"), { recursive: true });
      const err = await run(r, { CLAUDE_INBOX_AGENT: "orchestrator", CLAUDECODE: "1" });
      expect(sender()).toBe("no-card");
      expect(err).toMatch(/agent=no-card zdroj=git/);
    });
    it("chat (bez CLAUDECODE) používa CLAUDE_INBOX_AGENT", async () => {
      const err = await run("/", { CLAUDE_INBOX_AGENT: "orchestrator" });
      expect(sender()).toBe("orchestrator");
      expect(err).toMatch(/agent=orchestrator zdroj=env/);
      expect(err).toMatch(/prostredie=chat/);
    });
  });
});

describe("CLI claude-inbox", () => {
  const cli = (...args: string[]) =>
    execFileSync(process.execPath, [join(root, "dist", "claude-inbox.js"), ...args], {
      env: { ...process.env, CLAUDE_INBOX_DB: dbPath, CLAUDE_INBOX_HOME: join(dir, "home") },
      encoding: "utf8",
    });

  it("send, map, show", () => {
    expect(cli("send", "api", "Skontroluj", "build", "--as", "chat")).toContain("#1");
    expect(cli("map")).toMatch(/api:/);
    expect(cli("show", "1")).toContain("chat → api");
    // show nemení stav prečítania
    expect(api.inbox(true)).toHaveLength(1);
  });
  it("neplatný agent končí chybou", () => {
    expect(() => cli("send", "Bad Name", "x", "--as", "chat")).toThrow();
  });
});

describe("setup skript", () => {
  it("zachová existujúce servery a spraví zálohu", () => {
    const cfg = join(dir, "claude_desktop_config.json");
    writeFileSync(cfg, JSON.stringify({ theme: "x", mcpServers: { other: { command: "foo" } } }));
    const out = execFileSync(process.execPath, [join(root, "scripts", "setup.mjs"), "--no-build", "--no-link", "--no-claude-mcp"], {
      env: { ...process.env, CLAUDE_INBOX_DESKTOP_CONFIG: cfg, CLAUDE_INBOX_SETTINGS: join(dir, "settings.json") },
      encoding: "utf8",
    });
    const c = JSON.parse(readFileSync(cfg, "utf8"));
    expect(c.theme).toBe("x");
    expect(c.mcpServers.other).toEqual({ command: "foo" });
    expect(c.mcpServers["claude-inbox"].env).toEqual({ CLAUDE_INBOX_AGENT: "chat" });
    expect(c.mcpServers["claude-inbox"].args[0]).toMatch(/dist\/server\.js$/);
    expect(readdirSync(dir).some((f) => f.startsWith("claude_desktop_config.json.bak-"))).toBe(true);
    expect(out).toMatch(/claude mcp add claude-inbox --scope user -- /);
    expect(out).not.toMatch(/CLAUDE_INBOX_AGENT=api/);
    expect(out).toMatch(/claude-inbox link <agent>/);
  });
  it("neplatný JSON nechá bez zmeny", () => {
    const cfg = join(dir, "bad.json");
    writeFileSync(cfg, "{ nie json");
    expect(() =>
      execFileSync(process.execPath, [join(root, "scripts", "setup.mjs"), "--no-build", "--no-link", "--no-claude-mcp"], {
        env: { ...process.env, CLAUDE_INBOX_DESKTOP_CONFIG: cfg },
        stdio: "pipe",
      }),
    ).toThrow();
    expect(readFileSync(cfg, "utf8")).toBe("{ nie json");
  });
});
