# claude-inbox

**EN** · [SK](#slovensky)

A local inbox that lets **Claude chat** and **Claude Code** sessions (desktop app and terminal) exchange tasks,
tickets and project context. One person, one machine, no network.

- **Threads and tickets.** The chat sends a task to a project, Claude Code asks questions, the chat answers, Claude Code
  closes the thread with a summary.
- **Project map.** Every project has a markdown *card* (what it is, current focus, decisions, next step) that you can edit
  in any editor. Chat and Code read it before they work.
- **Sessions.** See which Claude Code sessions are active in which project and branch.
- **Status line + band.** Every Code session shows `📬 api · 1 new · 2 on you · 1 waiting · 2 sessions` for its own project.

## Install

Requirements: Node 22+, Claude desktop and/or Claude Code.

```bash
git clone https://github.com/eodesign7/claude-inbox.git
cd claude-inbox
npm install
npm run setup -- --chat-agent=chat --wait
```

`--wait` makes setup wait until you quit the Claude desktop app (it keeps its own copy of its config and would overwrite
ours). Quit it (Cmd+Q on macOS) when asked, then start it again. Setup makes a backup (`*.bak-<time>`) before every write and
keeps your existing settings:

1. builds the project,
2. adds the `claude-inbox` MCP server to the Claude desktop config (macOS, Linux, Windows) with
   `CLAUDE_INBOX_AGENT=<chat-agent>` (default `chat`),
3. registers the server in Claude Code (scope user, no fixed identity) and installs the `inbox-bar` mod,
4. sets `statusLine` and the `SessionStart` / `UserPromptSubmit` / `SessionEnd` hooks in `~/.claude/settings.json`
   (an existing `statusLine` is replaced and printed),
5. links the `claude-inbox` command globally and verifies the desktop config (`desktop config OK`).

The band above the prompt (`inbox-bar`) is installed by setup. To install only the mod from GitHub, in the Claude Code CLI:
`claude plugin install inbox-bar --marketplace eodesign7/claude-inbox`.

Then, in every repository:

```bash
claude-inbox link <agent>     # creates the project card and ties this repo to it
```

Instruction blocks to paste into your chat project and your Claude Code projects are in
[INSTRUCTIONS.md](INSTRUCTIONS.md).

## How identity works

An MCP server shared by chat and Code must know *who is talking*:

- **Claude Code session** (detected by `CLAUDECODE=1`, which Claude Code sets for its child processes): card `paths`
  (longest prefix wins) → git repository name → folder name → `default`. `CLAUDE_INBOX_AGENT` is ignored.
- **Chat**: `CLAUDE_INBOX_AGENT`, then the same chain.

`claude-inbox whoami` prints the identity and where it came from. The server also prints
`cwd / agent / source / environment` to stderr on start.

## MCP tools

| tool | what it does |
|---|---|
| `map()` | all projects: focus, open threads, active sessions, last summary |
| `project_get(agent)` | card, notes, open threads, active sessions, last 3 summaries |
| `context_write(agent, file, text, section?)` | write the card (`"card"`) or a note; with `section` only that section; frontmatter is never changed |
| `repo_read(agent, path)` | read-only access to `.md` files inside the project's `paths` |
| `send(to, subject, body, kind?, ticket?)` | new thread |
| `reply(thread_id, body, kind?, to?)` | reply in a thread |
| `inbox(unread_only?)` | my messages |
| `read_thread(thread_id)` | whole thread, marks it read |
| `close_thread(thread_id, summary, focus?, next?)` | closes, sends the summary, appends the daily log, rewrites card sections |
| `threads(status?, agent?)` | threads by status |

## Files

```
~/.claude-inbox/
  inbox.db                        machine state: threads, messages, sessions
  projects/<agent>/card.md        project card (YAML frontmatter: name, paths, ticket_prefix)
  projects/<agent>/notes/*.md     free notes
  log/YYYY-MM-DD.md               daily log of summaries
```

Context lives in the markdown files (source of truth); SQLite holds only machine state.

## CLI

```bash
claude-inbox map                  # overview of projects
claude-inbox show <thread_id>     # a whole thread
claude-inbox card <agent>         # open the card in $EDITOR
claude-inbox log [YYYY-MM-DD]     # daily log
claude-inbox link <agent>         # card from template + this repo's path
claude-inbox whoami               # who am I here and why
claude-inbox send <to> "text" --as <agent>
```

## Troubleshooting

- **The server is missing in the desktop app.** The app overwrites its config while running. Run
  `npm run setup -- --wait`, quit the app when asked. `npm run check` verifies the config and the handshake.
- **`claude` not found during setup.** Setup also looks inside the desktop app's bundle; otherwise it prints the commands to
  run by hand.
- **A Code session writes as the wrong agent.** Run `claude-inbox whoami` in the repo and check the stderr line in
  `~/Library/Logs/Claude/mcp-server-claude-inbox.log` (macOS). The desktop app also hands its own MCP servers to Code
  sessions; the chat instance tells the model not to use it from Code.

Status line labels are Slovak for now (*nové* = new, *na tebe* = waiting for you, *čaká* = waiting). Localization is welcome.

## Development

```bash
npm test             # vitest, temporary database and configs; never touches your real ones
npm run test:mod     # tests of the inbox-bar mod (needs the `claude` CLI)
npm run build
```

MIT license.

---

## Slovensky

Lokálna schránka správ medzi **Claude chatom** a **Claude Code** (desktop appka aj terminál): úlohy, tickety a kontext
projektov. Jeden používateľ, jeden počítač, bez siete.

**Inštalácia** (Node 22+):

```bash
git clone https://github.com/eodesign7/claude-inbox.git
cd claude-inbox
npm install
npm run setup -- --chat-agent=chat --wait
```

`--wait` počká, kým ukončíš Claude desktop (Cmd+Q). Appka si drží vlastnú kópiu configu a pri ukladaní by náš zápis prepísala.
Setup pred každým zápisom urobí zálohu a zachová ostatné nastavenia. Potom appku spusti a v každom repe:

```bash
claude-inbox link <agent>
```

- **Identita:** v Code session sa `CLAUDE_INBOX_AGENT` ignoruje; platí karta podľa `paths`, názov git repa, názov priečinka,
  `default`. V chate platí `CLAUDE_INBOX_AGENT`. Zistíš ju cez `claude-inbox whoami`.
- **Kontext** je v markdowne `~/.claude-inbox/projects/<agent>/card.md` (sekcie *Čo to je, Aktuálny fokus, Rozhodnutia,
  Ďalší krok*), upravíš ho v editore: `claude-inbox card <agent>`.
- **Nástroje, súbory a CLI** sú rovnaké ako v anglickej časti vyššie. Bloky inštrukcií pre chat a Claude Code sú v
  [INSTRUKCIE.md](INSTRUKCIE.md).
- **Riešenie problémov:** server v appke chýba → `npm run setup -- --wait` a ukonči appku; `npm run check` overí config.
