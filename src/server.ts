#!/usr/bin/env node
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isCodeClient, isCodeSession, resolveAgentOrFallback } from "./agent.js";
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
const tools: Record<string, RegisteredTool> = {};

/**
 * The desktop app also hands its own MCP servers to Code sessions, through a client called
 * "local-agent-mode-<server>" (chat uses "claude-ai"). An instance whose identity comes from
 * CLAUDE_INBOX_AGENT (chat) has no idea which repo such a session works in, so for Code clients it
 * keeps only the tools that take an explicit agent; the identity-bound ones are switched off and
 * the model uses the claude-inbox server that Claude Code runs itself.
 */
export const IDENTITY_TOOLS = ["send", "reply", "inbox", "read_thread", "close_thread", "approve", "threads"] as const;

server.server.oninitialized = () => {
  const c = server.server.getClientVersion();
  const name = c?.name ?? "?";
  console.error(`claude-inbox: klient=${name}/${c?.version ?? "?"}`);
  if (resolved.source === "env" && isCodeClient(name)) {
    for (const t of IDENTITY_TOOLS) tools[t]?.disable();
    console.error(`claude-inbox: klient ${name} je Claude Code, identitné nástroje vypnuté (identita ${agent} je pre chat)`);
  }
};

const threadId = z.number().int().positive();
const kind = z.enum(KINDS);

tools.map = server.registerTool(
  "map",
  {
    description:
      "Overview of all projects (focus, open threads, sessions, pending approvals, last summary). With `agent`: that project in full (card, notes, threads, sessions, summaries).",
    inputSchema: { agent: z.string().optional() },
  },
  wrap((a) => json(a.agent ? projectGet(db, a.agent) : mapOverview(db))),
);

tools.context_write = server.registerTool(
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

tools.repo_read = server.registerTool(
  "repo_read",
  {
    description: "Read a .md file inside the project's repo paths (read-only).",
    inputSchema: { agent: z.string(), path: z.string().describe("relative to a project path") },
  },
  wrap((a) => text(repoRead(a.agent, a.path))),
);

tools.send = server.registerTool(
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

tools.reply = server.registerTool(
  "reply",
  {
    description: "Reply in a thread. Without `to` it goes to the other side.",
    inputSchema: { thread_id: threadId, body: z.string(), kind: kind.default("reply"), to: z.string().optional() },
  },
  wrap((a) => json(mailbox.reply(a.thread_id, a.body, a.kind, a.to))),
);

tools.inbox = server.registerTool(
  "inbox",
  {
    description: "My messages, newest first, 200-char preview.",
    inputSchema: { unread_only: z.boolean().default(true) },
  },
  wrap((a) => json(mailbox.inbox(a.unread_only))),
);

tools.read_thread = server.registerTool(
  "read_thread",
  {
    description:
      "Whole thread in order; marks my messages read. Already-read middle messages are shortened to one line; full=true shows everything.",
    inputSchema: { thread_id: threadId, full: z.boolean().default(false) },
  },
  wrap((a) => {
    const r = mailbox.readThread(a.thread_id, a.full);
    return text(formatThread(r, r.collapse));
  }),
);

tools.close_thread = server.registerTool(
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

tools.approve = server.registerTool(
  "approve",
  {
    description:
      "Approve or decline a task waiting for the user's approval. Only when the user asks you to; a project never approves tasks addressed to itself.",
    inputSchema: {
      thread_id: threadId,
      decision: z.enum(["approve", "decline"]).default("approve"),
      note: z.string().optional(),
    },
  },
  wrap((a) => json(mailbox.approve(a.thread_id, a.decision, a.note))),
);

tools.threads = server.registerTool(
  "threads",
  {
    description: "Threads of me (or of `agent`) by status.",
    inputSchema: { status: z.enum([...STATUSES, "all"]).default("open"), agent: z.string().optional() },
  },
  wrap((a) => json(mailbox.threads(a.status, a.agent))),
);

await server.connect(new StdioServerTransport());
