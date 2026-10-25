import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AppsV1Api, BatchV1Api, CoreV1Api, KubeConfig } from '@kubernetes/client-node'
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

function cluster(): { config: KubeConfig; core: CoreV1Api; batch: BatchV1Api; apps: AppsV1Api } {
  const config = new KubeConfig()
  config.loadFromDefault()
  config.setCurrentContext(context)
  return {
    config,
    core: config.makeApiClient(CoreV1Api),
    batch: config.makeApiClient(BatchV1Api),
    apps: config.makeApiClient(AppsV1Api),
  }
}

const BUILD_FILE = `
tasks:
  # a claim of its own (generates) keeps it out of the runner: it runs as a Job
  build:
    image: alpine:3.19
    src: [src]
    generates: [dist]
    cmds:
      - echo "host=$(hostname)"
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
  fetch:
    image: node:24-alpine
    src: [src]
    network:
      allow: [registry.npmjs.org]
    cmds:
      - echo "left-pad:$(npm view left-pad version)"
      # around the proxy, to an address outside of the allow list: the policy of the runner
      - wget -Y off -q -T 5 -O /dev/null http://1.1.1.1 > /dev/null 2>&1 && echo direct=escaped || echo direct=refused
  # shells of the sandbox: their commands run in its runner, one pod for all of them
  leave:
    image: alpine:3.19
    src: [src]
    cmds:
      - echo "host=$(hostname)"
      - sleep 300 > /dev/null 2>&1 &
      # the server's root is a temporary directory, so the run's directory of the sandbox is
      # below /tmp too: in the runner a link to the files, which the cleanup of /tmp leaves
      - echo left > /dev/shm/mark && echo left > /tmp/mark && echo kept > /root/kept
  look:
    image: alpine:3.19
    src: [src]
    cmds:
      - echo "host=$(hostname)"
      - echo "sleeping=$(ps -o args | grep -c '[s]leep 300')"
      - test -e /dev/shm/mark || echo shm-empty
      - test -e /tmp/mark || echo tmp-empty
      - echo "files=$(cat src/app.ts | grep -c answer)"
      - echo "root=$(cat /root/kept)"
      - test -e /dev/shm/cancelled || echo cancel-cleaned
  fail:
    image: alpine:3.19
    src: [src]
    cmds:
      - echo before-the-exit && exit 7
  slow:
    image: alpine:3.19
    src: [src]
    cmds:
      - echo cancelled > /dev/shm/cancelled && echo slow-started && sleep 300
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
          // runs on sandboxes reach the services they need and the registry, through the
          // egress proxy of each task (sandboxes.network)
          networkPolicy: 'enforced',
          defaultResources: { requests: { cpu: '10m', memory: '16Mi' } },
          sandboxes: { image, size: '1Gi' },
        },
        sandboxes: { network: { allow: ['registry.npmjs.org'] } },
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
      const { core, batch, apps } = cluster()
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

      const execute = async (
        id: string,
        task: string,
        signal = new AbortController().signal,
        onEvent: (event: RunEventData) => void = () => undefined
      ) => {
        const current = await registry.state(sandbox.id)
        const run: Run = {
          id,
          owner: alice,
          state: 'running',
          createdAt: new Date().toISOString(),
          definition: version.hash,
          tasks: [task],
          accounts: [],
          source: { type: 'sandbox', id: sandbox.id, repo: REPO, commit: current.commit, tree: current.tree },
          options: {},
        }
        const events: RunEventData[] = []
        const error = await executor
          .execute(run, {
            emit: (e) => {
              events.push(e)
              onEvent(e)
            },
            signal,
          })
          .then(
            () => undefined,
            (e: Error) => e
          )
        return { error, events, text: events.map((e) => (e.type === 'log' ? e.text : '')).join('\n') }
      }
      const filesPod = async () =>
        (await core.readNamespacedPod({ name: names.pod, namespace: callerNamespace })).metadata?.uid
      // the egress proxies of the sandbox's tasks, by name, with their uid and owner
      const proxies = async () =>
        Object.fromEntries(
          (
            await apps.listNamespacedDeployment({
              namespace: callerNamespace,
              labelSelector: `hammerkit.dev/proxy-of-sandbox=${names.label}`,
            })
          ).items
            .filter((deployment) => !deployment.metadata?.deletionTimestamp)
            .map((deployment) => [
              deployment.metadata?.name,
              { uid: deployment.metadata?.uid, owner: deployment.metadata?.ownerReferences?.[0]?.uid },
            ])
        )
      const podBefore = await filesPod()
      // a task that reaches the registry through its proxy, which stays with the sandbox
      const fetched = await execute('run_sbx_fetch_1', 'fetch')
      expect(fetched.error, fetched.text).toBeUndefined()
      expect(fetched.text).toMatch(/left-pad:\d+\.\d+\.\d+/)
      expect(fetched.text).toContain('direct=refused')
      const fetchProxies = await proxies()
      expect(Object.values(fetchProxies)).toEqual([{ uid: expect.any(String), owner: podBefore }])

      const { error, events, text } = await execute('run_sbx_one_-', 'build')
      expect(error, text).toBeUndefined()
      // the pod of the files stayed through the run, whose Job went to its node: the claim
      // never moved
      expect(podBefore).toBeDefined()
      expect(await filesPod()).toBe(podBefore)
      // the Job read the edit and wrote into the claim
      expect(text).toMatch(/host=(?!hammerkit-runner-)\S+/)
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

      // the next run of the task, on the files the build changed, uses the same proxy
      const again = await execute('run_sbx_fetch_2', 'fetch')
      expect(again.error, again.text).toBeUndefined()
      expect(again.text).toMatch(/left-pad:\d+\.\d+\.\d+/)
      expect(await proxies()).toMatchObject(fetchProxies)

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

      // a shell's commands go into the runner of the sandbox, the next ones into the same pod:
      // the container stays, but no process of a command, nor what it left in /dev/shm
      const runners = async () =>
        (
          await core.listNamespacedPod({
            namespace: callerNamespace,
            labelSelector: `hammerkit.dev/sandbox=${names.label},hammerkit.dev/runner`,
          })
        ).items.filter((pod) => !pod.metadata?.deletionTimestamp)
      const hosts = (text: string) => [...text.matchAll(/host=(\S+)/g)].map((match) => match[1])
      const left = await execute('run_sbx_leave', 'leave')
      expect(left.error, left.text).toBeUndefined()
      const looked = await execute('run_sbx_look', 'look')
      expect(looked.error, looked.text).toBeUndefined()
      const [runner] = await runners()
      expect(runner?.metadata?.name).toMatch(/^hammerkit-runner-[0-9a-f]{20}$/)
      expect(runner?.metadata?.ownerReferences?.[0]?.uid).toBe(await filesPod())
      expect([...hosts(left.text), ...hosts(looked.text)]).toEqual(Array(2).fill(runner?.metadata?.name))
      expect(looked.text).toContain('sleeping=0')
      expect(looked.text).toContain('shm-empty')
      expect(looked.text).toContain('tmp-empty')
      expect(looked.text).toContain('files=1')
      expect(looked.text).toContain('root=kept')
      // a command's exit code is the task's
      const failed = await execute('run_sbx_fail', 'fail')
      expect(failed.error?.message).toBe('fail failed')
      expect(failed.text).toContain('before-the-exit')
      expect(failed.events).toContainEqual(
        expect.objectContaining({ type: 'task', task: 'fail', state: 'failed', exitCode: 7 })
      )
      // a cancelled command is killed in the runner, which stays
      const cancel = new AbortController()
      let started = false
      const slow = execute('run_sbx_slow', 'slow', cancel.signal, (event) => {
        started ||= event.type === 'log' && event.text.includes('slow-started')
      })
      for (let attempt = 0; !started && attempt < 240; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      expect(started).toBe(true)
      const cancelled = Date.now()
      cancel.abort()
      const stopped = await slow
      expect(stopped.error?.message).toBe('the run was cancelled')
      expect(Date.now() - cancelled).toBeLessThan(20_000)
      const after = await execute('run_sbx_look_2', 'look')
      expect(after.error, after.text).toBeUndefined()
      expect(after.text).toContain('sleeping=0')
      expect(after.text).toContain('cancel-cleaned')
      // and the files of the sandbox, below /tmp, are all still there
      expect((await registry.files(alice, sandbox.id).read('src/app.ts', {})).content).toContain('42')
      expect(hosts(after.text)).toEqual([runner?.metadata?.name])

      await registry.remove(alice, sandbox.id)
      // the runner and its limits go with the sandbox
      for (let attempt = 0; (await runners()).length > 0 && attempt < 60; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      expect(await runners()).toEqual([])
      // the proxies go with the pod of the files, which owned them
      for (let attempt = 0; Object.keys(await proxies()).length > 0 && attempt < 60; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      expect(await proxies()).toEqual({})
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
