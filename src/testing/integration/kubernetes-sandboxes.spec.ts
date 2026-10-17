import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BatchV1Api, CoreV1Api, KubeConfig } from '@kubernetes/client-node'
import { createServerAccount, ServerAccount } from '../kubernetes-server-account'
import { requiresKubernetes } from '../requires-kubernetes'
import { getRunLabelValue } from '../../kubernetes/job-placement'
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

// A server with a Kubernetes backend keeps a sandbox as claims in the caller's namespace:
// its pod fetches and edits the files, the Jobs of a run on it mount the claim of the
// files, what a task writes is in the sandbox afterwards, and the server pushes it. A link
// a task makes leads at most to the root of the claim of the files, never to git's data.
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
const bob = { iss: 'https://idp.corp', sub: 'bob' }
const callerNamespace = getCallerNamespace(prefix, alice)
const otherNamespace = getCallerNamespace(prefix, bob)
const REPO = 'git.test/corp/payments'

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' }
  ).trim()
}

function cluster(): { config: KubeConfig; core: CoreV1Api; batch: BatchV1Api } {
  const config = new KubeConfig()
  config.loadFromDefault()
  config.setCurrentContext(context)
  return { config, core: config.makeApiClient(CoreV1Api), batch: config.makeApiClient(BatchV1Api) }
}

const BUILD_FILE = `
tasks:
  build:
    image: alpine:3.19
    src: [src]
    cmds:
      - cat src/app.ts
      - echo generated-in-the-job > src/generated.txt
  plant:
    image: alpine:3.19
    src: [src]
    cmds:
      - rm -rf src/up
      - ln -s ../.. src/up
  peek:
    image: alpine:3.19
    deps: [plant]
    src: [src/up]
    cmds:
      - echo "seen:$(ls -A src/up | tr '\\n' ',')"
`

describe('sandboxes on a kubernetes backend', () => {
  let root: string
  // the server is a ServiceAccount with the rights of the docs only
  let account: ServerAccount | undefined
  const runRole = `${prefix}runs`

  beforeAll(
    requiresKubernetes(async () => {
      const { config, core } = cluster()
      await core.createNamespace({ body: { metadata: { name: operatorNamespace } } })
      account = await createServerAccount(config, operatorNamespace, { server: `${prefix}server`, runs: runRole })
    })
  )

  afterAll(
    requiresKubernetes(async () => {
      const { core } = cluster()
      for (const name of [operatorNamespace, callerNamespace, otherNamespace]) {
        await core.deleteNamespace({ name }).catch(() => undefined)
      }
      await account?.remove()
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
      mkdirSync(join(repository, 'src', 'up'), { recursive: true })
      git(repository, 'init', '--quiet', '--initial-branch=main')
      writeFileSync(join(repository, 'src', 'app.ts'), 'export const answer = 41\n')
      writeFileSync(join(repository, 'src', 'up', 'keep.txt'), 'keep\n')
      git(repository, 'add', '.')
      git(repository, 'commit', '--quiet', '-m', 'one')
      const first = git(repository, 'rev-parse', 'HEAD')

      const config = serverConfigSchema.parse({
        issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
        runs: { env: { allow: HOST_ENV_ALLOW } },
        sources: [{ match: 'git.test/corp/*' }],
        backend: {
          type: 'kubernetes',
          kubeconfig: account?.kubeconfig,
          context: account ? 'hammerkit' : context,
          runRole,
          namespace: operatorNamespace,
          namespacePrefix: prefix,
          // runs on sandboxes have no network but the services they need (sandboxes.network)
          networkPolicy: 'enforced',
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
      // the source has a secret, so the sandboxes may push; it reads and pushes with the
      // environment of the test, which can write to the repository on disk
      const testCredentials = async () => ({ env: { ...(process.env as { [key: string]: string }) }, values: [] })
      const pushing = Object.assign(Object.create(repos) as RepoAccess, {
        source: () => ({
          match: 'git.test/corp/*',
          secret: { from: 'echo:scm-token', account: 'scm', username: 'x-access-token' },
        }),
        credentials: testCredentials,
        pushCredentials: testCredentials,
      })
      const registry = new SandboxRegistry({
        storage: new KubernetesSandboxStorage(config, limits, process.env, join(root, 'staging')),
        records: join(root, 'records'),
        limits,
        repos: pushing,
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
      for (const name of [names.claim, names.git]) {
        const claim = await core.readNamespacedPersistentVolumeClaim({ name, namespace: callerNamespace })
        expect(claim.metadata?.annotations?.['hammerkit.dev/sandbox-id']).toBe(sandbox.id)
      }

      await registry.edit(alice, sandbox.id, [
        { op: 'replace', path: 'src/app.ts', old_string: '41', new_string: '42' },
      ])
      const state = await registry.state(sandbox.id)
      expect(state.clean).toBe(false)
      // the pod's image has ripgrep: a search runs there
      const found = await registry.files(alice, sandbox.id).search({ pattern: 'answer = 42' })
      expect(found.files).toEqual(['src/app.ts'])

      // another caller neither sees the sandbox nor shares its namespace
      expect(otherNamespace).not.toBe(callerNamespace)
      expect(() => registry.files(bob, sandbox.id)).toThrow('not found')
      const other = await registry.create(bob, REPO, 'main')
      const otherClaim = getSandboxNames(other.id).claim
      expect(
        (await core.readNamespacedPersistentVolumeClaim({ name: otherClaim, namespace: otherNamespace })).metadata?.name
      ).toBe(otherClaim)
      expect(
        await core.readNamespacedPersistentVolumeClaim({ name: otherClaim, namespace: callerNamespace }).then(
          () => true,
          () => false
        )
      ).toBe(false)
      await registry.remove(bob, other.id)

      const execute = async (id: string, task: string) => {
        const current = await registry.state(sandbox.id)
        const run: Run = {
          id,
          owner: alice,
          state: 'running',
          createdAt: new Date().toISOString(),
          definition: { name: 'payments', hash: version.hash },
          tasks: [task],
          accounts: [],
          source: { type: 'sandbox', id: sandbox.id, repo: REPO, commit: current.commit, tree: current.tree },
          options: {},
        }
        const events: RunEventData[] = []
        const error = await executor
          .execute(run, { emit: (e) => events.push(e), signal: new AbortController().signal })
          .then(
            () => undefined,
            (e: Error) => e
          )
        return { error, events, text: events.map((e) => (e.type === 'log' ? e.text : '')).join('\n') }
      }
      const filesPod = async () =>
        (await core.readNamespacedPod({ name: names.pod, namespace: callerNamespace })).metadata?.uid
      const podBefore = await filesPod()
      const { error, events, text } = await execute('run_sbx_one_-', 'build')
      expect(error, text).toBeUndefined()
      // the pod of the files stayed through the run, whose Job went to its node: the claim
      // never moved
      expect(podBefore).toBeDefined()
      expect(await filesPod()).toBe(podBefore)
      // the Job read the edit and wrote into the claim
      expect(text).toContain('export const answer = 42')
      expect(events).toContainEqual(expect.objectContaining({ type: 'task', task: 'build', state: 'succeeded' }))
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
        labelSelector: `hammerkit.dev/run=${getRunLabelValue('run_sbx_one_-')}`,
      })
      expect(jobs.items.filter((job) => !job.metadata?.deletionTimestamp)).toEqual([])
      expect(registry.get(alice, sandbox.id)?.bytes).toBeGreaterThan(0)

      // the server pushes the changes, with nothing of git run in the caller's namespace
      const pushed = await registry.push(
        alice,
        sandbox.id,
        'agent/k8s',
        {
          name: 'Alice Agent',
          email: 'alice@corp.test',
          message: 'Agent work',
        },
        ['agent/**']
      )
      expect(git(repository, 'rev-parse', 'agent/k8s')).toBe(pushed.commit)
      expect(git(repository, 'rev-parse', 'agent/k8s^')).toBe(first)
      expect(git(repository, 'show', 'agent/k8s:src/app.ts')).toContain('answer = 42')
      expect(git(repository, 'show', 'agent/k8s:src/generated.txt')).toContain('generated-in-the-job')
      expect(await registry.state(sandbox.id)).toMatchObject({ commit: pushed.commit, clean: true })

      // a task turns a source of the next one into a link up and out of the files: it leads
      // to the root of the claim of the files, which has nothing of git
      const escape = await execute('run_sbx_two', 'peek')
      expect(escape.error, escape.text).toBeUndefined()
      const seen = escape.text.match(/seen:(.*)/)?.[1]
      expect(seen, escape.text).toBeDefined()
      expect((seen as string).split(',').filter((name) => name && name !== 'lost+found')).toEqual(['files'])

      await registry.remove(alice, sandbox.id)
      for (const name of [names.claim, names.git]) {
        const left = await core.readNamespacedPersistentVolumeClaim({ name, namespace: callerNamespace }).then(
          (found) => !found.metadata?.deletionTimestamp,
          () => false
        )
        expect(left).toBe(false)
      }
    })
  )
})
