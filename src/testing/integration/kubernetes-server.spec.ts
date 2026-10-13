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

// A web server in the operator's namespace, which a task can reach unless its
// address is denied
async function startWebServer(core: CoreV1Api, name: string): Promise<string> {
  await core.createNamespacedPod({
    namespace: operatorNamespace,
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
    const pod = await core.readNamespacedPod({ name, namespace: operatorNamespace })
    if (pod.status?.phase === 'Running' && pod.status.podIP) {
      return pod.status.podIP
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
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
      # the policy may apply a moment after the pod started
      - for i in $(seq 30); do wget -q -T 2 -O /dev/null http://1.1.1.1 || exit 0; sleep 1; done; exit 1
      - echo offline-ok
  reach:
    image: alpine:3.19
    cmds:
      # an open network reaches beyond the namespace, but not a denied address
      - for i in $(seq 30); do wget -q -T 2 -O /dev/null http://${reachable}:8080/ && exit 0; sleep 1; done; exit 1
      - for i in $(seq 30); do wget -q -T 2 -O /dev/null http://${denied}:8080/ || exit 0; sleep 1; done; exit 1
      - echo denied-ok
  check:
    deps: [build, offline, reach]
    needs: [api]
    src: [input.txt]
    cmds:
      - echo "read $(cat out/result.txt)"
      - echo "from $(wget -q -O - http://api:8080/)"
`

describe('kubernetes backend of a server', () => {
  let root: string
  let executor: KubernetesExecutor
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
      for (const name of [operatorNamespace, callerNamespace]) {
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
        kubeconfig,
        context: kubeconfig ? 'hammerkit' : context,
        namespace: operatorNamespace,
        runRole,
        // the default ranges, and one web server of the cluster
        deniedEgress: ['169.254.0.0/16', 'fe80::/10', 'fd00:ec2::/32', ...(denied ? [`${denied}/32`] : [])],
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
        { entry: '.hammerkit.yaml', files: { '.hammerkit.yaml': buildFile(reachable, denied) } },
        alice
      )

      // run ids may end in `-` or `_`, which a label value can't
      const first = await execute('run_k8s_one_-', version.hash)
      expect(first.error).toBeUndefined()
      expect(first.text).toContain(`runs in the namespace ${callerNamespace}`)
      expect(first.text).toContain('key=***')
      expect(first.text).toContain('token-present')
      expect(first.text).not.toContain(KEY)
      // the local task ran in the tool image, on the output of the container task
      expect(first.text).toContain('read hello from the checkout')
      expect(first.events).toContainEqual({ type: 'task', task: 'build', state: 'succeeded' })
      expect(first.events).toContainEqual({ type: 'task', task: 'check', state: 'succeeded' })
      // network: none is a NetworkPolicy on the Job's pod
      expect(first.text).toContain('offline-ok')
      // the caller's namespace keeps an open task off the denied addresses
      expect(first.text).toContain('denied-ok')
      // the service is reached from its namespace
      expect(first.text).toContain('from api-ok')

      const { core, apps, batch, networking } = cluster()
      const quota = await core.readNamespacedResourceQuota({ name: 'hammerkit', namespace: callerNamespace })
      expect(quota.spec?.hard).toEqual({ pods: '20' })
      const selector = {
        namespace: callerNamespace,
        labelSelector: `hammerkit.dev/run=${getRunLabelValue('run_k8s_one_-')}`,
      }
      const left = async () =>
        [
          ...(await batch.listNamespacedJob(selector)).items,
          ...(await apps.listNamespacedDeployment(selector)).items,
          ...(await core.listNamespacedPod(selector)).items,
          ...(await core.listNamespacedService(selector)).items,
          ...(await core.listNamespacedSecret(selector)).items,
          ...(await core.listNamespacedPersistentVolumeClaim(selector)).items,
          ...(await networking.listNamespacedNetworkPolicy(selector)).items,
        ].filter((item) => !item.metadata?.deletionTimestamp)
      expect(await left()).toEqual([])

      // the outputs went to the server's cache, so the next run of the same code hits
      // on build and restores its outputs into a new claim; offline has no sources,
      // runs again, and so does check, which reads what was restored
      const second = await execute('run_k8s_two_', version.hash)
      expect(second.error).toBeUndefined()
      expect(second.events).toContainEqual({ type: 'task', task: 'build', state: 'cached' })
      expect(second.events).not.toContainEqual({ type: 'task', task: 'build', state: 'succeeded' })
      expect(second.text).toContain('read hello from the checkout')
    })
  )
})
