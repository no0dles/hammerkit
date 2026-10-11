import { join } from 'path'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { Environment } from '../../executer/environment'
import { isolateHammerkitHome } from '../git-repo'
import { getHammerkitDirectory } from '../../optimizer/get-cache-directory'
import { OnePasswordEnv, requiresOnePassword } from '../requires-1password'

// The secret providers against a real 1Password, with the example of
// examples/secrets-1password: a command provider (op), two service accounts, no
// signed-in session and no HOME. See its README for the demo vaults this needs.
const example = join(__dirname, '..', '..', '..', 'examples', 'secrets-1password')
const files = {
  '.git/HEAD': 'ref: refs/heads/main\n',
  '.hammerkit.yaml': readFileSync(join(example, '.hammerkit.yaml'), 'utf8'),
  'playground.txt': readFileSync(join(example, 'playground.txt'), 'utf8'),
}

const playground = 'op://hammerkit-demo/playground/password'
const otherPlayground = 'op://hammerkit-demo-other/playground/password'

function collectLogs(environment: Environment): string[] {
  const logs: string[] = []
  environment.status.on((message) => {
    logs.push(message.message)
  })
  return logs
}

function readToken(name: string, path: string): string {
  let token: string
  try {
    token = readFileSync(path, 'utf8').trim()
  } catch {
    throw new Error(`${name} (${path}) is not a readable file with the token of a service account`)
  }
  if (!token.startsWith('ops_')) {
    throw new Error(`${name} (${path}) does not hold a service account token (they start with ops_)`)
  }
  return token
}

describe('secrets from 1Password', () => {
  let opConfig: string

  beforeAll(() => {
    opConfig = mkdtempSync(join(tmpdir(), 'hammerkit-op-'))
  })
  afterAll(() => {
    rmSync(opConfig, { recursive: true, force: true })
  })

  // reads a secret the way hammerkit's provider does, to know what the spec must never see in a log
  function read(ref: string, token: string): string {
    const result = spawnSync('op', ['read', '--no-newline', ref], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, OP_CONFIG_DIR: opConfig, OP_SERVICE_ACCOUNT_TOKEN: token },
    })
    if (result.status !== 0) {
      throw new Error(`op could not read ${ref}: ${result.stderr || result.error?.message}`)
    }
    return result.stdout
  }

  async function run(
    op: OnePasswordEnv,
    task: string,
    check: (state: any, logs: string[], cwd: string) => Promise<void> | void
  ): Promise<void> {
    await createTestCase(`secrets-1password-${task}`, files).setup(async (cwd, environment) => {
      const envs: { [key: string]: string } = {
        PLAYGROUND_OP_CONFIG: opConfig,
        OP_TEST_TOKEN: readToken('OP_TEST_TOKEN_FILE', op.readerTokenFile),
        OP_OTHER_TOKEN: readToken('OP_OTHER_TOKEN_FILE', op.otherTokenFile),
      }
      environment.processEnvs = { ...environment.processEnvs, ...envs }
      delete environment.processEnvs['OP_NOBODY_TOKEN']
      const logs = collectLogs(environment)
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: task })
      await cli.clean({ cache: true })
      const result = await cli.runExec()
      await check(result.state.tasks[task].state.current, logs, cwd)
    })
  }

  it(
    'reads the secret as the default service account and masks it in every encoding',
    requiresOnePassword(async (op) => {
      const value = read(playground, readToken('OP_TEST_TOKEN_FILE', op.readerTokenFile))
      const forms = [
        value,
        Buffer.from(value).toString('base64'),
        Buffer.from(value).toString('hex'),
        encodeURIComponent(value),
      ]

      await run(op, 'show', (state, logs) => {
        expect(state.type).toEqual('completed')
        expect(logs).toContain(`length: ${value.length}`)
        expect(logs).toContain('value:  ***')
        expect(logs.some((log) => log.includes(value))).toBe(false)
      })

      await run(op, 'encodings', (state, logs) => {
        expect(state.type).toEqual('completed')
        expect(logs).toContain('plain: ***')
        for (const form of forms) {
          expect(logs.some((log) => log.includes(form))).toBe(false)
        }
      })
    }),
    120000
  )

  it(
    'switches identities with account: and keeps the accounts apart',
    requiresOnePassword(async (op) => {
      const other = read(otherPlayground, readToken('OP_OTHER_TOKEN_FILE', op.otherTokenFile))

      await run(op, 'other-secret', (state, logs) => {
        expect(state.type).toEqual('completed')
        expect(logs).toContain('other: ***')
        expect(logs.some((log) => log.includes(other))).toBe(false)
      })

      // `other` may read only the vault hammerkit-demo-other
      await run(op, 'as-other', (state, logs) => {
        expect(state.type).toEqual('error')
        expect(state.errorMessage).toContain(`op:${playground} as other`)
        expect(logs).not.toContain('as other: ***')
      })
    }),
    120000
  )

  it(
    'fails closed without the account variable and never falls back to another login',
    requiresOnePassword(async (op) => {
      await run(op, 'fail-closed', (state, logs) => {
        expect(state.type).toEqual('error')
        expect(state.errorMessage).toContain('account nobody')
        expect(state.errorMessage).toContain('OP_NOBODY_TOKEN is not set')
        expect(logs).not.toContain('this must not run')
      })
    }),
    120000
  )

  it(
    'names the secret, provider and account when the item does not exist',
    requiresOnePassword(async (op) => {
      await run(op, 'missing', (state, logs) => {
        expect(state.type).toEqual('error')
        expect(state.errorMessage).toContain('op:op://hammerkit-demo/does-not-exist/password as test')
        expect(logs).not.toContain('this must not run')
      })
    }),
    120000
  )

  it(
    'keys the cache by a digest of the value and stores no value',
    requiresOnePassword(async (op) => {
      const value = read(playground, readToken('OP_TEST_TOKEN_FILE', op.readerTokenFile))
      const home = isolateHammerkitHome()
      try {
        await run(op, 'keyed', async (state, logs, cwd) => {
          expect(state.type).toEqual('completed')
          expect(readFileSync(join(cwd, 'keyed.out'), 'utf8').trim()).toEqual(
            `built with a secret of length ${value.length}`
          )
          expect(logs.some((log) => log.includes(value))).toBe(false)

          const written = listFiles(getHammerkitDirectory())
          expect(written.length).toBeGreaterThan(0)
          const descriptions = written.filter((file) => file.endsWith('description.json'))
          expect(descriptions.map((file) => readFileSync(file, 'utf8')).join('\n')).toContain('SECRET=sha256:')
          for (const file of written) {
            expect(readFileSync(file).includes(value), file).toBe(false)
          }
        })
      } finally {
        home.restore()
      }
    }),
    120000
  )
})

function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? listFiles(path) : [path]
  })
}
