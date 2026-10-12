// The egress proxy of a task or service with `network: { allow: [hosts] }`.
// It runs in its own container (a pod on Kubernetes) next to the item, on the
// item's internal network, and is the item's only way out: HTTP requests and
// `CONNECT` tunnels to an allowed host pass, everything else gets a 403 and a
// `refused` event on stdout. The script is passed to `node -e`, so the proxy
// needs no image of its own, only a stock Node image.

export const EGRESS_PROXY_IMAGE = 'node:24-alpine'
export const EGRESS_PROXY_PORT = 3128
// the name the item reaches the proxy under
export const EGRESS_PROXY_HOST = 'hammerkit-proxy'

export type EgressProxyEvent = { type: 'ready' } | { type: 'refused'; host: string }

// Kept free of anything but Node's own modules. The host rule is the one of
// matchesHost in planner/work-network.ts.
export const EGRESS_PROXY_SCRIPT = `
const http = require('http')
const net = require('net')
const allow = JSON.parse(process.env.HAMMERKIT_ALLOW || '[]').map((h) => h.toLowerCase())
const port = parseInt(process.env.HAMMERKIT_PROXY_PORT || '${EGRESS_PROXY_PORT}', 10)
const refused = new Set()
function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\\n')
}
function isAllowed(host) {
  const name = host.toLowerCase().replace(/\\.$/, '')
  return allow.some((rule) => (rule.startsWith('*.') ? name.endsWith(rule.substring(1)) : name === rule))
}
function refuse(host) {
  if (!refused.has(host)) {
    refused.add(host)
    emit({ type: 'refused', host })
  }
}
function parseAuthority(value) {
  const match = /^\\[([^\\]]+)\\](?::(\\d+))?$/.exec(value) || /^([^:]+)(?::(\\d+))?$/.exec(value)
  return match ? { host: match[1], port: match[2] ? parseInt(match[2], 10) : 443 } : null
}
const server = http.createServer((req, res) => {
  let url
  try {
    url = new URL(req.url)
  } catch (e) {
    res.writeHead(400, { 'content-type': 'text/plain' })
    res.end('hammerkit: only proxy requests are served\\n')
    return
  }
  if (url.protocol !== 'http:' || !isAllowed(url.hostname)) {
    refuse(url.hostname)
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('hammerkit: network access to ' + url.hostname + ' is not allowed\\n')
    return
  }
  const headers = Object.assign({}, req.headers)
  delete headers['proxy-connection']
  delete headers['proxy-authorization']
  // the absolute URL wins over a Host header that disagrees
  headers.host = url.host
  const upstream = http.request(
    { host: url.hostname, port: url.port || 80, method: req.method, path: url.pathname + url.search, headers },
    (response) => {
      res.writeHead(response.statusCode || 502, response.headers)
      response.pipe(res)
    }
  )
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' })
    }
    res.end()
  })
  req.pipe(upstream)
})
server.on('connect', (req, socket, head) => {
  const target = parseAuthority(req.url || '')
  socket.on('error', () => socket.destroy())
  if (!target || !isAllowed(target.host)) {
    refuse(target ? target.host : String(req.url))
    socket.end('HTTP/1.1 403 Forbidden\\r\\ncontent-type: text/plain\\r\\n\\r\\nhammerkit: network access is not allowed\\n')
    return
  }
  let established = false
  const upstream = net.connect(target.port, target.host, () => {
    established = true
    socket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n')
    if (head && head.length > 0) {
      upstream.write(head)
    }
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => {
    if (established) {
      socket.destroy()
    } else {
      socket.end('HTTP/1.1 502 Bad Gateway\\r\\n\\r\\n')
    }
  })
  socket.on('close', () => upstream.destroy())
})
server.listen(port, () => emit({ type: 'ready' }))
process.on('SIGTERM', () => process.exit(0))
`

export function getEgressProxyCommand(): string[] {
  return ['node', '-e', EGRESS_PROXY_SCRIPT]
}

export function getEgressProxyEnvironment(hosts: string[]): { [key: string]: string } {
  return { HAMMERKIT_ALLOW: JSON.stringify(hosts), HAMMERKIT_PROXY_PORT: `${EGRESS_PROXY_PORT}` }
}

// The variables that send the item's HTTP(S) through the proxy, both spellings
// since tools read either. The services it needs are reached directly.
export function getProxyClientEnvironment(directHosts: string[]): { [key: string]: string } {
  const proxy = `http://${EGRESS_PROXY_HOST}:${EGRESS_PROXY_PORT}`
  const noProxy = ['localhost', '127.0.0.1', ...directHosts].join(',')
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    NO_PROXY: noProxy,
    http_proxy: proxy,
    https_proxy: proxy,
    no_proxy: noProxy,
  }
}

// The proxy variables emptied: a healthcheck checks the service itself, and
// tools that ignore NO_PROXY (busybox wget) would ask the proxy for localhost.
export function getProxylessEnvironment(env: { [key: string]: string }): { [key: string]: string } | undefined {
  const proxyKeys = Object.keys(env).filter((key) => /^(https?|no)_proxy$/i.test(key))
  return proxyKeys.length > 0 ? Object.fromEntries(proxyKeys.map((key) => [key, ''])) : undefined
}

// One line of the proxy's stdout, null for anything else.
export function parseEgressProxyEvent(line: string): EgressProxyEvent | null {
  try {
    const value = JSON.parse(line)
    if (value?.type === 'ready') {
      return { type: 'ready' }
    }
    if (value?.type === 'refused' && typeof value.host === 'string') {
      return { type: 'refused', host: value.host }
    }
  } catch {
    // not an event
  }
  return null
}

export function formatRefusedHost(host: string): string {
  return `network: refused ${host}`
}
