import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  AppsV1Api,
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  NetworkingV1Api,
  RbacAuthorizationV1Api,
  V1PolicyRule,
} from '@kubernetes/client-node'
import { requiresKubernetes } from '../requires-kubernetes'
import { getRunLabelValue } from '../../kubernetes/job-placement'
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
// credentials from the server's namespace, and leaves nothing behind. It does so with
// the rights the docs give it (website/content/docs/remote-compute/backend.mdx), as a
// ServiceAccount of its own.

const context = process.env.CLUSTER_NAME || 'docker-desktop'
const suffix = Date.now().toString(36)
const operatorNamespace = `hammerkit-srv-ops-${suffix}`
const prefix = `hk-srv-${suffix}-`
const alice = { iss: 'https://idp.corp', sub: 'alice' }
const callerNamespace = getCallerNamespace(prefix, alice)
const bob = { iss: 'https://idp.corp', sub: 'bob' }
const bobNamespace = getCallerNamespace(prefix, bob)
const REPO = 'git.test/corp/payments'
const KEY = 'value-of-the-operator-7f3a'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
  })
}

function cluster() {
  const config = new KubeConfig()
  config.loadFromDefault()
  config.setCurrentContext(context)
  return {
    config,
    core: config.makeApiClient(CoreV1Api),
    apps: config.makeApiClient(AppsV1Api),
    batch: config.makeApiClient(BatchV1Api),
    networking: config.makeApiClient(NetworkingV1Api),
    rbac: config.makeApiClient(RbacAuthorizationV1Api),
  }
}

// the roles of backend.mdx, "What the server may do"
const serverRole = `${prefix}server`
const runRole = `${prefix}runs`
const SERVER_RULES: V1PolicyRule[] = [
  { apiGroups: [''], resources: ['namespaces'], verbs: ['get', 'create'] },
  { apiGroups: ['rbac.authorization.k8s.io'], resources: ['rolebindings'], verbs: ['get', 'create', 'update'] },
  { apiGroups: ['rbac.authorization.k8s.io'], resources: ['clusterroles'], verbs: ['bind'], resourceNames: [runRole] },
]
const MANAGE = ['get', 'list', 'create', 'patch', 'delete', 'deletecollection']
const RUN_RULES: V1PolicyRule[] = [
  { apiGroups: [''], resources: ['resourcequotas', 'limitranges'], verbs: ['get', 'create', 'update', 'delete'] },
  {
    apiGroups: [''],
    resources: ['pods', 'pods/exec', 'pods/log', 'persistentvolumeclaims', 'secrets', 'services'],
    verbs: MANAGE,
  },
  { apiGroups: ['batch'], resources: ['jobs', 'jobs/status'], verbs: MANAGE },
  { apiGroups: ['apps'], resources: ['deployments'], verbs: MANAGE },
  {
    apiGroups: ['networking.k8s.io'],
    resources: ['networkpolicies'],
    verbs: ['get', 'list', 'create', 'update', 'patch', 'delete'],
  },
]
const ACCOUNT_RULES: V1PolicyRule[] = [
  { apiGroups: [''], resources: ['secrets'], verbs: ['get'], resourceNames: ['ci-files'] },
  { apiGroups: [''], resources: ['serviceaccounts/token'], verbs: ['create'], resourceNames: ['ci'] },
]

// A web server, which a task can reach unless its address is denied or its namespace
// is another caller's
async function startWebServer(core: CoreV1Api, name: string, namespace = operatorNamespace): Promise<string> {
  await core.createNamespacedPod({
    namespace,
    body: {
      metadata: { name },
      spec: {
        containers: [
          {
            name: 'web',
            image: 'busybox:1.36',
            command: ['sh', '-c', 'mkdir -p /www && echo ok > /www/index.html && httpd -f -p 8080 -h /www'],
          },
        ],
      },
    },
  })
  for (;;) {
    const pod = await core.readNamespacedPod({ name, namespace })
    if (pod.status?.phase === 'Running' && pod.status.podIP) {
      return pod.status.podIP
    }
    await sleep(1000)
  }
}

// Runs a script in a pod of its own and returns whether it succeeded.
async function runPod(core: CoreV1Api, namespace: string, name: string, script: string): Promise<boolean> {
  await core.createNamespacedPod({
    namespace,
    body: {
      metadata: { name },
      spec: {
        restartPolicy: 'Never',
        containers: [{ name: 'run', image: 'busybox:1.36', command: ['sh', '-c', script] }],
      },
    },
  })
  for (;;) {
    const pod = await core.readNamespacedPod({ name, namespace })
    if (pod.status?.phase === 'Succeeded' || pod.status?.phase === 'Failed') {
      await core.deleteNamespacedPod({ name, namespace, gracePeriodSeconds: 0 })
      return pod.status.phase === 'Succeeded'
    }
    await sleep(1000)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function until(check: () => Promise<boolean>, timeout: number, what: string): Promise<void> {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`${what} after ${timeout / 1000}s`)
    }
    await sleep(500)
  }
}

// What a run left in a namespace: nothing, once it ended.
async function left(run: string, namespace = callerNamespace) {
  const { core, apps, batch, networking } = cluster()
  const selector = { namespace, labelSelector: `hammerkit.dev/run=${getRunLabelValue(run)}` }
  return [
    ...(await batch.listNamespacedJob(selector)).items,
    ...(await apps.listNamespacedDeployment(selector)).items,
    ...(await core.listNamespacedPod(selector)).items,
    ...(await core.listNamespacedService(selector)).items,
    ...(await core.listNamespacedSecret(selector)).items,
    ...(await core.listNamespacedPersistentVolumeClaim(selector)).items,
    ...(await networking.listNamespacedNetworkPolicy(selector)).items,
  ]
    .filter((item) => !item.metadata?.deletionTimestamp)
    .map((item) => item.metadata?.name)
}

// The Jobs of some namespaces, seen while a run executes.
function watchJobs(namespaces: string[]) {
  const seen = new Map(namespaces.map((namespace) => [namespace, new Set<string>()]))
  let stopped = false
  const { batch } = cluster()
  const watching = (async () => {
    while (!stopped) {
      for (const namespace of namespaces) {
        const jobs = await batch.listNamespacedJob({ namespace }).catch(() => ({ items: [] }))
        for (const job of jobs.items) {
          seen.get(namespace)?.add(job.metadata?.name ?? '')
        }
      }
      await sleep(500)
    }
  })()
  return {
    async stop() {
      stopped = true
      await watching
      return Object.fromEntries([...seen].map(([namespace, names]) => [namespace, [...names]]))
    },
  }
}

const buildFile = (reachable: string, denied: string) => `
services:
  api:
    image: busybox:1.36
    shell: sh
    cmd: mkdir -p /www && echo api-ok > /www/index.html && httpd -f -p 8080 -h /www
    ports: [8080]
    healthcheck:
      cmd: wget -q -O /dev/null http://127.0.0.1:8080/
  bare:
    # no ports: a headless Service, its tasks reach the pod itself. Another image than
    # api's, since a service's id leaves out its cmd and ports
    image: busybox:1.37
    shell: sh
    cmd: mkdir -p /www && echo bare-ok > /www/index.html && httpd -f -p 8081 -h /www
    healthcheck:
      cmd: wget -q -O /dev/null http://127.0.0.1:8081/
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
  offline:
    image: alpine:3.19
    network: none
    cmds:
      # the pod starts once its policy holds, so not one try gets through to the
      # server that reach shows is there
      - for i in $(seq 5); do if nc -z -w 2 ${reachable} 8080; then echo "reached on try $i"; exit 1; fi; done
      # nor DNS: the namespace's default policy, which allows it, leaves limited pods out
      - if timeout 10 nslookup kubernetes.default.svc.cluster.local; then echo resolved; exit 1; fi
      - echo offline-ok
  reach:
    image: alpine:3.19
    cmds:
      # an open network reaches beyond the namespace, but not a denied address. An open
      # pod has no gate: on kindnet the namespace's policy applies a moment after it
      # started, so the denied address is blocked from then on, five tries in a row (in
      # one command, since every command is a pod of its own)
      - for i in $(seq 30); do wget -q -T 2 -O /dev/null http://${reachable}:8080/ && exit 0; sleep 1; done; exit 1
      # and resolves names
      - timeout 10 nslookup kubernetes.default.svc.cluster.local
      - >-
        for i in $(seq 30); do nc -z -w 2 ${denied} 8080 || break; sleep 1; done;
        for i in $(seq 5); do if nc -z -w 2 ${denied} 8080; then echo "reached on try $i"; exit 1; fi; done
      - echo denied-ok
  check:
    deps: [build, offline, reach]
    needs: [api, bare]
    src: [input.txt]
    cmds:
      - echo "read $(cat out/result.txt)"
      - echo "from $(wget -q -O - http://api:8080/)"
      - echo "from $(wget -q -O - http://bare:8081/)"
      # a pod of a Job, in the tool image, not the server's machine
      - echo "host=$(hostname)"
      - echo "alpine=$(cat /etc/alpine-release)"
`

describe('kubernetes backend of a server', () => {
  let root: string
  let executor: KubernetesExecutor
  let config: ServerConfig
  let executorOptions: ConstructorParameters<typeof KubernetesExecutor>[2]
  let store: DefinitionStore
  let commit: string

  let kubeconfig: string
  let reachable: string
  let denied: string

  beforeAll(
    requiresKubernetes(async () => {
      const { config, core, rbac } = cluster()
      await core.createNamespace({ body: { metadata: { name: operatorNamespace } } })
      await core.createNamespacedServiceAccount({ namespace: operatorNamespace, body: { metadata: { name: 'ci' } } })
      await core.createNamespacedSecret({
        namespace: operatorNamespace,
        body: { metadata: { name: 'ci-files' }, stringData: { 'api-key': KEY } },
      })

      // the server's own ServiceAccount, with only the rights of the docs
      await core.createNamespacedServiceAccount({
        namespace: operatorNamespace,
        body: { metadata: { name: 'hammerkit' } },
      })
      const subject = { kind: 'ServiceAccount', name: 'hammerkit', namespace: operatorNamespace }
      await rbac.createClusterRole({ body: { metadata: { name: serverRole }, rules: SERVER_RULES } })
      await rbac.createClusterRole({ body: { metadata: { name: runRole }, rules: RUN_RULES } })
      await rbac.createClusterRoleBinding({
        body: {
          metadata: { name: serverRole },
          roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: serverRole },
          subjects: [subject],
        },
      })
      await rbac.createNamespacedRole({
        namespace: operatorNamespace,
        body: { metadata: { name: 'hammerkit-accounts' }, rules: ACCOUNT_RULES },
      })
      await rbac.createNamespacedRoleBinding({
        namespace: operatorNamespace,
        body: {
          metadata: { name: 'hammerkit-accounts' },
          roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'hammerkit-accounts' },
          subjects: [subject],
        },
      })
      const token = await core.createNamespacedServiceAccountToken({
        name: 'hammerkit',
        namespace: operatorNamespace,
        body: { spec: { expirationSeconds: 7200 } },
      })
      const server = config.getCurrentCluster()
      kubeconfig = join(mkdtempSync(join(tmpdir(), 'hammerkit-kubeconfig-')), 'config')
      writeFileSync(
        kubeconfig,
        JSON.stringify({
          apiVersion: 'v1',
          kind: 'Config',
          clusters: [
            {
              name: 'cluster',
              cluster: {
                server: server?.server,
                ...(server?.caData ? { 'certificate-authority-data': server.caData } : {}),
                ...(server?.caFile ? { 'certificate-authority': server.caFile } : {}),
                ...(server?.skipTLSVerify ? { 'insecure-skip-tls-verify': true } : {}),
              },
            },
          ],
          users: [{ name: 'hammerkit', user: { token: token.status?.token } }],
          contexts: [{ name: 'hammerkit', context: { cluster: 'cluster', user: 'hammerkit' } }],
          'current-context': 'hammerkit',
        })
      )

      reachable = await startWebServer(core, 'reachable')
      denied = await startWebServer(core, 'denied')
    })
  )

  afterAll(
    requiresKubernetes(async () => {
      const { core, rbac } = cluster()
      for (const name of [operatorNamespace, callerNamespace, bobNamespace]) {
        await core.deleteNamespace({ name }).catch(() => undefined)
      }
      await rbac.deleteClusterRoleBinding({ name: serverRole }).catch(() => undefined)
      for (const name of [serverRole, runRole]) {
        await rbac.deleteClusterRole({ name }).catch(() => undefined)
      }
      if (kubeconfig) {
        rmSync(dirname(kubeconfig), { recursive: true, force: true })
      }
    })
  )

  // the gate of requiresKubernetes: without a cluster, CI skips the setup too
  beforeEach(
    requiresKubernetes(async () => {
      root = mkdtempSync(join(tmpdir(), 'hammerkit-kubernetes-server-'))
      const repository = join(root, 'repository')
      mkdirSync(repository)
      git(repository, 'init', '--quiet', '--initial-branch=main')
      writeFileSync(join(repository, 'input.txt'), 'hello from the checkout')
      git(repository, 'add', '.')
      git(repository, 'commit', '--quiet', '-m', 'one')
      commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()

      config = serverConfigSchema.parse({
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
          kubeconfig,
          context: kubeconfig ? 'hammerkit' : context,
          namespace: operatorNamespace,
          runRole,
          // the default ranges, and one web server of the cluster
          deniedEgress: ['169.254.0.0/16', 'fe80::/10', 'fd00:ec2::/32', ...(denied ? [`${denied}/32`] : [])],
          networkPolicy: 'enforced',
          namespacePrefix: prefix,
          pools: [{ name: 'default', toolImage: 'alpine:3.19' }],
          providers: { files: { image: 'alpine:3.19' } },
          quota: { pods: 20 },
          defaultResources: { requests: { cpu: '10m', memory: '16Mi' } },
          // the claims of a run go with it, so the next run restores from the cache
          keepVolumes: false,
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
      executorOptions = {
        definitions: store,
        planning,
        repos: new RepoAccess(config, planning.environment, { url: () => repository }),
        directory: join(root, 'runs'),
        cache: join(root, 'cache'),
        worker: TEST_WORKER,
      }
      executor = new KubernetesExecutor(config as ServerConfig & { backend: any }, process.env, executorOptions)
    })
  )

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  async function publish(file: string, owner = alice): Promise<string> {
    await store.load()
    const { version } = await store.publish({ entry: '.hammerkit.yaml', files: { '.hammerkit.yaml': file } }, owner)
    return version.hash
  }

  async function execute(
    id: string,
    hash: string,
    options: { owner?: typeof alice; tasks?: string[]; accounts?: string[]; signal?: AbortSignal } = {}
  ) {
    const run: Run = {
      id,
      owner: options.owner ?? alice,
      state: 'running',
      createdAt: new Date().toISOString(),
      definition: hash,
      tasks: options.tasks ?? ['check'],
      accounts: options.accounts ?? ['ci'],
      source: { type: 'ref', repo: REPO, ref: 'main', commit },
      options: {},
    }
    const events: RunEventData[] = []
    const error = await executor
      .execute(run, { emit: (e) => events.push(e), signal: options.signal ?? new AbortController().signal })
      .then(
        () => undefined,
        (e: Error) => e
      )
    const text = events.map((e) => (e.type === 'log' ? e.text : '')).join('\n')
    return { events, error, text, all: JSON.stringify(events) }
  }

  const taskStates = (events: RunEventData[], task: string) =>
    events.flatMap((e) => (e.type === 'task' && e.task === task ? [e.state] : []))

  it(
    'runs the tasks as Jobs in the caller’s namespace, reads secrets in the Job and cleans up',
    requiresKubernetes(async () => {
      const hash = await publish(buildFile(reachable, denied))

      // run ids may end in `-` or `_`, which a label value can't
      const jobs = watchJobs([callerNamespace, operatorNamespace])
      const first = await execute('run_k8s_one_-', hash)
      const seen = await jobs.stop()
      expect(first.error, first.all).toBeUndefined()
      expect(first.text).toContain(`runs in the namespace ${callerNamespace}`)
      // the Jobs ran in the caller's namespace, none in the server's
      expect(seen[callerNamespace].filter((name) => name.endsWith('-job')).length).toBeGreaterThanOrEqual(4)
      expect(seen[operatorNamespace]).toEqual([])
      expect(first.text).toContain('key=***')
      expect(first.text).toContain('token-present')
      expect(first.text).not.toContain(KEY)
      // the local task ran in a pod of a Job in the tool image, on the output of the
      // container task
      expect(first.text).toContain('read hello from the checkout')
      expect(first.text).toMatch(/host=\S+-job-\S+/)
      expect(first.text).toMatch(/alpine=3\.19\.\d+/)
      expect(first.events).toContainEqual(expect.objectContaining({ type: 'task', task: 'build', state: 'succeeded' }))
      expect(first.events).toContainEqual(expect.objectContaining({ type: 'task', task: 'check', state: 'succeeded' }))
      // network: none is a NetworkPolicy on the Job's pod, in force before its command
      expect(first.text).toContain('offline-ok')
      // the caller's namespace keeps an open task off the denied addresses
      expect(first.text).toContain('denied-ok')
      // the service is reached from its namespace
      expect(first.text).toContain('from api-ok')
      // and one without ports, on any port of its pod
      expect(first.text).toContain('from bare-ok')

      const { core } = cluster()
      const quota = await core.readNamespacedResourceQuota({ name: 'hammerkit', namespace: callerNamespace })
      expect(quota.spec?.hard).toEqual({ pods: '20' })
      const limits = await core.readNamespacedLimitRange({ name: 'hammerkit', namespace: callerNamespace })
      expect(limits.spec?.limits).toEqual([
        expect.objectContaining({ type: 'Container', defaultRequest: { cpu: '10m', memory: '16Mi' } }),
      ])
      expect(await left('run_k8s_one_-')).toEqual([])

      // the outputs went to the server's cache, so the next run of the same code hits
      // on build and restores its outputs into a new claim; offline has no sources,
      // runs again, and so does check, which reads what was restored
      const second = await execute('run_k8s_two_', hash)
      expect(second.error, second.all).toBeUndefined()
      expect(second.events).toContainEqual(expect.objectContaining({ type: 'task', task: 'build', state: 'cached' }))
      expect(taskStates(second.events, 'build')).not.toContain('succeeded')
      expect(second.text).toContain('read hello from the checkout')
      expect(await left('run_k8s_two_')).toEqual([])
    })
  )

  it(
    'keeps the claims of tasks for the next runs of the repository, empties them on a change and removes them once expired',
    requiresKubernetes(async () => {
      const keep = { ...config, backend: { ...config.backend, keepVolumes: '30s' } }
      executor = new KubernetesExecutor(keep as ServerConfig & { backend: any }, process.env, executorOptions)
      const hash = await publish(`
tasks:
  install:
    image: alpine:3.19
    src: [input.txt]
    generates: [out]
    cmds:
      - mkdir -p out && cp input.txt "out/$(md5sum input.txt | cut -c1-8)" && date +%s%N > out/stamp
  check:
    image: alpine:3.19
    deps: [install]
    cmds:
      - echo "stamp=$(cat out/stamp) files=$(ls out | wc -l)"
`)
      const { core } = cluster()
      const keptClaims = async () =>
        (
          await core.listNamespacedPersistentVolumeClaim({
            namespace: callerNamespace,
            labelSelector: 'hammerkit.dev/volume-scope',
          })
        ).items.filter((claim) => !claim.metadata?.deletionTimestamp)
      const stamp = (text: string) => /stamp=(\d+) files=(\d+)/.exec(text)?.slice(1)

      const first = await execute('run_k8s_keep_1', hash, { tasks: ['check'], accounts: [] })
      expect(first.error, first.all).toBeUndefined()
      expect(taskStates(first.events, 'install')).toContain('succeeded')
      const [made, count] = stamp(first.text) ?? []
      expect(count).toBe('2')
      // the claim of install stays, with the state of its outputs, and nothing else of the run
      const claims = await keptClaims()
      expect(claims.map((claim) => claim.metadata?.name)).toEqual([expect.stringMatching(/^hammerkit-[0-9a-f]{40}-/)])
      expect(claims[0].metadata?.labels?.['hammerkit.dev/run']).toBeUndefined()
      expect(Object.keys(claims[0].metadata?.annotations ?? {})).toEqual(
        expect.arrayContaining(['hammerkit.dev/state', 'hammerkit.dev/expires'])
      )
      expect(await left('run_k8s_keep_1')).toEqual([])

      // without the cache, the next run mounts the outputs in the kept claim as they are
      rmSync(join(root, 'cache'), { recursive: true, force: true })
      const second = await execute('run_k8s_keep_2', hash, { tasks: ['check'], accounts: [] })
      expect(second.error, second.all).toBeUndefined()
      expect(second.events).toContainEqual(expect.objectContaining({ type: 'task', task: 'install', state: 'cached' }))
      expect(taskStates(second.events, 'install')).not.toContain('succeeded')
      expect(stamp(second.text)).toEqual([made, '2'])

      // a change runs install on an emptied claim: the output of the input before is gone
      const repository = join(root, 'repository')
      writeFileSync(join(repository, 'input.txt'), 'changed')
      git(repository, 'commit', '--quiet', '-am', 'two')
      commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
      const third = await execute('run_k8s_keep_3', hash, { tasks: ['check'], accounts: [] })
      expect(third.error, third.all).toBeUndefined()
      expect(taskStates(third.events, 'install')).toContain('succeeded')
      const [remade, files] = stamp(third.text) ?? []
      expect(remade).not.toBe(made)
      expect(files).toBe('2')

      // once it expired, the server removes it
      await until(async () => (await keptClaims()).length === 0, 120_000, 'the kept claim is still there')
    })
  )

  it(
    'keeps one caller’s Jobs off the pods of another',
    requiresKubernetes(async () => {
      const { core } = cluster()
      // a pod of alice, whose namespace the first test made; her own pods reach it
      const victim = await startWebServer(core, 'victim', callerNamespace)
      expect(
        await runPod(
          core,
          callerNamespace,
          'neighbour',
          `for i in $(seq 30); do nc -z -w 2 ${victim} 8080 && exit 0; sleep 1; done; exit 1`
        )
      ).toBe(true)

      const hash = await publish(
        `
tasks:
  probe:
    image: alpine:3.19
    cmds:
      - for i in $(seq 30); do nc -z -w 2 ${reachable} 8080 && exit 0; sleep 1; done; exit 1
      - for i in $(seq 5); do if nc -z -w 2 ${victim} 8080; then echo "reached alice on try $i"; exit 1; fi; done
      - echo isolated-ok
`,
        bob
      )
      const jobs = watchJobs([callerNamespace, bobNamespace])
      const run = await execute('run_k8s_bob', hash, { owner: bob, tasks: ['probe'], accounts: [] })
      const seen = await jobs.stop()
      expect(run.error, run.all).toBeUndefined()
      expect(run.text).toContain(`runs in the namespace ${bobNamespace}`)
      expect(run.text).toContain('isolated-ok')
      // bob's Jobs ran in his namespace, nothing of his in alice's
      expect(seen[bobNamespace].length).toBeGreaterThan(0)
      expect(seen[callerNamespace]).toEqual([])
      expect(await left('run_k8s_bob', bobNamespace)).toEqual([])
      await core.deleteNamespacedPod({ name: 'victim', namespace: callerNamespace, gracePeriodSeconds: 0 })
    })
  )

  it(
    'removes what an earlier run left, and cleans up after a task failed',
    requiresKubernetes(async () => {
      const { core, networking } = cluster()
      // as if the server had stopped during an earlier run of alice
      const labels = { 'hammerkit.dev/run': getRunLabelValue('run_k8s_old') }
      await core.createNamespacedSecret({
        namespace: callerNamespace,
        body: { metadata: { name: 'left-behind', labels }, stringData: { value: 'old' } },
      })
      await networking.createNamespacedNetworkPolicy({
        namespace: callerNamespace,
        body: {
          metadata: { name: 'left-behind', labels },
          spec: { podSelector: { matchLabels: { 'left-behind': 'true' } }, policyTypes: ['Egress'] },
        },
      })

      const hash = await publish(
        `
tasks:
  broken:
    image: alpine:3.19
    cmds:
      - echo before-the-failure && exit 7
`
      )
      const run = await execute('run_k8s_broken', hash, { tasks: ['broken'], accounts: [] })
      expect(run.error?.message).toBe('broken failed')
      expect(taskStates(run.events, 'broken')).toContain('failed')
      // with the exit code of its command, as on a host
      expect(run.events).toContainEqual(
        expect.objectContaining({ type: 'task', task: 'broken', state: 'failed', exitCode: 7 })
      )
      // what the command printed before it failed
      expect(run.text).toContain('before-the-failure')
      expect(await left('run_k8s_broken')).toEqual([])
      expect(await left('run_k8s_old')).toEqual([])
    })
  )

  it(
    'stops the Job of a cancelled run and cleans up',
    requiresKubernetes(async () => {
      const hash = await publish('tasks:\n  slow:\n    image: alpine:3.19\n    cmds: [sleep 300]\n')
      const abort = new AbortController()
      const running = execute('run_k8s_cancel', hash, {
        tasks: ['slow'],
        accounts: [],
        signal: abort.signal,
      })
      const { core } = cluster()
      const selector = {
        namespace: callerNamespace,
        labelSelector: `hammerkit.dev/run=${getRunLabelValue('run_k8s_cancel')}`,
      }
      await until(
        async () => (await core.listNamespacedPod(selector)).items.some((pod) => pod.status?.phase === 'Running'),
        120_000,
        'the pod of slow did not run'
      )
      const cancelled = Date.now()
      abort.abort()
      const run = await running
      expect(run.error?.message).toBe('the run was cancelled')
      expect(await left('run_k8s_cancel')).toEqual([])
      expect(Date.now() - cancelled).toBeLessThan(30_000)
    })
  )

  it(
    'fails a task that runs past its timeout and removes its Job',
    requiresKubernetes(async () => {
      const hash = await publish(
        'tasks:\n  late:\n    image: alpine:3.19\n    timeout: 20s\n    cmds: [echo started && sleep 300]\n'
      )
      const run = await execute('run_k8s_late', hash, { tasks: ['late'], accounts: [] })
      expect(run.error?.message).toBe('late failed')
      expect(taskStates(run.events, 'late')).toContain('failed')
      expect(run.all).toContain('timed out after 20s')
      expect(await left('run_k8s_late')).toEqual([])
    })
  )

  it(
    'names the secret an init container could not read',
    requiresKubernetes(async () => {
      const hash = await publish(
        `
tasks:
  locked:
    image: alpine:3.19
    secrets:
      - { from: "files:missing", account: ci, env: MISSING }
    cmds:
      - echo never-ran
`
      )
      const run = await execute('run_k8s_locked', hash, { tasks: ['locked'] })
      expect(run.error?.message).toBe('locked failed')
      expect(run.all).toContain('secret MISSING (files:missing as ci) could not be read')
      expect(run.text).not.toContain('never-ran')
      expect(await left('run_k8s_locked')).toEqual([])
    })
  )
})
