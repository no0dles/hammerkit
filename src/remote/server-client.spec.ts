import { createServer, IncomingMessage, ServerResponse } from 'http'
import { AddressInfo } from 'net'
import { ServerConnection } from '../harness/sandbox-client'
import { callServer, printableLines, ServerError } from './server-client'

const QUICK = { windowMs: 5_000, firstDelayMs: 20, maxDelayMs: 100 }

const connect = (url: string, say?: (line: string) => void): ServerConnection => ({
  url,
  token: async () => 'a-token',
  reconnect: QUICK,
  say,
})

const json = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))

// a port nothing listens on, for a server that is away
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

// a server that is away for `awayMs`, as during a restart, then answers with `handler`
async function withRestart(
  awayMs: number,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (url: string) => Promise<void>
): Promise<void> {
  const port = await freePort()
  const server = createServer(handler)
  const started = new Promise<void>((resolve) =>
    setTimeout(() => server.listen(port, '127.0.0.1', () => resolve()), awayMs)
  )
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await started
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (url: string) => Promise<void>
): Promise<void> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

describe('server-client', () => {
  it('shows every problem of a refused publish, each on a line of its own', async () => {
    const problems = Array.from(
      { length: 12 },
      (_, i) => `dev:task-${i}: mounts /root/.local/share/iwentsourcing, which is outside of the bundle`
    )
    await withServer(
      (req, res) => {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: problems.join('\n') }))
      },
      async (url) => {
        const error = await callServer(connect(url), 'POST', '/v1/definitions', { body: {} }).catch((e) => e)
        const message = (error as Error).message
        expect(message).toBe(`${url} answered 400:\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
        expect(message).not.toContain('chars)')
      }
    )
  })

  it('reads again through a restart, and says when it reconnects and when the server is back', async () => {
    const said: string[] = []
    await withRestart(
      300,
      (req, res) => json(res, 200, { hosts: [] }),
      async (url) => {
        const answer = await callServer(
          connect(url, (line) => said.push(line)),
          'GET',
          '/v1/overview'
        )
        expect(answer).toEqual({ status: 200, body: { hosts: [] } })
        expect(said).toEqual([expect.stringContaining('reconnecting for up to'), `${url} is back`])
      }
    )
  })

  it('sends a call the restarting server refused once, when it is back', async () => {
    let received = 0
    await withRestart(
      300,
      (req, res) => {
        received++
        json(res, 200, { id: 'run_aaaaaaaaaaaaaaaa', state: 'queued' })
      },
      async (url) => {
        const answer = await callServer(connect(url), 'POST', '/v1/runs/run_aaaaaaaaaaaaaaaa/retry')
        expect(answer.body.state).toBe('queued')
        expect(received).toBe(1)
      }
    )
  })

  it('does not send a retry again once the server may have taken it, and fails at once', async () => {
    let received = 0
    await withServer(
      (req) => {
        received++
        // the connection breaks after the request was read: the answer is lost
        req.socket.destroy()
      },
      async (url) => {
        const error = await callServer(connect(url), 'POST', '/v1/runs/run_aaaaaaaaaaaaaaaa/retry').catch((e) => e)
        expect(error).toBeInstanceOf(ServerError)
        expect((error as Error).message).toContain(`unable to reach ${url}`)
        expect(received).toBe(1)
      }
    )
  })

  it('sends a stop again when its answer was lost, as the server takes a stop of a run that is stopped already', async () => {
    let answered = 0
    const stopped = new Set<string>()
    await withServer(
      (req, res) => {
        stopped.add('run_aaaaaaaaaaaaaaaa')
        answered++
        if (answered === 1) {
          req.socket.destroy()
          return
        }
        json(res, 200, { id: 'run_aaaaaaaaaaaaaaaa', state: 'cancelled' })
      },
      async (url) => {
        const answer = await callServer(connect(url), 'POST', '/v1/runs/run_aaaaaaaaaaaaaaaa/cancel', {
          repeat: 'always',
        })
        expect(answer.body.state).toBe('cancelled')
        expect(answered).toBe(2)
        expect([...stopped]).toEqual(['run_aaaaaaaaaaaaaaaa'])
      }
    )
  })

  it('keeps each line printable and bounded', () => {
    expect(printableLines('a\u001b[2Jb\n\nc‮d')).toEqual(['a?[2Jb', 'c\\u{202e}d'])
    expect(printableLines('x'.repeat(400))).toEqual([`${'x'.repeat(300)}… (+100 chars)`])
    const many = printableLines(Array.from({ length: 150 }, (_, i) => `line ${i}`).join('\n'))
    expect(many).toHaveLength(101)
    expect(many[100]).toBe('… (+50 lines)')
  })
})
