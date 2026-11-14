interface Entry<T> {
  data: T
  kept: boolean
}

// The last `limit` entries of each id, and all of those in the order they came. An entry an id
// no longer keeps leaves both; the list of all of them drops what left now and then, so an
// entry costs the same however many ids there are.
export class BufferContext<T> {
  private scopedBuffer = new Map<string, Entry<T>[]>()
  private buffer: Entry<T>[] = []
  private dropped = 0

  constructor(private limit: number) {}

  add(id: string, data: T) {
    const entry = { data, kept: true }
    this.buffer.push(entry)
    let scopedBuffer = this.scopedBuffer.get(id)
    if (!scopedBuffer) {
      scopedBuffer = []
      this.scopedBuffer.set(id, scopedBuffer)
    }
    scopedBuffer.push(entry)
    if (scopedBuffer.length > this.limit) {
      const removed = scopedBuffer.shift() as Entry<T>
      removed.kept = false
      this.dropped++
      if (this.dropped * 2 > this.buffer.length) {
        this.compact()
      }
    }
  }

  current(id: string): T | null {
    const value = this.scopedBuffer.get(id)
    if (!value || value.length === 0) {
      return null
    }
    return value[value.length - 1].data
  }

  get(id?: string): T[] {
    if (id) {
      return (this.scopedBuffer.get(id) ?? []).map((entry) => entry.data)
    }
    this.compact()
    return this.buffer.map((entry) => entry.data)
  }

  private compact(): void {
    if (this.dropped > 0) {
      this.buffer = this.buffer.filter((entry) => entry.kept)
      this.dropped = 0
    }
  }
}
