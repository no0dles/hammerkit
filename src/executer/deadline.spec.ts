import { getTaskTimeout, withDeadline } from './deadline'

describe('task timeout', () => {
  const run = (timeout: number | null, maxTimeout: number | null) => ({ timeout, maxTimeout })

  it("takes the task's own timeout over the run's default", () => {
    expect(getTaskTimeout(5000, run(1000, null))).toBe(5000)
    expect(getTaskTimeout(null, run(1000, null))).toBe(1000)
    expect(getTaskTimeout(null, run(null, null))).toBeNull()
  })

  it('caps every task with the maximum, and never extends one', () => {
    expect(getTaskTimeout(600_000, run(null, 30_000))).toBe(30_000)
    expect(getTaskTimeout(10_000, run(null, 30_000))).toBe(10_000)
    expect(getTaskTimeout(null, run(60_000, 30_000))).toBe(30_000)
    expect(getTaskTimeout(null, run(10_000, 30_000))).toBe(10_000)
    expect(getTaskTimeout(null, run(null, 30_000))).toBe(30_000)
  })
})

describe('deadline', () => {
  it('fires after the timeout', async () => {
    const deadline = withDeadline(new AbortController().signal, 10)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.expired()).toBe(true)
    deadline.clear()
  })

  it('sets none for a timeout longer than a timer can wait, instead of firing at once', async () => {
    const deadline = withDeadline(new AbortController().signal, 30 * 24 * 60 * 60 * 1000)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(deadline.signal.aborted).toBe(false)
    expect(deadline.expired()).toBe(false)
    deadline.clear()
  })
})
