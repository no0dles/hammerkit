import { join } from 'path'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { createGitRepo, isolateHammerkitHome } from '../testing/git-repo'
import { WorkItem } from './work-item'
import { WorkTask } from './work-task'
import { getWorkTaskCacheDescription } from '../optimizer/work-task-cache-description'
import { Environment } from '../executer/environment'
import { ParseError } from '../schema/parse-error'

const fake = join(__dirname, '..', 'testing', 'fake-secret-cli.cjs')

// Local task execution is not reliable on the Windows hosted runner (see
// execute.spec.ts), so gate the real runs off win32.
const itExceptWindows = process.platform === 'win32' ? it.skip : it

const provider = (calls?: string) => ({
  command: [process.execPath, fake, 'value', '{{ref}}'],
  env: calls ? { FAKE_CALLS: calls } : {},
})

const accounts = {
  test: { default: true, providers: { fake: { env: { FAKE_TOKEN: '${TEST_SA}' } } } },
  deploy: { providers: { fake: { env: { FAKE_TOKEN: '${DEPLOY_SA}' } } } },
}

const hostEnvs = { PATH: process.env.PATH, TEST_SA: 'test-sa', DEPLOY_SA: 'deploy-sa' }

describe('provider secrets', () => {
  let scratch: string
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'hammerkit-provider-spec-'))
  })
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  async function plan(
    name: string,
    buildFile: { [key: string]: unknown },
    files: { [name: string]: unknown } = {},
    envs: { [key: string]: string | undefined } = hostEnvs
  ) {
    let result: { cli: Awaited<ReturnType<typeof createCli>>; environment: Environment } | null = null
    await createTestCase(name, {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.hammerkit.yaml': buildFile,
      ...(files as { [name: string]: string }),
    }).setup(async (cwd, environment) => {
      environment.processEnvs = { ...environment.processEnvs, ...envs }
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
      result = { cli, environment }
    })
    return result!
  }

  const sourceOf = (cli: Awaited<ReturnType<typeof createCli>>, task: string, index = 0) =>
    (cli.task(task) as unknown as WorkItem<WorkTask>).data.secrets[index].source

  describe('accounts', () => {
    it('takes the account of the secret, else of the task, else the default', async () => {
      const { cli } = await plan('provider-account-precedence', {
        secretProviders: { fake: provider() },
        secretAccounts: accounts,
        tasks: {
          plain: { cmds: ['true'], secrets: [{ from: 'fake:a', env: 'A' }] },
          deploy: {
            account: 'deploy',
            cmds: ['true'],
            secrets: [
              { from: 'fake:a', env: 'A' },
              { from: 'fake:b', env: 'B', account: 'test' },
            ],
          },
        },
      })
      expect(sourceOf(cli, 'plain')).toMatchObject({ provider: 'fake', ref: 'a', account: 'test' })
      expect(sourceOf(cli, 'deploy', 0)).toMatchObject({ ref: 'a', account: 'deploy' })
      expect(sourceOf(cli, 'deploy', 1)).toMatchObject({ ref: 'b', account: 'test' })
    })

    it('takes the account of a service', async () => {
      const { cli } = await plan('provider-service-account', {
        secretProviders: { fake: provider() },
        secretAccounts: accounts,
        services: {
          db: { image: 'postgres:16', account: 'deploy', secrets: [{ from: 'fake:a', env: 'A' }] },
        },
      })
      const service = (cli.service('db') as unknown as { data: { secrets: { source: unknown }[] } }).data
      expect(service.secrets[0].source).toMatchObject({ account: 'deploy' })
    })

    it.each([
      ['an unknown provider', { from: 'nope:a', env: 'A' }, 'unknown secret provider nope, declared: fake'],
      ['an unknown account', { from: 'fake:a', env: 'A', account: 'x' }, 'unknown secret account x'],
      ['a reference starting with -', { from: 'fake:--x', env: 'A' }, 'must not be empty or start with -'],
    ])('rejects %s', async (_name, secret, message) => {
      await expect(
        plan(`provider-reject-${message.length}`, {
          secretProviders: { fake: provider() },
          secretAccounts: accounts,
          tasks: { build: { cmds: ['true'], secrets: [secret] } },
        })
      ).rejects.toThrow(message)
    })

    it('rejects a provider secret when no account is named and none is the default', async () => {
      await expect(
        plan('provider-no-default', {
          secretProviders: { fake: provider() },
          secretAccounts: { deploy: accounts.deploy },
          tasks: { build: { cmds: ['true'], secrets: [{ from: 'fake:a', env: 'A' }] } },
        })
      ).rejects.toThrow('needs an account, and none is named or marked default: true')
    })

    it('rejects an account without credentials for the provider', async () => {
      await expect(
        plan('provider-account-without-provider', {
          secretProviders: { fake: provider(), other: provider() },
          secretAccounts: accounts,
          tasks: { build: { cmds: ['true'], secrets: [{ from: 'other:a', env: 'A' }] } },
        })
      ).rejects.toThrow('account test has no credentials for provider other')
    })

    it('rejects an account that names a provider that is not declared', async () => {
      await expect(
        plan('provider-account-unknown-provider', { secretAccounts: accounts, tasks: { build: { cmds: ['true'] } } })
      ).rejects.toThrow('secret account test (')
    })

    it('rejects two default accounts', async () => {
      await expect(
        plan('provider-two-defaults', {
          secretProviders: { fake: provider() },
          secretAccounts: { ...accounts, deploy: { ...accounts.deploy, default: true } },
          tasks: { build: { cmds: ['true'] } },
        })
      ).rejects.toThrow('more than one default secret account: test, deploy')
    })
  })

  describe('declarations', () => {
    it('rejects the built-in names for a provider', async () => {
      for (const name of ['env', 'file']) {
        const error = await plan(`provider-reserved-${name}`, {
          secretProviders: { [name]: provider() },
          tasks: { build: { cmds: ['true'] } },
        }).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(ParseError)
        expect((error as ParseError).zod.issues.map((i) => i.message)).toContain(
          'env and file are built-in secret sources'
        )
      }
    })

    it('rejects a provider or account declared in two build files', async () => {
      await expect(
        plan(
          'provider-duplicate',
          {
            includes: { company: 'company.yaml' },
            secretProviders: { fake: provider() },
            tasks: { build: { cmds: ['true'] } },
          },
          { 'company.yaml': { secretProviders: { fake: provider() } } }
        )
      ).rejects.toThrow(
        /secret provider fake is declared in .*(company|\.hammerkit)\.yaml and in .*(company|\.hammerkit)\.yaml/
      )
    })

    it('shares providers and accounts from an included file, with its inputs applied', async () => {
      const { cli } = await plan(
        'provider-shared-include',
        {
          includes: { company: 'company.yaml' },
          tasks: { build: { cmds: ['true'], secrets: [{ from: 'fake:a', env: 'A' }] } },
        },
        {
          'company.yaml': {
            envs: { SUFFIX: 'x' },
            secretProviders: { fake: { command: [process.execPath, fake, 'value', '{{ref}}-${SUFFIX}'] } },
            secretAccounts: accounts,
          },
        }
      )
      expect(sourceOf(cli, 'build')).toMatchObject({
        binding: { definition: { command: [process.execPath, fake, 'value', '{{ref}}-x'] } },
      })
    })

    describe('from git', () => {
      let home: ReturnType<typeof isolateHammerkitHome>
      beforeEach(() => {
        home = isolateHammerkitHome()
      })
      afterEach(() => {
        home.restore()
      })

      async function includeCompany(ref: (sha: string) => string) {
        const repo = createGitRepo()
        try {
          const sha = repo.commit({
            'build.yaml': `secretProviders:\n  fake:\n    command: [node, x]\nsecretAccounts:\n  test:\n    default: true\n    providers:\n      fake:\n        env: {}\n`,
          })
          repo.branch('stable')
          writeFileSync(
            join(scratch, '.hammerkit.yaml'),
            `includes:\n  company:\n    git: ${repo.url}\n    ref: ${ref(sha)}\ntasks:\n  build:\n    cmds: [echo hi]\n`
          )
          const { createParseContext } = await import('../schema/schema-parser')
          const { environmentMock } = await import('../executer/environment-mock')
          const { parseReferences } = await import('../schema/reference-parser')
          const environment = environmentMock(scratch)
          const { ctx, scope } = await createParseContext(join(scratch, '.hammerkit.yaml'), environment)
          return await parseReferences(ctx, scope, environment)
        } finally {
          repo.remove()
        }
      }

      it('requires a full commit SHA for the ref', async () => {
        await expect(includeCompany(() => 'stable')).rejects.toThrow('needs ref to be a full commit SHA')
      })

      it('accepts a pinned include', async () => {
        const context = await includeCompany((sha) => sha)
        expect(Object.keys(context.secrets.providers)).toEqual(['fake'])
        expect(Object.keys(context.secrets.accounts)).toEqual(['test'])
      })
    })
  })

  describe('cache: true', () => {
    const task = (secret: object = {}) => ({
      cmds: ['true'],
      secrets: [{ from: 'fake:db', env: 'TOKEN', cache: true, ...secret }],
    })
    const buildFile = (mode = 'value', tasks: { [name: string]: unknown } = { build: task() }) => ({
      secretProviders: { fake: { command: [process.execPath, fake, mode, '{{ref}}'] } },
      secretAccounts: accounts,
      tasks,
    })

    // the id and description of `build`, once the run's secrets were fetched
    async function identify(name: string, file: { [key: string]: unknown }, envs = hostEnvs, taskName = 'build') {
      const { cli } = await plan(name, file, {}, envs)
      const item = cli.task(taskName) as unknown as WorkItem<WorkTask>
      await cli.explain()
      return { id: item.id(), description: JSON.stringify(getWorkTaskCacheDescription(item)) }
    }

    it('needs the value fetched before a task id is computed', async () => {
      const { cli } = await plan('provider-cache-unfetched', buildFile())
      const item = cli.task('build') as unknown as WorkItem<WorkTask>
      expect(() => item.id()).toThrow('secret TOKEN: fake:db as test was not fetched before its task id was computed')
      await cli.explain()
      expect(item.id()).toBeTruthy()
    })

    it('keys the task by a digest of the value, never the value', async () => {
      const first = await identify('provider-cache-a', buildFile())
      const second = await identify('provider-cache-a', buildFile(), { ...hostEnvs, TEST_SA: 'rotated-sa' })
      expect(first.id).not.toEqual(second.id)
      expect(first.description).toContain('TOKEN=sha256:')
      expect(first.description).not.toContain('value-of-db')
    })

    it('gives the same id on every checkout and for every account that reads the same value', async () => {
      const first = await identify('provider-cache-b', buildFile('static'))
      const other = await identify('provider-cache-c', buildFile('static'))
      expect(other.id).toEqual(first.id)
      const deploy = await identify(
        'provider-cache-d',
        buildFile('static', { build: { ...task(), account: 'deploy' } }),
        { ...hostEnvs, DEPLOY_SA: 'other-sa' }
      )
      expect(deploy.id).toEqual(first.id)
    })

    it('fetches only secrets that make up an id before the run', async () => {
      const calls = join(scratch, 'calls')
      const file = {
        secretProviders: { fake: provider(calls) },
        secretAccounts: accounts,
        tasks: {
          build: {
            cmds: ['true'],
            secrets: [
              { from: 'fake:keyed', env: 'KEYED', cache: true },
              { from: 'fake:ambient', env: 'AMBIENT' },
            ],
          },
        },
      }
      await identify('provider-cache-prefetch', file)
      const refs = readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).ref)
      expect(refs).toEqual(['keyed'])
    })

    itExceptWindows('fetches again for each run, and reuses the values of the run in between', async () => {
      const calls = join(scratch, 'calls')
      const { cli } = await plan('provider-cache-runs', {
        secretProviders: { fake: provider(calls) },
        secretAccounts: accounts,
        tasks: { build: { cmds: ['true'], secrets: [{ from: 'fake:db', env: 'TOKEN', cache: true }] } },
      })
      const fetches = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0)

      await cli.explain()
      await cli.explain()
      expect(fetches()).toBe(1)

      await cli.runExec()
      expect(fetches()).toBe(2)
      await cli.runExec()
      expect(fetches()).toBe(3)
    })

    itExceptWindows('is fetched once for the id and the start of the task', async () => {
      const calls = join(scratch, 'calls')
      const { cli } = await plan('provider-cache-once', {
        secretProviders: { fake: provider(calls) },
        secretAccounts: accounts,
        tasks: { build: { cmds: ['true'], secrets: [{ from: 'fake:db', env: 'TOKEN', cache: true }] } },
      })

      const result = await cli.runExec()

      expect(result.success).toBe(true)
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1)
    })
  })

  describe('runs', () => {
    itExceptWindows('hands the value to a task as the account, masks it, and fetches each reference once', async () => {
      const calls = join(scratch, 'calls')
      const { cli, environment } = await plan('provider-run', {
        secretProviders: { fake: provider(calls) },
        secretAccounts: accounts,
        tasks: {
          first: { cmds: ['echo "first $TOKEN"'], secrets: [{ from: 'fake:db', env: 'TOKEN' }] },
          second: {
            deps: ['first'],
            account: 'deploy',
            cmds: ['echo "second $TOKEN"'],
            secrets: [{ from: 'fake:db', env: 'TOKEN' }],
          },
          third: {
            deps: ['second'],
            cmds: ['echo "third $TOKEN"'],
            secrets: [{ from: 'fake:db', env: 'TOKEN' }],
          },
        },
      })
      const logs: string[] = []
      environment.status.on((message) => {
        logs.push(message.message)
      })
      await cli.clean({ cache: true })

      const result = await cli.runExec()

      expect(result.success).toBe(true)
      expect(logs.some((log) => log.includes('value-of-db'))).toBe(false)
      expect(logs).toEqual(expect.arrayContaining(['first ***', 'second ***', 'third ***']))
      // test account twice (shared), deploy account once
      const fetched = readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(fetched.map((call) => call.token).sort()).toEqual(['deploy-sa', 'test-sa'])
    })

    itExceptWindows('fails the task, naming the secret, when the provider fails', async () => {
      const { cli } = await plan('provider-run-fails', {
        secretProviders: { fake: { command: [process.execPath, fake, 'fail', '{{ref}}'], env: {} } },
        secretAccounts: accounts,
        tasks: { build: { cmds: ['true'], secrets: [{ from: 'fake:db', env: 'TOKEN' }] } },
      })
      await cli.clean({ cache: true })

      const result = await cli.runExec()

      expect(result.success).toBe(false)
      expect(result.state.tasks['build'].state.current).toMatchObject({
        type: 'error',
        errorMessage: expect.stringMatching(/secret TOKEN \(fake:db as test\): .* exited with code 3: denied: db/),
      })
    })

    it('never fetches while planning', async () => {
      const calls = join(scratch, 'calls')
      const { cli } = await plan('provider-plan-only', {
        secretProviders: { fake: provider(calls) },
        secretAccounts: accounts,
        tasks: { build: { cmds: ['true'], secrets: [{ from: 'fake:db', env: 'TOKEN' }] } },
      })
      cli.task('build')
      expect(await cli.validate()).toBeTruthy()
      expect(existsSync(calls)).toBe(false)
    })
  })
})
