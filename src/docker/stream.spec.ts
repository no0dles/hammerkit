import { PassThrough } from 'stream'
import { awaitStream, logStream } from './stream'

function makeStatus() {
  return { console: vi.fn(), write: vi.fn() } as any
}

function frame(type: number, payload: string): Buffer {
  const body = Buffer.from(payload)
  const header = Buffer.alloc(8)
  header.writeUInt8(type, 0)
  header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('logStream', () => {
  it('logs a single stdout frame', async () => {
    const status = makeStatus()
    const stream = new PassThrough()
    logStream(status, stream)

    stream.write(frame(1, 'hello world\n'))
    await settle()

    expect(status.console).toHaveBeenCalledTimes(1)
    expect(status.console).toHaveBeenCalledWith('stdout', 'hello world')
  })

  it('logs a stderr frame', async () => {
    const status = makeStatus()
    const stream = new PassThrough()
    logStream(status, stream)

    stream.write(frame(2, 'boom\n'))
    await settle()

    expect(status.console).toHaveBeenCalledTimes(1)
    expect(status.console).toHaveBeenCalledWith('stderr', 'boom')
  })

  it('logs every frame of a single chunk', async () => {
    const status = makeStatus()
    const stream = new PassThrough()
    logStream(status, stream)

    stream.write(Buffer.concat([frame(1, 'one\n'), frame(2, 'two\n'), frame(1, 'three\n')]))
    await settle()

    expect(status.console).toHaveBeenCalledTimes(3)
    expect(status.console.mock.calls).toEqual([
      ['stdout', 'one'],
      ['stderr', 'two'],
      ['stdout', 'three'],
    ])
  })

  it('reassembles a frame that is split across writes', async () => {
    const status = makeStatus()
    const stream = new PassThrough()
    logStream(status, stream)
    const data = frame(1, 'split payload\n')

    stream.write(data.subarray(0, 5))
    await settle()
    expect(status.console).not.toHaveBeenCalled()

    stream.write(data.subarray(5))
    await settle()

    expect(status.console).toHaveBeenCalledTimes(1)
    expect(status.console).toHaveBeenCalledWith('stdout', 'split payload')
  })

  it('reassembles a payload that is split across writes', async () => {
    const status = makeStatus()
    const stream = new PassThrough()
    logStream(status, stream)
    const data = frame(1, 'split payload\n')

    stream.write(Buffer.concat([data.subarray(0, 8), data.subarray(8, 12)]))
    await settle()
    expect(status.console).not.toHaveBeenCalled()

    stream.write(data.subarray(12))
    await settle()

    expect(status.console).toHaveBeenCalledTimes(1)
    expect(status.console).toHaveBeenCalledWith('stdout', 'split payload')
  })

  it('drops empty lines and keeps payloads without a trailing newline', async () => {
    const status = makeStatus()
    const stream = new PassThrough()
    logStream(status, stream)

    stream.write(frame(1, 'first\n\nsecond'))
    await settle()

    expect(status.console).toHaveBeenCalledTimes(2)
    expect(status.console.mock.calls).toEqual([
      ['stdout', 'first'],
      ['stdout', 'second'],
    ])
  })
})

describe('awaitStream', () => {
  it('logs the stream and resolves when it ends', async () => {
    const status = makeStatus()
    const stream = new PassThrough()
    const pending = awaitStream(status, stream)

    stream.write(frame(1, 'done\n'))
    stream.end()
    await expect(pending).resolves.toBeUndefined()

    expect(status.console).toHaveBeenCalledWith('stdout', 'done')
  })

  it('resolves when the stream closes without ending', async () => {
    const stream = new PassThrough()
    const pending = awaitStream(makeStatus(), stream)

    stream.destroy()
    await expect(pending).resolves.toBeUndefined()
  })

  it('rejects when the stream errors', async () => {
    const stream = new PassThrough()
    const pending = awaitStream(makeStatus(), stream)

    stream.destroy(new Error('stream failed'))
    await expect(pending).rejects.toThrow('stream failed')
  })
})
