import { Writable } from 'stream'

export function emptyStream(): Writable {
  return new Writable()
}

export function memoryStream(): { read(): string, stream: Writable } {
  const stream = new Writable()
  const chunks: string[] = []

  stream._write = function (chunk, encoding, done) {
    chunks.push(chunk.toString())
    done();
  };

  return {
    stream,
    read(): string {
      return chunks.join('')
    }
  }
}