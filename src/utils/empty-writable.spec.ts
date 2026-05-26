import { emptyWritable } from './empty-writable'

describe('emptyWritable', () => {
  it('accepts writes and invokes the callback', async () => {
    const stream = emptyWritable()
    await new Promise<void>((resolve, reject) => {
      stream.write('hello', (err) => (err ? reject(err) : resolve()))
    })
  })

  it('ends cleanly after writes', async () => {
    const stream = emptyWritable()
    stream.write('a')
    stream.write('b')
    await new Promise<void>((resolve) => stream.end(resolve))
  })
})
