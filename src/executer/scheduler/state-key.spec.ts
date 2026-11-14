import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { environmentMock } from '../environment-mock'
import { computeStateKey, getExecutionStateKeys } from './state-key'

describe('state-key', () => {
  let scratch: string
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'state-key-'))
  })
  afterEach(() => rmSync(scratch, { recursive: true, force: true }))

  const caching = { name: 'local', method: 'checksum', implicit: true, backend: {} } as any
  const item = (id: string, needs: any[] = [], deps: any[] = []) => {
    const file = join(scratch, `${id}.txt`)
    writeFileSync(file, id)
    return {
      id: () => id,
      name: id,
      status: { write: () => undefined },
      data: {
        type: 'local-task',
        name: id,
        cwd: scratch,
        cmds: ['x'],
        generates: [],
        src: [{ absolutePath: file, source: file, matcher: () => true, inherited: null, isFile: true }],
        caching,
      },
      needs,
      deps,
    } as any
  }

  const keysAlone = async (items: any[]) => {
    const keys: string[] = []
    for (const it of items) {
      keys.push((await computeStateKey(it, 'checksum', environmentMock(scratch))).stateKey)
    }
    return keys
  }
  const keysAtOnce = async (items: any[]) => {
    const env = environmentMock(scratch)
    const memo = getExecutionStateKeys({})
    const results = await Promise.all(items.map((it) => computeStateKey(it, 'checksum', env, memo)))
    return results.map((result) => result.stateKey)
  }

  // a placeholder for a service still being computed went into the keys of other tasks
  // checked at the same time, so they no longer changed with the service's sources
  it('gives tasks that need one service, checked at once, the keys they have alone', async () => {
    const db = item('db')
    const a = item('a', [{ name: 'db', service: db }])
    const b = item('b', [{ name: 'db', service: db }])

    const before = await keysAtOnce([a, b])
    expect(before).toEqual(await keysAlone([a, b]))

    writeFileSync(join(scratch, 'db.txt'), 'changed')
    const after = await keysAtOnce([a, b])
    expect(after).toEqual(await keysAlone([a, b]))
    expect(after[0]).not.toBe(before[0])
    expect(after[1]).not.toBe(before[1])
  })

  it('gives tasks that need a service which needs a service the keys they have alone', async () => {
    const store = item('store')
    const db = item('db', [{ name: 'store', service: store }])
    const a = item('a', [{ name: 'db', service: db }])
    const b = item('b', [{ name: 'db', service: db }])
    const c = item('c', [{ name: 'store', service: store }])

    const before = await keysAtOnce([a, b, c])
    expect(before).toEqual(await keysAlone([a, b, c]))

    writeFileSync(join(scratch, 'store.txt'), 'changed')
    const after = await keysAtOnce([a, b, c])
    expect(after).toEqual(await keysAlone([a, b, c]))
    for (let i = 0; i < after.length; i++) {
      expect(after[i]).not.toBe(before[i])
    }
  })

  it('ends on services that need each other', async () => {
    const one = item('one')
    const two = item('two', [{ name: 'one', service: one }])
    one.needs.push({ name: 'two', service: two })
    const a = item('a', [{ name: 'one', service: one }])
    const b = item('b', [{ name: 'two', service: two }])

    const keys = await keysAtOnce([a])
    expect(keys).toEqual(await keysAlone([a]))
    expect(await keysAlone([b])).toHaveLength(1)
  })
})
