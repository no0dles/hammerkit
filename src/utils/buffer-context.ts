// The last `limit` entries of each id, and all of those in the order they came. An entry an id
// no longer keeps leaves both.
export class BufferContext<T> {
  private scopedBuffer = new Map<string, T[]>()
  private buffer: T[] = []

  constructor(private limit: number) {}

  add(id: string, data: T) {
    this.buffer.push(data)
    let scopedBuffer = this.scopedBuffer.get(id)
    if (!scopedBuffer) {
      scopedBuffer = []
      this.scopedBuffer.set(id, scopedBuffer)
    }
    scopedBuffer.push(data)
    if (scopedBuffer.length > this.limit) {
      const removed = scopedBuffer.shift() as T
      const bufferIndex = this.buffer.indexOf(removed)
      if (bufferIndex >= 0) {
        this.buffer.splice(bufferIndex, 1)
      }
    }
  }

  current(id: string): T | null {
    const value = this.scopedBuffer.get(id)
    if (!value || value.length === 0) {
      return null
    }
    return value[value.length - 1]
  }

  get(id?: string): T[] {
    if (id) {
      return this.scopedBuffer.get(id) ?? []
    } else {
      return this.buffer
    }
  }
}
