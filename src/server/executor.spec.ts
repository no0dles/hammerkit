import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { environmentMock } from '../executer/environment-mock'
import { DefinitionStore } from './definitions'
import { HostExecutor, HostExecutorOptions } from './executor'
import { HOST_ENV_ALLOW } from '../testing/host-env'
import { getSecretCatalog } from './server-config'
import { PlanContext } from './run-plan'
import { runEnvironment } from './run-environment'
import { Run, RunEventData } from './runs'
import { RepoAccess } from './repo-access'
import { TEST_WORKER } from '../testing/worker'
import { ServerConfig, serverConfigSchema } from './server-config'
import { SandboxRegistry } from './sandboxes'
import { HostSandboxStorage } from './sandbox-storage'
import { NetworkSchema } from '../schema/network-schema'

const alice = { iss: 'https://idp.corp', sub: 'alice' }
const REPO = 'git.test/corp/payments'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
  })
}

// a run process that tells the network it was asked to run with
const TELLING_WORKER = [
  process.execPath,
  '-e',
  [
    'let text = ""',
    'process.stdin.on("data", (chunk) => (text += chunk))',
    'process.stdin.on("end", () => {',
    '  const network = JSON.stringify(JSON.parse(text).network)',
    '  console.log(JSON.stringify({ kind: "event", event: { type: "log", task: "t", stream: "stdout", text: network } }))',
    '  console.log(JSON.stringify({ kind: "result", ok: true }))',
    '})',
  ].join('\n'),
]

describe('HostExecutor', () => {
  let root: string
  let repository: string
  let store: DefinitionStore
  let executor: HostExecutor
  let options: HostExecutorOptions
  let runs: string
  let commit: string

  const config = (): ServerConfig =>
    serverConfigSchema.parse({
      issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
      runs: { env: { allow: HOST_ENV_ALLOW } },
      sources: [{ match: 'git.test/corp/*' }],
      secretProviders: {
        echo: { command: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', '{{ref}}'] },
      },
      accounts: {
        ci: { providers: { echo: { env: {} } } },
        prod: { providers: { echo: { env: {} } } },
      },
    })

  const planning = (serverConfig: ServerConfig, envs: { [key: string]: string | undefined }): PlanContext => ({
    environment: {
      ...environmentMock(root),
      processEnvs: runEnvironment(serverConfig, envs),
      hosted: { catalog: getSecretCatalog(serverConfig) },
    },
    policy: { envs: serverConfig.runs.env.allow },
  })

  async function publish(files: { [path: string]: string }, entry = '.hammerkit.yaml'): Promise<string> {
    const { version } = await store.publish('payments', { entry, files }, alice)
    return version.hash
  }

  const run = (hash: string, patch: Partial<Run> = {}): Run => ({
    id: 'run_test',
    owner: alice,
    state: 'running',
    createdAt: new Date().toISOString(),
    definition: { name: 'payments', hash },
    tasks: ['build'],
    accounts: [],
    source: { type: 'ref', repo: REPO, ref: 'main', commit },
    options: {},
    ...patch,
  })

  async function execute(r: Run, signal = new AbortController().signal) {
    const events: RunEventData[] = []
    const error = await executor.execute(r, { emit: (e) => events.push(e), signal }).then(
      () => undefined,
      (e: Error) => e
    )
    return { events, error }
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'hammerkit-executor-'))
    repository = join(root, 'repository')
    runs = join(root, 'runs')
    mkdirSync(repository)
    git(repository, 'init', '--quiet', '--initial-branch=main')
    // what the repository says its build file is does not matter, the published one runs
    writeFileSync(join(repository, '.hammerkit.yaml'), 'tasks:\n  build:\n    cmds: [echo from-the-repository]\n')
    writeFileSync(join(repository, 'input.txt'), 'hello')
    git(repository, 'add', '.')
    git(repository, 'commit', '--quiet', '-m', 'one')
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
    const serverConfig = config()
    const serverEnvs = { ...process.env, SECRET_OF_SERVER: 'x' }
    const hosted = planning(serverConfig, serverEnvs)
    store = new DefinitionStore(join(root, 'definitions'), hosted.environment, { policy: hosted.policy })
    await store.load()
    options = {
      definitions: store,
      planning: hosted,
      repos: new RepoAccess(serverConfig, hosted.environment, { url: () => repository }),
      directory: runs,
      cache: join(root, 'cache'),
      worker: TEST_WORKER,
    }
    executor = new HostExecutor(options)
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('runs the published tasks on the code of the ref and reports them', async () => {
    const hash = await publish({
      '.hammerkit.yaml': 'tasks:\n  build:\n    cmds:\n      - cat input.txt\n      - echo published\n',
    })
    const { events, error } = await execute(run(hash))
    expect(error).toBeUndefined()
    const logs = events.filter((e) => e.type === 'log').map((e) => (e as any).text)
    expect(logs.join('\n')).toContain('hello')
    expect(logs.join('\n')).toContain('published')
    expect(logs.join('\n')).not.toContain('from-the-repository')
    expect(events).toContainEqual(expect.objectContaining({ type: 'task', task: 'build', state: 'running' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'task', task: 'build', state: 'succeeded' }))
  })

  it('does not hand its own environment to the commands', async () => {
    const hash = await publish({
      '.hammerkit.yaml': 'tasks:\n  build:\n    cmds:\n      - echo "[$SECRET_OF_SERVER]"\n',
    })
    const { events, error } = await execute(run(hash))
    expect(error).toBeUndefined()
    const text = events.map((e) => (e.type === 'log' ? e.text : '')).join('\n')
    expect(text).toContain('[]')
    expect(text).not.toContain('[x]')
  })

  it('reads the secrets of a task as the account the run was admitted for, and masks them', async () => {
    const hash = await publish({
      '.hammerkit.yaml': [
        'tasks:',
        '  build:',
        '    secrets:',
        '      - { from: "echo:the-token-value", account: ci, env: TOKEN }',
        '    cmds:',
        '      - echo "token=$TOKEN"',
        '',
      ].join('\n'),
    })
    const { events, error } = await execute(run(hash, { accounts: ['ci'] }))
    expect(error).toBeUndefined()
    const text = events.map((e) => (e.type === 'log' ? e.text : '')).join('\n')
    expect(text).toContain('token=')
    expect(text).not.toContain('the-token-value')
    expect(events).toContainEqual(expect.objectContaining({ type: 'task', task: 'build', state: 'succeeded' }))
  })

  it('refuses a run that would use an account it was not admitted for, before anything starts', async () => {
    const hash = await publish({
      '.hammerkit.yaml': [
        'tasks:',
        '  build:',
        '    secrets:',
        '      - { from: "echo:x", account: prod, env: TOKEN }',
        '    cmds: [echo started]',
        '',
      ].join('\n'),
    })
    const { events, error } = await execute(run(hash, { accounts: ['ci'] }))
    expect(error?.message).toBe('the run would use prod, which it was not admitted for')
    expect(events).toEqual([])
    expect(existsSync(runs) ? readdirSync(runs) : []).toEqual([])
  })

  it('appends the arguments of the run to the last command of its task', async () => {
    const hash = await publish({ '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo first, cat]\n' })
    const { events, error } = await execute(run(hash, { options: { args: ['input.txt'] } }))
    expect(error).toBeUndefined()
    expect(events.map((e) => (e.type === 'log' ? e.text : '')).join('\n')).toContain('hello')
  })

  it('refuses arguments for a task that reads secrets, before anything starts', async () => {
    const hash = await publish({
      '.hammerkit.yaml': [
        'tasks:',
        '  build:',
        '    secrets:',
        '      - { from: "echo:x", account: ci, env: TOKEN }',
        '    cmds: [echo started]',
        '',
      ].join('\n'),
    })
    const { events, error } = await execute(run(hash, { accounts: ['ci'], options: { args: ['$TOKEN'] } }))
    expect(error?.message).toBe(
      'build reads the secret TOKEN, it takes no arguments on a server: an argument could make it print them'
    )
    expect(events).toEqual([])
  })

  it('hands runs.network to the process of the run, and refuses what reaches more', async () => {
    const limited: PlanContext = {
      ...options.planning,
      policy: { ...options.planning.policy, network: { type: 'allow', hosts: ['registry.npmjs.org'] } },
    }
    const network = new DefinitionStore(join(root, 'limited'), limited.environment, { policy: limited.policy })
    const yaml = (setting: string) =>
      `tasks:\n  build:\n    image: node:22\n    network: ${setting}\n    cmds: [npm ci]\n`
    const { version } = await network.publish(
      'payments',
      { entry: '.hammerkit.yaml', files: { '.hammerkit.yaml': yaml('none') } },
      alice
    )
    const telling = new HostExecutor({
      ...options,
      definitions: network,
      planning: limited,
      worker: TELLING_WORKER,
    })
    const events: RunEventData[] = []
    await telling.execute(run(version.hash), { emit: (e) => events.push(e), signal: new AbortController().signal })
    expect(events).toContainEqual({
      type: 'log',
      task: 't',
      stream: 'stdout',
      text: JSON.stringify({ allow: ['registry.npmjs.org'] }),
    })

    // a version published before the server limited its runs does not run with more
    const open = await publish({ '.hammerkit.yaml': yaml('open') })
    const before = new HostExecutor({ ...options, planning: limited })
    const refused = await before
      .execute(run(open), { emit: () => undefined, signal: new AbortController().signal })
      .then(
        () => undefined,
        (e: Error) => e
      )
    expect(refused?.message).toContain('build: asks for network open, more than this server allows')
  })

  it('fails the run when a task fails, with the task and its output', async () => {
    const hash = await publish({
      '.hammerkit.yaml': 'tasks:\n  build:\n    cmds:\n      - echo broken >&2\n      - exit 3\n',
    })
    const { events, error } = await execute(run(hash))
    expect(error?.message).toBe('build failed')
    // the exit code of the command that failed (on Windows the redirection fails first,
    // run-worker.spec.ts checks the value), and how long it ran
    expect(events).toContainEqual({
      type: 'task',
      task: 'build',
      state: 'failed',
      exitCode: expect.any(Number),
      durationMs: expect.any(Number),
    })
  })

  it('runs the tasks in the order they were named, and stops at the first failure', async () => {
    const hash = await publish({
      '.hammerkit.yaml':
        'tasks:\n  build:\n    cmds: [echo one]\n  bad:\n    cmds: [exit 1]\n  never:\n    cmds: [echo never]\n',
    })
    const { events, error } = await execute(run(hash, { tasks: ['build', 'bad', 'never'] }))
    expect(error?.message).toBe('bad failed')
    expect(events.filter((e) => e.type === 'task' && e.task === 'never')).toEqual([])
  })

  it('runs the tasks a label selects', async () => {
    const hash = await publish({
      '.hammerkit.yaml':
        'tasks:\n  build:\n    labels: { group: ci }\n    cmds: [echo labelled]\n  other:\n    cmds: [echo other]\n',
    })
    const { events, error } = await execute(run(hash, { tasks: [], options: { filter: ['group=ci'] } }))
    expect(error).toBeUndefined()
    expect(events).toContainEqual(expect.objectContaining({ type: 'task', task: 'build', state: 'succeeded' }))
    expect(events.filter((e) => e.type === 'task' && e.task === 'other')).toEqual([])
  })

  it('stops a running task when the run is cancelled', async () => {
    const hash = await publish({
      '.hammerkit.yaml': 'tasks:\n  build:\n    cmds:\n      - echo started\n      - sleep 30\n',
    })
    const abort = new AbortController()
    const started = Date.now()
    const result = execute(run(hash), abort.signal)
    for (let i = 0; i < 300 && !existsSync(runs); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
    abort.abort()
    const { error } = await result
    expect(error?.message).toMatch(/cancel/)
    expect(Date.now() - started).toBeLessThan(25_000)
  })

  it('removes the working directory of the run, failed or not', async () => {
    const ok = await publish({ '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo ok]\n' })
    await execute(run(ok))
    const bad = await publish({ '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [exit 1]\n' })
    await execute(run(bad))
    expect(existsSync(runs) ? readdirSync(runs) : []).toEqual([])
  })

  it('fails with the reason when the server does not list the repository', async () => {
    const hash = await publish({ '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo ok]\n' })
    const bare = serverConfigSchema.parse({
      issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
      runs: { env: { allow: HOST_ENV_ALLOW } },
    })
    const other = new HostExecutor({
      definitions: store,
      planning: planning(bare, process.env),
      repos: new RepoAccess(bare, planning(bare, process.env).environment, { url: () => repository }),
      directory: runs,
      cache: join(root, 'cache'),
      worker: TEST_WORKER,
    })
    await expect(
      other.execute(run(hash), { emit: () => undefined, signal: new AbortController().signal })
    ).rejects.toThrow('can not read git.test/corp/payments')
  })

  it('refuses a run from an upload, there is nothing to take the files from yet', async () => {
    const hash = await publish({ '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo ok]\n' })
    const { error } = await execute(run(hash, { source: { type: 'upload', snapshot: 'snap' } }))
    expect(error?.message).toContain('upload')
  })

  it('fails when the ref does not exist', async () => {
    const hash = await publish({ '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo ok]\n' })
    const { error } = await execute(run(hash, { source: { type: 'ref', repo: REPO, ref: 'missing', commit } }))
    expect(error?.message).toContain('unable to fetch')
  })

  it('fails when the ref moved since the run was submitted', async () => {
    const hash = await publish({ '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo ok]\n' })
    writeFileSync(join(repository, 'input.txt'), 'changed')
    git(repository, 'commit', '--quiet', '-am', 'two')
    const { error } = await execute(run(hash))
    expect(error?.message).toContain(`the run was submitted for ${commit}`)
  })

  it('does not write a published file into the git directory of the source', async () => {
    const hash = await publish({
      '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo ok]\n',
      '.git/hooks/post-checkout': 'evil',
    })
    const { error } = await execute(run(hash))
    expect(error?.message).toContain('can not be written')
  })

  it.each(['.GIT/hooks/post-checkout', '.git./config', '.Git/config', 'GIT~1/config', 'sub/.git/config'])(
    'does not write %s into the git directory, however the file system spells it',
    async (path) => {
      const hash = await publish({ '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo ok]\n', [path]: 'evil' })
      const { error } = await execute(run(hash))
      expect(error?.message).toContain('can not be written')
    }
  )

  it('does not follow a link of the source out of it', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(repository, 'link'))
    symlinkSync(join(outside, 'target.txt'), join(repository, 'file-link'))
    git(repository, 'add', '.')
    git(repository, 'commit', '--quiet', '-m', 'links')
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
    for (const path of ['link/payload.txt', 'file-link']) {
      const hash = await publish({ '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo ok]\n', [path]: 'evil' })
      const { error } = await execute(run(hash))
      expect(error?.message).toContain('can not be written')
    }
    expect(readdirSync(outside)).toEqual([])
  })

  it('starts the process of the run with the listed variables, a home directory of its own and a cache by repository', async () => {
    const hash = await publish({ '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo ok]\n' })
    // a process that tells what it was started with
    const script = [
      'const env = process.env',
      'const seen = { home: env.HOME, dir: env.HAMMERKIT_DIR, server: env.SECRET_OF_SERVER, path: Boolean(env.PATH), cwd: process.cwd() }',
      'console.log(JSON.stringify({ kind: "event", event: { type: "log", task: "t", stream: "stdout", text: JSON.stringify(seen) } }))',
      'console.log(JSON.stringify({ kind: "result", ok: true }))',
    ].join(';')
    const telling = new HostExecutor({ ...options, worker: [process.execPath, '-e', script] })
    const events: RunEventData[] = []
    await telling.execute(run(hash), { emit: (e) => events.push(e), signal: new AbortController().signal })
    const seen = JSON.parse((events.find((e) => e.type === 'log' && e.task === 't') as { text: string }).text)
    expect(seen.home).toBe(join(runs, 'run_test', 'home'))
    expect(seen.home).not.toBe(process.env.HOME)
    expect(seen.dir.startsWith(join(root, 'cache'))).toBe(true)
    expect(seen.dir).toMatch(/ref-[0-9a-f]{24}$/)
    expect(seen.path).toBe(true)
    // what the operator did not list stays with the server
    expect(seen.server).toBeUndefined()
    expect(seen.cwd).toContain(join('run_test', 'source'))

    // the cache directory of the process is below the server's, one for each repository
    const spaces = () => readdirSync(join(root, 'cache'))
    expect(spaces()).toHaveLength(1)
    await execute(run(hash))
    expect(spaces()).toHaveLength(1)
    await execute(run(hash, { source: { type: 'ref', repo: 'git.test/corp/other', ref: 'main', commit } }))
    expect(spaces()).toHaveLength(2)
    expect(spaces().every((name) => name.startsWith('ref-'))).toBe(true)
  })

  it('says when the process of the run dies, or can not start', async () => {
    const hash = await publish({ '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo ok]\n' })
    const crashing = new HostExecutor({
      ...options,
      worker: [process.execPath, '-e', 'console.error("boom"); process.exit(3)'],
    })
    const died = await crashing
      .execute(run(hash), { emit: () => undefined, signal: new AbortController().signal })
      .catch((e: Error) => e)
    expect((died as Error).message).toBe('the process of the run stopped (code 3): boom')

    const missing = new HostExecutor({ ...options, worker: [join(root, 'no-such-program')] })
    await expect(
      missing.execute(run(hash), { emit: () => undefined, signal: new AbortController().signal })
    ).rejects.toThrow('could not start')
  })

  it('fails a run whose version was yanked after the run was accepted', async () => {
    const hash = await publish({ '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo published]\n' })
    await store.yank('payments', hash, alice, { reason: 'leaks a token' })
    const { events, error } = await execute(run(hash))
    expect(error?.message).toContain('was yanked: leaks a token')
    expect(events).toEqual([])
  })

  it('fails when the build file is no longer on the server', async () => {
    const { error } = await execute(run('0'.repeat(64)))
    expect(error?.message).toContain('no longer on this server')
  })

  describe('on a sandbox', () => {
    let sandboxes: SandboxRegistry
    let sandboxId: string
    let files: string

    const onSandbox = (runtimes: ('docker' | 'local')[] = ['docker', 'local'], network: NetworkSchema = 'open') =>
      new HostExecutor({
        ...options,
        sandboxes: { registry: sandboxes, policy: { ...options.planning.policy, runtimes }, network },
      })

    const sandboxRun = (hash: string, patch: Partial<Run> = {}): Run =>
      run(hash, {
        source: { type: 'sandbox', id: sandboxId, repo: REPO, commit, tree: 'x' },
        ...patch,
      })

    async function executeWith(executor: HostExecutor, r: Run) {
      const events: RunEventData[] = []
      const error = await executor
        .execute(r, { emit: (e) => events.push(e), signal: new AbortController().signal })
        .then(
          () => undefined,
          (e: Error) => e
        )
      return { events, error, text: events.map((e) => (e.type === 'log' ? e.text : '')).join('\n') }
    }

    beforeEach(async () => {
      sandboxes = new SandboxRegistry({
        storage: new HostSandboxStorage(join(root, 'sandboxes'), process.env),
        records: join(root, 'sandbox-records'),
        limits: { count: 5, bytes: 1024 * 1024 * 1024, total: 1024 * 1024 * 1024 },
        repos: options.repos,
      })
      const sandbox = await sandboxes.create(alice, REPO, 'main')
      sandboxId = sandbox.id
      files = await sandboxes.attach(sandboxId)
    })

    it('runs the published tasks on the files of the sandbox, which keep what they wrote', async () => {
      const hash = await publish({
        '.hammerkit.yaml': 'tasks:\n  build:\n    cmds:\n      - cat input.txt\n      - echo written > out.txt\n',
      })
      writeFileSync(join(files, 'input.txt'), 'changed-in-the-sandbox')
      const { error, text } = await executeWith(onSandbox(), sandboxRun(hash))
      expect(error).toBeUndefined()
      expect(text).toContain('changed-in-the-sandbox')
      expect(text).not.toContain('from-the-repository')
      expect(text).toMatch(new RegExp(`sandbox ${sandboxId} of ${REPO} at ${commit}, files [0-9a-f]+ with changes`))
      expect(existsSync(join(files, 'out.txt'))).toBe(true)
      // the published build file is not written into the sandbox
      expect(readFileSync(join(files, '.hammerkit.yaml'), 'utf8')).toContain('from-the-repository')
      expect(existsSync(join(runs, 'run_test'))).toBe(false)
    })

    it('works in the directory of the sandbox where the published build file is', async () => {
      const hash = await publish(
        {
          'ci/build.yaml': 'tasks:\n  build:\n    cmds:\n      - cat ../input.txt\n      - echo nested > nested.txt\n',
        },
        'ci/build.yaml'
      )
      mkdirSync(join(files, 'ci'))
      const { error, text } = await executeWith(onSandbox(), sandboxRun(hash))
      expect(error).toBeUndefined()
      expect(text).toContain('hello')
      expect(existsSync(join(files, 'ci', 'nested.txt'))).toBe(true)
    })

    it('runs only on the runtimes of sandboxes, and under their network', async () => {
      const hash = await publish({ '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo local]\n' })
      const containers = await executeWith(onSandbox(['docker']), sandboxRun(hash))
      expect(containers.error?.message).toMatch(/runs on the local runtime, which this server does not allow/)
      const closed = await executeWith(onSandbox(['docker', 'local'], 'none'), sandboxRun(hash))
      expect(closed.error?.message).toMatch(/--network none needs every task in a container/)
    })

    it('keeps a sandbox run under runs.network as well as sandboxes.network', async () => {
      const ceiling: NetworkSchema = { allow: ['registry.npmjs.org'] }
      const policy = { ...options.planning.policy, network: { type: 'allow' as const, hosts: ['registry.npmjs.org'] } }
      const limited = new HostExecutor({
        ...options,
        planning: { ...options.planning, policy },
        worker: TELLING_WORKER,
        sandboxes: { registry: sandboxes, policy: { ...policy, runtimes: ['docker', 'local'] }, network: 'open' },
      })
      const yaml = (setting: string) =>
        `tasks:\n  build:\n    image: node:22\n    network: ${setting}\n    cmds: [npm ci]\n`
      const { events, error } = await executeWith(
        limited,
        sandboxRun(await publish({ '.hammerkit.yaml': yaml('none') }))
      )
      expect(error).toBeUndefined()
      expect(events).toContainEqual({ type: 'log', task: 't', stream: 'stdout', text: JSON.stringify(ceiling) })

      const open = await executeWith(limited, sandboxRun(await publish({ '.hammerkit.yaml': yaml('open') })))
      expect(open.error?.message).toMatch(/more than this server allows/)
    })

    it('keeps the cache of a sandbox run apart from runs of the repository, one per owner', async () => {
      const hash = await publish({ '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo ok]\n' })
      await execute(run(hash))
      expect((await executeWith(onSandbox(), sandboxRun(hash))).error).toBeUndefined()
      const spaces = readdirSync(join(root, 'cache')).sort()
      expect(spaces).toHaveLength(2)
      expect(spaces.filter((name) => name.startsWith('sandbox-'))).toHaveLength(1)
    })

    it('fails a run on a sandbox that was deleted, and one without sandboxes', async () => {
      const hash = await publish({ '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo ok]\n' })
      expect((await execute(sandboxRun(hash))).error?.message).toBe('this server keeps no sandboxes')
      await sandboxes.remove(alice, sandboxId)
      expect((await executeWith(onSandbox(), sandboxRun(hash))).error?.message).toBe(
        `the sandbox ${sandboxId} was deleted`
      )
    })
  })
})
