import { join } from 'path'
import { writeFileSync } from 'fs'
import { createTestCase } from '../test-case'
import { requiresLinuxContainers } from '../requires-linux-containers'
import {
  approveDeviceLogin,
  ensureLocalKeycloak,
  KEYCLOAK_AUDIENCE,
  KEYCLOAK_CLIENT,
  KEYCLOAK_USER,
  LocalKeycloak,
} from '../ensure-keycloak'
import { readServerConfig } from '../../server/server-config'
import { RunningServer, startServer } from '../../server/server'
import { deviceLogin } from '../../remote/device-login'
import { getMe } from '../../remote/server-client'
import { Environment } from '../../executer/environment'

// The unit specs play an identity provider; this one runs a real Keycloak, so the
// token verification (RS256, JWKS and discovery as Keycloak serves them) and the
// device authorization grant are checked against what a company would run.
describe('hammerkit server against Keycloak', () => {
  let keycloak: LocalKeycloak

  beforeAll(
    requiresLinuxContainers(async () => {
      keycloak = await ensureLocalKeycloak()
    }),
    240000
  )

  afterAll(async () => {
    if (keycloak) {
      await keycloak.cleanup()
    }
  })

  async function withServer(
    name: string,
    fn: (server: RunningServer, environment: Environment) => Promise<void>
  ): Promise<void> {
    await createTestCase(name, {}).setup(async (cwd, environment) => {
      const file = join(cwd, 'server.yaml')
      writeFileSync(
        file,
        `listen: { port: 0 }
issuers:
  - issuer: "${keycloak.issuer}"
    audience: ${KEYCLOAK_AUDIENCE}
    clientId: ${KEYCLOAK_CLIENT}
    scope: openid
secretProviders:
  echo: { command: [echo, "{{ref}}"] }
accounts:
  op-web-dev: { providers: { echo: { env: {} } } }
entitlements:
  - group: { iss: "${keycloak.issuer}", name: ${KEYCLOAK_USER.group} }
    accounts: { op-web-dev: use }
`
      )
      const server = await startServer(await readServerConfig(environment, file), environment)
      try {
        await fn(server, environment)
      } finally {
        await server.close()
      }
    })
  }

  async function passwordToken(): Promise<string> {
    const response = await fetch(`${keycloak.issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: KEYCLOAK_CLIENT,
        username: KEYCLOAK_USER.username,
        password: KEYCLOAK_USER.password,
        scope: 'openid',
      }),
    })
    const body = (await response.json()) as { access_token?: string }
    if (!body.access_token) {
      throw new Error(`keycloak gave no token: ${JSON.stringify(body)}`)
    }
    return body.access_token
  }

  it(
    'accepts a token Keycloak issued and maps its group to a service account',
    requiresLinuxContainers(async () => {
      await withServer('keycloak-token', async (server) => {
        const token = await passwordToken()
        const response = await fetch(`${server.url}/v1/me`, { headers: { authorization: `Bearer ${token}` } })
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          iss: keycloak.issuer,
          accounts: [{ name: 'op-web-dev', level: 'use' }],
        })
      })
    }),
    120000
  )

  it(
    'refuses a token whose signature was changed',
    requiresLinuxContainers(async () => {
      await withServer('keycloak-tampered', async (server) => {
        const [head, payload, signature] = (await passwordToken()).split('.')
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
        claims.groups = ['admins']
        const forged = `${head}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`
        const response = await fetch(`${server.url}/v1/me`, { headers: { authorization: `Bearer ${forged}` } })
        expect(response.status).toBe(401)
      })
    }),
    120000
  )

  it(
    'signs in with the device authorization grant',
    requiresLinuxContainers(async () => {
      await withServer('keycloak-device', async (server) => {
        const host = { url: server.url, issuer: keycloak.issuer }
        let approved: Promise<string> | null = null
        const result = await deviceLogin(host, {
          prompt: (message) => {
            const address = /open (\S+) and enter/.exec(message)?.[1]
            if (!address) {
              return // the line saying who is being signed in
            }
            // the user's side of the login, in the background while the CLI polls
            approved = approveDeviceLogin(address)
            approved.catch(() => undefined)
          },
        })
        await approved

        const me = await getMe(host, result.accessToken)
        expect(me).toMatchObject({ iss: keycloak.issuer, accounts: [{ name: 'op-web-dev', level: 'use' }] })
        expect(result.expiresAt).toBeGreaterThan(Date.now())
      })
    }),
    180000
  )
})
