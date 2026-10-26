import { join } from 'path'
import { HOST_RUNS_YAML } from '../testing/host-env'
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

  it('keeps a token command per server, in the host config only', async () => {
    await withConfig('remote-commands-token-command', async (run, configFile) => {
      const add = ['remote', 'add', 'a', 'https://a.corp', '--issuer', 'https://idp.corp']
      const command = 'gcloud auth print-identity-token --audiences=hammerkit'
      expect(await run(...add, '--client-id', 'cli', '--token-command', ` ${command} `)).toContain(
        `tokens for a come from: ${command}`
      )
      expect(readFileSync(configFile, 'utf8')).toContain(`tokenCommand: ${command}`)
      expect(await run('remote', 'list')).toContain(`token from: ${command}`)

      // adding it again without the command, or without a pin, keeps both
      await run(...add)
      expect(readFileSync(configFile, 'utf8')).toContain(`tokenCommand: ${command}`)
      expect(readFileSync(configFile, 'utf8')).toContain('clientId: cli')

      // a new command is no new server, it needs no --force
      await run(...add, '--token-command', 'other-token')
      expect(readFileSync(configFile, 'utf8')).toContain('tokenCommand: other-token')

      await run(...add, '--no-token-command')
      expect(readFileSync(configFile, 'utf8')).not.toContain('tokenCommand')
      expect(await run('remote', 'list')).not.toContain('token from')

      // a name pointed at another server does not keep the command
      await run(...add, '--token-command', 'other-token')
      await run('remote', 'add', 'a', 'https://b.corp', '--issuer', 'https://idp.corp', '--force')
      expect(readFileSync(configFile, 'utf8')).not.toContain('tokenCommand')

      await expect(run(...add, '--force', '--token-command', '  ')).rejects.toThrow(
        'the token command must not be empty'
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
      setup: {
        url: string
        issuer: string
        credentials: string
        environment: Environment
        // a token command that prints a token of the subject
        tokenCommand: (sub: string) => string
      }
    ) => Promise<void>,
    // whether the server offers a sign-in for its issuer
    signIn = true
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
          `${HOST_RUNS_YAML}listen: { port: 0 }
storage: { directory: ${JSON.stringify(join(environment.cwd, 'server-data'))} }
issuers:
  - { issuer: "${idp.url}", audience: hammerkit${signIn ? ', clientId: hammerkit-cli' : ''} }
secretProviders:
  echo: { command: [echo, "{{ref}}"] }
accounts:
  op-payments-dev: { description: payments, providers: { echo: { env: {} } } }
  op-web-dev: { providers: { echo: { env: {} } } }
  op-payments-prod: { providers: { echo: { env: {} } }, source: [ref], refs: [main] }
entitlements:
  - subject: { iss: "${idp.url}", sub: alice }
    accounts: { op-payments-dev: use, op-web-dev: use, op-payments-prod: request }
    repos: [github.com/corp/payments]
    builds: propose
  - subject: { iss: "${idp.url}", sub: ci }
    accounts: { op-web-dev: use }
`
        )
        const credentials = join(environment.cwd, 'credentials.json')
        environment.processEnvs = { ...environment.processEnvs, HAMMERKIT_CREDENTIALS: credentials }
        const server = await startServer(await readServerConfig(environment, serverFile), environment)
        try {
          const tokenCommand = (sub: string) => {
            const script = join(environment.cwd, `token-${sub}.js`)
            const token = signToken(key, {
              iss: idp.url,
              sub,
              aud: 'hammerkit',
              exp: Math.floor(Date.now() / 1000) + 3600,
            })
            writeFileSync(script, `process.stdout.write(${JSON.stringify(token + '\n')})`)
            return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`
          }
          await fn(run, { url: server.url, issuer: idp.url, credentials, environment, tokenCommand })
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
      expect(out).toContain('service accounts: op-payments-dev (use), op-payments-prod (request), op-web-dev (use)')
      expect(readFileSync(credentials, 'utf8')).not.toContain('never-stored')

      const accounts = await run('remote', 'accounts', 'build')
      expect(accounts).toContain(`build: alice (${issuer})`)
      expect(accounts).toContain('op-payments-dev')
      expect(accounts).toContain('use  payments  from upload, ref')
      expect(accounts).toContain('use  from upload, ref')
      expect(accounts).toContain('request, somebody who uses it approves  from ref')
      expect(accounts).toContain('you may propose build files, which somebody who publishes approves')
      expect(accounts).toContain('repositories: github.com/corp/payments')

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

  it('takes the token of a server from its token command, after the variables', async () => {
    await withServerAndIdp('remote-token-command', async (run, { url, issuer, environment, tokenCommand }) => {
      await run('remote', 'add', 'build', url, '--issuer', issuer, '--token-command', tokenCommand('ci'))
      expect(await run('remote', 'accounts', 'build')).toContain(`build: ci (${issuer})`)

      // the variables still win, for a job that brings its own token
      const env = environment.processEnvs
      environment.processEnvs = { ...env, HAMMERKIT_TOKEN_COMMAND: tokenCommand('alice') }
      expect(await run('remote', 'accounts', 'build')).toContain('build: alice')
      environment.processEnvs = env

      // a sign-in would never be used
      await expect(run('remote', 'login', 'build')).rejects.toThrow(
        `build takes its tokens from its token command (${tokenCommand('ci')}), it needs no sign-in`
      )
    })
  })

  it('says why a token command printed no token, without its output', async () => {
    await withServerAndIdp('remote-token-command-fails', async (run, { url, issuer, environment }) => {
      const script = join(environment.cwd, 'fails.js')
      writeFileSync(
        script,
        `process.stdout.write('eyJ.leaked'); process.stderr.write('ERROR: permission denied\\n'); process.exit(3)`
      )
      const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`
      await run('remote', 'add', 'build', url, '--issuer', issuer, '--token-command', command)
      const err = memoryStream()
      environment.stderr = err.stream
      const failure = run('remote', 'accounts', 'build')
      await expect(failure).rejects.toThrow('the token command of build printed no token, it exited with 3')
      await expect(failure).rejects.not.toThrow('eyJ.leaked')
      expect(err.read()).toContain('the token command of build: ERROR: permission denied')
      expect(err.read()).not.toContain('eyJ.leaked')
    })
  })

  it('points a server without a sign-in to a token command', async () => {
    await withServerAndIdp(
      'remote-login-no-sign-in',
      async (run, { url, issuer }) => {
        await run('remote', 'add', 'build', url, '--issuer', issuer)
        await expect(run('remote', 'login', 'build')).rejects.toThrow(
          `offers no sign-in for ${issuer}, it needs a token obtained elsewhere: register a command that prints one`
        )
        await expect(run('remote', 'login', 'build')).rejects.toThrow(
          `hammerkit remote add build ${url} --issuer ${issuer} --token-command '<command>'`
        )
      },
      false
    )
  })

  it('asks to sign in when there is no token for accounts', async () => {
    await withServerAndIdp('remote-accounts-signed-out', async (run, { url, issuer }) => {
      await run('remote', 'add', 'build', url, '--issuer', issuer)
      await expect(run('remote', 'accounts', 'build')).rejects.toThrow('not signed in to build')
    })
  })
})
