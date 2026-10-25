import { ensureKubernetesDeploymentExists } from './ensure-kubernetes-deployment-exists'
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
})
