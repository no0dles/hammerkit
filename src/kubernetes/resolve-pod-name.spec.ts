import { resolvePodName } from './resolve-pod-name'
import { AppsV1Api, CoreV1Api } from '@kubernetes/client-node'

function podBody(items: Array<{ name: string; ready?: boolean }>) {
  return {
    body: {
      items: items.map((p) => ({
        metadata: { name: p.name },
        status: {
          conditions: [{ type: 'Ready', status: p.ready ? 'True' : 'False' }],
        },
      })),
    },
  } as any
}

function makeCoreApi(opts: {
  service?: { selector?: { [k: string]: string } }
  pods?: Array<{ name: string; ready?: boolean }>
} = {}): CoreV1Api {
  return {
    readNamespacedService: jest.fn().mockResolvedValue({ body: { spec: { selector: opts.service?.selector } } }),
    listNamespacedPod: jest.fn().mockResolvedValue(podBody(opts.pods ?? [])),
  } as any
}

function makeAppsApi(opts: { deployment?: { matchLabels?: { [k: string]: string } } } = {}): AppsV1Api {
  return {
    readNamespacedDeployment: jest
      .fn()
      .mockResolvedValue({ body: { spec: { selector: { matchLabels: opts.deployment?.matchLabels } } } }),
  } as any
}

describe('resolvePodName', () => {
  it('returns the name directly for selector type "pod"', async () => {
    const core = makeCoreApi()
    const apps = makeAppsApi()
    await expect(resolvePodName(core, apps, 'ns', { type: 'pod', name: 'my-pod' })).resolves.toBe('my-pod')
    expect(core.listNamespacedPod).not.toHaveBeenCalled()
  })

  it('resolves a service to a ready pod', async () => {
    const core = makeCoreApi({
      service: { selector: { app: 'api' } },
      pods: [
        { name: 'api-old', ready: false },
        { name: 'api-new', ready: true },
      ],
    })
    const apps = makeAppsApi()
    await expect(resolvePodName(core, apps, 'ns', { type: 'service', name: 'api' })).resolves.toBe('api-new')
    expect(core.listNamespacedPod).toHaveBeenCalledWith('ns', undefined, undefined, undefined, undefined, 'app=api')
  })

  it('falls back to the first pod if none are ready', async () => {
    const core = makeCoreApi({
      service: { selector: { app: 'api' } },
      pods: [
        { name: 'api-1', ready: false },
        { name: 'api-2', ready: false },
      ],
    })
    const apps = makeAppsApi()
    await expect(resolvePodName(core, apps, 'ns', { type: 'service', name: 'api' })).resolves.toBe('api-1')
  })

  it('resolves a deployment via matchLabels', async () => {
    const core = makeCoreApi({ pods: [{ name: 'p', ready: true }] })
    const apps = makeAppsApi({ deployment: { matchLabels: { 'hammerkit.dev/id': 'x' } } })
    await expect(resolvePodName(core, apps, 'ns', { type: 'deployment', name: 'api' })).resolves.toBe('p')
    expect(core.listNamespacedPod).toHaveBeenCalledWith(
      'ns',
      undefined,
      undefined,
      undefined,
      undefined,
      'hammerkit.dev/id=x'
    )
  })

  it('throws when a service has no selector', async () => {
    const core = makeCoreApi({ service: { selector: undefined } })
    const apps = makeAppsApi()
    await expect(resolvePodName(core, apps, 'ns', { type: 'service', name: 'api' })).rejects.toThrow(/no selector/)
  })

  it('throws when no pods match', async () => {
    const core = makeCoreApi({ service: { selector: { app: 'api' } }, pods: [] })
    const apps = makeAppsApi()
    await expect(resolvePodName(core, apps, 'ns', { type: 'service', name: 'api' })).rejects.toThrow(
      /no pod found/
    )
  })

  it('rejects unsupported selector types', async () => {
    const core = makeCoreApi()
    const apps = makeAppsApi()
    await expect(resolvePodName(core, apps, 'ns', { type: 'statefulset', name: 'x' })).rejects.toThrow(
      /unsupported selector type/
    )
  })
})
