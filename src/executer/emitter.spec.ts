import { UpdateEmitter } from './emitter'

describe('emitter', () => {
  it('test error', async () => {
    const emitter = new UpdateEmitter<{ type: 'result'; value: number }>(new AbortController().signal)
    emitter.task(
      'test',
      () =>
        new Promise<{ type: 'result'; value: number }>((resolve, reject) =>
          setTimeout(() => reject(new Error('3')), 3000)
        )
    )
    emitter.task(
      'test',
      () =>
        new Promise<{ type: 'result'; value: number }>((resolve, reject) =>
          setTimeout(() => reject(new Error('1')), 1000)
        )
    )

    try {
      const result1 = await emitter.next()
      expect(result1).not.toBeCalled()
    } catch (e) {
      expect(e).toBeInstanceOf(Error)
      if (e instanceof Error) {
        expect(e.message).toBe('1')
      }
    }

    try {
      const result2 = await emitter.next()
      expect(result2).not.toBeCalled()
    } catch (e) {
      expect(e).toBeInstanceOf(Error)
      if (e instanceof Error) {
        expect(e.message).toBe('3')
      }
    }

    const result3 = await emitter.next()
    expect(result3).toBeNull()
  })

  it('test tasks', async () => {
    const emitter = new UpdateEmitter<{ type: 'result'; value: number }>(new AbortController().signal)
    emitter.task(
      'test',
      () =>
        new Promise<{ type: 'result'; value: number }>((resolve) =>
          setTimeout(() => resolve({ type: 'result', value: 3 }), 3000)
        )
    )
    emitter.task(
      'test',
      () =>
        new Promise<{ type: 'result'; value: number }>((resolve) =>
          setTimeout(() => resolve({ type: 'result', value: 1 }), 1000)
        )
    )

    const result1 = await emitter.next()
    expect(result1).toBeDefined()
    if (result1) {
      expect(result1.value).toBe(1)
    }

    const result2 = await emitter.next()
    expect(result2).toBeDefined()
    if (result2) {
      expect(result2.value).toBe(3)
    }

    const result3 = await emitter.next()
    expect(result3).toBeNull()
  })

  it('test interupt', async () => {
    const emitter = new UpdateEmitter<{ type: 'result'; value: number }>(new AbortController().signal)
    emitter.task(
      'test',
      () =>
        new Promise<{ type: 'result'; value: number }>((resolve) =>
          setTimeout(() => resolve({ type: 'result', value: 3 }), 3000)
        )
    )
    const result1Promise = emitter.next()

    emitter.task(
      'test',
      () =>
        new Promise<{ type: 'result'; value: number }>((resolve) =>
          setTimeout(() => resolve({ type: 'result', value: 1 }), 1000)
        )
    )

    expect(await result1Promise).toEqual({ value: 1, type: 'result' })
    expect(await emitter.next()).toEqual({ value: 3, type: 'result' })
  })

  it('test emit interupt', async () => {
    const emitter = new UpdateEmitter<{ type: 'result'; value: number }>(new AbortController().signal)
    emitter.task(
      'test',
      () =>
        new Promise<{ type: 'result'; value: number }>((resolve) =>
          setTimeout(() => resolve({ type: 'result', value: 2 }), 2000)
        )
    )
    const result1Promise = emitter.next()

    emitter.emit({ type: 'result', value: 0 })

    expect(await result1Promise).toEqual({ value: 0, type: 'result' })
    expect(await emitter.next()).toEqual({ value: 2, type: 'result' })
  })
})
