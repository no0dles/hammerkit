import { V1Node } from '@kubernetes/client-node'
import { getErrorMessage } from '../log'
import { statusCodeOf } from '../kubernetes/apply'
import type { KubernetesInstance } from '../kubernetes/kubernetes-instance'
import { parseQuantity } from '../utils/units'
import type { KubernetesPool } from './server-config'

/**
 * A caller's quota above its share (`backend.quota`), up to `backend.maxQuota`: the room of
 * the nodes that no other caller is promised. While a run of a caller executes, the caller is
 * promised its share; the room of the nodes of the pools beyond the shares of the callers with
 * a run executing and the quotas of the service runs that are up is split evenly among those
 * callers, each up to its `maxQuota`. A caller alone on the cluster gets all of it. The server
 * works it out again when a run of a caller or a service run starts or ends, from nothing but
 * which of them execute and what the nodes hold, so the same runs give the same quotas. It only
 * lowers a quota and never evicts: the pods a caller runs above its new quota run on, and its
 * next ones wait for room under the quota as they do under a full one.
 */

// The keys of a quota a caller may borrow, by the resource of the nodes whose room they take.
// `cpu` and `memory` are `requests.cpu` and `requests.memory`, as Kubernetes reads them.
export const BORROWED_RESOURCES = {
  cpu: { requests: ['requests.cpu', 'cpu'], limits: ['limits.cpu'] },
  memory: { requests: ['requests.memory', 'memory'], limits: ['limits.memory'] },
} as const

export type BorrowedResource = keyof typeof BORROWED_RESOURCES

export type Quota = Record<string, string>

export interface Room {
  cpu?: number
  memory?: number
}

export function getBorrowedResource(key: string): BorrowedResource | undefined {
  return (Object.keys(BORROWED_RESOURCES) as BorrowedResource[]).find((resource) => {
    const keys: readonly string[] = [...BORROWED_RESOURCES[resource].requests, ...BORROWED_RESOURCES[resource].limits]
    return keys.includes(key)
  })
}

// The key of a quota that holds what the pods of a namespace request of `resource`
function requestsKey(quota: Quota, resource: BorrowedResource): string | undefined {
  return BORROWED_RESOURCES[resource].requests.find((key) => quota[key] !== undefined)
}

/**
 * The quota of each caller with a run executing: its share, and of each resource of
 * `maxQuota` the part of the room `callers` share evenly beyond what is promised, up to
 * `maxQuota`. Every key of a resource rises by the same part of the way from its share to its
 * `maxQuota`, its limits as its requests. Without the room of the nodes, the share.
 */
export function getBorrowedQuota(options: {
  quota: Quota
  maxQuota: Quota
  // the callers with a run executing, the one this is for among them
  callers: number
  // the quotas of the service runs that are up
  serviceRuns: Quota[]
  // what the nodes of the pools hold
  room: Room | undefined
}): Quota {
  const { quota, maxQuota } = options
  const borrowed: Quota = { ...quota }
  const callers = Math.max(1, options.callers)
  for (const resource of Object.keys(BORROWED_RESOURCES) as BorrowedResource[]) {
    const key = requestsKey(maxQuota, resource)
    const room = options.room?.[resource]
    if (!key || room === undefined) {
      continue
    }
    const share = parseQuantity(quota[key]) ?? 0
    const max = parseQuantity(maxQuota[key]) ?? share
    if (max <= share) {
      continue
    }
    const promised =
      callers * share +
      options.serviceRuns.reduce((sum, up) => {
        const of = requestsKey(up, resource)
        return sum + (of ? parseQuantity(up[of]) ?? 0 : 0)
      }, 0)
    const part = Math.min(1, Math.max(0, (room - promised) / callers / (max - share)))
    if (part === 0) {
      continue
    }
    for (const of of [...BORROWED_RESOURCES[resource].requests, ...BORROWED_RESOURCES[resource].limits]) {
      if (maxQuota[of] === undefined) {
        continue
      }
      if (part === 1) {
        borrowed[of] = maxQuota[of]
        continue
      }
      const from = parseQuantity(quota[of]) ?? 0
      const to = parseQuantity(maxQuota[of]) ?? from
      borrowed[of] = formatQuantity(resource, from + part * (to - from))
    }
  }
  return borrowed
}

// Down to a millicore and a MiB, so that a quota changes only with what it is worked out from
function formatQuantity(resource: BorrowedResource, amount: number): string {
  return resource === 'cpu' ? `${Math.floor(amount * 1000)}m` : `${Math.floor(amount / 2 ** 20)}Mi`
}

// Whether a node is one of a pool's, where the pods of tasks and services go
export function isPoolNode(node: V1Node, pools: KubernetesPool[]): boolean {
  if (node.spec?.unschedulable) {
    return false
  }
  const labels = node.metadata?.labels ?? {}
  return pools.some(
    (pool) =>
      labels['kubernetes.io/os'] === pool.platform.os &&
      labels['kubernetes.io/arch'] === pool.platform.arch &&
      Object.entries(pool.nodeSelector).every(([label, value]) => labels[label] === value)
  )
}

// What the schedulable nodes of the pools hold together
export async function readPoolRoom(instance: KubernetesInstance, pools: KubernetesPool[]): Promise<Room> {
  const nodes = await instance.coreApi.listNode()
  const room: Room = { cpu: 0, memory: 0 }
  for (const node of nodes.items.filter((candidate) => isPoolNode(candidate, pools))) {
    room.cpu = (room.cpu ?? 0) + (parseQuantity(node.status?.allocatable?.cpu) ?? 0)
    room.memory = (room.memory ?? 0) + (parseQuantity(node.status?.allocatable?.memory) ?? 0)
  }
  return room
}

export interface BorrowedQuotasOptions {
  quota: Quota
  maxQuota: Quota
  // what the nodes of the pools hold; it throws when they can't be read
  room: () => Promise<Room>
  // replaces the quota of a caller's namespace
  write: (namespace: string, quota: Quota) => Promise<void>
  log?: (line: string) => void
}

/**
 * The quotas of the callers' namespaces while `backend.maxQuota` lets them borrow: which
 * callers have a run executing and which service runs are up, and the quota last written to
 * each namespace. Changes are worked out and written one at a time, in the order they came.
 */
export class BorrowedQuotas {
  // per caller namespace, its runs that execute
  private readonly runs = new Map<string, Set<string>>()
  // per namespace of a service run that is up, its quota
  private readonly serviceRuns = new Map<string, Quota>()
  // per caller namespace, the quota last written to it
  private readonly written = new Map<string, string>()
  private last: Promise<void> = Promise.resolve()
  private roomProblem: string | undefined

  constructor(private readonly options: BorrowedQuotasOptions) {}

  // A run of the caller of `namespace` executes from now, until `leave`.
  enter(namespace: string, run: string): void {
    const runs = this.runs.get(namespace) ?? new Set<string>()
    runs.add(run)
    this.runs.set(namespace, runs)
  }

  // The run ended: the quotas are worked out again, the caller's back to its share once its
  // last run ended.
  leave(namespace: string, run: string): Promise<void> {
    const runs = this.runs.get(namespace)
    if (!runs?.delete(run)) {
      return this.last
    }
    if (runs.size === 0) {
      this.runs.delete(namespace)
    }
    return this.apply()
  }

  // A service run is up, with the quota of its namespace, until `serviceRunEnded`.
  serviceRun(namespace: string, quota: Quota | undefined): Promise<void> {
    this.serviceRuns.set(namespace, quota ?? {})
    return this.apply()
  }

  serviceRunEnded(namespace: string): Promise<void> {
    if (!this.serviceRuns.delete(namespace)) {
      return this.last
    }
    return this.apply()
  }

  // The quotas as they are now, written where they changed; the quota of `own` (the namespace
  // of a run that starts, which it is written into before its tasks run) also when it did
  // not, since the server may have made the namespace since. Writing to `own` fails the call,
  // writing to another caller's namespace is logged.
  apply(own?: string): Promise<void> {
    const next = this.last.then(() => this.write(own))
    this.last = next.catch(() => undefined)
    return next
  }

  private async write(own?: string): Promise<void> {
    const room = await this.options.room().then(
      (room) => {
        this.roomProblem = undefined
        return room
      },
      (e) => {
        const problem = getErrorMessage(e)
        if (problem !== this.roomProblem) {
          this.roomProblem = problem
          this.options.log?.(`callers borrow no quota, the nodes could not be read: ${problem}`)
        }
        return undefined
      }
    )
    const callers = [...this.runs.keys()]
    const borrowed = getBorrowedQuota({
      quota: this.options.quota,
      maxQuota: this.options.maxQuota,
      callers: callers.length,
      serviceRuns: [...this.serviceRuns.values()],
      room,
    })
    // those that give back first, then those that borrow
    const quotas: [string, Quota][] = [
      ...[...this.written.keys()]
        .filter((namespace) => !this.runs.has(namespace))
        .map((namespace): [string, Quota] => [namespace, this.options.quota]),
      ...callers.map((namespace): [string, Quota] => [namespace, borrowed]),
    ]
    for (const [namespace, quota] of quotas) {
      const text = JSON.stringify(quota)
      if (namespace !== own && this.written.get(namespace) === text) {
        continue
      }
      try {
        await this.options.write(namespace, quota)
        this.written.set(namespace, text)
      } catch (e) {
        if (namespace === own) {
          throw e
        }
        this.written.delete(namespace)
        if (statusCodeOf(e) !== 404) {
          this.options.log?.(`the quota of ${namespace} could not be changed: ${getErrorMessage(e)}`)
        }
      }
    }
    // a caller back at its share needs nothing written until it borrows again
    for (const namespace of [...this.written.keys()]) {
      if (!this.runs.has(namespace)) {
        this.written.delete(namespace)
      }
    }
  }
}
