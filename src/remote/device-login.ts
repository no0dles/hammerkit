import { HostServer } from './host-config'
import { getDiscovery, printable, ServerError } from './server-client'

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
const DEFAULT_INTERVAL_SECONDS = 5
const SLOW_DOWN_SECONDS = 5
const FETCH_TIMEOUT_MS = 10_000
const MIN_INTERVAL_SECONDS = 1
const MAX_LIFETIME_SECONDS = 30 * 60

export interface DeviceLoginOptions {
  // told the user what to open and which code to enter
  prompt: (message: string) => void
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface DeviceLoginResult {
  accessToken: string
  // ms since epoch
  expiresAt: number
  // what the sign-in asked for, to be pinned for the next one
  pinned: { clientId: string; audience: string; scope: string }
}

const isLoopbackHost = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname)

// An endpoint must use the scheme of the issuer: loopback http is for a test
// identity provider on this machine only, never beside an https issuer.
function isSecure(url: unknown, issuer: string): url is string {
  if (typeof url !== 'string') {
    return false
  }
  try {
    const parsed = new URL(url)
    const issuerHost = new URL(issuer)
    return (
      parsed.protocol === 'https:' ||
      (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname) && issuerHost.protocol === 'http:')
    )
  } catch {
    return false
  }
}

// Redirects are refused: a 307 would send the device code to another place.
async function fetchJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  let response: Response
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (e) {
    throw new ServerError(`unable to reach ${url}: ${printable(e instanceof Error ? e.message : e)}`)
  }
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

function postForm(url: string, form: Record<string, string>) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form),
  })
}

// `offline_access` asks for a refresh token, which is never kept.
function normalizeScope(scope: string): string {
  return scope
    .split(/\s+/)
    .filter((part) => part && part !== 'offline_access')
    .join(' ')
}

// The token is sent to the hammerkit server next, so it has to be meant for it:
// a server that talked the user into a token for another service (Graph, a
// cloud API) gets nothing.
function checkToken(token: string, issuer: string, audience: string): void {
  let payload: any
  try {
    payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
  } catch {
    // handled below
  }
  const audiences = Array.isArray(payload?.aud) ? payload.aud : [payload?.aud]
  if (payload?.iss !== issuer || !audiences.includes(audience)) {
    throw new ServerError(
      `the identity provider issued a token that is not meant for ${printable(audience)}, it is not sent to the server`
    )
  }
}

function abortable(sleep: (ms: number) => Promise<void>, signal: AbortSignal | undefined) {
  return async (ms: number) => {
    if (signal?.aborted) {
      throw new ServerError('login was cancelled')
    }
    await sleep(ms)
  }
}

// OAuth device authorization grant (RFC 8628) against the issuer the server
// names for the issuer registered with `remote add`. Works headless: nothing is
// opened, the user visits the address on any device. The refresh token, if the
// issuer sends one, is dropped on purpose: what is kept is one short-lived
// access token, and signing in again is the way to renew it.
export async function deviceLogin(server: HostServer, options: DeviceLoginOptions): Promise<DeviceLoginResult> {
  const sleep = abortable(options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))), options.signal)
  const now = options.now ?? Date.now

  const discovery = await getDiscovery(server)
  const offered = discovery.issuers.find((i) => i.issuer === server.issuer)
  if (!offered) {
    const accepted = discovery.issuers.map((i) => printable(i.issuer)).join(', ')
    throw new ServerError(`${server.url} does not accept tokens from ${server.issuer} (it accepts ${accepted})`)
  }
  if (!offered.clientId) {
    throw new ServerError(`${server.url} offers no sign-in for ${server.issuer}, it needs a token obtained elsewhere`)
  }

  // What was pinned (by `remote add` or an earlier login) wins; the server can
  // only offer the same, never something else to sign in with.
  const wanted = {
    clientId: offered.clientId,
    audience: offered.audience,
    scope: normalizeScope(offered.scope),
  }
  const pinned = {
    clientId: server.clientId ?? wanted.clientId,
    audience: server.audience ?? wanted.audience,
    scope: normalizeScope(server.scope ?? wanted.scope),
  }
  for (const key of ['clientId', 'audience', 'scope'] as const) {
    if (pinned[key] !== wanted[key]) {
      throw new ServerError(
        `${server.url} now asks for ${key} "${printable(wanted[key])}", but "${printable(pinned[key])}" is pinned. ` +
          `If that is expected, register the server again with: hammerkit remote add <name> ${server.url} ` +
          `--issuer ${server.issuer} --force`
      )
    }
  }
  options.prompt(
    `signing in to ${server.url} through ${server.issuer}\n` +
      `  client ${printable(pinned.clientId)}, audience ${printable(pinned.audience)}, scope ${printable(pinned.scope)}`
  )

  const base = server.issuer.replace(/\/+$/, '')
  const described = await fetchJson(`${base}/.well-known/openid-configuration`)
  const metadata = described.body as Record<string, unknown>
  if (described.status !== 200) {
    throw new ServerError(`${server.issuer} answered ${described.status} for its configuration`)
  }
  if (metadata.issuer !== server.issuer) {
    throw new ServerError(`${server.issuer} describes itself as ${printable(metadata.issuer)}`)
  }
  if (
    !isSecure(metadata.device_authorization_endpoint, server.issuer) ||
    !isSecure(metadata.token_endpoint, server.issuer)
  ) {
    throw new ServerError(`${server.issuer} does not support the device authorization grant over https`)
  }

  const started = await postForm(metadata.device_authorization_endpoint, {
    client_id: pinned.clientId,
    scope: pinned.scope,
    audience: pinned.audience,
  })
  const device = started.body
  if (started.status !== 200 || typeof device.device_code !== 'string' || typeof device.user_code !== 'string') {
    throw new ServerError(
      `${server.issuer} refused the sign-in: ${printable(device.error_description ?? device.error ?? started.status)}`
    )
  }

  const address = device.verification_uri_complete ?? device.verification_uri
  if (!isSecure(address, server.issuer)) {
    throw new ServerError(`${server.issuer} sent a sign-in address that is not https`)
  }
  options.prompt(`To sign in, open ${printable(address)} and enter the code ${printable(device.user_code)}`)

  const lifetimeSeconds = typeof device.expires_in === 'number' ? device.expires_in : 600
  const deadline = now() + Math.min(Math.max(lifetimeSeconds, 0), MAX_LIFETIME_SECONDS) * 1000
  const intervalSeconds = typeof device.interval === 'number' ? device.interval : DEFAULT_INTERVAL_SECONDS
  let interval = Math.max(intervalSeconds, MIN_INTERVAL_SECONDS) * 1000
  for (;;) {
    await sleep(interval)
    if (now() > deadline) {
      throw new ServerError('the code expired, run the login again')
    }
    const answer = await postForm(metadata.token_endpoint, {
      grant_type: GRANT_TYPE,
      device_code: device.device_code,
      client_id: pinned.clientId,
    })
    if (answer.status === 200 && typeof answer.body.access_token === 'string') {
      checkToken(answer.body.access_token, server.issuer, pinned.audience)
      const lifetime = typeof answer.body.expires_in === 'number' ? answer.body.expires_in : 3600
      return { accessToken: answer.body.access_token, expiresAt: now() + lifetime * 1000, pinned }
    }
    switch (answer.body.error) {
      case 'authorization_pending':
        break
      case 'slow_down':
        interval += SLOW_DOWN_SECONDS * 1000
        break
      case 'access_denied':
        throw new ServerError('the sign-in was denied')
      case 'expired_token':
        throw new ServerError('the code expired, run the login again')
      default:
        throw new ServerError(
          `${server.issuer} refused the sign-in: ${printable(
            answer.body.error_description ?? answer.body.error ?? answer.status
          )}`
        )
    }
  }
}
