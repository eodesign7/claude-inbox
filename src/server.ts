#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isCodeSession, resolveAgentOrFallback } from "./agent.js";
import { contextWrite, mapOverview, projectGet, repoRead } from "./context.js";
import { openDb } from "./db.js";
import { KINDS, Inbox, InboxError, STATUSES, formatThread } from "./core.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const json = (v: unknown) => text(JSON.stringify(v));

function wrap<A>(fn: (a: A) => ReturnType<typeof text>) {
  return async (a: A) => {
    try {
      return fn(a);
    } catch (e) {
      if (e instanceof InboxError) return { ...text(e.message), isError: true };
      throw e;
    }
  };
}

const resolved = resolveAgentOrFallback(process.cwd());
const agent = resolved.agent;
console.error(
  `claude-inbox: cwd=${process.cwd()} agent=${agent} zdroj=${resolved.source} (${resolved.detail}) ` +
    `prostredie=${isCodeSession() ? "claude-code" : "chat"}`,
);
if (resolved.warning) console.error(resolved.warning);

const db = openDb();
const mailbox = new Inbox(db, agent);
const server = new McpServer(
  { name: "claude-inbox", version: "2.0.0" },
  resolved.source === "env"
    ? {
        instructions:
          `This instance acts as "${agent}" (chat). In Claude Code sessions do not use it: ` +
          `use the claude-inbox server registered for Claude Code, which takes its identity from the repo.`,
      }
    : undefined,
);
server.server.oninitialized = () => {
  const c = server.server.getClientVersion();
  console.error(`claude-inbox: klient=${c?.name ?? "?"}/${c?.version ?? "?"}`);
};

const threadId = z.number().int().positive();
const kind = z.enum(KINDS);

server.registerTool(
  "map",
  { description: "Overview of all projects: focus, open threads, active sessions, last summary.", inputSchema: {} },
  wrap(() => json(mapOverview(db))),
);

server.registerTool(
  "project_get",
  {
    description: "Full project card, notes, open threads, active sessions, last 3 summaries.",
    inputSchema: { agent: z.string() },
  },
  wrap((a) => json(projectGet(db, a.agent))),
);

server.registerTool(
  "context_write",
  {
    description: 'Write project context. file: "card" or a note name. With section only that card section is replaced; frontmatter is never changed.',
    inputSchema: {
      agent: z.string(),
      file: z.string(),
      text: z.string().describe("markdown"),
      section: z.string().optional().describe("Čo to je | Aktuálny fokus | Rozhodnutia | Ďalší krok"),
    },
  },
  wrap((a) => json(contextWrite(a.agent, a.file, a.text, a.section))),
);

server.registerTool(
  "repo_read",
  {
    description: "Read a .md file inside the project's repo paths (read-only).",
    inputSchema: { agent: z.string(), path: z.string().describe("relative to a project path") },
  },
  wrap((a) => text(repoRead(a.agent, a.path))),
);

server.registerTool(
  "send",
  {
    description: "New thread + first message to agent `to`. Returns thread_id.",
    inputSchema: {
      to: z.string(),
      subject: z.string(),
      body: z.string().describe("markdown"),
      kind: kind.default("task"),
      ticket: z.string().optional(),
    },
  },
  wrap((a) => json(mailbox.send(a.to, a.subject, a.body, a.kind, a.ticket))),
);

server.registerTool(
  "reply",
  {
    description: "Reply in a thread. Without `to` it goes to the other side.",
    inputSchema: { thread_id: threadId, body: z.string(), kind: kind.default("reply"), to: z.string().optional() },
  },
  wrap((a) => json(mailbox.reply(a.thread_id, a.body, a.kind, a.to))),
);

server.registerTool(
  "inbox",
  {
    description: "My messages, newest first, 200-char preview.",
    inputSchema: { unread_only: z.boolean().default(true) },
  },
  wrap((a) => json(mailbox.inbox(a.unread_only))),
);

server.registerTool(
  "read_thread",
  { description: "Whole thread in order; marks my messages read.", inputSchema: { thread_id: threadId } },
  wrap((a) => text(formatThread(mailbox.readThread(a.thread_id)))),
);

server.registerTool(
  "close_thread",
  {
    description: "Close thread as done, send summary to the other side, append to today's log; focus/next overwrite those card sections.",
    inputSchema: {
      thread_id: threadId,
      summary: z.string().describe("what was done, commits, what remains"),
      focus: z.string().optional(),
      next: z.string().optional(),
    },
  },
  wrap((a) => json(mailbox.closeThread(a.thread_id, a.summary, a.focus, a.next))),
);

server.registerTool(
  "threads",
  {
    description: "Threads of me (or of `agent`) by status.",
    inputSchema: { status: z.enum([...STATUSES, "all"]).default("open"), agent: z.string().optional() },
  },
  wrap((a) => json(mailbox.threads(a.status, a.agent))),
);

await server.connect(new StdioServerTransport());
