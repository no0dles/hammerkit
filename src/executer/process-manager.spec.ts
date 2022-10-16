import { ProcessManager } from './process-manager'
import { ProcessListenerEventType } from './process-listener'
import { environmentMock } from './environment-mock'
import { checkForAbort } from './abort'
import { sleep } from '../utils/sleep'

describe('process-manager', () => {
  it('should complete on success', async () => {
    const manager = new ProcessManager(environmentMock(), 0)

    let currentIndex = 0
    const expectedEvents: ProcessListenerEventType[] = ['started', 'ended']
    manager.on((evt) => {
      expect(evt.type).toBe(expectedEvents[currentIndex++])
    })

    manager.task(
      { type: 'task', name: 'test-success', id: 'a' },
      () => new Promise<void>((resolve) => setTimeout(() => resolve(), 100))
    )
    await manager.onComplete()
    expect(currentIndex).toBe(2)
  })

  it('should complete on error', async () => {
    const manager = new ProcessManager(environmentMock(), 0)

    let currentIndex = 0
    const expectedEvents: ProcessListenerEventType[] = ['started', 'ended']
    manager.on((evt) => {
      expect(evt.type).toBe(expectedEvents[currentIndex++])
    })

    manager.task(
      { type: 'task', name: 'test-error', id: 'a' },
      () => new Promise<void>((resolve, reject) => setTimeout(() => reject(new Error('3')), 100))
    )
    await manager.onComplete()
    expect(currentIndex).toBe(2)
  })

  it('should not start more than worker count', async () => {
    const manager = new ProcessManager(environmentMock(), 1)

    const processes: string[] = []
    let concurrencyCount = 0
    let hasOversteppedLimits = false
    manager.on((evt) => {
      if (evt.type === 'started') {
        concurrencyCount++
      } else if (evt.type === 'ended') {
        concurrencyCount--
        processes.push(evt.process.context.id)
      }
      if (concurrencyCount > 1) {
        hasOversteppedLimits = true
      }
    })

    manager.task(
      { type: 'task', name: 'test-success', id: 'a' },
      () => new Promise<void>((resolve) => setTimeout(() => resolve(), 100))
    )
    manager.task(
      { type: 'task', name: 'test-success', id: 'b' },
      () => new Promise<void>((resolve) => setTimeout(() => resolve(), 100))
    )
    manager.task(
      { type: 'task', name: 'test-success', id: 'c' },
      () => new Promise<void>((resolve) => setTimeout(() => resolve(), 100))
    )
    await manager.onComplete()
    expect(processes).toEqual(['a', 'b', 'c'])
    expect(hasOversteppedLimits).toBeFalsy()
    expect(concurrencyCount).toBe(0)
  })

  it('should terminate on abort', async () => {
    const env = environmentMock()
    const manager = new ProcessManager(env, 0)
    manager.task(
      { type: 'task', name: 'test-success', id: 'a' },
      (abort) =>
        new Promise<void>((resolve, reject) => {
          try {
            while (!abort.signal.aborted) {
              await sleep(20)
              checkForAbort(abort.signal)
            }
            resolve()
          } catch (e) {
            reject(e)
          }
        })
    )
    setTimeout(() => {
      env.abortCtrl.abort()
    }, 200)
    await manager.onComplete()
  })
  //
  // it('test tasks', async () => {
  //   const emitter = new ProcessManager<{ type: 'result'; value: number }>(new AbortController())
  //   emitter.task(
  //     'test',
  //     () =>
  //       new Promise<{ type: 'result'; value: number }>((resolve) =>
  //         setTimeout(() => resolve({ type: 'result', value: 3 }), 3000)
  //       )
  //   )
  //   emitter.task(
  //     'test',
  //     () =>
  //       new Promise<{ type: 'result'; value: number }>((resolve) =>
  //         setTimeout(() => resolve({ type: 'result', value: 1 }), 1000)
  //       )
  //   )
  //
  //   const result1 = await emitter.next()
  //   expect(result1).toBeDefined()
  //   if (result1) {
  //     expect(result1.value).toBe(1)
  //   }
  //
  //   const result2 = await emitter.next()
  //   expect(result2).toBeDefined()
  //   if (result2) {
  //     expect(result2.value).toBe(3)
  //   }
  //
  //   const result3 = await emitter.next()
  //   expect(result3).toBeNull()
  // })
  //
  // it('test interupt', async () => {
  //   const emitter = new ProcessManager(new AbortController())
  //   emitter.task(
  //     'test',
  //     () =>
  //       new Promise<{ type: 'result'; value: number }>((resolve) =>
  //         setTimeout(() => resolve({ type: 'result', value: 3 }), 3000)
  //       )
  //   )
  //   const result1Promise = emitter.next()
  //
  //   emitter.task(
  //     'test',
  //     () =>
  //       new Promise<{ type: 'result'; value: number }>((resolve) =>
  //         setTimeout(() => resolve({ type: 'result', value: 1 }), 1000)
  //       )
  //   )
  //
  //   expect(await result1Promise).toEqual({ value: 1, type: 'result' })
  //   expect(await emitter.next()).toEqual({ value: 3, type: 'result' })
  // })
})
