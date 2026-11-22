import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CallerNamespaces,
  getCallerNamespace,
  getClusterAccess,
  getServiceRunNamespace,
  getNamespacePolicies,
  getPodSecurityLabels,
  getVolumeScope,
  getKeptClaimTasks,
  getCapabilitiesProblem,
  getPrivilegedNamespaceProblem,
  isCallerNamespace,
  KubernetesExecutor,
} from './kubernetes-backend'
import { getRunLabelValue } from '../kubernetes/job-placement'
import { Run, RunContext, RunRegistry } from './runs'
import { TaskPlan } from './plan'
import { DEFAULT_DENIED_EGRESS, KubernetesBackend, serverConfigSchema } from './server-config'
import { getTransferNetworkLabels } from '../kubernetes/network-policy'

const KUBECONFIG = `
apiVersion: v1
kind: Config
clusters: [{ name: test, cluster: { server: 'https://127.0.0.1:1' } }]
users: [{ name: test, user: { token: x } }]
contexts: [{ name: test, context: { cluster: test, user: test } }]
current-context: test
`

describe('kubernetes backend', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hammerkit-kubernetes-backend-'))
    writeFileSync(join(root, 'config'), KUBECONFIG)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const backend = (patch: object = {}): KubernetesBackend =>
    serverConfigSchema.parse({
      issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
      backend: { type: 'kubernetes', ...patch },
    }).backend as KubernetesBackend

  it('gives every caller a namespace of their own', () => {
    const alice = getCallerNamespace('hammerkit-', { iss: 'https://idp.corp', sub: 'alice' })
    expect(alice).toMatch(/^hammerkit-[0-9a-f]{16}$/)
    expect(getCallerNamespace('hammerkit-', { iss: 'https://idp.corp', sub: 'alice' })).toBe(alice)
    expect(getCallerNamespace('hammerkit-', { iss: 'https://idp.corp', sub: 'bob' })).not.toBe(alice)
    expect(getCallerNamespace('hammerkit-', { iss: 'https://other', sub: 'alice' })).not.toBe(alice)
    expect(getCallerNamespace('agents-', { iss: 'https://idp.corp', sub: 'alice' })).toMatch(/^agents-/)
  })

  it('enforces baseline in a caller’s namespace, privileged only for the capabilities of a sandbox', () => {
    const plain = backend()
    expect(getPodSecurityLabels(plain)).toEqual({ 'pod-security.kubernetes.io/enforce': 'baseline' })
    const sandboxed = backend({ capabilities: { allow: ['SYS_ADMIN'], runtimeClass: 'gvisor' } })
    expect(getPodSecurityLabels(sandboxed)).toEqual({
      'pod-security.kubernetes.io/enforce': 'privileged',
      'pod-security.kubernetes.io/audit': 'baseline',
    })
    const ns = 'hammerkit-0123456789abcdef'
    // what a server of an earlier version made, and what an operator or the platform labelled
    for (const labels of <({ [label: string]: string } | undefined)[]>[
      undefined,
      { 'pod-security.kubernetes.io/enforce': 'baseline' },
      { 'pod-security.kubernetes.io/enforce': 'baseline', 'pod-security.kubernetes.io/audit': 'restricted' },
      { 'pod-security.kubernetes.io/enforce': 'restricted' },
    ]) {
      expect(getPrivilegedNamespaceProblem(ns, labels, plain)).toBeUndefined()
      expect(getCapabilitiesProblem(ns, labels, plain)).toBeUndefined()
      // made before the capabilities: the operator relabels it, the server can't
      expect(getCapabilitiesProblem(ns, labels, sandboxed)).toContain(
        `kubectl label namespace ${ns} pod-security.kubernetes.io/enforce=privileged`
      )
    }
    const privileged = { 'pod-security.kubernetes.io/enforce': 'privileged' }
    expect(getCapabilitiesProblem(ns, privileged, sandboxed)).toBeUndefined()
    expect(getPrivilegedNamespaceProblem(ns, privileged, sandboxed)).toBeUndefined()
    // made with the capabilities, which the config no longer has
    expect(getPrivilegedNamespaceProblem(ns, privileged, plain)).toContain(
      `kubectl label namespace ${ns} pod-security.kubernetes.io/enforce=baseline`
    )
  })

  it('takes capabilities only with the RuntimeClass of a sandbox, and sandboxes only those', () => {
    const parse = (config: object) =>
      serverConfigSchema.safeParse({ issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }], ...config })
    const issues = (config: object) => {
      const parsed = parse(config)
      return parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    }
    expect(issues({ backend: { type: 'kubernetes', capabilities: { allow: ['SYS_ADMIN'] } } })).toEqual([
      'backend.capabilities.runtimeClass: Required',
    ])
    expect(issues({ backend: { type: 'host', capabilities: { allow: ['SYS_ADMIN'] } } })).toEqual([
      'backend.capabilities.runtime: Required',
    ])
    expect(issues({ backend: { type: 'host', capabilities: { allow: ['SYS_ADMIN'], runtime: 'runsc' } } })).toEqual([])
    expect(issues({ backend: { type: 'host', capabilities: { allow: [], runtime: 'runsc' } } })).toEqual([
      'backend.capabilities.allow: Array must contain at least 1 element(s)',
    ])
    expect(
      issues({
        backend: { type: 'kubernetes', capabilities: { allow: ['SYS_ADMIN'], runtimeClass: 'gvisor' } },
        sandboxes: { capabilities: ['SYS_ADMIN', 'NET_ADMIN'] },
      })
    ).toEqual([
      'sandboxes.capabilities.1: the capability NET_ADMIN is not in backend.capabilities.allow, no run may add it',
    ])
    expect(issues({ sandboxes: { capabilities: ['SYS_ADMIN'] } })).toEqual([
      'sandboxes.capabilities.0: the capability SYS_ADMIN is not in backend.capabilities.allow, no run may add it',
    ])
  })

  it('knows its callers’ namespaces apart from those of a server whose prefix starts the same', () => {
    const own = getCallerNamespace('hk-', { iss: 'https://idp.corp', sub: 'alice' })
    const other = getCallerNamespace('hk-test-', { iss: 'https://idp.corp', sub: 'alice' })
    expect(isCallerNamespace('hk-', own)).toBe(true)
    expect(isCallerNamespace('hk-', other)).toBe(false)
    expect(isCallerNamespace('hk-test-', other)).toBe(true)
    expect(isCallerNamespace('hk-', 'hk-')).toBe(false)
    expect(isCallerNamespace('hk-', 'hk-server')).toBe(false)
  })

  it('reaches the cluster by the kubeconfig the operator names, the server’s own, or from inside it', () => {
    expect(getClusterAccess(backend({ kubeconfig: '/etc/kube', context: 'prod' }), {})).toEqual({
      kubeConfig: '/etc/kube',
      context: 'prod',
      env: {},
    })
    const own = join(root, 'config')
    expect(getClusterAccess(backend({ context: 'ci' }), { KUBECONFIG: own })).toEqual({
      kubeConfig: own,
      context: 'ci',
      env: {},
    })
    expect(
      getClusterAccess(backend(), {
        HOME: root,
        KUBERNETES_SERVICE_HOST: '10.0.0.1',
        KUBERNETES_SERVICE_PORT: '443',
        OTHER: 'x',
      })
    ).toEqual({ env: { KUBERNETES_SERVICE_HOST: '10.0.0.1', KUBERNETES_SERVICE_PORT: '443' } })
  })

  it('needs the namespace of the server outside of a pod', () => {
    const config = serverConfigSchema.parse({
      issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
      backend: { type: 'kubernetes', kubeconfig: join(root, 'config') },
    }) as any
    expect(() => new KubernetesExecutor(config, {}, {} as any)).toThrow(
      'backend.namespace: name the namespace of the server'
    )
  })

  it('runs the runs of one caller side by side, and holds the kept claims of a scope for one run at a time', async () => {
    const config = (keepVolumes?: false) =>
      serverConfigSchema.parse({
        issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
        backend: { type: 'kubernetes', kubeconfig: join(root, 'config'), namespace: 'hammerkit', keepVolumes },
      }) as any
    const executor = new KubernetesExecutor(config(), {}, {} as any)
    const order: string[] = []
    const release: { [id: string]: () => void } = {}
    ;(executor as any).host = {
      execute: (run: Run) =>
        new Promise<void>((resolve) => {
          order.push(`start ${run.id}`)
          release[run.id] = () => {
            order.push(`end ${run.id}`)
            resolve()
          }
        }),
    }
    const sandbox = (id: string) =>
      ({ type: 'sandbox', id, repo: 'git.test/corp/app', commit: 'c'.repeat(40), tree: 't' }) as Run['source']
    const ref = { type: 'ref', repo: 'git.test/corp/app', ref: 'main' } as Run['source']
    const run = (id: string, sub: string, source: Run['source']) =>
      ({ id, owner: { iss: 'https://idp.corp', sub }, source }) as Run
    const context: RunContext = { emit: () => undefined, signal: new AbortController().signal }
    // three coders of one caller, each on a sandbox of their own
    const runs = ['s1', 's2', 's3'].map((id) => run(id, 'alice', sandbox(`sbx_${id}`)))
    const executing = runs.map((one) => executor.execute(one, context))
    await new Promise((resolve) => setImmediate(resolve))
    expect(order).toEqual(['start s1', 'start s2', 'start s3'])

    // what the registry holds back: two runs of one scope share its kept claims, all of them
    // for a run without a plan
    expect(executor.excludes(runs[0], runs[1])).toBe(false)
    expect(executor.excludes(run('s4', 'alice', sandbox('sbx_s1')), runs[0])).toBe(true)
    expect(executor.excludes(run('r1', 'alice', ref), run('r2', 'alice', ref))).toBe(true)
    // the runs of two branches of a repository keep claims of their own and go side by side
    const branch = { ...ref, ref: 'feature' } as Run['source']
    expect(executor.excludes(run('r4', 'alice', branch), run('r1', 'alice', ref))).toBe(false)
    expect(executor.excludes(run('r4', 'alice', branch), run('r5', 'alice', branch))).toBe(true)
    // a check of a sandbox is the repository's, as its cache is
    const check = (id: string) => ({ ...sandbox(id), check: true }) as Run['source']
    expect(executor.excludes(run('c1', 'alice', check('sbx_s8')), run('c2', 'alice', check('sbx_s9')))).toBe(true)
    expect(executor.excludes(run('c1', 'alice', check('sbx_s8')), run('r1', 'alice', ref))).toBe(false)
    // an approved run on a sandbox keeps no claim with the sandbox's runs that needed no
    // approval, nor with a check, and approved runs of two sandboxes go side by side
    const approved = (id: string, sbx: string) =>
      ({ ...run(id, 'alice', sandbox(sbx)), approvals: [{ account: 'deploy' }] }) as unknown as Run
    expect(executor.excludes(approved('a1', 'sbx_s1'), runs[0])).toBe(false)
    expect(executor.excludes(approved('a1', 'sbx_s1'), run('c1', 'alice', check('sbx_s1')))).toBe(false)
    expect(executor.excludes(approved('a1', 'sbx_s1'), approved('a2', 'sbx_s1'))).toBe(true)
    expect(executor.excludes(approved('a1', 'sbx_s1'), approved('a3', 'sbx_s2'))).toBe(false)
    expect(getVolumeScope(approved('a1', 'sbx_s1'))).toMatch(/^approved-/)
    // a ref given as a commit hash names no branch: it keeps the repository's claims, as checks do
    const commit = { ...ref, ref: 'A'.repeat(40) } as Run['source']
    expect(executor.excludes(run('h1', 'alice', commit), run('c1', 'alice', check('sbx_s8')))).toBe(true)
    // a scope is the caller's: their namespace holds the claims
    expect(executor.excludes(run('r3', 'bob', ref), run('r1', 'alice', ref))).toBe(false)
    // without kept claims, runs share no object
    const keepsNone = new KubernetesExecutor(config(false), {}, {} as any)
    expect(keepsNone.excludes(run('r1', 'alice', ref), run('r2', 'alice', ref))).toBe(false)

    // the kept claims of the executing scopes stay when the namespace is swept
    expect([...(executor as any).scopesInUse(getCallerNamespace('hammerkit-', runs[0].owner))].length).toBe(3)
    for (const one of runs) {
      release[one.id]()
    }
    await Promise.all(executing)
    expect((executor as any).active.size).toBe(0)
  })

  it('holds the kept claims of the tasks of a run, and nothing for a run that mounts none', async () => {
    const config = serverConfigSchema.parse({
      issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
      backend: { type: 'kubernetes', kubeconfig: join(root, 'config'), namespace: 'hammerkit' },
    }) as any
    const executor = new KubernetesExecutor(config, {}, {} as any)
    const release: { [id: string]: () => void } = {}
    ;(executor as any).host = {
      execute: (run: Run) => new Promise<void>((resolve) => (release[run.id] = resolve)),
    }
    const task = (runtime: TaskPlan['runtime'], deps: string[] = []) =>
      ({
        kind: 'task',
        runtime,
        cmds: [],
        deps,
        needs: [],
        accounts: [],
        secrets: [],
        mounts: [],
        ports: [],
        generates: [],
        flags: [],
      }) as TaskPlan
    const service = { ...task('docker'), kind: 'service' } as TaskPlan
    const source = { type: 'ref', repo: 'git.test/corp/app', ref: 'main', commit: 'c'.repeat(40) } as Run['source']
    const run = (id: string, plan?: Record<string, TaskPlan>) =>
      ({
        id,
        owner: { iss: 'https://idp.corp', sub: 'alice' },
        source,
        tasks: [],
        ...(plan ? { plan } : {}),
      }) as unknown as Run
    // a push of main rolls out two services, each built by a task of its own
    const api = run('api', { 'image-api': task('docker'), 'deploy-api': task('docker', ['image-api']) })
    const todo = run('todo', { 'image-todo': task('docker'), 'deploy-todo': task('docker', ['image-todo']) })
    // a run of one of the tasks of another, and a run that mounts no kept claim
    const image = run('image', { 'image-api': task('docker') })
    const claimless = run('claimless', { all: task('none', ['notify']), notify: task('local'), db: service })
    const unplanned = run('unplanned')

    expect(getKeptClaimTasks(api)).toEqual(['deploy-api', 'image-api'])
    expect(getKeptClaimTasks(claimless)).toEqual([])
    expect(getKeptClaimTasks(unplanned)).toBeNull()
    // two runs of one branch with no task in common go side by side
    expect(executor.excludes(todo, api)).toBe(false)
    // two that mount the claim of one task go one after the other, either way round
    expect(executor.excludes(image, api)).toBe(true)
    expect(executor.excludes(api, image)).toBe(true)
    // a run without a plan may mount any claim of its scope
    expect(executor.excludes(unplanned, api)).toBe(true)
    expect(executor.excludes(todo, unplanned)).toBe(true)
    // a run that mounts no kept claim holds nothing, and waits for nothing
    for (const other of [api, image, unplanned, claimless]) {
      expect(executor.excludes(claimless, other)).toBe(false)
      expect(executor.excludes(other, claimless)).toBe(false)
    }

    const context: RunContext = { emit: () => undefined, signal: new AbortController().signal }
    const namespace = getCallerNamespace('hammerkit-', api.owner)
    const executing = [executor.execute(claimless, context)]
    await new Promise((resolve) => setImmediate(resolve))
    // the expired claims of the branch go while only a run that mounts none executes
    expect([...(executor as any).scopesInUse(namespace)]).toEqual([])
    executing.push(executor.execute(api, context), executor.execute(todo, context))
    await new Promise((resolve) => setImmediate(resolve))
    // and stay while one that mounts them does, for the one after it too
    expect([...(executor as any).scopesInUse(namespace)]).toEqual([getVolumeScope(api)])
    expect([...(executor as any).scopesInUse(namespace, getRunLabelValue('api'))]).toEqual([getVolumeScope(api)])
    release.api()
    release.claimless()
    await new Promise((resolve) => setImmediate(resolve))
    expect([...(executor as any).scopesInUse(namespace)]).toEqual([getVolumeScope(api)])
    release.todo()
    await Promise.all(executing)
    expect([...(executor as any).scopesInUse(namespace)]).toEqual([])
    expect((executor as any).active.size).toBe(0)
  })

  it('starts the runs of one branch that have no task in common at once', async () => {
    const config = serverConfigSchema.parse({
      issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
      backend: { type: 'kubernetes', kubeconfig: join(root, 'config'), namespace: 'hammerkit' },
    }) as any
    const executor = new KubernetesExecutor(config, {}, {} as any)
    const release: { [task: string]: () => void } = {}
    ;(executor as any).host = {
      execute: (run: Run) => new Promise<void>((resolve) => (release[run.tasks[0]] = resolve)),
    }
    const registry = new RunRegistry({ executor, maxConcurrent: 8, limits: { waiting: 8, queued: 8, running: 8 } })
    const task = (deps: string[] = []) =>
      ({
        kind: 'task',
        runtime: 'docker',
        cmds: [],
        deps,
        needs: [],
        accounts: [],
        secrets: [],
        mounts: [],
        ports: [],
        generates: [],
        flags: [],
      }) as TaskPlan
    const owner = { iss: 'https://idp.corp', sub: 'github' }
    const submit = (name: string, plan: Record<string, TaskPlan>) =>
      registry.submit(owner, {
        definition: 'sha256:' + 'a'.repeat(64),
        tasks: [name],
        accounts: [],
        plan,
        source: { type: 'ref', repo: 'git.test/corp/app', ref: 'main', commit: 'c'.repeat(40) },
        options: {},
      })
    const deploys = ['api', 'todo', 'docs'].map((name) =>
      submit(`deploy-${name}`, { [`image-${name}`]: task(), [`deploy-${name}`]: task([`image-${name}`]) })
    )
    const image = submit('image-api', { 'image-api': task() })
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
    await tick()
    expect(deploys.map((run) => registry.get(owner, run.id)?.state)).toEqual(['running', 'running', 'running'])
    expect(registry.queued(image.id)?.waitsFor).toEqual({ type: 'held', run: deploys[0].id })
    release['deploy-api']()
    await tick()
    expect(registry.get(owner, image.id)?.state).toBe('running')
    release['image-api']()
    release['deploy-todo']()
    release['deploy-docs']()
    await registry.close()
  })

  it('changes what is the whole namespace’s for one run at a time, and leaves what executing runs made', async () => {
    const config = serverConfigSchema.parse({
      issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
      backend: { type: 'kubernetes', kubeconfig: join(root, 'config'), namespace: 'hammerkit' },
    }) as any
    const executor = new KubernetesExecutor(config, {}, {} as any)
    const placement = (executor as any).placement()
    const steps: string[] = []
    const gates: (() => void)[] = []
    ;(executor as any).namespaces = {
      prepare: (namespace: string) =>
        new Promise<void>((resolve) => {
          steps.push(`prepare ${namespace}`)
          gates.push(resolve)
        }),
    }
    const selectors: string[] = []
    let failing = ''
    ;(executor as any).instance = {
      batchApi: {
        deleteCollectionNamespacedJob: async (r: any) => {
          selectors.push(r.labelSelector)
          if (r.labelSelector === failing) {
            throw new Error('the cluster is away')
          }
        },
      },
      appsApi: { deleteCollectionNamespacedDeployment: async () => undefined },
      coreApi: {
        deleteCollectionNamespacedPod: async () => undefined,
        deleteCollectionNamespacedService: async () => undefined,
        deleteCollectionNamespacedSecret: async () => undefined,
        deleteCollectionNamespacedPersistentVolumeClaim: async () => undefined,
        listNamespacedPod: async () => ({ items: [] }),
        listNamespacedPersistentVolumeClaim: async () => ({ items: [] }),
        listNamespace: async () => ({ items: [] }),
      },
      objectApi: { list: async () => ({ items: [] }) },
    }
    const owner = { iss: 'https://idp.corp', sub: 'alice' }
    const source = { type: 'sandbox', id: 'sbx_1', repo: 'r', commit: 'c', tree: 't' } as Run['source']
    const runs = ['run_1', 'run_2'].map((id) => ({ id, owner, source: { ...source, id: `sbx_${id}` } }) as Run)
    const context: RunContext = { emit: () => undefined, signal: new AbortController().signal }
    let finish = () => undefined as void
    const finished = new Promise<void>((resolve) => (finish = resolve))
    const prepared: string[] = []
    // the runs execute until the end of the test
    ;(executor as any).host = {
      execute: async (one: Run) => {
        await placement.prepare(one, context)
        prepared.push(one.id)
        await finished
      },
    }
    const executing = runs.map((one) => executor.execute(one, context))
    await vi.waitFor(() => expect(steps).toHaveLength(1))
    // the second waits for the first one's setup of the namespace
    await new Promise((resolve) => setImmediate(resolve))
    expect(steps).toHaveLength(1)
    gates[0]()
    await vi.waitFor(() => expect(steps).toHaveLength(2))
    gates[1]()
    await vi.waitFor(() => expect(prepared).toHaveLength(2))
    finish()
    await Promise.all(executing)
    // what a stopped server left goes, not what the other run makes; once, as long as
    // every run of this server removed what it made
    const both = runs.map((one) => getRunLabelValue(one.id))
    expect(selectors).toEqual([`hammerkit.dev/run,hammerkit.dev/run notin (${both.join(',')})`])

    // a release that failed leaves something, which the next run removes
    selectors.length = 0
    failing = `hammerkit.dev/run=${both[0]}`
    await placement.release(runs[0], context)
    ;(executor as any).host.execute = (one: Run) => placement.prepare(one, context)
    const third = { ...runs[0], id: 'run_3' }
    const preparing = executor.execute(third, context)
    await vi.waitFor(() => expect(gates).toHaveLength(3))
    gates[2]()
    await preparing
    expect(selectors).toEqual([failing, `hammerkit.dev/run,hammerkit.dev/run notin (${getRunLabelValue('run_3')})`])
  })

  it('does not start a run cancelled while it waits for the namespace', async () => {
    const config = serverConfigSchema.parse({
      issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
      backend: { type: 'kubernetes', kubeconfig: join(root, 'config'), namespace: 'hammerkit' },
    }) as any
    const executor = new KubernetesExecutor(config, {}, {} as any)
    const placement = (executor as any).placement()
    let open = () => undefined as void
    const prepared: string[] = []
    ;(executor as any).namespaces = {
      prepare: (namespace: string) => {
        prepared.push(namespace)
        return new Promise<void>((resolve) => (open = resolve))
      },
    }
    ;(executor as any).instance = {
      batchApi: { deleteCollectionNamespacedJob: async () => undefined },
      appsApi: { deleteCollectionNamespacedDeployment: async () => undefined },
      coreApi: {
        deleteCollectionNamespacedPod: async () => undefined,
        deleteCollectionNamespacedService: async () => undefined,
        deleteCollectionNamespacedSecret: async () => undefined,
        deleteCollectionNamespacedPersistentVolumeClaim: async () => undefined,
        listNamespacedPod: async () => ({ items: [] }),
        listNamespacedPersistentVolumeClaim: async () => ({ items: [] }),
        listNamespace: async () => ({ items: [] }),
      },
      objectApi: { list: async () => ({ items: [] }) },
    }
    const owner = { iss: 'https://idp.corp', sub: 'alice' }
    const source = { type: 'ref', repo: 'r', ref: 'main' } as Run['source']
    const first = placement.prepare({ id: 'run_1', owner, source } as Run, {
      emit: () => undefined,
      signal: new AbortController().signal,
    })
    const abort = new AbortController()
    const second = placement.prepare({ id: 'run_2', owner, source } as Run, {
      emit: () => undefined,
      signal: abort.signal,
    })
    await vi.waitFor(() => expect(prepared).toHaveLength(1))
    abort.abort()
    open()
    await first
    const outcome = await Promise.race([
      second.then(
        () => 'started',
        (e: Error) => e.message
      ),
      vi.waitFor(() => expect(prepared).toHaveLength(2)).then(() => 'prepared the namespace'),
    ])
    expect(outcome).toBe('the run was cancelled')
  })

  it('keeps the pods of a caller from other namespaces and from the metadata endpoint of the cloud', () => {
    const [ingress, egress] = getNamespacePolicies('hk-alice', ['169.254.0.0/16', '10.0.0.0/8', 'fd00:ec2::/32'])
    // policies add up: the pods of a limited item and the egress proxies have their own,
    // which these must not widen (a limited pod would get DNS back through the egress one)
    expect(ingress.spec).toEqual({
      podSelector: { matchExpressions: [{ key: 'hammerkit.dev/network', operator: 'DoesNotExist' }] },
      policyTypes: ['Ingress'],
      ingress: [{ _from: [{ podSelector: {} }] }],
    })
    // a proxy reaches out like an open pod
    expect(egress.spec?.podSelector).toEqual({
      matchExpressions: [{ key: 'hammerkit.dev/network', operator: 'NotIn', values: ['limited'] }],
    })
    expect(egress.spec?.egress).toEqual([
      { to: [{ podSelector: {} }] },
      {
        ports: [
          { protocol: 'UDP', port: 53 },
          { protocol: 'TCP', port: 53 },
        ],
      },
      {
        to: [
          { ipBlock: { cidr: '0.0.0.0/0', except: ['169.254.0.0/16', '10.0.0.0/8'] } },
          { ipBlock: { cidr: '::/0', except: ['fd00:ec2::/32'] } },
        ],
      },
    ])
    expect(getNamespacePolicies('hk-alice', [])[1].spec?.egress?.[2]).toEqual({
      to: [{ ipBlock: { cidr: '0.0.0.0/0' } }, { ipBlock: { cidr: '::/0' } }],
    })
  })

  it('lets the pods of a caller reach the allowed addresses of the denied ranges, in a rule of their own', () => {
    const egress = getNamespacePolicies('hk-alice', DEFAULT_DENIED_EGRESS, ['10.1.2.3/32', 'fd00::5/128'])[1]
    expect(egress.spec?.egress?.[2]).toEqual({
      to: [
        {
          ipBlock: {
            cidr: '0.0.0.0/0',
            except: ['169.254.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'],
          },
        },
        { ipBlock: { cidr: '::/0', except: ['fe80::/10', 'fc00::/7'] } },
      ],
    })
    expect(egress.spec?.egress?.[3]).toEqual({
      to: [{ ipBlock: { cidr: '10.1.2.3/32' } }, { ipBlock: { cidr: 'fd00::5/128' } }],
    })
    expect(getNamespacePolicies('hk-alice', DEFAULT_DENIED_EGRESS)[1].spec?.egress).toHaveLength(3)
  })

  it('lets nothing into an egress proxy that its own policy does not let in', () => {
    // the proxy's own policy can go before its pod has ended: without this one, nothing
    // would select the pod for ingress and anyone who can route to it would get in
    const proxy = getNamespacePolicies('hk-alice', DEFAULT_DENIED_EGRESS)[2]
    expect(proxy.metadata?.name).toBe('hammerkit-proxy-ingress')
    expect(proxy.spec).toEqual({
      podSelector: { matchLabels: { 'hammerkit.dev/network': 'proxy' } },
      policyTypes: ['Ingress'],
      ingress: [],
    })
  })

  it('lets nothing into or out of the pods that copy files into and out of claims', () => {
    const policies = getNamespacePolicies('hk-alice', DEFAULT_DENIED_EGRESS)
    const transfer = policies.find((policy) => policy.metadata?.name === 'hammerkit-transfer')
    expect(transfer?.spec).toEqual({
      podSelector: { matchLabels: { 'hammerkit.dev/transfer': 'true' } },
      policyTypes: ['Ingress', 'Egress'],
    })
    // and the policies of open pods leave them out, as the labels of such a pod say
    const pod = { metadata: { labels: getTransferNetworkLabels() } }
    const egress = policies.find((policy) => policy.metadata?.name === 'hammerkit-egress')
    const ingress = policies.find((policy) => policy.metadata?.name === 'hammerkit-ingress')
    expect(egress?.spec?.podSelector?.matchExpressions?.[0]).toEqual({
      key: 'hammerkit.dev/network',
      operator: 'NotIn',
      values: [pod.metadata.labels['hammerkit.dev/network']],
    })
    expect(ingress?.spec?.podSelector?.matchExpressions?.[0]).toEqual({
      key: 'hammerkit.dev/network',
      operator: 'DoesNotExist',
    })
  })

  describe('the namespace of a caller', () => {
    const owner = { iss: 'https://idp.corp', sub: 'alice' }
    const source = { type: 'ref', repo: 'git.test/corp/app', ref: 'main' } as Run['source']
    const namespace = getCallerNamespace('hammerkit-', owner)
    const context: RunContext = { emit: () => undefined, signal: new AbortController().signal }

    function cluster(labels: { [key: string]: string } | null) {
      const calls: string[] = []
      const notFound = () => Promise.reject(Object.assign(new Error('not found'), { code: 404 }))
      const collection = (kind: string) => async (request: any) => {
        calls.push(`delete ${kind} ${request.labelSelector}`)
      }
      const instance = {
        coreApi: {
          readNamespace: async () => (labels ? { metadata: { name: namespace, labels } } : notFound()),
          createNamespace: async (request: any) => {
            calls.push(`create Namespace ${JSON.stringify(request.body.metadata.labels)}`)
          },
          deleteCollectionNamespacedPod: collection('Pod'),
          deleteCollectionNamespacedService: collection('Service'),
          deleteCollectionNamespacedSecret: collection('Secret'),
          deleteCollectionNamespacedPersistentVolumeClaim: collection('PersistentVolumeClaim'),
          listNamespacedPod: async (request: any) => {
            calls.push(`await Pod ${request.labelSelector}`)
            return { items: [] }
          },
          listNamespacedPersistentVolumeClaim: async () => ({ items: [] }),
        },
        batchApi: { deleteCollectionNamespacedJob: collection('Job') },
        appsApi: { deleteCollectionNamespacedDeployment: collection('Deployment') },
        authApi: {
          createSelfSubjectReview: async () => ({
            status: { userInfo: { username: 'system:serviceaccount:hammerkit:server' } },
          }),
        },
        objectApi: {
          read: notFound,
          create: async (spec: any) => {
            calls.push(`create ${spec.kind} ${spec.metadata.name}`)
            if (spec.kind === 'RoleBinding') {
              calls.push(`  ${spec.roleRef.name} for ${spec.subjects[0].name}`)
            }
            return spec
          },
          delete: async (spec: any) => {
            calls.push(`delete ${spec.kind} ${spec.metadata.name}`)
            return notFound()
          },
          list: async () => ({ items: [{ metadata: { name: 'hammerkit-network-build' } }] }),
        },
      }
      return { calls, instance }
    }

    function executor(patch: object, instance: object) {
      const config = serverConfigSchema.parse({
        issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
        backend: { type: 'kubernetes', kubeconfig: join(root, 'config'), namespace: 'hammerkit', ...patch },
      }) as any
      const result = new KubernetesExecutor(config, {}, {} as any)
      ;(result as any).instance = instance
      ;(result as any).namespaces = new CallerNamespaces(instance as any, config.backend)
      return (result as any).placement()
    }

    it('is made isolated, with the server’s rights bound in it only, and swept of earlier runs', async () => {
      const { calls, instance } = cluster(null)
      const placement = executor({ quota: { pods: 20 } }, instance)
      const prepared = await placement.prepare({ id: 'run_AAAAAAAAAAAAAAA-', owner, source } as Run, context)
      expect(prepared.kubernetes.namespace).toBe(namespace)
      // the operator did not state that the cluster enforces policies: open pods wait for none
      expect(prepared.kubernetes.server.openGate).toBeUndefined()
      expect(calls).toEqual([
        'create Namespace {"hammerkit.dev/managed":"true","hammerkit.dev/caller":"' +
          namespace +
          '","pod-security.kubernetes.io/enforce":"baseline"}',
        'create RoleBinding hammerkit-runs',
        '  hammerkit-runs for system:serviceaccount:hammerkit:server',
        'create NetworkPolicy hammerkit-ingress',
        'create NetworkPolicy hammerkit-egress',
        'create NetworkPolicy hammerkit-proxy-ingress',
        'create NetworkPolicy hammerkit-transfer',
        'create ResourceQuota hammerkit',
        // no defaultResources: one an earlier config made goes
        'delete LimitRange hammerkit',
        ...['Job', 'Deployment', 'Pod', 'Service', 'Secret', 'PersistentVolumeClaim'].map(
          (kind) =>
            `delete ${kind} hammerkit.dev/run,hammerkit.dev/run notin (${getRunLabelValue('run_AAAAAAAAAAAAAAA-')})`
        ),
        // the policy of a limited pod goes once the pod is gone
        `await Pod hammerkit.dev/run,hammerkit.dev/run notin (${getRunLabelValue('run_AAAAAAAAAAAAAAA-')})`,
        'delete NetworkPolicy hammerkit-network-build',
      ])

      calls.length = 0
      await placement.release({ id: 'run_AAAAAAAAAAAAAAA-', owner, source } as Run, context)
      expect(calls).toEqual([
        ...['Job', 'Deployment', 'Pod', 'Service', 'Secret', 'PersistentVolumeClaim'].map(
          (kind) => `delete ${kind} hammerkit.dev/run=${getRunLabelValue('run_AAAAAAAAAAAAAAA-')}`
        ),
        `await Pod hammerkit.dev/run=${getRunLabelValue('run_AAAAAAAAAAAAAAA-')}`,
        'delete NetworkPolicy hammerkit-network-build',
      ])
    })

    it('leaves what the runs that resume after a restart made, and removes it for one that ends before it executes again', async () => {
      const { calls, instance } = cluster(null)
      const config = serverConfigSchema.parse({
        issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
        backend: { type: 'kubernetes', kubeconfig: join(root, 'config'), namespace: 'hammerkit' },
      }) as any
      const executor = new KubernetesExecutor(config, {}, {} as any)
      ;(executor as any).instance = instance
      ;(executor as any).namespaces = new CallerNamespaces(instance as any, config.backend)
      ;(executor as any).serviceRunsSwept = true
      const waiting = { id: 'run_BBBBBBBBBBBBBBB-', owner, source, state: 'queued', startedAt: 'x' } as unknown as Run
      executor.restored([waiting])
      const placement = (executor as any).placement()
      await placement.prepare({ id: 'run_AAAAAAAAAAAAAAA-', owner, source } as Run, context)
      const resuming = [getRunLabelValue('run_AAAAAAAAAAAAAAA-'), getRunLabelValue('run_BBBBBBBBBBBBBBB-')]
      expect(calls).toContain(`delete Job hammerkit.dev/run,hammerkit.dev/run notin (${resuming.join(',')})`)
      calls.length = 0
      // cancelled while it waited in the queue
      await executor.forget(waiting)
      expect(calls).toEqual([
        ...['Job', 'Deployment', 'Pod', 'Service', 'Secret', 'PersistentVolumeClaim'].map(
          (kind) => `delete ${kind} hammerkit.dev/run=${getRunLabelValue('run_BBBBBBBBBBBBBBB-')}`
        ),
        `await Pod hammerkit.dev/run=${getRunLabelValue('run_BBBBBBBBBBBBBBB-')}`,
        'delete NetworkPolicy hammerkit-network-build',
      ])
    })

    it('removes what a resumed run left when its execution ends before it got its place, and keeps it no more', async () => {
      const { calls, instance } = cluster(null)
      const config = serverConfigSchema.parse({
        issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
        backend: { type: 'kubernetes', kubeconfig: join(root, 'config'), namespace: 'hammerkit' },
      }) as any
      const executor = new KubernetesExecutor(config, {}, {} as any)
      ;(executor as any).instance = instance
      ;(executor as any).namespaces = new CallerNamespaces(instance as any, config.backend)
      ;(executor as any).serviceRunsSwept = true
      const resumed = { id: 'run_BBBBBBBBBBBBBBB-', owner, source, state: 'queued', startedAt: 'x' } as unknown as Run
      executor.restored([resumed])
      // its build file is gone: it fails before its tasks have a place on the cluster
      ;(executor as any).host = {
        execute: async () => {
          throw new Error('the build file is no longer on this server')
        },
      }
      await expect(executor.execute(resumed, context)).rejects.toThrow('no longer on this server')
      const label = getRunLabelValue('run_BBBBBBBBBBBBBBB-')
      expect(calls).toContain(`delete Job hammerkit.dev/run=${label}`)
      // the next run's tidy removes what is left of it
      calls.length = 0
      await (executor as any).placement().prepare({ id: 'run_AAAAAAAAAAAAAAA-', owner, source } as Run, context)
      expect(calls).toContain(
        `delete Job hammerkit.dev/run,hammerkit.dev/run notin (${getRunLabelValue('run_AAAAAAAAAAAAAAA-')})`
      )
    })

    it('has the quota the server works out for a caller who may borrow above its share, and only then', async () => {
      const { calls, instance } = cluster(null)
      const create = instance.objectApi.create
      instance.objectApi.create = async (spec: any) => {
        if (spec.kind === 'ResourceQuota') {
          calls.push(`quota ${JSON.stringify(spec.spec.hard)}`)
        }
        return create(spec)
      }
      ;(instance.coreApi as any).listNode = async () => ({
        items: [
          {
            metadata: { labels: { 'kubernetes.io/os': 'linux', 'kubernetes.io/arch': 'amd64' } },
            status: { allocatable: { cpu: '16', memory: '64Gi' } },
          },
        ],
      })
      const quota = { 'requests.cpu': '4', pods: '20' }
      const config = (patch: object) =>
        serverConfigSchema.parse({
          issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
          backend: { type: 'kubernetes', kubeconfig: join(root, 'config'), namespace: 'hammerkit', quota, ...patch },
        }) as any
      // off unless the operator sets backend.maxQuota
      expect((new KubernetesExecutor(config({}), {}, {} as any) as any).quotas).toBeUndefined()

      const borrowing = config({ maxQuota: { 'requests.cpu': '12' }, pools: [{ name: 'amd64' }] })
      const result = new KubernetesExecutor(borrowing, {}, {} as any)
      ;(result as any).instance = instance
      ;(result as any).namespaces = new CallerNamespaces(instance as any, borrowing.backend)
      const run = { id: 'run_AAAAAAAAAAAAAAA-', owner, source } as Run
      ;(result as any).quotas.enter(namespace, run.id)
      await (result as any).placement().prepare(run, context)
      // made with the share, then raised to what the nodes hold beyond it
      expect(calls.filter((call) => call.startsWith('quota '))).toEqual([
        'quota {"requests.cpu":"4","pods":"20"}',
        'quota {"requests.cpu":"12","pods":"20"}',
      ])
      // and never put back to the share by setting the namespace up again
      expect(calls).not.toContain('delete ResourceQuota hammerkit')
    })

    it('has the open pods of a run wait until the policy of the namespace holds, on a cluster that enforces it', async () => {
      const { instance } = cluster(null)
      const placement = executor({ networkPolicy: 'enforced' }, instance)
      const prepared = await placement.prepare({ id: 'run_AAAAAAAAAAAAAAA-', owner, source } as Run, context)
      expect(prepared.kubernetes.server.openGate).toEqual({ host: '169.254.169.254', port: 80 })
    })

    it('is set up again only after a while, or when it was made anew', async () => {
      let uid = 'ns-1'
      const { calls, instance } = cluster({ 'hammerkit.dev/managed': 'true' })
      ;(instance.coreApi as any).readNamespace = async () => ({
        metadata: { name: namespace, uid, labels: { 'hammerkit.dev/managed': 'true' } },
      })
      const config = serverConfigSchema.parse({
        issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
        backend: { type: 'kubernetes', kubeconfig: join(root, 'config'), namespace: 'hammerkit' },
      }) as any
      const namespaces = new CallerNamespaces(instance as any, config.backend)
      const applied = () => calls.filter((call) => call.startsWith('create ')).length
      await namespaces.prepare(namespace)
      const once = applied()
      expect(once).toBeGreaterThan(0)
      // the next runs of the caller find it as the server left it
      await namespaces.prepare(namespace)
      expect(applied()).toBe(once)
      // deleted and made again, by somebody else
      uid = 'ns-2'
      await namespaces.prepare(namespace)
      expect(applied()).toBe(2 * once)
      // and after a while, whatever changed in it
      vi.useFakeTimers({ now: Date.now() + 6 * 60_000, toFake: ['Date'] })
      try {
        await namespaces.prepare(namespace)
      } finally {
        vi.useRealTimers()
      }
      expect(applied()).toBe(3 * once)
    })

    it('never changes the Pod Security level of a namespace, and says what the operator relabels', async () => {
      const config = (backend: object) =>
        serverConfigSchema.parse({
          issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
          backend: { type: 'kubernetes', kubeconfig: join(root, 'config'), namespace: 'hammerkit', ...backend },
        }) as any
      const sandboxed = config({ capabilities: { allow: ['SYS_ADMIN'], runtimeClass: 'gvisor' } })
      const patched: any[] = []
      const made = (labels: object | null) => {
        const { calls, instance } = cluster(labels && { 'hammerkit.dev/managed': 'true', ...labels })
        ;(instance.objectApi as any).patch = async (spec: any) => {
          patched.push(spec)
          return spec
        }
        return { calls, instance: instance as any }
      }
      // made before the capabilities: the run goes on, its tasks that add them fail
      const old = made({ 'pod-security.kubernetes.io/enforce': 'baseline' })
      expect(await new CallerNamespaces(old.instance, config({}).backend).prepare(namespace)).toBeUndefined()
      expect(await new CallerNamespaces(old.instance, sandboxed.backend).prepare(namespace)).toContain(
        `kubectl label namespace ${namespace} pod-security.kubernetes.io/enforce=privileged`
      )
      // made with them: nothing runs in it once the config has none
      const privileged = made({ 'pod-security.kubernetes.io/enforce': 'privileged' })
      expect(await new CallerNamespaces(privileged.instance, sandboxed.backend).prepare(namespace)).toBeUndefined()
      await expect(new CallerNamespaces(privileged.instance, config({}).backend).prepare(namespace)).rejects.toThrow(
        `the namespace ${namespace} enforces Pod Security privileged`
      )
      expect(privileged.calls.filter((call) => call.startsWith('create '))).toHaveLength(
        old.calls.filter((call) => call.startsWith('create ')).length / 2
      )
      expect(patched).toEqual([])
      // a namespace it makes has the level at once
      const fresh = made(null)
      expect(await new CallerNamespaces(fresh.instance, sandboxed.backend).prepare(namespace)).toBeUndefined()
      expect(JSON.parse(fresh.calls[0].slice('create Namespace '.length))).toMatchObject({
        'pod-security.kubernetes.io/enforce': 'privileged',
        'pod-security.kubernetes.io/audit': 'baseline',
      })
    })

    it('gives the claims of tasks the size of the backend, at most its maximum', async () => {
      const { instance } = cluster(null)
      const prepared = await executor({ volumeSize: '5Gi', maxVolumeSize: '50Gi' }, instance).prepare(
        { id: 'run_1', owner, source } as Run,
        context
      )
      expect([prepared.kubernetes.volumeSize, prepared.kubernetes.maxVolumeSize]).toEqual(['5Gi', '50Gi'])

      // a build file states its own size: a server bounds it when the operator does not
      const bounded = async (patch: object) =>
        (await executor(patch, cluster(null).instance).prepare({ id: 'run_1', owner, source } as Run, context))
          .kubernetes.maxVolumeSize
      expect(await bounded({})).toBe('10Gi')
      expect(await bounded({ volumeSize: '20Gi' })).toBe('20Gi')
    })

    it('lets the tasks and services of a run that resumed take over what it left, and only those', async () => {
      const logs = { build: { container: 'containerd://abc', at: '2026-11-22T10:00:00.000000000', count: 1 } }
      const run = { id: 'run_1', owner, source } as Run
      const resumed = await executor({}, cluster(null).instance).prepare(run, { ...context, resumed: { logs } })
      expect(resumed.kubernetes.server.resumed).toEqual({ logs })
      const fresh = await executor({}, cluster(null).instance).prepare(run, context)
      expect(fresh.kubernetes.server.resumed).toBeUndefined()
    })

    it('keeps the claims of tasks for the next runs of the same source, and then removes them', async () => {
      const { instance } = cluster(null)
      const patched: string[] = []
      const deleted: string[] = []
      const claims = [
        {
          metadata: {
            name: 'hammerkit-expired',
            labels: { 'hammerkit.dev/volume-scope': 'ref-1' },
            annotations: { 'hammerkit.dev/expires': '2000-01-01T00:00:00Z' },
          },
        },
      ]
      ;(instance.coreApi as any).listNamespacedPersistentVolumeClaim = async (request: any) => ({
        items:
          request.labelSelector === `hammerkit.dev/kept-by=${getRunLabelValue('run_1')}`
            ? [{ metadata: { name: 'hammerkit-kept' } }]
            : request.labelSelector === 'hammerkit.dev/volume-scope'
              ? claims
              : [],
      })
      ;(instance.coreApi as any).deleteNamespacedPersistentVolumeClaim = async ({ name }: any) => {
        deleted.push(name)
        claims.length = 0
      }
      ;(instance.coreApi as any).readNamespacedPersistentVolumeClaim = async () =>
        Promise.reject(Object.assign(new Error('not found'), { code: 404 }))
      ;(instance.objectApi as any).patch = async (spec: any) => {
        patched.push(`${spec.metadata.name} ${Object.keys(spec.metadata.annotations)}`)
        return spec
      }
      const placement = executor({ keepVolumes: '10m' }, instance)
      const ref = (id: string, repo: string) => ({ id, owner, source: { type: 'ref', repo, ref: 'main' } }) as Run
      const sandbox = (id: string) => ({ id, owner, source: { type: 'sandbox', id, repo: 'git.test/corp/app' } }) as Run
      const scope = async (run: Run) => (await placement.prepare(run, context)).kubernetes.server.volumeScope

      // the claims that expired go before the run
      const first = await scope(ref('run_1', 'git.test/corp/app'))
      expect(deleted).toEqual(['hammerkit-expired'])
      // the runs of a ref of a repository share them; a sandbox's are its own
      expect(await scope(ref('run_2', 'git.test/corp/app'))).toBe(first)
      expect(first).toMatch(/^ref-[0-9a-f]{24}$/)
      expect(await scope(ref('run_3', 'git.test/corp/other'))).not.toBe(first)
      expect(await scope(sandbox('sbx_1'))).not.toBe(await scope(sandbox('sbx_2')))
      expect(await scope(sandbox('sbx_1'))).toMatch(/^sandbox-[0-9a-f]{24}$/)
      // a server that keeps none
      const off = await executor({ keepVolumes: false }, cluster(null).instance).prepare(ref('run_1', 'x'), context)
      expect(off.kubernetes.server.volumeScope).toBeUndefined()

      // what the run kept expires once it ended
      await placement.release(ref('run_1', 'git.test/corp/app'), context)
      expect(patched).toEqual(['hammerkit-kept hammerkit.dev/expires'])
    })

    it('leaves the expired claims of a scope that another run executes in until that run ended', async () => {
      const { instance } = cluster(null)
      const deleted: string[] = []
      const busy = { id: 'run_busy', owner, source: { type: 'ref', repo: 'git.test/corp/app', ref: 'main' } } as Run
      const other = { id: 'run_other', owner, source: { type: 'ref', repo: 'git.test/corp/lib', ref: 'main' } } as Run
      const claim = {
        metadata: {
          name: 'hammerkit-busy',
          labels: { 'hammerkit.dev/volume-scope': getVolumeScope(busy) },
          annotations: { 'hammerkit.dev/expires': '2000-01-01T00:00:00Z' },
        },
      }
      ;(instance.coreApi as any).listNamespacedPersistentVolumeClaim = async (request: any) => ({
        items: request.labelSelector === 'hammerkit.dev/volume-scope' && deleted.length === 0 ? [claim] : [],
      })
      ;(instance.coreApi as any).deleteNamespacedPersistentVolumeClaim = async ({ name }: any) => {
        deleted.push(name)
      }
      ;(instance.coreApi as any).readNamespacedPersistentVolumeClaim = async () =>
        Promise.reject(Object.assign(new Error('not found'), { code: 404 }))
      const config = serverConfigSchema.parse({
        issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
        backend: { type: 'kubernetes', kubeconfig: join(root, 'config'), namespace: 'hammerkit', keepVolumes: '10m' },
      }) as any
      const executor = new KubernetesExecutor(config, {}, {} as any)
      ;(executor as any).instance = instance
      ;(executor as any).namespaces = new CallerNamespaces(instance as any, config.backend)
      ;(executor as any).swept = true
      let end = () => undefined as void
      ;(executor as any).host = { execute: () => new Promise<void>((resolve) => (end = resolve)) }
      // a run of the scope executes, about to mount its claim
      const executing = executor.execute(busy, context)

      // neither another run's look at the namespace nor the timer takes it
      await (executor as any).placement().prepare(other, context)
      await (executor as any).sweep(namespace)
      expect(deleted).toEqual([])

      // once the run ended, it goes
      end()
      await executing
      await (executor as any).sweep(namespace)
      expect(deleted).toEqual(['hammerkit-busy'])
    })

    it('hands the tasks of a run on a sandbox its claim and the pod that holds it', async () => {
      const { instance } = cluster(null)
      const claim = { name: 'claim', namespace, subPath: 'files', label: 'sbx', pod: { name: 'files', uid: 'pod-1' } }
      const prepared = await executor({}, instance).prepare({ id: 'run_1', owner, source } as Run, context, {
        root: '/runs/run_1',
        claim,
      })
      expect(prepared.kubernetes.server.workspace).toEqual({
        root: '/runs/run_1',
        claim: 'claim',
        subPath: 'files',
        label: 'sbx',
        pod: { name: 'files', uid: 'pod-1' },
        // its shell runs in the sandbox's runner
        runner: true,
      })
      const off = await executor({ sandboxes: { runner: false } }, cluster(null).instance).prepare(
        { id: 'run_1', owner, source } as Run,
        context,
        { root: '/runs/run_1', claim }
      )
      expect(off.kubernetes.server.workspace.runner).toBeUndefined()
    })

    it('refuses a namespace of the same name that hammerkit did not make', async () => {
      const { calls, instance } = cluster({ team: 'payments' })
      await expect(executor({}, instance).prepare({ id: 'run_1', owner, source } as Run, context)).rejects.toThrow(
        `the namespace ${namespace} was not made by hammerkit, the server does not run tasks in it`
      )
      expect(calls).toEqual([])
    })
  })

  describe('service runs', () => {
    const config = () =>
      serverConfigSchema.parse({
        issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
        backend: { type: 'kubernetes', kubeconfig: join(root, 'config'), namespace: 'hammerkit' },
      }) as any
    const owner = { iss: 'https://idp.corp', sub: 'alice' }
    const ref = { type: 'ref', repo: 'git.test/corp/app', ref: 'main', commit: 'c'.repeat(40) } as Run['source']
    const up = { services: ['web'], ttl: 1000, name: 'main', endpoints: [] }
    const context: RunContext = { emit: () => undefined, signal: new AbortController().signal }

    it('holds nothing of the caller, and starts from a branch only', async () => {
      const executor = new KubernetesExecutor(config(), {}, {} as any)
      const serviceRun = { id: 'run_1', owner, source: ref, up } as unknown as Run
      expect(executor.excludes(serviceRun, { ...serviceRun, id: 'run_3' })).toBe(false)
      expect(executor.excludes(serviceRun, { id: 'run_4', owner, source: ref } as unknown as Run)).toBe(false)
      const sandbox = { type: 'sandbox', id: 'sbx_1', repo: 'r', commit: 'c', tree: 't' } as Run['source']
      await expect(
        executor.execute({ id: 'run_2', owner, source: sandbox, up } as unknown as Run, context)
      ).rejects.toThrow(/starts from a branch/)
    })

    it('removes the namespaces of service runs no run is in when the server starts', async () => {
      const executor = new KubernetesExecutor(config(), {}, {} as any)
      const active = getServiceRunNamespace('hammerkit-', 'run_active')
      ;(executor as any).serviceRuns.set(active, 1)
      const left = getServiceRunNamespace('hammerkit-', 'run_left')
      const deleted: string[] = []
      const selectors: string[] = []
      ;(executor as any).instance = {
        coreApi: {
          listNamespace: async ({ labelSelector }: any) => {
            selectors.push(labelSelector)
            return {
              items: [
                { metadata: { name: active } },
                { metadata: { name: left } },
                { metadata: { name: 'elsewhere-0123456789abcdef' } },
              ],
            }
          },
          deleteNamespace: async ({ name }: any) => deleted.push(name),
        },
      }
      executor.sweepServiceRuns()
      await vi.waitFor(() => expect(deleted).toEqual([left]))
      expect(selectors).toEqual(['hammerkit.dev/managed=true,hammerkit.dev/service-run'])
      // the sweep of kept claims leaves them be: a service run keeps none
      ;(executor as any).sweepLeftClaims()
      await vi.waitFor(() => expect(selectors).toHaveLength(2))
      expect(selectors[1]).toBe('hammerkit.dev/managed=true,!hammerkit.dev/service-run')
    })

    // a cluster that says what is removed in which namespace
    function recording() {
      const calls: string[] = []
      const collection = (kind: string) => async (request: any) => {
        calls.push(`delete ${kind} ${request.namespace} ${request.labelSelector}`)
      }
      const instance = {
        batchApi: { deleteCollectionNamespacedJob: collection('Job') },
        appsApi: { deleteCollectionNamespacedDeployment: collection('Deployment') },
        coreApi: {
          deleteNamespace: async ({ name }: any) => calls.push(`delete Namespace ${name}`),
          readNamespace: async () => Promise.reject(Object.assign(new Error('not found'), { code: 404 })),
          deleteCollectionNamespacedPod: collection('Pod'),
          deleteCollectionNamespacedService: collection('Service'),
          deleteCollectionNamespacedSecret: collection('Secret'),
          deleteCollectionNamespacedPersistentVolumeClaim: collection('PersistentVolumeClaim'),
          listNamespacedPod: async () => ({ items: [] }),
          listNamespacedPersistentVolumeClaim: async () => ({ items: [] }),
          listNamespace: async () => ({ items: [] as any[] }),
        },
        objectApi: { list: async () => ({ items: [] }) },
      }
      return { calls, instance }
    }

    it('keeps the namespace of a run that sleeps, with its claims, and wakes it there', async () => {
      const executor = new KubernetesExecutor(config(), {}, {} as any)
      const { calls, instance } = recording()
      ;(executor as any).instance = instance
      ;(executor as any).serviceRunsSwept = true
      const run = { id: 'run_4', owner, source: ref, up } as unknown as Run
      const namespace = getServiceRunNamespace('hammerkit-', 'run_4')
      await (executor as any).placement().release(run, { ...context, keep: () => 'volumes' })
      expect(calls).toEqual([
        `delete Job ${namespace} hammerkit.dev/run`,
        `delete Deployment ${namespace} hammerkit.dev/run`,
        `delete Pod ${namespace} hammerkit.dev/run`,
        `delete Service ${namespace} hammerkit.dev/run`,
        `delete Secret ${namespace} hammerkit.dev/run`,
      ])
      // the wakes of the run are in the namespace it slept in, which no sweep removes
      expect((executor as any).namespaceOf({ ...run, wakes: 3 })).toBe(namespace)
      instance.coreApi.listNamespace = async () => ({ items: [{ metadata: { name: namespace } }] })
      ;(executor as any).serviceRunsSwept = false
      executor.sweepServiceRuns()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(calls).not.toContain(`delete Namespace ${namespace}`)
      // it ended without waking: the namespace goes, and the claims with it
      await executor.forget(run)
      expect(calls).toContain(`delete Namespace ${namespace}`)
    })

    it('moves a service run beside itself, and leaves the services to the execution that holds them', async () => {
      const executor = new KubernetesExecutor(config(), {}, {} as any)
      const { calls, instance } = recording()
      ;(executor as any).instance = instance
      ;(executor as any).serviceRunsSwept = true
      const run = { id: 'run_6', owner, source: ref, up } as unknown as Run
      expect(executor.movesBeside(run)).toBe(true)
      expect(executor.movesBeside({ ...run, up: undefined } as Run)).toBe(false)
      const namespace = getServiceRunNamespace('hammerkit-', 'run_6')
      ;(executor as any).serviceRuns.set(namespace, 2)
      // the execution the run moved away from, or a move that did not get there
      await (executor as any).placement().release(run, { ...context, keep: () => 'everything' })
      expect(calls).toEqual([])
      expect((executor as any).serviceRuns.get(namespace)).toBe(1)
      // the run's namespace is still in use: no sweep takes it
      instance.coreApi.listNamespace = async () => ({ items: [{ metadata: { name: namespace } }] })
      executor.sweepServiceRuns()
      ;(executor as any).serviceRunsSwept = false
      executor.sweepServiceRuns()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(calls).toEqual([])
      await (executor as any).placement().release(run, { ...context, keep: () => undefined })
      expect(calls).toEqual([`delete Namespace ${namespace}`])
      expect((executor as any).serviceRuns.has(namespace)).toBe(false)
    })

    it('removes the namespace of a run that sleeps on a server that keeps no volumes, and wakes it in another', async () => {
      const executor = new KubernetesExecutor(
        { ...config(), runs: { ...config().runs, up: { ...config().runs.up, keepVolumes: false } } },
        {},
        {} as any
      )
      const { calls, instance } = recording()
      ;(executor as any).instance = instance
      const run = { id: 'run_5', owner, source: ref, up } as unknown as Run
      await (executor as any).placement().release(run, { ...context, keep: () => undefined })
      expect(calls).toEqual([`delete Namespace ${getServiceRunNamespace('hammerkit-', 'run_5')}`])
      expect((executor as any).namespaceOf({ ...run, wakes: 1 })).toBe(getServiceRunNamespace('hammerkit-', 'run_5', 1))
    })

    it('keeps the namespaces of the runs that sleep with their volumes when the server starts', async () => {
      const executor = new KubernetesExecutor(config(), {}, {} as any)
      const { calls, instance } = recording()
      const sleeping = getServiceRunNamespace('hammerkit-', 'run_sleeping')
      const gone = getServiceRunNamespace('hammerkit-', 'run_gone')
      instance.coreApi.listNamespace = async () => ({
        items: [{ metadata: { name: sleeping } }, { metadata: { name: gone } }],
      })
      ;(executor as any).instance = instance
      executor.restored([{ id: 'run_sleeping', owner, source: ref, up, volumesKept: true } as unknown as Run])
      await vi.waitFor(() => expect(calls).toContain(`delete Namespace ${gone}`))
      // what a server that went away left running in it goes, its claims stay
      await vi.waitFor(() => expect(calls).toContain(`delete Secret ${sleeping} hammerkit.dev/run`))
      expect(calls).not.toContain(`delete Namespace ${sleeping}`)
      expect(calls.filter((call) => call.startsWith('delete PersistentVolumeClaim'))).toEqual([])
    })

    it('leaves the namespace of a service run that resumes after a restart as it is, and removes it once the run ends', async () => {
      const executor = new KubernetesExecutor(config(), {}, {} as any)
      const { calls, instance } = recording()
      const resuming = getServiceRunNamespace('hammerkit-', 'run_resuming')
      instance.coreApi.listNamespace = async () => ({ items: [{ metadata: { name: resuming } }] })
      ;(executor as any).instance = instance
      const run = { id: 'run_resuming', owner, source: ref, up, state: 'queued', startedAt: 'x' } as unknown as Run
      executor.restored([run])
      await new Promise((resolve) => setTimeout(resolve, 20))
      // its services answer on until the run executes again
      expect(calls).toEqual([])
      // cancelled before it did: no execution removes what is left of it
      await executor.forget(run)
      expect(calls).toEqual([`delete Namespace ${resuming}`])
      ;(executor as any).serviceRunsSwept = false
      calls.length = 0
      executor.sweepServiceRuns()
      await vi.waitFor(() => expect(calls).toEqual([`delete Namespace ${resuming}`]))
    })

    it('keeps the namespace of a resumed service run from the sweep while it starts again, and removes it if it never gets there', async () => {
      const executor = new KubernetesExecutor(config(), {}, {} as any)
      const { calls, instance } = recording()
      const namespace = getServiceRunNamespace('hammerkit-', 'run_resuming')
      instance.coreApi.listNamespace = async () => ({ items: [{ metadata: { name: namespace } }] })
      ;(executor as any).instance = instance
      ;(executor as any).serviceRunsSwept = true
      const run = { id: 'run_resuming', owner, source: ref, up, state: 'queued', startedAt: 'x' } as unknown as Run
      executor.restored([run])
      let fail: (e: Error) => void = () => undefined
      ;(executor as any).host = { execute: () => new Promise<void>((_resolve, reject) => (fail = reject)) }
      const execution = executor.execute(run, context)
      // the sweep of the start looks while the run checks out its commit
      ;(executor as any).serviceRunsSwept = false
      executor.sweepServiceRuns()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(calls).toEqual([])
      fail(new Error('the commit is gone'))
      await expect(execution).rejects.toThrow('the commit is gone')
      expect(calls).toEqual([`delete Namespace ${namespace}`])
    })

    it('removes what runs in the namespace when the server may not delete it, and looks again later', async () => {
      const executor = new KubernetesExecutor(config(), {}, {} as any)
      const removed: string[] = []
      const forbidden = Object.assign(new Error('forbidden'), { code: 403 })
      ;(executor as any).serviceRunsSwept = true
      ;(executor as any).instance = {
        batchApi: {
          deleteCollectionNamespacedJob: async (r: any) => removed.push(`${r.namespace} ${r.labelSelector}`),
        },
        appsApi: { deleteCollectionNamespacedDeployment: async () => undefined },
        coreApi: {
          deleteNamespace: async () => {
            throw forbidden
          },
          deleteCollectionNamespacedPod: async () => undefined,
          deleteCollectionNamespacedService: async () => undefined,
          deleteCollectionNamespacedSecret: async () => undefined,
          deleteCollectionNamespacedPersistentVolumeClaim: async () => undefined,
        },
        objectApi: { list: async () => ({ items: [] }) },
      }
      const lines: string[] = []
      const run = { id: 'run_3', owner, source: ref, up } as unknown as Run
      await (executor as any).placement().release(run, { ...context, emit: (event: any) => lines.push(event.text) })
      const namespace = getServiceRunNamespace('hammerkit-', 'run_3')
      expect(removed).toEqual([`${namespace} hammerkit.dev/run`])
      expect(lines[0]).toMatch(/needs delete on namespaces/)
      expect((executor as any).serviceRunsSwept).toBe(false)
    })
  })
})
