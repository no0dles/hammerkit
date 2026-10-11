import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { createTestCase } from '../testing/test-case'
import { memoryStream } from '../testing/test-streams'
import { runProgram } from '../run-program'
import { Environment } from '../executer/environment'
import { createTestKey, signToken, startTestIssuer, TestDeviceFlow } from '../testing/test-issuer'
import { readServerConfig } from '../server/server-config'
import { startServer } from '../server/server'

const HK = 'hammerkit'

// The commands work on the machine's config file, so they need no build file;
// HAMMERKIT_CONFIG keeps the tests away from the real one.
async function withConfig(
  name: string,
  fn: (run: (...args: string[]) => Promise<string>, configFile: string, environment: Environment) => Promise<void>
) {
  await createTestCase(name, {}).setup(async (cwd, environment) => {
    const configFile = join(cwd, 'config.yaml')
    environment.processEnvs = { ...environment.processEnvs, HAMMERKIT_CONFIG: configFile }
    const run = async (...args: string[]) => {
      const out = memoryStream()
      environment.stdout = out.stream
      await runProgram(environment, [HK, ...args], true)
      return out.read()
    }
    await fn(run, configFile, environment)
  })
}

describe('remote commands', () => {
  it('registers, lists, sets the default and removes a server', async () => {
    await withConfig('remote-commands-lifecycle', async (run, configFile) => {
      expect(await run('remote', 'list')).toContain('no servers registered')

      expect(await run('remote', 'add', 'mac-mini', 'https://mac-mini.corp', '--issuer', 'https://idp.corp')).toContain(
        'added mac-mini: https://mac-mini.corp (issuer https://idp.corp)'
      )
      await run('remote', 'add', 'corp-k8s', 'https://hammerkit.corp', '--issuer', 'https://idp.corp')
      expect(readFileSync(configFile, 'utf8')).toContain('url: https://mac-mini.corp')

      expect(await run('remote', 'use', 'corp-k8s')).toContain('default location: corp-k8s')
      const listing = await run('remote', 'list')
      expect(listing).toContain('mac-mini')
      expect(listing).toMatch(/corp-k8s.*\(default\).*https:\/\/hammerkit\.corp/)

      expect(await run('remote', 'use', 'auto')).toContain('default location: auto')
      expect(await run('remote', 'list')).toContain('default location: auto')

      await run('remote', 'use', 'corp-k8s')
      const removed = await run('remote', 'remove', 'corp-k8s')
      expect(removed).toContain('removed corp-k8s')
      expect(removed).toContain('runs are local again')
      expect(await run('remote', 'remove', 'mac-mini')).not.toContain('local again')
      expect(await run('remote', 'list')).toContain('no servers registered')
    })
  })

  it.each([
    [['remote', 'add', 'a', 'http://a.corp', '--issuer', 'https://idp.corp'], 'must use https'],
    [['remote', 'add', 'local', 'https://a.corp', '--issuer', 'https://idp.corp'], 'reserved'],
    [['remote', 'add', 'a', 'https://a.corp', '--issuer', 'idp.corp'], 'invalid issuer'],
    [['remote', 'use', 'nowhere'], 'hammerkit remote add nowhere'],
    [['remote', 'remove', 'nowhere'], 'not registered'],
  ])('fails with a clear message for %j', async (args, message) => {
    await withConfig('remote-commands-errors', async (run) => {
      await expect(run(...args)).rejects.toThrow(message)
    })
  })

  it('refuses to repoint a name unless forced', async () => {
    await withConfig('remote-commands-force', async (run) => {
      await run('remote', 'add', 'a', 'https://a.corp', '--issuer', 'https://idp.corp')
      await expect(run('remote', 'add', 'a', 'https://evil.example', '--issuer', 'https://idp.corp')).rejects.toThrow(
        'use --force'
      )
      expect(await run('remote', 'add', 'a', 'https://b.corp', '--issuer', 'https://idp.corp', '--force')).toContain(
        'added a: https://b.corp'
      )
    })
  })

  it('works next to a build file, which it does not read', async () => {
    await createTestCase('remote-commands-build-file', { '.hammerkit.yaml': 'tasks: {}\n' }).setup(
      async (cwd, environment) => {
        environment.processEnvs = { ...environment.processEnvs, HAMMERKIT_CONFIG: join(cwd, 'config.yaml') }
        const out = memoryStream()
        environment.stdout = out.stream
        await runProgram(environment, [HK, 'remote', 'list'], true)
        expect(out.read()).toContain('no servers registered')
      }
    )
  })
})

describe('remote login, accounts and logout', () => {
  async function withServerAndIdp(
    name: string,
    fn: (
      run: (...args: string[]) => Promise<string>,
      setup: { url: string; issuer: string; credentials: string }
    ) => Promise<void>
  ) {
    const key = createTestKey('ES256', 'k1')
    const flow: TestDeviceFlow = { clientId: 'hammerkit-cli', interval: 0, token: () => '' }
    const idp = await startTestIssuer([key], flow)
    flow.token = () =>
      signToken(key, { iss: idp.url, sub: 'alice', aud: 'hammerkit', exp: Math.floor(Date.now() / 1000) + 3600 })
    try {
      await withConfig(name, async (run, _configFile, environment) => {
        const serverFile = join(environment.cwd, 'server.yaml')
        writeFileSync(
          serverFile,
          `listen: { port: 0 }
storage: { directory: ${JSON.stringify(join(environment.cwd, 'server-data'))} }
issuers:
  - { issuer: "${idp.url}", audience: hammerkit, clientId: hammerkit-cli }
entitlements:
  - subject: { iss: "${idp.url}", sub: alice }
    accounts: [op-payments-dev, op-web-dev]
    default: op-payments-dev
    publish: [payments]
approvals:
  rules:
    - name: production
      tasks: [deploy]
      approvers: [{ subject: { iss: "${idp.url}", sub: alice } }]
`
        )
        const credentials = join(environment.cwd, 'credentials.json')
        environment.processEnvs = { ...environment.processEnvs, HAMMERKIT_CREDENTIALS: credentials }
        const server = await startServer(await readServerConfig(environment, serverFile), environment)
        try {
          await fn(run, { url: server.url, issuer: idp.url, credentials })
        } finally {
          await server.close()
        }
      })
    } finally {
      await idp.close()
    }
  }

  it('signs in, shows the accounts and signs out again', async () => {
    await withServerAndIdp('remote-login-flow', async (run, { url, issuer, credentials }) => {
      await run('remote', 'add', 'build', url, '--issuer', issuer)

      const out = await run('remote', 'login', 'build')
      expect(out).toContain('To sign in, open')
      expect(out).toContain('enter the code ABCD-EFGH')
      expect(out).toContain('signed in to build as alice')
      expect(out).toContain('service accounts: op-payments-dev, op-web-dev')
      expect(readFileSync(credentials, 'utf8')).not.toContain('never-stored')

      const accounts = await run('remote', 'accounts', 'build')
      expect(accounts).toContain(`build: alice (${issuer})`)
      expect(accounts).toMatch(/op-payments-dev.*\(default\)/)
      expect(accounts).toContain('op-web-dev')
      expect(accounts).toContain('may publish build files: payments')
      expect(accounts).toContain('may approve runs that fall under an approval rule')

      expect(await run('remote', 'logout', 'build')).toContain('signed out of build')
      expect(await run('remote', 'logout', 'build')).toContain('not signed in to build')
    })
  })

  it('uses the default server when accounts gets no name', async () => {
    await withServerAndIdp('remote-accounts-default', async (run, { url, issuer }) => {
      await run('remote', 'add', 'build', url, '--issuer', issuer)
      await run('remote', 'login', 'build')
      await run('remote', 'use', 'build')
      expect(await run('remote', 'accounts')).toContain('build: alice')
    })
  })

  it.each([
    [['remote', 'login', 'nope'], 'server nope is not registered'],
    [['remote', 'accounts', 'nope'], 'server nope is not registered'],
    [['remote', 'accounts'], 'name a server'],
  ])('fails on %j', async (args, message) => {
    await withConfig('remote-login-errors', async (run) => {
      let error: unknown
      try {
        await run(...args)
      } catch (e) {
        error = e
      }
      expect(String((error as Error)?.message ?? error)).toContain(message)
    })
  })

  it('asks to sign in when there is no token for accounts', async () => {
    await withServerAndIdp('remote-accounts-signed-out', async (run, { url, issuer }) => {
      await run('remote', 'add', 'build', url, '--issuer', issuer)
      await expect(run('remote', 'accounts', 'build')).rejects.toThrow('not signed in to build')
    })
  })
})
