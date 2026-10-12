import { parseLogQuery, readLogs } from './run-logs'
import type { StoredEvent } from './runs'

type LogEvent = Extract<StoredEvent, { type: 'log' }>

let seq = 0
function log(task: string, text: string, stream: 'stdout' | 'stderr' = 'stdout'): LogEvent {
  return { type: 'log', task, stream, text, seq: ++seq, time: '2026-10-12T00:00:00.000Z' }
}

const query = (search: string) => parseLogQuery(new URLSearchParams(search))

// build prints three lines, test five: one of them in an event of two lines
const events = [
  log('hammerkit', 'checked out github.com/corp/payments at abc'),
  log('build', 'compiling'),
  log('test', 'PASS a.spec.ts'),
  log('build', 'done'),
  log('test', 'FAIL b.spec.ts\n  expected 1 to be 2\n'),
  log('test', 'at b.spec.ts:3', 'stderr'),
  log('test', 'Tests: 1 failed, 1 passed'),
]

describe('readLogs', () => {
  it('numbers the lines of the tasks asked for, an event of several lines as several', () => {
    const page = readLogs(events, query('task=test'), false)
    expect(page.total).toBe(5)
    expect(page.lines).toEqual([
      { line: 1, task: 'test', stream: 'stdout', text: 'PASS a.spec.ts' },
      { line: 2, task: 'test', stream: 'stdout', text: 'FAIL b.spec.ts' },
      { line: 3, task: 'test', stream: 'stdout', text: '  expected 1 to be 2' },
      { line: 4, task: 'test', stream: 'stderr', text: 'at b.spec.ts:3' },
      { line: 5, task: 'test', stream: 'stdout', text: 'Tests: 1 failed, 1 passed' },
    ])
    expect(page.next).toBeUndefined()
    expect(readLogs(events, query(''), false).total).toBe(8)
    expect(readLogs(events, query('task=build&task=hammerkit'), true)).toMatchObject({ total: 3, truncated: true })
  })

  it('reads the end, or a range that says where to go on', () => {
    expect(readLogs(events, query('task=test&tail=2'), false).lines.map((l) => l.line)).toEqual([4, 5])
    const first = readLogs(events, query('task=test&limit=2'), false)
    expect(first.lines.map((l) => l.line)).toEqual([1, 2])
    expect(first.next).toBe(3)
    const second = readLogs(events, query(`task=test&limit=2&from=${first.next}`), false)
    expect(second.lines.map((l) => l.line)).toEqual([3, 4])
    expect(readLogs(events, query('task=test&from=5'), false).lines.map((l) => l.line)).toEqual([5])
    expect(readLogs(events, query('task=test&from=9'), false).lines).toEqual([])
  })

  it('finds a fixed string with the lines around it, a regular expression is just text', () => {
    const page = readLogs(events, query('task=test&grep=FAIL&context=1'), false)
    expect(page.matches).toBe(1)
    expect(page.lines.map((l) => [l.line, l.match])).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ])
    expect(readLogs(events, query('grep=fail&i=true'), false).lines.map((l) => l.text)).toEqual([
      'FAIL b.spec.ts',
      'Tests: 1 failed, 1 passed',
    ])
    expect(readLogs(events, query('grep=fail'), false).lines.map((l) => l.text)).toEqual(['Tests: 1 failed, 1 passed'])
    expect(readLogs(events, query('grep=(a%2B)%2B$'), false)).toMatchObject({ matches: 0, lines: [] })
    // the last match only
    expect(readLogs(events, query('grep=spec&tail=1'), false).lines.map((l) => l.line)).toEqual([7])
  })
})

describe('parseLogQuery', () => {
  it('takes the parameters of the log with their defaults', () => {
    expect(query('')).toEqual({ tasks: [], limit: 200, ignoreCase: false, context: 0 })
    expect(query('task=a&task=b&tail=5&grep=x&i=1&context=3&limit=10')).toEqual({
      tasks: ['a', 'b'],
      tail: 5,
      limit: 10,
      grep: 'x',
      ignoreCase: true,
      context: 3,
    })
  })

  it('says what is wrong with a query', () => {
    expect(() => query('tail=0')).toThrow('tail is a number from 1 to 1000')
    expect(() => query('limit=1001')).toThrow('limit is a number from 1 to 1000')
    expect(() => query('from=-1')).toThrow('from is a number')
    expect(() => query('context=21')).toThrow('context is a number from 0 to 20')
    expect(() => query('tail=1&from=1')).toThrow('tail and from do not go together')
    expect(() => query('grep=')).toThrow('grep is a text of 1 to 200 characters')
    expect(() => query(`grep=${'x'.repeat(201)}`)).toThrow('grep is a text')
    expect(() => query('i=yes')).toThrow('i is true or false')
    expect(() => query('tail=1&tail=2')).toThrow('tail is given more than once')
    expect(() => query('lines=5')).toThrow('there is no parameter lines')
  })
})
