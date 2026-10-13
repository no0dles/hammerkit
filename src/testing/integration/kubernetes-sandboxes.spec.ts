import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BatchV1Api, CoreV1Api, KubeConfig } from '@kubernetes/client-node'
import { requiresKubernetes } from '../requires-kubernetes'
import { environmentMock } from '../../executer/environment-mock'
import { DefinitionStore } from '../../server/definitions'
import { getCallerNamespace, KubernetesExecutor } from '../../server/kubernetes-backend'
import { getSandboxNames, KubernetesSandboxStorage } from '../../server/kubernetes-sandbox-storage'
import { RepoAccess } from '../../server/repo-access'
import { PlanContext } from '../../server/run-plan'
import { runEnvironment } from '../../server/run-environment'
import { Run, RunEventData } from '../../server/runs'
import { SandboxRegistry } from '../../server/sandboxes'
import { getSecretCatalog, KubernetesBackend, ServerConfig, serverConfigSchema } from '../../server/server-config'
import { HOST_ENV_ALLOW } from '../host-env'
import { TEST_WORKER } from '../worker'

// A server with a Kubernetes backend keeps a sandbox as a claim in the caller's
// namespace: its pod fetches and edits the files, the Jobs of a run on it mount the
// claim, and what a task writes is in the sandbox afterwards.
//
// The pod of the files runs hammerkit itself, so the cluster needs an image of this
// source: `docker build -t hammerkit:dev . && kind load docker-image hammerkit:dev`, or
// another tag in HAMMERKIT_SANDBOX_IMAGE (CI builds one).

const context = process.env.CLUSTER_NAME || 'docker-desktop'
const image = process.env.HAMMERKIT_SANDBOX_IMAGE || 'hammerkit:dev'
const suffix = Date.now().toString(36)
const operatorNamespace = `hammerkit-sbx-ops-${suffix}`
const prefix = `hk-sbx-${suffix}-`
const alice = { iss: 'https://idp.corp', sub: 'alice' }
const callerNamespace = getCallerNamespace(prefix, alice)
const REPO = 'git.test/corp/payments'

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
    src: [src]
    cmds:
      - cat src/app.ts
      - echo generated-in-the-job > src/generated.txt
`

describe('sandboxes on a kubernetes backend', () => {
  let root: string

  beforeAll(
    requiresKubernetes(async () => {
      await cluster().core.createNamespace({ body: { metadata: { name: operatorNamespace } } })
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
    root = mkdtempSync(join(tmpdir(), 'hammerkit-kubernetes-sandboxes-'))
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it(
    'fetches into a claim, edits in its pod, runs Jobs on the claim and removes it with the sandbox',
    requiresKubernetes(async () => {
      const repository = join(root, 'repository')
      mkdirSync(join(repository, 'src'), { recursive: true })
      git(repository, 'init', '--quiet', '--initial-branch=main')
      writeFileSync(join(repository, 'src', 'app.ts'), 'export const answer = 41\n')
      git(repository, 'add', '.')
      git(repository, 'commit', '--quiet', '-m', 'one')

      const config = serverConfigSchema.parse({
        issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
        runs: { env: { allow: HOST_ENV_ALLOW } },
        sources: [{ match: 'git.test/corp/*' }],
        backend: {
          type: 'kubernetes',
          context,
          namespace: operatorNamespace,
          namespacePrefix: prefix,
          defaultResources: { requests: { cpu: '10m', memory: '16Mi' } },
          sandboxes: { image, size: '1Gi' },
        },
      }) as ServerConfig & { backend: KubernetesBackend }
      const planning: PlanContext = {
        environment: {
          ...environmentMock(root),
          processEnvs: runEnvironment(config, process.env),
          hosted: { catalog: getSecretCatalog(config) },
        },
        policy: { envs: config.runs.env.allow, runtimes: config.runtimes, backend: 'kubernetes' },
      }
      const repos = new RepoAccess(config, planning.environment, { url: () => repository })
      const limits = { count: 5, bytes: 20 * 1024 * 1024 * 1024, total: 100 * 1024 * 1024 * 1024 }
      const registry = new SandboxRegistry({
        storage: new KubernetesSandboxStorage(config, limits, process.env, join(root, 'staging')),
        records: join(root, 'records'),
        limits,
        repos,
      })
      await registry.load()
      const store = new DefinitionStore(join(root, 'definitions'), planning.environment, { policy: planning.policy })
      await store.load()
      const { version } = await store.publish(
        'payments',
        { entry: '.hammerkit.yaml', files: { '.hammerkit.yaml': BUILD_FILE } },
        alice
      )
      const executor = new KubernetesExecutor(config, process.env, {
        definitions: store,
        planning,
        repos,
        directory: join(root, 'runs'),
        cache: join(root, 'cache'),
        worker: TEST_WORKER,
        sandboxes: {
          registry,
          policy: { ...planning.policy, runtimes: config.sandboxes.runtimes },
          network: config.sandboxes.network,
        },
      })

      const sandbox = await registry.create(alice, REPO, 'main')
      const { core, batch } = cluster()
      const names = getSandboxNames(sandbox.id)
      const claim = await core.readNamespacedPersistentVolumeClaim({ name: names.claim, namespace: callerNamespace })
      expect(claim.metadata?.annotations?.['hammerkit.dev/sandbox-id']).toBe(sandbox.id)

      await registry.edit(alice, sandbox.id, [
        { op: 'replace', path: 'src/app.ts', old_string: '41', new_string: '42' },
      ])
      const state = await registry.state(sandbox.id)
      expect(state.clean).toBe(false)

      const run: Run = {
        id: 'run_sbx_one',
        owner: alice,
        state: 'running',
        createdAt: new Date().toISOString(),
        definition: { name: 'payments', hash: version.hash },
        tasks: ['build'],
        accounts: [],
        source: { type: 'sandbox', id: sandbox.id, repo: REPO, commit: sandbox.commit, tree: state.tree },
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
      expect(error, text).toBeUndefined()
      // the Job read the edit and wrote into the claim
      expect(text).toContain('export const answer = 42')
      expect(events).toContainEqual({ type: 'task', task: 'build', state: 'succeeded' })
      const files = registry.files(alice, sandbox.id)
      expect((await files.read('src/generated.txt', {})).content).toContain('generated-in-the-job')
      const changes = await registry.read(alice, sandbox.id, (sandboxFiles) => sandboxFiles.changes())
      expect(changes.map((change) => [change.path, change.status])).toEqual([
        ['src/app.ts', 'modified'],
        ['src/generated.txt', 'added'],
      ])
      // what was made for the run is gone, the claim of the sandbox is not
      const jobs = await batch.listNamespacedJob({
        namespace: callerNamespace,
        labelSelector: 'hammerkit.dev/run=run_sbx_one',
      })
      expect(jobs.items.filter((job) => !job.metadata?.deletionTimestamp)).toEqual([])
      expect(registry.get(alice, sandbox.id)?.bytes).toBeGreaterThan(0)

      await registry.remove(alice, sandbox.id)
      const left = await core
        .readNamespacedPersistentVolumeClaim({ name: names.claim, namespace: callerNamespace })
        .then(
          (found) => !found.metadata?.deletionTimestamp,
          () => false
        )
      expect(left).toBe(false)
    })
  )
})
