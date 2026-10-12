import { V1Deployment, V1EnvVar, V1HostAlias, V1NetworkPolicy, V1Service } from '@kubernetes/client-node'
import { PassThrough, Writable } from 'stream'
import { createInterface } from 'readline'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { isContainerWorkServiceItem, WorkItem } from '../planner/work-item'
import { ContainerWorkTask } from '../planner/work-task'
import { ContainerWorkService } from '../planner/work-service'
import { getEffectiveNetwork, WorkNetwork } from '../planner/work-network'
import { KubernetesInstance } from './kubernetes-instance'
import { apply, KubernetesObjectHeader, statusCodeOf } from './apply'
import { getServiceIp } from './get-service-ip'
import { getVersion } from '../version'
import { awaitDeployRunningState } from './await-running-state'
import {
  EGRESS_PROXY_HOST,
  EGRESS_PROXY_IMAGE,
  EGRESS_PROXY_PORT,
  formatRefusedHost,
  getEgressProxyCommand,
  getEgressProxyEnvironment,
  getProxyClientEnvironment,
  parseEgressProxyEvent,
} from '../network/egress-proxy'
import { getErrorMessage } from '../log'

type ContainerItem = WorkItem<ContainerWorkTask | ContainerWorkService>

const ID_LABEL = 'hammerkit.dev/id'
const PROXY_LABEL = 'hammerkit.dev/proxy-for'

export interface KubernetesItemNetwork {
  // the proxy variables under `allow`
  env: V1EnvVar[]
  // the needed services, and the proxy under `allow`, by name
  hostAliases: V1HostAlias[]
  // stops following the proxy's log
  close(): void
}

// Names short enough for a Service (63 characters), whatever the item is called.
export function getProxyName(item: ContainerItem): string {
  return `hammerkit-proxy-${item.id()}`
}

export function getNetworkPolicyName(item: ContainerItem): string {
  return `hammerkit-network-${item.id()}`
}

// The NetworkPolicy of a limited item: egress to the pods of the services it
// needs and, under `allow`, to its proxy; nothing else, DNS included (needs
// and the proxy are host aliases). An open item has none.
export function buildNetworkPolicy(
  env: WorkKubernetesEnvironment,
  item: ContainerItem,
  network: WorkNetwork
): V1NetworkPolicy & KubernetesObjectHeader {
  const needs = item.needs.filter((need) => isContainerWorkServiceItem(need.service))
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      namespace: env.namespace,
      name: getNetworkPolicyName(item),
      annotations: { 'hammerkit.dev/version': getVersion() },
      labels: { 'hammerkit.dev/network-of': item.id() },
    },
    spec: {
      podSelector: { matchLabels: { [ID_LABEL]: item.id() } },
      policyTypes: ['Egress'],
      egress: [
        ...(needs.length > 0
          ? [{ to: needs.map((need) => ({ podSelector: { matchLabels: { [ID_LABEL]: need.service.id() } } })) }]
          : []),
        ...(network.type === 'allow'
          ? [
              {
                to: [{ podSelector: { matchLabels: { [PROXY_LABEL]: item.id() } } }],
                ports: [{ protocol: 'TCP', port: EGRESS_PROXY_PORT }],
              },
            ]
          : []),
      ],
    },
  }
}

// What the item's pods are created with, after its policy (and proxy) are in
// place, so a pod never runs unlimited. An open item gets what it had before:
// whatever an earlier limited run left goes.
// A task follows the proxy's log while its jobs run. A service outlives the
// run on a cluster, so its refused hosts are in the proxy's own log.
export async function ensureKubernetesItemNetwork(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  item: ContainerItem,
  options: { followLog: boolean }
): Promise<KubernetesItemNetwork> {
  const network = getEffectiveNetwork(item.data)
  const hostAliases = await getNeedHostAliases(instance, env, item)
  if (network.type === 'open') {
    // without the rights to manage NetworkPolicies, hammerkit never made one
    await removeKubernetesItemNetwork(instance, env, item, { ignoreForbidden: true })
    return { env: [], hostAliases, close() {} }
  }

  await apply(instance, buildNetworkPolicy(env, item, network))
  if (network.type === 'none') {
    await removeProxy(instance, env, item, [404])
    return { env: [], hostAliases, close() {} }
  }

  let proxyIp: string
  try {
    proxyIp = await ensureProxy(instance, env, item, network.hosts, hostAliases)
  } catch (e) {
    await removeKubernetesItemNetwork(instance, env, item).catch(() => undefined)
    throw e
  }
  const follow = options.followLog ? await followProxyLog(instance, env, item) : null
  return {
    env: Object.entries(getProxyClientEnvironment(item.needs.map((need) => need.name))).map(([name, value]) => ({
      name,
      value,
    })),
    hostAliases: [...hostAliases, { ip: proxyIp, hostnames: [EGRESS_PROXY_HOST] }],
    close: () => follow?.abort(),
  }
}

export async function removeKubernetesItemNetwork(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  item: ContainerItem,
  options: { ignoreForbidden: boolean } = { ignoreForbidden: false }
): Promise<void> {
  const ignored = options.ignoreForbidden ? [403, 404] : [404]
  await ignoreStatus(
    instance.objectApi.delete({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: getNetworkPolicyName(item), namespace: env.namespace },
    }),
    ignored
  )
  await removeProxy(instance, env, item, ignored)
}

// the services the item needs, by the names it lists them under
async function getNeedHostAliases(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  item: ContainerItem
): Promise<V1HostAlias[]> {
  const hostAliases: V1HostAlias[] = []
  for (const need of item.needs) {
    if (!isContainerWorkServiceItem(need.service)) {
      continue
    }
    const ip = await getServiceIp(instance, env, need.service)
    if (!ip) {
      throw new Error(`unable to get service ip for ${need.name}`)
    }
    hostAliases.push({ ip, hostnames: [need.name] })
  }
  return hostAliases
}

// The proxy as a Deployment and a Service; its pods reach out without a policy
// of their own, and reach the needed services by name for tools that ignore
// NO_PROXY.
async function ensureProxy(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  item: ContainerItem,
  hosts: string[],
  hostAliases: V1HostAlias[]
): Promise<string> {
  const name = getProxyName(item)
  const labels = { [PROXY_LABEL]: item.id() }
  const metadata = {
    namespace: env.namespace,
    name,
    annotations: { 'hammerkit.dev/version': getVersion() },
    labels,
  }
  const deployment: V1Deployment & KubernetesObjectHeader = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata,
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          hostAliases,
          containers: [
            {
              name: 'proxy',
              image: EGRESS_PROXY_IMAGE,
              command: getEgressProxyCommand(),
              env: Object.entries(getEgressProxyEnvironment([...hosts, ...item.needs.map((need) => need.name)])).map(
                ([key, value]) => ({ name: key, value })
              ),
              ports: [{ containerPort: EGRESS_PROXY_PORT }],
              readinessProbe: { tcpSocket: { port: EGRESS_PROXY_PORT }, periodSeconds: 1 },
            },
          ],
        },
      },
    },
  }
  const service: V1Service & KubernetesObjectHeader = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata,
    spec: {
      type: 'ClusterIP',
      selector: labels,
      ports: [{ port: EGRESS_PROXY_PORT, targetPort: EGRESS_PROXY_PORT }],
    },
  }
  await apply(instance, deployment)
  const created = await apply(instance, service)
  await awaitDeployRunningState(instance, env, name, {
    podSelector: `${PROXY_LABEL}=${item.id()}`,
    timeout: null,
    timeoutMessage: '',
  })
  const ip = created.spec?.clusterIP
  if (!ip) {
    throw new Error(`the egress proxy of ${item.name} has no cluster ip`)
  }
  item.status.write('debug', `egress proxy allows ${hosts.join(', ') || 'no host'}`)
  return ip
}

// Refused hosts show up in the item's log, as on Docker.
async function followProxyLog(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  item: ContainerItem
): Promise<AbortController | null> {
  try {
    const pods = await instance.coreApi.listNamespacedPod({
      namespace: env.namespace,
      labelSelector: `${PROXY_LABEL}=${item.id()}`,
    })
    const pod = pods.items.find((p) => p.status?.phase === 'Running' && !p.metadata?.deletionTimestamp)
    if (!pod?.metadata?.name) {
      return null
    }
    const output = new PassThrough()
    createInterface({ input: output }).on('line', (line) => {
      const event = parseEgressProxyEvent(line)
      if (event?.type === 'refused') {
        item.status.write('warn', formatRefusedHost(event.host))
      }
    })
    return await instance.log.log(env.namespace, pod.metadata.name, 'proxy', output as Writable, { follow: true })
  } catch (e) {
    item.status.write('debug', `unable to follow the egress proxy log: ${getErrorMessage(e)}`)
    return null
  }
}

async function removeProxy(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  item: ContainerItem,
  ignored: number[]
) {
  const name = getProxyName(item)
  await ignoreStatus(instance.appsApi.deleteNamespacedDeployment({ name, namespace: env.namespace }), ignored)
  await ignoreStatus(instance.coreApi.deleteNamespacedService({ name, namespace: env.namespace }), ignored)
}

async function ignoreStatus(promise: Promise<unknown>, statusCodes: number[]): Promise<void> {
  try {
    await promise
  } catch (e) {
    if (!statusCodes.includes(statusCodeOf(e) ?? 0)) {
      throw e
    }
  }
}
