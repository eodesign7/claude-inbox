# inbox-bar

A Claude Code mod (terminal and the Code tab of the desktop app): one line above the prompt with the
[claude-inbox](../../README.md) mail status of the project the session runs in.

```
📬 api · 1 nové · 2 na tebe · 1 čaká · 2 sessions · „Test pošty“
```

(The labels are Slovak for now: *nové* = new, *na tebe* = waiting for you, *čaká* = waiting for the other side.)

- The agent comes from claude-inbox's `resolveAgent(cwd)`; the data comes from `claude-inbox status --json`
  (read-only access to the inbox database). The mod has no logic of its own: it uses the same code as the status line.
- Refreshes on session start, after every turn and at least every 15 seconds.
- No identity: `📬 bez identity`; no database or no `claude-inbox` command: `📬 pošta offline`.
- Clicking the line puts the word `pošta` into the prompt.

## Requirements

claude-inbox installed (`npm run setup` in the repository root). The mod finds the command in `~/.claude/settings.json`
(the status line or hook that setup wrote), otherwise it uses `claude-inbox` from the PATH.

## Install

`npm run setup` installs it. By hand:

```bash
claude plugin marketplace add /path/to/claude-inbox
claude plugin install inbox-bar@claude-inbox --scope user
```

## Development

```bash
claude plugin validate mod/inbox-bar
claude plugin test mod/inbox-bar
```

Claude Code writes its type declarations next to the mod (`.claude-plugin/types/`, git-ignored) the first time it loads it;
after that `tsc -p mod/inbox-bar` type-checks the mod.
