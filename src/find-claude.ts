import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** The `claude` executable: CLAUDE_INBOX_CLAUDE_BIN, then PATH, then the desktop app's bundle. */
export function findClaude(): string | null {
  if (process.env.CLAUDE_INBOX_CLAUDE_BIN) return process.env.CLAUDE_INBOX_CLAUDE_BIN;
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], { encoding: "utf8" });
  if (probe.status === 0) {
    const first = probe.stdout.split(/\r?\n/).find(Boolean);
    if (first) return first.trim();
  }
  const base =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "Claude", "claude-code")
      : process.platform === "win32" && process.env.APPDATA
        ? join(process.env.APPDATA, "Claude", "claude-code")
        : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "Claude", "claude-code");
  if (!existsSync(base)) return null;
  for (const version of readdirSync(base).sort(cmp).reverse()) {
    for (const sub of readdirSync(join(base, version)).sort(cmp).reverse()) {
      for (const rel of [["claude.app", "Contents", "MacOS", "claude"], ["claude.exe"], ["claude"]]) {
        const exe = join(base, version, sub, ...rel);
        if (existsSync(exe)) return exe;
      }
    }
  }
  return null;
}
