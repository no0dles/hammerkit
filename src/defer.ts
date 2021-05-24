export class Defer<T> {
  private resolveFn: ((value: T) => void) | null = null
  private rejectFn: ((err?: Error) => void) | null = null
  private promiseResolved = false
  private promiseRejected = false
  private promiseResult: T | null = null
  private promiseError: any | null = null

  promise: Promise<T>

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.rejectFn = reject
      this.resolveFn = resolve
    })
  }

  get isResolved() {
    return this.promiseResolved
  }

  get isRejected() {
    return this.promiseRejected
  }

  get resolvedResult(): T | null {
    return this.promiseResult
  }

  get rejectedError(): any | null {
    return this.promiseError
  }

  resolve(value: T) {
    if (this.promiseResolved) {
      throw new Error('defer already resolved')
    }
    if (this.promiseRejected) {
      throw new Error('defer already rejected')
    }

    this.promiseResolved = true
    this.promiseResult = value ?? null
    this.resolveFn!(value)
  }

  reject(err?: any) {
    if (this.promiseResolved) {
      throw new Error('defer already resolved')
    }
    if (this.promiseRejected) {
      throw new Error('defer already rejected')
    }

    this.promiseRejected = true
    this.promiseError = err
    this.rejectFn!(err)
  }
}
