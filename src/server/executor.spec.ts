import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { environmentMock } from '../executer/environment-mock'
import { DefinitionStore } from './definitions'
import { HostExecutor, passedEnvironment } from './executor'
import { Run, RunEventData } from './runs'
import { ServerConfig, serverConfigSchema } from './server-config'

const alice = { iss: 'https://idp.corp', sub: 'alice' }

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
  })
}

describe('passedEnvironment', () => {
  it('passes the tools to find docker and nothing the operator keeps for the server', () => {
    expect(
      passedEnvironment({
        PATH: '/bin',
        DOCKER_HOST: 'unix:///x',
        DATABASE_PASSWORD: 'secret',
        OAUTH_CLIENT_SECRET: 'x',
      })
    ).toEqual({ PATH: '/bin', DOCKER_HOST: 'unix:///x' })
  })
})

describe('HostExecutor', () => {
  let root: string
  let repository: string
  let store: DefinitionStore
  let executor: HostExecutor
  let runs: string

  const config = (): ServerConfig =>
    serverConfigSchema.parse({
      issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
      sources: { payments: { git: repository } },
    })

  async function publish(files: { [path: string]: string }): Promise<string> {
    const { version } = await store.publish('payments', { entry: '.hammerkit.yaml', files }, alice)
    return version.hash
  }

  const run = (hash: string, patch: Partial<Run> = {}): Run => ({
    id: 'run_test',
    owner: alice,
    state: 'running',
    createdAt: new Date().toISOString(),
    definition: { name: 'payments', hash },
    tasks: ['build'],
    account: null,
    source: { type: 'ref', ref: 'main' },
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
    const environment = environmentMock(root)
    store = new DefinitionStore(join(root, 'definitions'), environment)
    await store.load()
    executor = new HostExecutor({
      config: config(),
      definitions: store,
      environment: {
        ...environment,
        processEnvs: { ...passedEnvironment(process.env), SECRET_OF_SERVER: 'x' },
      },
      directory: runs,
    })
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
    expect(events).toContainEqual({ type: 'task', task: 'build', state: 'running' })
    expect(events).toContainEqual({ type: 'task', task: 'build', state: 'succeeded' })
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

  it('fails the run when a task fails, with the task and its output', async () => {
    const hash = await publish({
      '.hammerkit.yaml': 'tasks:\n  build:\n    cmds:\n      - echo broken >&2\n      - exit 3\n',
    })
    const { events, error } = await execute(run(hash))
    expect(error?.message).toBe('build failed')
    expect(events).toContainEqual({ type: 'task', task: 'build', state: 'failed' })
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
    expect(events).toContainEqual({ type: 'task', task: 'build', state: 'succeeded' })
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

  it('fails with the reason when the server has no repository for the build file', async () => {
    const hash = await publish({ '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo ok]\n' })
    const other = new HostExecutor({
      config: serverConfigSchema.parse({ issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }] }),
      definitions: store,
      environment: environmentMock(root),
      directory: runs,
    })
    await expect(
      other.execute(run(hash), { emit: () => undefined, signal: new AbortController().signal })
    ).rejects.toThrow('sources.payments.git')
  })

  it('refuses a run from an upload, there is nothing to take the files from yet', async () => {
    const hash = await publish({ '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo ok]\n' })
    const { error } = await execute(run(hash, { source: { type: 'upload', snapshot: 'snap' } }))
    expect(error?.message).toContain('upload')
  })

  it('fails when the ref does not exist', async () => {
    const hash = await publish({ '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo ok]\n' })
    const { error } = await execute(run(hash, { source: { type: 'ref', ref: 'missing' } }))
    expect(error?.message).toContain('unable to fetch')
  })

  it('does not write a published file into the git directory of the source', async () => {
    const hash = await publish({
      '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo ok]\n',
      '.git/hooks/post-checkout': 'evil',
    })
    const { error } = await execute(run(hash))
    expect(error?.message).toContain('can not be written')
  })

  it('fails when the build file is no longer on the server', async () => {
    const { error } = await execute(run('0'.repeat(64)))
    expect(error?.message).toContain('no longer on this server')
  })
})
