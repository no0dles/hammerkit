import { ensureKubernetesServiceExists } from './ensure-kubernetes-service-exists'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import { WorkService } from '../planner/work-service'
import { getRunLabelValue } from './job-placement'

const env = {
  type: 'kubernetes',
  namespace: 'demo',
  context: 'ctx',
  httpRoutes: [],
  networkPolicyEnforced: false,
} as WorkKubernetesEnvironment

function service(ports: { containerPort: number; hostPort?: number }[]) {
  return {
    name: 'db',
    id: () => 'abc123',
    data: { type: 'container-service', ports },
  } as unknown as WorkItem<WorkService>
}

function cluster(existing: { spec: { clusterIP: string } } | null) {
  const created: any[] = []
  const coreApi = {
    readNamespacedService: vi.fn(async () => {
      if (!existing) {
        throw { code: 404 }
      }
      return existing
    }),
    deleteNamespacedService: vi.fn(async () => {
      existing = null
    }),
  }
  const objectApi = {
    read: vi.fn(async () => {
      if (!existing) {
        throw { code: 404 }
      }
      return existing
    }),
    patch: vi.fn(async (spec: any) => spec),
    create: vi.fn(async (spec: any) => {
      created.push(spec)
      return spec
    }),
  }
  return { instance: { coreApi, objectApi } as any, coreApi, objectApi, created }
}

describe('ensureKubernetesServiceExists', () => {
  it('maps the ports of a service with ports', async () => {
    const { instance, created } = cluster(null)
    await ensureKubernetesServiceExists(instance, env, service([{ containerPort: 5432, hostPort: 15432 }]))
    expect(created[0].spec).toMatchObject({ type: 'ClusterIP', ports: [{ port: 15432, targetPort: 5432 }] })
    expect(created[0].spec.clusterIP).toBeUndefined()
  })

  it('makes a headless Service for a service without ports, which a ClusterIP one needs', async () => {
    const { instance, created } = cluster(null)
    await ensureKubernetesServiceExists(instance, env, service([]))
    expect(created[0].spec).toEqual({
      type: 'ClusterIP',
      clusterIP: 'None',
      selector: { 'hammerkit.dev/id': 'abc123' },
    })
  })

  it('selects only the pods of its own run on a server, whose runs share the namespace', async () => {
    const { instance, created } = cluster(null)
    const onServer = { ...env, server: { run: 'run_1' } } as WorkKubernetesEnvironment
    await ensureKubernetesServiceExists(instance, onServer, service([{ containerPort: 5432 }]))
    const run = getRunLabelValue('run_1')
    expect(created[0].metadata.name).toBe(`db-abc123-${run.substring(0, 8)}`)
    expect(created[0].spec.selector).toEqual({ 'hammerkit.dev/id': 'abc123', 'hammerkit.dev/run': run })
  })

  it('recreates the Service when its ports came or went, since its clusterIP is fixed', async () => {
    const { instance, coreApi, created } = cluster({ spec: { clusterIP: '10.0.0.5' } })
    await ensureKubernetesServiceExists(instance, env, service([]))
    expect(coreApi.deleteNamespacedService).toHaveBeenCalledWith({ name: 'db-abc123', namespace: 'demo' })
    expect(created[0].spec.clusterIP).toBe('None')
  })

  it('patches a Service that keeps its kind', async () => {
    const { instance, coreApi, objectApi } = cluster({ spec: { clusterIP: '10.0.0.5' } })
    await ensureKubernetesServiceExists(instance, env, service([{ containerPort: 5432 }]))
    expect(coreApi.deleteNamespacedService).not.toHaveBeenCalled()
    expect(objectApi.patch).toHaveBeenCalled()
  })
})
