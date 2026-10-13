import { LogIndex, parseLogQuery, readLogs } from './run-logs'
import type { StoredEvent } from './runs'

let seq = 0
function log(task: string, text: string, stream: 'stdout' | 'stderr' = 'stdout'): StoredEvent {
  return { type: 'log', task, stream, text, seq: ++seq, time: '2026-10-12T00:00:00.000Z' }
}

const query = (search: string) => parseLogQuery(new URLSearchParams(search))

// build prints two lines, test five: two of them in one event, one ending in \r\n
const events: StoredEvent[] = [
  log('hammerkit', 'checked out github.com/corp/payments at abc'),
  { type: 'task', task: 'build', state: 'running', seq: ++seq, time: '2026-10-12T00:00:00.000Z' },
  log('build', 'compiling'),
  log('test', 'PASS a.spec.ts'),
  log('build', 'done'),
  log('test', 'FAIL b.spec.ts\r\n  expected 1 to be 2\n'),
  log('test', 'at b.spec.ts:3', 'stderr'),
  log('test', 'Tests: 1 failed, 1 passed'),
]

function read(search: string, truncated = false) {
  const index = new LogIndex()
  index.update(events)
  return readLogs(events, index, query(search), truncated)
}

describe('readLogs', () => {
  it('numbers the lines of the task asked for, an event of several lines as several', () => {
    const page = read('task=test')
    expect(page.total).toBe(5)
    expect(page.lines).toEqual([
      { line: 1, task: 'test', stream: 'stdout', text: 'PASS a.spec.ts' },
      { line: 2, task: 'test', stream: 'stdout', text: 'FAIL b.spec.ts' },
      { line: 3, task: 'test', stream: 'stdout', text: '  expected 1 to be 2' },
      { line: 4, task: 'test', stream: 'stderr', text: 'at b.spec.ts:3' },
      { line: 5, task: 'test', stream: 'stdout', text: 'Tests: 1 failed, 1 passed' },
    ])
    expect(page.next).toBeUndefined()
    expect(read('').total).toBe(8)
    expect(read('task=build', true)).toMatchObject({ total: 2, truncated: true })
    expect(read('task=nothing')).toEqual({ lines: [], total: 0, truncated: false })
  })

  it('reads the end, or a range that says where to go on', () => {
    expect(read('task=test&tail=2').lines.map((l) => l.line)).toEqual([4, 5])
    expect(read('task=test&tail=4&limit=1').lines.map((l) => l.line)).toEqual([5])
    const first = read('task=test&limit=2')
    expect(first.lines.map((l) => l.line)).toEqual([1, 2])
    expect(first.next).toBe(3)
    const second = read(`task=test&limit=2&from=${first.next}`)
    expect(second.lines.map((l) => l.line)).toEqual([3, 4])
    expect(read('task=test&from=5').lines.map((l) => l.line)).toEqual([5])
    expect(read('task=test&from=9').lines).toEqual([])
  })

  it('reads as many lines as the tail asks for, past the default page', () => {
    const many = Array.from({ length: 1500 }, (_, i) => log('long', `line ${i + 1}`))
    const index = new LogIndex()
    index.update(many)
    const page = readLogs(many, index, query('tail=1000'), false)
    expect(page.lines).toHaveLength(1000)
    expect(page.lines[0]).toMatchObject({ line: 501, text: 'line 501' })
  })

  it('finds a fixed string with the lines around it, a regular expression is just text', () => {
    expect(read('task=test&grep=FAIL&context=1').lines.map((l) => [l.line, l.match])).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ])
    expect(read('grep=fail&i=true').lines.map((l) => l.text)).toEqual(['FAIL b.spec.ts', 'Tests: 1 failed, 1 passed'])
    expect(read('grep=fail').lines.map((l) => l.text)).toEqual(['Tests: 1 failed, 1 passed'])
    expect(read('grep=(a%2B)%2B$').lines).toEqual([])
    expect(read('grep=.spec').lines.map((l) => l.line)).toEqual([3, 5, 7])
    // the last match only
    expect(read('grep=spec&tail=1').lines.map((l) => l.line)).toEqual([7])
    expect(read('task=test&grep=spec&tail=2&context=1').lines.map((l) => [l.line, l.match])).toEqual([
      [4, true],
      [5, false],
    ])
  })

  it('pages through matches, with the lines after a match on the page before', () => {
    const page = read('task=test&grep=spec&context=1&limit=2')
    expect(page.lines.map((l) => l.line)).toEqual([1, 2])
    expect(page.next).toBe(3)
    expect(read(`task=test&grep=spec&context=1&limit=2&from=${page.next}`).lines.map((l) => l.line)).toEqual([3, 4])
    expect(read('task=test&grep=spec&from=3').lines.map((l) => l.line)).toEqual([4])
  })

  it('looks only at the events added since the last read', () => {
    const growing: StoredEvent[] = [log('build', 'one')]
    const index = new LogIndex()
    index.update(growing)
    expect(readLogs(growing, index, query(''), false).total).toBe(1)
    growing.push(log('build', 'two\nthree'))
    index.update(growing)
    expect(readLogs(growing, index, query('tail=2'), false).lines.map((l) => l.text)).toEqual(['two', 'three'])
  })

  it('reads a log of a million lines without copying it', () => {
    const big = Array.from({ length: 128 }, () => log('build', 'a\n'.repeat(4096)))
    big.push(log('build', 'the error'))
    const index = new LogIndex()
    index.update(big)
    const started = Date.now()
    for (let i = 0; i < 20; i++) {
      expect(readLogs(big, index, query('tail=1'), false).lines[0].text).toBe('the error')
      expect(readLogs(big, index, query('grep=error&tail=1'), false).lines[0].line).toBe(128 * 4096 + 1)
    }
    // a whole scan of the log per read used to take hundreds of milliseconds
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe('parseLogQuery', () => {
  it('takes the parameters of the log with their defaults', () => {
    expect(query('')).toEqual({ limit: 200, ignoreCase: false, context: 0 })
    expect(query('task=a&tail=5&grep=x&i=1&context=3&limit=10')).toEqual({
      task: 'a',
      tail: 5,
      limit: 10,
      grep: 'x',
      ignoreCase: true,
      context: 3,
    })
    expect(query('tail=500').limit).toBe(500)
  })

  it('says what is wrong with a query', () => {
    expect(() => query('tail=0')).toThrow('tail is a number from 1 to 1000')
    expect(() => query('limit=1001')).toThrow('limit is a number from 1 to 1000')
    expect(() => query('from=-1')).toThrow('from is a number')
    expect(() => query('context=21')).toThrow('context is a number from 0 to 20')
    expect(() => query('tail=1&from=1')).toThrow('tail and from do not go together')
    expect(() => query('grep=')).toThrow('grep is a text of 1 to 200 characters on one line')
    expect(() => query(`grep=${'x'.repeat(201)}`)).toThrow('grep is a text')
    expect(() => query('grep=a%0Ab')).toThrow('grep is a text')
    expect(() => query('i=yes')).toThrow('i is true or false')
    expect(() => query('tail=1&tail=2')).toThrow('tail is given more than once')
    expect(() => query('task=a&task=b')).toThrow('task is given more than once')
    expect(() => query('lines=5')).toThrow('there is no parameter lines')
  })
})
