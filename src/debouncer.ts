export class Debouncer {
  private timeoutHandle: any = null
  timeout = 0

  constructor(private trigger: () => any, private wait: number) {}

  start(): void {
    this.bounce()
  }

  clear(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle)
      this.timeoutHandle = null
    }
  }

  bounce(): void {
    this.clear()
    this.timeout = new Date().getTime() + this.wait
    this.timeoutHandle = setTimeout(() => this.flush(), this.wait)
  }

  flush(): void {
    this.trigger()
    this.clear()
  }
}
