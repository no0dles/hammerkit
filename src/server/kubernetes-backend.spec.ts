import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getCallerNamespace, getClusterAccess, KubernetesExecutor } from './kubernetes-backend'
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
})
