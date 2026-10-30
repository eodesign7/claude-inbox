import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pending, Seg, Status } from '../types'

const status = atom({ plugin: 'inbox-bar', key: 'status' } as const, null)

const REFRESH_MS = 15_000
const OFFLINE: Status = {
  segments: [{ t: '📬 pošta offline' }],
  plain: '📬 pošta offline',
  pending: [],
}

// Stav modulu; po reloade začína odznova.
const run = {
  cwd: '',
  command: undefined as string[] | undefined,
  timer: undefined as { cancel: () => void } | undefined,
}

/** Rozdelí príkaz na argumenty (úvodzovky držia medzery v cestách). */
function split(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3] ?? '')
}

/** Príkaz `claude-inbox` až po jeho skript: z nastavení (statusLine alebo hook, ktoré zapísal setup). */
function fromSettings(settings: unknown): string[] | undefined {
  const s = settings as
    | {
        statusLine?: { command?: string }
        hooks?: Record<string, { hooks?: { command?: string }[] }[]>
      }
    | undefined
  const commands = [
    s?.statusLine?.command,
    ...Object.values(s?.hooks ?? {}).flatMap(groups =>
      groups.flatMap(g => (g.hooks ?? []).map(h => h.command)),
    ),
  ]

  for (const command of commands) {
    if (!command?.includes('claude-inbox')) continue

    const argv = split(command)
    const at = argv.findIndex(a => a.includes('claude-inbox'))

    if (at >= 0) return argv.slice(0, at + 1)
  }

  return undefined
}

/** Spustí `claude-inbox status --json` (ten istý kód ako status line) a uloží výsledok. */
async function refresh($: EngineInterface) {
  try {
    run.command ??= fromSettings(await $.settings.read()) ?? ['claude-inbox']

    const result = await $.process.run([...run.command, 'status', '--json'], {
      cwd: run.cwd || undefined,
      stdin: JSON.stringify({ workspace: { current_dir: run.cwd } }),
      timeoutMs: 5000,
    })
    const model = JSON.parse(result.stdout) as { segments?: Seg[]; plain?: string; pending?: Pending[] }

    if (result.exitCode !== 0 || !model.segments || !model.plain) {
      throw new Error('claude-inbox answered without a status')
    }

    const next: Status = { segments: model.segments, plain: model.plain, pending: model.pending ?? [] }

    await update($, status, () => next)
  } catch {
    run.command = undefined // príkaz sa mohol presunúť: nabudúce znova z nastavení
    await update($, status, () => OFFLINE)
  }
}

/** Approves or declines a task with the same command the CLI uses, then redraws. */
async function decide($: EngineInterface, verb: 'approve' | 'decline', id: number) {
  try {
    run.command ??= fromSettings(await $.settings.read()) ?? ['claude-inbox']
    await $.process.run([...run.command, verb, String(id)], { cwd: run.cwd || undefined, timeoutMs: 10_000 })
    $.ui.toast(verb === 'approve' ? `Task #${id} approved` : `Task #${id} declined`)
  } catch {
    $.ui.toast(`Could not ${verb} task #${id}`)
  }

  await refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    run.cwd = e.cwd
    void refresh($)
    run.timer?.cancel()
    run.timer = $.clock.every(REFRESH_MS, () => {
      void refresh($)
    })

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    void refresh($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const current = await read($, status)

    if (current === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)

    const line = (
      <Button
        key="mail"
        label={current.plain}
        onPress={() => {
          void $.prompt.fill({ text: 'pošta', mode: 'insert' })
        }}
      >
        {current.segments.map(seg =>
          seg.s === 'hi' ? (
            <Text bold color="yellow">
              {seg.t}
            </Text>
          ) : seg.s === 'dim' ? (
            <Text dimColor>{seg.t}</Text>
          ) : (
            <Text>{seg.t}</Text>
          ),
        )}
      </Button>
    )

    if (current.pending.length === 0) return line

    return (
      <Box flexDirection="column">
        {line}
        {current.pending.slice(0, 3).map(p => (
          <Box key={`pending-${p.id}`}>
            <Text>
              {'📥 '}#{p.id} {p.from} → {p.to}: „{p.subject}“{'  '}
            </Text>
            <Button
              key={`approve-${p.id}`}
              label="Approve"
              onPress={() => {
                void decide($, 'approve', p.id)
              }}
            />
            <Text> </Text>
            <Button
              key={`decline-${p.id}`}
              label="Decline"
              onPress={() => {
                void decide($, 'decline', p.id)
              }}
            />
          </Box>
        ))}
      </Box>
    )
  })
}
