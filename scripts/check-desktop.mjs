#!/usr/bin/env node
// Checks the Claude desktop config: npm run check
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Is the desktop app running? (It keeps its own copy of the config and overwrites the file when it saves.) */
export function desktopRunning() {
  try {
    if (process.platform === "darwin") {
      // pgrep v niektorých prostrediach appku nevidí, ps áno
      const r = spawnSync("ps", ["-axo", "comm"], { encoding: "utf8" });
      return /(^|\n)\S.*\/Claude\.app\/Contents\/MacOS\/Claude\s*(\n|$)/.test(r.stdout ?? "");
    }
    if (process.platform === "win32") {
      const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq Claude.exe", "/NH"], { encoding: "utf8" });
      return /Claude\.exe/i.test(r.stdout ?? "");
    }
    const r = spawnSync("ps", ["-axo", "comm"], { encoding: "utf8" });
    return /(^|\n)(claude-desktop|Claude)\s*(\n|$)/.test(r.stdout ?? "");
  } catch {
    return false;
  }
}

/** Waits until the app quits. */
export async function waitForQuit(timeoutMs = 600_000) {
  const t0 = Date.now();
  while (desktopRunning()) {
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return true;
}

/** Sends the MCP server initialize + tools/list exactly as the config launches it. */
function handshake(entry) {
  return new Promise((done) => {
    const env = {
      HOME: process.env.HOME ?? "",
      USERPROFILE: process.env.USERPROFILE ?? "",
      ...(process.env.CLAUDE_INBOX_HOME ? { CLAUDE_INBOX_HOME: process.env.CLAUDE_INBOX_HOME } : {}),
      ...(process.env.CLAUDE_INBOX_DB ? { CLAUDE_INBOX_DB: process.env.CLAUDE_INBOX_DB } : {}),
      ...(entry.env ?? {}),
    };
    // cwd "/" like the desktop app: the identity must come from CLAUDE_INBOX_AGENT
    const p = spawn(entry.command, entry.args ?? [], { env, cwd: resolve("/"), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let finished = false;
    const finish = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      p.kill();
      done(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `no answer within 8 s. stderr: ${err.trim() || "(empty)"}` }), 8000);
    p.on("error", (e) => finish({ ok: false, error: `server did not start: ${e.message}` }));
    p.on("exit", (code) => finish({ ok: false, error: `server exited (code ${code}). stderr: ${err.trim() || "(empty)"}` }));
    p.stderr.on("data", (d) => (err += d));
    p.stdout.on("data", (d) => {
      out += d;
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          if (msg.error) return finish({ ok: false, error: `initialize: ${JSON.stringify(msg.error)}` });
          p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
        }
        if (msg.id === 2) {
          const n = msg.result?.tools?.length ?? 0;
          return finish({ ok: n > 0, tools: n, error: n ? undefined : "tools/list is empty" });
        }
      }
    });
    p.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-inbox-check", version: "0" } },
      }) + "\n",
    );
  });
}

/** Returns { ok, lines }. persistMs > 0: re-reads the config after that delay (the app may have overwritten it). */
export async function checkDesktop({ persistMs = 0 } = {}) {
  const lines = [];
  const fail = (m) => ({ ok: false, lines: [...lines, `ERROR: ${m}`] });
  const { desktopConfigPath } = await import(pathToFileURL(join(root, "dist", "paths.js")).href);
  const path = desktopConfigPath();
  const read = () => JSON.parse(readFileSync(path, "utf8"));

  if (!existsSync(path)) return fail(`config does not exist: ${path}`);
  let entry;
  try {
    entry = read().mcpServers?.["claude-inbox"];
  } catch (e) {
    return fail(`config is not valid JSON: ${e.message}`);
  }
  if (!entry) return fail(`"claude-inbox" is missing from mcpServers (${path})`);
  if (!entry.command || !(isAbsolute(entry.command) || win32.isAbsolute(entry.command))) {
    return fail(`command is not an absolute path: ${entry.command}`);
  }
  if (!existsSync(entry.command)) return fail(`command does not exist: ${entry.command}`);
  const server = entry.args?.[0];
  if (!server || !existsSync(server)) return fail(`args[0] does not exist: ${server}`);
  if (!entry.env?.CLAUDE_INBOX_AGENT) return fail("env.CLAUDE_INBOX_AGENT is missing");
  lines.push(`config: ${path}`, `command: ${entry.command}`, `args: ${server}`, `CLAUDE_INBOX_AGENT: ${entry.env.CLAUDE_INBOX_AGENT}`);

  // better-sqlite3 must be built for this very node
  const abi = spawnSync(entry.command, ["-e", "const D=require('better-sqlite3');new D(':memory:').close();process.stdout.write(process.version+' ABI '+process.versions.modules)"], {
    cwd: root,
    encoding: "utf8",
  });
  if (abi.status !== 0) {
    return fail(`better-sqlite3 cannot be loaded in ${entry.command}: ${(abi.stderr || "").split("\n").slice(0, 3).join(" ")} → run: npm rebuild better-sqlite3`);
  }
  lines.push(`better-sqlite3 OK (${abi.stdout.trim()})`);

  const hs = await handshake(entry);
  if (!hs.ok) return fail(`server did not answer initialize: ${hs.error}`);
  lines.push(`initialize OK, tools: ${hs.tools}`);

  if (persistMs > 0) {
    await new Promise((r) => setTimeout(r, persistMs));
    try {
      if (!read().mcpServers?.["claude-inbox"]) return fail("the entry vanished from the config (did the app overwrite it?). Quit Claude and run setup again.");
    } catch (e) {
      return fail(`the config got corrupted: ${e.message}`);
    }
  }
  return { ok: true, lines };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await checkDesktop();
  for (const l of r.lines) console.log(`  ${l}`);
  console.log(r.ok ? "desktop config OK" : "desktop config ERROR");
  process.exit(r.ok ? 0 : 1);
}
