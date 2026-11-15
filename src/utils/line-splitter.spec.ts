import { PassThrough } from 'stream'
import { lineSplitter } from './line-splitter'
import { createSecretRegistry } from './redact'
import { statusConsole } from '../planner/work-item-status'
import { emptyWritable } from './empty-writable'
import { logStream } from '../docker/stream'

describe('lineSplitter', () => {
  const split = (chunks: (string | Buffer)[], max?: number) => {
    const lines: string[] = []
    const splitter = lineSplitter((line) => lines.push(line), max)
    chunks.forEach((chunk) => splitter.write(chunk))
    splitter.end()
    return lines
  }

  it('passes on a line two chunks split as one line, once it ends', () => {
    expect(split(['hel', 'lo\nwor', 'ld\n'])).toEqual(['hello', 'world'])
    expect(split(['a\r', '\nb'])).toEqual(['a', 'b'])
  })

  it('leaves out empty lines and passes on a last line without a line feed', () => {
    expect(split(['\n\na\n\n', 'b'])).toEqual(['a', 'b'])
    expect(split([])).toEqual([])
  })

  it('keeps a character that two chunks split whole', () => {
    const bytes = Buffer.from('grüße\n')
    expect(split([bytes.subarray(0, 3), bytes.subarray(3)])).toEqual(['grüße'])
  })

  it('passes on a line longer than its limit in parts', () => {
    expect(split(['abcdefg'], 3)).toEqual(['abc', 'def', 'g'])
  })

  it('takes nothing after its end', () => {
    const lines: string[] = []
    const splitter = lineSplitter((line) => lines.push(line))
    splitter.write('a')
    splitter.end()
    splitter.write('b\n')
    splitter.end()
    expect(lines).toEqual(['a'])
  })
})

describe('the output of a task, masked', () => {
  const SECRET = 'sup3r-s3cret-value'

  it('masks a secret that two chunks of a command split', () => {
    const secrets = createSecretRegistry()
    secrets.register(SECRET)
    const status = statusConsole(emptyWritable(), secrets)
    const logged: string[] = []
    status.on((message) => {
      logged.push(message.message)
    })
    const splitter = lineSplitter((line) => status.context({ type: 'task', name: 'deploy' }).console('stdout', line))
    splitter.write(`token=${SECRET.slice(0, 6)}`)
    splitter.write(`${SECRET.slice(6)} done\n`)
    splitter.end()
    expect(logged).toEqual(['token=*** done'])
  })

  it('masks a secret that two frames of docker split', async () => {
    const secrets = createSecretRegistry()
    secrets.register(SECRET)
    const status = statusConsole(emptyWritable(), secrets)
    const logged: string[] = []
    status.on((message) => {
      logged.push(message.message)
    })
    const stream = new PassThrough()
    logStream(status.context({ type: 'task', name: 'deploy' }), stream)
    // a frame: the stream (1 stdout), three bytes, the length, the payload
    const frame = (text: string) => {
      const payload = Buffer.from(text)
      const header = Buffer.alloc(8)
      header.writeUInt8(1, 0)
      header.writeUInt32BE(payload.length, 4)
      return Buffer.concat([header, payload])
    }
    stream.write(frame(`key ${SECRET.slice(0, 4)}`))
    stream.write(frame(`${SECRET.slice(4)}\nlast`))
    stream.end()
    await new Promise((resolve) => stream.on('close', resolve).resume())
    expect(logged).toEqual(['key ***', 'last'])
  })
})
