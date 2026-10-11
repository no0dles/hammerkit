import { HostServer } from './host-config'
import { getDiscovery, ServerError } from './server-client'

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
const DEFAULT_INTERVAL_SECONDS = 5
const SLOW_DOWN_SECONDS = 5
const FETCH_TIMEOUT_MS = 10_000

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
}

function isSecure(url: unknown): url is string {
  if (typeof url !== 'string') {
    return false
  }
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'https:' ||
      (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
    )
  } catch {
    return false
  }
}

async function postForm(url: string, form: Record<string, string>): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
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
    const accepted = discovery.issuers.map((i) => i.issuer).join(', ')
    throw new ServerError(`${server.url} does not accept tokens from ${server.issuer} (it accepts ${accepted})`)
  }
  if (!offered.clientId) {
    throw new ServerError(`${server.url} offers no sign-in for ${server.issuer}, it needs a token obtained elsewhere`)
  }

  const base = server.issuer.replace(/\/+$/, '')
  const metadata = (await (
    await fetch(`${base}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  ).json()) as Record<string, unknown>
  if (metadata.issuer !== server.issuer) {
    throw new ServerError(`${server.issuer} describes itself as ${String(metadata.issuer)}`)
  }
  if (!isSecure(metadata.device_authorization_endpoint) || !isSecure(metadata.token_endpoint)) {
    throw new ServerError(`${server.issuer} does not support the device authorization grant over https`)
  }

  const started = await postForm(metadata.device_authorization_endpoint, {
    client_id: offered.clientId,
    scope: offered.scope,
    audience: offered.audience,
  })
  const device = started.body
  if (started.status !== 200 || typeof device.device_code !== 'string' || typeof device.user_code !== 'string') {
    throw new ServerError(
      `${server.issuer} refused the sign-in: ${device.error_description ?? device.error ?? started.status}`
    )
  }

  const address = device.verification_uri_complete ?? device.verification_uri
  options.prompt(`To sign in, open ${address} and enter the code ${device.user_code}`)

  const deadline = now() + (typeof device.expires_in === 'number' ? device.expires_in : 600) * 1000
  let interval = (typeof device.interval === 'number' ? device.interval : DEFAULT_INTERVAL_SECONDS) * 1000
  for (;;) {
    await sleep(interval)
    if (now() > deadline) {
      throw new ServerError('the code expired, run the login again')
    }
    const answer = await postForm(metadata.token_endpoint, {
      grant_type: GRANT_TYPE,
      device_code: device.device_code,
      client_id: offered.clientId,
    })
    if (answer.status === 200 && typeof answer.body.access_token === 'string') {
      const lifetime = typeof answer.body.expires_in === 'number' ? answer.body.expires_in : 3600
      return { accessToken: answer.body.access_token, expiresAt: now() + lifetime * 1000 }
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
          `${server.issuer} refused the sign-in: ${answer.body.error_description ?? answer.body.error ?? answer.status}`
        )
    }
  }
}
