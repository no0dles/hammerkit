export class BufferContext<T> {
  private scopedBuffer: { [key: string]: T[] } = {}
  private buffer: T[] = []

  constructor(private limit: number) {}

  add(id: string, data: T) {
    this.buffer.push(data)
    if (id in this.scopedBuffer) {
      const scopedBuffer = this.scopedBuffer[id]
      scopedBuffer.push(data)
      if (scopedBuffer.length > this.limit) {
        const removedBuffer = this.buffer.splice(0, 1)[0]
        const bufferIndex = this.buffer.indexOf(removedBuffer)
        if (bufferIndex >= 0) {
          this.buffer.splice(bufferIndex, 1)
        }
      }
    } else {
      this.scopedBuffer[id] = [data]
    }
  }

  current(id: string): T | null {
    if (!(id in this.scopedBuffer)) {
      return null
    }
    const value = this.scopedBuffer[id]
    return value[value.length - 1]
  }

  get(id?: string): T[] {
    if (id) {
      return this.scopedBuffer[id] ?? []
    } else {
      return this.buffer
    }
  }
}
