import { formatCpu, formatMemory } from './capacity-format'
import { Capacity, cachedCapacity, HostCapacity, KubernetesCapacity, parseQuantity } from './capacity'
import type { KubernetesInstance } from '../kubernetes/kubernetes-instance'
import type { Run } from './runs'
import { getRunLabelValue, RUN_LABEL } from '../kubernetes/job-placement'
import { SANDBOX_LABEL } from '../kubernetes/volumes'

const status = (code: number) => Object.assign(new Error(`HTTP ${code}`), { code })

describe('capacity', () => {
  it('reads the quantities of Kubernetes', () => {
    expect(parseQuantity('250m')).toBeCloseTo(0.25)
    expect(parseQuantity('2')).toBe(2)
    expect(parseQuantity('1.5')).toBe(1.5)
    expect(parseQuantity('512Mi')).toBe(512 * 1024 ** 2)
    expect(parseQuantity('1G')).toBe(1e9)
    expect(parseQuantity('12345678n')).toBeCloseTo(0.012345678)
    expect(parseQuantity('1e3')).toBe(1000)
    expect(parseQuantity('lots')).toBeUndefined()
    expect(parseQuantity(undefined)).toBeUndefined()
    expect(formatCpu(0.25)).toBe('0.25')
    expect(formatCpu(12)).toBe('12')
    expect(formatMemory(512 * 1024 ** 2)).toBe('512 MiB')
    expect(formatMemory(3.4 * 1024 ** 3)).toBe('3.4 GiB')
  })

  it('sums the requests, quota and use of the namespaces, and says what it may not read', async () => {
    const pod = (cpu: string, memory: string, phase = 'Running') => ({
      status: { phase },
      spec: { containers: [{ resources: { requests: { cpu, memory } } }] },
    })
    const instance = {
      coreApi: {
        listNamespacedPod: async ({ namespace }: { namespace: string }) => ({
          items:
            namespace === 'hk-a'
              ? [pod('500m', '256Mi'), pod('1', '1Gi'), pod('4', '4Gi', 'Succeeded')]
              : [pod('250m', '128Mi')],
        }),
        readNamespacedResourceQuota: async ({ namespace }: { namespace: string }) => {
          if (namespace === 'hk-b') {
            throw status(404)
          }
          return { spec: { hard: { 'requests.cpu': '8', 'requests.memory': '16Gi' } } }
        },
        listNode: async () => {
          throw status(403)
        },
      },
      metrics: {
        getPodMetrics: async (namespace: string) => {
          if (namespace === 'hk-b') {
            throw status(403)
          }
          return { items: [{ containers: [{ usage: { cpu: '100000000n', memory: '100Mi' } }] }] }
        },
      },
    } as unknown as KubernetesInstance
    const run = { id: 'run_aaaaaaaaaaaaaaaa', owner: { iss: 'i', sub: 'alice' } } as Run
    const capacity = await new KubernetesCapacity(instance, {
      quotaName: 'hammerkit',
      namespaces: async () => [
        { name: 'hk-b', kind: 'service-run' },
        { name: 'hk-a', kind: 'caller' },
      ],
      ownerOf: (namespace) => (namespace === 'hk-a' ? { owner: run.owner } : {}),
    }).read([run])
    expect(capacity.groups.map((group) => group.name)).toEqual(['hk-a', 'hk-b'])
    const [a, b] = capacity.groups
    expect(a).toMatchObject({ kind: 'caller', owner: { sub: 'alice' }, pods: 2, quota: { cpu: 8 } })
    expect(a.requested.cpu).toBeCloseTo(1.5)
    expect(a.requested.memory).toBe(1280 * 1024 ** 2)
    expect(a.used?.cpu).toBeCloseTo(0.1)
    expect(b).toMatchObject({ kind: 'service-run', pods: 1 })
    expect(b.quota).toBeUndefined()
    expect(b.used).toBeUndefined()
    expect(capacity.runs.pods).toBe(3)
    expect(capacity.runs.requested.cpu).toBeCloseTo(1.75)
    expect(capacity.machines).toBeUndefined()
    expect(capacity.problems).toEqual([
      expect.stringContaining('list on pods.metrics.k8s.io'),
      'the nodes: not shown, the server may not list nodes (optional, see the backend docs)',
    ])
    expect(capacity.unknown).toEqual({ total: 'may not list nodes', used: 'may not read metrics' })
  })

  it('says what the pods of each run and sandbox take, the most used first', async () => {
    const pod = (name: string, labels: Record<string, string>, cpu: string, memory: string, phase = 'Running') => ({
      metadata: { name, labels },
      status: { phase },
      spec: { containers: [{ resources: { requests: { cpu, memory } } }] },
    })
    const build = {
      id: 'run_build',
      owner: { iss: 'i', sub: 'alice', name: 'Alice' },
      tasks: ['build', 'test'],
      source: { type: 'ref', repo: 'github.com/corp/app', ref: 'main' },
    } as unknown as Run
    const preview = {
      id: 'run_preview',
      owner: { iss: 'i', sub: 'bob' },
      tasks: [],
      up: { name: 'pr-7', services: ['web', 'db'] },
      source: { type: 'upload' },
    } as unknown as Run
    const pods: Record<string, unknown[]> = {
      'hk-alice': [
        pod('build-1', { [RUN_LABEL]: getRunLabelValue(build.id) }, '1', '1Gi'),
        pod('test-1', { [RUN_LABEL]: getRunLabelValue(build.id) }, '500m', '512Mi'),
        pod('build-0', { [RUN_LABEL]: getRunLabelValue(build.id) }, '4', '4Gi', 'Succeeded'),
        pod('files', { [SANDBOX_LABEL]: 'abc' }, '100m', '128Mi'),
        pod('gone', { [RUN_LABEL]: getRunLabelValue('run_ended') }, '250m', '64Mi'),
      ],
      'hk-preview': [
        pod('web-1', { [RUN_LABEL]: getRunLabelValue(preview.id) }, '250m', '256Mi'),
        pod('db-1', { [RUN_LABEL]: getRunLabelValue(preview.id) }, '250m', '256Mi'),
      ],
    }
    const usage: Record<string, [string, string, string][]> = {
      'hk-alice': [
        ['build-1', '200m', '300Mi'],
        ['files', '10m', '20Mi'],
      ],
      'hk-preview': [
        ['web-1', '900m', '100Mi'],
        ['db-1', '100m', '100Mi'],
      ],
    }
    const instance = {
      coreApi: {
        listNamespacedPod: async ({ namespace }: { namespace: string }) => ({ items: pods[namespace] }),
        readNamespacedResourceQuota: async () => {
          throw status(404)
        },
        listNode: async () => ({ items: [] }),
      },
      metrics: {
        getPodMetrics: async (namespace: string) => ({
          items: usage[namespace].map(([name, cpu, memory]) => ({
            metadata: { name },
            containers: [{ usage: { cpu, memory } }],
          })),
        }),
        getNodeMetrics: async () => ({ items: [] }),
      },
    } as unknown as KubernetesInstance
    const capacity = await new KubernetesCapacity(instance, {
      quotaName: 'hammerkit',
      namespaces: async () => [
        { name: 'hk-alice', kind: 'caller' },
        { name: 'hk-preview', kind: 'service-run' },
      ],
      ownerOf: (namespace) => (namespace === 'hk-alice' ? { owner: { iss: 'i', sub: 'alice' } } : {}),
    }).read([build, preview])
    const [first, second, third, fourth] = capacity.uses ?? []
    expect(capacity.uses).toHaveLength(4)
    expect(first).toMatchObject({
      kind: 'run',
      run: 'run_preview',
      up: { name: 'pr-7', services: ['web', 'db'] },
      repo: 'an upload',
      owner: { sub: 'bob' },
      pods: 2,
    })
    expect(first.used?.cpu).toBeCloseTo(1)
    expect(first.requested.cpu).toBeCloseTo(0.5)
    expect(second).toMatchObject({
      kind: 'run',
      run: 'run_build',
      tasks: ['build', 'test'],
      repo: 'github.com/corp/app',
      owner: { sub: 'alice', name: 'Alice' },
      pods: 2,
    })
    expect(second.requested.cpu).toBeCloseTo(1.5)
    expect(second.used?.memory).toBe(300 * 1024 ** 2)
    // a sandbox's files, and a pod of a run the server no longer keeps
    expect(third).toMatchObject({ kind: 'sandbox', owner: { sub: 'alice' }, pods: 1 })
    expect(third.used?.cpu).toBeCloseTo(0.01)
    expect(fourth).toMatchObject({ kind: 'other', owner: { sub: 'alice' }, pods: 1 })
    expect(fourth.used).toBeUndefined()
  })

  it('reads the machine and the containers of runs on a host', async () => {
    const docker = {
      info: async () => ({ NCPU: 8, MemTotal: 16 * 1024 ** 3 }),
      listContainers: async () => [{ Id: 'one' }, { Id: 'two' }],
      getContainer: (id: string) => ({
        stats: async () =>
          id === 'one'
            ? {
                cpu_stats: { cpu_usage: { total_usage: 300 }, system_cpu_usage: 1100, online_cpus: 4 },
                precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 100 },
                memory_stats: { usage: 300, stats: { inactive_file: 100 } },
              }
            : Promise.reject(new Error('gone')),
      }),
    }
    const capacity = await new HostCapacity(docker as never, false).read()
    expect(capacity).toMatchObject({
      backend: 'host',
      machines: { count: 1, allocatable: { cpu: 8, memory: 16 * 1024 ** 3 } },
      runs: { containers: 2, used: { memory: 200 } },
      problems: [],
    })
    expect(capacity.runs.used?.cpu).toBeCloseTo(0.8)
  })

  it('reads once in a while, and says why it could not', async () => {
    let reads = 0
    let now = 0
    const cached = cachedCapacity(
      {
        read: async () => {
          reads++
          throw new Error('no daemon')
        },
      },
      1000,
      () => now
    )
    expect((await cached.read([])).problems).toEqual(['no daemon'])
    await cached.read([])
    expect(reads).toBe(1)
    now = 1000
    await cached.read([])
    expect(reads).toBe(2)
  })

  it('does not wait long for a slow read, and shows it once it came', async () => {
    let answer: (capacity: Capacity) => void = () => undefined
    const slow = new Promise<Capacity>((resolve) => (answer = resolve))
    const cached = cachedCapacity({ read: () => slow }, 60_000, Date.now, 20)
    expect((await cached.read([])).problems).toEqual(['the capacity could not be read in time'])
    answer({ backend: 'host', at: '', runs: { requested: {} }, groups: [], problems: [] })
    expect((await cached.read([])).problems).toEqual([])
  })
})
