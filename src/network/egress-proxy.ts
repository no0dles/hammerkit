// The egress proxy of a task or service with `network: { allow: [hosts] }`.
// It runs in its own container (a pod on Kubernetes) next to the item, on a
// network only the item and the proxy join, and is the item's only way out: HTTP requests and
// `CONNECT` tunnels to an allowed host pass, everything else gets a 403 and a
// `refused` event on stdout. For each `host:port` entry it also listens on that
// port and forwards raw TCP to that host, which the item reaches under the
// host's name. The script is passed to `node -e`, so the proxy
// needs no image of its own, only a stock Node image.

import { getEffectiveNetwork, getTcpForwards, WorkNetwork } from '../planner/work-network'
import { PROXY_PORT } from '../schema/network-schema'

// Pinned, so the code behind the boundary is the same on every host. To bump
// it, take the index digest of the tag (`docker buildx imagetools inspect
// node:24-alpine`). The port relay runs in it too.
export const EGRESS_PROXY_IMAGE =
  'node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1'
export const EGRESS_PROXY_PORT = PROXY_PORT
// the name the item reaches the proxy under
export const EGRESS_PROXY_HOST = 'hammerkit-proxy'

// `https-url`: an allowed host asked for by its https URL instead of through
// a CONNECT tunnel, which the proxy doesn't serve
export type EgressProxyEvent =
  | { type: 'ready' }
  | { type: 'refused'; host: string }
  | { type: 'https-url'; host: string }

// Kept free of anything but Node's own modules. The host rule is the one of
// matchesHost in planner/work-network.ts. A name a wildcard allows must not
// resolve to the host or a private network, and none to link-local.
export const EGRESS_PROXY_SCRIPT = `
const http = require('http')
const net = require('net')
const dns = require('dns')
const entries = JSON.parse(process.env.HAMMERKIT_ALLOW || '[]').map((h) => h.toLowerCase())
// names and patterns for HTTP(S)
const allow = entries.filter((e) => !e.includes(':'))
// names and ports for raw TCP, each forwarded on its port
const forwards = entries
  .filter((e) => e.includes(':'))
  .map((e) => ({ host: e.substring(0, e.lastIndexOf(':')), port: parseInt(e.substring(e.lastIndexOf(':') + 1), 10) }))
// entries of both kinds that a ceiling allows only through a pattern: they
// reach no private address, like a pattern
const publicOnly = JSON.parse(process.env.HAMMERKIT_PUBLIC_ONLY || '[]').map((h) => h.toLowerCase())
// the names of the needed services, for tools that ignore NO_PROXY: exact
// names only, never patterns
const needs = JSON.parse(process.env.HAMMERKIT_NEEDS || '[]').map((h) => h.toLowerCase())
const port = parseInt(process.env.HAMMERKIT_PROXY_PORT || '${EGRESS_PROXY_PORT}', 10)
// the name whose address the proxy listens on, every address when unset
const bind = process.env.HAMMERKIT_PROXY_BIND
const refused = new Set()
const httpsUrls = new Set()
function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\\n')
}
// the rule that allows a host and port: its exact name, a wildcard, or none
function allowedBy(host, port) {
  const name = host.toLowerCase().replace(/\\.$/, '')
  if (needs.includes(name)) {
    return 'exact'
  }
  const named = []
  if (allow.includes(name)) {
    named.push(name)
  }
  if (forwards.some((f) => f.host === name && f.port === port)) {
    named.push(name + ':' + port)
  }
  if (named.length > 0) {
    return named.some((entry) => !publicOnly.includes(entry)) ? 'exact' : 'wildcard'
  }
  return allow.some((rule) => rule.startsWith('*.') && name.endsWith(rule.substring(1))) ? 'wildcard' : null
}
function ipv4(address) {
  const mapped = /^::ffff:(\\d+\\.\\d+\\.\\d+\\.\\d+)$/i.exec(address)
  const value = mapped ? mapped[1] : address
  return net.isIPv4(value) ? value.split('.').map(Number) : null
}
// never allowed: the cloud metadata service lives there
function isLinkLocal(address) {
  const v4 = ipv4(address)
  return v4 ? v4[0] === 169 && v4[1] === 254 : /^fe[89ab]/i.test(address)
}
// the host, its private networks (Docker's bridges among them) and the
// cluster: only for a name listed exactly, such as a needed service
function isInternal(address) {
  const v4 = ipv4(address)
  if (v4) {
    const [a, b] = v4
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b < 128) ||
      (a === 172 && b >= 16 && b < 32) ||
      (a === 192 && b === 168)
    )
  }
  return address === '::' || address === '::1' || /^f[cd]/i.test(address)
}
// The proxy resolves the name itself and connects only to the addresses it
// checked, each in turn (a name can have an IPv6 address the network has no
// route to).
function resolve(host, rule, callback) {
  dns.lookup(host, { all: true }, (err, addresses) => {
    if (err || addresses.length === 0) {
      callback(err || new Error('no address'), null)
      return
    }
    const blocked = addresses.some((a) => isLinkLocal(a.address) || (rule !== 'exact' && isInternal(a.address)))
    callback(null, blocked ? null : addresses)
  })
}
// connection options that reach the checked addresses and nothing else
function connectTo(host, addresses) {
  const lookup = (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback
    if (typeof options === 'object' && options && options.all) {
      cb(null, addresses)
    } else {
      cb(null, addresses[0].address, addresses[0].family)
    }
  }
  return { host, lookup, autoSelectFamily: true }
}
function refuse(host) {
  if (!refused.has(host)) {
    refused.add(host)
    emit({ type: 'refused', host })
  }
}
function httpsUrl(host) {
  if (!httpsUrls.has(host)) {
    httpsUrls.add(host)
    emit({ type: 'https-url', host })
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
  // BusyBox wget sends an https URL to the proxy as it is: TLS belongs between
  // the client and the host, so only a CONNECT tunnel reaches an https host
  if (url.protocol === 'https:' && allowedBy(url.hostname, parseInt(url.port || '443', 10))) {
    httpsUrl(url.hostname)
    res.writeHead(501, { 'content-type': 'text/plain' })
    res.end('hammerkit: ' + url.hostname + ' is allowed through a CONNECT tunnel only, not by its https URL\\n')
    return
  }
  const rule = url.protocol === 'http:' ? allowedBy(url.hostname, parseInt(url.port || '80', 10)) : null
  if (!rule) {
    refuse(url.hostname)
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('hammerkit: network access to ' + url.hostname + ' is not allowed\\n')
    return
  }
  resolve(url.hostname, rule, (err, addresses) => {
    if (err) {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end()
      return
    }
    if (!addresses) {
      refuse(url.hostname)
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end('hammerkit: ' + url.hostname + ' resolves to an address that is not allowed\\n')
      return
    }
    const headers = Object.assign({}, req.headers)
    delete headers['proxy-connection']
    delete headers['proxy-authorization']
    // the absolute URL wins over a Host header that disagrees
    headers.host = url.host
    const upstream = http.request(
      Object.assign(connectTo(url.hostname, addresses), {
        port: url.port || 80,
        method: req.method,
        path: url.pathname + url.search,
        headers,
      }),
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
})
server.on('connect', (req, socket, head) => {
  const target = parseAuthority(req.url || '')
  socket.on('error', () => socket.destroy())
  const rule = target ? allowedBy(target.host, target.port) : null
  if (!rule) {
    refuse(target ? target.host : String(req.url))
    socket.end('HTTP/1.1 403 Forbidden\\r\\ncontent-type: text/plain\\r\\n\\r\\nhammerkit: network access is not allowed\\n')
    return
  }
  resolve(target.host, rule, (err, addresses) => {
    if (err) {
      socket.end('HTTP/1.1 502 Bad Gateway\\r\\n\\r\\n')
      return
    }
    if (!addresses) {
      refuse(target.host)
      socket.end('HTTP/1.1 403 Forbidden\\r\\ncontent-type: text/plain\\r\\n\\r\\nhammerkit: network access is not allowed\\n')
      return
    }
    let established = false
    const upstream = net.connect(Object.assign(connectTo(target.host, addresses), { port: target.port }), () => {
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
})
// A TCP forward: each connection goes to the checked addresses of its host,
// on the same port.
function forward(target) {
  return net.createServer({ allowHalfOpen: true }, (client) => {
    client.on('error', () => client.destroy())
    resolve(target.host, allowedBy(target.host, target.port), (err, addresses) => {
      if (err || !addresses) {
        if (!err) {
          refuse(target.host)
        }
        client.destroy()
        return
      }
      const upstream = net.connect(Object.assign(connectTo(target.host, addresses), { port: target.port }))
      upstream.on('error', () => client.destroy())
      client.on('close', () => upstream.destroy())
      client.pipe(upstream)
      upstream.pipe(client)
    })
  })
}
function listen(address) {
  const servers = [{ server, port }].concat(forwards.map((f) => ({ server: forward(f), port: f.port })))
  let pending = servers.length
  for (const entry of servers) {
    entry.server.on('error', (err) => {
      process.stderr.write('hammerkit: unable to listen on port ' + entry.port + ': ' + err.message + '\\n')
      process.exit(1)
    })
    entry.server.listen(entry.port, address, () => {
      pending--
      if (pending === 0) {
        emit({ type: 'ready' })
      }
    })
  }
}
if (bind) {
  dns.lookup(bind, { family: 4 }, (err, address) => {
    if (err) {
      process.stderr.write('hammerkit: unable to resolve ' + bind + ': ' + err.message + '\\n')
      process.exit(1)
    }
    listen(address)
  })
} else {
  listen(undefined)
}
process.on('SIGTERM', () => process.exit(0))
`

export function getEgressProxyCommand(): string[] {
  return ['node', '-e', EGRESS_PROXY_SCRIPT]
}

// `needs` are the names of the needed services, allowed as exactly those
// names. `bind` is the name the proxy listens on alone, so that nothing on its
// other networks reaches it. `publicOnly` are the entries of `hosts` that reach
// no private address (see WorkNetwork).
export function getEgressProxyEnvironment(
  hosts: string[],
  needs: string[],
  bind?: string,
  publicOnly: string[] = []
): { [key: string]: string } {
  return {
    HAMMERKIT_ALLOW: JSON.stringify(hosts),
    ...(publicOnly.length > 0 ? { HAMMERKIT_PUBLIC_ONLY: JSON.stringify(publicOnly) } : {}),
    HAMMERKIT_NEEDS: JSON.stringify(needs),
    HAMMERKIT_PROXY_PORT: `${EGRESS_PROXY_PORT}`,
    ...(bind ? { HAMMERKIT_PROXY_BIND: bind } : {}),
  }
}

// The proxy of a task or service: the hosts of its network in this run (under
// the run's ceiling), and the names of the services it needs, on every runtime.
export function getItemProxyEnvironment(
  item: { data: { network: WorkNetwork; networkCeiling: WorkNetwork | null }; needs: { name: string }[] },
  bind?: string
): { [key: string]: string } {
  const network = getEffectiveNetwork(item.data)
  return getEgressProxyEnvironment(
    network.type === 'allow' ? network.hosts : [],
    item.needs.map((need) => need.name),
    bind,
    network.type === 'allow' ? network.publicOnly ?? [] : []
  )
}

// The variables that send the item's HTTP(S) through the proxy, both spellings
// since tools read either. The services it needs are reached directly.
// The ports the proxy of a network listens on: its own, and one per TCP forward.
export function getEgressProxyPorts(network: WorkNetwork): number[] {
  return [EGRESS_PROXY_PORT, ...getTcpForwards(network).map((forward) => forward.port)]
}

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
    if ((value?.type === 'refused' || value?.type === 'https-url') && typeof value.host === 'string') {
      return { type: value.type, host: value.host }
    }
  } catch {
    // not an event
  }
  return null
}

export function formatRefusedHost(host: string): string {
  return `network: refused ${host}`
}

// The line of an event other than `ready` in the item's log.
export function formatEgressProxyEvent(event: Exclude<EgressProxyEvent, { type: 'ready' }>): string {
  if (event.type === 'https-url') {
    return (
      `network: ${event.host} is allowed, but the client asked the proxy for its https URL instead of ` +
      'tunneling with CONNECT (BusyBox wget does), use curl or GNU wget'
    )
  }
  return formatRefusedHost(event.host)
}
