import { ensureKubernetesDeploymentExists, MIN_READY_SECONDS } from './ensure-kubernetes-deployment-exists'
import { awaitDeployRunningState } from './await-running-state'
import { getRunLabelValue } from './job-placement'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'

vi.mock('./await-running-state', () => ({ awaitDeployRunningState: vi.fn(async () => undefined) }))
vi.mock('../planner/service-definition', () => ({ getServiceDefinitionHash: () => 'definition' }))
vi.mock('./job-placement', async (original) => ({
  ...(await original<typeof import('./job-placement')>()),
  getPodPlacement: () => ({ nodeSelector: {}, tolerations: [] }),
}))
vi.mock('./network-policy', () => ({ getNetworkLabels: () => ({}) }))

const service = {
  name: 'db',
  id: () => 'abc123',
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
  it('lets the wait fail a crash once the service was restarted as often as it allows', async () => {
    const instance = {
      objectApi: {
        read: vi.fn(async () => {
          throw { code: 404 }
        }),
        create: vi.fn(async (spec: any) => ({ ...spec, status: {} })),
      },
    } as any
    const env = { type: 'kubernetes', namespace: 'caller', httpRoutes: [] } as unknown as WorkKubernetesEnvironment
    const patient = { ...service, data: { ...service.data, restarts: 5 } } as unknown as WorkItem<ContainerWorkService>
    vi.mocked(awaitDeployRunningState).mockClear()
    await ensureKubernetesDeploymentExists(
      instance,
      env,
      patient,
      { mounts: [], volumes: [], workspace: [] } as any,
      { env: [], mounts: [], volumes: [] } as any,
      'state',
      { env: [], hostAliases: [], initContainers: [] }
    )
    expect(awaitDeployRunningState).toHaveBeenCalledWith(
      instance,
      env,
      expect.any(String),
      expect.objectContaining({ restarts: 5 })
    )
  })
})
