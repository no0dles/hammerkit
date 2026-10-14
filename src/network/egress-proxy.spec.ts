import { ChildProcess, spawn } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer, request, Server } from 'http'
import { AddressInfo, connect, createServer as createNetServer, Server as NetServer, Socket } from 'net'
import {
  EGRESS_PROXY_SCRIPT,
  EgressProxyEvent,
  getEgressProxyEnvironment,
  getProxyClientEnvironment,
  parseEgressProxyEvent,
} from './egress-proxy'

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

interface RunningProxy {
  port: number
  events: EgressProxyEvent[]
  process: ChildProcess
}

// the script as the container runs it: `node -e`, with its allow list in the env
// `preload` is a module the script runs after, to stand in for DNS
async function startProxy(
  hosts: string[],
  options: { needs?: string[]; bind?: string; preload?: string } = {}
): Promise<RunningProxy> {
  const port = await freePort()
  const preload = options.preload ? ['-r', options.preload] : []
  const child = spawn(process.execPath, [...preload, '-e', EGRESS_PROXY_SCRIPT], {
    env: { ...getEgressProxyEnvironment(hosts, options.needs ?? [], options.bind), HAMMERKIT_PROXY_PORT: `${port}` },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const events: EgressProxyEvent[] = []
  let buffer = ''
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.stdout!.on('data', (data: Buffer) => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const event = parseEgressProxyEvent(line)
        if (event) {
          events.push(event)
          if (event.type === 'ready') {
            resolve()
          }
        }
      }
    })
  })
  return { port, events, process: child }
}

function get(proxyPort: number, url: string, proxyHost = '127.0.0.1'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: proxyHost, port: proxyPort, method: 'GET', path: url }, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

// a CONNECT tunnel, then a plain HTTP request through it
function tunnel(proxyPort: number, authority: string, host: string, proxyHost = '127.0.0.1'): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, proxyHost, () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
    })
    let received = ''
    let tunneled = false
    socket.on('data', (data) => {
      received += data.toString()
      if (!tunneled && received.startsWith('HTTP/1.1 200')) {
        tunneled = true
        received = ''
        socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
      }
    })
    socket.on('end', () => resolve(received))
    socket.on('error', reject)
  })
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('egress proxy', () => {
  let upstream: Server
  let upstreamPort: number
  let proxy: RunningProxy

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`hello from ${req.headers.host}`)
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    upstreamPort = (upstream.address() as AddressInfo).port
    proxy = await startProxy(['localhost', '*.example.com'])
  })

  afterAll(async () => {
    proxy.process.kill()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })

  it('forwards an HTTP request to an allowed host', async () => {
    const response = await get(proxy.port, `http://localhost:${upstreamPort}/`)
    expect(response.status).toBe(200)
    expect(response.body).toBe(`hello from localhost:${upstreamPort}`)
  })

  it('tunnels a CONNECT to an allowed host', async () => {
    const response = await tunnel(proxy.port, `localhost:${upstreamPort}`, 'localhost')
    expect(response).toContain('hello from localhost')
  })

  it('refuses an HTTP request to a host not on the list and reports it once', async () => {
    const first = await get(proxy.port, `http://127.0.0.1:${upstreamPort}/`)
    const second = await get(proxy.port, `http://127.0.0.1:${upstreamPort}/again`)
    expect(first.status).toBe(403)
    expect(first.body).toContain('network access to 127.0.0.1 is not allowed')
    expect(second.status).toBe(403)
    await waitFor(() => proxy.events.some((e) => e.type === 'refused' && e.host === '127.0.0.1'))
    expect(proxy.events.filter((e) => e.type === 'refused' && e.host === '127.0.0.1')).toHaveLength(1)
  })

  it('refuses a CONNECT to a host not on the list', async () => {
    const response = await tunnel(proxy.port, 'example.com:443', 'example.com')
    expect(response).toContain('403 Forbidden')
    await waitFor(() => proxy.events.some((e) => e.type === 'refused' && e.host === 'example.com'))
    expect(proxy.events).toContainEqual({ type: 'refused', host: 'example.com' })
  })

  it('does not take the domain of a wildcard as allowed', async () => {
    const response = await tunnel(proxy.port, 'evil-example.com:443', 'evil-example.com')
    expect(response).toContain('403 Forbidden')
  })

  it('answers a request that is no proxy request with 400', async () => {
    const response = await get(proxy.port, '/')
    expect(response.status).toBe(400)
  })
})

describe('egress proxy destinations', () => {
  // the script's own env, past the schema, which takes no addresses: the
  // proxy resolves an address to itself
  it('refuses a name a wildcard allows when it resolves to the host', async () => {
    const proxy = await startProxy(['*.0.0.1'])
    try {
      const response = await tunnel(proxy.port, '127.0.0.1:80', '127.0.0.1')
      expect(response).toContain('403 Forbidden')
      await waitFor(() => proxy.events.some((e) => e.type === 'refused'))
      expect(proxy.events).toContainEqual({ type: 'refused', host: '127.0.0.1' })
      expect((await get(proxy.port, 'http://127.0.0.1/')).status).toBe(403)
    } finally {
      proxy.process.kill()
    }
  })

  it('refuses link-local addresses even for an exact name', async () => {
    const proxy = await startProxy(['169.254.169.254'])
    try {
      expect(await tunnel(proxy.port, '169.254.169.254:80', '169.254.169.254')).toContain('403 Forbidden')
      expect((await get(proxy.port, 'http://169.254.169.254/latest/meta-data')).status).toBe(403)
    } finally {
      proxy.process.kill()
    }
  })
})

describe('egress proxy with a name of several addresses', () => {
  let dir: string
  let upstream: Server
  let upstreamPort: number
  let proxy: RunningProxy

  beforeAll(async () => {
    upstream = createServer((req, res) => res.end(`hello from ${req.headers.host}`))
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    upstreamPort = (upstream.address() as AddressInfo).port
    // the first address has nothing listening, as an IPv6 address without a route
    dir = mkdtempSync(join(tmpdir(), 'hammerkit-proxy-'))
    const preload = join(dir, 'dns.js')
    writeFileSync(
      preload,
      `const dns = require('dns')
const lookup = dns.lookup
dns.lookup = (host, options, callback) => {
  if (host !== 'dual.test') return lookup(host, options, callback)
  const addresses = [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }]
  const cb = typeof options === 'function' ? options : callback
  if (options && options.all) cb(null, addresses)
  else cb(null, addresses[0].address, addresses[0].family)
}
`
    )
    proxy = await startProxy(['dual.test'], { preload })
  })

  afterAll(async () => {
    proxy.process.kill()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  })

  it('forwards an HTTP request to the address that answers', async () => {
    const response = await get(proxy.port, `http://dual.test:${upstreamPort}/`)
    expect(response.status).toBe(200)
    expect(response.body).toBe(`hello from dual.test:${upstreamPort}`)
  })

  it('tunnels a CONNECT to the address that answers', async () => {
    expect(await tunnel(proxy.port, `dual.test:${upstreamPort}`, 'dual.test')).toContain('hello from dual.test')
  })
})

describe('egress proxy TCP forwards', () => {
  let dir: string
  let echo: NetServer
  let echoPort: number
  let metaPort: number
  let proxy: RunningProxy

  // what the client sends, back to it; a refused forward closes the connection
  function exchange(port: number, message: string): Promise<string> {
    return new Promise((resolve) => {
      let received = ''
      const socket: Socket = connect(port, '127.0.0.2', () => {
        socket.end(message)
      })
      socket.on('data', (data: Buffer) => (received += data.toString()))
      socket.on('close', () => resolve(received))
      socket.on('error', () => undefined)
    })
  }

  // a CONNECT tunnel, then the message through it and its echo
  function echoThrough(authority: string, message: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let received = ''
      let tunneled = false
      const socket = connect(proxy.port, '127.0.0.2', () => {
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
      })
      socket.on('data', (data) => {
        received += data.toString()
        if (!tunneled && received.startsWith('HTTP/1.1 200')) {
          tunneled = true
          received = ''
          socket.write(message)
        } else if (tunneled && received === message) {
          socket.destroy()
          resolve(received)
        }
      })
      socket.on('end', () => resolve(received))
      socket.on('error', reject)
    })
  }

  beforeAll(async () => {
    // the proxy listens on the same port at 127.0.0.2, as it does at its own
    // address in its container
    echo = createNetServer({ allowHalfOpen: true }, (socket) => socket.pipe(socket))
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
    echoPort = (echo.address() as AddressInfo).port
    metaPort = await freePort()
    dir = mkdtempSync(join(tmpdir(), 'hammerkit-proxy-'))
    const preload = join(dir, 'dns.js')
    writeFileSync(
      preload,
      `const dns = require('dns')
const lookup = dns.lookup
const names = { 'db.test': '127.0.0.1', 'meta.test': '169.254.169.254', 'proxy.test': '127.0.0.2' }
dns.lookup = (host, options, callback) => {
  if (!names[host]) return lookup(host, options, callback)
  const address = { address: names[host], family: names[host].includes(':') ? 6 : 4 }
  const cb = typeof options === 'function' ? options : callback
  if (options && options.all) cb(null, [address])
  else cb(null, address.address, address.family)
}
`
    )
    proxy = await startProxy([`db.test:${echoPort}`, `meta.test:${metaPort}`], { preload, bind: 'proxy.test' })
  })

  afterAll(async () => {
    proxy.process.kill()
    await new Promise<void>((resolve) => echo.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  })

  it('forwards raw TCP on its port to its host', async () => {
    expect(await exchange(echoPort, 'PING')).toBe('PING')
  })

  it('refuses a forward whose host resolves to link-local', async () => {
    expect(await exchange(metaPort, 'GET / HTTP/1.0\r\n\r\n')).toBe('')
    await waitFor(() => proxy.events.some((e) => e.type === 'refused' && e.host === 'meta.test'))
    expect(proxy.events).toContainEqual({ type: 'refused', host: 'meta.test' })
  })

  it('tunnels a CONNECT to the host on the port of its forward only', async () => {
    expect(await echoThrough(`db.test:${echoPort}`, 'PING')).toBe('PING')
    expect(await tunnel(proxy.port, 'db.test:443', 'db.test', '127.0.0.2')).toContain('403 Forbidden')
    expect((await get(proxy.port, 'http://db.test/', '127.0.0.2')).status).toBe(403)
  })
})

describe('egress proxy for the needed services', () => {
  it('passes a needed service by its exact name, never as a pattern', async () => {
    const upstream = createServer((req, res) => res.end(`hello from ${req.headers.host}`))
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as AddressInfo).port
    // a name that would allow every .com host as a pattern
    const proxy = await startProxy([], { needs: ['localhost', '*.com'] })
    try {
      const response = await get(proxy.port, `http://localhost:${upstreamPort}/`)
      expect(response).toEqual({ status: 200, body: `hello from localhost:${upstreamPort}` })
      expect((await get(proxy.port, 'http://example.com/')).status).toBe(403)
      expect(await tunnel(proxy.port, 'example.com:443', 'example.com')).toContain('403 Forbidden')
    } finally {
      proxy.process.kill()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })
})

describe('egress proxy bound to one name', () => {
  it('listens on that address only', async () => {
    const proxy = await startProxy([], { bind: 'localhost' })
    try {
      // the address the name resolves to answers, another one of the host does not
      await expect(get(proxy.port, '/')).resolves.toMatchObject({ status: 400 })
      await expect(
        new Promise<void>((resolve, reject) => {
          const socket = connect(proxy.port, '127.0.0.2', () => {
            socket.destroy()
            resolve()
          })
          socket.on('error', reject)
        })
      ).rejects.toThrow()
    } finally {
      proxy.process.kill()
    }
  })
})

describe('proxy client environment', () => {
  it('points both spellings at the proxy and keeps the needed services direct', () => {
    const env = getProxyClientEnvironment(['db', 'cache'])
    expect(env.HTTPS_PROXY).toBe('http://hammerkit-proxy:3128')
    expect(env.http_proxy).toBe('http://hammerkit-proxy:3128')
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,db,cache')
    expect(env.no_proxy).toBe(env.NO_PROXY)
  })

  it('reads events and ignores other output', () => {
    expect(parseEgressProxyEvent('{"type":"refused","host":"a.com"}')).toEqual({ type: 'refused', host: 'a.com' })
    expect(parseEgressProxyEvent('{"type":"ready"}')).toEqual({ type: 'ready' })
    expect(parseEgressProxyEvent('{"type":"refused"}')).toBeNull()
    expect(parseEgressProxyEvent('npm warn')).toBeNull()
  })
})
