import type { Mock } from 'vitest'
import { moveFiles } from './move-files'
import { Environment } from '../executer/environment'
import { WorkItem } from '../planner/work-item'

function context(existing: string[]): { env: Environment; remove: Mock; copy: Mock } {
  const remove = vi.fn(async () => undefined)
  const copy = vi.fn(async () => undefined)
  const env = {
    file: {
      exists: vi.fn(async (p: string) => existing.includes(p)),
      remove,
      copy,
    },
  } as unknown as Environment
  return { env, remove, copy }
}

const item = { status: { write: vi.fn() } } as unknown as WorkItem<any>

function* once(from: string, to: string) {
  yield { from, to }
}

describe('move-files', () => {
  it('copies an existing folder and removes a pre-existing target first', async () => {
    const { env, remove, copy } = context(['/a', '/out/a'])
    await moveFiles(item, env, () => once('/a', '/out/a'))
    expect(remove).toHaveBeenCalledWith('/out/a')
    expect(copy).toHaveBeenCalledWith('/a', '/out/a')
  })

  it('does not remove the target when it does not exist yet', async () => {
    const { env, remove, copy } = context(['/a'])
    await moveFiles(item, env, () => once('/a', '/out/a'))
    expect(remove).not.toHaveBeenCalled()
    expect(copy).toHaveBeenCalledWith('/a', '/out/a')
  })

  it('skips folders whose source does not exist', async () => {
    const { env, copy } = context([])
    await moveFiles(item, env, () => once('/missing', '/out/m'))
    expect(copy).not.toHaveBeenCalled()
  })

  it('dedupes identical from/to pairs', async () => {
    const { env, copy } = context(['/a'])
    function* twice() {
      yield { from: '/a', to: '/out/a' }
      yield { from: '/a', to: '/out/a' }
    }
    await moveFiles(item, env, twice)
    expect(copy).toHaveBeenCalledTimes(1)
  })
})
