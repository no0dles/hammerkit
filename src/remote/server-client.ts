import { DiscoveryDocument, DISCOVERY_PATH } from '../server/discovery'
import { Repeat, showUrl } from '../harness/reconnect'
import { PublicConnection, request, ServerConnection } from '../harness/sandbox-client'
import { HostServer } from './host-config'

const TIMEOUT_MS = 10_000
const WRITE_TIMEOUT_MS = 30_000

export class ServerError extends Error {
  // what the server answered, when it did
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

// a reason from the network, such as a TLS or DNS error, can hold control characters
const failWith = (message: string) => new ServerError(printable(message))

// Text from the server or the identity provider is shown to the user: no
// control characters, so it can't rewrite the terminal, and format characters
// (bidi overrides, zero-width) written out, so text reads in the order it runs.
// Long text is cut, and says how much was.
export function printable(value: unknown): string {
  const text = printableWhole(value)
  return text.length > 300 ? `${text.slice(0, 300)}… (+${text.length - 300} chars)` : text
}

// Text of several lines, such as every problem of a refused publish: each line made
// printable and cut like `printable`, one per line, and at most `MAX_LINES` of them.
const MAX_LINES = 100
export function printableLines(value: unknown): string[] {
  const lines = String(value)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
  const shown = lines.slice(0, MAX_LINES).map(printable)
  return lines.length > MAX_LINES ? [...shown, `… (+${lines.length - MAX_LINES} lines)`] : shown
}

// The same, never cut: for what somebody decides on, such as a command.
export function printableWhole(value: unknown): string {
  return String(value)
    .replace(/\p{Cc}/gu, '?')
    .replace(/\p{Cf}/gu, (char) => `\\u{${char.codePointAt(0)?.toString(16)}}`)
}

// A document of the server, read as the connection reads it: a 401 carries its status, as
// the caller tells a token the server refused from a server that is not there.
async function getJson(connection: ServerConnection | PublicConnection, path: string): Promise<unknown> {
  const url = `${showUrl(connection.url)}${path}`
  const response = await request(connection, 'GET', path, { timeoutMs: TIMEOUT_MS, fail: failWith })
  if (response.status === 401) {
    throw new ServerError(`${url} did not accept the token`, 401)
  }
  if (!response.ok) {
    throw new ServerError(`${url} answered ${response.status}`, response.status)
  }
  return response.json()
}

// What the server says it is. The issuer registered with `remote add` has to be
// one it accepts, otherwise a login would send the user to an identity provider
// the server does not trust. No token is sent: the document is for anybody.
export async function getDiscovery(
  server: HostServer,
  options: { say?: (line: string) => void; signal?: AbortSignal } = {}
): Promise<DiscoveryDocument> {
  const connection: PublicConnection = { url: server.url, say: options.say, signal: options.signal }
  const document = (await getJson(connection, DISCOVERY_PATH)) as DiscoveryDocument
  if (document?.name !== 'hammerkit' || !Array.isArray(document.issuers)) {
    throw new ServerError(`${server.url} is not a hammerkit server`)
  }
  return document
}

export interface MeResponse {
  iss: string
  sub: string
  // `use` runs at once and approves, `request` waits for somebody who uses the account
  accounts: { name: string; level: 'use' | 'request' }[]
  // the repositories (host/path patterns) the caller may run from a git ref
  repos: string[]
  // what the caller may do with the build files
  builds: 'run' | 'propose' | 'publish' | null
  // every run of the server may be seen; left out by servers before it
  observe?: boolean
}

export async function getMe(connection: ServerConnection): Promise<MeResponse> {
  return (await getJson(connection, '/v1/me')) as MeResponse
}

export interface ServerAnswer<T = any> {
  status: number
  body: T
}

/**
 * A call of the server: its answer, or an error that says what the server answered. The call
 * is made the way the sandbox calls are (`request`): a server that is away is waited for within
 * the window of the connection (`reconnectMs` shortens it, 0 is no wait), and the call is sent
 * again only as `repeat` allows. A read, or a call that ends the same however often the server
 * takes it, is `always`; by default a POST is `unsent`, sent again only when the server certainly
 * did not take it. A call that times out counts as lost, so an `always` call that is slow is
 * sent again too, for up to the window.
 */
export async function callServer<T = any>(
  connection: ServerConnection,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  options: { body?: unknown; repeat?: Repeat; reconnectMs?: number } = {}
): Promise<ServerAnswer<T>> {
  const response = await request(connection, method, path, {
    body: options.body,
    repeat: options.repeat,
    reconnectMs: options.reconnectMs,
    timeoutMs: method === 'GET' ? TIMEOUT_MS : WRITE_TIMEOUT_MS,
    fail: failWith,
  })
  const shown = showUrl(connection.url)
  if (response.status === 401) {
    throw new ServerError(`${shown} did not accept the token`, 401)
  }
  let answer: any
  try {
    answer = await response.json()
  } catch {
    answer = undefined
  }
  if (!response.ok) {
    const lines = answer && typeof answer.error === 'string' ? printableLines(answer.error) : []
    // a refused publish says every problem, each on a line of its own
    const said =
      lines.length > 1 ? `:\n${lines.map((line) => `  ${line}`).join('\n')}` : lines.length === 1 ? `: ${lines[0]}` : ''
    throw new ServerError(`${shown} answered ${response.status}${said}`, response.status)
  }
  return { status: response.status, body: answer as T }
}
