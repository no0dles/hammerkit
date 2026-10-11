import { DiscoveryDocument, DISCOVERY_PATH } from '../server/discovery'
import { HostServer } from './host-config'

const TIMEOUT_MS = 10_000

export class ServerError extends Error {}

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
}

export async function getMe(server: HostServer, token: string): Promise<MeResponse> {
  return (await getJson(`${server.url}/v1/me`, token)) as MeResponse
}
