export class Lazy<T> {
  private current: { result: T } | null = null

  constructor(private factory: () => T) {}

  resolve(): T {
    if (!this.current) {
      this.current = { result: this.factory() }
    }
    return this.current.result
  }
}
