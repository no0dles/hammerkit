import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CallerNamespaces,
  getCallerNamespace,
  getClusterAccess,
  getNamespacePolicies,
  KubernetesExecutor,
} from './kubernetes-backend'
import { getRunLabelValue } from '../kubernetes/job-placement'
import { Run, RunContext } from './runs'
import { KubernetesBackend, serverConfigSchema } from './server-config'

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

  it('runs the runs of one caller one after the other, and those of different callers side by side', async () => {
    const config = serverConfigSchema.parse({
      issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
      backend: { type: 'kubernetes', kubeconfig: join(root, 'config'), namespace: 'hammerkit' },
    }) as any
    const executor = new KubernetesExecutor(config, {}, {} as any)
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
    const run = (id: string, sub: string) => ({ id, owner: { iss: 'https://idp.corp', sub } }) as Run
    const context: RunContext = { emit: () => undefined, signal: new AbortController().signal }
    const first = executor.execute(run('a1', 'alice'), context)
    const second = executor.execute(run('a2', 'alice'), context)
    const other = executor.execute(run('b1', 'bob'), context)
    await new Promise((resolve) => setImmediate(resolve))
    expect(order).toEqual(['start a1', 'start b1'])
    release.a1()
    await first
    await new Promise((resolve) => setImmediate(resolve))
    expect(order).toEqual(['start a1', 'start b1', 'end a1', 'start a2'])
    release.a2()
    release.b1()
    await Promise.all([second, other])

    // a run cancelled while it waits does not start
    const cancelled = new AbortController()
    const blocking = executor.execute(run('a3', 'alice'), context)
    const waiting = executor.execute(run('a4', 'alice'), { ...context, signal: cancelled.signal })
    cancelled.abort()
    await new Promise((resolve) => setImmediate(resolve))
    release.a3()
    await blocking
    await expect(waiting).rejects.toThrow('the run was cancelled')
    expect(order).not.toContain('start a4')
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
      expect(calls).toEqual([
        'create Namespace {"hammerkit.dev/managed":"true","hammerkit.dev/caller":"' +
          namespace +
          '","pod-security.kubernetes.io/enforce":"baseline"}',
        'create RoleBinding hammerkit-runs',
        '  hammerkit-runs for system:serviceaccount:hammerkit:server',
        'create NetworkPolicy hammerkit-ingress',
        'create NetworkPolicy hammerkit-egress',
        'create ResourceQuota hammerkit',
        // no defaultResources: one an earlier config made goes
        'delete LimitRange hammerkit',
        ...['Job', 'Deployment', 'Pod', 'Service', 'Secret', 'PersistentVolumeClaim'].map(
          (kind) => `delete ${kind} hammerkit.dev/run,hammerkit.dev/run!=${getRunLabelValue('run_AAAAAAAAAAAAAAA-')}`
        ),
        // the policy of a limited pod goes once the pod is gone
        `await Pod hammerkit.dev/run,hammerkit.dev/run!=${getRunLabelValue('run_AAAAAAAAAAAAAAA-')}`,
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
      // a repository's runs share them, as they share the cache; a sandbox's are its own
      expect(await scope(ref('run_2', 'git.test/corp/app'))).toBe(first)
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
      })
    })

    it('refuses a namespace of the same name that hammerkit did not make', async () => {
      const { calls, instance } = cluster({ team: 'payments' })
      await expect(executor({}, instance).prepare({ id: 'run_1', owner, source } as Run, context)).rejects.toThrow(
        `the namespace ${namespace} was not made by hammerkit, the server does not run tasks in it`
      )
      expect(calls).toEqual([])
    })
  })
})
