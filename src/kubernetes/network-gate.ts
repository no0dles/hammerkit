import { V1Container } from '@kubernetes/client-node'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkTask } from '../planner/work-task'
import { ContainerWorkService } from '../planner/work-service'
import { getEffectiveNetwork } from '../planner/work-network'
import { getContainerSecurity } from './job-placement'

export const NETWORK_GATE_CONTAINER = 'network-gate'
export const NETWORK_GATE_IMAGE = 'alpine:3.19'
// how long a pod waits for its policy before it fails
export const NETWORK_GATE_SECONDS = 60

/**
 * Waits until the pod's NetworkPolicy is in force. A network plugin applies a policy to
 * a new pod a moment after it starts, and until then the pod reaches everything. The
 * policy of a limited item allows no DNS, so once the cluster's DNS server (the
 * pod's nameserver) can't be reached on TCP 53, the policy holds. A cluster whose
 * plugin ignores NetworkPolicies fails the pod here instead of running it unlimited.
 */
export function getNetworkGateScript(seconds: number, resolvConf = '/etc/resolv.conf'): string {
  return [
    `ns=$(sed -n 's/^nameserver[[:space:]]*\\([^[:space:]]*\\).*/\\1/p' ${resolvConf} | head -n 1)`,
    `[ -n "$ns" ] || exit 0`,
    `i=0`,
    `while nc -z -w 1 "$ns" 53 2>/dev/null; do`,
    `  i=$((i+1))`,
    `  if [ "$i" -ge ${seconds} ]; then`,
    `    echo "the network policy was not in force after ${seconds}s" >&2`,
    `    exit 1`,
    `  fi`,
    `  sleep 1`,
    `done`,
  ].join('\n')
}

// The first init container of a limited item's pods, so neither its secrets nor its
// command run before the policy holds. An open item has none.
export function getNetworkGate(
  env: WorkKubernetesEnvironment,
  item: WorkItem<ContainerWorkTask | ContainerWorkService>
): V1Container[] {
  if (getEffectiveNetwork(item.data).type === 'open') {
    return []
  }
  return [
    {
      name: NETWORK_GATE_CONTAINER,
      image: NETWORK_GATE_IMAGE,
      command: ['sh', '-c', getNetworkGateScript(NETWORK_GATE_SECONDS)],
      ...getContainerSecurity(env),
    },
  ]
}

export function describeNetworkGateFailure(item: string): string {
  return (
    `the network policy of ${item} was not in force after ${NETWORK_GATE_SECONDS}s: ` +
    `the cluster's network plugin must enforce NetworkPolicies`
  )
}
