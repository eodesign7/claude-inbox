import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'inbox-bar',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const MODEL = {
  kind: 'ok',
  agent: 'api',
  plain: '📬 api · 1 nové · 2 na tebe · 2 sessions · „Test pošty“',
  segments: [
    { t: '📬 api' },
    { t: ' · ' },
    { t: '1 nové', s: 'hi' },
    { t: ' · ' },
    { t: '2 na tebe' },
    { t: ' · ' },
    { t: '2 sessions' },
    { t: ' · ' },
    { t: '„Test pošty“', s: 'dim' },
  ],
}

const OK = {
  exitCode: 0,
  stdout: JSON.stringify(MODEL),
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
}

test('the band shows the status of claude-inbox and a press fills the prompt, on every surface', async ($, on) => {
  const clock = mock.clock(on)
  const calls: string[][] = []
  const fills: string[] = []

  on('settings.read', () => ({
    value: { statusLine: { type: 'command', command: '"/n/node" "/p/dist/claude-inbox.js"' } },
  }))
  on('process.run', (_, e) => {
    calls.push([...e.argv])

    return { value: OK }
  })
  on('prompt.fill', (_, e) => {
    fills.push(e.text)

    return { isFilled: true, cursor: e.text.length }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/work/api', surface: 'desktop', isInteractive: true })
  await clock.settle()

  expect(calls[0]).toEqual(['/n/node', '/p/dist/claude-inbox.js', 'status', '--json'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ type: 'Button' }))?.text).toContain('2 na tebe')
    expect((await ui.find({ type: 'Text', text: /1 nové/ }))?.text).toBe('1 nové')
    await ui.press({ key: 'mail' })
    await ui.unmount()
  }

  expect(fills).toEqual(['pošta', 'pošta'])
})

test('without the command the band says the mail is offline', async ($, on) => {
  const clock = mock.clock(on)
  on('settings.read', () => ({ value: {} }))
  on('process.run', () => {
    throw new Error('claude-inbox: command not found')
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Button' }))?.text).toContain('pošta offline')
  await ui.unmount()
})

test('a survey holds the band', async ($, on) => {
  const clock = mock.clock(on)
  on('settings.read', () => ({ value: {} }))
  on('process.run', () => ({ value: OK }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // Nothing draws beneath the plugin: this hook stands for the engine's survey.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>survey</Text>
  })

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true }, surface: 'desktop' })

  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /survey/ }))?.text).toBe('survey')
  await ui.unmount()
})

test('the status is read again every 15 seconds and after a turn', async ($, on) => {
  const clock = mock.clock(on)
  let reads = 0

  on('settings.read', () => ({ value: {} }))
  on('process.run', () => {
    reads += 1

    return { value: OK }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(reads).toBe(1)

  await clock.advance(15_000)
  expect(reads).toBe(2)

  await clock.advance(30_000)
  expect(reads).toBe(4)
})
