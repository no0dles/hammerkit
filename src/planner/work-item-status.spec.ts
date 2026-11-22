import { Writable } from 'stream'
import { Message, statusConsole } from './work-item-status'

describe('statusConsole', () => {
  it('writes a line of a pod without its cursor, and tells its listeners where the log got to', () => {
    const written: string[] = []
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        written.push(chunk.toString())
        callback()
      },
    })
    const status = statusConsole(writable)
    const heard: Message[] = []
    status.on((message) => {
      heard.push(message)
    })
    const cursor = { container: 'containerd://abc', at: '2026-11-22T10:00:00.000000000', count: 1 }
    status.context({ type: 'task', name: 'build' }).console('stdout', 'hello', cursor)

    expect(heard).toEqual([expect.objectContaining({ type: 'console', message: 'hello', cursor })])
    const line = JSON.parse(written[0])
    expect(line.message).toEqual(expect.objectContaining({ type: 'console', message: 'hello' }))
    expect('cursor' in line.message).toBe(false)
  })
})
