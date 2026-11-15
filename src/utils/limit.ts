// Runs at most `concurrency` of the functions handed to it at once, the others wait their
// turn in the order they came. A function must not wait for another of the same limit, or
// both may wait for ever.
export type Limit = <T>(fn: () => Promise<T>) => Promise<T>

export function createLimit(concurrency: number): Limit {
  let running = 0
  const waiting: (() => void)[] = []
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (running >= concurrency) {
      await new Promise<void>((resolve) => waiting.push(resolve))
    } else {
      running++
    }
    try {
      return await fn()
    } finally {
      const next = waiting.shift()
      if (next) {
        // the slot goes to the next one as it is
        next()
      } else {
        running--
      }
    }
  }
}
