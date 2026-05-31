export function lazyResolver<T>(factory: () => T): () => T {
  let value: any = null
  let resolved = false
  return () => {
    if (!resolved) {
      value = factory()
      resolved = true
    }
    return value
  }
}
