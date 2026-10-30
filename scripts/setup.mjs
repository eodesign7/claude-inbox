#!/usr/bin/env node
// npm run setup [-- --chat-agent=<name> --wait --force --no-build --no-link --no-claude-mcp]
import { execFileSync, execSync } from "node:child_process";
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (f) => join(root, "dist", f);
const flags = process.argv.slice(2);
const has = (f) => flags.includes(f);
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });

// 1. build
if (!has("--no-build")) {
  console.log("→ build");
  run("npm run build");
}

const { desktopConfigPath, claudeSettingsPath } = await import(pathToFileURL(dist("paths.js")).href);
const { migrateLegacy } = await import(pathToFileURL(dist("cards.js")).href);
const { desktopRunning, waitForQuit, checkDesktop } = await import(
  pathToFileURL(join(root, "scripts", "check-desktop.mjs")).href
);
const { findClaude } = await import(pathToFileURL(dist("find-claude.js")).href);

// Bežiaca appka drží vlastnú kópiu configu a pri ďalšom uložení prepíše náš zápis.
if (!process.env.CLAUDE_INBOX_DESKTOP_CONFIG && !has("--force") && desktopRunning()) {
  if (has("--wait")) {
    console.log("Claude desktop is running. Quit it (Cmd+Q / File > Quit); waiting…");
    if (!(await waitForQuit())) {
      console.error("The app is still running, giving up.");
      process.exit(1);
    }
  } else {
    console.error("Claude desktop is running. It would overwrite its config when it saves its own settings,");
    console.error("and the new entry would vanish. Quit it and run setup again, or run");
    console.error("`npm run setup -- --wait` and quit the app afterwards. (Override: --force)");
    process.exit(1);
  }
}

/** Načíta JSON konfig (alebo {}), pred zápisom spraví zálohu. Neplatný JSON nechá na pokoji. */
function loadWithBackup(path) {
  console.log(`→ ${path}`);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    return {};
  }
  const raw = readFileSync(path, "utf8");
  let data = {};
  if (raw.trim()) {
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.error(`  not valid JSON, leaving it untouched: ${e.message}`);
      process.exit(1);
    }
  }
  const backup = `${path}.bak-${stamp()}`;
  copyFileSync(path, backup);
  console.log(`  backup: ${backup}`);
  return data;
}
const save = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + "\n");

// 2. migration from 0.1 (legacy ~/.aico and posta.db) to ~/.claude-inbox
if (!process.env.CLAUDE_INBOX_HOME) {
  const oldHome = join(homedir(), ".aico");
  const newHome = join(homedir(), ".claude-inbox");
  if (existsSync(oldHome) && !existsSync(newHome)) {
    renameSync(oldHome, newHome);
    for (const f of readdirSync(newHome)) {
      if (f.startsWith("posta.db")) renameSync(join(newHome, f), join(newHome, f.replace("posta.db", "inbox.db")));
    }
    console.log(`→ migrated ${oldHome} → ${newHome}`);
  }
}
const migrated = migrateLegacy();
if (migrated) console.log(`→ projects migrated from projects.json: ${migrated}`);

// 3. Claude desktop (chat): identita z CLAUDE_INBOX_AGENT
const desktopPath = desktopConfigPath();
const desktop = loadWithBackup(desktopPath);
desktop.mcpServers ??= {};
const old = desktop.mcpServers["aico-posta"]; // legacy name from 0.1
const chatFlag = flags.find((f) => f.startsWith("--chat-agent="))?.split("=")[1];
const chatAgent =
  chatFlag ||
  desktop.mcpServers["claude-inbox"]?.env?.CLAUDE_INBOX_AGENT ||
  old?.env?.AICO_AGENT ||
  "chat";
delete desktop.mcpServers["aico-posta"];
desktop.mcpServers["claude-inbox"] = {
  command: process.execPath,
  args: [dist("server.js")],
  env: { CLAUDE_INBOX_AGENT: chatAgent },
};
save(desktopPath, desktop);
console.log(`  server claude-inbox added (CLAUDE_INBOX_AGENT=${chatAgent}). Restart Claude desktop.`);

// 4. Claude Code: MCP server (scope user, bez identity), plugin s pásom
console.log("\n→ Claude Code");
const claude = has("--no-claude-mcp") ? null : findClaude();
const tryClaude = (args, quiet = false) => {
  try {
    execFileSync(claude, args, { stdio: quiet ? "ignore" : "inherit" });
    return true;
  } catch {
    return false;
  }
};
const quote = (a) => (/\s/.test(a) ? `"${a}"` : a);
const addArgs = ["mcp", "add", "claude-inbox", "--scope", "user", "--", process.execPath, dist("server.js")];
if (!claude) {
  console.log(`  skipped (${has("--no-claude-mcp") ? "--no-claude-mcp" : "`claude` not found"}). Run by hand:`);
  console.log(`  claude ${addArgs.map(quote).join(" ")}`);
  console.log(`  claude plugin marketplace add ${quote(root)}`);
  console.log("  claude plugin install inbox-bar@claude-inbox --scope user");
} else {
  console.log(`  using ${claude}`);
  tryClaude(["mcp", "remove", "aico-posta", "--scope", "user"], true);
  tryClaude(["mcp", "remove", "claude-inbox", "--scope", "user"], true);
  if (!tryClaude(addArgs)) console.error(`  failed, run by hand:\n  claude ${addArgs.map(quote).join(" ")}`);

  // pás nad promptom (plugin inbox-bar); staré názvy z 0.1 sa odstránia
  tryClaude(["plugin", "uninstall", "posta-inbox@aico-posta", "--scope", "user"], true);
  tryClaude(["plugin", "marketplace", "remove", "aico-posta"], true);
  tryClaude(["plugin", "marketplace", "add", root], true);
  if (!tryClaude(["plugin", "install", "inbox-bar@claude-inbox", "--scope", "user"])) {
    console.error("  plugin install failed; run by hand:\n  claude plugin install inbox-bar@claude-inbox --scope user");
  }
}

// 5. settings.json: statusLine + hooky
const settingsPath = claudeSettingsPath();
const settings = loadWithBackup(settingsPath);
const inboxCmd = `"${process.execPath}" "${dist("claude-inbox.js")}"`;
const prev = settings.statusLine?.command;
if (prev && !prev.includes("claude-inbox")) console.log(`  previous statusLine replaced: ${prev}`);
settings.statusLine = { type: "command", command: inboxCmd };
settings.hooks ??= {};
for (const event of ["SessionStart", "UserPromptSubmit", "SessionEnd"]) {
  const groups = (settings.hooks[event] ??= []).filter(
    (g) => !g.hooks?.some((h) => h.command?.includes("claude-inbox")),
  );
  groups.push({ hooks: [{ type: "command", command: `${inboxCmd} hook ${event}` }] });
  settings.hooks[event] = groups;
}
save(settingsPath, settings);
console.log("  statusLine + SessionStart, UserPromptSubmit, SessionEnd hooks set.");

// 6. príkaz claude-inbox globálne
if (!has("--no-link")) {
  console.log("\n→ npm link (command claude-inbox)");
  // the 0.1 package (aico-posta) left a global link owning the same command name
  try {
    execSync("npm unlink -g aico-posta", { cwd: root, stdio: "ignore" });
  } catch {
    /* not linked */
  }
  // the 0.1 package (aico-posta) left a global link owning the same command name
  try {
    execSync("npm unlink -g aico-posta", { cwd: root, stdio: "ignore" });
  } catch {
    /* not linked */
  }
  try {
    const bin = join(execSync("npm prefix -g", { cwd: root, encoding: "utf8" }).trim(), "bin");
    for (const name of ["claude-inbox", "posta", "aico-posta"]) {
      const link = join(bin, name);
      // only dangling symlinks that point into the old package are removed
      if (
        lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() &&
        !existsSync(link) &&
        readlinkSync(link).includes("node_modules/aico-posta/")
      ) {
        unlinkSync(link);
      }
    }
  } catch {
    /* best effort */
  }
  try {
    run("npm link");
  } catch {
    console.error("npm link failed. Try: sudo npm link (or set your npm prefix to ~/.npm-global).");
    process.exit(1);
  }
}

// 7. kontrola configu desktop appky (zápis, node, better-sqlite3, initialize, trvácnosť)
console.log("\n→ checking the desktop config");
const check = await checkDesktop({ persistMs: 1500 });
for (const l of check.lines) console.log(`  ${l}`);
if (!check.ok) process.exit(1);
console.log("desktop config OK");

console.log("\nIn every repo run: claude-inbox link <agent>");
