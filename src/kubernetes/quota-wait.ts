import { V1Pod } from '@kubernetes/client-node'
import { parseQuantity } from '../utils/units'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { KubernetesInstance } from './kubernetes-instance'

// How long a pod the quota of its namespace refuses waits for room before what needs it fails:
// a transfer pod in any case, a task's or service's only when no pod that will end holds the
// room (see QuotaWait)
export const QUOTA_TIMEOUT = 10 * 60 * 1000

// What a refusal of the quota of the namespace says, from where it starts: `exceeded quota:
// hammerkit, requested: limits.memory=4Gi, used: limits.memory=24Gi, limited: limits.memory=26Gi`
export function getQuotaRefusal(message: string | undefined): string | null {
  const index = message ? message.search(/exceeded quota/i) : -1
  return message && index >= 0 ? message.slice(index) : null
}

// A pod that asks for more of a resource than the quota allows at all never fits.
export function exceedsQuota(refusal: string): boolean {
  const requested = readAmounts(/requested: (\S+?)(?:,\s|$)/.exec(refusal)?.[1])
  const limited = readAmounts(/limited: (\S+?)(?:,\s|$)/.exec(refusal)?.[1])
  return [...requested].some(([resource, amount]) => {
    const limit = limited.get(resource)
    return limit !== undefined && amount > limit
  })
}

// `limits.memory=4Gi,requests.cpu=1` → limits.memory 4Gi, requests.cpu 1
function readAmounts(list = ''): Map<string, number> {
  const amounts = new Map<string, number>()
  for (const entry of list.split(',')) {
    const [resource, value] = entry.split('=')
    const amount = parseQuantity(value)
    if (resource && amount !== undefined) {
      amounts.set(resource, amount)
    }
  }
  return amounts
}

// A pod that will end and free its room: one of a Job (a task) or a pod of its own (the copy of
// a task's files). The pods of a Deployment (a service) stay as long as what needs them.
function willEnd(pod: V1Pod): boolean {
  if (pod.metadata?.deletionTimestamp || (pod.status?.phase !== 'Pending' && pod.status?.phase !== 'Running')) {
    return false
  }
  return !(pod.metadata?.ownerReferences ?? []).some((owner) => owner.kind === 'ReplicaSet')
}

export interface QuotaWaitOptions {
  // what something waiting is, such as `job build-1` or `service db`
  subject: string
  // ms of refusal after which the wait checks whether it can still end
  timeout: number
  // told once per new refusal
  onWaiting?: (text: string) => void
  now?: () => number
}

/**
 * The wait of a pod the quota of its namespace refuses. It is told what the quota refused,
 * fails at once when the pod asks for more than the quota allows at all, and after `timeout`
 * goes on waiting only while a pod that will end (a task's, another run's) holds room in the
 * namespace: when only services hold it, they wait for what waits for them, and it fails.
 */
export class QuotaWait {
  private since: number | null = null
  private told = ''

  constructor(
    private readonly instance: KubernetesInstance,
    private readonly env: WorkKubernetesEnvironment,
    private readonly options: QuotaWaitOptions
  ) {}

  // Called on each poll with what the quota refused now, or null when nothing is refused.
  async check(refusal: string | null): Promise<void> {
    const now = this.options.now ?? Date.now
    if (!refusal) {
      this.since = null
      return
    }
    if (refusal !== this.told) {
      this.told = refusal
      this.options.onWaiting?.(`waits for room under the quota of the namespace: ${refusal}`)
    }
    if (exceedsQuota(refusal)) {
      throw new Error(`${this.options.subject} asks for more than the quota of the namespace allows: ${refusal}`)
    }
    this.since = this.since ?? now()
    if (now() - this.since < this.options.timeout) {
      return
    }
    if (await this.othersWillEnd()) {
      // checked again after another `timeout`
      this.since = now()
      return
    }
    throw new Error(
      `${this.options.subject} did not fit the quota of the namespace within ${Math.round(
        this.options.timeout / 60000
      )} minutes, and only services hold its room: ${refusal}`
    )
  }

  private async othersWillEnd(): Promise<boolean> {
    try {
      const pods = await this.instance.coreApi.listNamespacedPod({ namespace: this.env.namespace })
      return pods.items.some(willEnd)
    } catch {
      // what it can not see may still end
      return true
    }
  }
}
