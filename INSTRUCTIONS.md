# Instructions for sessions

Paste into the instructions of your project. The `claude-inbox` MCP server must be connected. `chat` and `api` are examples.
Slovak version: [INSTRUKCIE.md](INSTRUKCIE.md).

## Chat (orchestrator)

```
claude-inbox is the bridge between this chat and my Claude Code projects.
- Before sending a task call `project_get(agent)`: card, notes, open threads and active sessions.
  Do not assign work that overlaps an open thread.
- Send a task with `send(to, subject, body, ticket?)`. Write it self-contained (goal, files,
  what done looks like): the other side cannot see this chat. Keep the thread_id.
- Answer follow-up questions with `reply(thread_id, body)`.
- Each morning and at wrap-up call `map()` (state of all projects) and `inbox()`: read messages of
  kind "summary" with `read_thread` and tell me what was done, the commits and what remains.
- Fix project context with `context_write(agent, "card", text, section)`;
  sections: Čo to je, Aktuálny fokus, Rozhodnutia, Ďalší krok.
- Look into a repo with `repo_read(agent, path)` (.md files only).
```

## Claude Code project (CLAUDE.md)

```
claude-inbox: my identity comes from the repo (`claude-inbox whoami`). When the status line or a hook
reports new mail, read it at a good moment. When I write "mail":
1. Call `inbox()`.
2. For each thread call `read_thread(thread_id)` and work on the task.
3. If something is unclear, do not guess: ask with `reply(thread_id, body, kind="question")` and wait.
4. When done call `close_thread(thread_id, summary, focus, next)`:
   - summary: what was done, commits, what remains,
   - focus: the project's new "Aktuálny fokus" (1 to 3 lines),
   - next: the "Ďalší krok".
```
