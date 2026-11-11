import { cpus, freemem, loadavg, totalmem } from 'os'
import type Dockerode from 'dockerode'
import { getErrorMessage } from '../log'
import { statusCodeOf } from '../kubernetes/apply'
import type { KubernetesInstance } from '../kubernetes/kubernetes-instance'
import type { Run } from './runs'

/**
 * What the machines of a server have, what the runs on them asked for and what they use:
 * CPU in cores and memory in bytes. On Kubernetes per namespace of a caller or a service run
 * (requested by its pods, the quota the server set, used by the metrics API), and the nodes
 * when the server may list them. On a host the machine the docker daemon runs on, and the
 * containers of runs on it. What could not be read is said in `problems`, the rest still shows.
 */
export interface Resources {
  cpu?: number
  memory?: number
}

export interface CapacityGroup {
  // the namespace on Kubernetes
  name: string
  kind: 'caller' | 'service-run'
  // whose runs execute in it, when one of the runs the server keeps tells
  owner?: { iss: string; sub: string }
  // the service run of the namespace
  run?: string
  pods: number
  requested: Resources
  // the quota the server set on it (`backend.quota`, `runs.up.quota`)
  quota?: Resources
  used?: Resources
}

export interface Capacity {
  backend: 'kubernetes' | 'host'
  at: string
  // what the machines have: the nodes of the cluster, or the machine of the docker daemon
  machines?: { count: number; allocatable: Resources; used?: Resources; load?: number[] }
  // what the runs of the server take together
  runs: { requested: Resources; used?: Resources; pods?: number; containers?: number }
  groups: CapacityGroup[]
  problems: string[]
  // why the total of the machines or what runs use could not be read, in a few words, for the
  // meters of the dashboard (the whole answer is in `problems`)
  unknown?: { total?: string; used?: string }
}

export interface CapacityReader {
  read(runs: Run[]): Promise<Capacity>
}

const UNITS: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  '': 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
}

// A quantity of Kubernetes (`250m`, `1.5`, `512Mi`, `12345678n`, `1e3`), as a number.
export function parseQuantity(value: string | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value === 'number') {
    return value
  }
  const match = /^([+-]?[0-9.]+(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/.exec(value.trim())
  if (!match || !(match[2] in UNITS)) {
    return undefined
  }
  const number = Number(match[1])
  return Number.isFinite(number) ? number * UNITS[match[2]] : undefined
}

function add(into: Resources, cpu: number | undefined, memory: number | undefined): void {
  if (cpu !== undefined) {
    into.cpu = (into.cpu ?? 0) + cpu
  }
  if (memory !== undefined) {
    into.memory = (into.memory ?? 0) + memory
  }
}

function addAll(into: Resources, from: Resources | undefined): void {
  if (from) {
    add(into, from.cpu, from.memory)
  }
}

// Reads at most once in `ms`, and never twice at the same time: the dashboard reloads. A read
// that takes longer than `wait` is not waited for: a slow cluster API does not hold up a page,
// the next one shows what it read.
export function cachedCapacity(reader: CapacityReader, ms = 15_000, now = Date.now, wait = 3000): CapacityReader {
  let last: { at: number; value: Promise<Capacity> } | undefined
  const failed = (problem: string): Capacity => ({
    backend: 'host',
    at: new Date(now()).toISOString(),
    runs: { requested: {} },
    groups: [],
    problems: [problem],
  })
  return {
    read(runs) {
      if (!last || now() - last.at >= ms) {
        const value = reader.read(runs).catch((e): Capacity => failed(getErrorMessage(e)))
        last = { at: now(), value }
      }
      let timer: NodeJS.Timeout | undefined
      const late = new Promise<Capacity>((resolve) => {
        timer = setTimeout(() => resolve(failed('the capacity could not be read in time')), wait)
        timer.unref?.()
      })
      return Promise.race([last.value, late]).finally(() => clearTimeout(timer))
    },
  }
}

function why(what: string, e: unknown, rule?: string): string {
  const code = statusCodeOf(e)
  if (code === 403 && rule) {
    return `${what}: the server may not read it, it needs ${rule}`
  }
  if (code === 404 && what.includes('metrics')) {
    return `${what}: the cluster serves no metrics API (metrics-server)`
  }
  return `${what}: ${getErrorMessage(e)}`
}

// `why`, in a few words
function briefly(e: unknown, what: 'nodes' | 'metrics'): string {
  const code = statusCodeOf(e)
  if (code === 403) {
    return what === 'nodes' ? 'may not list nodes' : 'may not read metrics'
  }
  if (code === 404 && what === 'metrics') {
    return 'no metrics API'
  }
  return what === 'nodes' ? 'nodes not readable' : 'metrics not readable'
}

export interface KubernetesCapacityOptions {
  // the namespaces of the server's callers and service runs, and whose they are
  namespaces: () => Promise<{ name: string; kind: CapacityGroup['kind'] }[]>
  // whose runs execute in a namespace, by the runs the server keeps
  ownerOf: (namespace: string, runs: Run[]) => Pick<CapacityGroup, 'owner' | 'run'>
  quotaName: string
}

const ENDED = ['Succeeded', 'Failed']

// On Kubernetes: per namespace of the server, its pods' requests, its quota and its usage.
export class KubernetesCapacity implements CapacityReader {
  constructor(
    private readonly instance: KubernetesInstance,
    private readonly options: KubernetesCapacityOptions
  ) {}

  async read(runs: Run[]): Promise<Capacity> {
    const problems: string[] = []
    const groups: CapacityGroup[] = []
    let namespaces: { name: string; kind: CapacityGroup['kind'] }[] = []
    try {
      namespaces = await this.options.namespaces()
    } catch (e) {
      problems.push(why('the namespaces of the server', e))
    }
    const unknown: NonNullable<Capacity['unknown']> = {}
    const said = new Set<string>()
    const once = (text: string) => {
      if (!said.has(text)) {
        said.add(text)
        problems.push(text)
      }
    }
    await Promise.all(
      namespaces.map(async ({ name: namespace, kind }) => {
        const group: CapacityGroup = {
          name: namespace,
          kind,
          ...this.options.ownerOf(namespace, runs),
          pods: 0,
          // a namespace whose pods could be listed and that has none asks for nothing
          requested: { cpu: 0, memory: 0 },
        }
        try {
          const pods = await this.instance.coreApi.listNamespacedPod({ namespace })
          for (const pod of pods.items) {
            if (ENDED.includes(pod.status?.phase ?? '')) {
              continue
            }
            group.pods++
            for (const container of pod.spec?.containers ?? []) {
              const requests = container.resources?.requests ?? {}
              add(group.requested, parseQuantity(requests.cpu) ?? 0, parseQuantity(requests.memory) ?? 0)
            }
          }
        } catch (e) {
          once(why('the pods of the namespaces', e, 'list on pods in them (runRole)'))
        }
        try {
          const quota = await this.instance.coreApi.readNamespacedResourceQuota({
            name: this.options.quotaName,
            namespace,
          })
          const hard = quota.spec?.hard ?? {}
          const cpu = parseQuantity(hard['requests.cpu'] ?? hard.cpu)
          const memory = parseQuantity(hard['requests.memory'] ?? hard.memory)
          if (cpu !== undefined || memory !== undefined) {
            group.quota = { ...(cpu !== undefined ? { cpu } : {}), ...(memory !== undefined ? { memory } : {}) }
          }
        } catch (e) {
          // a namespace without a quota is no problem
          if (statusCodeOf(e) !== 404) {
            once(why('the quotas of the namespaces', e, 'get on resourcequotas in them (runRole)'))
          }
        }
        if (this.instance.metrics) {
          try {
            const metrics = await this.instance.metrics.getPodMetrics(namespace)
            const used: Resources = { cpu: 0, memory: 0 }
            for (const pod of metrics.items) {
              for (const container of pod.containers) {
                add(used, parseQuantity(container.usage.cpu), parseQuantity(container.usage.memory))
              }
            }
            group.used = used
          } catch (e) {
            unknown.used ??= briefly(e, 'metrics')
            once(
              why(
                'what the pods use (metrics)',
                e,
                'list on pods.metrics.k8s.io in them (runRole, see the backend docs)'
              )
            )
          }
        }
        groups.push(group)
      })
    )
    groups.sort((a, b) => a.name.localeCompare(b.name))
    const total: Capacity['runs'] = { requested: {}, pods: 0 }
    const used: Resources = {}
    for (const group of groups) {
      addAll(total.requested, group.requested)
      total.pods = (total.pods ?? 0) + group.pods
      addAll(used, group.used)
    }
    if (groups.some((group) => group.used)) {
      total.used = used
    }
    let machines: Capacity['machines']
    try {
      const nodes = await this.instance.coreApi.listNode()
      const allocatable: Resources = {}
      for (const node of nodes.items) {
        const of = node.status?.allocatable ?? {}
        add(allocatable, parseQuantity(of.cpu), parseQuantity(of.memory))
      }
      machines = { count: nodes.items.length, allocatable }
      if (this.instance.metrics) {
        try {
          const metrics = await this.instance.metrics.getNodeMetrics()
          const nodesUsed: Resources = {}
          for (const node of metrics.items) {
            add(nodesUsed, parseQuantity(node.usage.cpu), parseQuantity(node.usage.memory))
          }
          machines.used = nodesUsed
        } catch (e) {
          unknown.used ??= briefly(e, 'metrics')
          once(why('what the nodes use (metrics)', e, 'list on nodes.metrics.k8s.io (see the backend docs)'))
        }
      }
    } catch (e) {
      unknown.total = briefly(e, 'nodes')
      // listing nodes is optional, and many clusters do not let a workload do it
      if (statusCodeOf(e) === 403) {
        once('the nodes: not shown, the server may not list nodes (optional, see the backend docs)')
      } else {
        once(why('the nodes', e))
      }
    }
    return {
      backend: 'kubernetes',
      at: new Date().toISOString(),
      ...(machines ? { machines } : {}),
      runs: total,
      groups,
      problems,
      ...(Object.keys(unknown).length > 0 ? { unknown } : {}),
    }
  }
}

// On a host: the machine of the docker daemon, and the containers runs started on it.
export class HostCapacity implements CapacityReader {
  constructor(
    private readonly docker: Pick<Dockerode, 'info' | 'listContainers' | 'getContainer'>,
    // whether the docker daemon runs on this machine, so its load is the server's
    private readonly local = true
  ) {}

  async read(): Promise<Capacity> {
    const problems: string[] = []
    let machines: Capacity['machines']
    try {
      const info = (await this.docker.info()) as { NCPU?: number; MemTotal?: number }
      machines = {
        count: 1,
        allocatable: { cpu: info.NCPU ?? cpus().length, memory: info.MemTotal ?? totalmem() },
        ...(this.local ? { used: { memory: totalmem() - freemem() }, load: loadavg() } : {}),
      }
    } catch (e) {
      problems.push(why('the docker daemon', e))
      machines = this.local
        ? {
            count: 1,
            allocatable: { cpu: cpus().length, memory: totalmem() },
            used: { memory: totalmem() - freemem() },
            load: loadavg(),
          }
        : undefined
    }
    const runs: Capacity['runs'] = { requested: {}, used: {}, containers: 0 }
    try {
      const containers = await this.docker.listContainers({ filters: { label: ['app=hammerkit'] } })
      runs.containers = containers.length
      await Promise.all(
        containers.map(async (container) => {
          try {
            const stats = (await this.docker.getContainer(container.Id).stats({ stream: false })) as {
              cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number }
              precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number }
              memory_stats?: { usage?: number; stats?: { inactive_file?: number; cache?: number } }
            }
            const cpu = stats.cpu_stats?.cpu_usage?.total_usage ?? 0
            const before = stats.precpu_stats?.cpu_usage?.total_usage ?? 0
            const system = (stats.cpu_stats?.system_cpu_usage ?? 0) - (stats.precpu_stats?.system_cpu_usage ?? 0)
            const online = stats.cpu_stats?.online_cpus ?? 1
            const cores = system > 0 ? ((cpu - before) / system) * online : 0
            const memory =
              (stats.memory_stats?.usage ?? 0) -
              (stats.memory_stats?.stats?.inactive_file ?? stats.memory_stats?.stats?.cache ?? 0)
            add(runs.used as Resources, Math.max(0, cores), Math.max(0, memory))
          } catch {
            // a container that just ended
          }
        })
      )
    } catch (e) {
      problems.push(why('the containers of runs', e))
      delete runs.used
    }
    return {
      backend: 'host',
      at: new Date().toISOString(),
      ...(machines ? { machines } : {}),
      runs,
      groups: [],
      problems,
    }
  }
}

export { formatCpu, formatMemory } from './capacity-format'
