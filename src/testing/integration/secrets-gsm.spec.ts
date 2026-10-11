import { join } from 'path'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { Environment } from '../../executer/environment'
import { isolateHammerkitHome } from '../git-repo'
import { getHammerkitDirectory } from '../../optimizer/get-cache-directory'
import { GoogleSecretManagerEnv, requiresGoogleSecretManager } from '../requires-google-secret-manager'

// The secret providers against a real Google Secret Manager, with the example of
// examples/secrets-gsm: a command provider (gcloud), two service accounts, no
// personal login and no HOME. See its README for the demo project this needs.
const example = join(__dirname, '..', '..', '..', 'examples', 'secrets-gsm')
const files = {
  '.git/HEAD': 'ref: refs/heads/main\n',
  '.hammerkit.yaml': readFileSync(join(example, '.hammerkit.yaml'), 'utf8'),
  'playground.txt': readFileSync(join(example, 'playground.txt'), 'utf8'),
}

function collectLogs(environment: Environment): string[] {
  const logs: string[] = []
  environment.status.on((message) => {
    logs.push(message.message)
  })
  return logs
}

function checkKeyFile(name: string, path: string): void {
  let key: { type?: string }
  try {
    key = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`${name} (${path}) is not a readable JSON key file of a service account`)
  }
  if (key.type !== 'service_account') {
    throw new Error(`${name} (${path}) is not a service account key`)
  }
}

describe('secrets from Google Secret Manager', () => {
  let gcloudConfig: string

  beforeAll(() => {
    gcloudConfig = mkdtempSync(join(tmpdir(), 'hammerkit-gsm-'))
  })
  afterAll(() => {
    rmSync(gcloudConfig, { recursive: true, force: true })
  })

  // reads a secret the way hammerkit's provider does, to know what the spec must never see in a log
  function read(gsm: GoogleSecretManagerEnv, secret: string, keyFile: string): string {
    const result = spawnSync(
      'gcloud',
      ['secrets', 'versions', 'access', 'latest', `--secret=${secret}`, `--project=${gsm.project}`],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          CLOUDSDK_CONFIG: gcloudConfig,
          CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: keyFile,
        },
      }
    )
    if (result.status !== 0) {
      throw new Error(`gcloud could not read ${secret} in ${gsm.project}: ${result.stderr || result.error?.message}`)
    }
    return result.stdout
  }

  async function run(
    gsm: GoogleSecretManagerEnv,
    task: string,
    check: (state: any, logs: string[], cwd: string) => Promise<void> | void
  ): Promise<void> {
    await createTestCase(`secrets-gsm-${task}`, files).setup(async (cwd, environment) => {
      const envs: { [key: string]: string } = {
        GCP_PROJECT: gsm.project,
        PLAYGROUND_GCLOUD_CONFIG: gcloudConfig,
        GSM_TEST_CREDENTIALS: gsm.reader,
        GSM_OTHER_CREDENTIALS: gsm.other,
      }
      environment.processEnvs = { ...environment.processEnvs, ...envs }
      delete environment.processEnvs['GSM_NOBODY_CREDENTIALS']
      const logs = collectLogs(environment)
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: task })
      await cli.clean({ cache: true })
      const result = await cli.runExec()
      await check(result.state.tasks[task].state.current, logs, cwd)
    })
  }

  it(
    'reads the secret as the default service account and masks it in every encoding',
    requiresGoogleSecretManager(async (gsm) => {
      checkKeyFile('GSM_TEST_CREDENTIALS', gsm.reader)
      checkKeyFile('GSM_OTHER_CREDENTIALS', gsm.other)
      const value = read(gsm, 'hammerkit-playground', gsm.reader)
      const forms = [
        value,
        Buffer.from(value).toString('base64'),
        Buffer.from(value).toString('hex'),
        encodeURIComponent(value),
      ]

      await run(gsm, 'show', (state, logs) => {
        expect(state.type).toEqual('completed')
        expect(logs).toContain(`length: ${value.length}`)
        expect(logs).toContain('value:  ***')
        expect(logs.some((log) => log.includes(value))).toBe(false)
      })

      await run(gsm, 'encodings', (state, logs) => {
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
    requiresGoogleSecretManager(async (gsm) => {
      const other = read(gsm, 'hammerkit-playground-other', gsm.other)

      await run(gsm, 'other-secret', (state, logs) => {
        expect(state.type).toEqual('completed')
        expect(logs).toContain('other: ***')
        expect(logs.some((log) => log.includes(other))).toBe(false)
      })

      // `other` may read only its own secret
      await run(gsm, 'as-other', (state, logs) => {
        expect(state.type).toEqual('error')
        expect(state.errorMessage).toContain('gsm:hammerkit-playground as other')
        expect(state.errorMessage).toMatch(/PERMISSION_DENIED|permission/i)
        expect(logs).not.toContain('as other: ***')
      })
    }),
    120000
  )

  it(
    'fails closed without the account variable and never falls back to another login',
    requiresGoogleSecretManager(async (gsm) => {
      await run(gsm, 'fail-closed', (state, logs) => {
        expect(state.type).toEqual('error')
        expect(state.errorMessage).toContain('account nobody')
        expect(state.errorMessage).toContain('GSM_NOBODY_CREDENTIALS is not set')
        expect(logs).not.toContain('this must not run')
      })
    }),
    120000
  )

  it(
    'names the secret, provider and account when the secret does not exist',
    requiresGoogleSecretManager(async (gsm) => {
      await run(gsm, 'missing', (state, logs) => {
        expect(state.type).toEqual('error')
        expect(state.errorMessage).toContain('gsm:hammerkit-playground-does-not-exist as test')
        expect(state.errorMessage).toMatch(/NOT_FOUND|not found/i)
        expect(logs).not.toContain('this must not run')
      })
    }),
    120000
  )

  it(
    'keys the cache by a digest of the value and stores no value',
    requiresGoogleSecretManager(async (gsm) => {
      const value = read(gsm, 'hammerkit-playground', gsm.reader)
      const home = isolateHammerkitHome()
      try {
        await run(gsm, 'keyed', async (state, logs, cwd) => {
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
