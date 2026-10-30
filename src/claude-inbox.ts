#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { findGitBranch, resolveAgentInfo } from "./agent.js";
import { defaultDbPath, openDb, openDbReadonly } from "./db.js";
import { renderStatus, runHook, statusModel } from "./inbox.js";

function stdinJson(): any {
  try {
    if (process.stdin.isTTY) return {};
    const s = readFileSync(0, "utf8");
    return s.trim() ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

/** Podpríkazy pre človeka (map, show, card, ...) obsluhuje cli.ts; status line a hooky zvyšok. */
const CLI_COMMANDS = new Set(["map", "show", "card", "log", "link", "whoami", "send", "help", "--help", "-h"]);

function statusOrHook() {
  const input = stdinJson();
  const cwd: string = input?.workspace?.current_dir ?? input?.cwd ?? process.cwd();
  let agent: string | null = null;
  try {
    // status line a hooky bežia vždy pod Claude Code: CLAUDE_INBOX_AGENT sa ignoruje
    agent = resolveAgentInfo(cwd, { allowDir: false, env: { CLAUDECODE: "1" } }).agent;
  } catch {
    /* bez identity */
  }
  
  if (process.argv[2] === "hook") {
    // Hook nikdy nesmie rušiť session: pri akejkoľvek chybe ticho skonči.
    try {
      if (agent) {
        const event = process.argv[3];
        // SessionEnd/Prompt bez DB nemajú čo robiť; SessionStart ju vytvorí.
        if (event === "SessionStart" || existsSync(defaultDbPath())) {
          const db = openDb();
          const out = runHook(db, agent, { ...input, cwd, branch: findGitBranch(cwd) }, event);
          if (out) process.stdout.write(out + "\n");
        }
      }
    } catch {
      /* ticho */
    }
  } else {
    const db = agent ? openDbReadonly() : null;
    if (process.argv[2] === "status" && process.argv.includes("--json")) {
      // pre mod: ten istý model ako status line, ako JSON
      process.stdout.write(JSON.stringify(statusModel(db, agent)) + "\n");
    } else if (process.argv[2] === "status" && process.argv.includes("--plain")) {
      process.stdout.write(statusModel(db, agent).plain + "\n");
    } else {
      process.stdout.write(renderStatus(db, agent) + "\n");
    }
  }
}

if (CLI_COMMANDS.has(process.argv[2] ?? "")) {
  const { run } = await import("./cli.js");
  run(process.argv.slice(2));
} else {
  statusOrHook();
}
