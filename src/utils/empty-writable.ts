import { Writable } from 'stream'

export function emptyWritable(): Writable {
  return new Writable({
    write(chunk, encding, callback) {
      setImmediate(callback)
    },
  })
}
