import { spawnSync } from "node:child_process";
import { isCodeSession, linkProject, resolveAgentInfo } from "./agent.js";
import { agentName } from "./base.js";
import { cardPath, ensureCard } from "./cards.js";
import { mapOverview } from "./context.js";
import { openDb } from "./db.js";
import { localDate, readLogText } from "./log.js";
import { InboxError, formatThread, getThread, sendMessage } from "./core.js";

const USAGE = `claude-inbox map
claude-inbox show <thread_id>
claude-inbox card <agent>
claude-inbox log [YYYY-MM-DD]
claude-inbox link <agent>
claude-inbox whoami
claude-inbox send <to> "<text>" --as <agent>

Without a subcommand claude-inbox acts as the Claude Code status line;
"claude-inbox hook <Event>" is used by the hooks.`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

export function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "map": {
      const rows = mapOverview(openDb());
      if (!rows.length) return console.log("Žiadne projekty. V repe spusti: claude-inbox link <agent>");
      for (const r of rows) {
        const last = r.last_summary ? ` · posledný: ${r.last_summary.date} ${r.last_summary.subject}` : "";
        console.log(
          `${r.agent}: ${r.focus ?? "(bez fokusu)"} · ${r.open_threads} vlákien · ${r.active_sessions} sessions${last}`,
        );
      }
      return;
    }
    case "show": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) fail(USAGE);
      return console.log(formatThread(getThread(openDb(), id)));
    }
    case "card": {
      if (!rest[0]) fail(USAGE);
      const agent = agentName(rest[0]);
      ensureCard(agent);
      const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
      const r = spawnSync(`${editor} "${cardPath(agent)}"`, { stdio: "inherit", shell: true });
      process.exit(r.status ?? 0);
    }
    case "log": {
      const date = rest[0] ?? localDate();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("Dátum musí byť YYYY-MM-DD.");
      const t = readLogText(date);
      return console.log(t ?? `Log ${date} je prázdny.`);
    }
    case "link": {
      if (!rest[0]) fail(USAGE);
      const r = linkProject(process.cwd(), rest[0]);
      return console.log(`${r.root} → ${agentName(rest[0])}${r.created ? " (nová karta)" : ""}`);
    }
    case "whoami": {
      const r = resolveAgentInfo(process.cwd());
      const names = { card: "karta", env: "env", git: "git", dir: "priečinok", default: "default" } as const;
      return console.log(
        `${r.agent} (zdroj: ${names[r.source]}, ${r.detail}; ${isCodeSession() ? "Claude Code" : "chat"})`,
      );
    }
    case "send": {
      const asIdx = rest.indexOf("--as");
      let as = process.env.CLAUDE_INBOX_AGENT ?? "me";
      if (asIdx >= 0) {
        as = rest[asIdx + 1] ?? fail("Chýba hodnota pre --as");
        rest.splice(asIdx, 2);
      }
      const [to, ...words] = rest;
      const body = words.join(" ");
      if (!to || !body) fail(USAGE);
      const subject = body.split("\n")[0]!.slice(0, 80);
      const r = sendMessage(openDb(), as, to, subject, body, "task");
      return console.log(`Vlákno #${r.thread_id} (${as} → ${to})`);
    }
    default:
      fail(USAGE);
  }
}

/** Spustí podpríkaz; chyby InboxError vypíše bez stacku. */
export function run(argv: string[]) {
  try {
    main(argv);
  } catch (e) {
    if (e instanceof InboxError) fail(e.message);
    throw e;
  }
}
