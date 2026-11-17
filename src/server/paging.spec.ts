import {
  countValues,
  ListParamError,
  MAX_LIMIT,
  newestFirst,
  pageByKey,
  pageByPosition,
  parsePage,
  parseValues,
  readList,
} from './paging'
import { parseTaskOrder, sortTasks } from './task-order'
import type { TaskStats } from './timings'

const params = (query: string) => new URLSearchParams(query)

interface Item {
  id: string
  at: string
}

const key = (item: Item): [string, string] => [item.at, item.id]

// every page of a list, one after the other, as a client follows `next`
function follow<T>(items: T[], limit: number, page: (cursor?: string) => { items: T[]; next?: string }): T[][] {
  const pages: T[][] = []
  let cursor: string | undefined
  do {
    const answered = page(cursor)
    pages.push(answered.items)
    cursor = answered.next
  } while (cursor && pages.length <= items.length / limit + 1)
  return pages
}

describe('pages of a list', () => {
  it('pages only when the caller names a limit', () => {
    expect(parsePage(params(''))).toBeUndefined()
    expect(parsePage(params('limit=20'))).toEqual({ limit: 20 })
    expect(parsePage(params('limit=20&cursor=abc'))).toEqual({ limit: 20, cursor: 'abc' })
    expect(parsePage(params(''), 50)).toEqual({ limit: 50 })
    expect(() => parsePage(params('cursor=abc'))).toThrow('cursor: only with limit')
    for (const limit of ['0', '-1', 'ten', String(MAX_LIMIT + 1), '1.5']) {
      expect(() => parsePage(params(`limit=${limit}`))).toThrow(ListParamError)
    }
  })

  it('answers the newest first, each once, until no more remain', () => {
    const items: Item[] = [
      { id: 'a', at: '2026-11-01T00:00:00.000Z' },
      { id: 'c', at: '2026-11-03T00:00:00.000Z' },
      // two of the same moment: by their id
      { id: 'b2', at: '2026-11-02T00:00:00.000Z' },
      { id: 'b1', at: '2026-11-02T00:00:00.000Z' },
      { id: 'd', at: '2026-11-04T00:00:00.000Z' },
    ]
    const sorted = newestFirst(items, key)
    expect(sorted.map((item) => item.id)).toEqual(['d', 'c', 'b2', 'b1', 'a'])
    const pages = follow(sorted, 2, (cursor) => pageByKey(sorted, { limit: 2, ...(cursor ? { cursor } : {}) }, key))
    expect(pages.map((page) => page.map((item) => item.id))).toEqual([['d', 'c'], ['b2', 'b1'], ['a']])
    expect(pageByKey(sorted, { limit: 5 }, key).next).toBeUndefined()
  })

  it('goes on after the last one answered, when one was added or removed meanwhile', () => {
    const items = newestFirst(
      ['1', '2', '3', '4'].map((n) => ({ id: n, at: `2026-11-0${n}T00:00:00.000Z` })),
      key
    )
    const first = pageByKey(items, { limit: 2 }, key)
    expect(first.items.map((item) => item.id)).toEqual(['4', '3'])
    // a new one comes first: it does not repeat one
    const added = [{ id: '5', at: '2026-11-05T00:00:00.000Z' }, ...items]
    expect(pageByKey(added, { limit: 2, cursor: first.next }, key).items.map((item) => item.id)).toEqual(['2', '1'])
    // the last one answered is gone: the ones older than it
    const removed = [items[0], ...items.slice(2)]
    expect(pageByKey(removed, { limit: 2, cursor: first.next }, key).items.map((item) => item.id)).toEqual(['2', '1'])
  })

  it('keeps the order a list was kept in for those of the same time', () => {
    const same = '2026-11-01T00:00:00.000Z'
    const items = ['x', 'a', 'm'].map((id) => ({ id, at: same }))
    const first = pageByKey(items, { limit: 2 }, key)
    expect(first.items.map((item) => item.id)).toEqual(['x', 'a'])
    expect(pageByKey(items, { limit: 2, cursor: first.next }, key).items.map((item) => item.id)).toEqual(['m'])
  })

  it('refuses a cursor it did not answer', () => {
    expect(() => pageByKey([], { limit: 1, cursor: '%%%' }, key)).toThrow('cursor:')
    expect(() => pageByKey([], { limit: 1, cursor: Buffer.from('{"at":1}').toString('base64url') }, key)).toThrow(
      'cursor:'
    )
    expect(() => pageByPosition([], { limit: 1, cursor: Buffer.from('["a","b"]').toString('base64url') })).toThrow(
      'cursor:'
    )
  })

  it('pages a list in an order of its own by position', () => {
    const items = ['a', 'b', 'c']
    const first = pageByPosition(items, { limit: 2 })
    expect(first.items).toEqual(['a', 'b'])
    expect(pageByPosition(items, { limit: 2, cursor: first.next })).toEqual({ items: ['c'] })
  })

  it('reads a filter repeated', () => {
    expect(readList(params('ref=main&ref=next&ref='), 'ref')).toEqual(['main', 'next'])
    expect(readList(params(''), 'ref')).toBeUndefined()
  })
})

describe('the values of a filter', () => {
  it('reads the field, the search and a page of them', () => {
    expect(parseValues(params(''), ['repo'])).toBeUndefined()
    expect(parseValues(params('values=repo&search=%20corp%20'), ['repo'])).toEqual({
      field: 'repo',
      search: 'corp',
      page: { limit: 50 },
    })
    expect(parseValues(params('values=repo&limit=5&cursor=x'), ['repo'])?.page).toEqual({ limit: 5, cursor: 'x' })
    expect(() => parseValues(params('values=owner'), ['repo', 'ref'])).toThrow('values: one of repo, ref')
  })

  it('counts each value once per item, the most first, narrowed by the search in its value or name', () => {
    const items = [['main', 'main'], ['main'], ['next'], ['feature/a']]
    const page = { limit: 10 }
    expect(countValues(items, (item) => item, { page }).items).toEqual([
      { value: 'main', count: 2 },
      { value: 'feature/a', count: 1 },
      { value: 'next', count: 1 },
    ])
    expect(countValues(items, (item) => item, { page, search: 'EX' }).items).toEqual([{ value: 'next', count: 1 }])
    const owners = [{ sub: 'u1', name: 'Alice' }, { sub: 'u2' }]
    expect(
      countValues(owners, (owner) => [{ value: owner.sub, name: owner.name }], { page, search: 'ali' }).items
    ).toEqual([{ value: 'u1', count: 1, name: 'Alice' }])
  })

  it('keeps an order given, and pages', () => {
    const items = ['failed', 'queued', 'failed', 'running']
    const order = ['queued', 'running', 'failed']
    const first = countValues(items, (item) => [item], { page: { limit: 2 } }, order)
    expect(first.items.map((value) => value.value)).toEqual(['queued', 'running'])
    expect(countValues(items, (item) => [item], { page: { limit: 2, cursor: first.next } }, order).items).toEqual([
      { value: 'failed', count: 2 },
    ])
  })
})

describe('the order of the tasks', () => {
  const stats = (task: string, extra: Partial<TaskStats>): TaskStats => ({
    repo: 'github.com/corp/payments',
    task,
    runs: 1,
    succeeded: 1,
    failed: 0,
    cached: 0,
    last: { status: 'succeeded', at: '2026-11-01T00:00:00.000Z' },
    ...extra,
  })

  it('sorts by a column, those without a value last', () => {
    const tasks = [
      stats('build', { runs: 4, medianMs: 10 }),
      stats('test', { runs: 2 }),
      stats('lint', { runs: 9, medianMs: 3 }),
    ]
    const order = (query: string) => {
      const parsed = parseTaskOrder(params(query))
      return parsed ? sortTasks(tasks, parsed).map((task) => task.task) : undefined
    }
    expect(order('')).toBeUndefined()
    expect(order('sort=runs')).toEqual(['lint', 'build', 'test'])
    expect(order('sort=runs&order=asc')).toEqual(['test', 'build', 'lint'])
    expect(order('sort=median&order=asc')).toEqual(['lint', 'build', 'test'])
    expect(order('sort=task&order=asc')).toEqual(['build', 'lint', 'test'])
    expect(() => order('sort=colour')).toThrow('sort:')
    expect(() => order('sort=runs&order=up')).toThrow('order:')
  })
})
