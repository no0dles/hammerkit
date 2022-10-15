import { ProcessManager } from './process-manager'
import { ProcessListenerEventType } from './process-listener'
import { getEnvironmentMock } from './get-environment-mock'

describe('process-manager', () => {
  it('should complete on error', async () => {
    const manager = new ProcessManager(getEnvironmentMock())

    let currentIndex = 0
    let expectedEvents: ProcessListenerEventType[] = ['started', 'ended']
    manager.on((evt, processes) => {
      expect(evt.type).toBe(expectedEvents[currentIndex++])
    })

    manager.task(
      { type: 'task', name: 'test-error', id: 'a' },
      () =>
        new Promise<{ type: 'result'; value: number }>((resolve, reject) =>
          setTimeout(() => reject(new Error('3')), 100)
        )
    )
    await manager.onComplete()
    expect(currentIndex).toBe(2)
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
