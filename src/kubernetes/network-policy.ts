import {
  V1Container,
  V1Deployment,
  V1EnvVar,
  V1HostAlias,
  V1LabelSelector,
  V1NetworkPolicy,
  V1NetworkPolicyIngressRule,
  V1Service,
} from '@kubernetes/client-node'
import { PassThrough, Writable } from 'stream'
import { createInterface } from 'readline'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { isContainerWorkServiceItem, WorkItem } from '../planner/work-item'
import { ContainerWorkTask } from '../planner/work-task'
import { ContainerWorkService, isContainerWorkService } from '../planner/work-service'
import { getEffectiveNetwork, getTcpForwards, WorkNetwork } from '../planner/work-network'
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
  getEgressProxyPorts,
  getItemProxyEnvironment,
  getProxyClientEnvironment,
  parseEgressProxyEvent,
} from '../network/egress-proxy'
import { getErrorMessage } from '../log'
import { sleep } from '../utils/sleep'
import { getNetworkGateContainer, HELPER_SECURITY_CONTEXT } from './network-gate'

type ContainerItem = WorkItem<ContainerWorkTask | ContainerWorkService>

const ID_LABEL = 'hammerkit.dev/id'
// the run a task's pods belong to
export const RUN_LABEL = 'hammerkit.dev/run'
const PROXY_LABEL = 'hammerkit.dev/proxy-for'
const NETWORK_OF_LABEL = 'hammerkit.dev/network-of'
const PROXY_READY_TIMEOUT_MS = 60000
// how long the pods of an item may take to end before their policy goes
const POD_END_TIMEOUT_MS = 120000
const POD_END_POLL_MS = 500

export interface KubernetesItemNetwork {
  // the proxy variables under `allow`
  env: V1EnvVar[]
  // the needed services, and the proxy under `allow`, by name
  hostAliases: V1HostAlias[]
  // run before the item's own containers: under a limited network, the gate
  // that waits until the policy holds
  initContainers: V1Container[]
  // stops following the proxy's log
  close(): void
}

// Whose pods a policy and proxy are for. A task's are per run (`run`), so
// concurrent runs never replace or remove each other's limits; a service has
// one Deployment, so one of each.
export interface KubernetesNetworkScope {
  run: string | null
}

// A key short enough for a Service name (63 characters) with its prefix.
function getNetworkKey(item: ContainerItem, scope: KubernetesNetworkScope): string {
  return scope.run ? `${item.id().substring(0, 32)}-${scope.run}` : item.id()
}

export function getProxyName(item: ContainerItem, scope: KubernetesNetworkScope): string {
  return `hammerkit-proxy-${getNetworkKey(item, scope)}`
}

export function getNetworkPolicyName(item: ContainerItem, scope: KubernetesNetworkScope): string {
  return `hammerkit-network-${getNetworkKey(item, scope)}`
}

// the pods of the item, of the run when the scope has one
function getItemPodLabels(item: ContainerItem, scope: KubernetesNetworkScope): { [key: string]: string } {
  return { [ID_LABEL]: item.id(), ...(scope.run ? { [RUN_LABEL]: scope.run } : {}) }
}

function toSelector(labels: { [key: string]: string }): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(',')
}

// Who may connect to a limited item: the items that need it, and for a
// service a Gateway API route of the environment, the cluster's equivalent
// of a published port. A task takes no connections.
function getIngress(env: WorkKubernetesEnvironment, item: ContainerItem): V1NetworkPolicyIngressRule[] {
  if (!isContainerWorkService(item.data)) {
    return []
  }
  if (env.httpRoutes.some((route) => route.service === item.name)) {
    return [{}]
  }
  const ids = [...new Set(item.requiredBy.map((requirer) => requirer.id()))]
  if (ids.length === 0) {
    return []
  }
  const from: V1LabelSelector = { matchExpressions: [{ key: ID_LABEL, operator: 'In', values: ids }] }
  // the client's name for `from`, a reserved word
  return [{ _from: [{ podSelector: from }] }]
}

// The NetworkPolicy of a limited item: egress to the pods of the services it
// needs and, under `allow`, to its proxy; nothing else, DNS included (needs
// and the proxy are host aliases). Ingress only from what needs it. An open
// item has none.
export function buildNetworkPolicy(
  env: WorkKubernetesEnvironment,
  item: ContainerItem,
  network: WorkNetwork,
  scope: KubernetesNetworkScope
): V1NetworkPolicy & KubernetesObjectHeader {
  const needs = item.needs.filter((need) => isContainerWorkServiceItem(need.service))
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      namespace: env.namespace,
      name: getNetworkPolicyName(item, scope),
      annotations: { 'hammerkit.dev/version': getVersion() },
      labels: { [NETWORK_OF_LABEL]: item.id() },
    },
    spec: {
      podSelector: { matchLabels: getItemPodLabels(item, scope) },
      policyTypes: ['Ingress', 'Egress'],
      ingress: getIngress(env, item),
      egress: [
        ...(needs.length > 0
          ? [{ to: needs.map((need) => ({ podSelector: { matchLabels: { [ID_LABEL]: need.service.id() } } })) }]
          : []),
        ...(network.type === 'allow'
          ? [
              {
                to: [{ podSelector: { matchLabels: { [PROXY_LABEL]: getNetworkKey(item, scope) } } }],
                ports: getEgressProxyPorts(network).map((port) => ({ protocol: 'TCP', port })),
              },
            ]
          : []),
      ],
    },
  }
}

// The proxy takes connections from its item's pods only, so no other pod
// uses its allow list or reaches the item's services through it.
export function buildProxyPolicy(
  env: WorkKubernetesEnvironment,
  item: ContainerItem,
  network: WorkNetwork,
  scope: KubernetesNetworkScope
): V1NetworkPolicy & KubernetesObjectHeader {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      namespace: env.namespace,
      name: getProxyName(item, scope),
      annotations: { 'hammerkit.dev/version': getVersion() },
      labels: { [NETWORK_OF_LABEL]: item.id() },
    },
    spec: {
      podSelector: { matchLabels: { [PROXY_LABEL]: getNetworkKey(item, scope) } },
      policyTypes: ['Ingress'],
      ingress: [
        {
          _from: [{ podSelector: { matchLabels: getItemPodLabels(item, scope) } }],
          ports: getEgressProxyPorts(network).map((port) => ({ protocol: 'TCP', port })),
        },
      ],
    },
  }
}

// What the item's pods are created with, after its policy (and proxy) are in
// place, so a pod never runs unlimited. A limited item needs an environment
// that states its cluster enforces NetworkPolicy: hammerkit can't tell from
// the API, and a policy nobody enforces would run the item open.
// An open service gets what it had before: whatever an earlier limited run
// left goes.
// A task follows the proxy's log while its jobs run. A service outlives the
// run on a cluster, so its refused hosts are in the proxy's own log.
export async function ensureKubernetesItemNetwork(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  item: ContainerItem,
  options: { followLog: boolean } & KubernetesNetworkScope
): Promise<KubernetesItemNetwork> {
  const network = getEffectiveNetwork(item.data)
  if (network.type !== 'open' && !env.networkPolicyEnforced) {
    throw new Error(
      `${item.name}: network ${network.type} needs a cluster that enforces NetworkPolicy, ` +
        'state it with networkPolicy: enforced on the kubernetes environment'
    )
  }
  const hostAliases = await getNeedHostAliases(instance, env, item)
  if (network.type === 'open') {
    if (!options.run) {
      // without the rights to manage NetworkPolicies, hammerkit never made one
      await removeKubernetesItemNetwork(instance, env, item, { run: null }, { ignoreForbidden: true })
    }
    return { env: [], hostAliases, initContainers: [], close() {} }
  }

  await apply(instance, buildNetworkPolicy(env, item, network, options))
  const initContainers = [getNetworkGateContainer()]
  if (network.type === 'none') {
    await removeProxy(instance, env, item, options, [404])
    return { env: [], hostAliases, initContainers, close() {} }
  }

  let proxyIp: string
  try {
    proxyIp = await ensureProxy(instance, env, item, network, hostAliases, options)
  } catch (e) {
    await removeKubernetesItemNetwork(instance, env, item, options).catch(() => undefined)
    throw e
  }
  const follow = options.followLog ? await followProxyLog(instance, env, item, options) : null
  return {
    env: Object.entries(getProxyClientEnvironment(item.needs.map((need) => need.name))).map(([name, value]) => ({
      name,
      value,
    })),
    // the item reaches each TCP forward under its host's name, at the proxy
    hostAliases: [
      ...hostAliases,
      { ip: proxyIp, hostnames: [EGRESS_PROXY_HOST, ...getTcpForwards(network).map((forward) => forward.host)] },
    ],
    initContainers,
    close: () => follow?.abort(),
  }
}

// The policy and proxy of the scope go only once no pod of it runs anymore:
// a pod that is still terminating (cancel, timeout, `down`) would otherwise
// run without limits. When pods outlast the wait, the policy stays.
export async function removeKubernetesItemNetwork(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  item: ContainerItem,
  scope: KubernetesNetworkScope,
  options: { ignoreForbidden: boolean } = { ignoreForbidden: false }
): Promise<void> {
  const ignored = options.ignoreForbidden ? [403, 404] : [404]
  await ignoreStatus(
    instance.objectApi.delete({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: getNetworkPolicyName(item, scope), namespace: env.namespace },
    }),
    ignored
  )
  await removeProxy(instance, env, item, scope, ignored)
}

// Waits until no pod with the labels runs or waits to run.
export async function awaitPodsEnded(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  labels: { [key: string]: string },
  timeout = POD_END_TIMEOUT_MS
): Promise<boolean> {
  const deadline = Date.now() + timeout
  for (;;) {
    const pods = await instance.coreApi.listNamespacedPod({
      namespace: env.namespace,
      labelSelector: toSelector(labels),
    })
    if (pods.items.every((pod) => pod.status?.phase === 'Succeeded' || pod.status?.phase === 'Failed')) {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await sleep(POD_END_POLL_MS)
  }
}

// Removes the scope's policy and proxy once its pods ended.
export async function releaseKubernetesItemNetwork(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  item: ContainerItem,
  scope: KubernetesNetworkScope
): Promise<void> {
  if (!(await awaitPodsEnded(instance, env, getItemPodLabels(item, scope)))) {
    throw new Error(`pods of ${item.name} are still running, so its network policy stays`)
  }
  await removeKubernetesItemNetwork(instance, env, item, scope)
}

// Every policy and proxy of the item, of any run, once none of its pods runs:
// what `down` and `clean` remove.
export async function removeAllKubernetesItemNetworks(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  item: ContainerItem
): Promise<void> {
  if (!(await awaitPodsEnded(instance, env, { [ID_LABEL]: item.id() }))) {
    throw new Error(`pods of ${item.name} are still running, so its network policy stays`)
  }
  const labelSelector = `${NETWORK_OF_LABEL}=${item.id()}`
  let policies: V1NetworkPolicy[]
  try {
    const list = await instance.objectApi.list<V1NetworkPolicy & KubernetesObjectHeader>(
      'networking.k8s.io/v1',
      'NetworkPolicy',
      env.namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    )
    policies = list.items
  } catch (e) {
    // without the rights to manage NetworkPolicies, hammerkit never made one
    if (statusCodeOf(e) === 403) {
      return
    }
    throw e
  }
  // the items of a list carry no kind of their own
  for (const name of policies.map((policy) => policy.metadata?.name).filter((name): name is string => !!name)) {
    await ignoreStatus(
      instance.objectApi.delete({
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name, namespace: env.namespace },
      }),
      [404]
    )
  }
  const deployments = await instance.appsApi.listNamespacedDeployment({ namespace: env.namespace, labelSelector })
  for (const deployment of deployments.items) {
    const name = deployment.metadata?.name
    if (name) {
      await ignoreStatus(instance.appsApi.deleteNamespacedDeployment({ name, namespace: env.namespace }), [404])
      await ignoreStatus(instance.coreApi.deleteNamespacedService({ name, namespace: env.namespace }), [404])
    }
  }
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

// The proxy as a Deployment and a Service; its pods reach out without an
// egress policy of their own, and reach the needed services by name for tools
// that ignore NO_PROXY. Unprivileged, from a pinned image. Its Service carries
// the port of each TCP forward too.
async function ensureProxy(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  item: ContainerItem,
  network: Extract<WorkNetwork, { type: 'allow' }>,
  hostAliases: V1HostAlias[],
  scope: KubernetesNetworkScope
): Promise<string> {
  const name = getProxyName(item, scope)
  const labels = { [PROXY_LABEL]: getNetworkKey(item, scope) }
  const metadata = {
    namespace: env.namespace,
    name,
    annotations: { 'hammerkit.dev/version': getVersion() },
    labels: { ...labels, [NETWORK_OF_LABEL]: item.id() },
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
          automountServiceAccountToken: false,
          // unprivileged, it still listens on the port of a TCP forward below
          // 1024; a sysctl every Pod Security level allows
          securityContext: { sysctls: [{ name: 'net.ipv4.ip_unprivileged_port_start', value: '0' }] },
          containers: [
            {
              name: 'proxy',
              image: EGRESS_PROXY_IMAGE,
              command: getEgressProxyCommand(),
              env: Object.entries(getItemProxyEnvironment(item)).map(([key, value]) => ({ name: key, value })),
              ports: getEgressProxyPorts(network).map((port) => ({ containerPort: port })),
              // in the pod, since its ingress policy may keep the kubelet out
              readinessProbe: {
                exec: {
                  command: [
                    'node',
                    '-e',
                    `require('net').connect(${EGRESS_PROXY_PORT}, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))`,
                  ],
                },
                periodSeconds: 2,
              },
              securityContext: HELPER_SECURITY_CONTEXT,
              resources: { limits: { memory: '256Mi' } },
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
      ports: getEgressProxyPorts(network).map((port) => ({ name: `tcp-${port}`, port, targetPort: port })),
    },
  }
  await apply(instance, buildProxyPolicy(env, item, network, scope))
  await apply(instance, deployment)
  const created = await apply(instance, service)
  await awaitDeployRunningState(instance, env, name, {
    podSelector: toSelector(labels),
    timeout: PROXY_READY_TIMEOUT_MS,
    timeoutMessage: `the egress proxy of ${item.name} did not start`,
  })
  const ip = created.spec?.clusterIP
  if (!ip) {
    throw new Error(`the egress proxy of ${item.name} has no cluster ip`)
  }
  item.status.write('debug', `egress proxy allows ${network.hosts.join(', ') || 'no host'}`)
  return ip
}

// Refused hosts show up in the item's log, as on Docker.
async function followProxyLog(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  item: ContainerItem,
  scope: KubernetesNetworkScope
): Promise<AbortController | null> {
  try {
    const pods = await instance.coreApi.listNamespacedPod({
      namespace: env.namespace,
      labelSelector: `${PROXY_LABEL}=${getNetworkKey(item, scope)}`,
    })
    const pod = pods.items.find((p) => p.status?.phase === 'Running' && !p.metadata?.deletionTimestamp)
    if (!pod?.metadata?.name) {
      return null
    }
    const output = new PassThrough()
    // close() aborts the request, which errors the response stream the
    // client pipes in here; nothing listens to it there
    output.on('pipe', (source) => source.on('error', () => undefined))
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
  scope: KubernetesNetworkScope,
  ignored: number[]
) {
  const name = getProxyName(item, scope)
  await ignoreStatus(instance.appsApi.deleteNamespacedDeployment({ name, namespace: env.namespace }), ignored)
  await ignoreStatus(instance.coreApi.deleteNamespacedService({ name, namespace: env.namespace }), ignored)
  await ignoreStatus(
    instance.objectApi.delete({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name, namespace: env.namespace },
    }),
    ignored
  )
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
