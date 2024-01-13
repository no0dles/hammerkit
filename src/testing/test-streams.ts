import { Writable } from 'stream'

export function emptyStream(): Writable {
  const stream = new Writable()

  stream._write = function (_chunk, _encoding, done) {
    done();
  };

  return stream
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