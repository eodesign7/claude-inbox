// Nájde spustiteľný súbor `claude`: najprv v PATH, potom v balíku desktop appky (macOS, Windows).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true });

export function findClaude() {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], { encoding: "utf8" });
  if (probe.status === 0) {
    const first = probe.stdout.split(/\r?\n/).find(Boolean);
    if (first) return first.trim();
  }
  const roots = [];
  if (process.platform === "darwin") {
    roots.push(join(homedir(), "Library", "Application Support", "Claude", "claude-code"));
  } else if (process.platform === "win32" && process.env.APPDATA) {
    roots.push(join(process.env.APPDATA, "Claude", "claude-code"));
  } else {
    roots.push(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "Claude", "claude-code"));
  }
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const version of readdirSync(root).sort(cmp).reverse()) {
      for (const sub of readdirSync(join(root, version)).sort(cmp).reverse()) {
        for (const rel of [
          ["claude.app", "Contents", "MacOS", "claude"],
          ["claude.exe"],
          ["claude"],
        ]) {
          const exe = join(root, version, sub, ...rel);
          if (existsSync(exe)) return exe;
        }
      }
    }
  }
  return null;
}
