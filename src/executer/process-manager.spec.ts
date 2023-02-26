import { ProcessManager } from './process-manager'
import { WorkItem } from '../planner/work-item'
import { logContext, statusConsole } from '../planner/work-node-status'
import { emptyWritable } from '../utils/empty-writable'

describe('process-manager', () => {
  function fakeWorkItem(id: string) {
    return {
      id: () => '',
      status: statusConsole(emptyWritable()).context(logContext('task', { name: id } as any)),
      deps: [],
      aliases: [id],
      needs: [],
      requiredBy: [],
      name: id,
      data: null,
      state: null,
    } as WorkItem<any>
  }

  it('should complete on success', async () => {
    const manager = new ProcessManager(0)

    let called = false
    await manager.task(
      fakeWorkItem('a'),
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            called = true
            resolve()
          }, 100)
        )
    )
    expect(called).toBeTruthy()
  })

  it('should throw error', async () => {
    const manager = new ProcessManager(0)

    await expect(
      manager.task(
        fakeWorkItem('a'),
        () => new Promise<void>((resolve, reject) => setTimeout(() => reject(new Error('3')), 100))
      )
    ).rejects.toThrow('3')
  })

  it('should not start more than worker count', async () => {
    const manager = new ProcessManager(1)

    let concurrencyCount = 0

    const fakeAction = () =>
      new Promise<void>((resolve) => {
        expect(concurrencyCount).toBe(0)
        concurrencyCount++
        setTimeout(() => {
          expect(concurrencyCount).toBe(1)
          concurrencyCount--
          resolve()
        }, 100)
      })

    await Promise.all([
      manager.task(fakeWorkItem('a'), fakeAction),
      manager.task(fakeWorkItem('b'), fakeAction),
      manager.task(fakeWorkItem('c'), fakeAction),
    ])

    expect(concurrencyCount).toBe(0)
  })
})
