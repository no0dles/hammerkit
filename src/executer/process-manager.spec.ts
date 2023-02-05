import { ProcessManager } from './process-manager'
import { ProcessListenerEventType } from './process-listener'
import { environmentMock } from './environment-mock'
import { listenOnAbort } from '../utils/abort-event'
import { WorkItem } from '../planner/work-item'
import { logContext, statusConsole } from '../planner/work-node-status'
import { emptyWritable } from '../utils/empty-writable'

describe('process-manager', () => {
  function fakeWorkItem(id: string) {
    return {
      id,
      status: statusConsole(emptyWritable()).context(logContext(id, 'task', null as any)),
      deps: [],
      needs: [],
      name: 'test',
      data: null,
    } as WorkItem<any>
  }

  it('should complete on success', async () => {
    const manager = new ProcessManager(environmentMock(process.cwd()), 0)

    let currentIndex = 0
    const expectedEvents: ProcessListenerEventType[] = ['started', 'ended']
    manager.on((evt) => {
      expect(evt.type).toBe(expectedEvents[currentIndex++])
    })

    manager.task(fakeWorkItem('a'), () => new Promise<void>((resolve) => setTimeout(() => resolve(), 100)))
    await manager.onComplete()
    expect(currentIndex).toBe(2)
  })

  it('should complete on error', async () => {
    const manager = new ProcessManager(environmentMock(process.cwd()), 0)

    let currentIndex = 0
    const expectedEvents: ProcessListenerEventType[] = ['started', 'ended']
    manager.on((evt) => {
      expect(evt.type).toBe(expectedEvents[currentIndex++])
    })

    manager.task(
      fakeWorkItem('a'),
      () => new Promise<void>((resolve, reject) => setTimeout(() => reject(new Error('3')), 100))
    )
    await manager.onComplete()
    expect(currentIndex).toBe(2)
  })

  it('should not start more than worker count', async () => {
    const manager = new ProcessManager(environmentMock(process.cwd()), 1)

    const processes: string[] = []
    let concurrencyCount = 0
    let hasOversteppedLimits = false
    manager.on((evt) => {
      if (evt.type === 'started') {
        concurrencyCount++
      } else if (evt.type === 'ended') {
        concurrencyCount--
        processes.push(evt.item.id)
      }
      if (concurrencyCount > 1) {
        hasOversteppedLimits = true
      }
    })

    manager.task(fakeWorkItem('a'), () => new Promise<void>((resolve) => setTimeout(() => resolve(), 100)))
    manager.task(fakeWorkItem('b'), () => new Promise<void>((resolve) => setTimeout(() => resolve(), 100)))
    manager.task(fakeWorkItem('c'), () => new Promise<void>((resolve) => setTimeout(() => resolve(), 100)))
    await manager.onComplete()
    expect(processes).toEqual(['a', 'b', 'c'])
    expect(hasOversteppedLimits).toBeFalsy()
    expect(concurrencyCount).toBe(0)
  })

  it('should terminate on abort', async () => {
    const env = environmentMock(process.cwd())
    const manager = new ProcessManager(env, 0)
    manager.task(
      fakeWorkItem('a'),
      (abort) =>
        new Promise<void>((resolve) => {
          listenOnAbort(abort.signal, resolve)
        })
    )
    setTimeout(() => {
      env.abortCtrl.abort()
    }, 200)
    await manager.onComplete()
  })

  it('should abort if task with same id is already started', async () => {
    const manager = new ProcessManager(environmentMock(process.cwd()), 0)

    const processes: string[] = []
    let concurrencyCount = 0
    let hasOversteppedLimits = false
    manager.on((evt) => {
      if (evt.type === 'started') {
        concurrencyCount++
      } else if (evt.type === 'ended') {
        concurrencyCount--
        processes.push(evt.item.id)
      }
      if (concurrencyCount > 1) {
        hasOversteppedLimits = true
      }
    })

    const abortController = manager.task(
      fakeWorkItem('a'),
      () => new Promise<void>((resolve) => setTimeout(() => resolve(), 200))
    )
    manager.task(fakeWorkItem('a'), () => new Promise<void>((resolve) => setTimeout(() => resolve(), 100)))
    expect(abortController.signal.aborted).toBeTruthy()
    await manager.onComplete()
    expect(processes).toEqual(['a', 'a'])
    expect(hasOversteppedLimits).toBeFalsy()
    expect(concurrencyCount).toBe(0)
  })
})
