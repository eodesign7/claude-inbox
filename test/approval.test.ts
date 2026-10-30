import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkProject } from "../src/agent.js";
import { editKey, readCard, setCardKey, wakeMode } from "../src/cards.js";
import { mapOverview, projectGet } from "../src/context.js";
import { openDb, type Db } from "../src/db.js";
import { Inbox, InboxError, decideApproval, formatThread, getThread, listPending } from "../src/core.js";
import { renderStatus, runHook, statusModel } from "../src/inbox.js";
import { listRuns } from "../src/runs.js";

const root = resolve(import.meta.dirname, "..");
const CLEAN = ["CLAUDE_INBOX_HOME", "CLAUDE_INBOX_DB", "CLAUDE_INBOX_CLAUDE_BIN", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID"];
let dir: string;
let saved: Record<string, string | undefined>;
let db: Db;
let chat: Inbox;
let worker: Inbox;

const repo = (name: string) => {
  const p = join(dir, name);
  mkdirSync(join(p, ".git"), { recursive: true });
  return p;
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "approval-")));
  saved = Object.fromEntries(CLEAN.map((k) => [k, process.env[k]]));
  for (const k of CLEAN) delete process.env[k];
  process.env.CLAUDE_INBOX_HOME = join(dir, "home");
  db = openDb(join(dir, "inbox.db"));
  chat = new Inbox(db, "chat");
  worker = new Inbox(db, "worker");
});
afterEach(() => {
  db.close();
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

describe("wake v karte", () => {
  it("predvolene off; nastavenie mení len kľúč wake a nič iné", () => {
    const r = repo("w");
    linkProject(r, "worker");
    expect(wakeMode("worker")).toBe("off");
    const before = readCard("worker")!;
    setCardKey("worker", "wake", "armed");
    const after = readCard("worker")!;
    expect(after.meta.wake).toBe("armed");
    expect(after.meta.paths).toEqual(before.meta.paths);
    expect(after.body).toBe(before.body);
    setCardKey("worker", "wake", "off");
    expect(readCard("worker")!.front!.match(/^wake:/gm)).toHaveLength(1);
  });
  it("editKey zachová zvyšok frontmatteru", () => {
    expect(editKey("name: a\npaths: []", "wake", "armed")).toBe("name: a\npaths: []\nwake: armed");
    expect(editKey("name: a\nwake: off\nx: 1", "wake", "headless")).toBe("name: a\nwake: headless\nx: 1");
  });
  it("neznáma hodnota sa berie ako off", () => {
    linkProject(repo("w"), "worker");
    setCardKey("worker", "wake", "yolo");
    expect(wakeMode("worker")).toBe("off");
  });
});

describe("úloha čaká na schválenie", () => {
  beforeEach(() => {
    linkProject(repo("w"), "worker");
    setCardKey("worker", "wake", "armed");
  });

  it("task pre projekt s wake je pending, bez wake alebo iný druh správy nie", () => {
    expect(chat.send("worker", "Auth", "x").approval).toBe("pending");
    expect(chat.send("worker", "Otázka", "x", "question").approval).toBe("none");
    expect(chat.send("nobody", "Iná", "x").approval).toBe("none");
    expect(listPending(db).map((p) => p.subject)).toEqual(["Auth"]);
  });
  it("príjemca ju nevidí: inbox, hook, status, ani ju nespotrebuje čítaním", () => {
    const t = chat.send("worker", "Auth", "tajný plán");
    expect(worker.inbox()).toEqual([]);
    expect(runHook(db, "worker", { session_id: "s" }, "UserPromptSubmit")).toBeNull();
    expect(renderStatus(db, "worker")).not.toMatch(/nové|na tebe/);
    const read = worker.readThread(t.thread_id);
    expect(formatThread(read)).toMatch(/NOT APPROVED \(pending\)/);
    expect(getThread(db, t.thread_id).messages[0]!.read_at).toBeNull(); // nespotrebovaná
  });
  it("príjemca nemôže odpovedať, zatvoriť ani sám schváliť", () => {
    const t = chat.send("worker", "Auth", "x");
    expect(() => worker.reply(t.thread_id, "idem na to")).toThrow(/not approved/);
    expect(() => worker.closeThread(t.thread_id, "hotovo")).toThrow(/not approved/);
    expect(() => worker.approve(t.thread_id)).toThrow(/addressed to itself/);
    expect(listPending(db)).toHaveLength(1);
  });
  it("odosielateľ vidí pending vo vlákne a status ukazuje počet na schválenie", () => {
    chat.send("worker", "Auth", "x");
    expect(chat.threads("open")[0]).toMatchObject({ approval: "pending" });
    const m = statusModel(db, "chat");
    expect(m.plain).toMatch(/1 na schválenie/);
    expect(m.pending).toEqual([expect.objectContaining({ subject: "Auth", from: "chat", to: "worker" })]);
    expect(mapOverview(db).find((r) => r.agent === "worker")).toMatchObject({
      wake: "armed",
      pending_approvals: [{ subject: "Auth", from: "chat" }],
    });
    expect(projectGet(db, "worker").open_threads[0]).toMatchObject({ approval: "pending" });
  });
});

describe("schválenie a zamietnutie", () => {
  let id: number;
  beforeEach(() => {
    linkProject(repo("w"), "worker");
    setCardKey("worker", "wake", "armed");
    id = chat.send("worker", "Auth", "plán").thread_id;
  });

  it("approve odomkne úlohu a hook ju ohlási ako SCHVÁLENÚ; armed nič nespúšťa", () => {
    const r = decideApproval(db, id, "approve", "user", "choď");
    expect(r).toMatchObject({ decision: "approve", to: "worker", wake: "armed", run: null });
    expect(getThread(db, id).thread.approval).toBe("approved");
    expect(worker.inbox().map((m) => m.kind)).toEqual(["reply", "task"]);
    const out = JSON.parse(runHook(db, "worker", { session_id: "s" }, "UserPromptSubmit")!);
    expect(out.hookSpecificOutput.additionalContext).toContain(`#${id} SCHVÁLENÉ používateľom, začni: Auth`);
    expect(worker.readThread(id).messages.map((m) => m.body)[1]).toMatch(/^Approved: choď\. Start the task now/);
    expect(listPending(db)).toEqual([]);
    expect(listRuns(db)).toEqual([]);
    worker.reply(id, "ok"); // teraz už smie
    expect(worker.closeThread(id, "hotovo").status).toBe("done");
  });
  it("decline zruší vlákno a oznámi to odosielateľovi; príjemca nikdy nič nevidel", () => {
    const r = decideApproval(db, id, "decline", "user", "teraz nie");
    expect(r.decision).toBe("decline");
    const t = getThread(db, id).thread;
    expect(t).toMatchObject({ approval: "declined", status: "cancelled" });
    expect(chat.inbox().map((m) => m.preview)).toEqual(["Declined: teraz nie."]);
    expect(worker.inbox()).toEqual([]);
    expect(() => decideApproval(db, id, "approve", "user")).toThrow(/not waiting for approval/);
  });
  it("odosielateľ (chat) môže schváliť cez nástroj; dvakrát nie", () => {
    expect(chat.approve(id).thread_id).toBe(id);
    expect(() => chat.approve(id)).toThrow(InboxError);
  });
});

describe("headless", () => {
  let fake: string;
  let out: string;
  beforeEach(() => {
    out = join(dir, "args.json");
    fake = join(dir, "fake-claude.js");
    writeFileSync(
      fake,
      `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd(), run: process.env.CLAUDE_INBOX_RUN}));\nconsole.log("done");\n`,
    );
    chmodSync(fake, 0o755);
    process.env.CLAUDE_INBOX_CLAUDE_BIN = fake;
  });

  const waitRun = async () => {
    for (let i = 0; i < 100; i++) {
      const r = listRuns(db)[0];
      if (r?.ended_at) return r;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("run did not finish");
  };

  it("po schválení spustí claude -p v repe so správnymi argumentmi a zapíše výsledok", async () => {
    const r = repo("w");
    linkProject(r, "worker");
    setCardKey("worker", "wake", "headless");
    setCardKey("worker", "wake_allowed_tools", "Bash(git:*), Bash(npm:*)");
    const id = chat.send("worker", "Auth", "x").thread_id;
    expect(listRuns(db)).toEqual([]); // pred schválením nič
    const res = decideApproval(db, id, "approve", "user");
    expect(res.run).toMatchObject({ run_id: 1 });
    const run = await waitRun();
    expect(run).toMatchObject({ thread_id: id, agent: "worker", exit_code: 0, cwd: r });
    const seen = JSON.parse(readFileSync(out, "utf8"));
    expect(seen.cwd).toBe(r);
    expect(seen.run).toBe("1");
    expect(seen.argv[0]).toBe("-p");
    expect(seen.argv[1]).toContain(`thread #${id}`);
    expect(seen.argv[1]).toContain(`close_thread(${id}`);
    expect(seen.argv.slice(2)).toEqual([
      "--permission-mode", "acceptEdits", "--allowedTools", "mcp__claude-inbox,Bash(git:*),Bash(npm:*)",
    ]);
    expect(readFileSync(run.log_path, "utf8")).toContain("done");
  });
  it("chyba pri štarte nezruší schválenie a nahlási sa", () => {
    linkProject(repo("w"), "worker");
    setCardKey("worker", "wake", "headless");
    setCardKey("worker", "paths_unused", "x");
    const card = readCard("worker")!;
    writeFileSync(join(process.env.CLAUDE_INBOX_HOME!, "projects", "worker", "card.md"), card.raw.replace(/paths:\n(  - .*\n)+/, "paths: []\n"));
    const id = chat.send("worker", "Auth", "x").thread_id;
    const res = decideApproval(db, id, "approve", "user");
    expect(res.run).toBeNull();
    expect(res.run_error).toMatch(/no existing path/);
    expect(getThread(db, id).thread.approval).toBe("approved");
  });
});

describe("CLI", () => {
  const cli = (...args: string[]) =>
    execFileSync(process.execPath, [join(root, "dist", "claude-inbox.js"), ...args], {
      env: { ...process.env, CLAUDE_INBOX_DB: join(dir, "inbox.db"), CLAUDE_INBOX_HOME: join(dir, "home") },
      encoding: "utf8",
    });

  it("wake, pending, approve, decline", () => {
    linkProject(repo("w"), "worker");
    expect(cli("wake", "worker")).toBe("worker: wake off\n");
    expect(cli("wake", "worker", "armed")).toBe("worker: wake armed\n");
    expect(() => cli("wake", "worker", "yolo")).toThrow();
    const a = chat.send("worker", "Auth", "x").thread_id;
    const b = chat.send("worker", "Billing", "x").thread_id;
    expect(cli("pending")).toMatch(/Auth/);
    expect(cli("approve", String(a), "ok")).toContain(`#${a} approved (worker, wake: armed)`);
    expect(cli("decline", String(b), "no")).toContain(`#${b} declined`);
    expect(cli("pending")).toContain("Nothing waits for approval.");
    expect(cli("runs")).toContain("No runs yet.");
  });
});
