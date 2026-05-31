import { Writable } from 'stream'
import {
  consoleContext,
  formatDate,
  getErrorMessage,
  getLogLevel,
  getLogs,
  getMaxNameLength,
  getNodeName,
  getType,
  hideCursor,
  printItem,
  printProperty,
  printTitle,
  showCursor,
} from './log'
import { environmentMock } from './executer/environment-mock'

function capture(): { stream: Writable; read(): string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString())
      cb()
    },
  })
  return { stream, read: () => chunks.join('') }
}

describe('log helpers', () => {
  describe('getLogs', () => {
    it('splits on \\r?\\n and drops empty lines', () => {
      expect(getLogs('a\r\nb\nc\n\n')).toEqual(['a', 'b', 'c'])
    })

    it('accepts a Buffer', () => {
      expect(getLogs(Buffer.from('x\ny'))).toEqual(['x', 'y'])
    })
  })

  describe('getLogLevel', () => {
    it.each(['debug', 'info', 'warn', 'error'] as const)('returns a string containing %s', (level) => {
      expect(getLogLevel(level)).toContain(level)
    })
  })

  describe('getErrorMessage', () => {
    it('uses Error.message for Error instances', () => {
      expect(getErrorMessage(new Error('boom'))).toBe('boom')
    })

    it('returns a string value unchanged', () => {
      expect(getErrorMessage('plain')).toBe('plain')
    })

    it('falls back to "unknown error <value>" for other values', () => {
      expect(getErrorMessage({ x: 1 })).toMatch(/^unknown error/)
    })
  })

  describe('consoleContext', () => {
    it('writes formatted lines for each level', () => {
      const cap = capture()
      const ctx = consoleContext(cap.stream)
      ctx.debug('d-msg')
      ctx.info('i-msg')
      ctx.warn('w-msg')
      ctx.error('e-msg')
      const out = cap.read()
      expect(out).toContain('d-msg')
      expect(out).toContain('i-msg')
      expect(out).toContain('w-msg')
      expect(out).toContain('e-msg')
      // 4 newlines, one per call
      expect(out.split('\n').filter((l) => l.length > 0)).toHaveLength(4)
    })
  })

  describe('getType / getNodeName / getMaxNameLength', () => {
    it('formats the type with the configured padding', () => {
      expect(getType('cli')).toContain('cli')
    })

    it('pads name to a given length', () => {
      expect(getNodeName('a', 4)).toContain('a')
      // pads with spaces to reach the requested length, then color codes
      // surround it — assert by inspecting the visible characters
      // ANSI color wrappers can only add chars, so the rendered string is at
      // least the requested width even when colors are enabled.
      expect(getNodeName('a', 4).length).toBeGreaterThanOrEqual(4)
    })

    it('getMaxNameLength returns the longest name yielded', () => {
      const names = function* () {
        yield 'aa'
        yield 'aaaaa'
        yield 'a'
      }
      expect(getMaxNameLength(names)).toBe(5)
    })

    it('getMaxNameLength returns 0 for an empty source', () => {
      expect(getMaxNameLength(() => [])).toBe(0)
    })
  })

  describe('print helpers', () => {
    it('printItem with and without description', () => {
      const env = environmentMock('/tmp')
      const cap = capture()
      env.stdout = cap.stream
      printItem(env, { name: 'a', description: null })
      printItem(env, { name: 'b', description: 'desc' })
      const out = cap.read()
      expect(out).toContain('• a\n')
      expect(out).toContain('• b')
      expect(out).toContain('desc')
    })

    it('printProperty writes "<name>: <value>"', () => {
      const env = environmentMock('/tmp')
      const cap = capture()
      env.stdout = cap.stream
      printProperty(env, 'image', 'alpine')
      expect(cap.read()).toContain('image:')
      expect(cap.read()).toContain('alpine')
    })

    it('printTitle writes the title with a colon', () => {
      const env = environmentMock('/tmp')
      const cap = capture()
      env.stdout = cap.stream
      printTitle(env, 'Tasks')
      expect(cap.read()).toContain('Tasks:')
    })
  })

  describe('formatDate', () => {
    it('produces a [yyyy-MM-DD HH:mm:ss.SSS] formatted timestamp', () => {
      // Use a fixed Date in UTC; the function uses local-time getters, so only
      // pattern-check the output rather than the literal value.
      const out = formatDate(new Date(2024, 0, 2, 3, 4, 5, 6))
      expect(out).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]/)
    })
  })

  describe('cursor', () => {
    it('hideCursor / showCursor write escape sequences', () => {
      const env = environmentMock('/tmp')
      const cap = capture()
      env.stdout = cap.stream
      hideCursor(env)
      showCursor(env)
      const out = cap.read()
      expect(out).toContain('\x1B[?25l')
      expect(out).toContain('\x1B[?25h')
    })
  })
})
