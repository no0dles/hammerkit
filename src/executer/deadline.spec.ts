import { getTaskTimeout } from './deadline'

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
