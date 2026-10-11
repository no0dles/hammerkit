import { DiscoveryDocument, DISCOVERY_PATH } from '../server/discovery'
import { HostServer } from './host-config'

const TIMEOUT_MS = 10_000
const WRITE_TIMEOUT_MS = 30_000

export class ServerError extends Error {}

// Text from the server or the identity provider is shown to the user: no
// control characters, so it can't rewrite the terminal.
export function printable(value: unknown): string {
  return String(value)
    .replace(/\p{Cc}/gu, '?')
    .slice(0, 300)
}

async function getJson(url: string, token?: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    throw new ServerError(`unable to reach ${url}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (response.status === 401) {
    throw new ServerError(`${url} did not accept the token`)
  }
  if (!response.ok) {
    throw new ServerError(`${url} answered ${response.status}`)
  }
  return response.json()
}

// What the server says it is. The issuer registered with `remote add` has to be
// one it accepts, otherwise a login would send the user to an identity provider
// the server does not trust.
export async function getDiscovery(server: HostServer): Promise<DiscoveryDocument> {
  const document = (await getJson(`${server.url}${DISCOVERY_PATH}`)) as DiscoveryDocument
  if (document?.name !== 'hammerkit' || !Array.isArray(document.issuers)) {
    throw new ServerError(`${server.url} is not a hammerkit server`)
  }
  return document
}

export interface MeResponse {
  iss: string
  sub: string
  accounts: string[]
  default: string | null
  // the build files the caller may publish, `*` for any
  publish?: string[]
  // the build files the caller may propose versions of
  propose?: string[]
  // the accounts the caller may request runs on, an admin of the account approves them
  request?: string[]
}

export async function getMe(server: HostServer, token: string): Promise<MeResponse> {
  return (await getJson(`${server.url}/v1/me`, token)) as MeResponse
}

export interface ServerAnswer<T = any> {
  status: number
  body: T
}

// A call that changes something, or whose answer the caller tells apart by status.
// Anything but 2xx is an error carrying what the server said about it.
export async function callServer<T = any>(
  server: HostServer,
  token: string,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown
): Promise<ServerAnswer<T>> {
  const url = `${server.url}${path}`
  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(method === 'GET' ? TIMEOUT_MS : WRITE_TIMEOUT_MS),
    })
  } catch (e) {
    throw new ServerError(`unable to reach ${url}: ${printable(e instanceof Error ? e.message : e)}`)
  }
  let answer: any
  try {
    answer = await response.json()
  } catch {
    answer = undefined
  }
  if (response.status === 401) {
    throw new ServerError(`${server.url} did not accept the token`)
  }
  if (!response.ok) {
    const said = answer && typeof answer.error === 'string' ? `: ${printable(answer.error)}` : ''
    throw new ServerError(`${server.url} answered ${response.status}${said}`)
  }
  return { status: response.status, body: answer as T }
}
