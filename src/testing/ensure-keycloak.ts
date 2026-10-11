import Dockerode from 'dockerode'
import { Stream } from 'stream'
import { createServer } from 'net'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const KEYCLOAK_IMAGE = process.env.HAMMERKIT_TEST_KEYCLOAK_IMAGE ?? 'quay.io/keycloak/keycloak:26.0'

export const KEYCLOAK_REALM = 'hammerkit'
export const KEYCLOAK_CLIENT = 'hammerkit-cli'
export const KEYCLOAK_AUDIENCE = 'hammerkit'
export const KEYCLOAK_USER = { username: 'alice', password: 'alice-password', group: 'eng-web' }

// A realm with a public client that allows the device grant and the password
// grant (to get a token without a browser), tokens that carry the audience
// `hammerkit`, and a `groups` claim.
const realm = {
  realm: KEYCLOAK_REALM,
  enabled: true,
  groups: [{ name: KEYCLOAK_USER.group }],
  users: [
    {
      username: KEYCLOAK_USER.username,
      enabled: true,
      email: 'alice@example.com',
      emailVerified: true,
      firstName: 'Alice',
      lastName: 'Example',
      credentials: [{ type: 'password', value: KEYCLOAK_USER.password, temporary: false }],
      groups: [`/${KEYCLOAK_USER.group}`],
    },
  ],
  clients: [
    {
      clientId: KEYCLOAK_CLIENT,
      enabled: true,
      publicClient: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: true,
      attributes: { 'oauth2.device.authorization.grant.enabled': 'true' },
      protocolMappers: [
        {
          name: 'hammerkit-audience',
          protocol: 'openid-connect',
          protocolMapper: 'oidc-audience-mapper',
          config: {
            'included.custom.audience': KEYCLOAK_AUDIENCE,
            'access.token.claim': 'true',
            'id.token.claim': 'false',
          },
        },
        {
          name: 'groups',
          protocol: 'openid-connect',
          protocolMapper: 'oidc-group-membership-mapper',
          config: {
            'claim.name': 'groups',
            'full.path': 'false',
            'access.token.claim': 'true',
            'id.token.claim': 'false',
            'userinfo.token.claim': 'false',
          },
        },
      ],
    },
  ],
}

export interface LocalKeycloak {
  // the issuer of the realm, as it appears in the tokens
  issuer: string
  cleanup(): Promise<void>
}

async function ensureImage(docker: Dockerode, image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect()
    return
  } catch {
    // not present locally, pull it below
  }
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: unknown, stream: NodeJS.ReadableStream | undefined) => {
      if (err || !stream) {
        reject(err ?? new Error('no pull stream'))
        return
      }
      docker.modem.followProgress(stream as unknown as Stream, (e: unknown) => (e ? reject(e) : resolve()))
    })
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port
      probe.close(() => resolve(port))
    })
  })
}

// Starts Keycloak in development mode with the realm above and waits until the
// realm answers. The issuer contains the published port, which is also how the
// tests reach it, so the `iss` of its tokens is what the tests configure.
export async function ensureLocalKeycloak(docker: Dockerode = new Dockerode()): Promise<LocalKeycloak> {
  await ensureImage(docker, KEYCLOAK_IMAGE)

  const importDir = mkdtempSync(join(tmpdir(), 'hammerkit-keycloak-'))
  mkdirSync(importDir, { recursive: true })
  const realmFile = join(importDir, `${KEYCLOAK_REALM}-realm.json`)
  writeFileSync(realmFile, JSON.stringify(realm))
  // the container runs as another user than the one writing the file
  chmodSync(importDir, 0o755)
  chmodSync(realmFile, 0o644)

  const port = await freePort()
  const container = await docker.createContainer({
    Image: KEYCLOAK_IMAGE,
    name: `hammerkit-test-keycloak-${process.pid}-${Date.now()}`,
    Cmd: ['start-dev', '--import-realm', '--http-port=8080'],
    Labels: { app: 'hammerkit' },
    Env: ['KC_BOOTSTRAP_ADMIN_USERNAME=admin', 'KC_BOOTSTRAP_ADMIN_PASSWORD=admin'],
    ExposedPorts: { '8080/tcp': {} },
    HostConfig: {
      AutoRemove: true,
      Binds: [`${importDir}:/opt/keycloak/data/import:ro`],
      PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] },
    },
  })
  await container.start()

  const cleanup = async () => {
    await container.remove({ force: true }).catch(() => undefined)
    rmSync(importDir, { recursive: true, force: true })
  }

  const issuer = `http://127.0.0.1:${port}/realms/${KEYCLOAK_REALM}`
  const deadline = Date.now() + 150_000
  let lastError = 'no answer yet'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) })
      if (response.ok) {
        return { issuer, cleanup }
      }
      lastError = `answered ${response.status}`
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  const logs = await container
    .logs({ stdout: true, stderr: true, tail: 40 })
    .then((buffer) => buffer.toString())
    .catch(() => '')
  await cleanup()
  throw new Error(`keycloak did not become ready (${lastError})\n${logs}`)
}

// A browser for the device verification page, enough to sign in: follows the
// redirects with a cookie jar, posts the login form and, when asked, the
// consent form. Returns the text of the last page.
export async function approveDeviceLogin(verificationUrl: string, user = KEYCLOAK_USER): Promise<string> {
  const cookies = new Map<string, string>()

  const request = async (
    url: string,
    init: RequestInit = {}
  ): Promise<{ url: string; status: number; body: string }> => {
    let current = url
    let method = init.method ?? 'GET'
    let body = init.body
    for (let hop = 0; hop < 15; hop++) {
      const response = await fetch(current, {
        method,
        body,
        redirect: 'manual',
        headers: {
          cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
          ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        signal: AbortSignal.timeout(15_000),
      })
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';')
        const eq = pair.indexOf('=')
        cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1))
      }
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location) {
        current = new URL(location, current).toString()
        method = 'GET'
        body = undefined
        continue
      }
      return { url: current, status: response.status, body: await response.text() }
    }
    throw new Error(`too many redirects from ${url}`)
  }

  const decode = (value: string) =>
    value
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#x3D;/g, '=')
  const form = (page: { url: string; body: string }) => {
    const match = /<form\b[^>]*\baction="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i.exec(page.body)
    return match ? { action: new URL(decode(match[1]), page.url).toString(), html: match[2] } : null
  }
  const hiddenFields = (html: string) => {
    const fields: Record<string, string> = {}
    for (const input of html.matchAll(/<input\b[^>]*>/gi)) {
      const name = /\bname="([^"]*)"/.exec(input[0])?.[1]
      const value = /\bvalue="([^"]*)"/.exec(input[0])?.[1] ?? ''
      if (name && /type="hidden"/i.test(input[0])) {
        fields[name] = decode(value)
      }
    }
    return fields
  }

  let page = await request(verificationUrl)
  const login = form(page)
  if (!login || !/name="password"/.test(login.html)) {
    throw new Error(`expected a login page at ${page.url} (${page.status}):\n${page.body.slice(0, 1500)}`)
  }
  page = await request(login.action, {
    method: 'POST',
    body: new URLSearchParams({ username: user.username, password: user.password, credentialId: '' }),
  })

  const consent = form(page)
  if (consent && /name="accept"/.test(consent.html)) {
    page = await request(consent.action, {
      method: 'POST',
      body: new URLSearchParams({ ...hiddenFields(consent.html), accept: 'Yes' }),
    })
  }
  if (page.status !== 200 || form(page)) {
    throw new Error(`the device login did not finish at ${page.url} (${page.status}):\n${page.body.slice(0, 1500)}`)
  }
  return page.body
}
