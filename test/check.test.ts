import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error JS modul bez typov
import { checkDesktop } from "../scripts/check-desktop.mjs";

const root = resolve(import.meta.dirname, "..");
let dir: string;
let saved: string | undefined;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "check-")));
  saved = process.env.CLAUDE_INBOX_DESKTOP_CONFIG;
  process.env.CLAUDE_INBOX_DESKTOP_CONFIG = join(dir, "desktop.json");
  process.env.CLAUDE_INBOX_HOME = join(dir, "home");
});
afterEach(() => {
  saved === undefined ? delete process.env.CLAUDE_INBOX_DESKTOP_CONFIG : (process.env.CLAUDE_INBOX_DESKTOP_CONFIG = saved);
});
const write = (entry: unknown) =>
  writeFileSync(process.env.CLAUDE_INBOX_DESKTOP_CONFIG!, JSON.stringify({ mcpServers: entry ? { "claude-inbox": entry } : {} }));

describe("checkDesktop", () => {
  it("platný zápis: initialize prejde, nástroje sú 10", async () => {
    write({ command: process.execPath, args: [join(root, "dist", "server.js")], env: { CLAUDE_INBOX_AGENT: "chat" } });
    const r = await checkDesktop();
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toMatch(/initialize OK, tools: 10/);
  });
  it("chýbajúci záznam, zlý command, chýbajúci CLAUDE_INBOX_AGENT", async () => {
    write(null);
    expect((await checkDesktop()).lines.join()).toMatch(/"claude-inbox" is missing/);
    write({ command: "node", args: ["/x"], env: { CLAUDE_INBOX_AGENT: "chat" } });
    expect((await checkDesktop()).lines.join()).toMatch(/not an absolute path/);
    write({ command: process.execPath, args: [join(root, "dist", "server.js")] });
    expect((await checkDesktop()).lines.join()).toMatch(/CLAUDE_INBOX_AGENT is missing/);
  });
  it("server, ktorý skončí, sa nahlási s stderr", async () => {
    const bad = join(dir, "bad.js");
    writeFileSync(bad, "console.error('boom');process.exit(3)");
    write({ command: process.execPath, args: [bad], env: { CLAUDE_INBOX_AGENT: "chat" } });
    const r = await checkDesktop();
    expect(r.ok).toBe(false);
    expect(r.lines.join()).toMatch(/exited \(code 3\).*boom/);
  });
});
