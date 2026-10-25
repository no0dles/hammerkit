import { createServer } from 'http'
import { AddressInfo } from 'net'
import { callServer, printableLines } from './server-client'

describe('server-client', () => {
  it('shows every problem of a refused publish, each on a line of its own', async () => {
    const problems = Array.from(
      { length: 12 },
      (_, i) => `dev:task-${i}: mounts /root/.local/share/iwentsourcing, which is outside of the bundle`
    )
    const server = createServer((req, res) => {
      res.statusCode = 400
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: problems.join('\n') }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const error = await callServer({ url, issuer: url }, 'a-token', 'POST', '/v1/definitions', {}).catch((e) => e)
      const message = (error as Error).message
      expect(message).toBe(`${url} answered 400:\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
      expect(message).not.toContain('chars)')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('keeps each line printable and bounded', () => {
    expect(printableLines('a\u001b[2Jb\n\nc‮d')).toEqual(['a?[2Jb', 'c\\u{202e}d'])
    expect(printableLines('x'.repeat(400))).toEqual([`${'x'.repeat(300)}… (+100 chars)`])
    const many = printableLines(Array.from({ length: 150 }, (_, i) => `line ${i}`).join('\n'))
    expect(many).toHaveLength(101)
    expect(many[100]).toBe('… (+50 lines)')
  })
})
