// Memoizes factory(). While the factory is still running, a re-entrant call
// (a cycle) returns onReentry() when given, instead of recursing forever.
export function lazyResolver<T>(factory: () => T, onReentry?: () => T): () => T {
  let value: any = null
  let resolved = false
  let resolving = false
  return () => {
    if (!resolved) {
      if (resolving && onReentry) {
        return onReentry()
      }
      resolving = true
      try {
        value = factory()
        resolved = true
      } finally {
        resolving = false
      }
    }
    return value
  }
}
