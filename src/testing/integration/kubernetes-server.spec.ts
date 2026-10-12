import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BatchV1Api, CoreV1Api, KubeConfig } from '@kubernetes/client-node'
import { requiresKubernetes } from '../requires-kubernetes'
import { environmentMock } from '../../executer/environment-mock'
import { DefinitionStore } from '../../server/definitions'
import { KubernetesExecutor, getCallerNamespace } from '../../server/kubernetes-backend'
import { RepoAccess } from '../../server/repo-access'
import { PlanContext } from '../../server/run-plan'
import { runEnvironment } from '../../server/run-environment'
import { Run, RunEventData } from '../../server/runs'
import { getSecretCatalog, ServerConfig, serverConfigSchema } from '../../server/server-config'
import { HOST_ENV_ALLOW } from '../host-env'
import { TEST_WORKER } from '../worker'

// A server with a Kubernetes backend runs the tasks of a run as Jobs in the
// caller's namespace, reads the secrets of providers in the Job with the account's
// credentials from the server's namespace, and leaves nothing behind.

const context = process.env.CLUSTER_NAME || 'docker-desktop'
const suffix = Date.now().toString(36)
const operatorNamespace = `hammerkit-srv-ops-${suffix}`
const prefix = `hk-srv-${suffix}-`
const alice = { iss: 'https://idp.corp', sub: 'alice' }
const callerNamespace = getCallerNamespace(prefix, alice)
const REPO = 'git.test/corp/payments'
const KEY = 'value-of-the-operator-7f3a'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
  })
}

function cluster(): { core: CoreV1Api; batch: BatchV1Api } {
  const config = new KubeConfig()
  config.loadFromDefault()
  config.setCurrentContext(context)
  return { core: config.makeApiClient(CoreV1Api), batch: config.makeApiClient(BatchV1Api) }
}

const BUILD_FILE = `
tasks:
  build:
    image: alpine:3.19
    src: [input.txt]
    generates: [out]
    secrets:
      - { from: "files:api-key", account: ci, env: API_KEY }
      - { from: "files:token", account: ci, path: /run/secrets/token }
    cmds:
      - echo "key=$API_KEY"
      - test -s /run/secrets/token && echo token-present
      - mkdir -p out && cat input.txt > out/result.txt
  check:
    deps: [build]
    src: [input.txt]
    cmds:
      - echo "read $(cat out/result.txt)"
`

describe('kubernetes backend of a server', () => {
  let root: string
  let executor: KubernetesExecutor
  let store: DefinitionStore
  let commit: string

  beforeAll(
    requiresKubernetes(async () => {
      const { core } = cluster()
      await core.createNamespace({ body: { metadata: { name: operatorNamespace } } })
      await core.createNamespacedServiceAccount({ namespace: operatorNamespace, body: { metadata: { name: 'ci' } } })
      await core.createNamespacedSecret({
        namespace: operatorNamespace,
        body: { metadata: { name: 'ci-files' }, stringData: { 'api-key': KEY } },
      })
    })
  )

  afterAll(
    requiresKubernetes(async () => {
      const { core } = cluster()
      for (const name of [operatorNamespace, callerNamespace]) {
        await core.deleteNamespace({ name }).catch(() => undefined)
      }
    })
  )

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hammerkit-kubernetes-server-'))
    const repository = join(root, 'repository')
    mkdirSync(repository)
    git(repository, 'init', '--quiet', '--initial-branch=main')
    writeFileSync(join(repository, 'input.txt'), 'hello from the checkout')
    git(repository, 'add', '.')
    git(repository, 'commit', '--quiet', '-m', 'one')
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()

    const config: ServerConfig = serverConfigSchema.parse({
      issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
      runs: { env: { allow: HOST_ENV_ALLOW } },
      runtimes: ['docker', 'local'],
      sources: [{ match: 'git.test/corp/*' }],
      secretProviders: { files: { command: ['cat', '/var/run/hammerkit/account/{{ref}}'] } },
      accounts: {
        ci: { providers: { files: { env: {} } }, kubernetes: { serviceAccount: 'ci', secret: 'ci-files' } },
      },
      backend: {
        type: 'kubernetes',
        context,
        namespace: operatorNamespace,
        namespacePrefix: prefix,
        pools: [{ name: 'default', toolImage: 'alpine:3.19' }],
        providers: { files: { image: 'alpine:3.19' } },
        quota: { pods: 20 },
        defaultResources: { requests: { cpu: '10m', memory: '16Mi' } },
      },
    })
    const planning: PlanContext = {
      environment: {
        ...environmentMock(root),
        processEnvs: runEnvironment(config, process.env),
        hosted: { catalog: getSecretCatalog(config) },
      },
      policy: { envs: config.runs.env.allow, runtimes: config.runtimes, backend: 'kubernetes' },
    }
    store = new DefinitionStore(join(root, 'definitions'), planning.environment, { policy: planning.policy })
    executor = new KubernetesExecutor(config as ServerConfig & { backend: any }, process.env, {
      definitions: store,
      planning,
      repos: new RepoAccess(config, planning.environment, { url: () => repository }),
      directory: join(root, 'runs'),
      cache: join(root, 'cache'),
      worker: TEST_WORKER,
    })
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  async function execute(id: string, hash: string) {
    const run: Run = {
      id,
      owner: alice,
      state: 'running',
      createdAt: new Date().toISOString(),
      definition: { name: 'payments', hash },
      tasks: ['check'],
      accounts: ['ci'],
      source: { type: 'ref', repo: REPO, ref: 'main', commit },
      options: {},
    }
    const events: RunEventData[] = []
    const error = await executor
      .execute(run, { emit: (e) => events.push(e), signal: new AbortController().signal })
      .then(
        () => undefined,
        (e: Error) => e
      )
    const text = events.map((e) => (e.type === 'log' ? e.text : '')).join('\n')
    return { events, error, text }
  }

  it(
    'runs the tasks as Jobs in the caller’s namespace, reads secrets in the Job and cleans up',
    requiresKubernetes(async () => {
      await store.load()
      const { version } = await store.publish(
        'payments',
        { entry: '.hammerkit.yaml', files: { '.hammerkit.yaml': BUILD_FILE } },
        alice
      )

      const first = await execute('run_k8s_one', version.hash)
      expect(first.error).toBeUndefined()
      expect(first.text).toContain(`runs in the namespace ${callerNamespace}`)
      expect(first.text).toContain('key=***')
      expect(first.text).toContain('token-present')
      expect(first.text).not.toContain(KEY)
      // the local task ran in the tool image, on the output of the container task
      expect(first.text).toContain('read hello from the checkout')
      expect(first.events).toContainEqual({ type: 'task', task: 'build', state: 'succeeded' })
      expect(first.events).toContainEqual({ type: 'task', task: 'check', state: 'succeeded' })

      const { core, batch } = cluster()
      const quota = await core.readNamespacedResourceQuota({ name: 'hammerkit', namespace: callerNamespace })
      expect(quota.spec?.hard).toEqual({ pods: '20' })
      const selector = { namespace: callerNamespace, labelSelector: 'hammerkit.dev/run=run_k8s_one' }
      const left = async () =>
        [
          ...(await batch.listNamespacedJob(selector)).items,
          ...(await core.listNamespacedSecret(selector)).items,
          ...(await core.listNamespacedPersistentVolumeClaim(selector)).items,
        ].filter((item) => !item.metadata?.deletionTimestamp)
      expect(await left()).toEqual([])

      // the outputs went to the server's cache, so the next run of the same code hits
      // on the task it asked for, and nothing runs again
      const second = await execute('run_k8s_two', version.hash)
      expect(second.error).toBeUndefined()
      expect(second.events).toContainEqual({ type: 'task', task: 'check', state: 'cached' })
      expect(second.events).not.toContainEqual({ type: 'task', task: 'build', state: 'succeeded' })
      expect(second.text).not.toContain('read hello from the checkout')
    })
  )
})
