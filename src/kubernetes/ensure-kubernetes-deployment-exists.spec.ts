import { ensureKubernetesDeploymentExists } from './ensure-kubernetes-deployment-exists'
import { awaitDeployRollout, awaitDeployRunningState } from './await-running-state'
import { AbortError } from '../executer/abort'
import { getClaimMountLabel } from './volumes'
import { serviceRollouts } from './service-rollouts'
import { getRunLabelValue } from './job-placement'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'

vi.mock('./await-running-state', () => ({
  awaitDeployRunningState: vi.fn(async () => undefined),
  awaitDeployRollout: vi.fn(async () => undefined),
}))
vi.mock('../planner/service-definition', () => ({ getServiceDefinitionHash: () => 'definition' }))
vi.mock('./job-placement', async (original) => ({
  ...(await original<typeof import('./job-placement')>()),
  getPodPlacement: () => ({ nodeSelector: {}, tolerations: [] }),
}))
vi.mock('./network-policy', () => ({ getNetworkLabels: () => ({}) }))

const service = {
  name: 'db',
  id: () => 'abc123',
  status: { write: vi.fn() },
  data: {
    type: 'container-service',
    image: 'busybox:1.36',
    envs: { variables: {}, replacements: [] },
    ports: [],
    cmd: null,
    healthcheck: null,
    shell: null,
    workdir: null,
    cwd: '/build',
  },
} as unknown as WorkItem<ContainerWorkService>

describe('ensureKubernetesDeploymentExists', () => {
  it('selects only the pods of its own run on a server, whose runs share the namespace', async () => {
    const created: any[] = []
    const instance = {
      objectApi: {
        read: vi.fn(async () => {
          throw { code: 404 }
        }),
        create: vi.fn(async (spec: any) => {
          created.push(spec)
          return { ...spec, status: { readyReplicas: 0 } }
        }),
      },
    } as any
    const env = {
      type: 'kubernetes',
      namespace: 'caller',
      httpRoutes: [],
      networkPolicyEnforced: true,
      server: { run: 'run_1' },
    } as unknown as WorkKubernetesEnvironment
    await ensureKubernetesDeploymentExists(
      instance,
      env,
      service,
      { mounts: [], volumes: [], workspace: [] } as any,
      { env: [], mounts: [], volumes: [] } as any,
      'state',
      { env: [], hostAliases: [], initContainers: [] }
    )

    const run = getRunLabelValue('run_1')
    const labels = { 'hammerkit.dev/id': 'abc123', 'hammerkit.dev/run': run }
    expect(created[0].metadata.name).toBe(`db-abc123-${run.substring(0, 8)}`)
    expect(created[0].spec.selector.matchLabels).toEqual(labels)
    expect(created[0].spec.template.metadata.labels).toMatchObject(labels)
    // ready once a pod of this run is, not one of the other run's
    expect(awaitDeployRunningState).toHaveBeenCalledWith(
      instance,
      env,
      `db-abc123-${run.substring(0, 8)}`,
      expect.objectContaining({ podSelector: `hammerkit.dev/id=abc123,hammerkit.dev/run=${run}` })
    )
  })

  describe('of a service run', () => {
    const env = {
      type: 'kubernetes',
      namespace: 'hk-run',
      httpRoutes: [],
      networkPolicyEnforced: true,
      server: { run: 'run_1', serviceRun: true },
    } as unknown as WorkKubernetesEnvironment
    const run = getRunLabelValue('run_1')
    const name = `db-abc123-${run.substring(0, 8)}`
    const previous = {
      metadata: { name, labels: { 'hammerkit.dev/state': 'old' }, annotations: { a: 'b' } },
      spec: { replicas: 1, template: { metadata: { labels: { 'hammerkit.dev/state': 'old' } } } },
    }

    function cluster() {
      const replaced: any[] = []
      const instance = {
        objectApi: {
          read: vi.fn(async () => ({ metadata: { resourceVersion: '7' } })),
          replace: vi.fn(async (spec: any) => {
            replaced.push(spec)
            return { ...spec, metadata: { ...spec.metadata, generation: 3 } }
          }),
          patch: vi.fn(),
        },
      } as any
      return { instance, replaced }
    }

    function ensure(instance: any, item: WorkItem<ContainerWorkService>, signal?: AbortSignal) {
      return ensureKubernetesDeploymentExists(
        instance,
        env,
        item,
        {
          mounts: [],
          volumes: [{ name: 'hammerkit-api', persistentVolumeClaim: { claimName: 'hammerkit-api' } }],
          workspace: [],
        } as any,
        { env: [], mounts: [], volumes: [] } as any,
        'new',
        { env: [], hostAliases: [], initContainers: [] },
        { previous: previous as any, signal }
      )
    }

    it('replaces the Deployment and waits for its new pods, the old ones serve until then', async () => {
      const { instance, replaced } = cluster()
      await ensure(instance, { ...service, data: { ...service.data, volumes: [] } } as any)

      expect(instance.objectApi.patch).not.toHaveBeenCalled()
      expect(replaced).toHaveLength(1)
      expect(replaced[0].metadata.resourceVersion).toBe('7')
      expect(replaced[0].spec.strategy).toEqual({
        type: 'RollingUpdate',
        rollingUpdate: { maxSurge: 1, maxUnavailable: 0 },
      })
      expect(replaced[0].spec.template.metadata.labels).toMatchObject({
        'hammerkit.dev/state': 'new',
        'hammerkit.dev/definition': 'definition',
        // where the pods that mount its claims are, the old one too
        [getClaimMountLabel('hammerkit-api')]: 'mounted',
      })
      expect(
        replaced[0].spec.template.spec.affinity.podAffinity.requiredDuringSchedulingIgnoredDuringExecution
      ).toEqual([
        {
          labelSelector: { matchLabels: { [getClaimMountLabel('hammerkit-api')]: 'mounted' } },
          topologyKey: 'kubernetes.io/hostname',
        },
      ])
      expect(awaitDeployRollout).toHaveBeenCalledWith(
        instance,
        env,
        name,
        expect.objectContaining({
          generation: 3,
          podSelector: `hammerkit.dev/id=abc123,hammerkit.dev/run=${run},hammerkit.dev/state=new,hammerkit.dev/definition=definition`,
        })
      )
    })

    it('stops a service with volumes of its own before its new pod starts', async () => {
      const { instance, replaced } = cluster()
      await ensure(instance, {
        ...service,
        data: { ...service.data, volumes: [{ name: 'data', containerPath: '/data', inherited: null }] },
      } as any)
      expect(replaced[0].spec.strategy).toEqual({ type: 'Recreate' })
    })

    it('says what it rolled, which the worker puts back when the services do not all get up', async () => {
      const { instance } = cluster()
      vi.mocked(awaitDeployRollout).mockRejectedValueOnce(new AbortError())
      await expect(ensure(instance, { ...service, data: { ...service.data, volumes: [] } } as any)).rejects.toThrow()
      const said: string[] = []
      const undo = { ...instance, appsApi: { deleteNamespacedDeployment: vi.fn() } }
      await serviceRollouts.undo(undo, (text) => said.push(text))
      expect(said).toEqual([`putting ${name} back as it was`])
      expect(instance.objectApi.replace).toHaveBeenLastCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ name, labels: previous.metadata.labels }),
          spec: previous.spec,
        })
      )
      expect(serviceRollouts.size).toBe(0)
    })
  })
})
