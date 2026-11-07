import { PassThrough } from 'stream'
import { getTerminalPrompt, isYes, terminalPrompt } from './terminal-prompt'

function terminal() {
  const input = new PassThrough()
  const output = new PassThrough()
  let written = ''
  output.on('data', (chunk) => (written += chunk.toString()))
  return { input, output, written: () => written }
}

describe('terminalPrompt', () => {
  it('asks and answers the line typed', async () => {
    const t = terminal()
    const answer = terminalPrompt(t.input, t.output, new AbortController().signal)('go on? [y/N] ')
    t.input.write('yes\n')
    expect(await answer).toBe('yes')
    expect(t.written()).toBe('go on? [y/N] ')
  })

  it('answers nothing when the input ends or the command is stopped, and ends the line', async () => {
    const ended = terminal()
    const first = terminalPrompt(ended.input, ended.output, new AbortController().signal)('go on? ')
    ended.input.end()
    expect(await first).toBeUndefined()
    expect(ended.written()).toBe('go on? \n')

    const stopped = terminal()
    const abort = new AbortController()
    const second = terminalPrompt(stopped.input, stopped.output, abort.signal)('go on? ')
    abort.abort()
    expect(await second).toBeUndefined()

    // stopped before it asks: it asks nothing
    const late = terminal()
    expect(await terminalPrompt(late.input, late.output, abort.signal)('go on? ')).toBeUndefined()
    expect(late.written()).toBe('')
  })
})

describe('getTerminalPrompt', () => {
  it('asks nothing in CI or without a terminal', () => {
    const signal = new AbortController().signal
    // vitest runs without a terminal on stdin
    expect(getTerminalPrompt({}, signal)).toBeUndefined()
    const tty = [process.stdin.isTTY, process.stdout.isTTY]
    try {
      process.stdin.isTTY = true
      process.stdout.isTTY = true
      expect(getTerminalPrompt({}, signal)).toBeDefined()
      expect(getTerminalPrompt({ CI: 'false' }, signal)).toBeDefined()
      expect(getTerminalPrompt({ CI: 'true' }, signal)).toBeUndefined()
      expect(getTerminalPrompt({ CI: '1' }, signal)).toBeUndefined()
    } finally {
      process.stdin.isTTY = tty[0] as true
      process.stdout.isTTY = tty[1] as true
    }
  })
})

describe('isYes', () => {
  it('takes y and yes in any case, nothing else', () => {
    for (const answer of ['y', 'Y', 'yes', 'YES', ' y ']) {
      expect(isYes(answer)).toBe(true)
    }
    for (const answer of [undefined, '', 'n', 'no', 'yep', 'y y']) {
      expect(isYes(answer)).toBe(false)
    }
  })
})
