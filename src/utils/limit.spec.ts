import { createLimit } from './limit'

describe('createLimit', () => {
  it('runs no more than its concurrency at once, and all of them', async () => {
    const limit = createLimit(3)
    let running = 0
    let most = 0
    const done = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        limit(async () => {
          running++
          most = Math.max(most, running)
          await new Promise((resolve) => setTimeout(resolve, i % 4))
          running--
          return i
        })
      )
    )
    expect(most).toBe(3)
    expect(done).toEqual(Array.from({ length: 20 }, (_, i) => i))
  })

  it('gives the slot of one that failed to the next', async () => {
    const limit = createLimit(1)
    const failed = limit(async () => {
      throw new Error('no')
    })
    const next = limit(async () => 'yes')
    await expect(failed).rejects.toThrow('no')
    await expect(next).resolves.toBe('yes')
  })
})
