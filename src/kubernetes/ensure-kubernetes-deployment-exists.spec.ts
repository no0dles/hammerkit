import {
  ensureKubernetesDeploymentExists,
  MIN_READY_SECONDS,
  POD_ANNOTATION,
} from './ensure-kubernetes-deployment-exists'
import { awaitDeployRollout, awaitDeployRunningState, watchKeptPods } from './await-running-state'
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
  watchKeptPods: vi.fn(async () => undefined),
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
          return { ...spec, status: { availableReplicas: 0 } }
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
        objectApi: { patch: vi.fn(), replace: vi.fn() },
        appsApi: {
          readNamespacedDeployment: vi.fn(async () => ({ metadata: { resourceVersion: '7' } })),
          // the JSON patch of all of it, as the Deployment it makes
          patchNamespacedDeployment: vi.fn(async ({ name, body }: any) => {
            if (!body.some((op: any) => op.path === '/spec')) {
              // a change of its labels only
              return { metadata: { name } }
            }
            const at = (path: string) => body.find((op: any) => op.path === path).value
            const spec = {
              metadata: {
                name,
                resourceVersion: at('/metadata/resourceVersion'),
                labels: at('/metadata/labels'),
                annotations: at('/metadata/annotations'),
              },
              spec: at('/spec'),
            }
            replaced.push(spec)
            return { ...spec, metadata: { ...spec.metadata, generation: 3 } }
          }),
          deleteNamespacedDeployment: vi.fn(),
        },
      } as any
      return { instance, replaced }
    }

    function ensure(instance: any, item: WorkItem<ContainerWorkService>, signal?: AbortSignal, before: any = previous) {
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
        { previous: before, signal }
      )
    }

    it('replaces the Deployment and waits for its new pods, the old ones serve until then', async () => {
      const { instance, replaced } = cluster()
      await ensure(instance, { ...service, data: { ...service.data, volumes: [] } } as any)

      // a patch of all of it, which the runRole allows (it has no update on Deployments)
      expect(instance.objectApi.patch).not.toHaveBeenCalled()
      expect(instance.objectApi.replace).not.toHaveBeenCalled()
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

    it('keeps the pod of a service whose pod would only run at another state, as one that watches its files', async () => {
      // each move executes from a checkout of its own
      const checkout = (root: string) =>
        ({
          ...service,
          data: { ...service.data, volumes: [], continuous: true, projectRoot: root, cwd: `${root}/web` },
        }) as any
      const item = checkout('/runs/run_1-2/source')
      const first = cluster()
      await ensure(first.instance, checkout('/runs/run_1/source'))
      expect(first.replaced[0].spec.template.spec.containers[0].workingDir).toBe('/runs/run_1/source/web')
      const pod = first.replaced[0].metadata.annotations[POD_ANNOTATION]
      expect(pod).toEqual(expect.any(String))
      vi.mocked(awaitDeployRollout).mockClear()

      const { instance, replaced } = cluster()
      const running = {
        metadata: {
          name,
          generation: 3,
          labels: { 'hammerkit.dev/state': 'old', 'hammerkit.dev/definition': 'definition' },
          annotations: { [POD_ANNOTATION]: pod },
        },
        spec: first.replaced[0].spec,
        status: { observedGeneration: 3, replicas: 1, updatedReplicas: 1, availableReplicas: 1 },
      }
      await ensure(instance, item, undefined, running)
      expect(replaced).toEqual([])
      expect(instance.appsApi.patchNamespacedDeployment).toHaveBeenCalledWith({
        name,
        namespace: 'hk-run',
        body: [{ op: 'add', path: '/metadata/labels/hammerkit.dev~1state', value: 'new' }],
      })
      expect(awaitDeployRollout).not.toHaveBeenCalled()
      // and it goes on running with the changed files
      expect(watchKeptPods).toHaveBeenCalledWith(
        instance,
        env,
        name,
        expect.objectContaining({ podSelector: `hammerkit.dev/id=abc123,hammerkit.dev/run=${run}` })
      )
      // put back to its state when the move does not get up
      await serviceRollouts.undo(instance, () => undefined)
      expect(replaced[0].metadata.labels['hammerkit.dev/state']).toBe('old')

      // a dev server that stops working with them fails the move, which puts them back
      vi.mocked(watchKeptPods).mockRejectedValueOnce(new Error('service db stopped working with the changed files'))
      await expect(ensure(cluster().instance, item, undefined, running)).rejects.toThrow('stopped working')
      await serviceRollouts.undo(instance, () => undefined)

      // a pod that is not ready, or another pod, rolls as before
      for (const other of [
        { ...running, status: { ...running.status, availableReplicas: 0 } },
        { ...running, metadata: { ...running.metadata, annotations: { [POD_ANNOTATION]: 'other' } } },
      ]) {
        const rolled = cluster()
        await ensure(rolled.instance, item, undefined, other)
        expect(rolled.replaced).toHaveLength(1)
        await serviceRollouts.undo(rolled.instance, () => undefined)
      }
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
      const { instance, replaced } = cluster()
      vi.mocked(awaitDeployRollout).mockRejectedValueOnce(new AbortError())
      await expect(ensure(instance, { ...service, data: { ...service.data, volumes: [] } } as any)).rejects.toThrow()
      const said: string[] = []
      await serviceRollouts.undo(instance, (text) => said.push(text))
      expect(said).toEqual([`putting ${name} back as it was`])
      expect(replaced[replaced.length - 1]).toEqual(
        expect.objectContaining({
          metadata: expect.objectContaining({ name, labels: previous.metadata.labels }),
          spec: previous.spec,
        })
      )
      expect(serviceRollouts.size).toBe(0)
    })
  })

  it('counts a service without a healthcheck as up once it ran for a while, one with it once it passed', async () => {
    const created: any[] = []
    const instance = {
      objectApi: {
        read: vi.fn(async () => {
          throw { code: 404 }
        }),
        create: vi.fn(async (spec: any) => {
          created.push(spec)
          return { ...spec, status: {} }
        }),
      },
    } as any
    const env = { type: 'kubernetes', namespace: 'caller', httpRoutes: [] } as unknown as WorkKubernetesEnvironment
    const checked = {
      ...service,
      data: {
        ...service.data,
        healthcheck: { cmd: { cmd: 'true', parsed: { command: 'true', args: [] } }, timeout: null },
      },
    } as unknown as WorkItem<ContainerWorkService>
    for (const item of [service, checked]) {
      await ensureKubernetesDeploymentExists(
        instance,
        env,
        item,
        { mounts: [], volumes: [], workspace: [] } as any,
        { env: [], mounts: [], volumes: [] } as any,
        'state',
        { env: [], hostAliases: [], initContainers: [] }
      )
    }
    expect(created[0].spec.minReadySeconds).toBe(MIN_READY_SECONDS)
    expect(created[0].spec.template.spec.containers[0].readinessProbe).toBeUndefined()
    // set to 0, not left out: a patch keeps what it leaves out
    expect(created[1].spec.minReadySeconds).toBe(0)
    expect(created[1].spec.template.spec.containers[0].readinessProbe).toBeDefined()
  })
})
