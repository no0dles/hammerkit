import { join } from 'path'
import { writeFileSync } from 'fs'
import { createTestCase } from '../testing/test-case'
import { createTestKey, signToken, startTestIssuer, TestDeviceFlow, TestIssuer, TestKey } from '../testing/test-issuer'
import { readServerConfig } from '../server/server-config'
import { RunningServer, startServer } from '../server/server'
import { deviceLogin } from './device-login'
import { getMe } from './server-client'

let key: TestKey

beforeAll(() => {
  key = createTestKey('ES256', 'k1')
})

interface Setup {
  idp: TestIssuer
  server: RunningServer
  flow: TestDeviceFlow
  host: { url: string; issuer: string }
  prompts: string[]
  sleeps: number[]
}

async function withLogin(
  name: string,
  options: { flow?: Partial<TestDeviceFlow>; clientId?: boolean },
  fn: (setup: Setup) => Promise<void>
): Promise<void> {
  const flow: TestDeviceFlow = {
    clientId: 'hammerkit-cli',
    token: () => '',
    ...options.flow,
  }
  const idp = await startTestIssuer([key], flow)
  flow.token = () =>
    signToken(key, { iss: idp.url, sub: 'alice', aud: 'hammerkit', exp: Math.floor(Date.now() / 1000) + 3600 })
  try {
    await createTestCase(name, {}).setup(async (cwd, env) => {
      const file = join(cwd, 'server.yaml')
      writeFileSync(
        file,
        `listen: { port: 0 }
issuers:
  - issuer: "${idp.url}"
    audience: hammerkit
    ${options.clientId === false ? '' : 'clientId: hammerkit-cli'}
    scope: "openid api://hammerkit/.default"
entitlements:
  - subject: { iss: "${idp.url}", sub: alice }
    accounts: [op-payments-dev]
`
      )
      const server = await startServer(await readServerConfig(env, file), env)
      try {
        await fn({ idp, server, flow, host: { url: server.url, issuer: idp.url }, prompts: [], sleeps: [] })
      } finally {
        await server.close()
      }
    })
  } finally {
    await idp.close()
  }
}

const login = (setup: Setup, extra: Parameters<typeof deviceLogin>[1] extends infer O ? Partial<O> : never = {}) =>
  deviceLogin(setup.host, {
    prompt: (message) => setup.prompts.push(message),
    sleep: async (ms) => {
      setup.sleeps.push(ms)
    },
    ...extra,
  })

describe('deviceLogin', () => {
  it('shows the code, waits for the approval and returns a token the server accepts', async () => {
    await withLogin('device-login-ok', { flow: { pending: 2 } }, async (setup) => {
      const result = await login(setup)
      expect(setup.prompts).toEqual([`To sign in, open ${setup.idp.url}/activate and enter the code ABCD-EFGH`])
      expect(setup.sleeps).toEqual([1000, 1000, 1000])
      expect(result.expiresAt).toBeGreaterThan(Date.now() + 3000 * 1000)

      const me = await getMe(setup.host, result.accessToken)
      expect(me).toMatchObject({ sub: 'alice', accounts: ['op-payments-dev'], default: 'op-payments-dev' })
    })
  })

  it('asks the issuer with the client, scope and audience the server publishes', async () => {
    await withLogin('device-login-request', {}, async (setup) => {
      await login(setup)
      expect(setup.flow.requests?.[0]).toEqual({
        path: '/device',
        client_id: 'hammerkit-cli',
        scope: 'openid api://hammerkit/.default',
        audience: 'hammerkit',
      })
      expect(setup.flow.requests?.[1]).toMatchObject({
        path: '/token',
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: 'dev-1',
        client_id: 'hammerkit-cli',
      })
    })
  })

  it('polls more slowly when the issuer says slow_down', async () => {
    await withLogin('device-login-slow-down', { flow: { error: 'slow_down' } }, async (setup) => {
      await login(setup, {
        sleep: async (ms) => {
          setup.sleeps.push(ms)
          if (setup.sleeps.length === 3) {
            setup.flow.error = undefined
          }
        },
      })
      expect(setup.sleeps).toEqual([1000, 6000, 11000])
    })
  })

  it('reports a denied sign-in', async () => {
    await withLogin('device-login-denied', { flow: { error: 'access_denied' } }, async (setup) => {
      await expect(login(setup)).rejects.toThrow('the sign-in was denied')
    })
  })

  it('reports an expired code, also when the deadline passes', async () => {
    await withLogin('device-login-expired', { flow: { error: 'expired_token' } }, async (setup) => {
      await expect(login(setup)).rejects.toThrow('the code expired')
    })
    await withLogin('device-login-deadline', { flow: { pending: 99 } }, async (setup) => {
      let clock = Date.now()
      await expect(
        login(setup, {
          now: () => clock,
          sleep: async (ms) => {
            clock += ms + 400_000
          },
        })
      ).rejects.toThrow('the code expired')
    })
  })

  it('reports another error of the issuer', async () => {
    await withLogin('device-login-error', { flow: { error: 'invalid_client' } }, async (setup) => {
      await expect(login(setup)).rejects.toThrow('refused the sign-in: invalid_client')
    })
  })

  it('stops when it is cancelled', async () => {
    await withLogin('device-login-cancel', { flow: { pending: 99 } }, async (setup) => {
      const controller = new AbortController()
      controller.abort()
      await expect(login(setup, { signal: controller.signal })).rejects.toThrow('cancelled')
    })
  })

  it('does not sign in at an issuer the server does not accept', async () => {
    await withLogin('device-login-other-issuer', {}, async (setup) => {
      await expect(
        deviceLogin({ ...setup.host, issuer: 'https://evil.example' }, { prompt: () => undefined })
      ).rejects.toThrow(`does not accept tokens from https://evil.example (it accepts ${setup.idp.url})`)
    })
  })

  it('needs the server to offer a client for the issuer', async () => {
    await withLogin('device-login-no-client', { clientId: false }, async (setup) => {
      await expect(login(setup)).rejects.toThrow('offers no sign-in')
    })
  })

  it('reports a server that is not there or not hammerkit', async () => {
    await expect(
      deviceLogin({ url: 'http://127.0.0.1:1', issuer: 'http://127.0.0.1:2' }, { prompt: () => undefined })
    ).rejects.toThrow('unable to reach')
    const idp = await startTestIssuer([key])
    try {
      await expect(deviceLogin({ url: idp.url, issuer: idp.url }, { prompt: () => undefined })).rejects.toThrow(
        'answered 404'
      )
    } finally {
      await idp.close()
    }
  })

  it('needs an issuer that supports the device grant over https', async () => {
    await withLogin('device-login-unsupported', {}, async (setup) => {
      setup.idp.metadata = { device_authorization_endpoint: undefined }
      await expect(login(setup)).rejects.toThrow('does not support the device authorization grant over https')
      setup.idp.metadata = { device_authorization_endpoint: 'http://idp.corp/device' }
      await expect(login(setup)).rejects.toThrow('does not support the device authorization grant over https')
    })
  })

  it('refuses an issuer whose metadata names another issuer', async () => {
    await withLogin('device-login-metadata', {}, async (setup) => {
      setup.idp.metadata = { issuer: 'https://other.example' }
      await expect(login(setup)).rejects.toThrow('describes itself as https://other.example')
    })
  })
})
