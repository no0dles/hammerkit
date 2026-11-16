import { join } from 'path'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { createTestCase, NO_HOST_CONFIG } from '../testing/test-case'
import { createCli } from '../program'
import { createGitRepo, isolateHammerkitHome } from '../testing/git-repo'
import { WorkItem } from './work-item'
import { WorkTask } from './work-task'
import { getWorkTaskCacheDescription } from '../optimizer/work-task-cache-description'
import { Environment } from '../executer/environment'
import { ParseError } from '../schema/parse-error'
import { WorkScope } from '../executer/work-scope'
import { runProgram } from '../run-program'
import { memoryStream } from '../testing/test-streams'

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

const hostEnvs = {
  PATH: process.env.PATH,
  HAMMERKIT_CONFIG: NO_HOST_CONFIG,
  TEST_SA: 'test-sa',
  DEPLOY_SA: 'deploy-sa',
}

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
    envs: { [key: string]: string | undefined } = hostEnvs,
    scope: WorkScope = {}
  ) {
    let result: { cli: Awaited<ReturnType<typeof createCli>>; environment: Environment } | null = null
    await createTestCase(name, {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.hammerkit.yaml': buildFile,
      ...(files as { [name: string]: string }),
    }).setup(async (cwd, environment) => {
      environment.processEnvs = { ...environment.processEnvs, ...envs }
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, scope)
      result = { cli, environment }
    })
    return result!
  }

  // what a run of the planned tasks says before anything starts
  const dryRun = async (planned: ReturnType<typeof plan>) => (await planned).cli.dryRun()

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
      ['an unknown provider', { from: 'nope:a', env: 'A' }, 'no secret provider nope is declared (declared: fake in '],
      [
        'an unknown account',
        { from: 'fake:a', env: 'A', account: 'x' },
        'no account x is declared (declared: test, deploy in ',
      ],
      ['a reference starting with -', { from: 'fake:--x', env: 'A' }, 'must not be empty or start with -'],
    ])('refuses to run %s', async (_name, secret, message) => {
      await expect(
        dryRun(
          plan(`provider-reject-${message.length}`, {
            secretProviders: { fake: provider() },
            secretAccounts: accounts,
            tasks: { build: { cmds: ['true'], secrets: [secret] } },
          })
        )
      ).rejects.toThrow(message)
    })

    it('refuses to run a provider secret when no account is named and none is the default', async () => {
      await expect(
        dryRun(
          plan('provider-no-default', {
            secretProviders: { fake: provider() },
            secretAccounts: { deploy: accounts.deploy },
            tasks: { build: { cmds: ['true'], secrets: [{ from: 'fake:a', env: 'A' }] } },
          })
        )
      ).rejects.toThrow(
        'but neither the secret nor task build names an account, and no account is marked default: true'
      )
    })

    it('refuses to run with an account without credentials for the provider', async () => {
      await expect(
        dryRun(
          plan('provider-account-without-provider', {
            secretProviders: { fake: provider(), other: provider() },
            secretAccounts: accounts,
            tasks: { build: { cmds: ['true'], secrets: [{ from: 'other:a', env: 'A' }] } },
          })
        )
      ).rejects.toThrow(
        /as account test, but account test \(in .*\.hammerkit\.yaml\) has no credentials for provider other/
      )
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

    describe('in the host config', () => {
      const hostConfig = (name: string, config: unknown) => {
        const file = join(scratch, `${name}.yaml`)
        writeFileSync(file, JSON.stringify(config))
        return { ...hostEnvs, HAMMERKIT_CONFIG: file }
      }

      it('reads providers and accounts of this machine, so the build file only names its secrets', async () => {
        const { cli } = await plan(
          'provider-host-config',
          { tasks: { build: { cmds: ['true'], secrets: [{ from: 'fake:a', env: 'A' }] } } },
          {},
          hostConfig('host', { secretProviders: { fake: provider() }, secretAccounts: accounts })
        )
        expect(sourceOf(cli, 'build')).toMatchObject({ provider: 'fake', ref: 'a', account: 'test' })
      })

      it('takes an account of the host config for a provider of the build file', async () => {
        const { cli } = await plan(
          'provider-host-config-account',
          {
            secretProviders: { fake: provider() },
            tasks: { build: { cmds: ['true'], secrets: [{ from: 'fake:a', env: 'A' }] } },
          },
          {},
          hostConfig('account', { secretAccounts: accounts })
        )
        expect(sourceOf(cli, 'build')).toMatchObject({ provider: 'fake', account: 'test' })
      })

      it('replaces what a build file declares under the same name, the machine says how it reads', async () => {
        const local = { command: [process.execPath, fake, 'value', 'local-{{ref}}'] }
        const { cli } = await plan(
          'provider-host-config-wins',
          {
            secretProviders: { fake: provider() },
            secretAccounts: accounts,
            tasks: { build: { cmds: ['true'], secrets: [{ from: 'fake:a', env: 'A' }] } },
          },
          {},
          hostConfig('wins', {
            secretProviders: { fake: local },
            secretAccounts: { mine: { default: true, providers: { fake: { env: {} } } } },
          })
        )
        // its provider, and its default account instead of the build file's
        expect(sourceOf(cli, 'build')).toMatchObject({
          account: 'mine',
          binding: { definition: { command: local.command, declaredIn: expect.stringContaining('wins.yaml') } },
        })
      })

      it('takes a provider of the host config for an account of the build file', async () => {
        const { cli } = await plan(
          'provider-host-config-provider',
          {
            secretAccounts: accounts,
            tasks: { build: { cmds: ['true'], secrets: [{ from: 'fake:a', env: 'A' }] } },
          },
          {},
          hostConfig('provider', { secretProviders: { fake: provider() } })
        )
        expect(sourceOf(cli, 'build')).toMatchObject({ provider: 'fake', account: 'test' })
      })

      it('says which task reads the secret as an unknown account, and what to add to the host config', async () => {
        const envs = hostConfig('tests-only', {
          secretProviders: { gsm: provider() },
          secretAccounts: {
            tests: { providers: { gsm: { env: { CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '${T}' } } } },
          },
        })
        const secrets = [{ from: 'gsm:ci-key', path: '/run/secrets/gcloud.json', account: 'operator' }]
        const error = await dryRun(
          plan(
            'provider-host-config-unknown-account',
            { tasks: { cli: { image: 'alpine', cmds: ['true'], secrets }, other: { cmds: ['true'] } } },
            {},
            envs
          )
        ).catch((e: Error) => e)
        expect((error as Error).message).toBe(
          [
            'task cli reads secret /run/secrets/gcloud.json from gsm:ci-key as account operator (the account: of the secret), ' +
              `but no account operator is declared (declared: tests in ${envs.HAMMERKIT_CONFIG}).`,
            'An account says which credential a secret is read with, and each machine declares its own in its host config, ' +
              `${envs.HAMMERKIT_CONFIG}. Add operator there:`,
            '',
            '  secretAccounts:',
            '    operator:',
            '      providers:',
            '        gsm:',
            '          env:',
            '            CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: ${OPERATOR_CREDENTIALS}',
            '',
            'Or read the secret as one of the declared accounts with account: on the secret.',
            'See https://hammerkit.dev/docs/task/secret-providers#accounts',
          ].join('\n')
        )
      })

      it('says when the account comes from the task, and names a service', async () => {
        const envs = hostConfig('service-account', { secretProviders: { gsm: provider() } })
        const error = await dryRun(
          plan(
            'provider-host-config-service-account',
            { services: { db: { image: 'postgres:16', account: 'ops', secrets: [{ from: 'gsm:x', env: 'X' }] } } },
            {},
            envs
          )
        ).catch((e: Error) => e)
        expect((error as Error).message).toContain(
          'service db reads secret X from gsm:x as account ops (the account: of service db), but no account ops is declared (declared: none).'
        )
        expect((error as Error).message).toContain(
          'Or read the secret as one of the declared accounts with account: on the secret or on service db.'
        )
        // no account passes credentials to gsm yet, so the snippet says what goes there
        expect((error as Error).message).toContain(
          '<VARIABLE>: ${<VARIABLE OF THIS MACHINE>} # what gsm reads its credential from'
        )
      })

      it('shows how to declare an unknown provider in the host config', async () => {
        const envs = hostConfig('no-providers', {})
        const error = await dryRun(
          plan(
            'provider-host-config-no-providers',
            { tasks: { build: { cmds: ['true'], secrets: [{ from: 'op:vault/item', env: 'A' }] } } },
            {},
            envs
          )
        ).catch((e: Error) => e)
        expect((error as Error).message).toContain(
          'task build reads secret A from op:vault/item, but no secret provider op is declared (declared: none).\n' +
            `A provider is the command that prints a secret's value. Declare it in the host config, ${envs.HAMMERKIT_CONFIG}:\n\n` +
            '  secretProviders:\n    op:\n'
        )
      })

      it('does not stop a project that reads no secrets from loading', async () => {
        const envs = hostConfig('other-project', {
          secretProviders: { op: { command: ['op', 'read', '{{ref}}'] } },
          secretAccounts: {
            dev: { default: true, providers: { op: { env: {} } } },
            // a provider the projects that use this account declare themselves
            gsm: { providers: { gsm: { env: {} } } },
          },
        })
        const { cli } = await plan(
          'provider-host-config-unrelated',
          {
            secretProviders: { op: provider() },
            secretAccounts: { ci: { default: true, providers: { op: { env: {} } } } },
            tasks: { build: { cmds: ['true'] } },
          },
          {},
          envs
        )
        expect(cli.task('build')).toBeDefined()
        // the provider is checked when a run reads a secret of it
        await expect(
          dryRun(
            plan(
              'provider-host-config-unknown',
              { tasks: { build: { cmds: ['true'], secrets: [{ from: 'gsm:a', env: 'A', account: 'gsm' }] } } },
              {},
              envs
            )
          )
        ).rejects.toThrow('no secret provider gsm is declared (declared: op in ')
      })

      it('rejects two default accounts in the host config', async () => {
        await expect(
          plan(
            'provider-host-config-defaults',
            { tasks: { build: { cmds: ['true'] } } },
            {},
            hostConfig('defaults', {
              secretProviders: { fake: provider() },
              secretAccounts: {
                a: { default: true, providers: { fake: { env: {} } } },
                b: { default: true, providers: { fake: { env: {} } } },
              },
            })
          )
        ).rejects.toThrow(/more than one default secret account: a, b \(.*defaults\.yaml\)/)
      })
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

  // A provider or account is the machine's to declare (its host config). A task that reads a
  // secret of one this machine does not have fails when it runs, never the other tasks of the file.
  describe('a provider this machine does not declare', () => {
    const buildFile = {
      tasks: {
        build: { cmds: ['echo built'] },
        deploy: { cmds: ['true'], secrets: [{ from: 'gcp-token:deploy', env: 'TOKEN' }] },
        // a cache: true secret makes up the task id
        release: { cmds: ['true'], secrets: [{ from: 'op:release', env: 'KEY', cache: true }] },
        ship: { deps: ['deploy'], cmds: ['true'] },
        integration: { needs: ['db'], cmds: ['true'] },
      },
      services: {
        db: { image: 'postgres:16', secrets: [{ from: 'op:db', env: 'PASSWORD' }] },
      },
    }
    const deployMessage =
      'task deploy reads secret TOKEN from gcp-token:deploy, but no secret provider gcp-token is declared (declared: none).'

    async function runTask(name: string, taskName: string) {
      const { cli } = await plan(name, buildFile, {}, hostEnvs, { taskName })
      return cli.runExec()
    }

    async function hammerkit(name: string, args: string[]): Promise<string> {
      let output = ''
      await createTestCase(name, { '.git/HEAD': 'ref: refs/heads/main\n', '.hammerkit.yaml': buildFile }).setup(
        async (_cwd, environment) => {
          environment.processEnvs = { ...environment.processEnvs, ...hostEnvs }
          const out = memoryStream()
          environment.stdout = out.stream
          await runProgram(environment, ['hammerkit', ...args], true)
          output = out.read()
        }
      )
      return output
    }

    itExceptWindows('runs a task that reads none of its secrets', async () => {
      const result = await runTask('provider-undeclared-other', 'build')
      expect(result.success).toBe(true)
    })

    it('refuses to run the task that reads it, before anything starts', async () => {
      await expect(runTask('provider-undeclared-task', 'deploy')).rejects.toThrow(deployMessage)
    })

    it('refuses a run whose dependency or service reads it', async () => {
      await expect(runTask('provider-undeclared-dep', 'ship')).rejects.toThrow(deployMessage)
      await expect(runTask('provider-undeclared-need', 'integration')).rejects.toThrow(
        'service db reads secret PASSWORD from op:db, but no secret provider op is declared (declared: none).'
      )
    })

    it('computes the ids of the other tasks, and refuses the id of a task with a cache: true secret of it', async () => {
      const { cli } = await plan('provider-undeclared-ids', buildFile, {}, hostEnvs, { taskName: 'build' })
      await expect(cli.explain()).resolves.toHaveLength(1)
      const release = await plan('provider-undeclared-release-id', buildFile, {}, hostEnvs, { taskName: 'release' })
      await expect(release.cli.explain()).rejects.toThrow(
        'task release reads secret KEY from op:release, but no secret provider op is declared (declared: none).'
      )
    })

    it('lists every task, saying which can not run here', async () => {
      const listed = await hammerkit('provider-undeclared-ls', ['ls'])
      expect(listed).toContain('• build')
      expect(listed).toMatch(
        /• deploy\n.*can't run here:.* secret TOKEN from gcp-token:deploy: no secret provider gcp-token is declared\n/
      )
      expect(listed).toMatch(
        /• db\n.*can't run here:.* secret PASSWORD from op:db: no secret provider op is declared\n/
      )

      const json = JSON.parse(await hammerkit('provider-undeclared-ls-json', ['ls', '--json']))
      const byName = Object.fromEntries(json.tasks.map((task: { name: string }) => [task.name, task]))
      expect(byName.build.unreadableSecrets).toBeUndefined()
      expect(byName.deploy.unreadableSecrets).toEqual([
        'secret TOKEN from gcp-token:deploy: no secret provider gcp-token is declared',
      ])
      expect(json.services[0].unreadableSecrets).toEqual([
        'secret PASSWORD from op:db: no secret provider op is declared',
      ])
    })

    it('warns in validate, the build file is valid', async () => {
      const validated = await hammerkit('provider-undeclared-validate', ['validate'])
      expect(validated).toMatch(
        /warn.* at .*deploy.* secret TOKEN from gcp-token:deploy: no secret provider gcp-token is declared, running it here fails/
      )
    })
  })
})
