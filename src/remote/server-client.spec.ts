import { createServer, IncomingMessage, ServerResponse } from 'http'
import { AddressInfo } from 'net'
import { RETRY_HEADER } from '../server/http'
import { ServerConnection } from '../harness/sandbox-client'
import { callServer, getDiscovery, getMe, printableLines, ServerError } from './server-client'
import type { HostServer } from './host-config'

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
        const answer = await callServer(connect(url), 'POST', '/v1/runs/run_aaaaaaaaaaaaaaaa/retry', {
          repeat: 'unsent',
        })
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
        const error = await callServer(connect(url), 'POST', '/v1/runs/run_aaaaaaaaaaaaaaaa/retry', {
          repeat: 'unsent',
        }).catch((e) => e)
        expect(error).toBeInstanceOf(ServerError)
        expect((error as Error).message).toContain(`unable to reach ${url}`)
        expect(received).toBe(1)
      }
    )
  })

  it('sends a stop again when its answer was lost, and the run ends once', async () => {
    // the server's own rule: a stop ends a run that runs, and a stop of a run that is over changes nothing
    let state = 'running'
    let answers = 0
    let ended = 0
    await withServer(
      (req, res) => {
        answers++
        if (state === 'running') {
          state = 'cancelled'
          ended++
        }
        if (answers === 1) {
          // the stop was applied, but its answer is lost
          req.socket.destroy()
          return
        }
        json(res, 200, { id: 'run_aaaaaaaaaaaaaaaa', state })
      },
      async (url) => {
        const answer = await callServer(connect(url), 'POST', '/v1/runs/run_aaaaaaaaaaaaaaaa/cancel', {
          repeat: 'always',
        })
        expect(answer.body.state).toBe('cancelled')
        expect(answers).toBe(2)
        expect(ended).toBe(1)
      }
    )
  })

  it('retries a 503 that says the server took nothing for a POST, and not a plain 503', async () => {
    let calls = 0
    await withServer(
      (req, res) => {
        calls++
        if (calls === 1) {
          res.writeHead(503, { [RETRY_HEADER]: 'safe', 'content-type': 'application/json' })
          return res.end('{"error":"the server is shutting down"}')
        }
        return json(res, 200, { id: 'run_aaaaaaaaaaaaaaaa', state: 'queued' })
      },
      async (url) => {
        const answer = await callServer(connect(url), 'POST', '/v1/runs/run_aaaaaaaaaaaaaaaa/retry', {
          repeat: 'unsent',
        })
        expect(answer.body.state).toBe('queued')
        expect(calls).toBe(2)
      }
    )

    let plain = 0
    await withServer(
      (req, res) => {
        plain++
        json(res, 503, { error: 'busy' })
      },
      async (url) => {
        const error = await callServer(connect(url), 'POST', '/v1/runs/run_aaaaaaaaaaaaaaaa/retry', {
          repeat: 'unsent',
        }).catch((e) => e)
        expect(error).toBeInstanceOf(ServerError)
        expect((error as ServerError).status).toBe(503)
        expect(plain).toBe(1)
      }
    )
  })

  it('retries a 503 of a read, which may come from a server that is away', async () => {
    let calls = 0
    await withServer(
      (req, res) => {
        calls++
        if (calls === 1) {
          return json(res, 503, { error: 'busy' })
        }
        return json(res, 200, { hosts: [] })
      },
      async (url) => {
        expect((await callServer(connect(url), 'GET', '/v1/overview')).body).toEqual({ hosts: [] })
        expect(calls).toBe(2)
      }
    )
  })

  it('refuses a redirect, so the token goes to no other address', async () => {
    let elsewhere = 0
    await withServer(
      (req, res) => {
        elsewhere++
        json(res, 200, { hosts: [] })
      },
      async (other) => {
        await withServer(
          (req, res) => {
            res.writeHead(302, { location: `${other}/v1/overview` }).end()
          },
          async (url) => {
            const error = await callServer(connect(url), 'GET', '/v1/overview').catch((e) => e)
            expect(error).toBeInstanceOf(ServerError)
            expect((error as Error).message).toContain(`unable to reach ${url}`)
            expect(elsewhere).toBe(0)
          }
        )
      }
    )
  })

  it('reads the token for each call, and asks for a new one once when the server refuses it', async () => {
    let current = 'stale'
    const read: string[] = []
    let renewed = 0
    await withServer(
      (req, res) => {
        if (req.headers.authorization !== 'Bearer fresh') {
          return json(res, 401, { error: 'the token is expired' })
        }
        return json(res, 200, { ok: true })
      },
      async (url) => {
        const connection: ServerConnection = {
          url,
          reconnect: QUICK,
          token: async () => {
            read.push(current)
            return current
          },
          renew: async () => {
            renewed++
            current = 'fresh'
          },
        }
        expect((await callServer(connection, 'GET', '/v1/overview')).body).toEqual({ ok: true })
        expect(renewed).toBe(1)
        expect(read).toEqual(['stale', 'fresh'])
      }
    )

    // a token that is refused again after its renewal is not renewed in a loop
    let asked = 0
    await withServer(
      (req, res) => json(res, 401, { error: 'no' }),
      async (url) => {
        const connection: ServerConnection = {
          url,
          reconnect: QUICK,
          token: async () => 'nope',
          renew: async () => {
            asked++
          },
        }
        const error = await callServer(connection, 'GET', '/v1/overview').catch((e) => e)
        expect(error).toBeInstanceOf(ServerError)
        expect((error as ServerError).status).toBe(401)
        expect(asked).toBe(1)
      }
    )
  })

  it('asks for the discovery document of a server without a token', async () => {
    let authorization: string | undefined = 'not asked'
    await withServer(
      (req, res) => {
        authorization = req.headers.authorization
        json(res, 200, { name: 'hammerkit', issuers: [] })
      },
      async (url) => {
        const document = await getDiscovery({ url, issuer: url } as HostServer)
        expect(document.name).toBe('hammerkit')
        expect(authorization).toBeUndefined()
      }
    )
  })

  it('ends the wait for a server that is away when the signal is aborted, for who signs in and for discovery', async () => {
    const url = `http://127.0.0.1:${await freePort()}`
    const reconnect = { windowMs: 60_000, firstDelayMs: 20, maxDelayMs: 100 }
    for (const ask of [
      (signal: AbortSignal) => getMe({ url, token: async () => 'a-token', reconnect, signal }),
      (signal: AbortSignal) => getDiscovery({ url, issuer: url } as HostServer, { signal }),
    ]) {
      const stop = new AbortController()
      setTimeout(() => stop.abort(), 100)
      const started = Date.now()
      const error = await ask(stop.signal).catch((e) => e)
      expect(error).toBeInstanceOf(ServerError)
      expect((error as Error).message).toMatch(/unable to reach|stopped while asking/)
      expect(Date.now() - started).toBeLessThan(5_000)
    }
  })

  it('answers at once for a call that names no window, and says nothing about it', async () => {
    const url = `http://127.0.0.1:${await freePort()}`
    const said: string[] = []
    const started = Date.now()
    const error = await callServer(
      connect(url, (line) => said.push(line)),
      'GET',
      '/v1/capacity',
      {
        reconnectMs: 0,
      }
    ).catch((e) => e)
    expect(error).toBeInstanceOf(ServerError)
    expect(said).toEqual([])
    expect(Date.now() - started).toBeLessThan(QUICK.windowMs)
  })

  it('keeps each line printable and bounded', () => {
    expect(printableLines('a\u001b[2Jb\n\nc‮d')).toEqual(['a?[2Jb', 'c\\u{202e}d'])
    expect(printableLines('x'.repeat(400))).toEqual([`${'x'.repeat(300)}… (+100 chars)`])
    const many = printableLines(Array.from({ length: 150 }, (_, i) => `line ${i}`).join('\n'))
    expect(many).toHaveLength(101)
    expect(many[100]).toBe('… (+50 lines)')
  })
})
